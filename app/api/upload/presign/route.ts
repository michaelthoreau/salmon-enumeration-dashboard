import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { flights, flightPlans, projects } from '@/lib/schema'
import { eq, isNull } from 'drizzle-orm'
import { createPresignedUploadPost } from '@/lib/s3'

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'application/octet-stream',
])

/** Strip path separators and leading dots to prevent path traversal in S3 keys. */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/^\.+/, '')
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  let body: { flightId: string; files: { name: string; type: string; size: number }[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { flightId, files } = body

  if (!flightId || !Array.isArray(files) || files.length === 0) {
    return NextResponse.json({ error: 'flightId and files[] are required' }, { status: 400 })
  }

  if (files.length > 500) {
    return NextResponse.json({ error: 'Maximum 500 files per batch' }, { status: 400 })
  }

  // Load flight → flight plan → project (all must be active)
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

  // Validate each file
  for (const file of files) {
    if (!file.name || typeof file.name !== 'string') {
      return NextResponse.json({ error: 'Each file must have a name' }, { status: 400 })
    }
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (ext === 'tif' || ext === 'tiff') {
      return NextResponse.json(
        { error: 'TIFF files (.tif/.tiff) cannot be uploaded as raw flight images. Use the "Upload GeoTIFF" option in the Processing Modal instead.' },
        { status: 400 },
      )
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `File type not allowed: ${file.type}` },
        { status: 400 },
      )
    }
    if (file.size > 5 * 1024 * 1024 * 1024) {
      return NextResponse.json({ error: 'File exceeds 5 GB limit' }, { status: 400 })
    }
  }

  // Generate presigned POST policies in parallel (concurrency-safe — each key is unique)
  const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime'])

  const presignedPosts = await Promise.all(
    files.map((file) =>
      createPresignedUploadPost(
        project.id,
        flightPlan.id,
        flight.id,
        sanitizeFileName(file.name),
        file.type,
        file.size,
        VIDEO_TYPES.has(file.type),
      ).then((post) => ({ name: file.name, ...post })),
    ),
  )

  return NextResponse.json({ uploads: presignedPosts })
}
