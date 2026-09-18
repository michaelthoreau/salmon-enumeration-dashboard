import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Minimal Drizzle stub ──────────────────────────────────────────────────────
// `select()` resolves to the next queued result; inserts and deletes are recorded
// so the test can assert on what the action wrote.
const selectQueue: unknown[][] = []
const inserted: { table: unknown; rows: Record<string, unknown>[] }[] = []
const deletes: unknown[] = []

function selectChain() {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin', 'groupBy']) {
    chain[m] = vi.fn(() => chain)
  }
  const result = () => Promise.resolve(selectQueue.shift() ?? [])
  chain.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => result().then(ok, err)
  chain.catch = (err: (e: unknown) => unknown) => result().catch(err)
  chain.finally = (cb: () => void) => result().finally(cb)
  return chain
}

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => selectChain()),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (rows: Record<string, unknown>[]) => {
        inserted.push({ table, rows })
      }),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => { deletes.push(table) }),
    })),
  },
}))

vi.mock('@/lib/session', () => ({
  getSession: vi.fn().mockResolvedValue({ userId: 'u-admin', role: 'admin' }),
}))

import { splitLabelingTasksIntoTiles } from '@/app/actions/labeling-tasks'
import { labelingTasks, labelingTaskPoints } from '@/lib/schema'

const baseTask = {
  id: 'task-1',
  fileId: 'file-1',
  x1: 0,
  y1: 0,
  x2: 2000,
  y2: 2000,
  frame: 0,
  completedBy: 'u-labeler',
  createdBy: 'u-creator',
  createdAt: new Date('2026-08-01T00:00:00Z'),
  queueId: 'queue-1',
}

function point(id: string, x: number, y: number) {
  return { id, taskId: 'task-1', x, y, createdBy: 'u-labeler', createdAt: new Date('2026-08-02T00:00:00Z') }
}

function newTasks() {
  return inserted.filter(i => i.table === labelingTasks).flatMap(i => i.rows)
}
function newPoints() {
  return inserted.filter(i => i.table === labelingTaskPoints).flatMap(i => i.rows)
}

describe('splitLabelingTasksIntoTiles', () => {
  beforeEach(() => {
    selectQueue.length = 0
    inserted.length = 0
    deletes.length = 0
  })

  it('replaces an oversized task with a grid of tiles', async () => {
    selectQueue.push([baseTask], [])
    const res = await splitLabelingTasksIntoTiles(['task-1'], 1000)

    expect(res.ok).toBe(true)
    expect(res.groups).toHaveLength(1)
    expect(res.groups![0].sourceTaskId).toBe('task-1')
    expect(res.groups![0].tiles).toHaveLength(4)

    const tiles = newTasks()
    expect(tiles).toHaveLength(4)
    // Queue membership, completion and ownership are inherited by every tile.
    for (const t of tiles) {
      expect(t.queueId).toBe('queue-1')
      expect(t.completedBy).toBe('u-labeler')
      expect(t.createdBy).toBe('u-creator')
      expect(t.fileId).toBe('file-1')
      expect(t.x2 as number - (t.x1 as number)).toBe(1000)
    }
    // The old task and its points are removed.
    expect(deletes).toContain(labelingTasks)
    expect(deletes).toContain(labelingTaskPoints)
  })

  it('moves existing annotations into the tile that contains them', async () => {
    selectQueue.push(
      [baseTask],
      [point('p-tl', 10, 20), point('p-br', 1500, 1600), point('p-tr', 1200, 30)],
    )
    await splitLabelingTasksIntoTiles(['task-1'], 1000)

    const tiles = newTasks()
    const byId = new Map(tiles.map(t => [t.id as string, t]))
    const pts = newPoints()
    expect(pts).toHaveLength(3)

    // Re-project each point back to absolute source pixels — it must match where
    // it started, which is the property that makes re-tiling non-destructive.
    const absolute = pts.map(p => {
      const tile = byId.get(p.taskId as string)!
      return { x: (tile.x1 as number) + (p.x as number), y: (tile.y1 as number) + (p.y as number) }
    }).sort((a, b) => a.x - b.x)

    expect(absolute).toEqual([
      { x: 10, y: 20 },
      { x: 1200, y: 30 },
      { x: 1500, y: 1600 },
    ])
    // ...and each landed in a different tile of the 2×2 grid.
    expect(new Set(pts.map(p => p.taskId)).size).toBe(3)
    // Authorship of the original label is preserved.
    for (const p of pts) expect(p.createdBy).toBe('u-labeler')
  })

  it('keeps a point sitting exactly on the region edge', async () => {
    selectQueue.push([baseTask], [point('p-edge', 2000, 2000)])
    await splitLabelingTasksIntoTiles(['task-1'], 1000)

    const tiles = newTasks()
    const byId = new Map(tiles.map(t => [t.id as string, t]))
    const pts = newPoints()
    expect(pts).toHaveLength(1)
    const tile = byId.get(pts[0].taskId as string)!
    expect((tile.x1 as number) + (pts[0].x as number)).toBe(2000)
    expect((tile.y1 as number) + (pts[0].y as number)).toBe(2000)
  })

  it('leaves tasks that are already at or below tile size alone', async () => {
    selectQueue.push([{ ...baseTask, x2: 900, y2: 900 }], [])
    const res = await splitLabelingTasksIntoTiles(['task-1'], 1000)
    expect(res.ok).toBe(true)
    expect(res.groups).toEqual([])
    expect(newTasks()).toHaveLength(0)
    expect(deletes).toHaveLength(0)
  })

  it('ignores video tasks, which address a frame rather than a crop', async () => {
    selectQueue.push([{ ...baseTask, x1: 0, y1: 0, x2: 0, y2: 0, frame: 480 }], [])
    const res = await splitLabelingTasksIntoTiles(['task-1'], 1000)
    expect(res.groups).toEqual([])
    expect(newTasks()).toHaveLength(0)
  })

  it('rejects callers without write access', async () => {
    const { getSession } = await import('@/lib/session')
    vi.mocked(getSession).mockResolvedValueOnce({ userId: 'u', role: 'read-only' } as never)
    const res = await splitLabelingTasksIntoTiles(['task-1'], 1000)
    expect(res.error).toBe('Unauthorized')
    expect(newTasks()).toHaveLength(0)
  })

  it('rejects a nonsensical tile size', async () => {
    const res = await splitLabelingTasksIntoTiles(['task-1'], 0)
    expect(res.error).toBe('Invalid tile size')
  })
})
