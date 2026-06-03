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
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const key = request.nextUrl.searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 })

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

  const data = (await res.json()) as unknown
  console.log(`[Tiles Info] Successfully loaded tile info.`);
  return NextResponse.json(data)
}
