import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { georefTasks, flights } from '@/lib/schema'
import { eq } from 'drizzle-orm'
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

  // Load flight
  const [flight] = await db.select().from(flights).where(eq(flights.id, flightId))
  if (!flight || flight.deletedAt) {
    return NextResponse.json({ error: 'Flight not found' }, { status: 404 })
  }

  // Pre-fetch bounds from the tile server
  let boundsStr: string | null = null
  try {
    const url = process.env.MODAL_TILE_SERVER_URL
    const token = process.env.MODAL_TILE_TOKEN
    if (url && token) {
      const targetUrl = `${url}/info?key=${encodeURIComponent(key)}` + (process.env.S3_BUCKET_NAME ? `&bucket=${encodeURIComponent(process.env.S3_BUCKET_NAME)}` : '')
      const infoRes = await fetch(targetUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (infoRes.ok) {
        boundsStr = await infoRes.text()
        console.log(`[Geotiff Register API] Pre-fetched bounds for key ${key}:`, boundsStr)
      } else {
        const errorText = await infoRes.text()
        console.warn(`[Geotiff Register API] Tile server returned status ${infoRes.status}:`, errorText)
      }
    }
  } catch (err) {
    console.error('[Geotiff Register API] Failed to pre-fetch bounds from tile server:', err)
  }

  // Create a completed georefTask record in the database
  const taskId = randomUUID()
  try {
    await db
      .insert(georefTasks)
      .values({
        id: taskId,
        flightId,
        status: 'completed',
        totalImages: 0,
        outputKey: key,
        createdBy: session.userId,
        createdAt: new Date(),
        completedAt: new Date(),
        bounds: boundsStr,
        processed: 0,
        progress: 100,
      })

    return NextResponse.json({ ok: true, taskId })
  } catch (err) {
    console.error('[Geotiff Register API] Database insert failed:', err)
    return NextResponse.json({ error: 'Failed to write task record to database' }, { status: 500 })
  }
}
