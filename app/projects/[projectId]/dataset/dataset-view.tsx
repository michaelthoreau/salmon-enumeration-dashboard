'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from 'lucide-react'

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

function thumbnailUrl(key: string, etag: string, size: number): string {
  return `/api/files/thumbnail?key=${encodeURIComponent(key)}&etag=${encodeURIComponent(etag)}&size=${size}`
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const TABS = ['unassigned', 'train', 'val', 'test'] as const
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
  imageWidth: number | null
  imageHeight: number | null
  size: number | null
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
  const [activeTab, setActiveTab] = useState<Tab>('unassigned')
  const [splits, setSplits] = useState<Map<string, Split | null>>(
    () => new Map(initialEntries.map(e => [e.key, e.split]))
  )
  const [splitDialog, setSplitDialog] = useState<{ keys: string[] } | null>(null)
  const [pendingSplit, setPendingSplit] = useState<SplitChoice | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [taskDialog, setTaskDialog] = useState<TaskDialogState | null>(null)
  const [maxPerImage, setMaxPerImage] = useState<number | null>(null)
  const [collapsedFlights, setCollapsedFlights] = useState<Set<string>>(new Set())
  const [activeImageKey, setActiveImageKey] = useState<string | null>(null)
  const [activeDownloadUrl, setActiveDownloadUrl] = useState('')
  const [lightboxImages, setLightboxImages] = useState<DatasetEntry[]>([])
  const [excludeWithTasks, setExcludeWithTasks] = useState(false)

  // Filter entries by active tab (use live splits map, not initial data)
  const filtered = useMemo(() => {
    return initialEntries.filter(e => {
      const s = splits.get(e.key) ?? null
      if (activeTab === 'unassigned') { if (s !== null) return false }
      else { if (s !== activeTab) return false }
      if (excludeWithTasks && isImageKey(e.key) && (taskCountByFileId.get(e.fileId) ?? 0) > 0) return false
      return true
    })
  }, [initialEntries, splits, activeTab, excludeWithTasks, taskCountByFileId])

  const activeEntry = useMemo(() => initialEntries.find(e => e.key === activeImageKey) ?? null, [initialEntries, activeImageKey])
  const filteredImages = useMemo(() => filtered.filter(e => isImageKey(e.key)), [filtered])

  const lightboxList = useMemo(() => {
    return lightboxImages.length > 0 ? lightboxImages : filteredImages
  }, [lightboxImages, filteredImages])

  const activeIndex = useMemo(() => {
    return lightboxList.findIndex(e => e.key === activeImageKey)
  }, [lightboxList, activeImageKey])

  const handlePrev = useCallback(() => {
    if (activeIndex > 0) {
      setActiveImageKey(lightboxList[activeIndex - 1].key)
    }
  }, [activeIndex, lightboxList])

  const handleNext = useCallback(() => {
    if (activeIndex < lightboxList.length - 1) {
      setActiveImageKey(lightboxList[activeIndex + 1].key)
    }
  }, [activeIndex, lightboxList])

  useEffect(() => {
    if (!activeImageKey) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') handlePrev()
      if (e.key === 'ArrowRight') handleNext()
      if (e.key === 'Escape') {
        setActiveImageKey(null)
        setLightboxImages([])
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeImageKey, handlePrev, handleNext])

  useEffect(() => {
    if (!activeImageKey) return
    let active = true
    fetch(`/api/files/presign?key=${encodeURIComponent(activeImageKey)}&download=1`)
      .then(r => r.ok ? r.json() as Promise<{ url: string }> : null)
      .then(data => {
        if (active && data) setActiveDownloadUrl(data.url)
      })
    return () => { active = false }
  }, [activeImageKey])

  const toggleFlight = useCallback((flightId: string) => {
    setCollapsedFlights(prev => {
      const n = new Set(prev)
      n.has(flightId) ? n.delete(flightId) : n.add(flightId)
      return n
    })
  }, [])

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
            // Use cached dimensions from DB when available
            const { width, height } = (entry.imageWidth && entry.imageHeight)
              ? { width: entry.imageWidth, height: entry.imageHeight }
              : await getImageDimensions(entry.key)
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

  // filtered is defined at the top of the component

  // Counts for tab badges
  const counts: Record<Tab, number> = {
    train: 0, val: 0, test: 0, unassigned: 0,
  }
  for (const e of initialEntries) {
    const s = splits.get(e.key) ?? null
    if (s) counts[s]++
    else counts.unassigned++
  }

  // Group filtered entries by flight
  const flightGroups = useMemo(() => {
    const map = new Map<string, { flightPlanName: string; flightTimestampIso: string; entries: DatasetEntry[] }>()
    for (const entry of filtered) {
      if (!map.has(entry.flightId)) {
        map.set(entry.flightId, { flightPlanName: entry.flightPlanName, flightTimestampIso: entry.flightTimestampIso, entries: [] })
      }
      map.get(entry.flightId)!.entries.push(entry)
    }
    return Array.from(map.entries())
  }, [filtered])

  const tabLabel: Record<Tab, string> = {
    unassigned: 'Unassigned',
    train: 'Train',
    val: 'Val',
    test: 'Test',
  }

  const splitDialogHasConflict = !!splitDialog && pendingSplit !== null &&
    splitDialog.keys.some(k => {
      const cur = splits.get(k) ?? null
      const target = pendingSplit === 'none' ? null : pendingSplit
      return cur !== null && cur !== target
    })

  return (
    <>
      {/* Tabs + inline action bar */}
      <div className="flex items-center justify-between border-b border-gray-200">
        <div className="flex items-center gap-1">
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
          {/* Hide files that already have tasks */}
          <label className="ml-3 flex items-center gap-1.5 cursor-pointer select-none text-xs text-gray-500 hover:text-gray-700 pb-1">
            <input
              type="checkbox"
              className="rounded"
              checked={excludeWithTasks}
              onChange={e => setExcludeWithTasks(e.target.checked)}
            />
            Hide images with tasks
          </label>
        </div>

        {/* Actions — always in this spot, content changes with selection */}
        <div className="flex items-center gap-2 pb-1">
          {selected.size > 0 ? (
            <>
              <span className="text-xs text-gray-500 mr-1">{selected.size} selected</span>
              {canWrite && (
                <>
                  {/* Single split selector replaces 3 separate buttons */}
                  <select
                    value=""
                    onChange={async e => {
                      const target = e.target.value
                      if (!target) return
                      const keys = Array.from(selected)
                      const splitVal = target === 'none' ? null : target as Split
                      setSplits(prev => { const n = new Map(prev); keys.forEach(k => n.set(k, splitVal)); return n })
                      setSelected(new Set())
                      await Promise.all(keys.map(k => assignFileSplit(k, splitVal)))
                      router.refresh()
                    }}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'pr-7 cursor-pointer')}
                  >
                    <option value="">{activeTab === 'unassigned' ? 'Add to split…' : 'Move to…'}</option>
                    {(['train', 'val', 'test'] as Split[]).filter(s => s !== activeTab).map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                    {activeTab !== 'unassigned' && <option value="none">Remove from split</option>}
                  </select>
                  {activeTab !== 'unassigned' && selectedImageEntries.length > 0 && (
                    <button
                      onClick={openTaskDialog}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                    >
                      Create labeling tasks
                    </button>
                  )}
                </>
              )}
              <button
                onClick={() => setSelected(new Set())}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Clear
              </button>
            </>
          ) : (
            <span className="text-xs text-gray-300 select-none">Select files to take action</span>
          )}
        </div>
      </div>

      {/* Flight groups */}
      {flightGroups.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <p className="text-sm text-gray-500">No files in this split.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {flightGroups.map(([flightId, group]) => {
            const isCollapsed = collapsedFlights.has(flightId)
            const groupKeys = group.entries.map(e => e.key)
            const allGroupSelected = groupKeys.every(k => selected.has(k))
            const someGroupSelected = groupKeys.some(k => selected.has(k))
            return (
              <div key={flightId} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {/* Section header */}
                <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={allGroupSelected}
                    ref={el => { if (el) el.indeterminate = !allGroupSelected && someGroupSelected }}
                    onChange={e => {
                      if (e.target.checked) setSelected(prev => new Set([...prev, ...groupKeys]))
                      else setSelected(prev => { const n = new Set(prev); groupKeys.forEach(k => n.delete(k)); return n })
                    }}
                    aria-label={`Select all files in ${group.flightPlanName}`}
                    onClick={ev => ev.stopPropagation()}
                  />
                  <button
                    onClick={() => toggleFlight(flightId)}
                    className="flex-1 flex items-center gap-3 text-left"
                  >
                    <span className="text-sm font-semibold text-gray-800">{group.flightPlanName}</span>
                    <span className="text-gray-300">–</span>
                    <span className="text-sm text-gray-500">{fmt.format(new Date(group.flightTimestampIso))}</span>
                    <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5 ml-1">
                      {group.entries.length} file{group.entries.length !== 1 ? 's' : ''}
                    </span>
                    <svg
                      className={cn('ml-auto h-4 w-4 text-gray-400 transition-transform shrink-0', isCollapsed ? '-rotate-90' : '')}
                      xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
                    >
                      <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>

                {/* Collapsible table */}
                {!isCollapsed && (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="w-10 px-4 py-2" />
                        <th className="text-left px-4 py-2 font-medium text-gray-600">Filename</th>
                        <th className="text-left px-4 py-2 font-medium text-gray-600">Split</th>
                        <th className="text-right px-4 py-2 font-medium text-gray-600">Tasks</th>
                        <th className="text-left px-4 py-2 font-medium text-gray-600">Uploaded</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {group.entries.map(entry => {
                        const filename = entry.key.split('/').pop() ?? entry.key
                        const split = splits.get(entry.key) ?? null
                        return (
                          <tr key={entry.key} className={cn('transition-colors', selected.has(entry.key) ? 'bg-blue-50' : 'hover:bg-gray-50')}>
                            <td className="px-4 py-2.5" onClick={() => setSelected(prev => { const n = new Set(prev); n.has(entry.key) ? n.delete(entry.key) : n.add(entry.key); return n })}>
                              <input type="checkbox" className="rounded pointer-events-none" checked={selected.has(entry.key)} onChange={() => {}} />
                            </td>
                            <td
                              className={cn(
                                'px-4 py-2.5 font-mono text-xs max-w-xs truncate transition-all duration-100',
                                isImageKey(entry.key)
                                  ? 'text-blue-600 hover:text-blue-800 hover:underline cursor-pointer font-medium'
                                  : 'text-gray-700'
                              )}
                              title={filename}
                              onClick={() => {
                                if (isImageKey(entry.key)) {
                                  setActiveImageKey(entry.key)
                                  setLightboxImages(filteredImages)
                                }
                              }}
                            >
                              {filename}
                            </td>
                            <td className="px-4 py-2.5">
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
                            <td className="px-4 py-2.5 text-right">
                              {(() => {
                                const n = taskCountByFileId.get(entry.fileId) ?? 0
                                return n > 0
                                  ? <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{n}</span>
                                  : <span className="text-xs text-gray-300">—</span>
                              })()}
                            </td>
                            <td className="px-4 py-2.5 text-gray-400 text-xs">
                              {new Date(entry.uploadedAtIso).toLocaleDateString()}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}

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
            const effectiveTotal = taskDialog.fileTiles.reduce(
              (s, f) => s + (maxPerImage !== null ? Math.min(f.tiles.length, maxPerImage) : f.tiles.length), 0
            )
            const imageCount = taskDialog.fileTiles.length
            const isCapped = maxPerImage !== null && effectiveTotal < totalTiles
            return (
              <>
                {/* Summary stats */}
                <div className="grid grid-cols-3 gap-3 my-1">
                  <div className="flex flex-col items-center justify-center rounded-xl bg-gray-50 border border-gray-100 px-3 py-4">
                    <span className="text-2xl font-black text-gray-900">{imageCount}</span>
                    <span className="text-xs text-gray-500 mt-0.5">image{imageCount !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="flex flex-col items-center justify-center rounded-xl bg-gray-50 border border-gray-100 px-3 py-4">
                    <span className="text-2xl font-black text-gray-900">{totalTiles}</span>
                    <span className="text-xs text-gray-500 mt-0.5">available tiles</span>
                  </div>
                  <div className={`flex flex-col items-center justify-center rounded-xl border px-3 py-4 ${isCapped ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'}`}>
                    <span className={`text-2xl font-black ${isCapped ? 'text-amber-700' : 'text-blue-700'}`}>{effectiveTotal}</span>
                    <span className={`text-xs mt-0.5 ${isCapped ? 'text-amber-600' : 'text-blue-600'}`}>tasks to create{isCapped ? ' (capped)' : ''}</span>
                  </div>
                </div>

                {/* Settings */}
                <div className="flex items-center justify-between gap-3 rounded-xl bg-gray-50 border border-gray-100 px-4 py-3">
                  <div>
                    <p className="text-xs font-medium text-gray-700">Tile size</p>
                    <p className="text-xs text-gray-500">{TILE_SIZE}×{TILE_SIZE} px per task</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <label className="text-xs text-gray-500 whitespace-nowrap">Max per image</label>
                    <select
                      value={maxPerImage ?? ''}
                      onChange={e => setMaxPerImage(e.target.value === '' ? null : Number(e.target.value))}
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                    >
                      {MAX_OPTIONS.map(o => (
                        <option key={String(o.value)} value={o.value ?? ''}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
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

      {/* Lightbox Dialog */}
      <Dialog open={!!activeImageKey} onOpenChange={o => { if (!o) { setActiveImageKey(null); setActiveDownloadUrl(''); setLightboxImages([]) } }}>
        <DialogContent className="sm:max-w-6xl h-[85vh] p-0 overflow-hidden flex flex-col bg-gray-950 text-white border border-gray-800 rounded-2xl">
          {activeEntry && (
            <>
              {/* Header */}
              <div className="px-6 py-3 border-b border-gray-800 flex items-center justify-between shrink-0 bg-gray-950 z-10">
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">Image Preview</span>
                  <span className="text-sm font-mono text-gray-200 truncate max-w-lg mt-0.5" title={activeEntry.key.split('/').pop()}>
                    {activeEntry.key.split('/').pop()}
                  </span>
                </div>
                <div className="flex items-center gap-4 mr-8">
                  <span className="text-xs text-gray-400">
                    {activeIndex !== -1 ? `${activeIndex + 1} of ${lightboxList.length}` : ''}
                  </span>
                </div>
              </div>

              {/* Viewport / Stage */}
              <div className="flex-1 min-h-0 relative flex items-center justify-center bg-gray-950 group">
                {/* Prev Button */}
                {activeIndex > 0 && (
                  <button
                    onClick={handlePrev}
                    className="absolute left-4 z-20 p-2 rounded-full bg-gray-900/60 hover:bg-gray-800/80 text-gray-300 hover:text-white transition-colors cursor-pointer"
                    aria-label="Previous image"
                  >
                    <ChevronLeftIcon className="w-6 h-6" />
                  </button>
                )}

                {/* Main Image */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumbnailUrl(activeEntry.key, activeEntry.etag, 1200)}
                  alt={activeEntry.key.split('/').pop()}
                  className="max-w-full max-h-full object-contain select-none pointer-events-none"
                />

                {/* Next Button */}
                {activeIndex < lightboxList.length - 1 && (
                  <button
                    onClick={handleNext}
                    className="absolute right-4 z-20 p-2 rounded-full bg-gray-900/60 hover:bg-gray-800/80 text-gray-300 hover:text-white transition-colors cursor-pointer"
                    aria-label="Next image"
                  >
                    <ChevronRightIcon className="w-6 h-6" />
                  </button>
                )}
              </div>

              {/* Footer metadata & Split selection */}
              <div className="px-6 py-3 border-t border-gray-800 flex items-center justify-between shrink-0 bg-gray-900 text-gray-300">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-gray-400">
                  <div>
                    <span className="text-gray-500 font-medium">Flight Plan: </span>
                    <span className="text-gray-300 font-medium">{activeEntry.flightPlanName}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 font-medium">Size: </span>
                    <span className="text-gray-300 font-medium">{formatBytes(activeEntry.size)}</span>
                  </div>
                  {activeEntry.imageWidth && activeEntry.imageHeight && (
                    <div>
                      <span className="text-gray-500 font-medium">Dimensions: </span>
                      <span className="text-gray-300 font-medium">{activeEntry.imageWidth}×{activeEntry.imageHeight} px</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">Dataset Split:</span>
                    {canWrite ? (
                      <select
                        value={splits.get(activeEntry.key) ?? 'none'}
                        onChange={e => handleSplitChange(activeEntry.key, e.target.value as SplitChoice)}
                        className={cn(
                          'text-xs rounded border px-2 py-0.5 font-medium focus:outline-none focus:ring-1 cursor-pointer transition-colors',
                          splitSelectClass(splits.get(activeEntry.key) ?? null)
                        )}
                      >
                        <option value="none">Unassigned</option>
                        <option value="train">Train</option>
                        <option value="val">Validation</option>
                        <option value="test">Testing</option>
                      </select>
                    ) : (
                      <SplitBadge split={splits.get(activeEntry.key) ?? null} />
                    )}
                  </div>

                  {activeDownloadUrl && (
                    <a
                      href={activeDownloadUrl}
                      download
                      className={cn(
                        buttonVariants({ variant: 'outline', size: 'xs' }),
                        'bg-gray-800 border-gray-700 hover:bg-gray-700 hover:text-white text-gray-200 gap-1.5'
                      )}
                    >
                      <DownloadIcon className="w-3.5 h-3.5" />
                      Download
                    </a>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
