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

  // Already terminal — return the DB state directly with S3 logs if available
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
    let logs: string[] = []
    if (task.status !== 'canceled') {
      try {
        const { getObjectBuffer } = await import('@/lib/s3')
        const { flights, flightPlans } = await import('@/lib/schema')
        const { eq: deq } = await import('drizzle-orm')
        const [flight] = await db.select().from(flights).where(deq(flights.id, task.flightId))
        if (flight) {
          const [flightPlan] = await db.select().from(flightPlans).where(deq(flightPlans.id, flight.flightPlanId))
          if (flightPlan) {
            const logKey = `${flightPlan.projectId}/${flight.flightPlanId}/${task.flightId}/outputs/orthophoto.log`
            const buf = await getObjectBuffer(logKey)
            logs = buf.toString('utf-8').split('\n')
          }
        }
      } catch (err) {
        console.error('[ODM Tasks API] Failed to fetch log from S3:', err)
        logs = task.error ? [task.error] : []
      }
    } else {
      logs = ['Task was canceled by user.']
    }

    return NextResponse.json({
      taskId,
      odmUuid: task.odmUuid,
      status: task.status,
      uploadedImages: task.totalImages ?? 0,
      totalImages: task.totalImages,
      processingTime: -1,
      imagesCount: task.totalImages ?? 0,
      progress: task.status === 'completed' ? 100 : 0,
      output: logs.slice(outputLine),
      outputKey: task.outputKey ?? null,
      reportKey: task.reportKey ?? null,
      error: task.error ?? null,
    })
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
    const nextDbStatus = (statusLabel === 'completed' && !task.outputKey) ? 'running' : statusLabel
    const progressVal = statusLabel === 'completed' ? (task.outputKey ? 100 : 90) : (statusLabel === 'canceled' || statusLabel === 'failed' ? 0 : ((info.progress ?? 0) * 0.9))
    const processedVal = statusLabel === 'completed' ? (task.totalImages ?? 0) : (info.imagesCount ?? 0)

    await db
      .update(odmTasks)
      .set({
        status: nextDbStatus,
        processed: processedVal,
        progress: progressVal,
        ...(nextDbStatus === 'completed' || nextDbStatus === 'failed' || nextDbStatus === 'canceled'
          ? { completedAt: new Date() }
          : {}),
      })
      .where(eq(odmTasks.id, taskId))
  }

  const finalStatus = isDbTerminal ? task.status : (statusLabel === 'completed' && !task.outputKey ? 'running' : statusLabel)

  // When NodeODM is completed but we haven't collected / tiled yet: trigger & poll async collection task
  let outputKey = task.outputKey
  let reportKey = task.reportKey
  let progressVal = finalStatus === 'completed' ? 100 : (finalStatus === 'canceled' || finalStatus === 'failed' ? 0 : ((info.progress ?? 0) * 0.9))
  let combinedOutput = finalStatus === 'canceled' ? ['Task was canceled by user.'] : (info.output ?? [])

  if (statusLabel === 'completed' && !outputKey) {
    const workerUrl = process.env.MODAL_ODM_WORKER_URL
    const workerToken = process.env.MODAL_ODM_WORKER_TOKEN
    if (!workerUrl || !workerToken) {
      return NextResponse.json({ error: 'MODAL_ODM_WORKER_URL / MODAL_ODM_WORKER_TOKEN not set' }, { status: 500 })
    }

    let collectData: {
      status: string
      processed: number
      total: number
      output_key: string | null
      report_key: string | null
      tiles_key: string | null
      error: string | null
      output?: string[]
    } | null = null

    try {
      const res = await fetch(`${workerUrl}/collect-status/${task.odmUuid}`, {
        headers: { Authorization: `Bearer ${workerToken}` },
        cache: 'no-store',
      })
      if (res.ok) {
        collectData = await res.json()
      }
    } catch (err) {
      console.warn('[ODM Tasks API] Error checking collect status:', err)
    }

    if (!collectData) {
      // Trigger asynchronous background collection + tiling on the Modal worker
      try {
        const { flights, flightPlans } = await import('@/lib/schema')
        const { eq: deq } = await import('drizzle-orm')
        const [flight] = await db.select().from(flights).where(deq(flights.id, task.flightId))
        if (!flight) throw new Error('Flight not found')
        const [flightPlan] = await db.select().from(flightPlans).where(deq(flightPlans.id, flight.flightPlanId))
        if (!flightPlan) throw new Error('Flight plan not found')
        const odmNodeUrl = process.env.ODM_NODE_URL
        if (!odmNodeUrl) throw new Error('ODM_NODE_URL not configured')

        console.log(`[ODM Tasks API] Triggering async collection on Modal for uuid: ${task.odmUuid}`)
        await fetch(`${workerUrl}/collect-async`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify({
            odm_uuid: task.odmUuid,
            flight_id: task.flightId,
            project_id: flightPlan.projectId,
            flight_plan_id: flight.flightPlanId,
            bucket: process.env.S3_BUCKET_NAME,
            odm_node_url: odmNodeUrl,
          }),
        })
      } catch (err) {
        console.error('[ODM Tasks API] Failed to trigger collect-async:', err)
      }

      progressVal = 90
      combinedOutput.push('Initiating S3 collection & static WebP tile generation...')
    } else if (collectData.status === 'failed') {
      await db.update(odmTasks).set({ status: 'failed', completedAt: new Date() }).where(eq(odmTasks.id, taskId))
      return NextResponse.json({
        taskId,
        odmUuid: task.odmUuid,
        status: 'failed',
        uploadedImages: task.totalImages ?? 0,
        totalImages: task.totalImages,
        processingTime: info.processingTime,
        imagesCount: info.imagesCount,
        progress: 0,
        error: collectData.error ?? 'Output collection failed',
        output: [...combinedOutput, ...(collectData.output ?? [])],
        outputKey: null,
      })
    } else if (collectData.status === 'completed' && collectData.output_key) {
      outputKey = collectData.output_key
      reportKey = collectData.report_key

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

      if (boundsStr) {
        try {
          const parsed = JSON.parse(boundsStr)
          const mz = (collectData as any).max_zoom
          if (mz !== undefined && mz !== null) {
            parsed.maxzoom = Number(mz)
            boundsStr = JSON.stringify(parsed)
            console.log(`[ODM Tasks API] Overriding bounds maxzoom with actual static tile max_zoom: ${parsed.maxzoom}`)
          }
        } catch (err) {
          console.error('[ODM Tasks API] Failed to override maxzoom in bounds:', err)
        }
      }

      await db
        .update(odmTasks)
        .set({
          status: 'completed',
          outputKey,
          reportKey,
          tilesKey: collectData.tiles_key,
          bounds: boundsStr,
          completedAt: new Date(),
          progress: 100,
          processed: task.totalImages ?? 0,
        })
        .where(eq(odmTasks.id, taskId))

      progressVal = 100
      combinedOutput.push(...(collectData.output ?? []))
    } else {
      // Collecting/tiling is in progress
      const collectProgress = collectData.total > 0 ? (collectData.processed / collectData.total) * 10 : 5
      progressVal = 90 + collectProgress
      combinedOutput.push(...(collectData.output ?? []))
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
    progress: Math.min(99.5, progressVal),
    output: combinedOutput.slice(outputLine),
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
