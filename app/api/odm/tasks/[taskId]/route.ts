import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { odmTasks } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { odmGetTaskInfo, odmDownloadAllZip, ODM_STATUS, type OdmStatusCode } from '@/lib/odm'
import { putObject, flightPrefix } from '@/lib/s3'
import { unzipSync } from 'fflate'

interface RouteParams {
  params: Promise<{ taskId: string }>
}

/**
 * GET /api/odm/tasks/[taskId]?outputLine=0
 *
 * While status is 'uploading': proxies to the Modal worker's upload-progress
 * endpoint so the client can show X/Y progress.  Once the worker commits the
 * task, this endpoint transitions the DB record to 'queued' and begins
 * polling NodeODM for processing status on subsequent requests.
 */
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { taskId } = await params
  const outputLine = Number(req.nextUrl.searchParams.get('outputLine') ?? '0')

  const [task] = await db.select().from(odmTasks).where(eq(odmTasks.id, taskId))
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  // ── Upload phase: poll Modal worker for progress ──────────────────────────
  if (task.status === 'uploading') {
    const workerUrl = process.env.MODAL_ODM_WORKER_URL
    const workerToken = process.env.MODAL_ODM_WORKER_TOKEN

    if (!workerUrl || !workerToken) {
      return NextResponse.json({ error: 'MODAL_ODM_WORKER_URL / MODAL_ODM_WORKER_TOKEN not set' }, { status: 500 })
    }

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
      // 404 = container recycled / unknown uuid — treat as still uploading
    } catch {
      // Network error — just return current state
    }

    if (uploadError) {
      await db.update(odmTasks).set({ status: 'failed', completedAt: new Date() }).where(eq(odmTasks.id, taskId))
      return NextResponse.json({
        taskId,
        odmUuid: task.odmUuid,
        status: 'failed',
        uploadedImages: uploaded,
        totalImages: task.totalImages,
        processingTime: -1,
        imagesCount: 0,
        output: [`Upload error: ${uploadError}`],
        outputKey: null,
      })
    }

    if (!committed) {
      // Still uploading
      const progressVal = task.totalImages && task.totalImages > 0 ? (uploaded / task.totalImages) * 100 : 0
      await db
        .update(odmTasks)
        .set({ processed: uploaded, progress: progressVal })
        .where(eq(odmTasks.id, taskId))

      return NextResponse.json({
        taskId,
        odmUuid: task.odmUuid,
        status: 'uploading',
        uploadedImages: uploaded,
        totalImages: task.totalImages,
        processingTime: -1,
        imagesCount: 0,
        output: [],
        outputKey: null,
      })
    }

    // Committed — transition to queued and fall through to ODM poll below
    await db.update(odmTasks).set({ status: 'queued' }).where(eq(odmTasks.id, taskId))
    task.status = 'queued'
  }

  // ── Processing phase: poll NodeODM ────────────────────────────────────────
  let info: Awaited<ReturnType<typeof odmGetTaskInfo>>
  try {
    console.log(`[ODM Tasks API] Polling NodeODM for task uuid: ${task.odmUuid}, outputLine: ${outputLine}`);
    info = await odmGetTaskInfo(task.odmUuid, outputLine)
    console.log(`[ODM Tasks API] NodeODM response status code: ${info.status?.code}`);
  } catch (err) {
    console.error(`[ODM Tasks API] Failed to reach ODM node for uuid ${task.odmUuid}:`, err);
    return NextResponse.json({ error: `Failed to reach ODM node: ${String(err)}` }, { status: 502 })
  }

  if (!info.status) {
    console.error(`[ODM Tasks API] Malformed ODM response (missing status) for uuid ${task.odmUuid}:`, info);
    return NextResponse.json({ error: `Malformed ODM response: missing status` }, { status: 502 })
  }

  const statusCode = info.status.code as OdmStatusCode
  const statusLabel = ODM_STATUS[statusCode] as 'queued' | 'running' | 'failed' | 'completed' | 'canceled'

  // Sync status, processed, and progress to DB
  const isDbTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'canceled'

  if (!isDbTerminal) {
    const progressVal = statusLabel === 'completed' ? 100 : (statusLabel === 'canceled' || statusLabel === 'failed' ? 0 : (info.progress ?? 0))
    const processedVal = statusLabel === 'completed' ? (task.totalImages ?? 0) : (info.imagesCount ?? 0)

    await db
      .update(odmTasks)
      .set({
        status: statusLabel,
        processed: processedVal,
        progress: progressVal,
        ...(statusLabel === 'completed' || statusLabel === 'failed' || statusLabel === 'canceled'
          ? { completedAt: new Date() }
          : {}),
      })
      .where(eq(odmTasks.id, taskId))
  }

  const finalStatus = isDbTerminal ? task.status : statusLabel

  // When completed for the first time: download zip, extract GeoTIFF, upload to S3
  let outputKey = task.outputKey
  let reportKey = task.reportKey
  if (finalStatus === 'completed' && !outputKey) {
    try {
      const collected = await collectOdmOutputs(task.odmUuid, task.flightId)
      outputKey = collected.outputKey
      reportKey = collected.reportKey ?? null

      // Pre-fetch bounds from the tile server
      let boundsStr: string | null = null
      try {
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
            console.log(`[ODM Tasks API] Pre-fetched bounds for task ${taskId}:`, boundsStr)
          }
        }
      } catch (err) {
        console.error('[ODM Tasks API] Failed to pre-fetch bounds:', err)
      }

      await db.update(odmTasks).set({ outputKey, reportKey, bounds: boundsStr }).where(eq(odmTasks.id, taskId))
    } catch (err) {
      // Non-fatal: client can retry on next poll
      console.error('ODM output collection failed:', err)
    }
  }

  return NextResponse.json({
    taskId,
    odmUuid: task.odmUuid,
    status: finalStatus,
    uploadedImages: task.totalImages ?? 0,
    totalImages: task.totalImages,
    processingTime: info.processingTime,
    imagesCount: info.imagesCount,
    progress: finalStatus === 'completed' ? 100 : (finalStatus === 'canceled' || finalStatus === 'failed' ? 0 : (info.progress ?? 0)),
    output: finalStatus === 'canceled' ? ['Task was canceled by user.'] : (info.output ?? []),
    outputKey,
    reportKey,
  })
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { taskId } = await params
  const [task] = await db.select().from(odmTasks).where(eq(odmTasks.id, taskId))
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  // Update status to canceled in the database
  await db
    .update(odmTasks)
    .set({ status: 'canceled', completedAt: new Date() })
    .where(eq(odmTasks.id, taskId))

  // Try to cancel on NodeODM if we have an odmUuid and it was queued/running
  if (task.odmUuid && (task.status === 'queued' || task.status === 'running')) {
    try {
      const { odmCancelTask } = await import('@/lib/odm')
      await odmCancelTask(task.odmUuid)
    } catch (err) {
      console.error('Failed to cancel task on NodeODM:', err)
    }
  }

  return NextResponse.json({ success: true })
}


