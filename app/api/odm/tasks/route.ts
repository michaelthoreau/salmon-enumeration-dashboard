import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { flights, flightPlans, projects, odmTasks } from '@/lib/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { listFlightObjects } from '@/lib/s3'

function canWrite(role: string) {
  return role === 'read-write' || role === 'admin'
}

/**
 * POST /api/odm/tasks
 * Body: { flightId: string, projectId: string, flightPlanId: string }
 *
 * Builds the image list from S3, then hands off to the Modal ODM worker which
 * handles the S3→NodeODM upload concurrently without being constrained by the
 * Next.js request timeout.  Returns { taskId } once the worker has committed
 * the ODM task so the client can begin polling for status.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { flightId?: string; projectId?: string; flightPlanId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { flightId, projectId, flightPlanId } = body
  if (!flightId || !projectId || !flightPlanId) {
    return NextResponse.json(
      { error: 'flightId, projectId, and flightPlanId are required' },
      { status: 400 },
    )
  }

  // Verify entities exist and aren't soft-deleted
  const [flight] = await db
    .select()
    .from(flights)
    .where(and(eq(flights.id, flightId), isNull(flights.deletedAt)))
  if (!flight) return NextResponse.json({ error: 'Flight not found' }, { status: 404 })

  const [flightPlan] = await db
    .select()
    .from(flightPlans)
    .where(and(eq(flightPlans.id, flightPlanId), isNull(flightPlans.deletedAt)))
  if (!flightPlan) return NextResponse.json({ error: 'Flight plan not found' }, { status: 404 })

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  // List S3 objects for this flight, filtering out any previously stored ODM outputs
  let objects: { key: string }[]
  try {
    const all = await listFlightObjects(projectId, flightPlanId, flightId)
    objects = all.filter((o) => {
      const lower = o.key.toLowerCase()
      return (
        (lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') ||
          lower.endsWith('.png') ||
          lower.endsWith('.tif') ||
          lower.endsWith('.tiff')) &&
        !o.key.includes('/odm/')
      )
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to list S3 objects: ${String(err)}` },
      { status: 500 },
    )
  }

  if (objects.length === 0) {
    return NextResponse.json({ error: 'No images found for this flight' }, { status: 400 })
  }

  // Resolve Modal worker configuration
  const workerUrl = process.env.MODAL_ODM_WORKER_URL
  const workerToken = process.env.MODAL_ODM_WORKER_TOKEN
  if (!workerUrl || !workerToken) {
    return NextResponse.json(
      { error: 'MODAL_ODM_WORKER_URL and MODAL_ODM_WORKER_TOKEN must be set' },
      { status: 500 },
    )
  }

  const taskName = `${project.name} / ${flightPlan.name} / ${flight.timestamp.toISOString()}`
  const images = objects.map((o) => ({
    key: o.key,
    filename: o.key.split('/').pop() ?? o.key,
  }))

  // Call the Modal worker — it inits the ODM task and immediately returns {odm_uuid}
  // while uploading continues in the background on Modal.
  let odmUuid: string
  try {
    const res = await fetch(`${workerUrl}/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({ task_name: taskName, images }),
    })
    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json(
        { error: `Modal worker error (${res.status}): ${text}` },
        { status: 502 },
      )
    }
    const data = (await res.json()) as { odm_uuid: string }
    odmUuid = data.odm_uuid
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to reach Modal worker: ${String(err)}` },
      { status: 502 },
    )
  }

  // Persist the task immediately — status starts as 'uploading' until the Modal
  // background task finishes uploading and commits to NodeODM.
  const taskId = randomUUID()
  await db.insert(odmTasks).values({
    id: taskId,
    flightId,
    odmUuid,
    status: 'uploading',
    totalImages: images.length,
    outputKey: null,
    createdBy: session.userId,
    createdAt: new Date(),
    completedAt: null,
  })

  return NextResponse.json({ taskId })
}

