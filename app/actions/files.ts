'use server'

import { db } from '@/lib/db'
import { files } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { headObject } from '@/lib/s3'
import { randomUUID } from 'crypto'
import type { Split } from '@/lib/schema'

const VALID_SPLITS = new Set<string>(['train', 'val', 'test'])

export async function assignFileSplit(
  key: string,
  split: Split | null,
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  if (split !== null && !VALID_SPLITS.has(split)) {
    return { error: 'Invalid split value' }
  }

  const [existing] = await db.select({ id: files.id }).from(files).where(eq(files.key, key))

  if (existing) {
    await db.update(files).set({ split }).where(eq(files.key, key))
  } else if (split !== null) {
    // File was uploaded before the register step existed — auto-register it now.
    // Key structure: {projectId}/{flightPlanId}/{flightId}/filename
    const segments = key.split('/')
    const flightId = segments[2]
    if (!flightId) return { error: 'Could not derive flightId from key' }
    const { etag } = await headObject(key)
    await db.insert(files).values({
      id: randomUUID(),
      flightId,
      key,
      etag,
      split,
      uploadedAt: new Date(),
      uploadedBy: session.userId,
    })
  }

  return { ok: true }
}
