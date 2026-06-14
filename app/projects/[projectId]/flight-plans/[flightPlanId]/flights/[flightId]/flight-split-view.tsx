'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { MapIcon, ImageIcon, DownloadIcon, ArrowLeft, Maximize2, RefreshCw } from 'lucide-react'
import FlightUploader from './flight-uploader'
import FileLightbox from './file-lightbox'
import EditFlightButton from './edit-flight-button'
import OrthoMap from './ortho-map'
import ProcessingModal from './processing-modal'
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

function isImage(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
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
}: FlightSplitViewProps) {
  const router = useRouter()
  const [sidebarWidth, setSidebarWidth] = useState(500)
  const [zoomTrigger, setZoomTrigger] = useState(0)
  const [activeTab, setActiveTab] = useState<'map' | 'images'>(geotiffKey ? 'map' : 'images')
  const isResizingRef = useRef(false)

  const [isModalOpen, setIsModalOpen] = useState(false)

  // Refresh page data on mount to bypass client-side router cache
  useEffect(() => {
    router.refresh()
  }, [router])

  // Unified task logic
  const latestOdm = latestOdmTask ? { ...latestOdmTask, type: 'odm' as const, error: null as string | null } : null
  const latestGeoref = latestGeorefTask ? { ...latestGeorefTask, type: 'georef' as const } : null

  const activeOdm = latestOdm && !['completed', 'failed', 'canceled'].includes(latestOdm.status) ? latestOdm : null
  const activeGeoref = latestGeoref && !['completed', 'failed', 'canceled'].includes(latestGeoref.status) ? latestGeoref : null

  const activeTask = activeOdm || activeGeoref
  const latestTask = activeTask || 
    ((latestOdm && latestGeoref) 
      ? (new Date(latestOdm.createdAt) > new Date(latestGeoref.createdAt) ? latestOdm : latestGeoref)
      : (latestOdm || latestGeoref || null))

  // Live polling for sidebar status when a task is active
  const [activeTaskState, setActiveTaskState] = useState<{
    status: string
    processed: number
    total: number
    progress?: number
    outputKey?: string | null
    reportKey?: string | null
  } | null>(null)

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
        const progress = data.progress ?? (data.status === 'completed' ? 100 : (t > 0 ? (p / t) * 100 : 0))

        setActiveTaskState((prev) => {
          const finalProcessed = Math.max(p, prev ? prev.processed : 0)
          const finalTotal = t > 0 ? t : (prev ? prev.total : 0)
          const calculatedProgress = finalTotal > 0 ? (finalProcessed / finalTotal) * 100 : 0
          const finalProgress = Math.max(
            data.progress ?? (data.status === 'completed' ? 100 : calculatedProgress),
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

  // Image list filtering
  const images = displayObjects.filter((o) => isImage(o.key))
  const [activeImage, setActiveImage] = useState<FileEntry | null>(images[0] ?? null)

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
  const processed = activeTaskState?.processed ?? 0
  const progress = activeTaskState?.progress ?? (total > 0 ? (processed / total) * 100 : 0)
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
                href={`/projects/${projectId}/flight-plans/${flightPlanId}/flights`}
                className="p-1 hover:bg-gray-100 rounded-md transition-colors text-gray-500 hover:text-gray-900 mt-0.5 flex-shrink-0"
                title={`Back to ${flightPlan.name}`}
              >
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div>
                <h1 className="text-xl font-semibold text-gray-900 leading-tight">
                  {formattedTime}
                </h1>
                <p className="text-[10px] text-gray-400 mt-1 font-mono">
                  {flight.timestamp.toISOString()}
                </p>
                {flight.notes && <p className="text-sm text-gray-500 mt-2">{flight.notes}</p>}
              </div>
            </div>
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


        {/* File list */}
        <section className="border-t border-gray-100 pt-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">All Flight Files</h2>
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <FileLightbox
              files={displayObjects}
              timezone={project.timezone}
              canWrite={canWrite}
              onImageClick={(file) => {
                setActiveTab('images')
                setActiveImage(file)
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
        <div className="flex items-center justify-between px-6 bg-white border-b border-gray-200 h-12 flex-shrink-0 z-25">
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
              Flight Images ({images.length})
            </button>
          </div>
          {activeTab === 'map' && (
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
          )}
        </div>

        {/* Tab Contents */}
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {/* Map Tab */}
          {activeTab === 'map' && (
            <div className="w-full h-full relative">
              <OrthoMap
                outputKey={geotiffKey}
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
                    setActiveTab('images')
                    setActiveImage(found)
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
              />
            </div>
          )}

          {/* Images Tab */}
          {activeTab === 'images' && (
            <div className="w-full h-full flex flex-col overflow-hidden">
              {images.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-400 p-8">
                  <span className="text-4xl mb-2">📸</span>
                  <p className="text-sm font-medium">No images uploaded to S3 yet.</p>
                </div>
              ) : (
                <>
                  {/* Large Viewport Area */}
                  {activeImage && (
                    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-gray-950">
                      {/* Active Image Header Bar */}
                      <div className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between text-gray-200 flex-shrink-0">
                        <div className="min-w-0">
                          <h3 className="text-sm font-mono font-medium truncate">
                            {activeImage.key.split('/').pop()}
                          </h3>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-gray-400">
                          <span>{formatBytes(activeImage.size)}</span>
                          {activeImageDownloadUrl && (
                            <a
                              href={activeImageDownloadUrl}
                              className="text-gray-300 hover:text-white flex items-center gap-1 font-medium transition-colors"
                            >
                              <DownloadIcon className="w-3.5 h-3.5" /> Download
                            </a>
                          )}
                        </div>
                      </div>

                      {/* Interactive Viewport */}
                      <div className="flex-1 min-h-0 flex items-center justify-center p-4 relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          key={activeImage.key}
                          src={thumbnailUrl(activeImage.key, activeImage.etag, 1200)}
                          alt={activeImage.key.split('/').pop()}
                          className="max-w-full max-h-full object-contain shadow-2xl rounded"
                        />
                      </div>

                      {/* Split Selection / Metadata Footer */}
                      <div className="bg-gray-900 border-t border-gray-800 px-6 py-3 flex items-center justify-between text-gray-300 flex-shrink-0">
                        <div className="flex items-center gap-3">
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
                          Last Modified: {new Date(activeImage.lastModifiedIso).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Bottom Filmstrip Selector */}
                  <div className="h-40 border-t border-gray-200 bg-white flex-shrink-0 flex flex-col min-h-0">
                    <div className="flex-1 flex gap-3 overflow-x-auto p-3">
                      {images.map((img) => {
                        const isSelected = activeImage?.key === img.key
                        const filename = img.key.split('/').pop() ?? img.key
                        return (
                          <button
                            key={img.key}
                            onClick={() => setActiveImage(img)}
                            className={cn(
                              'w-36 flex-shrink-0 text-left rounded-lg overflow-hidden border p-1 transition-all flex flex-col justify-between',
                              isSelected
                                ? 'border-blue-500 bg-blue-50/20 ring-1 ring-blue-500'
                                : 'border-gray-200 hover:border-gray-300'
                            )}
                          >
                            <div className="w-full flex-1 min-h-0 bg-gray-100 overflow-hidden rounded mb-1 relative">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={thumbnailUrl(img.key, img.etag, 320)}
                                alt=""
                                className="w-full h-full object-cover"
                                loading="lazy"
                              />
                            </div>
                            <span className="text-[9px] font-mono text-gray-600 block truncate px-0.5 select-none">
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
      {isModalOpen && (
        <ProcessingModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          flightId={flightId}
          projectId={projectId}
          flightPlanId={flightPlanId}
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
                }
              : null
          }
        />
      )}
    </div>
  )
}
