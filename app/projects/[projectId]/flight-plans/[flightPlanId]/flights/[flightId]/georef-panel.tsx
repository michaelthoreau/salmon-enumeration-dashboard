'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { MapPinIcon } from 'lucide-react'

async function openPresignedUrl(key: string): Promise<void> {
  const res = await fetch(`/api/files/presign?key=${encodeURIComponent(key)}`)
  if (!res.ok) return
  const { url } = await res.json()
  window.open(url, '_blank', 'noreferrer')
}

interface GeorefTask {
  taskId: string
  status: 'running' | 'completed' | 'failed'
  processed: number
  total: number
  outputKey: string | null
  error: string | null
}

interface GeorefPanelProps {
  flightId: string
  projectId: string
  flightPlanId: string
  /** Existing task from the server, if one has already been started. */
  initialTask?: {
    taskId: string
    status: GeorefTask['status']
    outputKey: string | null
    error: string | null
    totalImages: number | null
  } | null
}

const POLL_INTERVAL_MS = 3000
const MAX_POLL_INTERVAL_MS = 30_000
const TERMINAL_STATUSES = new Set<GeorefTask['status']>(['completed', 'failed'])

const STATUS_BADGE: Record<GeorefTask['status'], string> = {
  running: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
}

export default function GeorefPanel({
  flightId,
  projectId,
  flightPlanId,
  initialTask,
}: GeorefPanelProps) {
  const [task, setTask] = useState<GeorefTask | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    if (initialTask) {
      setTask({
        taskId: initialTask.taskId,
        status: initialTask.status,
        processed: initialTask.totalImages ?? 0,
        total: initialTask.totalImages ?? 0,
        outputKey: initialTask.outputKey,
        error: initialTask.error,
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pollStatus = useCallback(async (taskId: string) => {
    const res = await fetch(`/api/georef/tasks/${taskId}`, { cache: 'no-store' })
    if (!res.ok) return null
    const data: GeorefTask = await res.json()
    setTask(data)
    return data
  }, [])

  // Polling loop with exponential back-off on errors
  useEffect(() => {
    if (!task) return
    if (TERMINAL_STATUSES.has(task.status)) return

    let cancelled = false
    let consecutiveErrors = 0

    const schedule = (delay: number) => {
      setTimeout(async () => {
        if (cancelled) return
        const data = await pollStatus(task.taskId)
        if (cancelled) return
        if (!data) {
          consecutiveErrors++
          schedule(Math.min(POLL_INTERVAL_MS * 2 ** consecutiveErrors, MAX_POLL_INTERVAL_MS))
        } else {
          consecutiveErrors = 0
          if (!TERMINAL_STATUSES.has(data.status)) {
            schedule(POLL_INTERVAL_MS)
          }
        }
      }, delay)
    }

    schedule(POLL_INTERVAL_MS)
    return () => { cancelled = true }
  }, [task?.taskId, task?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function startGeoref() {
    setStarting(true)
    setStartError(null)
    try {
      const res = await fetch('/api/georef/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flightId, projectId, flightPlanId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setStartError(data.error ?? 'Failed to start georeferencing')
        return
      }
      setTask({
        taskId: data.taskId,
        status: 'running',
        processed: 0,
        total: 0,
        outputKey: null,
        error: null,
      })
    } finally {
      setStarting(false)
    }
  }

  const isActive = task && !TERMINAL_STATUSES.has(task.status)

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MapPinIcon className="w-5 h-5 text-gray-500" />
          <h2 className="text-lg font-semibold text-gray-900">Quick Georeference</h2>
        </div>
        <button
          onClick={startGeoref}
          disabled={starting || !!isActive}
          className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg"
        >
          {starting
            ? 'Starting…'
            : !task
              ? 'Quick Georef'
              : isActive
                ? 'Running…'
                : 'Re-georeference'}
        </button>
      </div>

      <p className="text-xs text-gray-500">
        Computes a merged orthophoto directly from DJI EXIF / XMP camera metadata
        (GPS, gimbal angles, calibrated focal length) without full 3-D reconstruction.
        Fast but less accurate than ODM — ideal for quick review in the field.
      </p>

      {startError && (
        <p className="text-sm text-red-600">{startError}</p>
      )}

      {task && (
        <div className="rounded-xl border border-gray-200 overflow-hidden">
          {/* Status bar */}
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${STATUS_BADGE[task.status]}`}
              >
                {isActive && (
                  <span className="mr-1.5 w-2 h-2 rounded-full bg-current opacity-75 animate-pulse" />
                )}
                {task.status}
              </span>
              {task.total > 0 && (
                <span className="text-xs text-gray-500">{task.total} images</span>
              )}
            </div>
          </div>

          {/* Progress bar */}
          {task.status === 'running' && (
            <div className="px-4 py-3 border-b border-gray-200">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-gray-500">
                  {task.total > 0
                    ? `Georeferencing… ${task.processed} / ${task.total}`
                    : 'Georeferencing images…'}
                </span>
                {task.total > 0 && (
                  <span className="text-xs font-mono text-gray-500">
                    {Math.round((task.processed / task.total) * 100)}%
                  </span>
                )}
              </div>
              <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                  style={{
                    width: task.total > 0
                      ? `${(task.processed / task.total) * 100}%`
                      : '5%',
                  }}
                />
              </div>
            </div>
          )}

          {/* Completed: download button */}
          {task.status === 'completed' && task.outputKey && (
            <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border-b border-emerald-100">
              <button
                onClick={() => openPresignedUrl(task.outputKey!)}
                className="text-sm font-medium text-emerald-700 hover:text-emerald-900 underline"
              >
                Download merged GeoTIFF (COG)
              </button>
            </div>
          )}

          {/* Error */}
          {task.status === 'failed' && task.error && (
            <div className="px-4 py-3 bg-red-50 border-b border-red-100">
              <p className="text-sm text-red-700">{task.error}</p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
