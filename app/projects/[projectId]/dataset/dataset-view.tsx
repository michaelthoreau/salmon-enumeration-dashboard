'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

import type { Split } from '@/lib/schema'
import { assignFileSplit } from '@/app/actions/files'
import { createLabelingTasks, type LabelingTaskInput } from '@/app/actions/labeling-tasks'

type SplitChoice = Split | 'none'

const SPLIT_STYLES: Record<Split, string> = {
  train: 'bg-blue-100 text-blue-700',
  val:   'bg-amber-100 text-amber-700',
  test:  'bg-green-100 text-green-700',
}

function splitSelectClass(split: Split | null): string {
  if (split === 'train') return 'bg-blue-50 border-blue-300 text-blue-700'
  if (split === 'val')   return 'bg-amber-50 border-amber-300 text-amber-700'
  if (split === 'test')  return 'bg-green-50 border-green-300 text-green-700'
  return 'bg-white border-gray-200 text-gray-400'
}

const TABS = ['all', 'train', 'val', 'test', 'unassigned'] as const
type Tab = (typeof TABS)[number]

function SplitBadge({ split }: { split: Split | null }) {
  if (!split) return <span className="text-xs text-gray-300 select-none">—</span>
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', SPLIT_STYLES[split])}>
      {split}
    </span>
  )
}

// ── Labeling task helpers ──────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif'])
function isImageKey(key: string) {
  return IMAGE_EXTS.has(key.split('.').pop()?.toLowerCase() ?? '')
}

const TILE_SIZE = 640
function computeTiles(width: number, height: number) {
  const tiles: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  for (let r = 0; r < Math.ceil(height / TILE_SIZE); r++) {
    for (let c = 0; c < Math.ceil(width / TILE_SIZE); c++) {
      tiles.push({
        x1: c * TILE_SIZE,
        y1: r * TILE_SIZE,
        x2: (c + 1) * TILE_SIZE,
        y2: (r + 1) * TILE_SIZE,
      })
    }
  }
  return tiles
}

