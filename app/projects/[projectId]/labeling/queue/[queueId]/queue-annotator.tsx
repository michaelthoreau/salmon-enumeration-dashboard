'use client'

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { History, X, ChevronDown, Check, Circle, List, MoreHorizontal, Brain, Loader2, Sparkles, Fish, Zap, ZoomIn, ZoomOut } from 'lucide-react'
import { saveTaskPoints, setTaskComplete } from '@/app/actions/labeling-tasks'
import type { SurveyType } from '@/lib/schema'

interface Point {
  id: string
  x: number
  y: number
}

interface PredictedPoint {
  x: number
  y: number
  crop_x: number
  crop_y: number
  score: number
}

interface Task {
  id: string
  fileId: string
  fileKey: string
  x1: number
  y1: number
  x2: number
  y2: number
  frame: number
  completedBy: string | null
  flightPlanName: string
  surveyType: SurveyType
}

interface QueueTaskItem {
  id: string
  fileKey: string
  x1: number
  y1: number
  x2: number
  y2: number
  frame: number
  completedBy: string | null
  completedByEmail?: string | null
  pointCount: number
}

interface Props {
  projectId: string
  queueId: string
  queueName: string
  task: Task
  initialPoints: { id: string; x: number; y: number }[]
  canWrite: boolean
  positionInQueue: number
  totalInQueue: number
  completeCount: number
  prevTaskId: string | null
  nextTaskId: string | null
  queueTasks?: QueueTaskItem[]
}

const POINT_RADIUS = 4
const HIT_RADIUS = 8
// Fallback display cap for image tiles, used only for the first paint before the
// container has been measured.
const IMAGE_MAX_DISPLAY = 800
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv'])

const MIN_ZOOM = 0.25
const MAX_ZOOM = 16
const ZOOM_STEP = 1.25

// Display scale (CSS px per source pixel) an image task is shown at by default.
// A fish should end up the same number of screen pixels across whether its crop
// came off a river (migration) flight or a spawning-ground flight, so the default
// is native resolution — 1 source pixel per CSS pixel — rather than "shrink the
// whole crop until it fits", which used to make big spawning photos 5-6× smaller
// than river imagery. If one platform's imagery turns out to be flown at a
// different ground sample distance than the river imagery, scale it here: a value
// of 2 shows that survey type's pixels at double size.
const DEFAULT_IMAGE_SCALE: Record<SurveyType, number> = {
  migration: 1,
  spawning: 1,
}

function isVideoKey(key: string) {
  return VIDEO_EXTS.has(key.split('.').pop()?.toLowerCase() ?? '')
}

function queueTaskUrl(projectId: string, queueId: string, taskId: string) {
  return `/projects/${projectId}/labeling/queue/${queueId}?task=${taskId}`
}

