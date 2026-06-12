import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { georefTasks } from '@/lib/schema'
import { eq } from 'drizzle-orm'

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

  // Already terminal — return the DB state directly without proxying
  if (task.status === 'completed' || task.status === 'failed') {
    return NextResponse.json({
      taskId,
      status: task.status,
      processed: task.totalImages ?? 0,
      total: task.totalImages ?? 0,
      outputKey: task.outputKey ?? null,
      error: task.error ?? null,
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

  // Sync terminal states back to DB
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
        error: workerData.error ?? 'Unknown error',
        completedAt: new Date(),
      })
      .where(eq(georefTasks.id, taskId))
  }

  return NextResponse.json({
    taskId,
    status: workerData.status,
    processed: workerData.processed,
    total: workerData.total,
    outputKey: workerData.output_key ?? null,
    error: workerData.error ?? null,
  })
}
