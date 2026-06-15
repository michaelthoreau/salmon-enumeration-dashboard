import { db } from '@/lib/db'
import { odmTasks, georefTasks, flights, flightPlans } from '@/lib/schema'
import { eq, inArray, and, isNull } from 'drizzle-orm'
import { odmGetTaskInfo, odmDownloadAllZip, ODM_STATUS, type OdmStatusCode } from '@/lib/odm'
import { putObject, flightPrefix } from '@/lib/s3'
import { unzipSync } from 'fflate'

/**
 * Downloads all.zip from NodeODM, extracts the orthophoto and report,
 * and uploads them to S3.
 */
export async function collectOdmOutputs(
  odmUuid: string,
  flightId: string
): Promise<{ outputKey: string; reportKey?: string }> {
  const [flight] = await db.select().from(flights).where(eq(flights.id, flightId))
  if (!flight) throw new Error('Flight not found when collecting ODM outputs')

  const [flightPlan] = await db
    .select()
    .from(flightPlans)
    .where(eq(flightPlans.id, flight.flightPlanId))
  if (!flightPlan) throw new Error('FlightPlan not found when collecting ODM outputs')

  const prefix = flightPrefix(flightPlan.projectId, flight.flightPlanId, flightId)
  const zipBuffer = await odmDownloadAllZip(odmUuid)
  const files = unzipSync(new Uint8Array(zipBuffer))

  // GeoTIFF (required)
  const tifEntry = Object.keys(files).find(
    (k) => k.includes('odm_orthophoto') && (k.endsWith('.tif') || k.endsWith('.tiff'))
  )
  if (!tifEntry) throw new Error('odm_orthophoto.tif not found in all.zip')

  const outputKey = `${prefix}outputs/orthophoto.tif`
  await putObject(outputKey, Buffer.from(files[tifEntry]), 'image/tiff')

  // Report PDF (optional)
  let reportKey: string | undefined
  const reportEntry = Object.keys(files).find((k) => k.includes('report') && k.endsWith('.pdf'))
  if (reportEntry) {
    reportKey = `${prefix}odm/${flightId}_report.pdf`
    await putObject(reportKey, Buffer.from(files[reportEntry]), 'application/pdf')
  }

  return { outputKey, reportKey }
}

/**
 * Syncs a single ODM task status from NodeODM / Modal upload progress, and caches it in the DB.
 */
export async function syncOdmTaskStatus(taskId: string): Promise<any> {
  const [task] = await db.select().from(odmTasks).where(eq(odmTasks.id, taskId))
  if (!task) return null

  const isDbTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'canceled'
  if (isDbTerminal) return task

  // 1. Upload Phase: Poll Modal worker upload-progress
  if (task.status === 'uploading') {
    const workerUrl = process.env.MODAL_ODM_WORKER_URL
    const workerToken = process.env.MODAL_ODM_WORKER_TOKEN
    if (!workerUrl || !workerToken) return task

    let uploaded = 0
    let committed = false
    let uploadError: string | null = null

    try {
      const res = await fetch(`${workerUrl}/upload-progress/${task.odmUuid}`, {
        headers: { Authorization: `Bearer ${workerToken}` },
        cache: 'no-store',
      })
      if (res.ok) {
        const prog = (await res.json()) as {
          uploaded: number
          total: number
          committed: boolean
          error: string | null
        }
        uploaded = prog.uploaded
        committed = prog.committed
        uploadError = prog.error
      }
    } catch {
      // Ignored: network glitch
    }

    if (uploadError) {
      await db
        .update(odmTasks)
        .set({ status: 'failed', processed: uploaded, progress: 0, completedAt: new Date() })
        .where(eq(odmTasks.id, taskId))
      return { ...task, status: 'failed', processed: uploaded, progress: 0 }
    }

    if (!committed) {
      const progressVal = task.totalImages && task.totalImages > 0 ? (uploaded / task.totalImages) * 100 : 0
      await db
        .update(odmTasks)
        .set({ processed: uploaded, progress: progressVal })
        .where(eq(odmTasks.id, taskId))
      return { ...task, processed: uploaded, progress: progressVal }
    }

    // Committed: transition to queued and proceed to poll NodeODM
    await db.update(odmTasks).set({ status: 'queued' }).where(eq(odmTasks.id, taskId))
    task.status = 'queued'
  }

  // 2. Processing Phase: Poll NodeODM
  try {
    const info = await odmGetTaskInfo(task.odmUuid, 999999)
    if (!info.status) return task

    const statusCode = info.status.code as OdmStatusCode
    const statusLabel = ODM_STATUS[statusCode] as 'queued' | 'running' | 'failed' | 'completed' | 'canceled'

    const progressVal = statusLabel === 'completed' ? 100 : (statusLabel === 'canceled' || statusLabel === 'failed' ? 0 : (info.progress ?? 0))
    const processedVal = statusLabel === 'completed' ? (task.totalImages ?? 0) : (info.imagesCount ?? 0)

    let outputKey = task.outputKey
    let reportKey = task.reportKey
    let boundsStr = task.bounds

    // Transition to completed
    if (statusLabel === 'completed' && !outputKey) {
      try {
        const collected = await collectOdmOutputs(task.odmUuid, task.flightId)
        outputKey = collected.outputKey
        reportKey = collected.reportKey ?? null

        // Pre-fetch bounds
        const url = process.env.MODAL_TILE_SERVER_URL
        const token = process.env.MODAL_TILE_TOKEN
        if (url && token && outputKey) {
          const targetUrl = `${url}/info?key=${encodeURIComponent(outputKey)}` + (process.env.S3_BUCKET_NAME ? `&bucket=${encodeURIComponent(process.env.S3_BUCKET_NAME)}` : '')
          const infoRes = await fetch(targetUrl, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
          })
          if (infoRes.ok) {
            boundsStr = await infoRes.text()
          }
        }
      } catch (err) {
        console.error('[syncOdmTaskStatus] Output collection failed:', err)
      }
    }

    const updatedData = {
      status: statusLabel,
      processed: processedVal,
      progress: progressVal,
      outputKey,
      reportKey,
      bounds: boundsStr,
      ...(statusLabel === 'completed' || statusLabel === 'failed' || statusLabel === 'canceled'
        ? { completedAt: new Date() }
        : {}),
    }

    await db.update(odmTasks).set(updatedData).where(eq(odmTasks.id, taskId))
    return { ...task, ...updatedData }
  } catch (err) {
    console.error(`[syncOdmTaskStatus] Failed to reach ODM node for uuid ${task.odmUuid}:`, err)
    return task
  }
}

