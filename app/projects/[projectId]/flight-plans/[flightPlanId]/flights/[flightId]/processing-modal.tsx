'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { X, Play, RefreshCw, AlertTriangle, Layers, Map, Eye, HelpCircle, Loader2 } from 'lucide-react'

async function openPresignedUrl(key: string, download = false): Promise<void> {
  const qs = download ? `&download=1` : ''
  const res = await fetch(`/api/files/presign?key=${encodeURIComponent(key)}${qs}`)
  if (!res.ok) return
  const { url } = await res.json()
  window.open(url, '_blank', 'noreferrer')
}

interface TaskState {
  taskId: string
  type: 'odm' | 'georef'
  status: 'pending' | 'uploading' | 'queued' | 'running' | 'failed' | 'completed' | 'canceled'
  progress: number
  uploadedImages: number
  totalImages: number | null
  processingTime: number
  imagesCount: number
  output: string[]
  outputKey: string | null
  reportKey: string | null
  error: string | null
}

interface ProcessingModalProps {
  isOpen: boolean
  onClose: () => void
  flightId: string
  projectId: string
  flightPlanId: string
  initialActiveTask: {
    taskId: string
    type: 'odm' | 'georef'
    status: TaskState['status']
    odmUuid?: string | null
    outputKey: string | null
    reportKey?: string | null
    error?: string | null
    totalImages?: number | null
  } | null
}

const POLL_INTERVAL_MS = 3000
const MAX_POLL_INTERVAL_MS = 30000
const TERMINAL_STATUSES = new Set<TaskState['status']>(['completed', 'failed', 'canceled'])

