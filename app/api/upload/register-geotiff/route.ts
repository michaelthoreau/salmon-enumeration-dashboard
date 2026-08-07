import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { georefTasks, flights, flightPlans } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  let body: { key: string; flightId: string; tfwKey?: string; epsg?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { key, flightId, tfwKey, epsg } = body
  if (!key || !flightId) {
    return NextResponse.json({ error: 'key and flightId are required' }, { status: 400 })
  }
  if (tfwKey && !epsg) {
    return NextResponse.json({ error: 'epsg is required when tfwKey is provided' }, { status: 400 })
  }

  // Load flight
  const [flight] = await db.select().from(flights).where(eq(flights.id, flightId))
  if (!flight || flight.deletedAt) {
    return NextResponse.json({ error: 'Flight not found' }, { status: 404 })
  }

  // Load flightPlan
  const [flightPlan] = await db.select().from(flightPlans).where(eq(flightPlans.id, flight.flightPlanId))
  if (!flightPlan || flightPlan.deletedAt) {
    return NextResponse.json({ error: 'Flight plan not found' }, { status: 404 })
  }

  const taskId = randomUUID()
  const outputPrefix = `${flightPlan.projectId}/${flight.flightPlanId}/${flightId}/outputs`

  const workerUrl = process.env.MODAL_GEOREF_WORKER_URL
  const workerToken = process.env.MODAL_GEOREF_WORKER_TOKEN
  if (!workerUrl || !workerToken) {
    return NextResponse.json(
      { error: 'MODAL_GEOREF_WORKER_URL and MODAL_GEOREF_WORKER_TOKEN must be set' },
      { status: 500 },
    )
  }

  if (tfwKey) {
    // World-file path: the uploaded TIFF has no usable embedded georeferencing, only
    // a sidecar .tfw (+ the EPSG the caller supplied, since a world file never carries
    // a CRS). The worker bakes both into a proper COG at a NEW key — the original
    // upload is left untouched as raw input — then tiles it, same as the direct path.
    const outputKey = `${outputPrefix}/orthophoto_georeferenced.tif`
    try {
      const res = await fetch(`${workerUrl}/apply_worldfile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
        body: JSON.stringify({
          task_id: taskId,
          tif_key: key,
          tfw_key: tfwKey,
          epsg,
          bucket: process.env.S3_BUCKET_NAME,
          output_prefix: outputPrefix,
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        console.error(`[Geotiff Register API] Worker world-file application failed: ${text}`)
        return NextResponse.json({ error: `World-file worker failed: ${text}` }, { status: 502 })
      }
    } catch (err) {
      console.error('[Geotiff Register API] Failed to trigger georef worker world-file application:', err)
      return NextResponse.json({ error: `Failed to trigger georef worker: ${String(err)}` }, { status: 502 })
    }

    // bounds intentionally left null here — the corrected file doesn't exist at
    // outputKey yet (the worker is still running); /api/tiles/info lazily computes
    // and caches bounds itself the first time the map requests them, same as any
    // other task whose bounds weren't pre-fetched.
    try {
      await db.insert(georefTasks).values({
        id: taskId,
        flightId,
        status: 'running',
        totalImages: 0,
        outputKey,
        createdBy: session.userId,
        createdAt: new Date(),
        completedAt: null,
        bounds: null,
        processed: 0,
        progress: 0,
      })
      return NextResponse.json({ ok: true, taskId })
    } catch (err) {
      console.error('[Geotiff Register API] Database insert failed:', err)
      return NextResponse.json({ error: 'Failed to write task record to database' }, { status: 500 })
    }
  }

  // Existing path: TIFF already has valid embedded GeoTIFF tags — pre-fetch bounds
  // from the tile server and kick off static tiling directly against the uploaded key.
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

  try {
    const res = await fetch(`${workerUrl}/tile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        task_id: taskId,
        key: key,
        bucket: process.env.S3_BUCKET_NAME,
        output_prefix: outputPrefix,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[Geotiff Register API] Worker tiling initiation failed: ${text}`)
      return NextResponse.json({ error: `Tiling worker failed: ${text}` }, { status: 502 })
    }
  } catch (err) {
    console.error('[Geotiff Register API] Failed to trigger georef worker tiling:', err)
    return NextResponse.json({ error: `Failed to trigger georef worker: ${String(err)}` }, { status: 502 })
  }

  // Create a running georefTask record in the database
  try {
    await db
      .insert(georefTasks)
      .values({
        id: taskId,
        flightId,
        status: 'running',
        totalImages: 0,
        outputKey: key,
        createdBy: session.userId,
        createdAt: new Date(),
        completedAt: null,
        bounds: boundsStr,
        processed: 0,
        progress: 0,
      })

    return NextResponse.json({ ok: true, taskId })
  } catch (err) {
    console.error('[Geotiff Register API] Database insert failed:', err)
    return NextResponse.json({ error: 'Failed to write task record to database' }, { status: 500 })
  }
}
