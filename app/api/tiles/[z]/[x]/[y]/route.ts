import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { georefTasks, odmTasks } from '@/lib/schema'
import { eq, and, isNotNull, desc } from 'drizzle-orm'
import { getObjectBuffer } from '@/lib/s3'

function getTileServer(): { url: string; token: string } {
  const url = process.env.MODAL_TILE_SERVER_URL
  const token = process.env.MODAL_TILE_TOKEN
  if (!url || !token) throw new Error('Tile server not configured (MODAL_TILE_SERVER_URL / MODAL_TILE_TOKEN missing)')
  return { url, token }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ z: string; x: string; y: string }> },
): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return new NextResponse('Unauthorized', { status: 401 })

  const { z, x, y } = await params
  const key = request.nextUrl.searchParams.get('key')
  if (!key) return new NextResponse('Missing key', { status: 400 })

  // 1. Try static WebP tile serving from S3
  try {
    const [georefTask] = await db
      .select({ tilesKey: georefTasks.tilesKey, createdAt: georefTasks.createdAt })
      .from(georefTasks)
      .where(
        and(
          eq(georefTasks.outputKey, key),
          isNotNull(georefTasks.tilesKey)
        )
      )
      .orderBy(desc(georefTasks.createdAt))
      .limit(1)

    const [odmTask] = await db
      .select({ tilesKey: odmTasks.tilesKey, createdAt: odmTasks.createdAt })
      .from(odmTasks)
      .where(
        and(
          eq(odmTasks.outputKey, key),
          isNotNull(odmTasks.tilesKey)
        )
      )
      .orderBy(desc(odmTasks.createdAt))
      .limit(1)

    let tilesKey: string | null = null

    if (georefTask && odmTask) {
      tilesKey = georefTask.createdAt.getTime() > odmTask.createdAt.getTime()
        ? georefTask.tilesKey
        : odmTask.tilesKey
    } else {
      tilesKey = georefTask?.tilesKey || odmTask?.tilesKey || null
    }

    if (tilesKey) {
      const staticTileKey = `${tilesKey.replace(/\/$/, '')}/${z}/${x}/${y}.webp`
      try {
        const buffer = await getObjectBuffer(staticTileKey)
        return new NextResponse(new Uint8Array(buffer), {
          status: 200,
          headers: {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
      } catch (err: any) {
        // NoSuchKey or similar S3 not found error => return 204 (empty/transparent tile)
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          return new NextResponse(null, { status: 204 })
        }
        console.error(`[Static Tile Route] Failed to fetch static tile ${staticTileKey}:`, err)
        // Fall through to dynamic tile server as backup
      }
    }
  } catch (err) {
    console.error('[Static Tile Route] Database lookup or static tile check failed:', err)
    // Fall through to dynamic tile server as backup
  }

  // 2. Fall back to dynamic tile server (original behavior)
  const { url, token } = getTileServer()
  const bucket = process.env.S3_BUCKET_NAME || ''
  const tilesize = request.nextUrl.searchParams.get('tilesize') || '256'
  const targetUrl = `${url}/tiles/${z}/${x}/${y}?key=${encodeURIComponent(key)}` + (bucket ? `&bucket=${encodeURIComponent(bucket)}` : '') + `&tilesize=${tilesize}`

  const startTime = Date.now()
  let fetchStartTime = Date.now()
  let res: Response
  try {
    res = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
  } catch (err) {
    console.error(`[Tile Image Route] Error reaching tile server for tile ${z}/${x}/${y} after ${Date.now() - startTime}ms:`, err)
    return new NextResponse('Tile server unreachable', { status: 502 })
  }
  const fetchDuration = Date.now() - fetchStartTime

  if (res.status === 204) {
    console.log(`[Tile Route] Tile ${z}/${x}/${y} (key: ${key}): total ${Date.now() - startTime}ms (fetch ${fetchDuration}ms) -> 204 (No Content)`)
    return new NextResponse(null, { status: 204 })
  }

  if (!res.ok) {
    const text = await res.text()
    console.error(`[Tile Image Route] Tile server returned non-ok status: ${res.status}. Body: ${text} (took total ${Date.now() - startTime}ms, fetch ${fetchDuration}ms)`)
    return new NextResponse('Tile server error', { status: 502 })
  }

  const buffer = await res.arrayBuffer()
  const totalDuration = Date.now() - startTime
  console.log(`[Tile Route] Tile ${z}/${x}/${y} (key: ${key}): total ${totalDuration}ms (fetch ${fetchDuration}ms) -> 200 OK`)

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    },
  })
}
