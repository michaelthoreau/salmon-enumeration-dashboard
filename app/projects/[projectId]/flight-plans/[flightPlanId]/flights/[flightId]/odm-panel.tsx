'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

async function openPresignedUrl(key: string, download = false): Promise<void> {
  const qs = download ? `&download=1` : ''
  const res = await fetch(`/api/files/presign?key=${encodeURIComponent(key)}${qs}`)
  if (!res.ok) return
  const { url } = await res.json()
  window.open(url, '_blank', 'noreferrer')
}

interface OdmTask {
  taskId: string
  odmUuid: string
  status: 'uploading' | 'queued' | 'running' | 'failed' | 'completed' | 'canceled'
  uploadedImages: number
  totalImages: number | null
  processingTime: number
  imagesCount: number
  progress: number
  output: string[]
  outputKey: string | null
  reportKey: string | null
}

interface OdmPanelProps {
  flightId: string
  projectId: string
  flightPlanId: string
  /** Existing active task from the server (if any). */
  initialTask?: {
    taskId: string
    odmUuid: string
    status: OdmTask['status']
    outputKey: string | null
    reportKey: string | null
  } | null
}

const POLL_INTERVAL_MS = 4000
const MAX_POLL_INTERVAL_MS = 60_000 // back off up to 1 min on repeated errors
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled'])

const STATUS_BADGE: Record<OdmTask['status'], string> = {
  uploading: 'bg-purple-100 text-purple-800',
  queued: 'bg-yellow-100 text-yellow-800',
  running: 'bg-blue-100 text-blue-800',
  failed: 'bg-red-100 text-red-800',
  completed: 'bg-green-100 text-green-800',
  canceled: 'bg-gray-100 text-gray-700',
}

