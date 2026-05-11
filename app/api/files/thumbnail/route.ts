import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { createPresignedGetUrl } from '@/lib/s3'

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
  const etag = request.nextUrl.searchParams.get('etag') // used purely for cache-busting

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

  const contentType = upstream.headers.get('content-type') ?? 'image/jpeg'
  const body = await upstream.arrayBuffer()

  // Cache aggressively: ETag is content-derived, so cache is valid as long as
  // the etag param matches. 1 year browser cache + CDN immutable.
  const cacheControl = etag
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600'

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      ...(etag ? { ETag: `"${etag}"` } : {}),
    },
  })
}
