import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { files, flights, flightPlans, projects } from '@/lib/schema'
import { eq, and, isNull, or, like, not, desc } from 'drizzle-orm'

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.MP4', '.MOV', '.AVI', '.MKV']

export async function GET(request: NextRequest) {
  const apiKey = await validateApiKey(request.headers.get('authorization'))
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const searchParams = request.nextUrl.searchParams
  const projectId = searchParams.get('projectId')
  const flightPlanId = searchParams.get('flightPlanId')
  const flightId = searchParams.get('flightId')
  const type = searchParams.get('type')
  const limit = Math.min(1000, Math.max(1, Number(searchParams.get('limit') ?? '50')))
  const offset = Math.max(0, Number(searchParams.get('offset') ?? '0'))

  const conditions = []

  // Soft delete filters
  conditions.push(isNull(flights.deletedAt))
  conditions.push(isNull(flightPlans.deletedAt))
  conditions.push(isNull(projects.deletedAt))

  if (projectId) {
    conditions.push(eq(flightPlans.projectId, projectId))
  }
  if (flightPlanId) {
    conditions.push(eq(flights.flightPlanId, flightPlanId))
  }
  if (flightId) {
    conditions.push(eq(files.flightId, flightId))
  }

  // Type filters (video vs image)
  const videoConditions = VIDEO_EXTS.map((ext) => like(files.key, `%${ext}`))
  const videoOr = or(...videoConditions)
  if (videoOr) {
    if (type === 'video') {
      conditions.push(videoOr)
    } else if (type === 'image') {
      conditions.push(not(videoOr))
    }
  }

  const rows = await db
    .select({
      id: files.id,
      flightId: files.flightId,
      key: files.key,
      etag: files.etag,
      split: files.split,
      uploadedAt: files.uploadedAt,
      uploadedBy: files.uploadedBy,
      imageWidth: files.imageWidth,
      imageHeight: files.imageHeight,
      size: files.size,
      latitude: files.latitude,
      longitude: files.longitude,
      durationSeconds: files.durationSeconds,
      reviewStatus: files.reviewStatus,
      reviewRating: files.reviewRating,
      reviewedBy: files.reviewedBy,
      reviewedAt: files.reviewedAt,
      hidden: files.hidden,
      projectId: flightPlans.projectId,
      flightPlanId: flights.flightPlanId,
    })
    .from(files)
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .innerJoin(projects, eq(flightPlans.projectId, projects.id))
    .where(and(...conditions))
    .orderBy(desc(files.uploadedAt))
    .limit(limit)
    .offset(offset)

  return NextResponse.json(rows)
}
