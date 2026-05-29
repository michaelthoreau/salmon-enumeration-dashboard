/**
 * GET /api/files/range?key=<s3-key>
 *
 * Proxies byte-range requests from the browser to S3 via the AWS SDK.
 * This lets client-side libraries (georaster, geotiff.js) load Cloud Optimized
 * GeoTIFFs without needing S3 CORS configuration.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getObjectRange } from '@/lib/s3'

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return new NextResponse('Unauthorized', { status: 401 })

  const key = request.nextUrl.searchParams.get('key')
  if (!key) return new NextResponse('Missing key parameter', { status: 400 })

  const range = request.headers.get('range') ?? undefined

  try {
    const { body, status, contentLength, contentRange, acceptRanges } =
      await getObjectRange(key, range)

    const headers: Record<string, string> = {
      'Content-Type': 'image/tiff',
      'Accept-Ranges': acceptRanges,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    }
    if (contentLength !== undefined) headers['Content-Length'] = contentLength.toString()
    if (contentRange) headers['Content-Range'] = contentRange

    return new NextResponse(Buffer.from(body), { status, headers })
  } catch (err) {
    // NoSuchKey is expected for sidecar files (.ovr, .aux.xml, etc.) — return 404 silently
    const code = err && typeof err === 'object' && 'Code' in err ? (err as { Code: string }).Code : null
    if (code !== 'NoSuchKey') {
      console.error('[range] S3 fetch error:', err)
    }
    return new NextResponse('Not found', { status: 404 })
  }
}
