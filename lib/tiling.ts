// ─── Labeling tile geometry ───────────────────────────────────────────────────
//
// A labeling task covers a rectangular crop of a source image. Whole-image tasks
// (x1,y1 = 0,0 → full width/height) put hundreds of fish in front of a labeler at
// once and force the annotator to shrink the image to fit the screen, which makes
// each fish only a few pixels across. Splitting the crop into a grid of tiles
// keeps the fish count per task manageable and lets the annotator show each tile
// at native resolution.

export interface Tile {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Default tile edge length in source pixels. Roughly one screenful at 1:1. */
export const DEFAULT_TILE_SIZE = 1024

/** Tile size choices offered in the UI. `null` = don't tile, one task per image. */
export const TILE_SIZE_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Whole image (no tiling)', value: null },
  { label: '512 px', value: 512 },
  { label: '768 px', value: 768 },
  { label: '1024 px (recommended)', value: 1024 },
  { label: '1536 px', value: 1536 },
  { label: '2048 px', value: 2048 },
]

/**
 * Split a crop region into a grid of tiles of roughly `tileSize` pixels a side.
 *
 * The region is divided into a whole number of rows/columns rather than laid out
 * with a fixed stride, so tiles come out evenly sized and there are never sliver
 * tiles along the right/bottom edge. Tile edges land on integer pixels so the
 * crops line up exactly with what the thumbnail endpoint can serve.
 *
 * Returns a single tile covering the whole region when it is already at or below
 * tile size (or when `tileSize` is null), so callers can use it unconditionally.
 */
export function tileRegion(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  tileSize: number | null,
): Tile[] {
  const left = Math.round(x1)
  const top = Math.round(y1)
  const right = Math.round(x2)
  const bottom = Math.round(y2)
  const w = right - left
  const h = bottom - top

  if (!tileSize || tileSize <= 0 || w <= 0 || h <= 0) {
    return [{ x1: left, y1: top, x2: right, y2: bottom }]
  }

  // Round to the nearest whole number of tiles so a 1.2×tileSize region becomes
  // one tile rather than one full tile plus a 20% sliver.
  const cols = Math.max(1, Math.round(w / tileSize))
  const rows = Math.max(1, Math.round(h / tileSize))
  if (cols === 1 && rows === 1) {
    return [{ x1: left, y1: top, x2: right, y2: bottom }]
  }

  const tiles: Tile[] = []
  for (let r = 0; r < rows; r++) {
    // Derive both edges from the same expression so adjacent tiles share an edge
    // exactly and the tiles tile the region with no gaps or overlaps.
    const ty1 = top + Math.round((h * r) / rows)
    const ty2 = top + Math.round((h * (r + 1)) / rows)
    for (let c = 0; c < cols; c++) {
      const tx1 = left + Math.round((w * c) / cols)
      const tx2 = left + Math.round((w * (c + 1)) / cols)
      tiles.push({ x1: tx1, y1: ty1, x2: tx2, y2: ty2 })
    }
  }
  return tiles
}

/** How many tiles `tileRegion` would produce, without building them. */
export function countTiles(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  tileSize: number | null,
): number {
  const w = Math.round(x2) - Math.round(x1)
  const h = Math.round(y2) - Math.round(y1)
  if (!tileSize || tileSize <= 0 || w <= 0 || h <= 0) return 1
  return Math.max(1, Math.round(w / tileSize)) * Math.max(1, Math.round(h / tileSize))
}