export default function QueueAnnotator({
  projectId,
  queueId,
  queueName,
  task,
  initialPoints,
  canWrite,
  positionInQueue,
  totalInQueue,
  completeCount,
  prevTaskId,
  nextTaskId,
  queueTasks = [],
}: Props) {
  const router = useRouter()
  const isVideo = isVideoKey(task.fileKey)

  // ── Task selector state ──────────────────────────────────────────────
  const [showTaskSelector, setShowTaskSelector] = useState(false)
  const [filterTab, setFilterTab] = useState<'all' | 'completed' | 'incomplete'>('all')
  const selectorRef = useRef<HTMLDivElement>(null)

  // Click outside to close selector
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setShowTaskSelector(false)
      }
    }
    if (showTaskSelector) {
      document.addEventListener('mousedown', handleOutsideClick)
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [showTaskSelector])

  const [showActionsMenu, setShowActionsMenu] = useState(false)
  const actionsMenuRef = useRef<HTMLDivElement>(null)

  // Click outside to close actions menu
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setShowActionsMenu(false)
      }
    }
    if (showActionsMenu) {
      document.addEventListener('mousedown', handleOutsideClick)
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [showActionsMenu])

  // ── Instructions modal ───────────────────────────────────────────────
  const storageKey = `labeling-instructions-seen-${queueId}`
  const [showInstructions, setShowInstructions] = useState(false)
  useEffect(() => {
    if (typeof window !== 'undefined' && !localStorage.getItem(storageKey)) {
      setShowInstructions(true)
    }
  }, [storageKey])
  const dismissInstructions = () => {
    localStorage.setItem(storageKey, '1')
    setShowInstructions(false)
  }

  // ── Annotation state ──────────────────────────────────────────────────────
  const [points, setPoints] = useState<Point[]>(() => initialPoints.map(p => ({ ...p })))
  const [complete, setComplete] = useState(!!task.completedBy)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState<'crosshair' | 'grabbing'>('crosshair')
  const dragRef = useRef<{ id: string } | null>(null)
  const didDragRef = useRef(false)

  // ── Prediction state ──────────────────────────────────────────────────────
  const [scoreThresh, setScoreThresh] = useState<number>(0.4)
  const [minDist, setMinDist] = useState<number>(50)
  const [predicting, setPredicting] = useState<boolean>(false)
  const [predictError, setPredictError] = useState<string | null>(null)
  const [rawPredictions, setRawPredictions] = useState<PredictedPoint[]>([])
  const [isPreviewing, setIsPreviewing] = useState<boolean>(false)
  const [showClearConfirm, setShowClearConfirm] = useState<boolean>(false)
  const [originalPointsBeforePredict, setOriginalPointsBeforePredict] = useState<Point[]>([])
  const [copiedError, setCopiedError] = useState<boolean>(false)
  const [showSlowPredictionWarning, setShowSlowPredictionWarning] = useState<boolean>(false)

  const filteredPredictions = useMemo(() => {
    // 1. Filter by confidence score
    const thresholded = rawPredictions.filter(p => p.score >= scoreThresh)
    
    // 2. Sort by confidence score descending
    const sorted = [...thresholded].sort((a, b) => b.score - a.score)
    
    // 3. Perform NMS based on minimum Euclidean distance
    const accepted: PredictedPoint[] = []
    
    for (const p of sorted) {
      const px = isVideo ? p.x : p.crop_x
      const py = isVideo ? p.y : p.crop_y
      
      let tooClose = false
      for (const acc of accepted) {
        const accX = isVideo ? acc.x : acc.crop_x
        const accY = isVideo ? acc.y : acc.crop_y
        const dist = Math.sqrt((px - accX) ** 2 + (py - accY) ** 2)
        if (dist < minDist) {
          tooClose = true
          break
        }
      }
      
      if (!tooClose) {
        accepted.push(p)
      }
    }
    
    return accepted
  }, [rawPredictions, scoreThresh, minDist, isVideo])

  // ── Image state ───────────────────────────────────────────────────────────
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageError, setImageError] = useState(false)

  // ── Video state ───────────────────────────────────────────────────────────
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoError, setVideoError] = useState(false)
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null)
  const [frameReady, setFrameReady] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps] = useState(29.97)
  const videoRef = useRef<HTMLVideoElement>(null)
  const returnTimeRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)

  // ── Container size (for filling the window) ───────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const e = entries[0]
      if (e) setContainerSize({ w: e.contentRect.width, h: e.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Zoom / pan state ──────────────────────────────────────────────────────
  //
  // The media wrapper is laid out centred at its unzoomed size (mw × mh) and then
  // transformed with `translate(-50%,-50%) translate(pan) scale(zoom)` about its
  // top-left corner, so a point p in wrapper-local CSS px lands on screen at
  //     screen = containerCentre - (mw/2, mh/2) + pan + p * zoom
  // Keeping the origin at the top-left (rather than moving it around) means a
  // zoom that holds some anchor point still is just a pan adjustment:
  //     pan' = pan + anchor * (zoom - zoom')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const isPanningRef = useRef(false)
  const didPanRef = useRef(false)
  const panStartRef = useRef({ mx: 0, my: 0, px: 0, py: 0 })
  // The centred media + overlay element — the thing the zoom transform is on
  const mediaWrapperRef = useRef<HTMLDivElement>(null)

  const resetZoom = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // Reset zoom when task changes
  useEffect(() => { resetZoom() }, [task.id, resetZoom])

  /** Zoom to `next`, holding the wrapper-local point `anchor` still on screen. */
  const zoomTo = useCallback((next: number, anchor: { x: number; y: number }) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next))
    if (clamped === zoom) return
    const delta = zoom - clamped
    setPan(p => ({ x: p.x + anchor.x * delta, y: p.y + anchor.y * delta }))
    setZoom(clamped)
  }, [zoom])

  /** Zoom by a step, holding the centre of the viewport still. */
  const zoomByStep = useCallback((factor: number) => {
    const el = containerRef.current
    const wrapper = mediaWrapperRef.current
    if (!el || !wrapper) return
    const elRect = el.getBoundingClientRect()
    const wrapRect = wrapper.getBoundingClientRect()
    // Viewport centre expressed in wrapper-local (unzoomed) coordinates
    const anchor = {
      x: (elRect.left + elRect.width / 2 - wrapRect.left) / zoom,
      y: (elRect.top + elRect.height / 2 - wrapRect.top) / zoom,
    }
    zoomTo(zoom * factor, anchor)
  }, [zoom, zoomTo])

  // Wheel to zoom around the mouse
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const wrapper = mediaWrapperRef.current
      if (!wrapper) return
      // getBoundingClientRect is the *transformed* rect, so dividing by the
      // current zoom recovers untransformed local coordinates.
      const rect = wrapper.getBoundingClientRect()
      const delta = e.deltaY < 0 ? 1.08 : 1 / 1.08
      zoomTo(zoom * delta, {
        x: (e.clientX - rect.left) / zoom,
        y: (e.clientY - rect.top) / zoom,
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom, zoomTo])

  // Pan via drag
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isPanningRef.current) return
      const dx = e.clientX - panStartRef.current.mx
      const dy = e.clientY - panStartRef.current.my
      if (Math.hypot(dx, dy) > 3) didPanRef.current = true
      setPan({
        x: panStartRef.current.px + dx,
        y: panStartRef.current.py + dy,
      })
    }
    const onMouseUp = () => { isPanningRef.current = false }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const beginPan = useCallback((e: React.MouseEvent) => {
    isPanningRef.current = true
    didPanRef.current = false
    panStartRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y }
    e.preventDefault()
  }, [pan])

  // ── Display dimensions ────────────────────────────────────────────────────
  // `scale` is the 100%-zoom display scale (CSS px per source px); the on-screen
  // magnification is `scale * zoom`.
  const { frameW, frameH, displayW, displayH, scale } = useMemo(() => {
    if (isVideo && videoDims) {
      // Fill the container, preserving aspect ratio
      const maxW = containerSize?.w ?? window.innerWidth
      const maxH = containerSize?.h ?? window.innerHeight
      const s = Math.min(maxW / videoDims.w, maxH / videoDims.h)
      return {
        frameW: videoDims.w,
        frameH: videoDims.h,
        displayW: Math.round(videoDims.w * s),
        displayH: Math.round(videoDims.h * s),
        scale: s,
      }
    }
    if (!isVideo) {
      const tileW = task.x2 - task.x1
      const tileH = task.y2 - task.y1
      // Native resolution by default, so fish are the same on-screen size across
      // survey types — but never larger than fits, so legacy whole-image tasks
      // (which are far bigger than a screen) still open usable and can be zoomed.
      const preferred = DEFAULT_IMAGE_SCALE[task.surveyType] ?? 1
      const fit = containerSize
        ? Math.min(containerSize.w / tileW, containerSize.h / tileH)
        : IMAGE_MAX_DISPLAY / Math.max(tileW, tileH)
      const s = Math.min(preferred, fit)
      return {
        frameW: tileW,
        frameH: tileH,
        displayW: Math.round(tileW * s),
        displayH: Math.round(tileH * s),
        scale: s,
      }
    }
    return { frameW: 0, frameH: 0, displayW: 0, displayH: 0, scale: 1 }
  }, [isVideo, videoDims, containerSize, task.x1, task.y1, task.x2, task.y2, task.surveyType])

  // ── Load image tile ───────────────────────────────────────────────────────
  useEffect(() => {
    if (isVideo) return
    setImageUrl(null)
    setImageError(false)
    const tileW = task.x2 - task.x1
    const tileH = task.y2 - task.y1
    const params = new URLSearchParams({
      key: task.fileKey,
      x: String(task.x1),
      y: String(task.y1),
      w: String(tileW),
      h: String(tileH),
    })
    fetch(`/api/files/thumbnail?${params}`)
      .then(r => { if (!r.ok) throw new Error(); return r.blob() })
      .then(blob => setImageUrl(URL.createObjectURL(blob)))
      .catch(() => setImageError(true))
  }, [isVideo, task.fileKey, task.x1, task.y1, task.x2, task.y2])

  // ── Load video ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isVideo) return
    setVideoUrl(null)
    setVideoError(false)
    setVideoDims(null)
    setFrameReady(false)
    fetch(`/api/files/presign?key=${encodeURIComponent(task.fileKey)}`)
      .then(r => r.ok ? r.json() as Promise<{ url: string }> : null)
      .then(data => { if (data) setVideoUrl(data.url) })
      .catch(() => setVideoError(true))
  }, [isVideo, task.fileKey])

  // Seek to task frame — handled via onLoadedMetadata on the video element

  // Track play state — re-attach whenever the video element or URL changes
  useEffect(() => {
    if (!isVideo || !videoUrl) return
    // Wait a tick for the video element to be in the DOM
    const attach = () => {
      const video = videoRef.current
      if (!video) return
      const onPlay = () => setIsPlaying(true)
      const onPause = () => {
        setIsPlaying(false)
        if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      }
      const onError = () => setVideoError(true)
      video.addEventListener('play', onPlay)
      video.addEventListener('pause', onPause)
      video.addEventListener('error', onError)
      return () => {
        video.removeEventListener('play', onPlay)
        video.removeEventListener('pause', onPause)
        video.removeEventListener('error', onError)
      }
    }
    const cleanup = attach()
    return cleanup
  }, [isVideo, videoUrl])

  // ── Hotkeys ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if ((e.key === 'r' || e.key === 'R') && isVideo) {
        e.preventDefault()
        handlePlayLastSecond()
      }
      if ((e.key === 'Enter' || e.key === 'c' || e.key === 'C') && canWrite) {
        e.preventDefault()
        handleComplete()
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomByStep(ZOOM_STEP)
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        zoomByStep(1 / ZOOM_STEP)
      }
      if (e.key === '0') {
        e.preventDefault()
        resetZoom()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, canWrite, zoomByStep, resetZoom])

  // ── Video controls ────────────────────────────────────────────────────────
  const handlePlayLastSecond = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const targetTime = task.frame / fps
    video.currentTime = Math.max(0, targetTime - 1)
    video.play().catch(() => {})
    // Poll with rAF for precise stopping — timeupdate only fires ~4x/sec
    const stop = () => {
      if (!videoRef.current) return
      if (videoRef.current.currentTime >= targetTime) {
        videoRef.current.pause()
        videoRef.current.currentTime = targetTime
        rafRef.current = null
      } else {
        rafRef.current = requestAnimationFrame(stop)
      }
    }
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(stop)
  }, [task.frame, fps])

  // ── Drag handling ─────────────────────────────────────────────────────────
  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    if (didDragRef.current) { setDirty(true); setSaveStatus('idle') }
    dragRef.current = null
    didDragRef.current = false
    setCursor('crosshair')
  }, [])

  useEffect(() => {
    document.addEventListener('mouseup', endDrag)
    return () => document.removeEventListener('mouseup', endDrag)
  }, [endDrag])

  // ── Save helpers ──────────────────────────────────────────────────────────
  const doSave = useCallback(async () => {
    setSaveStatus('saving')
    const res = await saveTaskPoints(task.id, points.map(p => ({ x: p.x, y: p.y })))
    setSaveStatus(res.ok ? 'saved' : 'error')
    if (res.ok) setDirty(false)
    return !!res.ok
  }, [task.id, points])

  // ── Prediction logic ──────────────────────────────────────────────────────
  const handlePredict = useCallback(async (options?: { forceClear?: boolean }) => {
    if (!canWrite) return
    if (points.length > 0 && !options?.forceClear) {
      setShowClearConfirm(true)
      return
    }

    setOriginalPointsBeforePredict(points)
    setPoints([])
    setPredicting(true)
    setPredictError(null)
    setShowClearConfirm(false)
    setShowSlowPredictionWarning(false)

    let slowTimer: any = null
    slowTimer = setTimeout(() => {
      setShowSlowPredictionWarning(true)
    }, 3500)

    try {
      let presignedUrl = videoUrl
      if (isVideo) {
        try {
          const presignRes = await fetch(`/api/files/presign?key=${encodeURIComponent(task.fileKey)}`)
          if (presignRes.ok) {
            const presignData = await presignRes.json()
            presignedUrl = presignData.url
          }
        } catch (e) {
          console.error('Failed to retrieve fresh presigned URL for prediction, falling back to cached:', e)
        }
      }

      const response = await fetch('https://michaelthoreau--salmon-prediction-api-salmoninferenceser-6e48b3.modal.run/predict', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          task: {
            fileId: task.fileId,
            frame: task.frame,
            x1: task.x1,
            y1: task.y1,
            x2: task.x2,
            y2: task.y2,
            ...(isVideo && presignedUrl ? { presignedUrl } : {}),
          },
          score_thresh: 0.05,
        }),
      })

      if (!response.ok) {
        throw new Error(`Prediction API returned status ${response.status}`)
      }

      const data = await response.json()
      if (!data || !Array.isArray(data.points)) {
        throw new Error('Invalid response format from prediction API')
      }

      setRawPredictions(data.points)
      setIsPreviewing(true)
    } catch (err: any) {
      console.error('Prediction error:', err)
      setPredictError(err.message || 'Prediction failed')
      // Restore original points if prediction failed
      setPoints(points)
    } finally {
      if (slowTimer) {
        clearTimeout(slowTimer)
      }
      setShowSlowPredictionWarning(false)
      setPredicting(false)
    }
  }, [canWrite, points, task, isVideo, videoUrl])

  const handleLockIn = useCallback(() => {
    const finalPoints = filteredPredictions.map(p => ({
      id: crypto.randomUUID(),
      x: isVideo ? p.x : p.crop_x,
      y: isVideo ? p.y : p.crop_y,
    }))

    setPoints(finalPoints)
    setIsPreviewing(false)
    setRawPredictions([])
    setOriginalPointsBeforePredict([])
    setDirty(true)
    setSaveStatus('idle')
  }, [filteredPredictions, isVideo])

  const handleCancelPreview = useCallback(() => {
    setIsPreviewing(false)
    setRawPredictions([])
    setPoints(originalPointsBeforePredict)
    setOriginalPointsBeforePredict([])
    setPredictError(null)
  }, [originalPointsBeforePredict])

  const handleCopyError = useCallback(() => {
    if (!predictError) return
    navigator.clipboard.writeText(predictError)
    setCopiedError(true)
    setTimeout(() => setCopiedError(false), 2000)
  }, [predictError])

  const handlePrev = useCallback(() => {
    if (!prevTaskId) return
    router.push(queueTaskUrl(projectId, queueId, prevTaskId))
  }, [prevTaskId, projectId, queueId, router])

  const handleSkip = useCallback(() => {
    if (!nextTaskId) return
    router.push(queueTaskUrl(projectId, queueId, nextTaskId))
  }, [nextTaskId, projectId, queueId, router])

  const handleComplete = useCallback(async () => {
    if (!canWrite) return
    setBusy(true)
    if (dirty) {
      const ok = await doSave()
      if (!ok) { setBusy(false); return }
    }
    if (!complete) {
      await setTaskComplete(task.id, true)
      setComplete(true)
    }
    setBusy(false)
    if (nextTaskId) {
      router.push(queueTaskUrl(projectId, queueId, nextTaskId))
    } else {
      router.refresh()
    }
  }, [canWrite, dirty, complete, task.id, doSave, nextTaskId, projectId, queueId, router])

  const handleMarkIncomplete = useCallback(async () => {
    if (!canWrite) return
    setBusy(true)
    await setTaskComplete(task.id, false)
    setComplete(false)
    setBusy(false)
    router.refresh()
  }, [canWrite, task.id, router])

  const handleNavigateToTask = useCallback(async (targetTaskId: string) => {
    if (targetTaskId === task.id) return
    if (dirty && canWrite) {
      setBusy(true)
      const ok = await doSave()
      setBusy(false)
      if (!ok) return
    }
    router.push(queueTaskUrl(projectId, queueId, targetTaskId))
    setShowTaskSelector(false)
  }, [task.id, dirty, canWrite, doSave, projectId, queueId, router])

  const filteredTasks = useMemo(() => {
    return queueTasks.filter(t => {
      if (filterTab === 'completed') return !!t.completedBy
      if (filterTab === 'incomplete') return !t.completedBy
      return true
    })
  }, [queueTasks, filterTab])

  // ── Canvas interaction ────────────────────────────────────────────────────
  // The wrapper's bounding rect is post-transform, so dividing by `zoom` first
  // gets back to unzoomed CSS px and dividing by `scale` gets to source pixels.
  // Hit radius is unaffected by zoom — the dots scale with the image.
  const toSourcePoint = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / zoom / scale,
      y: (e.clientY - rect.top) / zoom / scale,
    }
  }, [zoom, scale])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const { x: px, y: py } = toSourcePoint(e)
    const idx = canWrite && !isPreviewing
      ? points.findIndex(p => Math.hypot(p.x - px, p.y - py) < HIT_RADIUS / scale)
      : -1
    if (idx >= 0) {
      dragRef.current = { id: points[idx].id }
      didDragRef.current = false
      setCursor('grabbing')
      e.preventDefault()
    } else {
      beginPan(e)
    }
  }, [canWrite, points, scale, isPreviewing, toSourcePoint, beginPan])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current || !canWrite || isPreviewing) return
    didDragRef.current = true
    const { x, y } = toSourcePoint(e)
    const px = Math.max(0, Math.min(frameW, x))
    const py = Math.max(0, Math.min(frameH, y))
    const id = dragRef.current.id
    setPoints(prev => prev.map(p => p.id === id ? { ...p, x: px, y: py } : p))
  }, [canWrite, frameW, frameH, isPreviewing, toSourcePoint])

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!canWrite || isPreviewing) return
    if (didDragRef.current) { didDragRef.current = false; return }
    if (didPanRef.current) { didPanRef.current = false; return }
    const { x: px, y: py } = toSourcePoint(e)
    const hit = points.findIndex(p => Math.hypot(p.x - px, p.y - py) < HIT_RADIUS / scale)
    if (hit >= 0) return
    setPoints(prev => [...prev, { id: crypto.randomUUID(), x: px, y: py }])
    setDirty(true)
    setSaveStatus('idle')
  }, [canWrite, points, scale, isPreviewing, toSourcePoint])

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!canWrite || isPreviewing) return
    const { x: px, y: py } = toSourcePoint(e)
    const hitIdx = points.findIndex(p => Math.hypot(p.x - px, p.y - py) < HIT_RADIUS / scale)
    if (hitIdx >= 0) {
      e.preventDefault()
      setPoints(prev => prev.filter((_, i) => i !== hitIdx))
      setDirty(true)
      setSaveStatus('idle')
    }
  }, [canWrite, points, scale, isPreviewing, toSourcePoint])

  const progressPct = totalInQueue > 0 ? Math.round((completeCount / totalInQueue) * 100) : 0
  const filename = task.fileKey.split('/').pop() ?? task.fileKey

  const annotationDots = (
    <svg
      className="absolute inset-0 pointer-events-none"
      width={displayW}
      height={displayH}
      viewBox={`0 0 ${displayW} ${displayH}`}
    >
      {points.map(p => {
        const cx = p.x * scale
        const cy = p.y * scale
        return (
          <g key={p.id}>
            <circle cx={cx} cy={cy} r={POINT_RADIUS + 1} fill="rgba(0,0,0,0.5)" />
            <circle cx={cx} cy={cy} r={POINT_RADIUS} fill="#ef4444" stroke="white" strokeWidth={1.5} />
          </g>
        )
      })}
    </svg>
  )

  const previewDots = (
    <>
      {isPreviewing && (
        <svg
          className="absolute inset-0 pointer-events-none"
          width={displayW}
          height={displayH}
          viewBox={`0 0 ${displayW} ${displayH}`}
        >
          {filteredPredictions.map((p, idx) => {
            const px = isVideo ? p.x : p.crop_x
            const py = isVideo ? p.y : p.crop_y
            const cx = px * scale
            const cy = py * scale
            return (
              <g key={`preview-image-${idx}`}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={POINT_RADIUS + 3}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={1}
                  className="animate-ping"
                  style={{ transformOrigin: `${cx}px ${cy}px`, animationDuration: '2s' }}
                />
                <circle cx={cx} cy={cy} r={POINT_RADIUS + 1} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={1.5} />
                <circle cx={cx} cy={cy} r={POINT_RADIUS} fill="#f59e0b" stroke="white" strokeWidth={1.5} />
              </g>
            )
          })}
        </svg>
      )}
    </>
  )

  return (
    <div className="fixed top-[100px] bottom-0 left-0 right-0 z-10 bg-gray-950 flex flex-col overflow-hidden">

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 h-12 bg-gray-900 border-b border-gray-800 flex-shrink-0 relative z-20">
        {/* Back + queue + progress + filename */}
        <Link href={`/projects/${projectId}/labeling`} className="text-xs text-gray-400 hover:text-white transition-colors shrink-0">← Labeling</Link>
        <span className="text-gray-700 select-none">|</span>
        <span className="text-sm font-semibold text-white truncate min-w-0">{queueName}</span>
        <div ref={selectorRef} className="relative flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowTaskSelector(!showTaskSelector)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white text-xs font-semibold transition-colors"
          >
            <List className="w-3.5 h-3.5 text-blue-400 animate-pulse" />
            <span className="text-sm font-black tabular-nums text-white">
              {positionInQueue}
              <span className="text-gray-500 font-normal text-xs"> / {totalInQueue}</span>
            </span>
            <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${showTaskSelector ? 'rotate-180' : ''}`} />
          </button>
          
          <div className="w-20 h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
          </div>

          {showTaskSelector && (
            <div className="absolute top-9 left-0 z-30 w-80 max-h-[480px] overflow-hidden bg-gray-900 border border-gray-800 rounded-xl shadow-2xl flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 bg-gray-950">
                <span className="text-xs font-semibold text-gray-300">Queue Tasks</span>
                <span className="text-[10px] bg-gray-800 px-2 py-0.5 rounded text-gray-400 font-medium">{completeCount} / {totalInQueue} Complete</span>
              </div>
              
              {/* Tab Filters */}
              <div className="flex border-b border-gray-800 bg-gray-950/50 p-1 gap-1">
                {(['all', 'completed', 'incomplete'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={(e) => {
                      e.stopPropagation()
                      setFilterTab(tab)
                    }}
                    className={`flex-1 py-1 text-[10px] font-semibold rounded capitalize transition-colors ${filterTab === tab ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              {/* Scrollable list */}
              <div className="flex-1 overflow-y-auto p-1.5 max-h-[350px] space-y-0.5">
                {filteredTasks.map((t) => {
                  const isActive = t.id === task.id
                  const isItemVideo = isVideoKey(t.fileKey)
                  const displayFilename = t.fileKey.split('/').pop() ?? t.fileKey
                  const labelStr = isItemVideo 
                    ? `Frame ${t.frame}`
                    : `${t.x1},${t.y1}–${t.x2},${t.y2}`

                  return (
                    <button
                      key={t.id}
                      onClick={() => handleNavigateToTask(t.id)}
                      className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition-colors ${isActive ? 'bg-blue-600/20 border border-blue-500/40 text-white' : 'hover:bg-gray-800/60 text-gray-300 hover:text-white'}`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {t.completedBy ? (
                          <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
                        ) : (
                          <Circle className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                        )}
                        <div className="min-w-0 flex flex-col">
                          <span className="text-[11px] font-medium truncate">{displayFilename}</span>
                          <span className="text-[9px] text-gray-500 font-mono truncate">
                            {labelStr}
                            {t.completedByEmail && (
                              <span className="text-gray-600 font-normal ml-1.5 font-sans">({t.completedByEmail})</span>
                            )}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] font-black tabular-nums bg-gray-800/80 px-1.5 py-0.5 rounded text-blue-400">
                          {t.pointCount} fish
                        </span>
                      </div>
                    </button>
                  )
                })}
                {filteredTasks.length === 0 && (
                  <div className="text-center py-6 text-xs text-gray-500">No {filterTab} tasks found</div>
                )}
              </div>
            </div>
          )}
        </div>
        <span className="text-gray-700 select-none">|</span>
        <span className="text-xs font-mono text-gray-400 truncate min-w-0">
          {filename}{isVideo ? <span className="text-gray-600"> · frame {task.frame}</span> : <span className="text-gray-600"> · {task.x1},{task.y1}–{task.x2},{task.y2}</span>}
        </span>
        <span className="text-gray-700 select-none">|</span>
        {/* Play last second — video only */}
        {isVideo && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={handlePlayLastSecond} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white text-xs font-semibold transition-colors" title="Play last second (R)">
              <History className="w-3.5 h-3.5 text-amber-400" />
              Play last second
              <kbd className="ml-1 text-[10px] text-gray-500 font-mono bg-gray-900 rounded px-1">R</kbd>
            </button>
            {isPlaying && <span className="text-[11px] text-white/50 animate-pulse">▶ playing…</span>}
            <span className="text-gray-700 select-none">|</span>
          </div>
        )}

        {/* Zoom controls — images and video alike */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => zoomByStep(1 / ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            className="flex items-center justify-center w-7 h-7 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Zoom out (−)"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={resetZoom}
            disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
            className="px-2 py-1.5 rounded-lg border text-xs font-semibold tabular-nums transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-blue-900/60 hover:bg-blue-800 border-blue-700 text-blue-300 disabled:hover:bg-blue-900/60"
            title="Reset zoom (0)"
          >
            {Math.round(scale * zoom * 100)}%
          </button>
          <button
            onClick={() => zoomByStep(ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            className="flex items-center justify-center w-7 h-7 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Zoom in (+)"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
        <span className="text-gray-700 select-none">|</span>

        {/* Predict Panel */}
        {canWrite && (
          <div className={isPreviewing ? "flex items-center gap-2 shrink-0 bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1" : "flex items-center gap-2 shrink-0"}>
            {isPreviewing ? (
              <>
                <span className="text-[11px] text-gray-400 font-medium">Thresh: {scoreThresh.toFixed(2)}</span>
                <input
                  type="range"
                  min="0.05"
                  max="0.95"
                  step="0.05"
                  value={scoreThresh}
                  onChange={(e) => setScoreThresh(parseFloat(e.target.value))}
                  className="w-20 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <span className="text-[11px] text-gray-400 font-medium ml-2">Min Dist:</span>
                <input
                  type="number"
                  min="0"
                  max="500"
                  step="5"
                  value={minDist}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    setMinDist(isNaN(val) ? 0 : val)
                  }}
                  className="w-12 h-5 bg-gray-800 border border-gray-700 rounded text-center text-[11px] text-white font-medium focus:outline-none focus:border-blue-500"
                />
                <span className="text-[11px] text-gray-400 font-medium mr-1">px</span>
                <span className="text-[11px] text-amber-400 font-bold tabular-nums">
                  {filteredPredictions.length} fish
                </span>
                <button
                  onClick={handleLockIn}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-green-600 hover:bg-green-500 text-white text-[11px] font-bold transition-colors"
                >
                  <Check className="w-3 h-3" />
                  Proceed to Cleanup
                </button>
                <button
                  onClick={handleCancelPreview}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-[11px] font-bold border border-gray-700 transition-colors"
                >
                  <X className="w-3 h-3" />
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => handlePredict()}
                  disabled={predicting}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none"
                >
                  {predicting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
                  ) : (
                    <div className="relative w-3.5 h-3.5">
                      <Fish className="w-3.5 h-3.5 text-blue-100" />
                      <Zap className="absolute -top-1 -right-1 w-2.5 h-2.5 text-yellow-400 fill-yellow-400 stroke-blue-600 stroke-[1.5px]" />
                    </div>
                  )}
                  {predicting ? 'Predicting...' : (
                    <span className="flex items-center gap-1">
                      Predict
                      <span className="text-[8px] bg-blue-500 text-blue-100 px-1 py-0.5 rounded font-black tracking-wider uppercase leading-none scale-95 border border-blue-400/25">Beta</span>
                    </span>
                  )}
                </button>
                {predictError && (
                  <div className="flex items-center gap-1 bg-red-950/80 border border-red-800 rounded px-1.5 py-0.5 text-[10px] text-red-300">
                    <span className="truncate max-w-[150px]" title={predictError}>
                      {predictError}
                    </span>
                    <button
                      onClick={handleCopyError}
                      type="button"
                      className="text-red-400 hover:text-red-200 underline font-semibold cursor-pointer shrink-0 ml-1"
                    >
                      {copiedError ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      onClick={() => setPredictError(null)}
                      type="button"
                      className="text-red-400 hover:text-red-200 font-black cursor-pointer shrink-0 ml-1"
                    >
                      ×
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        <span className="text-gray-700 select-none">|</span>

        {/* Status */}
        <div className="flex items-center gap-2 shrink-0">
          {dirty && <span className="text-[11px] text-amber-400 font-medium">Unsaved</span>}
          {saveStatus === 'saving' && <span className="text-[11px] text-gray-500 animate-pulse">Saving…</span>}
          {saveStatus === 'saved' && !dirty && <span className="text-[11px] text-green-500">Saved</span>}
          {saveStatus === 'error' && <span className="text-[11px] text-red-400">Save failed</span>}
          {complete && !dirty && <span className="text-[11px] text-green-400 font-semibold">✓ Complete</span>}
          {canWrite && dirty && <button onClick={doSave} className="text-[11px] text-blue-400 hover:text-blue-300 underline">Save</button>}
          {canWrite && points.length > 0 && <button onClick={() => { setPoints([]); setDirty(true); setSaveStatus('idle') }} className="text-[11px] text-gray-500 hover:text-red-400 underline">Clear</button>}
        </div>
        {/* Nav + complete */}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <button onClick={handlePrev} disabled={!prevTaskId} className="px-3 py-1.5 rounded-lg border border-gray-700 bg-gray-800 text-xs font-medium text-gray-300 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed">← Prev</button>
          <button onClick={handleSkip} disabled={!nextTaskId} className="px-3 py-1.5 rounded-lg border border-gray-700 bg-gray-800 text-xs font-medium text-gray-300 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed">Skip →</button>
          {canWrite && complete && (
            <div ref={actionsMenuRef} className="relative">
              <button
                onClick={() => setShowActionsMenu(!showActionsMenu)}
                disabled={busy}
                className="flex items-center justify-center w-8 h-8 rounded-lg border border-gray-700 bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title="More actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              
              {showActionsMenu && (
                <div className="absolute right-0 top-full mt-1.5 z-30 w-40 bg-gray-900 border border-gray-800 rounded-lg shadow-2xl p-1">
                  <button
                    onClick={() => {
                      setShowActionsMenu(false)
                      handleMarkIncomplete()
                    }}
                    disabled={busy}
                    className="w-full text-left px-2.5 py-1.5 rounded text-xs font-semibold text-red-400 hover:bg-gray-800 hover:text-red-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Mark Incomplete
                  </button>
                </div>
              )}
            </div>
          )}
          {canWrite && (
            <button onClick={handleComplete} disabled={busy} title="Complete & next (Enter or C)" className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${complete ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white'}`}>
              {busy ? '…' : complete ? '✓ Next →' : nextTaskId ? 'Complete & Next →' : '✓ Complete'}
            </button>
          )}
          {!canWrite && complete && <span className="px-3 py-1.5 rounded-lg bg-green-900/40 text-green-400 text-xs font-semibold">✓ Complete</span>}
        </div>
      </div>

      {/* ── Main content area ─────────────────────────────────────────────── */}
      {isVideo ? (
        /* ── Video mode: full-area canvas with overlay HUD ── */
        <div ref={containerRef} className="flex-1 min-h-0 relative bg-black">
          {videoError && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">Failed to load video</div>
          )}

          {/* Centered video+overlay wrapper — zoom transform applied here */}
          {/* Render as soon as videoUrl is known; onLoadedMetadata fires on the single video element */}
          {videoUrl && containerSize && (() => {
            // Use videoDims if known, otherwise render an invisible placeholder so the
            // video element mounts early and fires onLoadedMetadata without remounting.
            const dims = videoDims ?? { w: containerSize.w, h: containerSize.h }
            const s = Math.min(containerSize.w / dims.w, containerSize.h / dims.h)
            const ow = Math.round(dims.w * s)
            const oh = Math.round(dims.h * s)
            const overlayScale = s
            return (
              <div
                ref={mediaWrapperRef}
                style={{
                  position: 'absolute',
                  width: ow, height: oh,
                  top: '50%', left: '50%',
                  transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: '0 0',
                  willChange: 'transform',
                  visibility: videoDims ? 'visible' : 'hidden',
                  cursor: cursor === 'grabbing' ? 'grabbing' : canWrite ? 'crosshair' : 'grab',
                }}
                onMouseDown={handleMouseDown}
                onClick={handleCanvasClick}
                onMouseMove={handleMouseMove}
                onContextMenu={handleContextMenu}
              >
                {/* Single video element — ref, metadata, seek, and playback all here */}
                <video
                  ref={videoRef}
                  src={videoUrl}
                  preload="auto"
                  muted
                  playsInline
                  onLoadedMetadata={() => {
                    const v = videoRef.current
                    if (!v) return
                    setVideoDims({ w: v.videoWidth, h: v.videoHeight })
                    v.currentTime = task.frame / fps
                  }}
                  onSeeked={() => setFrameReady(true)}
                  style={{ position: 'absolute', inset: 0, width: ow, height: oh, pointerEvents: 'none', opacity: frameReady ? 1 : 0, transition: 'opacity 0.15s' }}
                />
                {/* Annotation dots */}
                <svg
                  className="absolute inset-0 pointer-events-none"
                  width={ow} height={oh}
                  viewBox={`0 0 ${ow} ${oh}`}
                >
                  {frameReady && points.map(p => {
                    const cx = p.x * overlayScale
                    const cy = p.y * overlayScale
                    return (
                      <g key={p.id}>
                        <circle cx={cx} cy={cy} r={POINT_RADIUS + 1} fill="rgba(0,0,0,0.5)" />
                        <circle cx={cx} cy={cy} r={POINT_RADIUS} fill="#ef4444" stroke="white" strokeWidth={1.5} />
                      </g>
                    )
                  })}
                  {frameReady && isPreviewing && filteredPredictions.map((p, idx) => {
                    const cx = p.x * overlayScale
                    const cy = p.y * overlayScale
                    return (
                      <g key={`preview-video-${idx}`}>
                        <circle
                          cx={cx}
                          cy={cy}
                          r={POINT_RADIUS + 3}
                          fill="none"
                          stroke="#f59e0b"
                          strokeWidth={1}
                          className="animate-ping"
                          style={{ transformOrigin: `${cx}px ${cy}px`, animationDuration: '2s' }}
                        />
                        <circle cx={cx} cy={cy} r={POINT_RADIUS + 1} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={1.5} />
                        <circle cx={cx} cy={cy} r={POINT_RADIUS} fill="#f59e0b" stroke="white" strokeWidth={1.5} />
                      </g>
                    )
                  })}
                </svg>
              </div>
            )
          })()}

          {(!frameReady || !videoUrl) && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 animate-pulse pointer-events-none">Loading…</div>
          )}

          {/* Overlay HUD — bottom bar (hints only) */}
          <div className="absolute bottom-0 left-0 right-0 flex items-center justify-end px-4 py-2 pointer-events-none">
            {canWrite && (
              <div className="flex items-center gap-3 text-[11px] text-white/40 pointer-events-none select-none">
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">click</kbd> add</span>
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">drag</kbd> move / pan</span>
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">right-click</kbd> remove</span>
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">scroll · + / −</kbd> zoom</span>
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">C / Enter</kbd> complete</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Image mode: centered, zoomable canvas filling the area ── */
        <div ref={containerRef} className="flex-1 min-h-0 relative bg-gray-950 overflow-hidden">
          <div
            ref={mediaWrapperRef}
            className="select-none bg-gray-900 shadow-2xl"
            style={{
              position: 'absolute',
              width: displayW, height: displayH,
              top: '50%', left: '50%',
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              willChange: 'transform',
              cursor: cursor === 'grabbing' ? 'grabbing' : canWrite ? 'crosshair' : 'grab',
            }}
            onClick={handleCanvasClick}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onContextMenu={handleContextMenu}
          >
            {imageUrl && !imageError && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt=""
                draggable={false}
                width={displayW}
                height={displayH}
                style={{ position: 'absolute', inset: 0, width: displayW, height: displayH, imageRendering: 'pixelated', pointerEvents: 'none', userSelect: 'none' }}
                onError={() => setImageError(true)}
              />
            )}
            {imageError && <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">Failed to load image</div>}
            {!imageUrl && !imageError && <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 animate-pulse">Loading…</div>}
            {annotationDots}
            {previewDots}
          </div>
          {canWrite && (
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center px-4 py-2 pointer-events-none">
              <div className="flex items-center gap-3 text-[11px] text-white/40 select-none">
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">click</kbd> add</span>
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">drag</kbd> move / pan</span>
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">right-click</kbd> remove</span>
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">scroll · + / −</kbd> zoom</span>
                <span><kbd className="font-mono bg-white/10 rounded px-1 py-0.5 text-white/60">C / Enter</kbd> complete</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Instructions modal ─────────────────────────────────────────────── */}
      {showInstructions && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-5 pb-3">
              <h2 className="text-base font-bold text-white">Labeling tips</h2>
              <button onClick={dismissInstructions} className="text-gray-500 hover:text-white transition-colors p-1">
                <X className="w-4 h-4" />
              </button>
            </div>
            <ul className="px-6 pb-5 space-y-3 text-sm text-gray-300">
              <li className="flex gap-3">
                <span className="text-blue-400 font-bold shrink-0">1.</span>
                <span>Click to place a dot on every visible fish in the frame.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-blue-400 font-bold shrink-0">2.</span>
                <span>If fish are too hard to make out, skip the frame and move on — it's better to skip than to guess.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-blue-400 font-bold shrink-0">3.</span>
                <span>You don't need to label every frame. Spread your effort across the video rather than spending too long on one clip.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-blue-400 font-bold shrink-0">4.</span>
                <span>Use <span className="font-semibold text-white">zoom</span> to get a closer look, and <span className="font-semibold text-white">Replay last second</span> to watch motion before deciding.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-amber-400 font-bold shrink-0">★</span>
                <span><span className="font-semibold text-white">Quality over quantity.</span> A bad label teaches the model the wrong thing. When in doubt, skip.</span>
              </li>
            </ul>
            <div className="px-6 pb-5">
              <button
                onClick={dismissInstructions}
                className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold transition-colors"
              >
                Got it, let's go
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Clear existing points confirmation modal ─────────────────────────────── */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-5 pb-3">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Brain className="w-5 h-5 text-amber-500" />
                Clear existing annotations?
              </h2>
              <button onClick={() => setShowClearConfirm(false)} className="text-gray-500 hover:text-white transition-colors p-1">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 pb-5 space-y-4">
              <p className="text-sm text-gray-300">
                You have {points.length} existing annotation{points.length !== 1 ? 's' : ''} on this frame. Running prediction will clear them.
              </p>
              <p className="text-xs text-gray-500">
                You will be able to review the predictions in preview mode and can cancel to restore your original annotations if needed.
              </p>
            </div>
            <div className="px-6 pb-5 flex gap-3">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="flex-1 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-white text-sm font-semibold border border-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handlePredict({ forceClear: true })}
                className="flex-1 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors"
              >
                Clear & Predict
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Slow prediction warning toast ─────────────────────────────── */}
      {showSlowPredictionWarning && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 bg-amber-950/95 border border-amber-800 rounded-xl px-4 py-3 shadow-2xl text-amber-200 animate-in fade-in slide-in-from-bottom-4 duration-300 max-w-sm">
          <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
            <Sparkles className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-xs font-bold text-white">Prediction is taking a moment...</span>
            <span className="text-[10px] text-amber-300/80 leading-normal">
              The deep learning model server may be starting up. First-time cold starts can take up to 20 seconds.
            </span>
          </div>
          <button
            onClick={() => setShowSlowPredictionWarning(false)}
            type="button"
            className="text-amber-400 hover:text-amber-200 shrink-0 font-bold ml-2 text-sm cursor-pointer"
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
