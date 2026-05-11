import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { createPresignedGetUrl } from '@/lib/s3'

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const key = request.nextUrl.searchParams.get('key')
  if (!key || key.trim() === '') {
    return NextResponse.json({ error: 'Missing key' }, { status: 400 })
  }

  const download = request.nextUrl.searchParams.get('download') === '1'
  const url = await createPresignedGetUrl(key, 3600, download ? 'attachment' : 'inline')
  return NextResponse.json({ url })
}
