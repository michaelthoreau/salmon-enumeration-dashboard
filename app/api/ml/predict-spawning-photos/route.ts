import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 800

import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { files } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { createPresignedGetUrl } from '@/lib/s3'

// Same deployed Modal service as predict-ortho — /predict_raw_photos is a new
// route on that app, not a separate service.
const MODAL_URL = process.env.MODAL_PREDICTION_URL ||
  'https://salmon2--salmon-prediction-api-salmoninferenceserver-fas-bc238e.modal.run'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif'])

function isImageKey(key: string): boolean {
  return IMAGE_EXTS.has(key.split('.').pop()?.toLowerCase() ?? '')
}

// Runs detection across a spawning flight's raw source photos instead of its
// orthomosaic — ortho stitching distortion was hurting detection quality for
// stationary spawning salmon, so this projects each raw-photo detection to a
// real-world lat/lon via the photo's own GPS + gimbal pose (same math the
// georef worker uses) and dedupes detections of the same fish seen across
// multiple overlapping photos, entirely on the Modal side.
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { flightId, score_thresh, dedup_radius_m } = await request.json()
  if (!flightId) return NextResponse.json({ error: 'Missing flightId' }, { status: 400 })

  const flightFiles = await db
    .select({ key: files.key })
    .from(files)
    .where(eq(files.flightId, flightId))

  const imageFiles = flightFiles.filter(f => isImageKey(f.key))
  if (imageFiles.length === 0) {
    return NextResponse.json({ error: 'No raw photos found for this flight' }, { status: 404 })
  }

  const photos = await Promise.all(
    imageFiles.map(async f => ({
      url: await createPresignedGetUrl(f.key, 3600),
      filename: f.key.split('/').pop() ?? f.key,
    }))
  )

  const modalRes = await fetch(`${MODAL_URL}/predict_raw_photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      photos,
      score_thresh: score_thresh ?? 0.25,
      dedup_radius_m: dedup_radius_m ?? 1.5,
    }),
  })

  if (!modalRes.ok) {
    const text = await modalRes.text()
    return NextResponse.json({ error: text }, { status: modalRes.status })
  }

  return NextResponse.json(await modalRes.json())
}
