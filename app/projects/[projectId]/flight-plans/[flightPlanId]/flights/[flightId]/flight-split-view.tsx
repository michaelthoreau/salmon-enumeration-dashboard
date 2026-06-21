'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { MapIcon, ImageIcon, DownloadIcon, ArrowLeft, Maximize2, Minimize2, RefreshCw, X, Wind, Cloud, Droplet, Thermometer, Compass, Waves, AlertTriangle, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from 'lucide-react'
import FlightUploader from './flight-uploader'
import FileLightbox from './file-lightbox'
import EditFlightButton from './edit-flight-button'
import ShareFlightButton from './share-flight-button'
import OrthoMap from './ortho-map'
import ProcessingModal from './processing-modal'
import VideoPlayer from './video-player'
import { Layers } from 'lucide-react'
import { assignFileSplit, syncFlightFiles } from '@/app/actions/files'
import { updateFlightPlanLocation } from '@/app/actions/flight-plans'
import type { Split, flights, flightPlans, projects, odmTasks, georefTasks } from '@/lib/schema'
import type { InferSelectModel } from 'drizzle-orm'

type Flight = InferSelectModel<typeof flights>
type FlightPlan = InferSelectModel<typeof flightPlans>
type Project = InferSelectModel<typeof projects>
type OdmTask = InferSelectModel<typeof odmTasks>
type GeorefTask = InferSelectModel<typeof georefTasks>

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])
const VIDEO_EXTS = new Set(['mp4', 'mov'])

function isImage(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
}

function isVideo(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTS.has(ext)
}

