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
import OdmPanel from './odm-panel'
import OrthoMap from './ortho-map'
import { assignFileSplit, syncFlightFiles } from '@/app/actions/files'
import type { Split, flights, flightPlans, projects, odmTasks } from '@/lib/schema'
import type { InferSelectModel } from 'drizzle-orm'

type Flight = InferSelectModel<typeof flights>
type FlightPlan = InferSelectModel<typeof flightPlans>
type Project = InferSelectModel<typeof projects>
type OdmTask = InferSelectModel<typeof odmTasks>

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

function isImage(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
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

        {/* ODM Control Panel */}
        {canWrite && (
          <section className="border-t border-gray-100 pt-4">
            <OdmPanel
              key={latestOdmTask?.id ?? 'no-task'}
              flightId={flightId}
              projectId={projectId}
              flightPlanId={flightPlanId}
              initialTask={
                latestOdmTask
                  ? {
                    taskId: latestOdmTask.id,
                    odmUuid: latestOdmTask.odmUuid,
                    status: latestOdmTask.status,
                    outputKey: latestOdmTask.outputKey ?? null,
                    reportKey: latestOdmTask.reportKey ?? null,
                  }
                  : null
              }
            />
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
              disabled={!geotiffKey}
              className={cn(
                'flex items-center gap-1.5 px-1 h-full text-sm font-medium border-b-2 transition-colors',
                !geotiffKey && 'text-gray-300 cursor-not-allowed',
                geotiffKey && activeTab === 'map'
                  ? 'border-blue-600 text-blue-600'
                  : geotiffKey && 'border-transparent text-gray-500 hover:text-gray-800'
              )}
            >
              <MapIcon className="w-4 h-4" />
              Orthophoto Map
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
          {activeTab === 'map' && geotiffKey && (
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
          {activeTab === 'map' && geotiffKey && (
            <div className="w-full h-full relative">
              <OrthoMap
                outputKey={geotiffKey}
                fitBoundsTrigger={zoomTrigger}
                className="h-full w-full rounded-none border-none"
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
    </div>
  )
}
