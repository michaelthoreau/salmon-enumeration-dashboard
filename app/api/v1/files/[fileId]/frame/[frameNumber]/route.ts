import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { files } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { createPresignedGetUrl } from '@/lib/s3'

interface RouteParams {
  params: Promise<{ fileId: string; frameNumber: string }>
}

function getTileServer(): { url: string; token: string } {
  const url = process.env.MODAL_TILE_SERVER_URL
  const token = process.env.MODAL_TILE_TOKEN
  if (!url || !token) throw new Error('Tile server not configured (MODAL_TILE_SERVER_URL / MODAL_TILE_TOKEN missing)')
  return { url, token }
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const apiKey = await validateApiKey(request.headers.get('authorization'))
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { fileId, frameNumber } = await params
  const frame = Number(frameNumber)
  if (isNaN(frame) || frame < 0) {
    return NextResponse.json({ error: 'Invalid frame number' }, { status: 400 })
  }

  const [file] = await db.select().from(files).where(eq(files.id, fileId))
  if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 })

  const downloadUrl = await createPresignedGetUrl(file.key, 3600)
  const { url, token } = getTileServer()
  const quality = Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get('quality') ?? '95')))
  
  const targetUrl = `${url}/frame?url=${encodeURIComponent(downloadUrl)}&frame=${frame}&quality=${quality}`

  try {
    const res = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `Modal frame extraction failed: ${text}` }, { status: res.status })
    }

    const arrayBuffer = await res.arrayBuffer()
    return new NextResponse(new Uint8Array(arrayBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=604800, s-maxage=604800', // Cache frames for a week
      },
    })
  } catch (err: any) {
    console.error('[Frame Proxy API] Failed to proxy frame request:', err)
    return NextResponse.json({ error: `Failed to fetch frame from worker: ${err.message}` }, { status: 502 })
  }
}
