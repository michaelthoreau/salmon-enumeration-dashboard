'use server'

import { db } from '@/lib/db'
import { annotations } from '@/lib/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { revalidatePath } from 'next/cache'
import { randomUUID } from 'crypto'

function canWrite(role: string): boolean {
  return role === 'read-write' || role === 'admin'
}

export async function getAnnotations(flightId: string) {
  return db
    .select()
    .from(annotations)
    .where(and(eq(annotations.flightId, flightId), isNull(annotations.deletedAt)))
}

export async function createAnnotation(data: {
  flightId: string
  shape: 'point' | 'polygon' | 'linestring'
  geometry: string
  fishCount?: number
  confidence?: number
}) {
  const session = await getSession()
  if (!session || !canWrite(session.role)) {
    throw new Error('Unauthorized')
  }

  const id = randomUUID()
  const now = new Date()

  const [newAnnotation] = await db
    .insert(annotations)
    .values({
      id,
      flightId: data.flightId,
      shape: data.shape,
      label: 'fish',
      fishCount: data.fishCount ?? 1,
      confidence: data.confidence ?? 1.0,
      geometry: data.geometry,
      createdBy: session.userId,
      createdAt: now,
      modifiedAt: now,
    })
    .returning()

  return newAnnotation
}

export async function updateAnnotation(
  id: string,
  data: {
    fishCount?: number
    confidence?: number
    geometry?: string
  }
) {
  const session = await getSession()
  if (!session || !canWrite(session.role)) {
    throw new Error('Unauthorized')
  }

  const now = new Date()
  const updateData: any = {
    modifiedAt: now,
  }

  if (data.fishCount !== undefined) updateData.fishCount = data.fishCount
  if (data.confidence !== undefined) updateData.confidence = data.confidence
  if (data.geometry !== undefined) updateData.geometry = data.geometry

  const [updated] = await db
    .update(annotations)
    .set(updateData)
    .where(eq(annotations.id, id))
    .returning()

  return updated
}

export async function deleteAnnotation(id: string) {
  const session = await getSession()
  if (!session || !canWrite(session.role)) {
    throw new Error('Unauthorized')
  }

  const [deleted] = await db
    .update(annotations)
    .set({ deletedAt: new Date() })
    .where(eq(annotations.id, id))
    .returning()

  return deleted
}