/**
 * Syncs a single Georeference task status from Modal georef worker status, and caches it in the DB.
 */
export async function syncGeorefTaskStatus(taskId: string): Promise<any> {
  const [task] = await db.select().from(georefTasks).where(eq(georefTasks.id, taskId))
  if (!task) return null

  const isDbTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'canceled'
  if (isDbTerminal) return task

  const workerUrl = process.env.MODAL_GEOREF_WORKER_URL
  const workerToken = process.env.MODAL_GEOREF_WORKER_TOKEN
  if (!workerUrl || !workerToken) return task

  try {
    const res = await fetch(`${workerUrl}/status/${taskId}`, {
      headers: { Authorization: `Bearer ${workerToken}` },
      cache: 'no-store',
    })
    if (!res.ok) return task

    const workerData = (await res.json()) as {
      status: string
      processed: number
      total: number
      output_key: string | null
      error: string | null
    }

    const progressVal = workerData.status === 'completed' ? 100 : (workerData.status === 'failed' || workerData.status === 'canceled' ? 0 : (workerData.total > 0 ? (workerData.processed / workerData.total) * 100 : 0))

    if (workerData.status === 'completed' && workerData.output_key) {
      let boundsStr: string | null = null
      try {
        const url = process.env.MODAL_TILE_SERVER_URL
        const token = process.env.MODAL_TILE_TOKEN
        const outputKey = workerData.output_key
        if (url && token && outputKey) {
          const targetUrl = `${url}/info?key=${encodeURIComponent(outputKey)}` + (process.env.S3_BUCKET_NAME ? `&bucket=${encodeURIComponent(process.env.S3_BUCKET_NAME)}` : '')
          const infoRes = await fetch(targetUrl, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
          })
          if (infoRes.ok) {
            boundsStr = await infoRes.text()
          }
        }
      } catch (err) {
        console.error('[syncGeorefTaskStatus] Failed to pre-fetch bounds:', err)
      }

      const updatedData = {
        status: 'completed' as const,
        processed: workerData.processed,
        progress: 100,
        outputKey: workerData.output_key,
        bounds: boundsStr,
        completedAt: new Date(),
      }
      await db.update(georefTasks).set(updatedData).where(eq(georefTasks.id, taskId))
      return { ...task, ...updatedData }
    } else if (workerData.status === 'failed') {
      const updatedData = {
        status: 'failed' as const,
        processed: workerData.processed,
        progress: 0,
        error: workerData.error ?? 'Unknown error',
        completedAt: new Date(),
      }
      await db.update(georefTasks).set(updatedData).where(eq(georefTasks.id, taskId))
      return { ...task, ...updatedData }
    } else {
      const updatedData = {
        status: workerData.status as any,
        processed: workerData.processed,
        progress: progressVal,
      }
      await db.update(georefTasks).set(updatedData).where(eq(georefTasks.id, taskId))
      return { ...task, ...updatedData }
    }
  } catch (err) {
    console.error(`[syncGeorefTaskStatus] Failed to sync georef status for ${taskId}:`, err)
    return task
  }
}

/**
 * Searches for active (in-progress) tasks for the given flightIds and triggers sync fetches for them.
 */
export async function syncActiveTasks(flightIds: string[]): Promise<void> {
  if (flightIds.length === 0) return

  // Find all active ODM tasks
  const activeOdmTasks = await db
    .select({ id: odmTasks.id })
    .from(odmTasks)
    .where(
      and(
        inArray(odmTasks.flightId, flightIds),
        inArray(odmTasks.status, ['uploading', 'queued', 'running'])
      )
    )

  // Find all active Georef tasks
  const activeGeorefTasks = await db
    .select({ id: georefTasks.id })
    .from(georefTasks)
    .where(
      and(
        inArray(georefTasks.flightId, flightIds),
        inArray(georefTasks.status, ['pending', 'running'])
      )
    )

  const promises: Promise<any>[] = []

  for (const t of activeOdmTasks) {
    promises.push(syncOdmTaskStatus(t.id))
  }
  for (const t of activeGeorefTasks) {
    promises.push(syncGeorefTaskStatus(t.id))
  }

  if (promises.length > 0) {
    // Run in parallel and swallow errors so we don't block the caller
    await Promise.all(promises).catch((err) => {
      console.error('[syncActiveTasks] Error during parallel sync:', err)
    })
  }
}
