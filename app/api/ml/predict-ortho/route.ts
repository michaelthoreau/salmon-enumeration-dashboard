import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { odmTasks, georefTasks } from '@/lib/schema'
import { eq, desc, isNotNull, and } from 'drizzle-orm'

const MODAL_URL = process.env.MODAL_PREDICTION_URL ||
  'https://salmon2--salmon-prediction-api-salmoninferenceserver-fas-bc238e.modal.run'

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { outputKey, score_thresh } = await request.json()
  if (!outputKey) return NextResponse.json({ error: 'Missing outputKey' }, { status: 400 })

  // Find the most recent completed task with tiles for this outputKey
  const [odmTask] = await db
    .select({ tilesKey: odmTasks.tilesKey, bounds: odmTasks.bounds })
    .from(odmTasks)
    .where(and(eq(odmTasks.outputKey, outputKey), isNotNull(odmTasks.tilesKey)))
    .orderBy(desc(odmTasks.createdAt))
    .limit(1)

  const [georefTask] = await db
    .select({ tilesKey: georefTasks.tilesKey, bounds: georefTasks.bounds })
    .from(georefTasks)
    .where(and(eq(georefTasks.outputKey, outputKey), isNotNull(georefTasks.tilesKey)))
    .orderBy(desc(georefTasks.createdAt))
    .limit(1)

  const task = odmTask ?? georefTask
  if (!task?.tilesKey) {
    return NextResponse.json({ error: 'No tiles found for this ortho' }, { status: 404 })
  }

  // Parse cached bounds JSON: { bounds: [minlng, minlat, maxlng, maxlat], minzoom, maxzoom }
  let bounds = [-180, -85, 180, 85]
  let zoom = 20
  if (task.bounds) {
    try {
      const info = JSON.parse(task.bounds)
      if (Array.isArray(info.bounds)) bounds = info.bounds
      if (typeof info.maxzoom === 'number') zoom = info.maxzoom
    } catch {}
  }

  const modalRes = await fetch(`${MODAL_URL}/predict_ortho`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tiles_key: task.tilesKey, bounds, zoom, score_thresh: score_thresh ?? 0.25 }),
  })

  if (!modalRes.ok) {
    const text = await modalRes.text()
    return NextResponse.json({ error: text }, { status: modalRes.status })
  }

  return NextResponse.json(await modalRes.json())
}
