'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from 'lucide-react'

import type { Split, SurveyType } from '@/lib/schema'
import { assignFileSplit, loadDatasetEntriesBefore, randomlyAssignSplits } from '@/app/actions/files'
import type { DatasetEntry } from '@/app/actions/files'
import { createLabelingTasks, type LabelingTaskInput } from '@/app/actions/labeling-tasks'
import { DEFAULT_TILE_SIZE, TILE_SIZE_OPTIONS, countTiles, tileRegion } from '@/lib/tiling'
import { createLabelingQueue } from '@/app/actions/labeling-queues'

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

// ── File type helpers ──────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv'])

function isImageKey(key: string) {
  return IMAGE_EXTS.has(key.split('.').pop()?.toLowerCase() ?? '')
}

function isVideoKey(key: string) {
  return VIDEO_EXTS.has(key.split('.').pop()?.toLowerCase() ?? '')
}

// ── Rating badge ───────────────────────────────────────────────────────────────

const RATING_COLORS: Record<number, string> = {
  1: 'bg-red-100 text-red-700 border-red-300',
  2: 'bg-yellow-100 text-yellow-700 border-yellow-300',
  3: 'bg-green-100 text-green-700 border-green-300',
}

const RATING_LABELS: Record<number, string> = {
  1: 'Not usable',
  2: 'Somewhat usable',
  3: 'Very usable',
}

function RatingBadge({ rating }: { rating: number | null }) {
  if (!rating) return <span className="text-xs text-gray-300 select-none">—</span>
  return (
    <span
      className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium border', RATING_COLORS[rating])}
      title={RATING_LABELS[rating]}
    >
      {rating}
    </span>
  )
}

// ── Labeling task helpers — images ─────────────────────────────────────────────

function getImageDimensions(key: string): Promise<{ width: number; height: number }> {
  const params = new URLSearchParams({ key, meta: '1' })
  return fetch(`/api/files/thumbnail?${params}`)
    .then(r => { if (!r.ok) throw new Error('meta failed'); return r.json() as Promise<{ width: number; height: number }> })
}

type FileImageInfo = {
  key: string
  fileId: string
  filename: string
  width: number
  height: number
}

type TaskDialogState =
  | { step: 'loading' }
  | { step: 'ready'; fileImages: FileImageInfo[] }
  | { step: 'creating' }
  | { step: 'done'; count: number }
  | { step: 'error'; message: string }

// ── Labeling task helpers — videos ─────────────────────────────────────────────

const VIDEO_FPS = 29.97

const VIDEO_MAX_OPTIONS = [
  { label: '1/s (all)', value: null },
  { label: '30', value: 30 },
  { label: '60', value: 60 },
  { label: '120', value: 120 },
  { label: '300', value: 300 },
] as const

type VideoFileSample = {
  fileId: string
  filename: string
  durationSeconds: number
}

type VideoTaskDialogState =
  | { step: 'ready'; videoEntries: VideoFileSample[] }
  | { step: 'creating' }
  | { step: 'done'; count: number; queueId?: string }
  | { step: 'error'; message: string }

function sampleVideoFrames(durationSeconds: number, maxFrames: number | null): number[] {
  const totalAtOneFps = Math.max(1, Math.floor(durationSeconds))
  const count = maxFrames !== null ? Math.min(totalAtOneFps, maxFrames) : totalAtOneFps
  // Never include frame 0 — "play last second" requires at least 1s of prior footage.
  // For the 1/s case, sample at exactly 1, 2, 3 … whole seconds.
  // For capped cases, distribute evenly starting from 1 second in.
  const isOneFps = maxFrames === null
  if (isOneFps) {
    return Array.from({ length: count }, (_, i) => Math.round((i + 1) * VIDEO_FPS))
  }
  const lastFrame = Math.floor(durationSeconds * VIDEO_FPS)
  const firstFrame = Math.round(VIDEO_FPS) // ~1 second in
  return Array.from({ length: count }, (_, i) =>
    Math.round(firstFrame + (i / (count - 1)) * (lastFrame - firstFrame))
  )
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string
  entries: DatasetEntry[]
  taskCountByFileId: Map<string, number>
  canWrite: boolean
  timezone: string
  hasMore: boolean
  globalCounts: { train: number; val: number; test: number; unassigned: number }
}

