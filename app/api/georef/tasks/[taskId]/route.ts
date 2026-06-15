import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { georefTasks, flights, flightPlans } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getObjectBuffer } from '@/lib/s3'

interface RouteParams {
  params: Promise<{ taskId: string }>
}

/**
 * GET /api/georef/tasks/[taskId]
 *
 * Proxies to the Modal georef worker's /status/:task_id endpoint and
 * synchronises the DB record when the task completes or fails.
 *
 * Response shape:
 *   { taskId, status, processed, total, outputKey | null, error | null }
 */
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { taskId } = await params

  const [task] = await db.select().from(georefTasks).where(eq(georefTasks.id, taskId))
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  const outputLine = Number(req.nextUrl.searchParams.get('outputLine') ?? '0')

  // Already terminal — return the DB state directly with S3 logs if available
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
    let logs: string[] = []
    if (task.status !== 'canceled') {
      try {
        const [flight] = await db.select().from(flights).where(eq(flights.id, task.flightId))
        if (flight) {
          const [flightPlan] = await db.select().from(flightPlans).where(eq(flightPlans.id, flight.flightPlanId))
          if (flightPlan) {
            const logKey = `${flightPlan.projectId}/${flight.flightPlanId}/${task.flightId}/outputs/orthophoto.log`
            const buf = await getObjectBuffer(logKey)
            logs = buf.toString('utf-8').split('\n')
          }
        }
      } catch (err) {
        console.error('[Georef Tasks API] Failed to fetch log from S3:', err)
        logs = task.error ? [task.error] : []
      }
    } else {
      logs = ['Task was canceled by user.']
    }

    return NextResponse.json({
      taskId,
      status: task.status,
      processed: task.totalImages ?? 0,
      total: task.totalImages ?? 0,
      outputKey: task.outputKey ?? null,
      error: task.error ?? null,
      output: logs.slice(outputLine),
    })
  }

  // Still running — proxy to Modal worker for live progress
  const workerUrl = process.env.MODAL_GEOREF_WORKER_URL
  const workerToken = process.env.MODAL_GEOREF_WORKER_TOKEN
  if (!workerUrl || !workerToken) {
    return NextResponse.json(
      { error: 'MODAL_GEOREF_WORKER_URL / MODAL_GEOREF_WORKER_TOKEN not set' },
      { status: 500 },
    )
  }

  let workerData: {
    task_id: string
    status: string
    processed: number
    total: number
    output_key: string | null
    error: string | null
    output?: string[]
  }

  try {
    const res = await fetch(`${workerUrl}/status/${taskId}`, {
      headers: { Authorization: `Bearer ${workerToken}` },
      cache: 'no-store',
    })
    console.log(`[georef GET] taskId=${taskId} workerStatus=${res.status} tokenLen=${workerToken.length}`)
    if (!res.ok) {
      const text = await res.text()
      console.error(`[georef GET] worker error status=${res.status} body=${text}`)
      // Worker container may have been recycled — treat as still running
      return NextResponse.json({
        taskId,
        status: 'running',
        processed: 0,
        total: task.totalImages ?? 0,
        outputKey: null,
        error: null,
      })
    }
    workerData = await res.json()
  } catch {
    return NextResponse.json({
      taskId,
      status: 'running',
      processed: 0,
      total: task.totalImages ?? 0,
      outputKey: null,
      error: null,
    })
  }

  // Sync status, processed, and progress to DB
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
          console.log(`[Georef Tasks API] Pre-fetched bounds for task ${taskId}:`, boundsStr)
        }
      }
    } catch (err) {
      console.error('[Georef Tasks API] Failed to pre-fetch bounds:', err)
    }

    await db
      .update(georefTasks)
      .set({
        status: 'completed',
        processed: workerData.processed,
        progress: 100,
        outputKey: workerData.output_key,
        bounds: boundsStr,
        completedAt: new Date(),
      })
      .where(eq(georefTasks.id, taskId))
  } else if (workerData.status === 'failed') {
    await db
      .update(georefTasks)
      .set({
        status: 'failed',
        processed: workerData.processed,
        progress: 0,
        error: workerData.error ?? 'Unknown error',
        completedAt: new Date(),
      })
      .where(eq(georefTasks.id, taskId))
  } else {
    // Still running or pending
    await db
      .update(georefTasks)
      .set({
        status: workerData.status as any,
        processed: workerData.processed,
        progress: progressVal,
      })
      .where(eq(georefTasks.id, taskId))
  }

  const logs = workerData.output ?? []

  return NextResponse.json({
    taskId,
    status: workerData.status,
    processed: workerData.processed,
    total: workerData.total,
    outputKey: workerData.output_key ?? null,
    error: workerData.error ?? null,
    output: logs.slice(outputLine),
  })
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { taskId } = await params
  const [task] = await db.select().from(georefTasks).where(eq(georefTasks.id, taskId))
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  // Update status to canceled in the database
  await db
    .update(georefTasks)
    .set({ status: 'canceled', completedAt: new Date() })
    .where(eq(georefTasks.id, taskId))

  return NextResponse.json({ success: true })
}
