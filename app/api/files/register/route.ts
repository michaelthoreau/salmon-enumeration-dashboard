import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { files, flights } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { headObject } from '@/lib/s3'
import { randomUUID } from 'crypto'
import { extractExifGps } from '@/lib/exif'
import { tagFilesAgainstGeofences, getProjectIdForFlight } from '@/lib/geofence-tagger'

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

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

  const lower = key.toLowerCase()
  const isVideo = lower.endsWith('.mp4') || lower.endsWith('.mov')

  const [flight] = await db.select().from(flights).where(eq(flights.id, flightId))
  if (!flight || flight.deletedAt) {
    return NextResponse.json({ error: 'Flight not found' }, { status: 404 })
  }

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
      uploadedBy: session.userId,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
      durationSeconds: coords?.durationSeconds ?? null,
      ...(isVideo && { compressionStatus: 'done' }),
    })
    .onConflictDoUpdate({
      target: files.key,
      set: {
        etag,
        size: contentLength,
        uploadedAt: new Date(),
        uploadedBy: session.userId,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
        durationSeconds: coords?.durationSeconds ?? null,
        ...(isVideo && { compressionStatus: 'done' }),
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
