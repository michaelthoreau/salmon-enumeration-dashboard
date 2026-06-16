import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'

function getTileServer(): { url: string; token: string } {
  const url = process.env.MODAL_TILE_SERVER_URL
  const token = process.env.MODAL_TILE_TOKEN
  if (!url || !token) throw new Error('Tile server not configured (MODAL_TILE_SERVER_URL / MODAL_TILE_TOKEN missing)')
  return { url, token }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return new NextResponse('Unauthorized', { status: 401 })

  const key = request.nextUrl.searchParams.get('key')
  if (!key) return new NextResponse('Missing key', { status: 400 })

  const maxSizeStr = request.nextUrl.searchParams.get('size') || '256'
  const maxInt = parseInt(maxSizeStr, 10)
  const maxSize = Number.isNaN(maxInt) ? 256 : maxInt

  const { url, token } = getTileServer()
  const bucket = process.env.S3_BUCKET_NAME || ''
  
  try {
    const targetUrl = `${url}/preview?key=${encodeURIComponent(key)}&max_size=${maxSize}` + (bucket ? `&bucket=${encodeURIComponent(bucket)}` : '')
    const res = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      const detail = await res.text()
      return new NextResponse(`Tile server error: ${detail}`, { status: res.status })
    }

    const arrayBuffer = await res.arrayBuffer()
    const contentType = res.headers.get('content-type') || 'image/png'

    return new NextResponse(new Uint8Array(arrayBuffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', // Cache for 24h
      },
    })
  } catch (err) {
    console.error('[Preview Proxy] Error:', err)
    return new NextResponse(`Failed to fetch preview: ${String(err)}`, { status: 502 })
  }
}
