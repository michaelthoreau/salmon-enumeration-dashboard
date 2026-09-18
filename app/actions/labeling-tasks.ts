'use server'

import { db } from '@/lib/db'
import { labelingTasks, labelingTaskPoints } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { tileRegion } from '@/lib/tiling'

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
): Promise<{ ok?: boolean; count?: number; taskIds?: string[]; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  if (tasks.length === 0) return { ok: true, count: 0, taskIds: [] }

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
  return { ok: true, count: tasks.length, taskIds: rows.map(r => r.id) }
}

/**
 * Replace oversized image tasks with a grid of smaller tiles.
 *
 * Existing points are carried over into whichever tile now contains them, with
 * their coordinates rebased onto that tile's origin, so re-tiling a queue that
 * has already been partly labeled doesn't lose work. Queue membership and
 * completion state are inherited by every tile of a task.
 *
 * Video tasks (which address a frame, not a crop) and tasks already at or below
 * tile size are left untouched.
 */
export interface SplitTaskTile {
  taskId: string
  x1: number
  y1: number
  x2: number
  y2: number
  pointCount: number
}

export interface SplitTaskGroup {
  /** The task that was replaced. */
  sourceTaskId: string
  tiles: SplitTaskTile[]
}

export async function splitLabelingTasksIntoTiles(
  taskIds: string[],
  tileSize: number,
): Promise<{ ok?: boolean; groups?: SplitTaskGroup[]; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  if (taskIds.length === 0) return { ok: true, groups: [] }
  if (!Number.isFinite(tileSize) || tileSize <= 0) return { error: 'Invalid tile size' }

  const tasks = await db.select().from(labelingTasks).where(inArray(labelingTasks.id, taskIds))

  // Only crop-based (image) tasks can be tiled; video tasks carry a zero-size crop.
  const candidates = tasks.filter(t => t.x2 - t.x1 > 0 && t.y2 - t.y1 > 0)
  const plans = candidates
    .map(t => ({ task: t, tiles: tileRegion(t.x1, t.y1, t.x2, t.y2, tileSize) }))
    .filter(p => p.tiles.length > 1)
  if (plans.length === 0) return { ok: true, groups: [] }

  const oldIds = plans.map(p => p.task.id)
  const points = await db
    .select()
    .from(labelingTaskPoints)
    .where(inArray(labelingTaskPoints.taskId, oldIds))
  const pointsByTask = new Map<string, typeof points>()
  for (const p of points) {
    const list = pointsByTask.get(p.taskId)
    if (list) list.push(p)
    else pointsByTask.set(p.taskId, [p])
  }

  const now = new Date()
  const newTasks: (typeof labelingTasks.$inferInsert)[] = []
  const newPoints: (typeof labelingTaskPoints.$inferInsert)[] = []
  const groups: SplitTaskGroup[] = []

  for (const { task, tiles } of plans) {
    const taskPoints = pointsByTask.get(task.id) ?? []
    const tileIds = tiles.map(() => randomUUID())
    const tilePointCounts = tiles.map(() => 0)

    tiles.forEach((tile, i) => {
      newTasks.push({
        id: tileIds[i],
        fileId: task.fileId,
        x1: tile.x1,
        y1: tile.y1,
        x2: tile.x2,
        y2: tile.y2,
        frame: task.frame,
        completedBy: task.completedBy,
        createdBy: task.createdBy,
        createdAt: task.createdAt,
        queueId: task.queueId,
      })
    })

    for (const point of taskPoints) {
      // Point coords are relative to the old tile's origin; convert to absolute
      // source pixels, then find the tile that contains them.
      const absX = task.x1 + point.x
      const absY = task.y1 + point.y
      let idx = tiles.findIndex(t => absX >= t.x1 && absX < t.x2 && absY >= t.y1 && absY < t.y2)
      if (idx === -1) {
        // On the region's right/bottom edge (or nudged outside by a rounded tile
        // boundary) — fall back to the nearest tile so the label isn't dropped.
        idx = nearestTileIndex(tiles, absX, absY)
      }
      newPoints.push({
        id: randomUUID(),
        taskId: tileIds[idx],
        x: absX - tiles[idx].x1,
        y: absY - tiles[idx].y1,
        createdBy: point.createdBy,
        createdAt: point.createdAt ?? now,
      })
      tilePointCounts[idx]++
    }

    groups.push({
      sourceTaskId: task.id,
      tiles: tiles.map((tile, i) => ({
        taskId: tileIds[i],
        x1: tile.x1,
        y1: tile.y1,
        x2: tile.x2,
        y2: tile.y2,
        pointCount: tilePointCounts[i],
      })),
    })
  }

  const CHUNK = 100
  for (let i = 0; i < newTasks.length; i += CHUNK) {
    await db.insert(labelingTasks).values(newTasks.slice(i, i + CHUNK))
  }
  for (let i = 0; i < newPoints.length; i += CHUNK) {
    await db.insert(labelingTaskPoints).values(newPoints.slice(i, i + CHUNK))
  }
  for (let i = 0; i < oldIds.length; i += CHUNK) {
    const chunk = oldIds.slice(i, i + CHUNK)
    await db.delete(labelingTaskPoints).where(inArray(labelingTaskPoints.taskId, chunk))
    await db.delete(labelingTasks).where(inArray(labelingTasks.id, chunk))
  }

  return { ok: true, groups }
}

function nearestTileIndex(
  tiles: { x1: number; y1: number; x2: number; y2: number }[],
  x: number,
  y: number,
): number {
  let best = 0
  let bestDist = Infinity
  tiles.forEach((t, i) => {
    // Distance from the point to the tile rectangle (0 when inside).
    const dx = Math.max(t.x1 - x, 0, x - t.x2)
    const dy = Math.max(t.y1 - y, 0, y - t.y2)
    const dist = dx * dx + dy * dy
    if (dist < bestDist) { bestDist = dist; best = i }
  })
  return best
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