async function openPresignedUrl(key: string, download = false): Promise<void> {
  const qs = download ? `&download=1` : ''
  const res = await fetch(`/api/files/presign?key=${encodeURIComponent(key)}${qs}`)
  if (!res.ok) return
  const { url } = await res.json()
  window.open(url, '_blank', 'noreferrer')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function thumbnailUrl(key: string, etag: string, size: number): string {
  return `/api/files/thumbnail?key=${encodeURIComponent(key)}&etag=${encodeURIComponent(etag)}&size=${size}`
}

const SPLIT_SELECT_CLASSES: Record<string, string> = {
  train: 'bg-blue-50 border-blue-300 text-blue-700 focus:ring-blue-400',
  val: 'bg-amber-50 border-amber-300 text-amber-700 focus:ring-amber-400',
  test: 'bg-green-50 border-green-300 text-green-700 focus:ring-green-400',
  none: 'bg-white border-gray-200 text-gray-400 focus:ring-blue-400',
}

interface FileEntry {
  id: string
  key: string
  size: number
  lastModifiedIso: string
  etag: string
  split: Split | null
  latitude?: number | null
  longitude?: number | null
}

interface FlightSplitViewProps {
  projectId: string
  flightPlanId: string
  flightId: string
  flight: Flight
  flightPlan: FlightPlan
  project: Project
  displayObjects: FileEntry[]
  geotiffKey: string | null
  reportPdfKey: string | null
  geotiffDownloadUrl: string
  reportPdfViewUrl: string
  latestOdmTask: OdmTask | null
  latestGeorefTask: GeorefTask | null
  splitByKey: Record<string, Split | null>
  canWrite: boolean
  formattedTime: string
  localTimestamp: string
  weather: {
    temperature: number
    precipitation: number
    cloudCover: number
    windSpeed: number
    windDirection: number
  } | null
  tides: {
    stationName: string
    predictions: { time: string; value: number }[]
  } | null
  initialAnnotations?: any[]
  userEmailMap?: Record<string, string>
  from?: string
  returnTo?: string
}

export default function FlightSplitView({
  projectId,
  flightPlanId,
  flightId,
  flight,
  flightPlan,
  project,
  displayObjects,
  geotiffKey,
  reportPdfKey,
  geotiffDownloadUrl,
  reportPdfViewUrl,
  latestOdmTask,
  latestGeorefTask,
  splitByKey,
  canWrite,
  formattedTime,
  localTimestamp,
  weather,
  tides,
  initialAnnotations = [],
  userEmailMap = {},
  from,
  returnTo,
}: FlightSplitViewProps) {
  const router = useRouter()
  const [sidebarWidth, setSidebarWidth] = useState(500)
  const [zoomTrigger, setZoomTrigger] = useState(0)
  const [activeTab, setActiveTab] = useState<'map' | 'images'>(geotiffKey ? 'map' : 'images')
  const isResizingRef = useRef(false)

  const [isModalOpen, setIsModalOpen] = useState(false)

  // Helper to compute Tide SVG path parameters for a given viewport size
  const getTideSvgData = useCallback((width: number, height: number, padX: number, padY: number) => {
    if (!tides || !tides.predictions || tides.predictions.length === 0) return null

    const flightTimeMs = new Date(flight.timestamp).getTime()

    // Filter predictions to show a narrower window: from 12 hours before to 24 hours after the flight
    const minTimeMs = flightTimeMs - 12 * 60 * 60 * 1000
    const maxTimeMs = flightTimeMs + 24 * 60 * 60 * 1000

    const predictions = tides.predictions.filter((p) => {
      const t = new Date(p.time).getTime()
      return t >= minTimeMs && t <= maxTimeMs
    })

    if (predictions.length === 0) return null

    const values = predictions.map((p) => p.value)
    const minVal = Math.min(...values)
    const maxVal = Math.max(...values)
    const valRange = maxVal - minVal || 1

    const scaleX = (idx: number) => padX + (idx / (predictions.length - 1)) * (width - 2 * padX)
    const scaleY = (val: number) => {
      const pct = (val - minVal) / valRange
      return height - padY - pct * (height - 2 * padY)
    }

    // Build curve path
    const points = predictions.map((p, idx) => `${scaleX(idx).toFixed(1)},${scaleY(p.value).toFixed(1)}`)
    const pathD = `M ${points.join(' L ')}`
    const fillD = `${pathD} L ${scaleX(predictions.length - 1).toFixed(1)},${height} L ${scaleX(0).toFixed(1)},${height} Z`

    // Find closest prediction to flight timestamp
    let closestIdx = 0
    let minDiff = Infinity

    predictions.forEach((p, idx) => {
      const diff = Math.abs(new Date(p.time).getTime() - flightTimeMs)
      if (diff < minDiff) {
        minDiff = diff
        closestIdx = idx
      }
    })

    const closestPred = predictions[closestIdx]
    const dotX = scaleX(closestIdx)
    const dotY = scaleY(closestPred.value)

    // Determine tide direction (rising or falling)
    let isRising = false
    if (closestIdx < predictions.length - 1) {
      isRising = predictions[closestIdx + 1].value > closestPred.value
    } else if (closestIdx > 0) {
      isRising = closestPred.value > predictions[closestIdx - 1].value
    }

    // Find local maxima and minima (High and Low tides)
    const highsLows: { type: 'high' | 'low'; x: number; y: number; val: number; time: string }[] = []
    for (let i = 1; i < predictions.length - 1; i++) {
      const prev = predictions[i - 1].value
      const curr = predictions[i].value
      const next = predictions[i + 1].value
      if (curr >= prev && curr >= next && (curr > prev || curr > next)) {
        highsLows.push({ type: 'high', x: scaleX(i), y: scaleY(curr), val: curr, time: predictions[i].time })
      } else if (curr <= prev && curr <= next && (curr < prev || curr < next)) {
        highsLows.push({ type: 'low', x: scaleX(i), y: scaleY(curr), val: curr, time: predictions[i].time })
      }
    }

    return {
      pathD,
      fillD,
      dotX,
      dotY,
      closestValue: closestPred.value,
      isRising,
      scaleY0: scaleY(0),
      minVal,
      maxVal,
      highsLows,
      predictions: predictions.map((p, idx) => ({ ...p, x: scaleX(idx), y: scaleY(p.value) })),
    }
  }, [tides, flight.timestamp])

  const tideSvg = getTideSvgData(400, 100, 25, 20)

  // Refresh page data on mount to bypass client-side router cache
  useEffect(() => {
    router.refresh()
  }, [router])

  // Unified task logic
  const latestOdm = latestOdmTask ? { ...latestOdmTask, type: 'odm' as const, error: null as string | null } : null
  const latestGeoref = latestGeorefTask ? { ...latestGeorefTask, type: latestGeorefTask.totalImages === 0 ? ('upload' as const) : ('georef' as const) } : null

  const activeOdm = latestOdm && !['completed', 'failed', 'canceled'].includes(latestOdm.status) ? latestOdm : null
  const activeGeoref = latestGeoref && !['completed', 'failed', 'canceled'].includes(latestGeoref.status) ? latestGeoref : null

  const activeTask = activeOdm || activeGeoref
  const latestTask = activeTask ||
    ((latestOdm && latestGeoref)
      ? (new Date(latestOdm.createdAt) > new Date(latestGeoref.createdAt) ? latestOdm : latestGeoref)
      : (latestOdm || latestGeoref || null))

  const completedTask = (latestOdmTask && latestGeorefTask)
    ? (new Date(latestOdmTask.createdAt) > new Date(latestGeorefTask.createdAt) ? latestOdmTask : latestGeorefTask)
    : (latestOdmTask || latestGeorefTask || null)

  const cacheBuster = completedTask?.completedAt
    ? new Date(completedTask.completedAt).getTime().toString()
    : null

  // Live polling for sidebar status when a task is active
  const [activeTaskState, setActiveTaskState] = useState<{
    status: string
    processed: number
    total: number
    progress?: number
    outputKey?: string | null
    reportKey?: string | null
  } | null>(() => {
    if (!activeTask) return null
    return {
      status: activeTask.status,
      processed: activeTask.processed ?? 0,
      total: activeTask.totalImages ?? 0,
      progress: activeTask.progress ?? 0,
      outputKey: activeTask.outputKey,
      reportKey: 'reportKey' in activeTask ? (activeTask as any).reportKey : null,
    }
  })

  useEffect(() => {
    if (!activeTask) {
      setActiveTaskState(null)
      return
    }

    let active = true
    let timerId: NodeJS.Timeout

    async function poll() {
      if (!activeTask) return
      const endpoint = activeTask.type === 'odm'
        ? `/api/odm/tasks/${activeTask.id}?outputLine=999999`
        : `/api/georef/tasks/${activeTask.id}?outputLine=999999`

      try {
        const res = await fetch(endpoint, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        if (!active) return

        const p = data.uploadedImages ?? data.processed ?? 0
        const t = data.totalImages ?? data.total ?? 0
        let progress = data.progress ?? (data.status === 'completed' ? 100 : (t > 0 ? (p / t) * 100 : 0))
        if (data.status !== 'completed' && progress >= 100) {
          progress = 90
        }

        setActiveTaskState((prev) => {
          const finalProcessed = Math.max(p, prev ? prev.processed : 0)
          const finalTotal = t > 0 ? t : (prev ? prev.total : 0)
          let calculatedProgress = finalTotal > 0 ? (finalProcessed / finalTotal) * 100 : 0
          if (data.status !== 'completed' && calculatedProgress >= 100) {
            calculatedProgress = 90
          }
          let nextProgress = data.progress ?? (data.status === 'completed' ? 100 : calculatedProgress)
          if (data.status !== 'completed' && nextProgress >= 100) {
            nextProgress = 90
          }
          const finalProgress = Math.max(
            nextProgress,
            prev?.progress ?? 0
          )

          return {
            status: data.status,
            processed: finalProcessed,
            total: finalTotal,
            progress: finalProgress,
            outputKey: data.outputKey ?? prev?.outputKey ?? null,
            reportKey: data.reportKey ?? prev?.reportKey ?? null,
          }
        })

        if (['completed', 'failed', 'canceled'].includes(data.status)) {
          router.refresh()
        } else {
          timerId = setTimeout(poll, 4000)
        }
      } catch (err) {
        if (active) {
          timerId = setTimeout(poll, 8000)
        }
      }
    }

    poll()

    return () => {
      active = false
      clearTimeout(timerId)
    }
  }, [activeTask?.id, activeTask?.type, router])

  // Poll for new files arriving (e.g. Lambda still registering after DJI sync)
  const [fileCount, setFileCount] = useState(displayObjects.length)
  const [fileSyncActive, setFileSyncActive] = useState(false)
  const prevFileCountRef = useRef(displayObjects.length)

  useEffect(() => {
    setFileCount(displayObjects.length)
    prevFileCountRef.current = displayObjects.length
  }, [displayObjects.length])

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const res = await fetch(`/api/files?flightId=${flightId}&count=true`)
        if (!res.ok || !active) return
        const { count } = await res.json()
        if (!active) return
        if (count > prevFileCountRef.current) {
          setFileSyncActive(true)
          setFileCount(count)
          prevFileCountRef.current = count
          router.refresh()
        } else if (count === prevFileCountRef.current && fileSyncActive) {
          setFileSyncActive(false)
        }
      } catch { /* skip */ }
    }
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [flightId, router, fileSyncActive])

  const [isSyncing, setIsSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const handleSync = useCallback(async () => {
    setIsSyncing(true)
    setSyncStatus(null)
    try {
      const result = await syncFlightFiles(projectId, flightPlanId, flightId)
      if (result.ok) {
        if (result.added === 0 && result.removed === 0) {
          setSyncStatus({ type: 'success', message: 'All files are already synchronized with S3.' })
        } else {
          setSyncStatus({
            type: 'success',
            message: `Sync complete: Registered ${result.added} missing file(s) and removed ${result.removed} orphaned database record(s).`
          })
        }
        router.refresh()
      } else {
        setSyncStatus({ type: 'error', message: result.error ?? 'Sync failed.' })
      }
    } catch (err) {
      setSyncStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setIsSyncing(false)
    }
  }, [projectId, flightPlanId, flightId, router])

  const [cancelling, setCancelling] = useState(false)

  const handleCancelTask = useCallback(async () => {
    if (!activeTask) return
    if (!confirm('Are you sure you want to stop/abandon this processing job?')) return
    setCancelling(true)

    const endpoint = activeTask.type === 'odm'
      ? `/api/odm/tasks/${activeTask.id}`
      : `/api/georef/tasks/${activeTask.id}`

    try {
      const res = await fetch(endpoint, { method: 'DELETE' })
      if (res.ok) {
        setActiveTaskState((prev) => prev ? { ...prev, status: 'canceled' } : null)
        router.refresh()
      } else {
        const data = await res.json()
        alert(data.error ?? 'Failed to cancel task')
      }
    } catch (err) {
      alert('Error canceling task: ' + String(err))
    } finally {
      setCancelling(false)
    }
  }, [activeTask, router])

  // Clear sync status after 6 seconds
  useEffect(() => {
    if (syncStatus) {
      const timer = setTimeout(() => setSyncStatus(null), 6000)
      return () => clearTimeout(timer)
    }
  }, [syncStatus])

  // Automatically switch to map tab once the processing finishes and geotiffKey becomes available
  useEffect(() => {
    if (geotiffKey) {
      setActiveTab('map')
    }
  }, [geotiffKey])

  // Annotations state
  const [annotations, setAnnotations] = useState<any[]>(initialAnnotations)

  // Calculate total fish count from annotations
  const totalFishCount = annotations.reduce((sum, anno) => sum + (anno.fishCount || 0), 0)

  // Video fish counter helpers
  const getVideoFishCount = useCallback((fileId: string) => {
    const anno = annotations.find((a) => a.label === 'video-count' && a.fileId === fileId)
    return anno?.fishCount ?? 0
  }, [annotations])

  const annotationsUrl = `/api/projects/${projectId}/flight-plans/${flightPlanId}/flights/${flightId}/annotations`

  const handleVideoIncrement = useCallback(async (fileId: string) => {
    const existing = annotations.find((a) => a.label === 'video-count' && a.fileId === fileId)
    if (existing) {
      const next = (existing.fishCount || 0) + 1
      setAnnotations((prev) => prev.map((a) => a.id === existing.id ? { ...a, fishCount: next } : a))
      try {
        await fetch(annotationsUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: existing.id, fishCount: next }),
        })
      } catch { /* poll will correct */ }
    } else {
      const tempId = `__optimistic__${Date.now()}`
      const tempAnno = {
        id: tempId,
        flightId,
        fileId,
        shape: 'point',
        geometry: '{"type":"Point","coordinates":[0,0]}',
        fishCount: 1,
        confidence: 1.0,
        label: 'video-count',
      }
      setAnnotations((prev) => [...prev, tempAnno])
      try {
        const res = await fetch(annotationsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shape: 'point',
            geometry: '{"type":"Point","coordinates":[0,0]}',
            fishCount: 1,
            confidence: 1.0,
            fileId,
            label: 'video-count',
          }),
        })
        if (res.ok) {
          const newAnno = await res.json()
          setAnnotations((prev) => prev.map((a) => a.id === tempId ? newAnno : a))
        } else {
          setAnnotations((prev) => prev.filter((a) => a.id !== tempId))
        }
      } catch {
        setAnnotations((prev) => prev.filter((a) => a.id !== tempId))
      }
    }
  }, [annotations, annotationsUrl, flightId])

  const handleVideoDecrement = useCallback(async (fileId: string) => {
    const existing = annotations.find((a) => a.label === 'video-count' && a.fileId === fileId)
    if (!existing || (existing.fishCount || 0) <= 0) return
    const next = (existing.fishCount || 0) - 1
    setAnnotations((prev) => prev.map((a) => a.id === existing.id ? { ...a, fishCount: next } : a))
    try {
      await fetch(annotationsUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: existing.id, fishCount: next }),
      })
    } catch { /* poll will correct */ }
  }, [annotations, annotationsUrl])

  // Video notes helpers
  const getVideoNotes = useCallback((fileId: string) => {
    return annotations
      .filter((a) => a.label === 'video-note' && a.fileId === fileId)
      .map((a) => {
        const author = userEmailMap[a.createdBy] ?? a.createdBy ?? ''
        try {
          const data = JSON.parse(a.geometry)
          return { id: a.id, time: data.time ?? 0, frame: data.frame ?? 0, text: data.text ?? '', author }
        } catch {
          return { id: a.id, time: 0, frame: 0, text: '', author }
        }
      })
  }, [annotations, userEmailMap])

  const handleAddNote = useCallback(async (fileId: string, note: { time: number; frame: number; text: string }) => {
    const geometry = JSON.stringify({ time: note.time, frame: note.frame, text: note.text })
    const tempId = `__optimistic__${Date.now()}`
    const tempAnno = {
      id: tempId, flightId, fileId, shape: 'point' as const,
      geometry, fishCount: 0, confidence: 1.0, label: 'video-note',
    }
    setAnnotations((prev) => [...prev, tempAnno])
    try {
      const res = await fetch(annotationsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shape: 'point', geometry, fishCount: 0, confidence: 1.0, fileId, label: 'video-note' }),
      })
      if (res.ok) {
        const newAnno = await res.json()
        setAnnotations((prev) => prev.map((a) => a.id === tempId ? newAnno : a))
      } else {
        setAnnotations((prev) => prev.filter((a) => a.id !== tempId))
      }
    } catch {
      setAnnotations((prev) => prev.filter((a) => a.id !== tempId))
    }
  }, [annotationsUrl, flightId])

  const handleDeleteNote = useCallback(async (id: string) => {
    const removed = annotations.find((a) => a.id === id)
    setAnnotations((prev) => prev.filter((a) => a.id !== id))
    try {
      const res = await fetch(`${annotationsUrl}?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok && removed) setAnnotations((prev) => [...prev, removed])
    } catch {
      if (removed) setAnnotations((prev) => [...prev, removed])
    }
  }, [annotations, annotationsUrl])

  // Sync annotations if initialAnnotations changes (e.g. server-side refresh)
  useEffect(() => {
    setAnnotations(initialAnnotations)
  }, [initialAnnotations])

  // Poll for new annotations every 7s to support concurrent annotators
  useEffect(() => {
    const url = `/api/projects/${projectId}/flight-plans/${flightPlanId}/flights/${flightId}/annotations`
    const poll = async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) return
        const serverAnnotations = await res.json()
        setAnnotations((prev) => {
          // Keep any optimistic (in-flight) entries the current user just added
          const optimistic = prev.filter((a) => String(a.id).startsWith('__optimistic__'))
          // Merge: server is the source of truth for all confirmed annotations
          return [...serverAnnotations, ...optimistic]
        })
      } catch {
        // Network hiccup — silently skip this poll cycle
      }
    }

    const interval = setInterval(poll, 7000)
    return () => clearInterval(interval)
  }, [projectId, flightPlanId, flightId])

  // Image list filtering
  const images = displayObjects.filter((o) => isImage(o.key) || isVideo(o.key))
  const [activeImage, setActiveImage] = useState<FileEntry | null>(images[0] ?? null)
  const [loadedKeys, setLoadedKeys] = useState<Record<string, boolean>>({})
  const activeImageLoading = !!(activeImage && !isVideo(activeImage.key) && !loadedKeys[activeImage.key])

  const handleImageRef = useCallback((imgNode: HTMLImageElement | null) => {
    if (imgNode && imgNode.complete && activeImage) {
      const key = activeImage.key
      setLoadedKeys((prev) => {
        if (prev[key]) return prev
        return { ...prev, [key]: true }
      })
    }
  }, [activeImage])
  const [lightboxImage, setLightboxImage] = useState<FileEntry | null>(null)
  const [lightboxFullResUrl, setLightboxFullResUrl] = useState<string | null>(null)
  const [isFullResLoading, setIsFullResLoading] = useState(false)
  const [isFullResImageLoading, setIsFullResImageLoading] = useState(false)
  const [isFullscreenPlayer, setIsFullscreenPlayer] = useState(false)
  const [isFullscreenMap, setIsFullscreenMap] = useState(false)

  const handlePrevImage = useCallback(() => {
    if (!activeImage || images.length <= 1) return
    const currentIndex = images.findIndex((img) => img.key === activeImage.key)
    if (currentIndex > 0) {
      setActiveImage(images[currentIndex - 1])
    } else {
      setActiveImage(images[images.length - 1])
    }
  }, [activeImage, images])

  const handleNextImage = useCallback(() => {
    if (!activeImage || images.length <= 1) return
    const currentIndex = images.findIndex((img) => img.key === activeImage.key)
    if (currentIndex < images.length - 1) {
      setActiveImage(images[currentIndex + 1])
    } else {
      setActiveImage(images[0])
    }
  }, [activeImage, images])

  // Listen for keys to navigate and exit full viewport player
  useEffect(() => {
    if (!isFullscreenPlayer) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullscreenPlayer(false)
      } else if (e.key === 'ArrowLeft') {
        handlePrevImage()
      } else if (e.key === 'ArrowRight') {
        handleNextImage()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreenPlayer, handlePrevImage, handleNextImage])

  useEffect(() => {
    if (!isFullscreenMap) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreenMap(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreenMap])

  // Notify maplibre to resize when fullscreen map toggles
  useEffect(() => {
    const timer = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
    return () => clearTimeout(timer)
  }, [isFullscreenMap])

  // Zoom and pan state for lightbox image
  const [zoomScale, setZoomScale] = useState(1)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY < 0 ? 0.25 : -0.25
    setZoomScale((prev) => {
      const next = Math.max(1, Math.min(5, prev + delta))
      if (next === 1) {
        setPanOffset({ x: 0, y: 0 })
      }
      return next
    })
  }, [])

  const viewportRefVal = useRef<HTMLDivElement | null>(null)
  const viewportRef = useCallback((node: HTMLDivElement | null) => {
    if (viewportRefVal.current) {
      viewportRefVal.current.removeEventListener('wheel', handleWheel)
    }
    viewportRefVal.current = node
    if (node) {
      node.addEventListener('wheel', handleWheel, { passive: false })
    }
  }, [handleWheel])

  // Reset full res and zoom state when lightbox image changes
  useEffect(() => {
    setLightboxFullResUrl(null)
    setIsFullResLoading(false)
    setIsFullResImageLoading(false)
    setZoomScale(1)
    setPanOffset({ x: 0, y: 0 })
    setIsDragging(false)
  }, [lightboxImage])

  // Sync activeImage if the images list changes (e.g. after upload refresh or file deletion)
  useEffect(() => {
    if (images.length === 0) {
      if (activeImage !== null) setActiveImage(null)
    } else {
      const activeStillExists = activeImage && images.some(img => img.key === activeImage.key)
      if (!activeStillExists) {
        setActiveImage(images[0])
      }
    }
  }, [images, activeImage])

  // Derived state: split for active image
  const activeSplit = (activeImage && splitByKey[activeImage.key]) || 'none'

  // Derived task status & progress
  const taskStatus = activeTaskState?.status || latestTask?.status
  const isTaskActive = !!(activeTask && !['completed', 'failed', 'canceled'].includes(taskStatus || ''))
  const total = activeTaskState?.total ?? latestTask?.totalImages ?? 0
  const processed = activeTaskState?.processed ?? (latestTask && 'processed' in latestTask ? latestTask.processed : null) ?? 0
  let progress = activeTaskState?.progress ?? (latestTask && 'progress' in latestTask ? latestTask.progress : null) ?? (total > 0 ? (processed / total) * 100 : 0)
  if (taskStatus !== 'completed' && progress >= 100) {
    progress = 90
  }
  const currentOutputKey = activeTaskState?.outputKey || latestTask?.outputKey
  const currentReportKey = activeTaskState?.reportKey || (latestTask && 'reportKey' in latestTask ? latestTask.reportKey : null)

  // Drag resizing handlers
  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return
      const newWidth = Math.max(320, Math.min(650, e.clientX))
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false
        document.body.style.removeProperty('cursor')
        document.body.style.removeProperty('user-select')
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const handleSplitChange = async (newSplit: string) => {
    if (!activeImage) return
    const target = newSplit === 'none' ? null : (newSplit as Split)
    await assignFileSplit(activeImage.key, target)
    router.refresh()
  }

  // Pre-generate download link for active image
  const [activeImageDownloadUrl, setActiveImageDownloadUrl] = useState('')
  useEffect(() => {
    if (!activeImage) return
    let active = true
    async function fetchDownloadUrl() {
      const res = await fetch(`/api/files/presign?key=${encodeURIComponent(activeImage!.key)}&download=1`)
      if (!res.ok) return
      const { url } = await res.json()
      if (active) setActiveImageDownloadUrl(url)
    }
    fetchDownloadUrl()
    return () => { active = false }
  }, [activeImage])

  return (
    <div className="fixed top-[100px] bottom-0 left-0 right-0 z-10 bg-gray-50 flex overflow-hidden border-t border-gray-200">
      {/* ─── Left Sidebar ─── */}
      <aside
        style={{ width: `${sidebarWidth}px` }}
        className="h-full overflow-y-auto no-scrollbar border-r border-gray-200 bg-white p-6 space-y-6 flex-shrink-0 flex flex-col"
      >
        {/* Header */}
        <div>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-2 -ml-1">
              <Link
                href={returnTo || `/projects/${projectId}/flight-plans/${flightPlanId}/flights${from ? `?from=${from}` : ''}`}
                className="p-1 hover:bg-gray-100 rounded-md transition-colors text-gray-500 hover:text-gray-900 mt-0.5 flex-shrink-0"
                title={`Back to ${flightPlan.displayName || flightPlan.name}`}
              >
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 block mb-0.5 select-none">
                  Flight Route
                </span>
                <h1 className="text-lg font-bold text-gray-900 leading-snug">
                  {flightPlan.displayName || flightPlan.name}
                </h1>
                <p className="text-sm font-medium text-gray-500 mt-1">
                  {formattedTime}
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5 font-mono">
                  {flight.timestamp.toISOString()}
                </p>
                {flight.notes && <p className="text-sm text-gray-500 mt-2">{flight.notes}</p>}

              </div>
            </div>
            <div className="flex items-center gap-2">
              <ShareFlightButton />
              {canWrite && (
                <EditFlightButton
                  flightId={flightId}
                  projectId={projectId}
                  flightPlanId={flightPlanId}
                  timezone={project.timezone}
                  localTimestamp={localTimestamp}
                  currentNotes={flight.notes}
                />
              )}
            </div>
          </div>
        </div>

        {/* Uploader & Sync Section */}
        {canWrite && (
          <section className="border-t border-gray-100 pt-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <FlightUploader
                flightId={flightId}
                defaultOpen={false}
                hasFiles={displayObjects.length > 0}
              />
              <Button
                variant="outline"
                className="w-full flex items-center justify-center gap-2"
                onClick={handleSync}
                disabled={isSyncing}
              >
                <RefreshCw className={cn("w-4 h-4 text-gray-500", isSyncing && "animate-spin")} />
                <span>{isSyncing ? 'Syncing...' : 'Sync S3'}</span>
              </Button>
            </div>

            {syncStatus && (
              <div
                className={cn(
                  "p-3 rounded-lg border text-xs animate-in fade-in slide-in-from-top-1 duration-200",
                  syncStatus.type === 'success'
                    ? "bg-green-50 text-green-700 border-green-200"
                    : "bg-red-50 text-red-700 border-red-200"
                )}
              >
                {syncStatus.message}
              </div>
            )}
          </section>
        )}

        {/* Unified Processing Panel */}
        {canWrite && (
          <section className="border-t border-gray-100 pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="w-5 h-5 text-gray-500" />
                <h2 className="text-sm font-semibold text-gray-900">Map Processing</h2>
              </div>
              <button
                onClick={() => setIsModalOpen(true)}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                {activeTask ? (
                  <>
                    <span className="w-2.5 h-2.5 rounded-full bg-white opacity-75 animate-pulse" />
                    <span>View Monitor</span>
                  </>
                ) : (
                  <span>Process Imagery</span>
                )}
              </button>
            </div>

            {/* Current/Latest Status Card */}
            {latestTask ? (
              <div className="p-3 bg-gray-50 dark:bg-slate-800/40 border border-gray-200 dark:border-slate-800 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-500 dark:text-gray-400 font-mono capitalize">
                    {latestTask.type === 'odm' ? 'ODM Reconstruction' : 'Quick Georeference'}
                  </span>
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                    taskStatus === 'completed' ? 'bg-green-100 text-green-800 dark:bg-green-950/20 dark:text-green-400' :
                      taskStatus === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-950/20 dark:text-red-400' :
                        taskStatus === 'canceled' ? 'bg-gray-100 text-gray-800 dark:bg-gray-850 dark:text-gray-400' :
                          'bg-blue-100 text-blue-800 dark:bg-blue-950/20 dark:text-blue-400 animate-pulse'
                  )}>
                    {taskStatus}
                  </span>
                </div>

                {isTaskActive && (
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-gray-500 dark:text-gray-400">
                        {taskStatus === 'uploading'
                          ? `Uploading images (${processed}/${total})`
                          : `Processing (${processed}/${total})`}
                      </span>
                      <span className="font-semibold text-gray-700 dark:text-slate-200">
                        {Math.round(progress)}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-gray-200 dark:bg-slate-850 overflow-hidden relative">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          latestTask.type === 'odm' ? 'bg-gradient-to-r from-blue-500 to-indigo-600' : 'bg-gradient-to-r from-emerald-500 to-teal-600'
                        )}
                        style={{ width: `${Math.max(3, progress)}%` }}
                      />
                    </div>
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={handleCancelTask}
                        disabled={cancelling}
                        className="px-2 py-1 bg-red-50 hover:bg-red-100 dark:bg-red-950/20 dark:hover:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-900/30 rounded text-[10px] font-medium transition-colors cursor-pointer"
                      >
                        {cancelling ? 'Stopping...' : 'Stop Processing'}
                      </button>
                    </div>
                  </div>
                )}

                {taskStatus === 'completed' && currentOutputKey && (
                  <div className="flex items-center gap-2 text-xs pt-1">
                    <button
                      onClick={() => openPresignedUrl(currentOutputKey, true)}
                      className="text-emerald-700 hover:text-emerald-950 dark:text-emerald-400 dark:hover:text-emerald-300 font-medium underline flex items-center gap-1 cursor-pointer"
                    >
                      <DownloadIcon className="w-3.5 h-3.5" />
                      <span>Download GeoTIFF</span>
                    </button>
                    {latestTask.type === 'odm' && currentReportKey && (
                      <button
                        onClick={() => openPresignedUrl(currentReportKey)}
                        className="text-slate-700 hover:text-slate-900 dark:text-slate-350 dark:hover:text-slate-200 font-medium underline flex items-center gap-1 ml-2 cursor-pointer"
                      >
                        📄 View Report
                      </button>
                    )}
                  </div>
                )}
                {taskStatus === 'failed' && latestTask.error && (
                  <p className="text-[11px] text-red-650 line-clamp-2 italic font-mono bg-red-50/50 dark:bg-red-950/5 p-1 border border-red-100 dark:border-red-950/20 rounded">
                    {latestTask.error}
                  </p>
                )}
              </div>
            ) : (
              <div className="p-3 bg-gray-50/50 border border-dashed border-gray-200 dark:border-slate-800 dark:bg-slate-800/10 rounded-xl text-center text-xs text-gray-550 italic py-5 select-none">
                No processed orthomap exists yet.
              </div>
            )}
          </section>
        )}

        {/* Fish Marked Section */}
        <section className="border-t border-gray-100 pt-4">
          <p className="text-sm text-gray-700">Fish Marked: <span className="font-semibold">{totalFishCount}</span></p>
        </section>

        {/* Environmental Conditions Section */}
        <section className="border-t border-gray-100 pt-4 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Environmental Conditions</h2>

          {weather || tides ? (
            <div className="flex flex-col gap-4">
              {/* Weather Stats Card */}
              {weather && (
                <div className="bg-gray-50 border border-gray-150 rounded-xl p-3.5 flex flex-col justify-between text-xs text-gray-650 space-y-2">
                  <div className="flex items-center justify-between border-b border-gray-200 pb-1.5 mb-1">
                    <span className="font-semibold text-gray-800">Flight Weather</span>
                    <span className="text-[10px] text-gray-400 font-mono">Open-Meteo</span>
                  </div>
                  <div className="grid grid-cols-2 gap-y-4 gap-x-4 pt-1">
                    <div className="flex items-center gap-2">
                      <Thermometer className="w-5 h-5 text-orange-500 flex-shrink-0" />
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase font-semibold text-gray-450">Temperature</span>
                        <span className="font-medium text-gray-700">
                          {Math.round((weather.temperature * 9) / 5 + 32)}°F ({Math.round(weather.temperature)}°C)
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Cloud className="w-5 h-5 text-blue-450 flex-shrink-0" />
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase font-semibold text-gray-450">Cloud Cover</span>
                        <span className="font-medium text-gray-700">{weather.cloudCover}% Cover</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Wind className="w-5 h-5 text-teal-500 flex-shrink-0" />
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase font-semibold text-gray-450">Wind Speed</span>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-gray-700">
                            {Math.round(weather.windSpeed * 0.621371)} mph
                          </span>
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-550 font-mono bg-gray-200/50 px-1 rounded">
                            <Compass
                              className="w-3 h-3 text-gray-400 transition-transform"
                              style={{ transform: `rotate(${weather.windDirection}deg)` }}
                            />
                            {weather.windDirection}°
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Droplet className="w-5 h-5 text-blue-500 flex-shrink-0" />
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase font-semibold text-gray-455">Precipitation</span>
                        <span className="font-medium text-gray-700">{weather.precipitation} mm/hr</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Tide Stats & Graph Card */}
              {tides && tideSvg && (
                <div className="bg-gray-50 border border-gray-150 rounded-xl p-3.5 flex flex-col justify-between text-xs text-gray-650 space-y-2">
                  <div className="flex items-center justify-between border-b border-gray-200 pb-1.5 mb-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <Waves className="w-4 h-4 text-blue-500 flex-shrink-0" />
                      <span
                        className="font-semibold text-gray-800 truncate"
                        title={tides.stationName}
                      >
                        Tide: {tides.stationName}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] text-gray-400 font-mono">NOAA</span>
                    </div>
                  </div>

                  <div className="flex items-baseline justify-between">
                    <div className="flex flex-col">
                      <span className="text-xl font-bold text-gray-800">
                        {tideSvg.closestValue.toFixed(1)} ft
                      </span>
                      <span className="text-[10px] text-gray-455 uppercase font-semibold">
                        Height Relative to MLLW
                      </span>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${tideSvg.isRising
                          ? 'bg-blue-50 text-blue-700 border border-blue-100'
                          : 'bg-indigo-50 text-indigo-700 border border-indigo-100'
                        }`}
                    >
                      {tideSvg.isRising ? 'Rising (Flood)' : 'Falling (Ebb)'}
                    </span>
                  </div>

                  {/* SVG Tide Curve graph */}
                  <div className="relative pt-2">
                    <svg viewBox="0 0 400 100" className="w-full h-24 overflow-visible">
                      <defs>
                        <linearGradient id="tide-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
                          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.15" />
                          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.01" />
                        </linearGradient>
                      </defs>

                      {/* Mean Lower Low Water reference line (0.0 ft) */}
                      {tideSvg.minVal < 0 && tideSvg.maxVal > 0 && (
                        <line
                          x1="0"
                          y1={tideSvg.scaleY0}
                          x2="400"
                          y2={tideSvg.scaleY0}
                          stroke="#cbd5e1"
                          strokeDasharray="2,2"
                          strokeWidth="1"
                        />
                      )}

                      {/* Wave Fill Area */}
                      <path d={tideSvg.fillD} fill="url(#tide-gradient)" />

                      {/* Wave Curve */}
                      <path
                        d={tideSvg.pathD}
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />

                      {/* Highs and Lows Labels */}
                      {tideSvg.highsLows.map((hl, idx) => (
                        <g key={idx}>
                          <circle cx={hl.x} cy={hl.y} r="3.5" fill={hl.type === 'high' ? '#3b82f6' : '#64748b'} />
                          <text
                            x={hl.x}
                            y={hl.type === 'high' ? hl.y - 10 : hl.y + 16}
                            textAnchor="middle"
                            fontSize="12"
                            fontWeight="700"
                            fill={hl.type === 'high' ? '#1d4ed8' : '#334155'}
                            className="select-none font-sans"
                          >
                            {hl.type === 'high' ? 'High' : 'Low'}: {hl.val.toFixed(1)}ft
                          </text>
                        </g>
                      ))}

                      {/* Flight Time Indicator Marker (No pulse animation) */}
                      <circle
                        cx={tideSvg.dotX}
                        cy={tideSvg.dotY}
                        r="5"
                        fill="#ef4444"
                        stroke="#ffffff"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-3.5 bg-amber-50/40 border border-dashed border-amber-200 dark:border-amber-900/30 dark:bg-amber-950/10 rounded-xl text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Environmental Data Unavailable</p>
                <p className="text-amber-700/80 dark:text-amber-400/80 mt-0.5 leading-relaxed">
                  To load local weather conditions and NOAA tide predictions, please set a geographic boundary/point on the parent <strong>Flight Route</strong>, or upload flight images containing embedded GPS metadata.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* File list */}
        <section className="border-t border-gray-100 pt-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1">All Flight Files</h2>
          {fileSyncActive && (
            <div className="flex items-center gap-2 text-xs text-blue-600 mb-2 animate-pulse">
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>{fileCount} files synced — more arriving…</span>
            </div>
          )}
          {!fileSyncActive && (
            <p className="text-xs text-gray-400 mb-3">{displayObjects.length} files</p>
          )}
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <FileLightbox
              files={displayObjects}
              timezone={project.timezone}
              canWrite={canWrite}
              onImageClick={(file) => {
                setActiveTab('images')
                const match = displayObjects.find((o) => o.key === file.key)
                if (match) setActiveImage(match)
              }}
            />
          </div>
        </section>
      </aside>

      {/* ─── Drag Resizer Handle ─── */}
      <div
        className="w-1 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors h-full flex-shrink-0 z-20"
        onMouseDown={startResizing}
      />

      {/* ─── Right Panel ─── */}
      <main className="flex-1 h-full bg-gray-50 flex flex-col overflow-hidden">
        {/* Tab Headers */}
        <div className="relative flex items-center justify-between px-6 bg-white border-b border-gray-200 h-12 flex-shrink-0 z-25">
          <div className="flex gap-4 h-full">
            <button
              onClick={() => setActiveTab('map')}
              className={cn(
                'flex items-center gap-1.5 px-1 h-full text-sm font-medium border-b-2 transition-colors',
                activeTab === 'map'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              )}
            >
              <MapIcon className="w-4 h-4" />
              Flight Map
            </button>
            <button
              onClick={() => setActiveTab('images')}
              className={cn(
                'flex items-center gap-1.5 px-1 h-full text-sm font-medium border-b-2 transition-colors',
                activeTab === 'images'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              )}
            >
              <ImageIcon className="w-4 h-4" />
              Flight Files ({images.length})
            </button>
          </div>

          {/* Centered Flight Plan Name */}
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center pointer-events-none select-none">
            <span className="font-semibold text-gray-800 text-sm tracking-wide bg-gray-50 border border-gray-200 px-3.5 py-1 rounded-full shadow-2xs">
              {flightPlan.displayName || flightPlan.name}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {activeTab === 'map' && (
              <>
                <button
                  onClick={() => setZoomTrigger((prev) => prev + 1)}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    "gap-1.5 text-xs h-8"
                  )}
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                  <span>Zoom to Flight</span>
                </button>
                <button
                  onClick={() => setIsFullscreenMap(true)}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    "gap-1.5 text-xs h-8"
                  )}
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                  <span>Full Screen</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Tab Contents */}
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {/* Map Tab */}
          {activeTab === 'map' && (
            <div className={cn(
              "relative",
              isFullscreenMap
                ? "fixed inset-0 z-50 bg-gray-950"
                : "w-full h-full"
            )}>
              {isFullscreenMap && (
                <div className="absolute top-[10px] right-[52px] z-[60] flex items-center gap-2">
                  <button
                    onClick={() => setZoomTrigger((prev) => prev + 1)}
                    className="px-3 py-2 bg-black/60 hover:bg-black/80 backdrop-blur-sm border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-white rounded-lg shadow-lg transition-all text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    Zoom to Flight
                  </button>
                  <button
                    onClick={() => setIsFullscreenMap(false)}
                    className="px-3 py-2 bg-black/60 hover:bg-black/80 backdrop-blur-sm border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-white rounded-lg shadow-lg transition-all text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                    title="Exit Full Screen (Escape)"
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                    Exit Full Screen
                  </button>
                </div>
              )}
              <OrthoMap
                outputKey={geotiffKey}
                cacheBuster={cacheBuster}
                photos={images.map((img) => ({
                  key: img.key,
                  name: img.key.split('/').pop() || img.key,
                  latitude: img.latitude ?? null,
                  longitude: img.longitude ?? null,
                  etag: img.etag,
                  size: img.size,
                }))}
                onSelectPhoto={(key) => {
                  const found = images.find((img) => img.key === key)
                  if (found) {
                    setLightboxImage(found)
                  }
                }}
                fitBoundsTrigger={zoomTrigger}
                className="h-full w-full rounded-none border-none"
                editable={canWrite}
                flightPlanId={flightPlanId}
                initialLocation={flightPlan.location}
                onSaveLocation={async (locationJson) => {
                  await updateFlightPlanLocation(flightPlanId, locationJson)
                }}
                annotations={annotations}
                onAddAnnotation={async (anno) => {
                  // Optimistically add a temp annotation immediately so the
                  // marker appears on the map without waiting for the server.
                  const tempId = `__optimistic__${Date.now()}`
                  const tempAnno = {
                    id: tempId,
                    shape: anno.shape,
                    geometry: anno.geometry,
                    fishCount: anno.fishCount,
                    confidence: anno.confidence,
                    label: null,
                  }
                  setAnnotations((prev) => [...prev, tempAnno])

                  try {
                    const res = await fetch(`/api/projects/${projectId}/flight-plans/${flightPlanId}/flights/${flightId}/annotations`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(anno),
                    })
                    if (res.ok) {
                      const newAnno = await res.json()
                      // Swap the temp entry for the real one from the server
                      setAnnotations((prev) => prev.map((a) => (a.id === tempId ? newAnno : a)))
                    } else {
                      // Server rejected — roll back
                      setAnnotations((prev) => prev.filter((a) => a.id !== tempId))
                      console.error('Failed to save annotation: server returned', res.status)
                    }
                  } catch (err) {
                    // Network error — roll back
                    setAnnotations((prev) => prev.filter((a) => a.id !== tempId))
                    console.error('Failed to save annotation:', err)
                  }
                }}
                onUpdateAnnotation={async (id, updates) => {
                  try {
                    const res = await fetch(`/api/projects/${projectId}/flight-plans/${flightPlanId}/flights/${flightId}/annotations`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ id, ...updates }),
                    })
                    if (res.ok) {
                      const updatedAnno = await res.json()
                      setAnnotations((prev) => prev.map((a) => (a.id === id ? updatedAnno : a)))
                    }
                  } catch (err) {
                    console.error('Failed to update annotation:', err)
                  }
                }}
                onDeleteAnnotation={async (id) => {
                  // Optimistically remove immediately
                  setAnnotations((prev) => {
                    const removed = prev.find((a) => a.id === id)
                      ; (async () => {
                        try {
                          const res = await fetch(`/api/projects/${projectId}/flight-plans/${flightPlanId}/flights/${flightId}/annotations?id=${encodeURIComponent(id)}`, {
                            method: 'DELETE',
                          })
                          if (!res.ok) {
                            // Roll back — re-insert the removed annotation
                            if (removed) setAnnotations((p) => [...p, removed])
                            console.error('Failed to delete annotation: server returned', res.status)
                          }
                        } catch (err) {
                          if (removed) setAnnotations((p) => [...p, removed])
                          console.error('Failed to delete annotation:', err)
                        }
                      })()
                    return prev.filter((a) => a.id !== id)
                  })
                }}
              />
            </div>
          )}

          {/* Images Tab */}
          {activeTab === 'images' && (
            <div className="w-full h-full flex flex-col overflow-hidden">
              {images.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-400 p-8">
                  <span className="text-4xl mb-2">📸</span>
                  <p className="text-sm font-medium">No files uploaded to S3 yet.</p>
                </div>
              ) : (
                <>
                  {/* Large Viewport Area */}
                  {activeImage && (
                    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-gray-950">
                      {/* Combined Metadata & Actions Header */}
                      <div className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-gray-300 flex-shrink-0">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          <span className="text-xs font-mono font-medium text-white truncate max-w-[240px]" title={activeImage.key.split('/').pop()}>
                            {activeImage.key.split('/').pop()}
                          </span>
                          <span className="text-[11px] text-gray-500 font-mono">{formatBytes(activeImage.size)}</span>
                          {activeImageDownloadUrl && (
                            <a
                              href={activeImageDownloadUrl}
                              className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium transition-colors"
                            >
                              <DownloadIcon className="w-3.5 h-3.5" /> Download
                            </a>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400">Dataset Split:</span>
                            {canWrite ? (
                              <select
                                value={activeSplit}
                                onChange={(e) => handleSplitChange(e.target.value)}
                                className={cn(
                                  'text-xs rounded border px-3 py-1 font-medium focus:outline-none focus:ring-1 cursor-pointer transition-colors',
                                  SPLIT_SELECT_CLASSES[activeSplit]
                                )}
                              >
                                <option value="none">Unassigned</option>
                                <option value="train">Train</option>
                                <option value="val">Validation</option>
                                <option value="test">Testing</option>
                              </select>
                            ) : (
                              <span
                                className={cn(
                                  'inline-flex items-center rounded px-2.5 py-0.5 text-xs font-semibold capitalize',
                                  activeSplit === 'train' && 'bg-blue-900/30 text-blue-300',
                                  activeSplit === 'val' && 'bg-amber-900/30 text-amber-300',
                                  activeSplit === 'test' && 'bg-green-900/30 text-green-300',
                                  activeSplit === 'none' && 'bg-gray-800 text-gray-500'
                                )}
                              >
                                {activeSplit === 'none' ? 'unassigned' : activeSplit}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-gray-500 font-mono">
                            Modified: {new Date(activeImage.lastModifiedIso).toLocaleString()}
                          </p>
                        </div>
                      </div>

                      {/* Interactive Viewport (Takes up full area) */}
                      <div className="flex-1 min-h-0 flex items-center justify-center relative bg-gray-950">
                        {isVideo(activeImage.key) ? (
                          <div className="w-full h-full">
                            <VideoPlayer
                              videoUrl={activeImageDownloadUrl}
                              filename={activeImage.key.split('/').pop() || ''}
                              fishCount={getVideoFishCount(activeImage.id)}
                              canWrite={canWrite}
                              onIncrement={() => handleVideoIncrement(activeImage.id)}
                              onDecrement={() => handleVideoDecrement(activeImage.id)}
                              notes={getVideoNotes(activeImage.id)}
                              onAddNote={(note) => handleAddNote(activeImage.id, note)}
                              onDeleteNote={handleDeleteNote}
                              onExpand={() => setIsFullscreenPlayer(true)}
                            />
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => setIsFullscreenPlayer(true)}
                              className="absolute right-4 bottom-4 z-10 p-2 bg-black/60 hover:bg-black/80 backdrop-blur-xs border border-gray-800 hover:border-gray-700 text-gray-300 hover:text-white rounded-lg shadow-lg transition-all hover:scale-105 cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
                              title="Expand Viewport"
                            >
                              <Maximize2 className="w-3.5 h-3.5" />
                              <span>Expand</span>
                            </button>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              key={activeImage.key}
                              ref={handleImageRef}
                              src={thumbnailUrl(activeImage.key, activeImage.etag, 1200)}
                              alt={activeImage.key.split('/').pop()}
                              onLoad={() => setLoadedKeys((prev) => ({ ...prev, [activeImage.key]: true }))}
                              className={cn(
                                "max-w-full max-h-full object-contain shadow-2xl rounded transition-opacity duration-200",
                                activeImageLoading ? "opacity-0" : "opacity-100"
                              )}
                            />
                            {activeImageLoading && (
                              <div className="absolute inset-0 flex items-center justify-center bg-gray-950/50 backdrop-blur-xs">
                                <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Bottom Filmstrip Selector */}
                  <div className="h-40 border-t border-gray-200 bg-white flex-shrink-0 flex flex-col min-h-0">
                    <div className="flex-1 flex gap-3 overflow-x-auto p-3">
                      {images.map((img) => {
                        const isSelected = activeImage?.key === img.key
                        const filename = img.key.split('/').pop() ?? img.key

                        // Only load thumbnails in production environment to keep dev fast
                        const isProd = process.env.NODE_ENV === 'production'

                        return (
                          <button
                            key={img.key}
                            onClick={() => setActiveImage(img)}
                            className={cn(
                              'w-36 flex-shrink-0 text-left rounded-lg overflow-hidden border p-1 transition-all flex flex-col justify-between h-full',
                              isSelected
                                ? 'border-blue-500 bg-blue-50/20 ring-1 ring-blue-500'
                                : 'border-gray-200 hover:border-gray-300'
                            )}
                          >
                            <div className="w-full flex-1 min-h-0 bg-gray-100 overflow-hidden rounded mb-1 relative">
                              {isVideo(img.key) ? (
                                <div className="w-full h-full bg-slate-900 flex flex-col items-center justify-center text-slate-400 text-xs">
                                  <span className="text-2xl mb-1">🎥</span>
                                  <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Video</span>
                                </div>
                              ) : isProd ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                  src={thumbnailUrl(img.key, img.etag, 320)}
                                  alt=""
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="w-full h-full bg-blue-50 flex flex-col items-center justify-center text-blue-500 text-xs">
                                  <span className="text-xl mb-1">📸</span>
                                  <span className="text-[9px] font-semibold uppercase tracking-wider text-blue-400">Image</span>
                                </div>
                              )}
                            </div>
                            <span className="text-[9px] font-mono text-gray-500 truncate w-full block text-center select-none">
                              {filename}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </main>
      {isModalOpen && (() => {
        let defaultAltitudeOffset = 0
        if (tides && tides.predictions && tides.predictions.length > 0) {
          const flightTime = new Date(flight.timestamp).getTime()
          const targetTime = flightTime - 2 * 60 * 60 * 1000

          let closestPrediction = tides.predictions[0]
          let minDiff = Infinity
          tides.predictions.forEach((p) => {
            const diff = Math.abs(new Date(p.time).getTime() - targetTime)
            if (diff < minDiff) {
              minDiff = diff
              closestPrediction = p
            }
          })

          const tideHeightInFt = closestPrediction.value
          const rawOffset = (36 - tideHeightInFt) / 3.28
          defaultAltitudeOffset = Math.round(rawOffset * 2) / 2
        }

        return (
          <ProcessingModal
            isOpen={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            flightId={flightId}
            projectId={projectId}
            flightPlanId={flightPlanId}
            defaultAltitudeOffset={defaultAltitudeOffset}
            initialActiveTask={
              activeTask
                ? {
                  taskId: activeTask.id,
                  type: activeTask.type,
                  status: activeTask.status,
                  odmUuid: activeTask.type === 'odm' ? (activeTask as any).odmUuid : null,
                  outputKey: activeTask.outputKey,
                  reportKey: activeTask.type === 'odm' ? (activeTask as any).reportKey : null,
                  error: (activeTask as any).error ?? null,
                  totalImages: activeTask.totalImages,
                  processed: activeTask.processed,
                  progress: activeTask.progress,
                }
                : latestTask
                  ? {
                    taskId: latestTask.id,
                    type: latestTask.type,
                    status: latestTask.status,
                    odmUuid: latestTask.type === 'odm' ? (latestTask as any).odmUuid : null,
                    outputKey: latestTask.outputKey,
                    reportKey: latestTask.type === 'odm' ? (latestTask as any).reportKey : null,
                    error: (latestTask as any).error ?? null,
                    totalImages: latestTask.totalImages,
                    processed: latestTask.processed,
                    progress: latestTask.progress,
                  }
                  : null
            }
          />
        )
      })()}


      {/* Lightbox modal for displaying a single flight image */}
      {lightboxImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-xs p-4">
          <div className="absolute inset-0" onClick={() => setLightboxImage(null)} />
          <div className="relative bg-gray-950 border border-gray-800 rounded-2xl overflow-hidden max-w-5xl w-full max-h-[90vh] flex flex-col shadow-2xl z-10">
            {/* Header */}
            <div className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between text-gray-200">
              <div className="min-w-0 flex items-center gap-3">
                <h3 className="text-sm font-mono font-medium truncate">
                  {lightboxImage.key.split('/').pop()}
                </h3>
                <span className="text-xs text-gray-500 font-mono">{formatBytes(lightboxImage.size)}</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-400 mr-2">
                {/* Zoom Controls */}
                <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700">
                  <button
                    onClick={() => {
                      setZoomScale(prev => Math.max(1, prev - 0.5))
                      if (zoomScale <= 1.5) setPanOffset({ x: 0, y: 0 })
                    }}
                    disabled={zoomScale <= 1}
                    className="p-1 hover:bg-gray-700 rounded text-gray-300 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer"
                    title="Zoom Out"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <span className="px-2 font-mono text-[10px] text-gray-300 min-w-[45px] text-center select-none">
                    {Math.round(zoomScale * 100)}%
                  </span>
                  <button
                    onClick={() => setZoomScale(prev => Math.min(5, prev + 0.5))}
                    disabled={zoomScale >= 5}
                    className="p-1 hover:bg-gray-700 rounded text-gray-300 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer"
                    title="Zoom In"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                  {zoomScale > 1 && (
                    <button
                      onClick={() => {
                        setZoomScale(1)
                        setPanOffset({ x: 0, y: 0 })
                      }}
                      className="px-1.5 py-0.5 hover:bg-gray-700 rounded text-[9px] font-bold text-blue-400 hover:text-blue-300 cursor-pointer"
                    >
                      RESET
                    </button>
                  )}
                </div>

                {/* Full Res Toggle Button */}
                {!lightboxFullResUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isFullResLoading}
                    onClick={async (e) => {
                      e.preventDefault()
                      setIsFullResLoading(true)
                      try {
                        const res = await fetch(`/api/files/presign?key=${encodeURIComponent(lightboxImage.key)}`)
                        if (res.ok) {
                          const { url } = await res.json()
                          setIsFullResImageLoading(true)
                          setLightboxFullResUrl(url)
                        }
                      } catch (err) {
                        console.error('Failed to load full res image:', err)
                      } finally {
                        setIsFullResLoading(false)
                      }
                    }}
                    className={cn(
                      "text-blue-400 hover:text-blue-300 border-blue-900/50 hover:border-blue-800 bg-blue-950/30 hover:bg-blue-950/50 flex items-center gap-1.5 font-semibold h-7 text-[11px] rounded-lg transition-colors cursor-pointer disabled:opacity-50",
                      (zoomScale > 1 && !lightboxFullResUrl) ? "animate-pulse ring-2 ring-blue-500/50 border-blue-500 bg-blue-950/75" : ""
                    )}
                  >
                    {isFullResLoading ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin" /> Loading...
                      </>
                    ) : (
                      <>
                        <Maximize2 className="w-3 h-3" /> Load Full Res
                      </>
                    )}
                  </Button>
                ) : (
                  <span className="text-green-400 font-semibold flex items-center gap-1 bg-green-950/30 border border-green-900/50 px-2.5 h-7 rounded-lg text-[11px]">
                    ✓ Full Res Loaded
                  </span>
                )}

                <button
                  onClick={async (e) => {
                    e.preventDefault()
                    await openPresignedUrl(lightboxImage.key, true)
                  }}
                  className="text-gray-300 hover:text-white flex items-center gap-1 font-medium transition-colors cursor-pointer"
                >
                  <DownloadIcon className="w-3.5 h-3.5" /> Download
                </button>
                <button
                  onClick={() => setLightboxImage(null)}
                  className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {/* Viewport */}
            <div
              ref={viewportRef}
              className={cn(
                "flex-1 min-h-0 flex items-center justify-center p-6 bg-gray-950 relative select-none overflow-hidden",
                zoomScale > 1 ? "cursor-grab active:cursor-grabbing" : ""
              )}
              onMouseDown={(e) => {
                if (zoomScale <= 1) return
                e.preventDefault()
                setIsDragging(true)
                dragStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y }
              }}
              onMouseMove={(e) => {
                if (!isDragging || zoomScale <= 1) return
                e.preventDefault()
                const newX = e.clientX - dragStartRef.current.x
                const newY = e.clientY - dragStartRef.current.y

                // Bound panning to prevent dragging completely out of view
                const maxPanX = (zoomScale - 1) * 400
                const maxPanY = (zoomScale - 1) * 300
                setPanOffset({
                  x: Math.max(-maxPanX, Math.min(maxPanX, newX)),
                  y: Math.max(-maxPanY, Math.min(maxPanY, newY))
                })
              }}
              onMouseUp={() => setIsDragging(false)}
              onMouseLeave={() => setIsDragging(false)}
              onDoubleClick={() => {
                setZoomScale(1)
                setPanOffset({ x: 0, y: 0 })
              }}
            >
              <div
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`,
                  transition: isDragging ? 'none' : 'transform 0.15s ease-out',
                }}
                className="max-w-full max-h-[70vh] flex items-center justify-center"
              >
                <img
                  src={lightboxFullResUrl || thumbnailUrl(lightboxImage.key, lightboxImage.etag, 1200)}
                  alt={lightboxImage.key.split('/').pop()}
                  onLoad={() => setIsFullResImageLoading(false)}
                  className={cn(
                    "max-w-full max-h-[70vh] object-contain rounded pointer-events-none transition-opacity duration-200",
                    isFullResImageLoading ? "opacity-40" : "opacity-100"
                  )}
                />
              </div>
              {isFullResImageLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/45 backdrop-blur-xs pointer-events-none">
                  <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
                </div>
              )}
              {zoomScale > 1 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-xs px-3 py-1.5 rounded-full text-[10px] text-gray-300 font-medium pointer-events-none select-none">
                  Drag to pan • Scroll or use buttons to zoom
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isFullscreenPlayer && activeImage && (
        <div className="fixed inset-0 z-50 bg-gray-950 flex flex-col animate-fade-in select-none">
          {/* Header */}
          <div className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between text-gray-300 flex-shrink-0 z-10">
            <div className="flex items-center gap-3">
              <span className="text-sm font-mono font-medium text-white truncate max-w-[300px] sm:max-w-[400px]">
                {activeImage.key.split('/').pop()}
              </span>
              <span className="text-xs text-gray-500 font-mono">{formatBytes(activeImage.size)}</span>
            </div>
            <div className="flex items-center gap-4">
              {activeImageDownloadUrl && (
                <a
                  href={activeImageDownloadUrl}
                  className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium transition-colors"
                >
                  <DownloadIcon className="w-3.5 h-3.5" /> Download
                </a>
              )}
              <button
                onClick={() => setIsFullscreenPlayer(false)}
                className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors cursor-pointer flex items-center gap-1 text-xs font-semibold"
              >
                <Minimize2 className="w-4 h-4" /> Exit Full Viewport
              </button>
            </div>
          </div>

          {/* Viewport */}
          <div className="flex-1 min-h-0 flex items-center justify-center relative bg-gray-950 p-6">
            {images.length > 1 && (
              <button
                onClick={handlePrevImage}
                className="absolute left-6 z-20 p-2.5 bg-black/60 hover:bg-black/80 backdrop-blur-xs border border-gray-800 hover:border-gray-700 text-gray-300 hover:text-white rounded-full shadow-lg transition-all hover:scale-105 cursor-pointer"
                title="Previous File (Left Arrow)"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}

            {isVideo(activeImage.key) ? (
              <div className="w-full h-full max-w-7xl max-h-[85vh] flex items-center justify-center">
                <VideoPlayer
                  videoUrl={activeImageDownloadUrl}
                  filename={activeImage.key.split('/').pop() || ''}
                  fishCount={getVideoFishCount(activeImage.id)}
                  canWrite={canWrite}
                  onIncrement={() => handleVideoIncrement(activeImage.id)}
                  onDecrement={() => handleVideoDecrement(activeImage.id)}
                  notes={getVideoNotes(activeImage.id)}
                  onAddNote={(note) => handleAddNote(activeImage.id, note)}
                  onDeleteNote={handleDeleteNote}
                />
              </div>
            ) : (
              <>
                <img
                  key={activeImage.key}
                  ref={handleImageRef}
                  src={thumbnailUrl(activeImage.key, activeImage.etag, 1200)}
                  alt={activeImage.key.split('/').pop()}
                  onLoad={() => setLoadedKeys((prev) => ({ ...prev, [activeImage.key]: true }))}
                  className={cn(
                    "max-w-full max-h-full object-contain shadow-2xl rounded transition-opacity duration-200",
                    activeImageLoading ? "opacity-0" : "opacity-100"
                  )}
                />
                {activeImageLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-950/50 backdrop-blur-xs">
                    <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
                  </div>
                )}
              </>
            )}

            {images.length > 1 && (
              <button
                onClick={handleNextImage}
                className="absolute right-6 z-20 p-2.5 bg-black/60 hover:bg-black/80 backdrop-blur-xs border border-gray-800 hover:border-gray-700 text-gray-300 hover:text-white rounded-full shadow-lg transition-all hover:scale-105 cursor-pointer"
                title="Next File (Right Arrow)"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
