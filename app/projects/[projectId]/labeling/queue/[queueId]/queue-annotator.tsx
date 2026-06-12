'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { saveTaskPoints, setTaskComplete } from '@/app/actions/labeling-tasks'

interface Point {
  id: string
  x: number
  y: number
}

interface Task {
  id: string
  fileKey: string
  x1: number
  y1: number
  x2: number
  y2: number
  completedBy: string | null
  flightPlanName: string
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
}

const POINT_RADIUS = 6
const HIT_RADIUS = 10

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
}: Props) {
  const router = useRouter()

  const tileW = task.x2 - task.x1
  const tileH = task.y2 - task.y1
  const maxDisplay = 800
  const scale = Math.min(1, maxDisplay / Math.max(tileW, tileH))
  const displayW = Math.round(tileW * scale)
  const displayH = Math.round(tileH * scale)

  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageError, setImageError] = useState(false)
  const [points, setPoints] = useState<Point[]>(() => initialPoints.map(p => ({ ...p })))
  const [complete, setComplete] = useState(!!task.completedBy)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState<'crosshair' | 'grabbing'>('crosshair')

  const dragRef = useRef<{ id: string } | null>(null)
  const didDragRef = useRef(false)

  // Load tile image
  useEffect(() => {
    setImageUrl(null)
    setImageError(false)
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
  }, [task.fileKey, task.x1, task.y1, tileW, tileH])

  // End drag anywhere
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

  // ── Save helpers ────────────────────────────────────────────────────────
  const doSave = useCallback(async () => {
    setSaveStatus('saving')
    const res = await saveTaskPoints(task.id, points.map(p => ({ x: p.x, y: p.y })))
    setSaveStatus(res.ok ? 'saved' : 'error')
    if (res.ok) setDirty(false)
    return !!res.ok
  }, [task.id, points])

  // Prev — just navigate, no save
  const handlePrev = useCallback(() => {
    if (!prevTaskId) return
    router.push(queueTaskUrl(projectId, queueId, prevTaskId))
  }, [prevTaskId, projectId, queueId, router])

  // Skip — navigate to next without saving or marking done
  const handleSkip = useCallback(() => {
    if (!nextTaskId) return
    router.push(queueTaskUrl(projectId, queueId, nextTaskId))
  }, [nextTaskId, projectId, queueId, router])

  // Complete — save, mark done, advance to next
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
      // Last task — stay but refresh to show ✓
      router.refresh()
    }
  }, [canWrite, dirty, complete, task.id, doSave, nextTaskId, projectId, queueId, router])

  // ── Canvas interaction ──────────────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !canWrite) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = (e.clientX - rect.left) / scale
    const py = (e.clientY - rect.top) / scale
    const idx = points.findIndex(p => Math.hypot(p.x - px, p.y - py) < HIT_RADIUS / scale)
    if (idx >= 0) {
      dragRef.current = { id: points[idx].id }
      didDragRef.current = false
      setCursor('grabbing')
      e.preventDefault()
    }
  }, [canWrite, points, scale])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current || !canWrite) return
    didDragRef.current = true
    const rect = e.currentTarget.getBoundingClientRect()
    const px = Math.max(0, Math.min(tileW, (e.clientX - rect.left) / scale))
    const py = Math.max(0, Math.min(tileH, (e.clientY - rect.top) / scale))
    const id = dragRef.current.id
    setPoints(prev => prev.map(p => p.id === id ? { ...p, x: px, y: py } : p))
  }, [canWrite, scale, tileW, tileH])

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!canWrite) return
    if (didDragRef.current) { didDragRef.current = false; return }
    const rect = e.currentTarget.getBoundingClientRect()
    const px = (e.clientX - rect.left) / scale
    const py = (e.clientY - rect.top) / scale
    const hit = points.findIndex(p => Math.hypot(p.x - px, p.y - py) < HIT_RADIUS / scale)
    if (hit >= 0) return
    setPoints(prev => [...prev, { id: crypto.randomUUID(), x: px, y: py }])
    setDirty(true)
    setSaveStatus('idle')
  }, [canWrite, points, scale])

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!canWrite) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = (e.clientX - rect.left) / scale
    const py = (e.clientY - rect.top) / scale
    const hitIdx = points.findIndex(p => Math.hypot(p.x - px, p.y - py) < HIT_RADIUS / scale)
    if (hitIdx >= 0) {
      e.preventDefault()
      setPoints(prev => prev.filter((_, i) => i !== hitIdx))
      setDirty(true)
      setSaveStatus('idle')
    }
  }, [canWrite, points, scale])

  // Progress bar pct
  const progressPct = totalInQueue > 0 ? Math.round((completeCount / totalInQueue) * 100) : 0
  const filename = task.fileKey.split('/').pop() ?? task.fileKey

  return (
    <div className="flex flex-col gap-0 h-full">

      {/* ── Queue Session Header ─────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-blue-700 to-blue-600 text-white rounded-2xl px-6 py-4 mb-5">
        <div className="flex items-center justify-between gap-4">
          {/* Left: breadcrumb + queue name */}
          <div className="min-w-0">
            <Link
              href={`/projects/${projectId}/labeling`}
              className="text-xs text-blue-300 hover:text-white transition-colors"
            >
              ← Back to labeling
            </Link>
            <h1 className="text-lg font-bold mt-0.5 truncate">{queueName}</h1>
          </div>

          {/* Centre: progress counter */}
          <div className="flex flex-col items-center shrink-0">
            <span className="text-3xl font-black tabular-nums leading-none">
              {positionInQueue}
              <span className="text-blue-300 text-xl font-semibold"> / {totalInQueue}</span>
            </span>
            <span className="text-xs text-blue-200 mt-0.5">{completeCount} complete</span>
          </div>

          {/* Right: progress bar */}
          <div className="w-40 shrink-0">
            <div className="flex items-center justify-between text-xs text-blue-200 mb-1">
              <span>Progress</span>
              <span>{progressPct}%</span>
            </div>
            <div className="h-2 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-white rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Task info + nav buttons ──────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 mb-4">
        {/* File info */}
        <div className="min-w-0">
          <p className="text-base font-semibold text-gray-900 truncate">{filename}</p>
          <p className="text-xs text-gray-400 font-mono">
            {task.flightPlanName} · {task.x1},{task.y1} — {task.x2},{task.y2}
          </p>
        </div>

        {/* Nav + action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Prev */}
          {prevTaskId ? (
            <button
              onClick={handlePrev}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm"
            >
              ← Prev
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-gray-100 bg-gray-50 text-sm font-medium text-gray-300 cursor-not-allowed select-none">
              ← Prev
            </span>
          )}

          {/* Skip */}
          {nextTaskId ? (
            <button
              onClick={handleSkip}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm"
            >
              Skip →
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-gray-100 bg-gray-50 text-sm font-medium text-gray-300 cursor-not-allowed select-none">
              Skip →
            </span>
          )}

          {/* Complete */}
          {canWrite && (
            <button
              onClick={handleComplete}
              disabled={busy}
              className={`inline-flex items-center gap-2 px-6 py-2 rounded-xl text-sm font-bold transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed ${
                complete
                  ? 'bg-green-500 hover:bg-green-600 text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              {busy ? (
                <span className="animate-pulse">…</span>
              ) : complete ? (
                <>✓ Complete — next</>
              ) : nextTaskId ? (
                <>Complete & Next →</>
              ) : (
                <>✓ Complete</>
              )}
            </button>
          )}

          {!canWrite && complete && (
            <span className="inline-flex items-center rounded-xl bg-green-50 px-4 py-2 text-sm font-semibold text-green-700">
              ✓ Complete
            </span>
          )}
        </div>
      </div>

      {/* Status strip — always rendered at fixed height to prevent layout shift */}
      <div className="h-7 flex items-center gap-3 mb-3 text-xs overflow-hidden">
        {complete && !dirty && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 font-medium text-green-700">
            ✓ Marked complete
          </span>
        )}
        {dirty && <span className="text-amber-600 font-medium">Unsaved changes</span>}
        {saveStatus === 'saving' && <span className="text-gray-400 animate-pulse">Saving…</span>}
        {saveStatus === 'saved' && !dirty && <span className="text-green-600">Saved</span>}
        {saveStatus === 'error' && <span className="text-red-500">Save failed</span>}
        {canWrite && dirty && (
          <button onClick={doSave} className="text-blue-600 underline hover:text-blue-800">
            Save now
          </button>
        )}
        {canWrite && points.length > 0 && (
          <button
            onClick={() => { setPoints([]); setDirty(true); setSaveStatus('idle') }}
            className="ml-auto text-gray-400 hover:text-red-500 underline"
          >
            Clear all points
          </button>
        )}
      </div>

      {/* ── Annotation canvas ────────────────────────────────────────────── */}
      <div className="flex justify-center">
        <div
          className="relative select-none bg-gray-100 rounded-xl overflow-hidden shadow-inner"
          style={{ width: displayW, height: displayH, cursor: canWrite ? cursor : 'default' }}
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
              style={{
                position: 'absolute',
                inset: 0,
                width: displayW,
                height: displayH,
                imageRendering: 'pixelated',
                pointerEvents: 'none',
                userSelect: 'none',
              }}
              onError={() => setImageError(true)}
            />
          )}
          {imageError && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
              Failed to load image
            </div>
          )}
          {!imageUrl && !imageError && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 animate-pulse">
              Loading…
            </div>
          )}

          {/* Point overlay */}
          <svg className="absolute inset-0 pointer-events-none" width={displayW} height={displayH} viewBox={`0 0 ${displayW} ${displayH}`}>
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
        </div>
      </div>

      {/* Keyboard hints */}
      {canWrite && (
        <div className="flex items-center justify-center gap-6 mt-4 text-xs text-gray-400">
          <span><kbd className="font-mono bg-gray-100 border border-gray-200 rounded px-1 py-0.5">Left click</kbd> Add point</span>
          <span><kbd className="font-mono bg-gray-100 border border-gray-200 rounded px-1 py-0.5">Drag</kbd> Move point</span>
          <span><kbd className="font-mono bg-gray-100 border border-gray-200 rounded px-1 py-0.5">Right click</kbd> Remove point</span>
        </div>
      )}
    </div>
  )
}
