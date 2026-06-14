import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { flights, flightPlans, projects, georefTasks, odmTasks } from '@/lib/schema'
import { eq, and, isNull, or } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { listFlightObjects } from '@/lib/s3'

function canWrite(role: string) {
  return role === 'read-write' || role === 'admin'
}

/**
 * POST /api/georef/tasks
 * Body: { flightId: string, projectId: string, flightPlanId: string }
 *
 * Lists all JPEG/PNG images for the flight from S3, then sends them to the
 * Modal georef worker which downloads each from S3, computes the ground
 * footprint from DJI EXIF/XMP, creates individual GeoTIFFs, and merges them
 * into a single COG — all as a background Modal task.
 *
 * Returns: { taskId: string }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    flightId?: string
    projectId?: string
    flightPlanId?: string
    dewarp?: boolean
    altitudeMode?: string
    altitudeOffset?: number
    specifiedAltitude?: number
    sampleFactor?: number
    useLrf?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { flightId, projectId, flightPlanId, dewarp, altitudeMode, altitudeOffset, specifiedAltitude, sampleFactor, useLrf } = body
  if (!flightId || !projectId || !flightPlanId) {
    return NextResponse.json(
      { error: 'flightId, projectId, and flightPlanId are required' },
      { status: 400 },
    )
  }

  // Concurrency check: Ensure no other task is running for this flight
  const [activeOdm] = await db
    .select()
    .from(odmTasks)
    .where(
      and(
        eq(odmTasks.flightId, flightId),
        or(
          eq(odmTasks.status, 'uploading'),
          eq(odmTasks.status, 'queued'),
          eq(odmTasks.status, 'running')
        )
      )
    )
    .limit(1)

  const [activeGeoref] = await db
    .select()
    .from(georefTasks)
    .where(
      and(
        eq(georefTasks.flightId, flightId),
        or(
          eq(georefTasks.status, 'pending'),
          eq(georefTasks.status, 'running')
        )
      )
    )
    .limit(1)

  if (activeOdm || activeGeoref) {
    return NextResponse.json(
      { error: 'Another processing task (ODM or Georef) is currently running for this flight.' },
      { status: 400 }
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

  // List JPEG/PNG images, excluding any previously generated outputs
  let objects: { key: string }[]
  try {
    const all = await listFlightObjects(projectId, flightPlanId, flightId)
    objects = all.filter((o) => {
      const lower = o.key.toLowerCase()
      return (
        (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png')) &&
        !o.key.includes('/georef/') &&
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

  // Sort objects alphabetically by filename (representing sequential/chronological order)
  objects.sort((a, b) => {
    const aName = a.key.split('/').pop() || ''
    const bName = b.key.split('/').pop() || ''
    return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' })
  })

  const firstObject = objects[0]

  const workerUrl = process.env.MODAL_GEOREF_WORKER_URL
  const workerToken = process.env.MODAL_GEOREF_WORKER_TOKEN
  if (!workerUrl || !workerToken) {
    return NextResponse.json(
      { error: 'MODAL_GEOREF_WORKER_URL and MODAL_GEOREF_WORKER_TOKEN must be set' },
      { status: 500 },
    )
  }

  // Use our DB task ID also as the Modal task_id for idempotency
  const taskId = randomUUID()
  const outputPrefix = `${projectId}/${flightPlanId}/${flightId}/outputs`
  const images = objects.map((o) => ({
    key: o.key,
    filename: o.key.split('/').pop() ?? o.key,
  }))

  console.log(`[georef POST] taskId=${taskId} images=${images.length} workerUrl=${workerUrl} tokenLen=${workerToken.length}`)

  // Kick off Modal worker (fire-and-forget — it reports status via /status/:task_id)
  try {
    const res = await fetch(`${workerUrl}/georeference`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        task_id: taskId,
        images,
        bucket: process.env.S3_BUCKET_NAME,
        output_prefix: outputPrefix,
        dewarp: dewarp !== false, // Default to true if not specified
        altitude_mode: altitudeMode || (useLrf ? 'lrf' : 'relative'),
        altitude_offset: altitudeOffset != null ? Number(altitudeOffset) : 0.0,
        specified_altitude: specifiedAltitude != null ? Number(specifiedAltitude) : 50.0,
        sample_factor: sampleFactor != null ? Math.max(1, Math.round(Number(sampleFactor))) : 1,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[georef POST] worker error status=${res.status} body=${text}`)
      return NextResponse.json(
        { error: `Georef worker error (${res.status}): ${text}` },
        { status: 502 },
      )
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to reach georef worker: ${String(err)}` },
      { status: 502 },
    )
  }

  // Persist task record
  await db.insert(georefTasks).values({
    id: taskId,
    flightId,
    status: 'running',
    totalImages: images.length,
    outputKey: null,
    error: null,
    createdBy: session.userId,
    createdAt: new Date(),
    completedAt: null,
  })

  return NextResponse.json({ taskId })
}