/** Return a random sample of `n` items (without replacement). */
function sampleN<T>(arr: T[], n: number): T[] {
  if (n >= arr.length) return arr
  const copy = arr.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

const MAX_OPTIONS = [
  { label: 'All tiles', value: null },
  { label: '1', value: 1 },
  { label: '5', value: 5 },
  { label: '10', value: 10 },
  { label: '20', value: 20 },
  { label: '50', value: 50 },
] as const

function getImageDimensions(key: string): Promise<{ width: number; height: number }> {
  const params = new URLSearchParams({ key, meta: '1' })
  return fetch(`/api/files/thumbnail?${params}`)
    .then(r => { if (!r.ok) throw new Error('meta failed'); return r.json() as Promise<{ width: number; height: number }> })
}

type FileTileInfo = {
  key: string
  fileId: string
  filename: string
  width: number
  height: number
  tiles: Array<{ x1: number; y1: number; x2: number; y2: number }>
}

type TaskDialogState =
  | { step: 'loading' }
  | { step: 'ready'; fileTiles: FileTileInfo[] }
  | { step: 'creating' }
  | { step: 'done'; count: number }
  | { step: 'error'; message: string }

export interface DatasetEntry {
  fileId: string
  key: string
  etag: string
  split: Split | null
  flightId: string
  flightTimestampIso: string
  flightPlanName: string
  uploadedAtIso: string
}

interface Props {
  entries: DatasetEntry[]
  taskCountByFileId: Map<string, number>
  canWrite: boolean
  timezone: string
}

export default function DatasetView({ entries: initialEntries, taskCountByFileId, canWrite, timezone }: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<Tab>('all')
  const [splits, setSplits] = useState<Map<string, Split | null>>(
    () => new Map(initialEntries.map(e => [e.key, e.split]))
  )
  const [splitDialog, setSplitDialog] = useState<{ keys: string[] } | null>(null)
  const [pendingSplit, setPendingSplit] = useState<SplitChoice | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [taskDialog, setTaskDialog] = useState<TaskDialogState | null>(null)
  const [maxPerImage, setMaxPerImage] = useState<number | null>(null)

  useEffect(() => {
    setSplits(new Map(initialEntries.map(e => [e.key, e.split])))
  }, [initialEntries])

  const fmt = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  })

  const openSplitDialog = (keys: string[]) => {
    setSplitDialog({ keys })
    setPendingSplit(null)
  }

  const handleSplitChange = useCallback(async (key: string, choice: SplitChoice) => {
    const cur = splits.get(key) ?? null
    const target = choice === 'none' ? null : choice as Split
    if (cur === target) return
    if (cur !== null && target !== null) {
      // Reassignment: open dialog with the choice pre-filled
      setSplitDialog({ keys: [key] })
      setPendingSplit(choice)
      return
    }
    // Direct assign or clear: apply immediately
    setSplits(prev => { const n = new Map(prev); n.set(key, target); return n })
    await assignFileSplit(key, target)
    router.refresh()
  }, [splits, router])

  const confirmSplitAssign = useCallback(async () => {
    if (!splitDialog || pendingSplit === null) return
    const target = pendingSplit === 'none' ? null : pendingSplit
    const keys = splitDialog.keys
    setSplitDialog(null)
    setPendingSplit(null)
    setSplits(prev => {
      const next = new Map(prev)
      for (const k of keys) next.set(k, target)
      return next
    })
    await Promise.all(keys.map(k => assignFileSplit(k, target)))
    router.refresh()
  }, [splitDialog, pendingSplit, router])

  // ── Labeling task creation ────────────────────────────────────────────────

  const selectedImageEntries = initialEntries.filter(
    e => selected.has(e.key) && isImageKey(e.key)
  )

  const openTaskDialog = useCallback(async () => {
    const imageEntries = initialEntries.filter(e => selected.has(e.key) && isImageKey(e.key))
    if (imageEntries.length === 0) return
    setTaskDialog({ step: 'loading' })
    try {
      const fileTiles: FileTileInfo[] = await Promise.all(
        imageEntries.map(async entry => {
          const filename = entry.key.split('/').pop() ?? entry.key
          try {
            const { width, height } = await getImageDimensions(entry.key)
            return { key: entry.key, fileId: entry.fileId, filename, width, height, tiles: computeTiles(width, height) }
          } catch {
            return { key: entry.key, fileId: entry.fileId, filename, width: 0, height: 0, tiles: [] }
          }
        })
      )
      setTaskDialog({ step: 'ready', fileTiles })
    } catch (e) {
      setTaskDialog({ step: 'error', message: String(e) })
    }
  }, [selected, initialEntries])

  const confirmCreateTasks = useCallback(async () => {
    if (!taskDialog || taskDialog.step !== 'ready') return
    const { fileTiles } = taskDialog
    setTaskDialog({ step: 'creating' })
    const allTasks: LabelingTaskInput[] = fileTiles.flatMap(f => {
      const picked = maxPerImage !== null ? sampleN(f.tiles, maxPerImage) : f.tiles
      return picked.map(t => ({ fileId: f.fileId, ...t, frame: 0 }))
    })
    const result = await createLabelingTasks(allTasks)
    if (result.ok) {
      setTaskDialog({ step: 'done', count: result.count ?? 0 })
      setSelected(new Set())
      router.refresh()
    } else {
      setTaskDialog({ step: 'error', message: result.error ?? 'Unknown error' })
    }
  }, [taskDialog, router])

  // Filter entries by active tab (use live splits map, not initial data)
  const filtered = initialEntries.filter(e => {
    const s = splits.get(e.key) ?? null
    if (activeTab === 'all') return true
    if (activeTab === 'unassigned') return s === null
    return s === activeTab
  })

  // Counts for tab badges
  const counts: Record<Tab, number> = {
    all: initialEntries.length,
    train: 0, val: 0, test: 0, unassigned: 0,
  }
  for (const e of initialEntries) {
    const s = splits.get(e.key) ?? null
    if (s) counts[s]++
    else counts.unassigned++
  }

  const tabLabel: Record<Tab, string> = {
    all: 'All',
    train: 'Train',
    val: 'Val',
    test: 'Test',
    unassigned: 'Unassigned',
  }

  const splitDialogHasConflict = !!splitDialog && pendingSplit !== null &&
    splitDialog.keys.some(k => {
      const cur = splits.get(k) ?? null
      const target = pendingSplit === 'none' ? null : pendingSplit
      return cur !== null && cur !== target
    })

  return (
    <>
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
              activeTab === tab
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800',
            )}
          >
            {tabLabel[tab]}
            <span className={cn(
              'ml-1.5 rounded-full px-1.5 py-0.5 text-xs',
              activeTab === tab ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500',
            )}>
              {counts[tab]}
            </span>
          </button>
        ))}
      </div>

      {/* Selection toolbar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm">
          <span className="text-blue-700 font-medium">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            {canWrite && selectedImageEntries.length > 0 && (
              <button
                onClick={openTaskDialog}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'bg-white')}
              >
                Create labeling tasks ({selectedImageEntries.length} image{selectedImageEntries.length !== 1 ? 's' : ''})
              </button>
            )}
            <button
              onClick={() => setSelected(new Set())}
              className="text-blue-500 hover:text-blue-700 text-xs"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-500 p-6">No files in this split.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={filtered.length > 0 && filtered.every(e => selected.has(e.key))}
                    onChange={e => {
                      if (e.target.checked) setSelected(prev => new Set([...prev, ...filtered.map(f => f.key)]))
                      else setSelected(prev => { const n = new Set(prev); filtered.forEach(f => n.delete(f.key)); return n })
                    }}
                    aria-label="Select all"
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Filename</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Split</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Tasks</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Flight plan</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Flight</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Uploaded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(entry => {
                const filename = entry.key.split('/').pop() ?? entry.key
                const split = splits.get(entry.key) ?? null
                return (
                  <tr key={entry.key} className={cn('transition-colors', selected.has(entry.key) ? 'bg-blue-50' : 'hover:bg-gray-50')}>
                    <td className="px-4 py-3" onClick={() => setSelected(prev => { const n = new Set(prev); n.has(entry.key) ? n.delete(entry.key) : n.add(entry.key); return n })}>
                      <input type="checkbox" className="rounded pointer-events-none" checked={selected.has(entry.key)} onChange={() => {}} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-xs truncate" title={filename}>
                      {filename}
                    </td>
                    <td className="px-4 py-3">
                      {canWrite ? (
                        <select
                          value={split ?? 'none'}
                          onChange={e => handleSplitChange(entry.key, e.target.value as SplitChoice)}
                          className={cn(
                            'text-xs rounded border px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer',
                            splitSelectClass(split),
                          )}
                        >
                          <option value="none">—</option>
                          <option value="train">train</option>
                          <option value="val">val</option>
                          <option value="test">test</option>
                        </select>
                      ) : (
                        <SplitBadge split={split} />
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(() => {
                        const n = taskCountByFileId.get(entry.fileId) ?? 0
                        return n > 0
                          ? <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{n}</span>
                          : <span className="text-xs text-gray-300">—</span>
                      })()}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{entry.flightPlanName}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {fmt.format(new Date(entry.flightTimestampIso))}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {new Date(entry.uploadedAtIso).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Labeling task creation dialog */}
      <Dialog
        open={!!taskDialog}
        onOpenChange={o => {
          if (!o && taskDialog?.step !== 'loading' && taskDialog?.step !== 'creating') setTaskDialog(null)
        }}
      >
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Create labeling tasks</DialogTitle>
          </DialogHeader>

          {taskDialog?.step === 'loading' && (
            <p className="text-sm text-gray-500 py-4 text-center">Loading image dimensions…</p>
          )}

          {taskDialog?.step === 'ready' && (() => {
            const totalTiles = taskDialog.fileTiles.reduce((s, f) => s + f.tiles.length, 0)
            const effectivePerFile = taskDialog.fileTiles.map(f => ({
              ...f,
              effective: maxPerImage !== null ? Math.min(f.tiles.length, maxPerImage) : f.tiles.length,
            }))
            const effectiveTotal = effectivePerFile.reduce((s, f) => s + f.effective, 0)
            return (
              <>
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm text-gray-600">
                    Each image is split into <strong>{TILE_SIZE}×{TILE_SIZE}px</strong> tiles.
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <label className="text-xs text-gray-500 whitespace-nowrap">Max per image</label>
                    <select
                      value={maxPerImage ?? ''}
                      onChange={e => setMaxPerImage(e.target.value === '' ? null : Number(e.target.value))}
                      className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    >
                      {MAX_OPTIONS.map(o => (
                        <option key={String(o.value)} value={o.value ?? ''}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <table className="w-full text-xs mt-2 border border-gray-100 rounded-lg overflow-hidden">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">File</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Dimensions</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Total tiles</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Creating</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {effectivePerFile.map(f => (
                      <tr key={f.key}>
                        <td className="px-3 py-2 font-mono text-gray-700 max-w-[140px] truncate" title={f.filename}>{f.filename}</td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {f.width > 0 ? `${f.width}×${f.height}` : <span className="text-red-400">failed</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-400">{f.tiles.length}</td>
                        <td className="px-3 py-2 text-right font-medium text-gray-700">
                          {f.effective}
                          {f.effective < f.tiles.length && (
                            <span className="ml-1 text-amber-500">rand</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t border-gray-200">
                    <tr>
                      <td className="px-3 py-2 font-medium text-gray-700" colSpan={2}>Total</td>
                      <td className="px-3 py-2 text-right text-gray-400">{totalTiles}</td>
                      <td className="px-3 py-2 text-right font-semibold text-gray-900">{effectiveTotal}</td>
                    </tr>
                  </tfoot>
                </table>
              </>
            )
          })()}

          {taskDialog?.step === 'creating' && (
            <p className="text-sm text-gray-500 py-4 text-center">Creating tasks…</p>
          )}

          {taskDialog?.step === 'done' && (
            <p className="text-sm text-green-700 py-4 text-center">
              ✓ Created <strong>{taskDialog.count}</strong> labeling tasks.
            </p>
          )}

          {taskDialog?.step === 'error' && (
            <p className="text-sm text-red-600 py-4">{taskDialog.message}</p>
          )}

          <DialogFooter>
            {(taskDialog?.step === 'done' || taskDialog?.step === 'error') && (
              <Button variant="outline" onClick={() => setTaskDialog(null)}>Close</Button>
            )}
            {taskDialog?.step === 'ready' && (() => {
              const effectiveTotal = taskDialog.fileTiles.reduce(
                (s, f) => s + (maxPerImage !== null ? Math.min(f.tiles.length, maxPerImage) : f.tiles.length), 0
              )
              return (
                <>
                  <Button variant="outline" onClick={() => setTaskDialog(null)}>Cancel</Button>
                  <Button
                    onClick={confirmCreateTasks}
                    disabled={effectiveTotal === 0}
                  >
                    Create {effectiveTotal} task{effectiveTotal !== 1 ? 's' : ''}
                  </Button>
                </>
              )
            })()}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Split assignment dialog */}
      <Dialog open={!!splitDialog} onOpenChange={o => { if (!o) { setSplitDialog(null); setPendingSplit(null) } }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Assign split</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            {splitDialog?.keys.length === 1
              ? <>Assign a dataset split to <strong>{splitDialog.keys[0].split('/').pop()}</strong>.</>
              : <>Assign a dataset split to <strong>{splitDialog?.keys.length} files</strong>.</>}
          </p>
          <div className="flex flex-wrap gap-2 mt-1">
            {(['train', 'val', 'test'] as Split[]).map(s => (
              <button
                key={s}
                onClick={() => setPendingSplit(s)}
                className={cn(
                  'px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors',
                  pendingSplit === s
                    ? cn(SPLIT_STYLES[s], 'border-transparent ring-2 ring-offset-1',
                        s === 'train' ? 'ring-blue-400' : s === 'val' ? 'ring-amber-400' : 'ring-green-400')
                    : 'border-gray-200 text-gray-600 hover:border-gray-400',
                )}
              >
                {s}
              </button>
            ))}
            <button
              onClick={() => setPendingSplit('none')}
              className={cn(
                'px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors',
                pendingSplit === 'none'
                  ? 'bg-gray-100 border-gray-400 text-gray-700 ring-2 ring-offset-1 ring-gray-400'
                  : 'border-gray-200 text-gray-400 hover:border-gray-400',
              )}
            >
              Clear
            </button>
          </div>
          {splitDialogHasConflict && (
            <p className="text-sm text-amber-600 flex items-start gap-1.5 mt-1">
              <span className="shrink-0">⚠️</span>
              <span>
                {splitDialog!.keys.filter(k => {
                  const cur = splits.get(k) ?? null
                  const target = pendingSplit === 'none' ? null : pendingSplit
                  return cur !== null && cur !== target
                }).length} file(s) already have a split assigned and will be reassigned.
              </span>
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSplitDialog(null); setPendingSplit(null) }}>
              Cancel
            </Button>
            <Button onClick={confirmSplitAssign} disabled={pendingSplit === null}>
              {splitDialogHasConflict ? 'Confirm reassignment' : 'Assign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
