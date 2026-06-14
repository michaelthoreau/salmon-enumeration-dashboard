'use server'

import { db } from '@/lib/db'
import { labelingTasks, labelingTaskPoints } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'

export interface LabelingTaskInput {
  fileId: string
  x1: number
  y1: number
  x2: number
  y2: number
  frame: number
}

export async function createLabelingTasks(
  tasks: LabelingTaskInput[],
): Promise<{ ok?: boolean; count?: number; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  if (tasks.length === 0) return { ok: true, count: 0 }

  const now = new Date()
  const rows = tasks.map(t => ({
    id: randomUUID(),
    fileId: t.fileId,
    x1: t.x1,
    y1: t.y1,
    x2: t.x2,
    y2: t.y2,
    frame: t.frame,
    createdBy: session.userId,
    createdAt: now,
  }))

  // Chunk into 100-row batches to stay under libsql's variable limit
  const CHUNK = 100
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(labelingTasks).values(rows.slice(i, i + CHUNK))
  }
  return { ok: true, count: tasks.length }
}

// ─── Point CRUD ───────────────────────────────────────────────────────────────

export interface PointInput {
  x: number
  y: number
}

/**
 * Replace all points for a task with the provided list.
 * Called on every save from the annotator.
 */
export async function saveTaskPoints(
  taskId: string,
  points: PointInput[],
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session) return { error: 'Unauthorized' }

  const [task] = await db.select({ id: labelingTasks.id }).from(labelingTasks).where(eq(labelingTasks.id, taskId))
  if (!task) return { error: 'Task not found' }

  const now = new Date()
  await db.delete(labelingTaskPoints).where(eq(labelingTaskPoints.taskId, taskId))
  if (points.length > 0) {
    await db.insert(labelingTaskPoints).values(
      points.map(p => ({
        id: randomUUID(),
        taskId,
        x: p.x,
        y: p.y,
        createdBy: session.userId,
        createdAt: now,
      })),
    )
  }
  return { ok: true }
}

// ─── Complete / incomplete ────────────────────────────────────────────────────

export async function setTaskComplete(
  taskId: string,
  complete: boolean,
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session) return { error: 'Unauthorized' }

  await db
    .update(labelingTasks)
    .set({ completedBy: complete ? session.userId : null })
    .where(eq(labelingTasks.id, taskId))
  return { ok: true }
}

// ─── Delete tasks ─────────────────────────────────────────────────────────────

export async function deleteLabelingTasks(
  taskIds: string[],
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  if (taskIds.length === 0) return { ok: true }
  await db.delete(labelingTaskPoints).where(inArray(labelingTaskPoints.taskId, taskIds))
  await db.delete(labelingTasks).where(inArray(labelingTasks.id, taskIds))
  return { ok: true }
}
