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

  // Generate a short-lived presigned URL (10 minutes) for streaming/downloading
  const downloadUrl = await createPresignedGetUrl(file.key, 600)

  return NextResponse.redirect(downloadUrl, 307)
}
