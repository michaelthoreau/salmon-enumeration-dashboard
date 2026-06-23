import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { files, flights } from '@/lib/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { headObject } from '@/lib/s3'
import { randomUUID } from 'crypto'
import { extractExifGps } from '@/lib/exif'
import { tagFilesAgainstGeofences, getProjectIdForFlight } from '@/lib/geofence-tagger'

// POST /api/v1/files/register
// Body: { key, flightId }
// Registers an S3 object (already placed at `key`) as a file belonging to `flightId`.
export async function POST(request: NextRequest) {
  const apiKey = await validateApiKey(request.headers.get('authorization'))
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { key: string; flightId: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { key, flightId } = body
  if (!key || !flightId) {
    return NextResponse.json({ error: 'key and flightId are required' }, { status: 400 })
  }

  const [flight] = await db.select().from(flights).where(and(eq(flights.id, flightId), isNull(flights.deletedAt)))
  if (!flight) return NextResponse.json({ error: 'Flight not found' }, { status: 404 })

  const { etag, contentLength } = await headObject(key)
  const coords = await extractExifGps(key)

  await db
    .insert(files)
    .values({
      id: randomUUID(),
      flightId,
      key,
      etag,
      size: contentLength,
      uploadedAt: new Date(),
      uploadedBy: `api:${apiKey.id}`,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
    })
    .onConflictDoUpdate({
      target: files.key,
      set: {
        etag,
        size: contentLength,
        uploadedAt: new Date(),
        uploadedBy: `api:${apiKey.id}`,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      },
    })

  if (coords) {
    const projectId = await getProjectIdForFlight(flightId)
    if (projectId) {
      const [file] = await db.select({ id: files.id }).from(files).where(eq(files.key, key))
      if (file) {
        tagFilesAgainstGeofences(projectId, [{ id: file.id, latitude: coords.latitude, longitude: coords.longitude }]).catch(() => {})
      }
    }
  }

  return NextResponse.json({ ok: true, etag })
}
