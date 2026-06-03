import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { getSession } from '@/lib/session'
import { createPresignedGetUrl } from '@/lib/s3'
import { db } from '@/lib/db'
import { files } from '@/lib/schema'
import { eq } from 'drizzle-orm'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'tif'])

function isImage(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const key = request.nextUrl.searchParams.get('key')
  // etag is used purely for cache-busting; sanitise before echoing in a header
  const rawEtag = request.nextUrl.searchParams.get('etag')
  const etag = rawEtag ? rawEtag.replace(/[\r\n\x00]/g, '') : null
  const meta = request.nextUrl.searchParams.get('meta') === '1'

  // Optional resize: ?size=N → fit within an N×N square
  const rawSize = request.nextUrl.searchParams.get('size')
  const size = rawSize ? Math.min(Math.max(parseInt(rawSize, 10), 1), 2000) : null

  // Optional crop params (pixel coordinates in the source image)
  const cx = request.nextUrl.searchParams.get('x')
  const cy = request.nextUrl.searchParams.get('y')
  const cw = request.nextUrl.searchParams.get('w')
  const ch = request.nextUrl.searchParams.get('h')
  let crop: { left: number; top: number; width: number; height: number } | null = null
  if (cx !== null && cy !== null && cw !== null && ch !== null) {
    const left = parseInt(cx, 10)
    const top = parseInt(cy, 10)
    const width = parseInt(cw, 10)
    const height = parseInt(ch, 10)
    if (
      !Number.isFinite(left) || !Number.isFinite(top) ||
      !Number.isFinite(width) || !Number.isFinite(height) ||
      left < 0 || top < 0 || width <= 0 || height <= 0
    ) {
      return new NextResponse('Invalid crop parameters', { status: 400 })
    }
    crop = { left, top, width, height }
  }

  if (!key || key.trim() === '') {
    return new NextResponse('Missing key', { status: 400 })
  }

  if (!isImage(key)) {
    return new NextResponse('Not an image', { status: 415 })
  }

  // Fetch the image server-side via presigned URL and proxy it back
  // This lets us add our own cache headers keyed on the ETag
  const presignedUrl = await createPresignedGetUrl(key, 300) // 5 min for the fetch

  const upstream = await fetch(presignedUrl)
  if (!upstream.ok) {
    return new NextResponse('S3 fetch failed', { status: 502 })
  }

  const buffer = Buffer.from(await upstream.arrayBuffer())

  // ?meta=1 → return image dimensions as JSON and cache in DB
  if (meta) {
    const { width, height } = await sharp(buffer).metadata()
    const w = width ?? 0
    const h = height ?? 0
    // Persist dimensions if not already stored (fire-and-forget)
    if (w > 0 && h > 0) {
      db.update(files)
        .set({ imageWidth: w, imageHeight: h })
        .where(eq(files.key, key))
        .run()
        .catch(() => {}) // non-fatal
    }
    return NextResponse.json({ width: w, height: h }, {
      headers: { 'Cache-Control': etag ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' },
    })
  }

  const contentType = (crop || size) ? 'image/jpeg' : (upstream.headers.get('content-type') ?? 'image/jpeg')
  let bodyBuffer: Buffer

  if (crop) {
    bodyBuffer = await sharp(buffer).extract(crop).resize(size ?? undefined, size ?? undefined, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
  } else if (size) {
    bodyBuffer = await sharp(buffer).resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
  } else {
    bodyBuffer = buffer
  }

  // Cache aggressively: ETag is content-derived, so cache is valid as long as
  // the etag param matches. 1 year browser cache + CDN immutable.
  const cacheControl = etag
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600'

  return new NextResponse(new Uint8Array(bodyBuffer), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      ...(etag ? { ETag: `"${etag}"` } : {}),
    },
  })
}
