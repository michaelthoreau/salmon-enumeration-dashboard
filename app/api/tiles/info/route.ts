import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { odmTasks, georefTasks } from '@/lib/schema'
import { eq, desc } from 'drizzle-orm'

function getTileServer(): { url: string; token: string } {
  const url = process.env.MODAL_TILE_SERVER_URL
  const token = process.env.MODAL_TILE_TOKEN
  if (!url || !token) throw new Error('Tile server not configured (MODAL_TILE_SERVER_URL / MODAL_TILE_TOKEN missing)')
  return { url, token }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const key = request.nextUrl.searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 })

  // 1. Check if bounds are already cached in the database (resolving to most recent completed task)
  let cachedInfo: string | null = null
  let matchingTaskType: 'odm' | 'georef' | null = null
  let matchingTaskId: string | null = null

  try {
    const [odmMatch] = await db
      .select({ id: odmTasks.id, bounds: odmTasks.bounds, completedAt: odmTasks.completedAt })
      .from(odmTasks)
      .where(eq(odmTasks.outputKey, key))
      .orderBy(desc(odmTasks.completedAt))
      .limit(1)

    const [georefMatch] = await db
      .select({ id: georefTasks.id, bounds: georefTasks.bounds, completedAt: georefTasks.completedAt })
      .from(georefTasks)
      .where(eq(georefTasks.outputKey, key))
      .orderBy(desc(georefTasks.completedAt))
      .limit(1)

    if (odmMatch && georefMatch) {
      if (odmMatch.completedAt && georefMatch.completedAt && odmMatch.completedAt > georefMatch.completedAt) {
        cachedInfo = odmMatch.bounds
        matchingTaskType = 'odm'
        matchingTaskId = odmMatch.id
      } else {
        cachedInfo = georefMatch.bounds
        matchingTaskType = 'georef'
        matchingTaskId = georefMatch.id
      }
    } else if (odmMatch) {
      cachedInfo = odmMatch.bounds
      matchingTaskType = 'odm'
      matchingTaskId = odmMatch.id
    } else if (georefMatch) {
      cachedInfo = georefMatch.bounds
      matchingTaskType = 'georef'
      matchingTaskId = georefMatch.id
    }
  } catch (err) {
    console.error('[Tiles Info] DB lookup failed:', err)
  }

  if (cachedInfo) {
    console.log(`[Tiles Info] Returning cached bounds from DB for key: ${key}`)
    return NextResponse.json(JSON.parse(cachedInfo))
  }

  const { url, token } = getTileServer()
  const bucket = process.env.S3_BUCKET_NAME || ''
  let res: Response
  try {
    console.log(`[Tiles Info] Fetching tile info for key: ${key} (bucket: ${bucket})`);
    const targetUrl = `${url}/info?key=${encodeURIComponent(key)}` + (bucket ? `&bucket=${encodeURIComponent(bucket)}` : '')
    console.log(`[Tiles Info] Target URL: ${targetUrl}`);
    const startTime = Date.now();
    res = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    })
    const duration = Date.now() - startTime;
    console.log(`[Tiles Info] Tile server response status: ${res.status} (took ${duration}ms)`);
  } catch (err) {
    console.error(`[Tiles Info] Error reaching tile server:`, err);
    return NextResponse.json({ error: `Tile server unreachable: ${String(err)}` }, { status: 502 })
  }

  if (!res.ok) {
    const text = await res.text()
    console.error(`[Tiles Info] Tile server returned non-ok status: ${res.status}. Body: ${text}`);
    return NextResponse.json({ error: `Tile server error: ${res.status}`, detail: text }, { status: 502 })
  }

  const data = (await res.json()) as any
  console.log(`[Tiles Info] Successfully loaded tile info.`);

  // 2. Cache it in the database asynchronously if we found a matching task
  if (matchingTaskId && data) {
    try {
      const boundsStr = JSON.stringify(data)
      if (matchingTaskType === 'odm') {
        await db.update(odmTasks).set({ bounds: boundsStr }).where(eq(odmTasks.id, matchingTaskId))
      } else if (matchingTaskType === 'georef') {
        await db.update(georefTasks).set({ bounds: boundsStr }).where(eq(georefTasks.id, matchingTaskId))
      }
      console.log(`[Tiles Info] Cached bounds in DB for ${matchingTaskType} task: ${matchingTaskId}`)
    } catch (err) {
      console.error('[Tiles Info] Failed to save bounds cache to DB:', err)
    }
  }

  return NextResponse.json(data)
}