/**
 * Delegates the slow and memory-intensive output collection phase to the Modal worker
 * to prevent Vercel serverless functions from running out of memory (OOM).
 * Retries up to 3 times with short delays because NodeODM can take a moment
 * to finish writing all.zip after marking itself as complete (status 40).
 */
async function collectOdmOutputs(
  odmUuid: string,
  flightId: string,
): Promise<{ outputKey: string; reportKey?: string }> {
  const { flights, flightPlans } = await import('@/lib/schema')
  const { eq: deq } = await import('drizzle-orm')
  const { db: database } = await import('@/lib/db')

  const [flight] = await database.select().from(flights).where(deq(flights.id, flightId))
  if (!flight) throw new Error('Flight not found when collecting ODM outputs')

  const [flightPlan] = await database
    .select()
    .from(flightPlans)
    .where(deq(flightPlans.id, flight.flightPlanId))
  if (!flightPlan) throw new Error('FlightPlan not found when collecting ODM outputs')

  const workerUrl = process.env.MODAL_ODM_WORKER_URL
  const workerToken = process.env.MODAL_ODM_WORKER_TOKEN
  if (!workerUrl || !workerToken) {
    throw new Error('MODAL_ODM_WORKER_URL or MODAL_ODM_WORKER_TOKEN not configured')
  }

  // Pass the NodeODM URL that Next.js itself uses (including any token query param)
  // so the Modal worker can download all.zip directly — nothing routes through Vercel.
  const odmNodeUrl = process.env.ODM_NODE_URL
  if (!odmNodeUrl) {
    throw new Error('ODM_NODE_URL not configured')
  }

  const body = JSON.stringify({
    odm_uuid: odmUuid,
    flight_id: flightId,
    project_id: flightPlan.projectId,
    flight_plan_id: flight.flightPlanId,
    bucket: process.env.S3_BUCKET_NAME,
    odm_node_url: odmNodeUrl,
  })

  const MAX_ATTEMPTS = 3
  const RETRY_DELAYS_MS = [3_000, 10_000] // wait before attempt 2, then attempt 3

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const delay = RETRY_DELAYS_MS[attempt - 2]
      console.log(`[ODM Tasks API] Retrying output collection (attempt ${attempt}/${MAX_ATTEMPTS}) after ${delay}ms for uuid: ${odmUuid}`)
      await new Promise((r) => setTimeout(r, delay))
    }

    console.log(`[ODM Tasks API] Delegating output collection to Modal worker for uuid: ${odmUuid} (attempt ${attempt})`)

    let res: Response
    try {
      res = await fetch(`${workerUrl}/collect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${workerToken}`,
        },
        body,
        signal: AbortSignal.timeout(90_000),
      })
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.warn(`[ODM Tasks API] Fetch error on attempt ${attempt} for uuid ${odmUuid}:`, lastError.message)
      continue
    }

    if (res.ok) {
      const data = (await res.json()) as { outputKey: string; reportKey?: string }
      console.log(`[ODM Tasks API] Successfully collected outputs via Modal worker (attempt ${attempt}):`, data)
      return data
    }

    const text = await res.text()
    lastError = new Error(`Modal worker collection failed (${res.status}): ${text}`)
    console.warn(`[ODM Tasks API] Collection attempt ${attempt} failed for uuid ${odmUuid}: ${lastError.message}`)
  }

  throw lastError ?? new Error('Output collection failed after all attempts')
}
