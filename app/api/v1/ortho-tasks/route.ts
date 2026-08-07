import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { annotations, odmTasks, georefTasks } from '@/lib/schema'
import { eq, and, isNull, desc, gt } from 'drizzle-orm'

// Exports ground-truth points already placed/approved directly on the
// orthomosaic map (annotations.fileId IS NULL) as synthetic "tasks" shaped
// exactly like /api/v1/labeling-tasks output, so the training pipeline can
// consume both without a separate data loader. Each task's fileId encodes an
// ortho tile ("ortho:{flightId}:{z}:{x}:{y}") instead of a real files.id.
// The `label` query param selects which annotation label to export — 'fish'
// (default, migration/swimming counts) or 'spawning_salmon' — since the two
// train separate models and must never be mixed into one export.

const TILE_SIZE = 256
const MAX_TILES_PER_FLIGHT = 2000
const ZOOM_BACKOFF_STEPS = 6
const MIN_ZOOM_FLOOR = 14
const POLE_LAT_LIMIT = 85.0511

// Web Mercator lat/lng -> tile index + pixel offset within that tile.
// Mirrors _latlon_to_tile / _pixel_to_latlon in salmon-enumeration-ml's
// predict_modal.py so train-time and inference-time tile math don't drift.
function projectLatLng(z: number, lat: number, lng: number) {
  const clampedLat = Math.max(-POLE_LAT_LIMIT, Math.min(POLE_LAT_LIMIT, lat))
  const n = Math.pow(2, z)
  const xFloat = ((lng + 180) / 360) * n
  const latRad = (clampedLat * Math.PI) / 180
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const tileX = Math.floor(xFloat)
  const tileY = Math.floor(yFloat)
  return {
    tileX,
    tileY,
    pixelX: (xFloat - tileX) * TILE_SIZE,
    pixelY: (yFloat - tileY) * TILE_SIZE,
  }
}

// Mirrors predict_modal.py's /predict_ortho zoom-backoff loop (lines ~801-811):
// back the zoom level down from the flight's cached maxzoom until the whole
// flight's tile count is <= 2000. Keeps training-time apparent fish size
// consistent with whatever zoom production inference actually uses for a
// flight of this size (large flights get inferred at a lower/coarser zoom).
function pickZoom(bounds: [number, number, number, number], initialZoom: number): number {
  const [minlng, minlat, maxlng, maxlat] = bounds
  let zoom = initialZoom
  const floor = Math.max(initialZoom - ZOOM_BACKOFF_STEPS, MIN_ZOOM_FLOOR)
  for (let z = initialZoom; z >= floor; z--) {
    const min = projectLatLng(z, maxlat, minlng)
    const max = projectLatLng(z, minlat, maxlng)
    const tileCount = (max.tileX - min.tileX + 1) * (max.tileY - min.tileY + 1)
    if (tileCount <= MAX_TILES_PER_FLIGHT) {
      zoom = z
      break
    }
  }
  return zoom
}

type ResolvedOrtho = {
  outputKey: string
  bounds: string | null
  completedAt: Date
}

// Same "prefer whichever of odmTasks/georefTasks is newer" resolution used in
// app/api/ml/predict-ortho/route.ts and the flight detail page, applied here
// by flightId instead of by outputKey.
async function resolveFlightOrtho(flightId: string): Promise<ResolvedOrtho | null> {
  const [latestOdmTask] = await db
    .select()
    .from(odmTasks)
    .where(eq(odmTasks.flightId, flightId))
    .orderBy(desc(odmTasks.createdAt))
    .limit(1)

  const [latestGeorefTask] = await db
    .select()
    .from(georefTasks)
    .where(eq(georefTasks.flightId, flightId))
    .orderBy(desc(georefTasks.createdAt))
    .limit(1)

  const odmOutputKey = latestOdmTask?.outputKey ?? null
  const georefOutputKey = latestGeorefTask?.outputKey ?? null

  let chosen: { outputKey: string; bounds: string | null; completedAt: Date | null } | null = null
  if (odmOutputKey && georefOutputKey) {
    chosen = new Date(latestGeorefTask!.createdAt) > new Date(latestOdmTask!.createdAt)
      ? { outputKey: georefOutputKey, bounds: latestGeorefTask!.bounds, completedAt: latestGeorefTask!.completedAt }
      : { outputKey: odmOutputKey, bounds: latestOdmTask!.bounds, completedAt: latestOdmTask!.completedAt }
  } else if (odmOutputKey) {
    chosen = { outputKey: odmOutputKey, bounds: latestOdmTask!.bounds, completedAt: latestOdmTask!.completedAt }
  } else if (georefOutputKey) {
    chosen = { outputKey: georefOutputKey, bounds: latestGeorefTask!.bounds, completedAt: latestGeorefTask!.completedAt }
  }

  if (!chosen || !chosen.completedAt) return null
  return { outputKey: chosen.outputKey, bounds: chosen.bounds, completedAt: chosen.completedAt }
}

