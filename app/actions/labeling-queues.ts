'use server'

import { db } from '@/lib/db'
import { labelingQueues, labelingTasks, labelingTaskPoints } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { randomUUID } from 'crypto'
import { eq, inArray, isNull } from 'drizzle-orm'

export async function createLabelingQueue(
  projectId: string,
  name: string,
  assignedTo: string | null,
  taskIds: string[],
): Promise<{ ok?: boolean; id?: string; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  const id = randomUUID()
  // Run queue insert and task assignment in a single batch when possible
  await db.insert(labelingQueues).values({
    id,
    name,
    projectId,
    assignedTo: assignedTo ?? null,
    createdBy: session.userId,
    createdAt: new Date(),
  })
  if (taskIds.length > 0) {
    // Single bulk UPDATE instead of N round-trips
    await db.update(labelingTasks)
      .set({ queueId: id })
      .where(inArray(labelingTasks.id, taskIds))
  }
  return { ok: true, id }
}

export async function assignTasksToQueue(
  queueId: string,
  taskIds: string[],
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  if (taskIds.length === 0) return { ok: true }
  await db.update(labelingTasks)
    .set({ queueId })
    .where(inArray(labelingTasks.id, taskIds))
  return { ok: true }
}

export async function removeTasksFromQueue(
  taskIds: string[],
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  if (taskIds.length === 0) return { ok: true }
  await db.update(labelingTasks)
    .set({ queueId: null })
    .where(inArray(labelingTasks.id, taskIds))
  return { ok: true }
}

export async function updateQueueAssignment(
  queueId: string,
  assignedTo: string | null,
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  await db.update(labelingQueues)
    .set({ assignedTo })
    .where(eq(labelingQueues.id, queueId))
  return { ok: true }
}

export async function renameLabelingQueue(
  queueId: string,
  name: string,
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  await db.update(labelingQueues)
    .set({ name })
    .where(eq(labelingQueues.id, queueId))
  return { ok: true }
}

export async function deleteLabelingQueue(
  queueId: string,
  deleteTasks = false,
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  if (deleteTasks) {
    // Hard-delete all tasks belonging to this queue
    const taskRows = await db
      .select({ id: labelingTasks.id })
      .from(labelingTasks)
      .where(eq(labelingTasks.queueId, queueId))
    const ids = taskRows.map(r => r.id)
    if (ids.length > 0) {
      await db.delete(labelingTaskPoints).where(inArray(labelingTaskPoints.taskId, ids))
      await db.delete(labelingTasks).where(inArray(labelingTasks.id, ids))
    }
  } else {
    // Just unlink tasks so they become unassigned
    await db.update(labelingTasks)
      .set({ queueId: null })
      .where(eq(labelingTasks.queueId, queueId))
  }
  await db.delete(labelingQueues).where(eq(labelingQueues.id, queueId))
  return { ok: true }
}
