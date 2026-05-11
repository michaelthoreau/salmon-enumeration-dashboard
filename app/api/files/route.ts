import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { deleteObject } from '@/lib/s3'

export async function DELETE(request: NextRequest) {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const key = request.nextUrl.searchParams.get('key')
  if (!key || key.trim() === '') {
    return NextResponse.json({ error: 'Missing key' }, { status: 400 })
  }

  await deleteObject(key)
  return NextResponse.json({ ok: true })
}
