import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { files } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { createPresignedGetUrl } from '@/lib/s3'

interface RouteParams {
  params: Promise<{ fileId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const apiKey = await validateApiKey(request.headers.get('authorization'))
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { fileId } = await params
  const [file] = await db.select().from(files).where(eq(files.id, fileId))
  if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 })

  // Generate a short-lived presigned URL (1 hour)
  const downloadUrl = await createPresignedGetUrl(file.key, 3600)

  return NextResponse.json({
    id: file.id,
    flightId: file.flightId,
    key: file.key,
    etag: file.etag,
    split: file.split,
    uploadedAt: file.uploadedAt,
    uploadedBy: file.uploadedBy,
    imageWidth: file.imageWidth,
    imageHeight: file.imageHeight,
    size: file.size,
    latitude: file.latitude,
    longitude: file.longitude,
    durationSeconds: file.durationSeconds,
    reviewStatus: file.reviewStatus,
    reviewRating: file.reviewRating,
    reviewedBy: file.reviewedBy,
    reviewedAt: file.reviewedAt,
    hidden: file.hidden,
    downloadUrl,
  })
}
