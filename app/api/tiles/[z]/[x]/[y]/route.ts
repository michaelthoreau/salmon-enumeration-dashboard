import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'

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

  const { url, token } = getTileServer()
  const bucket = process.env.S3_BUCKET_NAME || ''
  const targetUrl = `${url}/tiles/${z}/${x}/${y}?key=${encodeURIComponent(key)}` + (bucket ? `&bucket=${encodeURIComponent(bucket)}` : '')

  let res: Response
  try {
    res = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (err) {
    console.error(`[Tile Image Route] Error reaching tile server for tile ${z}/${x}/${y}:`, err)
    return new NextResponse('Tile server unreachable', { status: 502 })
  }

  if (res.status === 204) {
    return new NextResponse(null, { status: 204 })
  }

  if (!res.ok) {
    const text = await res.text()
    console.error(`[Tile Image Route] Tile server returned non-ok status: ${res.status}. Body: ${text}`)
    return new NextResponse('Tile server error', { status: 502 })
  }

  const buffer = await res.arrayBuffer()
  return new NextResponse(buffer, {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
  })
}