type OrthoTileTask = {
  fileId: string
  frame: number
  x1: number
  y1: number
  x2: number
  y2: number
  flightId: string
  orthoKey: string
  bucket: string
  tileZ: number
  tileX: number
  tileY: number
  points: { x: number; y: number }[]
}

export async function GET(request: NextRequest) {
  const apiKey = await validateApiKey(request.headers.get('authorization'))
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const searchParams = request.nextUrl.searchParams
  const flightIdParam = searchParams.get('flightId')
  // 'fish' (migration/swimming-salmon counts) is the default to preserve
  // existing training-pipeline behavior; pass ?label=spawning_salmon to
  // export the stationary spawning-ground ground truth instead. The two
  // are never mixed into the same export.
  const label = searchParams.get('label') ?? 'fish'
  const limit = Math.min(5000, Math.max(1, Number(searchParams.get('limit') ?? '2000')))
  const offset = Math.max(0, Number(searchParams.get('offset') ?? '0'))

  const s3Bucket = process.env.S3_BUCKET_NAME ?? ''

  let flightIds: string[]
  if (flightIdParam) {
    flightIds = [flightIdParam]
  } else {
    const rows = await db
      .selectDistinct({ flightId: annotations.flightId })
      .from(annotations)
      .where(and(isNull(annotations.deletedAt), isNull(annotations.fileId), eq(annotations.shape, 'point'), eq(annotations.label, label)))
    flightIds = rows.map((r) => r.flightId)
  }

  const tileTasks = new Map<string, OrthoTileTask>()
  let skippedMultiFish = 0
  let skippedStaleGeometry = 0
  let skippedNoOrtho = 0

  for (const flightId of flightIds) {
    const ortho = await resolveFlightOrtho(flightId)
    if (!ortho) {
      skippedNoOrtho++
      continue
    }

    let bounds: [number, number, number, number] = [-180, -85, 180, 85]
    let maxzoom = 20
    if (ortho.bounds) {
      try {
        const info = JSON.parse(ortho.bounds)
        if (Array.isArray(info.bounds)) bounds = info.bounds
        if (typeof info.maxzoom === 'number') maxzoom = info.maxzoom
      } catch {}
    }
    const zoom = pickZoom(bounds, maxzoom)

    // Only trust annotations placed/edited after this ortho run completed —
    // a flight can be reprocessed, and annotations have no FK back to the
    // specific ortho run they were drawn against, so an older annotation may
    // no longer align with the current raster's georeferencing.
    const pointRows = await db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.flightId, flightId),
          isNull(annotations.deletedAt),
          isNull(annotations.fileId),
          eq(annotations.shape, 'point'),
          eq(annotations.label, label),
          gt(annotations.modifiedAt, ortho.completedAt)
        )
      )

    for (const row of pointRows) {
      if (row.fishCount !== 1) {
        // A single point can represent >1 fish via a count-bump UI rather
        // than a separate point per fish; skip rather than emit a
        // mis-positioned/undercounted box for v1.
        skippedMultiFish++
        continue
      }

      let geom: { type?: string; coordinates?: [number, number] } | undefined
      try {
        geom = JSON.parse(row.geometry)
      } catch {
        skippedStaleGeometry++
        continue
      }
      if (geom?.type !== 'Point' || !Array.isArray(geom.coordinates)) {
        skippedStaleGeometry++
        continue
      }
      const [lng, lat] = geom.coordinates

      const { tileX, tileY, pixelX, pixelY } = projectLatLng(zoom, lat, lng)
      const fileId = `ortho:${flightId}:${zoom}:${tileX}:${tileY}`

      let task = tileTasks.get(fileId)
      if (!task) {
        task = {
          fileId,
          frame: 0,
          // Degenerate bbox (x2<=x1) on purpose: the ML-side loader stitches a
          // configurable neighborhood of tiles around this task's center tile,
          // so the actual downloaded frame size is a loader-side concern, not
          // something this endpoint should hardcode. Points below stay relative
          // to just the center tile (0..TILE_SIZE); the loader is responsible
          // for shifting them by its own stitch margin.
          x1: 0,
          y1: 0,
          x2: 0,
          y2: 0,
          flightId,
          orthoKey: ortho.outputKey,
          bucket: s3Bucket,
          tileZ: zoom,
          tileX,
          tileY,
          points: [],
        }
        tileTasks.set(fileId, task)
      }
      task.points.push({ x: pixelX, y: pixelY })
    }
  }

  console.log(
    `[ortho-tasks] label=${label} flights=${flightIds.length} tiles=${tileTasks.size} ` +
    `skipped(no-ortho)=${skippedNoOrtho} skipped(multi-fish)=${skippedMultiFish} skipped(stale-geometry)=${skippedStaleGeometry}`
  )

  const allTasks = Array.from(tileTasks.values())
  const paged = allTasks.slice(offset, offset + limit)

  return NextResponse.json(paged)
}
