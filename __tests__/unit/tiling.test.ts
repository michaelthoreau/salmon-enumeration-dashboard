import { describe, it, expect } from 'vitest'
import { tileRegion, countTiles } from '@/lib/tiling'

describe('tileRegion', () => {
  it('returns the whole region when tiling is disabled', () => {
    expect(tileRegion(0, 0, 4000, 3000, null)).toEqual([{ x1: 0, y1: 0, x2: 4000, y2: 3000 }])
  })

  it('returns a single tile when the region is already around tile size', () => {
    expect(tileRegion(0, 0, 1024, 1024, 1024)).toHaveLength(1)
    // 1.2× a tile rounds down to one tile rather than leaving a sliver
    expect(tileRegion(0, 0, 1200, 1200, 1024)).toHaveLength(1)
  })

  it('splits a large image into an even grid', () => {
    const tiles = tileRegion(0, 0, 4096, 3072, 1024)
    expect(tiles).toHaveLength(4 * 3)
    for (const t of tiles) {
      expect(t.x2 - t.x1).toBe(1024)
      expect(t.y2 - t.y1).toBe(1024)
    }
  })

  it('covers the region exactly, with no gaps or overlaps', () => {
    const [w, h] = [5280, 3956]
    const tiles = tileRegion(0, 0, w, h, 1024)
    // Edges of adjacent tiles line up, and the union spans the full region.
    expect(Math.min(...tiles.map(t => t.x1))).toBe(0)
    expect(Math.min(...tiles.map(t => t.y1))).toBe(0)
    expect(Math.max(...tiles.map(t => t.x2))).toBe(w)
    expect(Math.max(...tiles.map(t => t.y2))).toBe(h)
    const area = tiles.reduce((sum, t) => sum + (t.x2 - t.x1) * (t.y2 - t.y1), 0)
    expect(area).toBe(w * h)

    const xEdges = [...new Set(tiles.flatMap(t => [t.x1, t.x2]))].sort((a, b) => a - b)
    const yEdges = [...new Set(tiles.flatMap(t => [t.y1, t.y2]))].sort((a, b) => a - b)
    expect(tiles).toHaveLength((xEdges.length - 1) * (yEdges.length - 1))
  })

  it('tiles are roughly the requested size', () => {
    for (const t of tileRegion(0, 0, 5280, 3956, 1024)) {
      expect(t.x2 - t.x1).toBeGreaterThan(700)
      expect(t.x2 - t.x1).toBeLessThan(1400)
      expect(t.y2 - t.y1).toBeGreaterThan(700)
      expect(t.y2 - t.y1).toBeLessThan(1400)
    }
  })

  it('honours a non-zero origin', () => {
    const tiles = tileRegion(100, 200, 2100, 2200, 1000)
    expect(tiles).toHaveLength(4)
    expect(Math.min(...tiles.map(t => t.x1))).toBe(100)
    expect(Math.min(...tiles.map(t => t.y1))).toBe(200)
    expect(Math.max(...tiles.map(t => t.x2))).toBe(2100)
    expect(Math.max(...tiles.map(t => t.y2))).toBe(2200)
  })

  it('handles degenerate regions without dividing by zero', () => {
    expect(tileRegion(0, 0, 0, 0, 1024)).toEqual([{ x1: 0, y1: 0, x2: 0, y2: 0 }])
  })

  it('every point in the region lands in exactly one tile', () => {
    const tiles = tileRegion(0, 0, 5280, 3956, 1024)
    const samples = [[0, 0], [5279, 3955], [2640, 1978], [1055, 791], [1056, 792]]
    for (const [x, y] of samples) {
      const hits = tiles.filter(t => x >= t.x1 && x < t.x2 && y >= t.y1 && y < t.y2)
      expect(hits).toHaveLength(1)
    }
  })
})

describe('countTiles', () => {
  it('agrees with tileRegion', () => {
    const cases: [number, number, number | null][] = [
      [4096, 3072, 1024],
      [5280, 3956, 1024],
      [1200, 1200, 1024],
      [800, 600, 512],
      [4000, 3000, null],
    ]
    for (const [w, h, size] of cases) {
      expect(countTiles(0, 0, w, h, size)).toBe(tileRegion(0, 0, w, h, size).length)
    }
  })
})
