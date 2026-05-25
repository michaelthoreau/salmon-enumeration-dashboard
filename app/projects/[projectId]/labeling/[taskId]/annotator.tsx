'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { saveTaskPoints, setTaskComplete } from '@/app/actions/labeling-tasks'

interface Point {
  id: string   // client-side temp id for keying
  x: number    // pixels from left of tile
  y: number    // pixels from top of tile
}

interface Task {
  id: string
  fileKey: string
  x1: number
  y1: number
  x2: number
  y2: number
  completedBy: string | null
}

interface Props {
  task: Task
  initialPoints: { id: string; x: number; y: number }[]
  canWrite: boolean
  projectId: string
}

const POINT_RADIUS = 6
const HIT_RADIUS = 10 // right-click within this many px of centre to delete

export default function Annotator({ task, initialPoints, canWrite, projectId }: Props) {
  const router = useRouter()
  const tileW = task.x2 - task.x1
  const tileH = task.y2 - task.y1

  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageError, setImageError] = useState(false)
  const [points, setPoints] = useState<Point[]>(() =>
    initialPoints.map(p => ({ ...p }))
  )
  const [complete, setComplete] = useState(!!task.completedBy)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [dirty, setDirty] = useState(false)
  const [hasSaved, setHasSaved] = useState(initialPoints.length > 0)
  const [completing, setCompleting] = useState(false)

  // Scale factor: display at most 800px wide or tall
  const maxDisplay = 800
  const scale = Math.min(1, maxDisplay / Math.max(tileW, tileH))
  const displayW = Math.round(tileW * scale)
  const displayH = Math.round(tileH * scale)

  const [cursor, setCursor] = useState<'crosshair' | 'grabbing'>('crosshair')

  const handleSave = useCallback(async () => {
    if (!canWrite) return
    setSaveStatus('saving')
    const result = await saveTaskPoints(task.id, points.map(p => ({ x: p.x, y: p.y })))
    setSaveStatus(result.ok ? 'saved' : 'error')
    if (result.ok) { setDirty(false); setHasSaved(true) }
    return result.ok
  }, [canWrite, task.id, points])

  const handleSaveAndDone = useCallback(async () => {
    if (!canWrite) return
    setCompleting(true)
    if (dirty) {
      const ok = await handleSave()
      if (!ok) { setCompleting(false); return }
    }
    // If already complete and just saving updates, don't toggle done state
    if (!dirty || !complete) {
      const next = !complete
      await setTaskComplete(task.id, next)
      setComplete(next)
    }
    setCompleting(false)
    router.refresh()
  }, [canWrite, dirty, complete, task.id, handleSave, router])

  // Fetch cropped tile on mount
  useEffect(() => {
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

  // Left-click → add point (only if not finishing a drag)
  const dragRef = useRef<{ id: string } | null>(null)
  const didDragRef = useRef(false)

  // End drag on mouseup anywhere on the page so releasing outside canvas doesn't get stuck
  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    if (didDragRef.current) {
      setDirty(true)
      setSaveStatus('idle')
    }
    dragRef.current = null
    didDragRef.current = false
    setCursor('crosshair')
  }, [])

  useEffect(() => {
    document.addEventListener('mouseup', endDrag)
    return () => document.removeEventListener('mouseup', endDrag)
  }, [endDrag])

  const getCanvasPos = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      px: Math.max(0, Math.min(tileW, (e.clientX - rect.left) / scale)),
      py: Math.max(0, Math.min(tileH, (e.clientY - rect.top) / scale)),
    }
  }

  const hitPoint = (px: number, py: number) =>
    points.findIndex(p => Math.hypot(p.x - px, p.y - py) < HIT_RADIUS / scale)

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
    // Don't add a point if clicking on an existing one
    const hit = points.findIndex(p => Math.hypot(p.x - px, p.y - py) < HIT_RADIUS / scale)
    if (hit >= 0) return
    setPoints(prev => [...prev, { id: crypto.randomUUID(), x: px, y: py }])
    setDirty(true)
    setSaveStatus('idle')
  }, [canWrite, points, scale])

  // Right-click → remove point if clicking on one
  const handleCanvasContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
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



  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-500">
            {points.length} point{points.length !== 1 ? 's' : ''}
          </span>
          {saveStatus === 'saving' && <span className="text-gray-400 animate-pulse text-xs">Saving…</span>}
          {saveStatus === 'saved' && !dirty && <span className="text-green-600 text-xs">Saved</span>}
          {saveStatus === 'error' && <span className="text-red-500 text-xs">Save failed</span>}
          {canWrite && (
            <button
              onClick={() => { setPoints([]); setDirty(true); setSaveStatus('idle') }}
              className="text-gray-400 hover:text-red-500 text-xs underline"
            >
              Clear all
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canWrite && (
            <button
              onClick={handleSaveAndDone}
              disabled={completing || saveStatus === 'saving'}
              className={`min-w-32 px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                complete
                  ? 'border-green-200 bg-green-100 text-green-700 hover:bg-green-200'
                  : dirty
                  ? 'border-transparent bg-blue-600 text-white hover:bg-blue-700'
                  : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
              }`}
            >
              {completing || saveStatus === 'saving'
                ? '…'
                : dirty
                ? complete
                  ? 'Update'
                  : (hasSaved ? 'Update & Done' : 'Save & Done')
                : complete
                ? '✓ Done — undo'
                : 'Mark Done'}
            </button>
          )}
          {!canWrite && complete && (
            <span className="inline-flex items-center rounded-full bg-green-50 px-3 py-1 text-sm font-medium text-green-700">
              ✓ Complete
            </span>
          )}
        </div>
      </div>

      {/* Annotation canvas */}
      <div className="flex justify-center">
        <div
          className="relative select-none bg-gray-100 rounded-lg overflow-hidden"
          style={{ width: displayW, height: displayH, cursor: canWrite ? cursor : 'default' }}
          onClick={handleCanvasClick}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onContextMenu={handleCanvasContextMenu}
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
        </div>
      </div>

      {canWrite && (
        <div className="flex items-center justify-center gap-6 text-xs text-gray-400">
          <span><kbd className="font-mono bg-gray-100 border border-gray-200 rounded px-1 py-0.5">Left click</kbd> Add point</span>
          <span><kbd className="font-mono bg-gray-100 border border-gray-200 rounded px-1 py-0.5">Drag</kbd> Move point</span>
          <span><kbd className="font-mono bg-gray-100 border border-gray-200 rounded px-1 py-0.5">Right click</kbd> Remove point</span>
          <span><kbd className="font-mono bg-gray-100 border border-gray-200 rounded px-1 py-0.5">Save</kbd> Persist changes</span>
        </div>
      )}
    </div>
  )
}
