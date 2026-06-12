import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { files, flights } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { headObject } from '@/lib/s3'
import { randomUUID } from 'crypto'

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

  const [flight] = await db.select().from(flights).where(eq(flights.id, flightId))
  if (!flight || flight.deletedAt) {
    return NextResponse.json({ error: 'Flight not found' }, { status: 404 })
  }

  const { etag, contentLength } = await headObject(key)

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
    })
    .onConflictDoUpdate({
      target: files.key,
      set: { etag, size: contentLength, uploadedAt: new Date(), uploadedBy: session.userId },
    })

  return NextResponse.json({ ok: true, etag })
}
