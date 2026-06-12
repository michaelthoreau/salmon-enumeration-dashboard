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
  const key1 = request.nextUrl.searchParams.get('key1')
  const key2 = request.nextUrl.searchParams.get('key2')
  
  if (!key1 || !key2) {
    return new NextResponse('Missing key1 or key2 parameters', { status: 400 })
  }

  const { url, token } = getTileServer()
  const bucket = process.env.S3_BUCKET_NAME || ''
  
  const colormap = request.nextUrl.searchParams.get('colormap') || 'red-green'
  const threshold = request.nextUrl.searchParams.get('threshold') || '15'
  const maxDiff = request.nextUrl.searchParams.get('maxDiff') || '120'

  const targetUrl = 
    `${url}/diff-tiles/${z}/${x}/${y}` +
    `?key1=${encodeURIComponent(key1)}` +
    `&key2=${encodeURIComponent(key2)}` +
    `&colormap=${encodeURIComponent(colormap)}` +
    `&threshold=${encodeURIComponent(threshold)}` +
    `&max_diff=${encodeURIComponent(maxDiff)}` +
    (bucket ? `&bucket=${encodeURIComponent(bucket)}` : '')

  let res: Response
  try {
    res = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (err) {
    console.error(`[Diff Tile Image Route] Error reaching tile server for tile ${z}/${x}/${y}:`, err)
    return new NextResponse('Tile server unreachable', { status: 502 })
  }

  if (res.status === 204) {
    return new NextResponse(null, { status: 204 })
  }

  if (!res.ok) {
    const text = await res.text()
    console.error(`[Diff Tile Image Route] Tile server returned non-ok status: ${res.status}. Body: ${text}`)
    return new NextResponse('Tile server error', { status: 502 })
  }

  const buffer = await res.arrayBuffer()
  return new NextResponse(buffer, {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
  })
}
