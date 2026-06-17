import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { flights, flightPlans, projects } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { createPresignedUploadPost } from '@/lib/s3'

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  let body: { flightId: string; contentType: string; size: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { flightId, contentType, size } = body
  if (!flightId || !contentType || !size) {
    return NextResponse.json({ error: 'flightId, contentType, and size are required' }, { status: 400 })
  }

  // Load flight -> flight plan -> project
  const [flight] = await db.select().from(flights).where(eq(flights.id, flightId))
  if (!flight || flight.deletedAt) {
    return NextResponse.json({ error: 'Flight not found' }, { status: 404 })
  }

  const [flightPlan] = await db
    .select()
    .from(flightPlans)
    .where(eq(flightPlans.id, flight.flightPlanId))
  if (!flightPlan || flightPlan.deletedAt) {
    return NextResponse.json({ error: 'Flight plan not found' }, { status: 404 })
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, flightPlan.projectId))
  if (!project || project.deletedAt) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  try {
    // Generate a presigned POST policy directly to outputs/orthophoto.tif
    const post = await createPresignedUploadPost(
      project.id,
      flightPlan.id,
      flight.id,
      'outputs/orthophoto.tif',
      contentType,
      size
    )

    return NextResponse.json({ upload: post })
  } catch (err) {
    console.error('Failed to generate presigned upload POST for GeoTIFF:', err)
    return NextResponse.json({ error: 'Failed to generate upload signature' }, { status: 500 })
  }
}
