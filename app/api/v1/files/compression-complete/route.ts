import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { files } from '@/lib/schema'
import { eq } from 'drizzle-orm'

// POST /api/v1/files/compression-complete
// Body: { originalKey: string, compressedKey?: string, status: 'done' | 'failed' }
// Called by the compression Lambda after FFmpeg finishes (or fails).
export async function POST(request: NextRequest) {
  const apiKey = await validateApiKey(request.headers.get('authorization'))
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { originalKey: string; compressedKey?: string; status: 'done' | 'failed' }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { originalKey, compressedKey, status } = body
  if (!originalKey || !status) {
    return NextResponse.json({ error: 'originalKey and status are required' }, { status: 400 })
  }

  const update =
    status === 'done' && compressedKey
      ? { compressionStatus: 'done' as const, compressedKey }
      : { compressionStatus: 'failed' as const }

  const result = await db.update(files).set(update).where(eq(files.key, originalKey))

  if (!result.rowsAffected) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