const STATUS_BADGE: Record<TaskState['status'], string> = {
  pending: 'bg-amber-500/10 text-amber-500 border border-amber-500/20',
  uploading: 'bg-purple-500/10 text-purple-400 border border-purple-500/20',
  queued: 'bg-yellow-500/10 text-yellow-500 border border-yellow-500/20',
  running: 'bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse',
  failed: 'bg-red-500/10 text-red-500 border border-red-500/20',
  completed: 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20',
  canceled: 'bg-gray-500/10 text-gray-400 border border-gray-500/20',
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

export default function ProcessingModal({
  isOpen,
  onClose,
  flightId,
  projectId,
  flightPlanId,
  initialActiveTask,
}: ProcessingModalProps) {
  const router = useRouter()
  const [method, setMethod] = useState<'odm' | 'georef'>('georef')

  // Georef config state
  const [dewarp, setDewarp] = useState(true)
  const [altitudeMode, setAltitudeMode] = useState<'relative' | 'lrf' | 'specified'>('relative')
  const [altitudeOffset, setAltitudeOffset] = useState<number>(0)
  const [specifiedAltitude, setSpecifiedAltitude] = useState<number>(50)
  const [sampleFactor, setSampleFactor] = useState<number>(1)

  // Task processing state
  const [task, setTask] = useState<TaskState | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  const logRef = useRef<HTMLPreElement>(null)
  const outputLineRef = useRef(0)

  // Initialize from initial active task if present
  useEffect(() => {
    if (initialActiveTask && isOpen) {
      setTask((prev) => {
        // If there's already a task with the same taskId, just update its status and metadata
        if (prev && prev.taskId === initialActiveTask.taskId) {
          return {
            ...prev,
            status: initialActiveTask.status,
            outputKey: initialActiveTask.outputKey ?? prev.outputKey,
            reportKey: initialActiveTask.reportKey ?? prev.reportKey,
            error: initialActiveTask.error ?? prev.error,
          }
        }
        // Otherwise, it's a new task or first initialization, so reset output line ref and return new state
        outputLineRef.current = 0
        return {
          taskId: initialActiveTask.taskId,
          type: initialActiveTask.type,
          status: initialActiveTask.status,
          progress: 0,
          uploadedImages: 0,
          totalImages: initialActiveTask.totalImages ?? null,
          processingTime: -1,
          imagesCount: 0,
          output: [],
          outputKey: initialActiveTask.outputKey,
          reportKey: initialActiveTask.reportKey ?? null,
          error: initialActiveTask.error ?? null,
        }
      })
      setMethod(initialActiveTask.type)
    }
  }, [
    initialActiveTask?.taskId,
    initialActiveTask?.status,
    initialActiveTask?.outputKey,
    initialActiveTask?.reportKey,
    initialActiveTask?.error,
    isOpen,
  ])

  // Scroll terminal logs to bottom on changes
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [task?.output.length])

  // Polling logic
  const pollStatus = useCallback(async (taskId: string, type: 'odm' | 'georef') => {
    const line = outputLineRef.current
    const endpoint = type === 'odm'
      ? `/api/odm/tasks/${taskId}?outputLine=${line}`
      : `/api/georef/tasks/${taskId}?outputLine=${line}`

    try {
      const res = await fetch(endpoint, { cache: 'no-store' })
      if (!res.ok) return null
      const data = await res.json()

      if (data.output && data.output.length > 0) {
        outputLineRef.current = line + data.output.length
      }

      setTask((prev) => {
        // Enforce monotonicity for processed count, total, and progress to avoid UI jumps on fallback responses
        const isSameTask = prev && prev.taskId === data.taskId
        
        const nextProcessed = data.uploadedImages ?? data.processed ?? 0
        const prevProcessed = isSameTask ? prev.uploadedImages : 0
        const finalProcessed = Math.max(nextProcessed, prevProcessed)

        const nextTotal = data.totalImages ?? data.total ?? null
        const prevTotal = isSameTask ? prev.totalImages : null
        const finalTotal = nextTotal !== null ? nextTotal : prevTotal

        const calculatedProgress = (finalTotal && finalTotal > 0) ? (finalProcessed / finalTotal) * 100 : 0
        const nextProgress = data.progress ?? (data.status === 'completed' ? 100 : calculatedProgress)
        const prevProgress = isSameTask ? prev.progress : 0
        const finalProgress = Math.max(nextProgress, prevProgress)

        const merged: TaskState = {
          taskId: data.taskId,
          type,
          status: data.status,
          progress: finalProgress,
          uploadedImages: finalProcessed,
          totalImages: finalTotal,
          processingTime: data.processingTime ?? (isSameTask ? prev.processingTime : -1),
          imagesCount: data.imagesCount ?? data.total ?? (isSameTask ? prev.imagesCount : 0),
          output: isSameTask ? [...prev.output, ...(data.output ?? [])] : (data.output ?? []),
          outputKey: data.outputKey ?? (isSameTask ? prev.outputKey : null),
          reportKey: data.reportKey ?? (isSameTask ? prev.reportKey : null),
          error: data.error ?? (isSameTask ? prev.error : null),
        }
        return merged
      })
      return data
    } catch {
      return null
    }
  }, [])

  // Auto-polling useEffect hook
  useEffect(() => {
    if (!task) return
    if (TERMINAL_STATUSES.has(task.status)) return

    let cancelledPoll = false
    let consecutiveErrors = 0

    const schedule = (delay: number) => {
      setTimeout(async () => {
        if (cancelledPoll) return
        const data = await pollStatus(task.taskId, task.type)
        if (cancelledPoll) return
        
        if (!data) {
          consecutiveErrors++
          schedule(Math.min(POLL_INTERVAL_MS * 2 ** consecutiveErrors, MAX_POLL_INTERVAL_MS))
        } else {
          consecutiveErrors = 0
          if (!TERMINAL_STATUSES.has(data.status)) {
            schedule(POLL_INTERVAL_MS)
          } else {
            router.refresh()
          }
        }
      }, delay)
    }

    schedule(0)
    return () => { cancelledPoll = true }
  }, [task?.taskId, task?.status, pollStatus, router])

  // Trigger processing
  async function startProcessing() {
    setStarting(true)
    setStartError(null)
    outputLineRef.current = 0

    const endpoint = method === 'odm' ? '/api/odm/tasks' : '/api/georef/tasks'
    const body = method === 'odm'
      ? { flightId, projectId, flightPlanId }
      : {
          flightId,
          projectId,
          flightPlanId,
          dewarp,
          altitudeMode,
          altitudeOffset: Number(altitudeOffset),
          specifiedAltitude: Number(specifiedAltitude),
          sampleFactor: Number(sampleFactor),
        }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setStartError(data.error ?? 'Failed to start processing')
        return
      }

      setTask({
        taskId: data.taskId,
        type: method,
        status: method === 'odm' ? 'uploading' : 'pending',
        progress: 0,
        uploadedImages: 0,
        totalImages: null,
        processingTime: -1,
        imagesCount: 0,
        output: [],
        outputKey: null,
        reportKey: null,
        error: null,
      })
      router.refresh()
      onClose()
    } catch (err) {
      setStartError('Failed to reach server: ' + String(err))
    } finally {
      setStarting(false)
    }
  }

  // Cancel processing
  async function handleCancel() {
    if (!task) return
    if (!confirm('Are you sure you want to cancel and stop this task?')) return
    setCancelling(true)

    const endpoint = task.type === 'odm'
      ? `/api/odm/tasks/${task.taskId}`
      : `/api/georef/tasks/${task.taskId}`

    try {
      const res = await fetch(endpoint, { method: 'DELETE' })
      if (res.ok) {
        setTask((prev) => prev ? { ...prev, status: 'canceled' } : null)
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
  }

  if (!isOpen) return null

  const isActive = !!(task && !TERMINAL_STATUSES.has(task.status))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={() => !isActive && onClose()}
      />

      {/* Modal Container */}
      <div className="relative w-full max-w-3xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-gradient-to-r from-emerald-600/10 via-transparent to-transparent">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-600/10 rounded-lg text-emerald-600">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Flight Imagery Processing</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">Generate georeferenced orthophoto from flight images</p>
            </div>
          </div>
          <button 
            disabled={isActive}
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 disabled:opacity-30 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {!task ? (
            /* Configure Task Screen */
            <div className="space-y-6">
              
              {/* Method Selection Toggles */}
              <div className="grid grid-cols-2 gap-4">
                
                {/* Georef Option */}
                <label className={`flex flex-col p-4 rounded-xl border-2 text-left cursor-pointer transition-all ${
                  method === 'georef'
                    ? 'border-emerald-600 bg-emerald-50/20 dark:bg-emerald-950/10'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}>
                  <input 
                    type="radio" 
                    name="method" 
                    value="georef" 
                    checked={method === 'georef'} 
                    onChange={() => setMethod('georef')}
                    className="sr-only"
                  />
                  <span className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                      <Map className="w-4 h-4 text-emerald-600" />
                      Quick Georeference
                    </span>
                    <span className="text-[10px] uppercase font-bold tracking-wide px-2 py-0.5 rounded bg-emerald-600/10 text-emerald-600">Fast</span>
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Fast flat-earth camera projection. Processes in 1-2 minutes. Ideal for quick check of camera coverage and alignments in the field.
                  </span>
                </label>

                {/* ODM Option */}
                <label className={`flex flex-col p-4 rounded-xl border-2 text-left cursor-pointer transition-all ${
                  method === 'odm'
                    ? 'border-blue-600 bg-blue-50/20 dark:bg-blue-950/10'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}>
                  <input 
                    type="radio" 
                    name="method" 
                    value="odm" 
                    checked={method === 'odm'} 
                    onChange={() => setMethod('odm')}
                    className="sr-only"
                  />
                  <span className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                      <Layers className="w-4 h-4 text-blue-500" />
                      3-D Reconstruction (ODM)
                    </span>
                    <span className="text-[10px] uppercase font-bold tracking-wide px-2 py-0.5 rounded bg-blue-600/10 text-blue-500">Premium</span>
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Full structure-from-motion (SfM) photogrammetry pipeline. Processes in 10-30 minutes. High details, accurate elevations, but slower.
                  </span>
                </label>

              </div>

              {/* Georef Option Configuration */}
              {method === 'georef' && (
                <div className="p-5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-100 dark:border-slate-800/60 space-y-4 animate-in fade-in duration-200">
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-white">Georeference Settings</h4>
                  
                  {/* Dewarp Checkbox */}
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      id="modal-dewarp"
                      checked={dewarp}
                      onChange={(e) => setDewarp(e.target.checked)}
                      className="mt-0.5 w-4 h-4 text-emerald-600 border-slate-300 dark:border-slate-700 rounded focus:ring-emerald-500 cursor-pointer"
                    />
                    <div className="grid gap-0.5 select-none cursor-pointer" onClick={() => setDewarp(!dewarp)}>
                      <label htmlFor="modal-dewarp" className="text-xs font-semibold text-slate-800 dark:text-slate-200 cursor-pointer">
                        Apply Lens Dewarping (Recommended)
                      </label>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400">
                        Undistorts the wide-angle camera barrel profiles before projection to keep features straight.
                      </span>
                    </div>
                  </div>

                  <hr className="border-slate-200/60 dark:border-slate-800/60" />

                  {/* Altitude Mode Selection */}
                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-slate-800 dark:text-slate-200">Altitude Source Plane</label>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => setAltitudeMode('relative')}
                        className={`px-3 py-2 text-xs font-medium border rounded-lg transition-colors ${
                          altitudeMode === 'relative'
                            ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        Relative AGL
                      </button>
                      <button
                        type="button"
                        onClick={() => setAltitudeMode('lrf')}
                        className={`px-3 py-2 text-xs font-medium border rounded-lg transition-colors ${
                          altitudeMode === 'lrf'
                            ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        Laser Range Finder
                      </button>
                      <button
                        type="button"
                        onClick={() => setAltitudeMode('specified')}
                        className={`px-3 py-2 text-xs font-medium border rounded-lg transition-colors ${
                          altitudeMode === 'specified'
                            ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        Specify Height
                      </button>
                    </div>

                    {/* Mode Specific Offset Inputs */}
                    <div className="pt-2">
                      {altitudeMode === 'relative' && (
                        <div className="space-y-1.5 animate-in slide-in-from-top-1 duration-150">
                          <label className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                            Relative Takeoff Altitude Offset (meters)
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={altitudeOffset}
                            onChange={(e) => setAltitudeOffset(e.target.valueAsNumber || 0)}
                            className="px-3 py-1.5 text-xs w-36 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                          />
                          <p className="text-[10px] text-slate-400">
                            Offset added to takeoff AGL (positive moves projection up, expanding the footprint).
                          </p>
                        </div>
                      )}

                      {altitudeMode === 'lrf' && (
                        <div className="space-y-1.5 animate-in slide-in-from-top-1 duration-150">
                          <label className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                            Laser Range Finder (LRF) Offset / Z-offset (meters)
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={altitudeOffset}
                            onChange={(e) => setAltitudeOffset(e.target.valueAsNumber || 0)}
                            className="px-3 py-1.5 text-xs w-36 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                          />
                          <p className="text-[10px] text-slate-400">
                            Offset added to LRF tilt-compensated height (compensates for distance from sensor axis).
                          </p>
                        </div>
                      )}

                      {altitudeMode === 'specified' && (
                        <div className="space-y-1.5 animate-in slide-in-from-top-1 duration-150">
                          <label className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                            Fixed Projection AGL Altitude (meters)
                          </label>
                          <input
                            type="number"
                            step="0.5"
                            min="1"
                            value={specifiedAltitude}
                            onChange={(e) => setSpecifiedAltitude(e.target.valueAsNumber || 50)}
                            className="px-3 py-1.5 text-xs w-36 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                          />
                          <p className="text-[10px] text-slate-400">
                            Hardcode a flat height plane above the ground for all images.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  <hr className="border-slate-200/60 dark:border-slate-800/60" />

                  {/* Downsampling Select */}
                  <div className="space-y-1.5">
                    <label htmlFor="modal-sample-factor" className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Downsampling / Image Sampling Rate
                    </label>
                    <select
                      id="modal-sample-factor"
                      value={sampleFactor}
                      onChange={(e) => setSampleFactor(Number(e.target.value) || 1)}
                      className="px-3 py-1.5 text-xs w-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 cursor-pointer"
                    >
                      <option value="1">Use all images (1/1)</option>
                      <option value="2">Use 1 every 2 images (1/2)</option>
                      <option value="3">Use 1 every 3 images (1/3)</option>
                      <option value="5">Use 1 every 5 images (1/5)</option>
                      <option value="10">Use 1 every 10 images (1/10)</option>
                    </select>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">
                      Processes only every Nth image to speed up draft georeferences. The first and last images are always processed.
                    </p>
                  </div>

                </div>
              )}

              {startError && (
                <div className="flex items-center gap-2 p-3 text-xs text-red-600 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/30 rounded-xl">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{startError}</span>
                </div>
              )}
            </div>
          ) : (
            /* Active Processing Screen */
            <div className="space-y-6 animate-in fade-in duration-200">
              
              {/* Progress Summary Card */}
              <div className="p-5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-200/60 dark:border-slate-800 flex items-center justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold tracking-wide uppercase px-2 py-0.5 rounded-full ${STATUS_BADGE[task.status]}`}>
                      {task.status}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400 capitalize font-medium">
                      {task.type === 'odm' ? '3-D Reconstruction' : 'Quick Georeference'}
                    </span>
                  </div>
                  <h4 className="text-base font-semibold text-slate-900 dark:text-white">
                    {task.status === 'uploading' && 'Uploading flight images…'}
                    {task.status === 'queued' && 'Task queued in processing node…'}
                    {task.status === 'running' && 'Processing images & assembling tiles…'}
                    {task.status === 'completed' && 'Processing completed successfully!'}
                    {task.status === 'failed' && 'Task processing failed'}
                    {task.status === 'canceled' && 'Task canceled by user'}
                  </h4>
                  {task.totalImages && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {task.status === 'uploading' ? `Uploaded ${task.uploadedImages} of ${task.totalImages} images` : `Processed ${task.uploadedImages} of ${task.totalImages} images`}
                    </p>
                  )}
                </div>

                <div className="flex flex-col items-end gap-1 font-mono text-xs text-slate-500">
                  {task.processingTime > 0 && (
                    <span>Duration: {formatDuration(task.processingTime)}</span>
                  )}
                  {isActive && (
                    <button
                      onClick={handleCancel}
                      disabled={cancelling}
                      className="px-3 py-1 bg-transparent hover:bg-red-50 dark:hover:bg-red-950/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/30 rounded-md font-semibold text-[10px] disabled:opacity-40 transition-colors cursor-pointer"
                    >
                      {cancelling ? 'Cancelling…' : 'Cancel Task'}
                    </button>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              {(task.status === 'running' || task.status === 'uploading' || task.status === 'queued' || task.status === 'pending') && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500 dark:text-slate-400 font-medium">Overall Progress</span>
                    <span className="font-semibold text-slate-900 dark:text-white">{Math.round(task.progress)}%</span>
                  </div>
                  <div className="h-3 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden relative">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        task.type === 'odm' ? 'bg-gradient-to-r from-blue-500 to-indigo-600' : 'bg-gradient-to-r from-emerald-500 to-teal-600'
                      }`}
                      style={{ width: `${Math.max(3, task.progress)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Logs display */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-700 dark:text-slate-300 font-semibold flex items-center gap-1.5">
                    Console Logs
                  </span>
                  {isActive && (
                    <span className="flex items-center gap-1 text-[10px] text-slate-400 animate-pulse">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Streaming logs…
                    </span>
                  )}
                </div>
                <pre
                  ref={logRef}
                  className="font-mono text-[11px] text-emerald-400 bg-slate-950 p-4 rounded-xl max-h-80 overflow-y-auto whitespace-pre-wrap leading-relaxed shadow-inner border border-slate-900"
                >
                  {task.output.length > 0 ? task.output.join('\n') : (isActive ? 'Connecting to logs stream…' : 'No logs recorded.')}
                </pre>
              </div>

              {/* Finished outputs actions */}
              {task.status === 'completed' && (task.outputKey || task.reportKey) && (
                <div className="p-4 bg-emerald-50 dark:bg-emerald-950/10 rounded-xl border border-emerald-100 dark:border-emerald-900/30 flex items-center gap-3">
                  {task.outputKey && (
                    <button
                      onClick={() => openPresignedUrl(task.outputKey!, true)}
                      className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-sm transition-colors"
                    >
                      ⬇️ Download Orthomap (GeoTIFF)
                    </button>
                  )}
                  {task.reportKey && (
                    <button
                      onClick={() => openPresignedUrl(task.reportKey!)}
                      className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg shadow-sm transition-colors dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700 dark:hover:bg-slate-700"
                    >
                      📄 View Processing Report
                    </button>
                  )}
                </div>
              )}

              {/* Error Alert */}
              {task.status === 'failed' && task.error && (
                <div className="p-4 bg-red-50 dark:bg-red-950/15 border border-red-100 dark:border-red-900/35 rounded-xl text-xs text-red-650 flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <span className="font-semibold">Error Message</span>
                    <p className="font-mono bg-slate-950/5 dark:bg-slate-950/20 p-2 rounded border border-red-200/50 dark:border-red-900/10">{task.error}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 dark:bg-slate-800/40 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="text-xs text-slate-400">
            {isActive ? 'Processing is lock-held to prevent double execution.' : 'You can change parameters and reprocess at any time.'}
          </div>
          <div className="flex gap-2">
            {!task ? (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={startProcessing}
                  disabled={starting}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 rounded-lg shadow-sm transition-all flex items-center gap-1.5"
                >
                  {starting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Contacting Node…</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Start Processing</span>
                    </>
                  )}
                </button>
              </>
            ) : (
              <>
                {!isActive && (
                  <button
                    type="button"
                    onClick={() => {
                      setTask(null)
                      setStartError(null)
                    }}
                    className="px-4 py-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Run New Processing</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-700 hover:bg-slate-800 rounded-lg shadow-sm transition-colors"
                >
                  Close
                </button>
              </>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