function formatDuration(ms: number): string {
  if (ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export default function OdmPanel({ flightId, projectId, flightPlanId, initialTask }: OdmPanelProps) {
  const [task, setTask] = useState<OdmTask | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const outputLineRef = useRef(0)

  // If server passed an existing task, kick off polling for it
  useEffect(() => {
    if (initialTask && !TERMINAL_STATUSES.has(initialTask.status)) {
      setTask({
        taskId: initialTask.taskId,
        odmUuid: initialTask.odmUuid,
        status: initialTask.status,
        outputKey: initialTask.outputKey,
        reportKey: initialTask.reportKey,
        uploadedImages: 0,
        totalImages: null,
        processingTime: -1,
        imagesCount: 0,
        progress: 0,
        output: [],
      })
    } else if (initialTask) {
      // Terminal — just show it statically (we'll poll once to get logs)
      setTask({
        taskId: initialTask.taskId,
        odmUuid: initialTask.odmUuid,
        status: initialTask.status,
        outputKey: initialTask.outputKey,
        reportKey: initialTask.reportKey,
        uploadedImages: 0,
        totalImages: null,
        processingTime: -1,
        imagesCount: 0,
        progress: 0,
        output: [],
      })
    }
  }, [initialTask]) // eslint-disable-line react-hooks/exhaustive-deps

  const pollStatus = useCallback(async (taskId: string) => {
    const line = outputLineRef.current
    const res = await fetch(`/api/odm/tasks/${taskId}?outputLine=${line}`, { cache: 'no-store' })
    if (!res.ok) return
    const data: OdmTask = await res.json()
    if (data.output && data.output.length > 0) {
      outputLineRef.current = line + data.output.length
    }
    setTask((prev) => {
      const merged: OdmTask = {
        ...data,
        output: prev ? [...prev.output, ...(data.output ?? [])] : (data.output ?? []),
      }
      return merged
    })
    return data
  }, [])

  // Auto-scroll log to bottom whenever output grows
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [task?.output.length])

  // Polling loop — uses recursive setTimeout so we can back off on errors
  useEffect(() => {
    if (!task) return
    if (TERMINAL_STATUSES.has(task.status)) {
      // Trigger one final poll to capture any remaining logs
      if (task.output.length === 0) {
        pollStatus(task.taskId)
      }
      return
    }

    let cancelled = false
    let consecutiveErrors = 0

    const schedule = (delay: number) => {
      setTimeout(async () => {
        if (cancelled) return
        const data = await pollStatus(task.taskId)
        if (cancelled) return
        if (!data) {
          // Network / 5xx error — back off exponentially up to MAX_POLL_INTERVAL_MS
          consecutiveErrors++
          const backoff = Math.min(
            POLL_INTERVAL_MS * 2 ** consecutiveErrors,
            MAX_POLL_INTERVAL_MS,
          )
          schedule(backoff)
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

  async function startProcessing() {
    setStarting(true)
    setStartError(null)
    try {
      const res = await fetch('/api/odm/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flightId, projectId, flightPlanId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setStartError(data.error ?? 'Failed to start processing')
        return
      }
      // Kick off polling
      outputLineRef.current = 0
      setTask({
        taskId: data.taskId,
        odmUuid: '',
        status: 'uploading',
        uploadedImages: 0,
        totalImages: null,
        processingTime: -1,
        imagesCount: 0,
        progress: 0,
        output: [],
        outputKey: null,
        reportKey: null,
      })
    } finally {
      setStarting(false)
    }
  }

  const isActive = task && !TERMINAL_STATUSES.has(task.status)

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">ODM Processing</h2>
        <button
          onClick={startProcessing}
          disabled={starting}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg"
        >
          {starting ? 'Starting…' : !task ? 'Start Processing' : isActive ? 'Resubmit' : 'Reprocess'}
        </button>
      </div>

      {startError && (
        <p className="text-sm text-red-600">{startError}</p>
      )}

      {starting && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
          Contacting ODM node…
        </div>
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
              {task.imagesCount > 0 && (
                <span className="text-xs text-gray-500">{task.imagesCount} images</span>
              )}
            </div>
            {task.processingTime >= 0 && (
              <span className="text-xs text-gray-500 font-mono">
                {formatDuration(task.processingTime)}
              </span>
            )}
          </div>

          {/* Upload progress bar (uploading phase) */}
          {task.status === 'uploading' && (
            <div className="px-4 py-3 border-b border-gray-200">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-gray-500">
                  {task.totalImages != null
                    ? `Uploading images to ODM… ${task.uploadedImages} / ${task.totalImages}`
                    : 'Uploading images to ODM…'}
                </span>
                {task.totalImages != null && (
                  <span className="text-xs font-mono text-gray-500">
                    {Math.round((task.uploadedImages / task.totalImages) * 100)}%
                  </span>
                )}
              </div>
              <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-purple-500 transition-all duration-500"
                  style={{
                    width: task.totalImages
                      ? `${(task.uploadedImages / task.totalImages) * 100}%`
                      : '0%',
                  }}
                />
              </div>
            </div>
          )}

          {/* ODM processing progress bar (running phase) */}
          {task.status === 'running' && task.progress > 0 && (
            <div className="px-4 py-3 border-b border-gray-200">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-gray-500">Processing…</span>
                <span className="text-xs font-mono text-gray-500">{Math.round(task.progress)}%</span>
              </div>
              <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-500"
                  style={{ width: `${task.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Completed: download / view buttons */}
          {task.status === 'completed' && (task.outputKey || task.reportKey) && (
            <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border-b border-green-100">
              {task.outputKey && (
                <button
                  onClick={() => openPresignedUrl(task.outputKey!, true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-green-700 hover:bg-green-800 rounded-md"
                >
                  ⬇️ Download GeoTIFF
                </button>
              )}
              {task.reportKey && (
                <button
                  onClick={() => openPresignedUrl(task.reportKey!)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-800 bg-white border border-green-300 hover:bg-green-50 rounded-md"
                >
                  📄 View Report
                </button>
              )}
            </div>
          )}

          {/* Log output */}
          {task.output.length > 0 && (
            <pre
              ref={logRef}
              className="text-xs font-mono text-gray-700 bg-gray-900 text-green-300 p-4 max-h-80 overflow-y-auto whitespace-pre-wrap"
            >
              {task.output.join('\n')}
            </pre>
          )}

          {task.output.length === 0 && isActive && (
            <div className="px-4 py-3 text-sm text-gray-400 italic">
              Waiting for logs…
            </div>
          )}
        </div>
      )}
    </section>
  )
}