export default function DatasetView({ projectId, entries: initialEntries, taskCountByFileId, canWrite, timezone, hasMore: initialHasMore, globalCounts }: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<Tab>('unassigned')
  const [allEntries, setAllEntries] = useState<DatasetEntry[]>(initialEntries)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [splits, setSplits] = useState<Map<string, Split | null>>(
    () => new Map(initialEntries.map(e => [e.key, e.split]))
  )
  const [taskCounts, setTaskCounts] = useState<Map<string, number>>(() => taskCountByFileId)
  const [splitDialog, setSplitDialog] = useState<{ keys: string[] } | null>(null)
  const [pendingSplit, setPendingSplit] = useState<SplitChoice | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [taskDialog, setTaskDialog] = useState<TaskDialogState | null>(null)
  const [taskTileSize, setTaskTileSize] = useState<number | null>(DEFAULT_TILE_SIZE)
  const [videoTaskDialog, setVideoTaskDialog] = useState<VideoTaskDialogState | null>(null)
  const [maxFramesPerVideo, setMaxFramesPerVideo] = useState<number | null>(null)
  const [videoCreateQueue, setVideoCreateQueue] = useState(true)
  const [videoQueueName, setVideoQueueName] = useState('')
  const [collapsedFlights, setCollapsedFlights] = useState<Set<string>>(new Set())
  const [activeImageKey, setActiveImageKey] = useState<string | null>(null)
  const [activeDownloadUrl, setActiveDownloadUrl] = useState('')
  const [lightboxImages, setLightboxImages] = useState<DatasetEntry[]>([])
  const [excludeWithTasks, setExcludeWithTasks] = useState(false)
  const [showImages, setShowImages] = useState(false)
  const [surveyTypeFilter, setSurveyTypeFilter] = useState<'all' | SurveyType>('all')
  const [randomSplitDialogOpen, setRandomSplitDialogOpen] = useState(false)
  const [randomSplitTrainPct, setRandomSplitTrainPct] = useState(70)
  const [randomSplitValPct, setRandomSplitValPct] = useState(15)
  const [randomSplitBusy, setRandomSplitBusy] = useState(false)

  // Infinite scroll sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting && hasMore && !isLoadingMore) loadMore() },
      { rootMargin: '300px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, isLoadingMore])

  async function loadMore() {
    if (isLoadingMore || !hasMore) return
    setIsLoadingMore(true)
    const oldest = allEntries[allEntries.length - 1]
    if (!oldest) { setIsLoadingMore(false); return }
    const result = await loadDatasetEntriesBefore(projectId, oldest.uploadedAtIso)
    setAllEntries(prev => [...prev, ...result.entries])
    setSplits(prev => {
      const n = new Map(prev)
      for (const e of result.entries) n.set(e.key, e.split)
      return n
    })
    setTaskCounts(prev => {
      const n = new Map(prev)
      for (const [k, v] of Object.entries(result.taskCounts)) n.set(k, v)
      return n
    })
    setHasMore(result.hasMore)
    setIsLoadingMore(false)
  }

  // Filter entries by active tab
  const filtered = useMemo(() => {
    return allEntries.filter(e => {
      const s = splits.get(e.key) ?? null
      if (activeTab === 'unassigned') { if (s !== null) return false }
      else { if (s !== activeTab) return false }
      if (!showImages && isImageKey(e.key)) return false
      if (excludeWithTasks && isImageKey(e.key) && (taskCounts.get(e.fileId) ?? 0) > 0) return false
      if (surveyTypeFilter !== 'all' && e.surveyType !== surveyTypeFilter) return false
      return true
    })
  }, [allEntries, splits, activeTab, excludeWithTasks, showImages, taskCounts, surveyTypeFilter])

  const activeEntry = useMemo(() => allEntries.find(e => e.key === activeImageKey) ?? null, [allEntries, activeImageKey])
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

  // A router.refresh() (e.g. after creating tasks or assigning splits) re-runs the
  // server query, which only ever fetches the first page — refreshing initialEntries
  // must NOT wipe out additional pages already loaded here via infinite scroll, or
  // large datasets (more than one page) visibly "lose" files after every action.
  useEffect(() => {
    setAllEntries(prev => {
      const freshByKey = new Map(initialEntries.map(e => [e.key, e]))
      const olderNotInFreshPage = prev.filter(e => !freshByKey.has(e.key))
      return [...initialEntries, ...olderNotInFreshPage]
    })
    setSplits(prev => {
      const n = new Map(prev)
      for (const e of initialEntries) n.set(e.key, e.split)
      return n
    })
    setTaskCounts(prev => {
      const n = new Map(prev)
      for (const [fileId, count] of taskCountByFileId) n.set(fileId, count)
      return n
    })
    setHasMore(initialHasMore)
  }, [initialEntries, taskCountByFileId, initialHasMore])

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
      setSplitDialog({ keys: [key] })
      setPendingSplit(choice)
      return
    }
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

  const confirmRandomSplit = useCallback(async () => {
    const entries = allEntries.filter(e => selected.has(e.key))
    if (entries.length === 0) return
    setRandomSplitBusy(true)
    const fileIds = entries.map(e => e.fileId)
    const res = await randomlyAssignSplits(fileIds, randomSplitTrainPct, randomSplitValPct)
    setRandomSplitBusy(false)
    if (res.error) return
    setRandomSplitDialogOpen(false)
    setSelected(new Set())
    router.refresh()
  }, [allEntries, selected, randomSplitTrainPct, randomSplitValPct, router])

  // ── Image labeling task creation ───────────────────────────────────────────

  const selectedImageEntries = allEntries.filter(
    e => selected.has(e.key) && isImageKey(e.key)
  )

  const openTaskDialog = useCallback(async () => {
    const imageEntries = allEntries.filter(e => selected.has(e.key) && isImageKey(e.key))
    if (imageEntries.length === 0) return
    setTaskDialog({ step: 'loading' })
    try {
      const fileImages: FileImageInfo[] = await Promise.all(
        imageEntries.map(async entry => {
          const filename = entry.key.split('/').pop() ?? entry.key
          try {
            const { width, height } = (entry.imageWidth && entry.imageHeight)
              ? { width: entry.imageWidth, height: entry.imageHeight }
              : await getImageDimensions(entry.key)
            return { key: entry.key, fileId: entry.fileId, filename, width, height }
          } catch {
            return { key: entry.key, fileId: entry.fileId, filename, width: 0, height: 0 }
          }
        })
      )
      setTaskDialog({ step: 'ready', fileImages })
    } catch (e) {
      setTaskDialog({ step: 'error', message: String(e) })
    }
  }, [selected, allEntries])

  const confirmCreateTasks = useCallback(async () => {
    if (!taskDialog || taskDialog.step !== 'ready') return
    const { fileImages } = taskDialog
    setTaskDialog({ step: 'creating' })
    const allTasks: LabelingTaskInput[] = fileImages
      .filter(f => f.width > 0 && f.height > 0)
      .flatMap(f =>
        tileRegion(0, 0, f.width, f.height, taskTileSize).map(t => ({
          fileId: f.fileId,
          x1: t.x1,
          y1: t.y1,
          x2: t.x2,
          y2: t.y2,
          frame: 0,
        })),
      )
    const result = await createLabelingTasks(allTasks)
    if (result.ok) {
      setTaskDialog({ step: 'done', count: result.count ?? 0 })
      setSelected(new Set())
      router.refresh()
    } else {
      setTaskDialog({ step: 'error', message: result.error ?? 'Unknown error' })
    }
  }, [taskDialog, taskTileSize, router])

  // ── Video labeling task creation ───────────────────────────────────────────

  const selectedVideoEntries = allEntries.filter(
    e => selected.has(e.key) && isVideoKey(e.key) &&
      (e.reviewRating === 2 || e.reviewRating === 3)
  )

  const openVideoTaskDialog = useCallback(() => {
    const videoEntries = allEntries
      .filter(e => selected.has(e.key) && isVideoKey(e.key) &&
        (e.reviewRating === 2 || e.reviewRating === 3) &&
        e.durationSeconds != null && e.durationSeconds > 0)
      .map(e => ({
        fileId: e.fileId,
        filename: e.key.split('/').pop() ?? e.key,
        durationSeconds: e.durationSeconds!,
      }))
    if (videoEntries.length === 0) return
    setVideoTaskDialog({ step: 'ready', videoEntries })
  }, [selected, allEntries])

  const confirmCreateVideoTasks = useCallback(async () => {
    if (!videoTaskDialog || videoTaskDialog.step !== 'ready') return
    const { videoEntries } = videoTaskDialog
    setVideoTaskDialog({ step: 'creating' })
    const allTasks: LabelingTaskInput[] = videoEntries.flatMap(v => {
      const frames = sampleVideoFrames(v.durationSeconds, maxFramesPerVideo)
      return frames.map(frame => ({ fileId: v.fileId, x1: 0, y1: 0, x2: 0, y2: 0, frame }))
    })
    const result = await createLabelingTasks(allTasks)
    if (!result.ok) {
      setVideoTaskDialog({ step: 'error', message: result.error ?? 'Unknown error' })
      return
    }
    // Optionally create a queue and add all the new tasks
    if (videoCreateQueue && videoQueueName.trim() && result.taskIds && result.taskIds.length > 0) {
      const queueResult = await createLabelingQueue(
        projectId,
        videoQueueName.trim(),
        null,
        result.taskIds,
      )
      setVideoTaskDialog({ step: 'done', count: result.count ?? 0, queueId: queueResult.id })
    } else {
      setVideoTaskDialog({ step: 'done', count: result.count ?? 0 })
    }
    setSelected(new Set())
    router.refresh()
  }, [videoTaskDialog, maxFramesPerVideo, videoCreateQueue, videoQueueName, projectId, router])

  // ── Tab counts ─────────────────────────────────────────────────────────────

  const counts = globalCounts

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
          {/* Show/hide images toggle */}
          <button
            onClick={() => setShowImages(v => !v)}
            className={cn(
              'ml-3 flex items-center gap-1.5 cursor-pointer select-none text-xs px-2 py-1 rounded border transition-colors pb-1',
              showImages
                ? 'bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100'
                : 'bg-white border-gray-200 text-gray-500 hover:text-gray-700 hover:border-gray-300'
            )}
          >
            {showImages ? '🖼 Hide images' : '🖼 Show images'}
          </button>
          {/* Hide files that already have tasks — only visible when images are shown */}
          {showImages && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-gray-500 hover:text-gray-700 pb-1">
              <input
                type="checkbox"
                className="rounded"
                checked={excludeWithTasks}
                onChange={e => setExcludeWithTasks(e.target.checked)}
              />
              Hide images with tasks
            </label>
          )}
          {/* Survey type filter — scope the workspace to spawning-ground flights only, etc. */}
          <select
            value={surveyTypeFilter}
            onChange={e => setSurveyTypeFilter(e.target.value as 'all' | SurveyType)}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'ml-3 pr-7 cursor-pointer text-xs pb-1')}
          >
            <option value="all">All survey types</option>
            <option value="migration">Migration only</option>
            <option value="spawning">Spawning only</option>
          </select>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pb-1">
          {selected.size > 0 ? (
            <>
              <span className="text-xs text-gray-500 mr-1">{selected.size} selected</span>
              {canWrite && (
                <>
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
                  <button
                    onClick={() => setRandomSplitDialogOpen(true)}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  >
                    Randomly split…
                  </button>
                  {activeTab !== 'unassigned' && selectedImageEntries.length > 0 && (
                    <button
                      onClick={openTaskDialog}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                    >
                      Create image tasks
                    </button>
                  )}
                  {activeTab !== 'unassigned' && selectedVideoEntries.length > 0 && (
                    <button
                      onClick={openVideoTaskDialog}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                    >
                      Create video tasks
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
                        <th className="text-left px-4 py-2 font-medium text-gray-600">Rating</th>
                        <th className="text-left px-4 py-2 font-medium text-gray-600">Uploaded</th>
                        <th className="w-10 px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {group.entries.map(entry => {
                        const filename = entry.key.split('/').pop() ?? entry.key
                        const split = splits.get(entry.key) ?? null
                        const isVideo = isVideoKey(entry.key)
                        const isInsufficientQuality = isVideo && entry.reviewRating !== 2 && entry.reviewRating !== 3
                        return (
                          <tr
                            key={entry.key}
                            className={cn(
                              'transition-colors',
                              selected.has(entry.key) ? 'bg-blue-50' : 'hover:bg-gray-50',
                              isInsufficientQuality && 'opacity-40 text-gray-400'
                            )}
                          >
                            <td
                              className="px-4 py-2.5"
                              onClick={() => {
                                if (isInsufficientQuality) return
                                setSelected(prev => {
                                  const n = new Set(prev)
                                  n.has(entry.key) ? n.delete(entry.key) : n.add(entry.key)
                                  return n
                                })
                              }}
                            >
                              <input
                                type="checkbox"
                                className="rounded pointer-events-none"
                                checked={selected.has(entry.key)}
                                disabled={isInsufficientQuality}
                                onChange={() => {}}
                              />
                            </td>
                            <td
                              className={cn(
                                'px-4 py-2.5 font-mono text-xs max-w-xs truncate transition-all duration-100',
                                isImageKey(entry.key)
                                  ? 'text-blue-600 hover:text-blue-800 hover:underline cursor-pointer font-medium'
                                  : isVideo
                                  ? 'text-blue-600 hover:text-blue-800 font-medium cursor-pointer'
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
                              {isVideo ? (
                                <Link
                                  href={`/projects/${projectId}/flight-plans/${entry.flightPlanId}/flights/${entry.flightId}?file=${entry.fileId}`}
                                  className="flex items-center gap-1 hover:underline"
                                  title={`Open in flight view: ${filename}`}
                                >
                                  <span className="text-gray-400">▶</span>
                                  {filename}
                                </Link>
                              ) : (
                                filename
                              )}
                            </td>
                            <td className="px-4 py-2.5">
                              {canWrite ? (
                                <select
                                  value={split ?? 'none'}
                                  disabled={isInsufficientQuality}
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
                                const n = taskCounts.get(entry.fileId) ?? 0
                                return n > 0
                                  ? <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{n}</span>
                                  : <span className="text-xs text-gray-300">—</span>
                              })()}
                            </td>
                            <td className="px-4 py-2.5">
                              {isVideo ? (
                                <div className="flex items-center gap-2">
                                  <RatingBadge rating={entry.reviewRating} />
                                  {isInsufficientQuality && (
                                    <span className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 whitespace-nowrap">
                                      Rate 2 or 3 to include
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-xs text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-gray-400 text-xs">
                              {new Date(entry.uploadedAtIso).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-2.5">
                              {canWrite && isVideo && !isInsufficientQuality && entry.durationSeconds && entry.durationSeconds > 0 && (
                                <button
                                  onClick={() => {
                                    setVideoTaskDialog({
                                      step: 'ready',
                                      videoEntries: [{
                                        fileId: entry.fileId,
                                        filename: entry.key.split('/').pop() ?? entry.key,
                                        durationSeconds: entry.durationSeconds!,
                                      }],
                                    })
                                  }}
                                  className="whitespace-nowrap text-xs px-2.5 py-1 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition-colors"
                                  title="Create labeling tasks for this video"
                                >
                                  + Tasks
                                </button>
                              )}
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

      {/* Image labeling task creation dialog */}
      <Dialog
        open={!!taskDialog}
        onOpenChange={o => {
          if (!o && taskDialog?.step !== 'loading' && taskDialog?.step !== 'creating') setTaskDialog(null)
        }}
      >
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Create image labeling tasks</DialogTitle>
          </DialogHeader>

          {taskDialog?.step === 'loading' && (
            <p className="text-sm text-gray-500 py-4 text-center">Loading image dimensions…</p>
          )}

          {taskDialog?.step === 'ready' && (() => {
            const imageCount = taskDialog.fileImages.length
            const valid = taskDialog.fileImages.filter(f => f.width > 0 && f.height > 0)
            const taskCount = valid.reduce(
              (sum, f) => sum + countTiles(0, 0, f.width, f.height, taskTileSize), 0,
            )
            return (
              <>
                <div className="grid grid-cols-2 gap-3 my-1">
                  <div className="flex flex-col items-center justify-center rounded-xl bg-gray-50 border border-gray-100 px-3 py-4">
                    <span className="text-2xl font-black text-gray-900">{imageCount}</span>
                    <span className="text-xs text-gray-500 mt-0.5">image{imageCount !== 1 ? 's' : ''} selected</span>
                  </div>
                  <div className="flex flex-col items-center justify-center rounded-xl bg-blue-50 border border-blue-200 px-3 py-4">
                    <span className="text-2xl font-black text-blue-700">{taskCount}</span>
                    <span className="text-xs text-blue-600 mt-0.5">task{taskCount !== 1 ? 's' : ''} to create</span>
                  </div>
                </div>
                <label className="flex items-center justify-between gap-3 text-sm mt-1">
                  <span className="text-gray-700">Tile size</span>
                  <select
                    value={taskTileSize === null ? 'none' : String(taskTileSize)}
                    onChange={e => setTaskTileSize(e.target.value === 'none' ? null : Number(e.target.value))}
                    className="rounded border border-gray-300 px-2 py-1 text-sm cursor-pointer"
                  >
                    {TILE_SIZE_OPTIONS.map(o => (
                      <option key={o.label} value={o.value === null ? 'none' : String(o.value)}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <p className="text-xs text-gray-500 -mt-1">
                  Each image is split into a grid of tiles roughly this many pixels a side, so a
                  labeler sees fewer fish at a time and the annotator can show each tile at full
                  resolution.
                </p>
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
              const taskCount = taskDialog.fileImages
                .filter(f => f.width > 0 && f.height > 0)
                .reduce((sum, f) => sum + countTiles(0, 0, f.width, f.height, taskTileSize), 0)
              return (
                <>
                  <Button variant="outline" onClick={() => setTaskDialog(null)}>Cancel</Button>
                  <Button onClick={confirmCreateTasks} disabled={taskCount === 0}>
                    Create {taskCount} task{taskCount !== 1 ? 's' : ''}
                  </Button>
                </>
              )
            })()}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Video labeling task creation dialog */}
      <Dialog
        open={!!videoTaskDialog}
        onOpenChange={o => {
          if (!o && videoTaskDialog?.step !== 'creating') setVideoTaskDialog(null)
        }}
      >
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Create video labeling tasks</DialogTitle>
          </DialogHeader>

          {videoTaskDialog?.step === 'ready' && (() => {
            const videoCount = videoTaskDialog.videoEntries.length
            const totalFrames = videoTaskDialog.videoEntries.reduce(
              (s, v) => s + Math.floor(v.durationSeconds), 0
            )
            const effectiveTotal = videoTaskDialog.videoEntries.reduce(
              (s, v) => s + sampleVideoFrames(v.durationSeconds, maxFramesPerVideo).length, 0
            )
            const isCapped = maxFramesPerVideo !== null && effectiveTotal < totalFrames
            return (
              <>
                <div className="grid grid-cols-3 gap-3 my-1">
                  <div className="flex flex-col items-center justify-center rounded-xl bg-gray-50 border border-gray-100 px-3 py-4">
                    <span className="text-2xl font-black text-gray-900">{videoCount}</span>
                    <span className="text-xs text-gray-500 mt-0.5">video{videoCount !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="flex flex-col items-center justify-center rounded-xl bg-gray-50 border border-gray-100 px-3 py-4">
                    <span className="text-2xl font-black text-gray-900">{totalFrames}</span>
                    <span className="text-xs text-gray-500 mt-0.5">available frames</span>
                  </div>
                  <div className={`flex flex-col items-center justify-center rounded-xl border px-3 py-4 ${isCapped ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'}`}>
                    <span className={`text-2xl font-black ${isCapped ? 'text-amber-700' : 'text-blue-700'}`}>{effectiveTotal}</span>
                    <span className={`text-xs mt-0.5 ${isCapped ? 'text-amber-600' : 'text-blue-600'}`}>tasks to create{isCapped ? ' (capped)' : ''}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl bg-gray-50 border border-gray-100 px-4 py-3">
                  <div>
                    <p className="text-xs font-medium text-gray-700">Sampling rate</p>
                    <p className="text-xs text-gray-500">1 frame per second by default</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <label className="text-xs text-gray-500 whitespace-nowrap">Max per video</label>
                    <select
                      value={maxFramesPerVideo ?? ''}
                      onChange={e => setMaxFramesPerVideo(e.target.value === '' ? null : Number(e.target.value))}
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                    >
                      {VIDEO_MAX_OPTIONS.map(o => (
                        <option key={String(o.value)} value={o.value ?? ''}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Create queue option */}
                <div className="rounded-xl border border-gray-200 overflow-hidden">
                  <label className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={videoCreateQueue}
                      onChange={e => setVideoCreateQueue(e.target.checked)}
                    />
                    <span className="text-sm font-medium text-gray-700">Create a labeling queue with these tasks</span>
                  </label>
                  {videoCreateQueue && (
                    <div className="px-4 pb-3 border-t border-gray-100">
                      <label className="block text-xs font-medium text-gray-500 mb-1.5 mt-3">Queue name</label>
                      <input
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        placeholder="e.g. Batch 1 — Flight A"
                        value={videoQueueName}
                        onChange={e => setVideoQueueName(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </>
            )
          })()}

          {videoTaskDialog?.step === 'creating' && (
            <p className="text-sm text-gray-500 py-4 text-center">Creating tasks…</p>
          )}

          {videoTaskDialog?.step === 'done' && (
            <div className="py-4 flex flex-col items-center gap-3">
              <p className="text-sm text-green-700 text-center">
                ✓ Created <strong>{videoTaskDialog.count}</strong> video labeling tasks.
              </p>
              {videoTaskDialog.queueId && (
                <Link
                  href={`/projects/${projectId}/labeling/queue/${videoTaskDialog.queueId}`}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition-colors"
                  onClick={() => setVideoTaskDialog(null)}
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>
                  Start Labeling
                </Link>
              )}
            </div>
          )}

          {videoTaskDialog?.step === 'error' && (
            <p className="text-sm text-red-600 py-4">{videoTaskDialog.message}</p>
          )}

          <DialogFooter>
            {(videoTaskDialog?.step === 'done' || videoTaskDialog?.step === 'error') && (
              <Button variant="outline" onClick={() => setVideoTaskDialog(null)}>Close</Button>
            )}
            {videoTaskDialog?.step === 'ready' && (() => {
              const effectiveTotal = videoTaskDialog.videoEntries.reduce(
                (s, v) => s + sampleVideoFrames(v.durationSeconds, maxFramesPerVideo).length, 0
              )
              const needsQueueName = videoCreateQueue && !videoQueueName.trim()
              return (
                <>
                  <Button variant="outline" onClick={() => setVideoTaskDialog(null)}>Cancel</Button>
                  <Button
                    onClick={confirmCreateVideoTasks}
                    disabled={effectiveTotal === 0 || needsQueueName}
                    title={needsQueueName ? 'Enter a queue name to continue' : undefined}
                  >
                    {videoCreateQueue ? `Create & Start Labeling →` : `Create ${effectiveTotal} task${effectiveTotal !== 1 ? 's' : ''}`}
                  </Button>
                </>
              )
            })()}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Random proportional split dialog */}
      <Dialog open={randomSplitDialogOpen} onOpenChange={o => { if (!o) setRandomSplitDialogOpen(false) }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Randomly split into train/val/test</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            Randomly shuffles <strong>{selected.size} selected file{selected.size === 1 ? '' : 's'}</strong> and
            assigns splits proportionally — overwrites any existing split on these files.
          </p>
          <div className="flex flex-col gap-3 mt-1">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-gray-700">Train %</span>
              <input
                type="number" min={0} max={100} value={randomSplitTrainPct}
                onChange={e => setRandomSplitTrainPct(Math.max(0, Math.min(100, Number(e.target.value))))}
                className="w-20 rounded border border-gray-300 px-2 py-1 text-right"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-gray-700">Val %</span>
              <input
                type="number" min={0} max={100} value={randomSplitValPct}
                onChange={e => setRandomSplitValPct(Math.max(0, Math.min(100, Number(e.target.value))))}
                className="w-20 rounded border border-gray-300 px-2 py-1 text-right"
              />
            </label>
            <div className="flex items-center justify-between gap-3 text-sm text-gray-400">
              <span>Test % (remainder)</span>
              <span className="w-20 text-right">{Math.max(0, 100 - randomSplitTrainPct - randomSplitValPct)}</span>
            </div>
          </div>
          {randomSplitTrainPct + randomSplitValPct > 100 && (
            <p className="text-sm text-red-600">Train + Val can't exceed 100%.</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRandomSplitDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={confirmRandomSplit}
              disabled={randomSplitBusy || randomSplitTrainPct + randomSplitValPct > 100 || selected.size === 0}
            >
              {randomSplitBusy ? 'Splitting…' : 'Randomly split'}
            </Button>
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

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} className="h-1" />
      {isLoadingMore && (
        <div className="flex items-center justify-center py-6 text-gray-400 text-xs gap-2">
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Loading more files…
        </div>
      )}

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
                {activeIndex > 0 && (
                  <button
                    onClick={handlePrev}
                    className="absolute left-4 z-20 p-2 rounded-full bg-gray-900/60 hover:bg-gray-800/80 text-gray-300 hover:text-white transition-colors cursor-pointer"
                    aria-label="Previous image"
                  >
                    <ChevronLeftIcon className="w-6 h-6" />
                  </button>
                )}

                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumbnailUrl(activeEntry.key, activeEntry.etag, 1200)}
                  alt={activeEntry.key.split('/').pop()}
                  className="max-w-full max-h-full object-contain select-none pointer-events-none"
                />

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

              {/* Footer */}
              <div className="px-6 py-3 border-t border-gray-800 flex items-center justify-between shrink-0 bg-gray-900 text-gray-300">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-gray-400">
                  <div>
                    <span className="text-gray-500 font-medium">Flight Route: </span>
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
