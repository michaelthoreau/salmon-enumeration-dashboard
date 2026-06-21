import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { flights, flightPlans, projects } from '@/lib/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { createPresignedUploadPost } from '@/lib/s3'

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/quicktime', 'application/octet-stream',
])

/** Strip path separators and leading dots to prevent path traversal in S3 keys. */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/^\.+/, '')
}

// POST /api/v1/upload
// Body: { flightId, files: [{ name, type, size }] }
// Returns: { uploads: [{ name, url, fields }] }
export async function POST(request: NextRequest) {
  const key = await validateApiKey(request.headers.get('authorization'))
  if (!key) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { flightId: string; files: { name: string; type: string; size: number }[] }
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { flightId, files } = body
  if (!flightId || !Array.isArray(files) || files.length === 0) {
    return NextResponse.json({ error: 'flightId and files[] are required' }, { status: 400 })
  }
  if (files.length > 500) {
    return NextResponse.json({ error: 'Maximum 500 files per batch' }, { status: 400 })
  }

  const [flight] = await db.select().from(flights).where(and(eq(flights.id, flightId), isNull(flights.deletedAt)))
  if (!flight) return NextResponse.json({ error: 'Flight not found' }, { status: 404 })

  const [plan] = await db.select().from(flightPlans).where(and(eq(flightPlans.id, flight.flightPlanId), isNull(flightPlans.deletedAt)))
  if (!plan) return NextResponse.json({ error: 'Flight plan not found' }, { status: 404 })

  const [project] = await db.select().from(projects).where(and(eq(projects.id, plan.projectId), isNull(projects.deletedAt)))
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  for (const f of files) {
    if (!f.name || typeof f.name !== 'string') {
      return NextResponse.json({ error: 'Each file must have a name' }, { status: 400 })
    }
    const ext = f.name.split('.').pop()?.toLowerCase()
    if (ext === 'tif' || ext === 'tiff') {
      return NextResponse.json(
        { error: 'TIFF files (.tif/.tiff) cannot be uploaded as raw flight images. Use the "Upload GeoTIFF" option in the Processing Modal instead.' },
        { status: 400 },
      )
    }
    if (!ALLOWED_TYPES.has(f.type)) {
      return NextResponse.json({ error: `File type not allowed: ${f.type}` }, { status: 400 })
    }
    if (f.size > 5 * 1024 * 1024 * 1024) {
      return NextResponse.json({ error: 'File exceeds 5 GB limit' }, { status: 400 })
    }
  }

  const uploads = await Promise.all(
    files.map(async (f) => {
      const { url, fields } = await createPresignedUploadPost(
        project.id,
        plan.id,
        flight.id,
        sanitizeFileName(f.name),
        f.type,
        f.size,
      )
      return { name: f.name, url, fields }
    }),
  )

  return NextResponse.json({ uploads })
}
