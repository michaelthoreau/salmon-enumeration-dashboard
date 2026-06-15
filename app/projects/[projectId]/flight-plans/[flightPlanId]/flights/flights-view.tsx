'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ExternalLink, Layers, CheckCircle2, AlertCircle, PlayCircle, ImageMinus, Maximize2, Sliders } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import OrthoMap from './[flightId]/ortho-map'
import CompareMap from './[flightId]/compare-map'
import EditFlightButton from './[flightId]/edit-flight-button'
import { DeleteFlightButton } from './flight-actions'
import CreateFlightForm from './create-flight-form'
import type { OdmTaskStatus, GeorefTaskStatus } from '@/lib/schema'
import type { InferSelectModel } from 'drizzle-orm'
import type { flights } from '@/lib/schema'

type Flight = InferSelectModel<typeof flights>

export interface FlightRow {
  flight: Flight
  formattedTime: string
  localTimestamp: string
  imageCount: number
  taskStatus: OdmTaskStatus | GeorefTaskStatus | null
  outputKey: string | null
  taskCompletedAt?: Date | null
}

interface Props {
  rows: FlightRow[]
  projectId: string
  flightPlanId: string
  timezone: string
  canWrite: boolean
  projectName: string
  flightPlan: {
    name: string
    description: string | null
  }
  from?: string
}

function StatusBadge({ status, imageCount }: { status: OdmTaskStatus | GeorefTaskStatus | null; imageCount: number }) {
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-green-50 border border-green-200 px-2 py-0.5 text-xs text-green-700 font-medium">
        <CheckCircle2 className="w-3 h-3 text-green-500" />
        <span>Map Ready</span>
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-blue-700 font-medium animate-pulse">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
        <span>Running</span>
      </span>
    )
  }
  if (status === 'queued' || status === 'uploading' || status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs text-amber-700 font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping" />
        <span>Queued</span>
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-red-50 border border-red-200 px-2 py-0.5 text-xs text-red-700 font-medium">
        <AlertCircle className="w-3.5 h-3.5 text-red-500" />
        <span>Failed</span>
      </span>
    )
  }
  if (status === 'canceled') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs text-gray-500 font-medium">
        <span>Canceled</span>
      </span>
    )
  }
  if (imageCount > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-purple-50 border border-purple-200 px-2 py-0.5 text-xs text-purple-700 font-medium">
        <PlayCircle className="w-3 h-3 text-purple-500" />
        <span>Ready to Process</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs text-gray-400 font-medium">
      <ImageMinus className="w-3 h-3 text-gray-300" />
      <span>No Images</span>
    </span>
  )
}

export default function FlightsView({
  rows,
  projectId,
  flightPlanId,
  timezone,
  canWrite,
  projectName,
  flightPlan,
  from,
}: Props) {
  const router = useRouter()
  const [sidebarWidth, setSidebarWidth] = useState(500)
  const [zoomTrigger, setZoomTrigger] = useState(0)
  const isResizingRef = useRef(false)

  // Refresh page data on mount to bypass client-side router cache
  useEffect(() => {
    router.refresh()
  }, [router])

  // Default to first flight, prioritizing the one with an orthophoto if possible
  const firstWithOrtho = rows.find((r) => r.outputKey)
  const defaultSelected = firstWithOrtho?.flight.id ?? rows[0]?.flight.id ?? null
  const [selectedId, setSelectedId] = useState<string | null>(defaultSelected)

  // Track map viewport center/zoom to prevent jumping on mode toggle
  const [viewport, setViewport] = useState<{ center: [number, number]; zoom: number } | null>(null)

  // ── Compare Mode State ─────────────────────────────────────────────────────
  const flightsWithOrtho = rows
    .filter((r) => r.outputKey)
    .map((r) => ({
      flightId: r.flight.id,
      formattedTime: r.formattedTime,
      outputKey: r.outputKey!,
      cacheBuster: r.taskCompletedAt ? new Date(r.taskCompletedAt).getTime().toString() : null,
    }))

  const [isCompareMode, setIsCompareMode] = useState(false)
  const [compareAId, setCompareAId] = useState<string | null>(null)
  const [compareBId, setCompareBId] = useState<string | null>(null)

  const handleEnableCompare = () => {
    setIsCompareMode(true)
    const baseId = selectedId || flightsWithOrtho[0]?.flightId || null
    setCompareAId(baseId)
    const otherFlight = flightsWithOrtho.find((f) => f.flightId !== baseId)
    setCompareBId(otherFlight?.flightId || null)
  }

  const handleCompareAChange = (id: string) => {
    setCompareAId(id)
    if (id !== 'none') {
      setSelectedId(id)
    }
  }

  // Sync selectedId to compareAId (left map) when in compare mode
  useEffect(() => {
    if (isCompareMode && selectedId && selectedId !== compareAId) {
      setCompareAId(selectedId)
    }
  }, [selectedId, isCompareMode, compareAId])

  // Sync selectedId when rows list changes
  useEffect(() => {
    if (selectedId && !rows.some((r) => r.flight.id === selectedId)) {
      const firstWithOrtho = rows.find((r) => r.outputKey)
      setSelectedId(firstWithOrtho?.flight.id ?? rows[0]?.flight.id ?? null)
    } else if (!selectedId && rows.length > 0) {
      const firstWithOrtho = rows.find((r) => r.outputKey)
      setSelectedId(firstWithOrtho?.flight.id ?? rows[0]?.flight.id ?? null)
    }
  }, [rows, selectedId])

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

  const selected = rows.find((r) => r.flight.id === selectedId)

  return (
    <div className="fixed top-[100px] bottom-0 left-0 right-0 z-10 bg-gray-50 flex overflow-hidden border-t border-gray-200">
      {/* ─── Left Sidebar ─── */}
      <aside
        style={{ width: `${sidebarWidth}px` }}
        className="h-full overflow-y-auto no-scrollbar border-r border-gray-200 bg-white p-6 space-y-6 flex-shrink-0 flex flex-col"
      >
        {/* Flight Plan Header */}
        <div className="flex items-start gap-2 -ml-1">
          <Link
            href={from === 'list' ? `/projects/${projectId}/flight-plans` : `/projects/${projectId}`}
            className="p-1 hover:bg-gray-100 rounded-md transition-colors text-gray-500 hover:text-gray-900 mt-0.5 flex-shrink-0"
            title={from === 'list' ? 'Back to flight plans' : 'Back to project dashboard'}
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-xl font-semibold text-gray-900 leading-tight">
              {flightPlan.name}
            </h1>
            {flightPlan.description && (
              <p className="text-sm text-gray-500 mt-2">{flightPlan.description}</p>
            )}
          </div>
        </div>

        {/* Log Flight Button */}
        {canWrite && (
          <div className="border-t border-gray-100 pt-4">
            <CreateFlightForm
              projectId={projectId}
              flightPlanId={flightPlanId}
              timezone={timezone}
              className="w-full justify-center"
            />
          </div>
        )}

        {/* Flights List */}
        <section className="border-t border-gray-100 pt-4 flex-1 flex flex-col min-h-0">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Flights ({rows.length})
          </h2>
          <div className="flex-1 overflow-y-auto no-scrollbar space-y-3 pr-1 pb-4">
            {rows.length === 0 ? (
              <div className="text-center py-8 text-gray-400 border border-dashed border-gray-200 rounded-xl">
                <span className="text-2xl block mb-1">✈️</span>
                <p className="text-sm font-medium">No flights logged yet.</p>
                {canWrite && (
                  <p className="text-xs text-gray-500 mt-1">Use the button above to log your first flight.</p>
                )}
              </div>
            ) : (
              rows.map((row) => {
                const isSelected = row.flight.id === selectedId

                return (
                  <div
                    key={row.flight.id}
                    onClick={() => setSelectedId(row.flight.id)}
                    className={cn(
                      "group relative rounded-xl border p-4 cursor-pointer transition-all flex flex-col space-y-3",
                      isSelected
                        ? "border-blue-500 bg-blue-50/10 shadow-sm ring-1 ring-blue-500"
                        : "border-gray-200 hover:border-gray-300 bg-white"
                    )}
                  >
                    {/* Card Header with Timestamp & Actions */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-semibold text-sm text-gray-900 block">
                          {row.formattedTime}
                        </span>
                        <p className="text-[10px] text-gray-400 mt-0.5 font-mono">
                          {new Date(row.flight.timestamp).toISOString()}
                        </p>
                      </div>

                      {/* Actions (Edit/Delete) */}
                      <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                        {canWrite && (
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <EditFlightButton
                              flightId={row.flight.id}
                              projectId={projectId}
                              flightPlanId={flightPlanId}
                              timezone={timezone}
                              localTimestamp={row.localTimestamp}
                              currentNotes={row.flight.notes}
                            />
                            <DeleteFlightButton
                              flight={row.flight}
                              projectId={projectId}
                              flightPlanId={flightPlanId}
                            />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Notes */}
                    {row.flight.notes && (
                      <p className="text-xs text-gray-500 line-clamp-2">
                        {row.flight.notes}
                      </p>
                    )}

                    {/* Metadata Badges & Open Action */}
                    <div className="flex items-center justify-between gap-2 mt-auto pt-1">
                      <div className="flex flex-wrap gap-2 items-center text-xs">
                        {/* Image count */}
                        <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs text-gray-600 font-medium">
                          <Layers className="w-3.5 h-3.5 text-gray-400" />
                          <span>{row.imageCount} images</span>
                        </span>

                        {/* Status badge */}
                        <StatusBadge status={row.taskStatus} imageCount={row.imageCount} />
                      </div>

                      {/* Open Details Link */}
                      <div onClick={(e) => e.stopPropagation()}>
                        <Link
                          href={`/projects/${projectId}/flight-plans/${flightPlanId}/flights/${row.flight.id}${from ? `?from=${from}` : ''}`}
                          className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), "gap-1 text-[11px] px-2 py-0.5")}
                        >
                          <span>Open</span>
                          <ExternalLink className="w-3 h-3 text-gray-400" />
                        </Link>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>
      </aside>

      {/* ─── Drag Resizer Handle ─── */}
      <div
        className="w-1 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors h-full flex-shrink-0 z-20"
        onMouseDown={startResizing}
      />

      {/* ─── Right Panel ─── */}
      <main className="flex-1 h-full bg-gray-50 flex flex-col overflow-hidden relative">
        {/* Top Header Bar */}
        <div className="flex items-center justify-between px-6 bg-white border-b border-gray-200 h-12 flex-shrink-0 z-20">
          <span className="text-sm font-medium text-gray-700">Orthophoto Map Preview</span>
          {flightsWithOrtho.length >= 2 && !isCompareMode && (
            <button
              onClick={handleEnableCompare}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), "gap-1.5 text-xs h-8")}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Compare Flights</span>
            </button>
          )}
        </div>

        {/* Map or Fallback Viewport */}
        <div className="flex-1 min-h-0 relative">
          {isCompareMode && compareAId && compareBId ? (
            <CompareMap
              key="compare-viewport"
              flightAId={compareAId}
              flightBId={compareBId}
              flightsWithOrtho={flightsWithOrtho}
              initialViewport={viewport}
              onFlightAChange={handleCompareAChange}
              onFlightBChange={setCompareBId}
              onExit={() => setIsCompareMode(false)}
            />
          ) : selected ? (
            selected.outputKey ? (
              <div key="single-viewport" className="w-full h-full relative">
                <OrthoMap
                  outputKey={selected.outputKey}
                  cacheBuster={selected.taskCompletedAt ? new Date(selected.taskCompletedAt).getTime().toString() : null}
                  fitBoundsTrigger={zoomTrigger}
                  onViewportChange={setViewport}
                  className="h-full w-full rounded-none border-none"
                />
                {/* Floating card at top-left */}
                <div className="absolute top-4 left-4 z-30 bg-white p-4 rounded-xl shadow-lg border border-gray-200 max-w-sm space-y-3">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-sm">{selected.formattedTime}</h3>
                    {selected.flight.notes && (
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">{selected.flight.notes}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setZoomTrigger((prev) => prev + 1)}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), "gap-1.5 text-xs flex-1 justify-center")}
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      <span>Zoom to Flight</span>
                    </button>
                    <Link
                      href={`/projects/${projectId}/flight-plans/${flightPlanId}/flights/${selected.flight.id}${from ? `?from=${from}` : ''}`}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), "gap-1.5 text-xs flex-1 justify-center")}
                    >
                      <span>Open Details</span>
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                  </div>
                </div>
              </div>
            ) : (
              <div className="w-full h-full bg-gray-50 flex items-center justify-center p-6">
                <div className="max-w-md w-full bg-white rounded-2xl border border-gray-200 shadow-md p-8 text-center space-y-6">
                  <div className="mx-auto w-12 h-12 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center">
                    <Layers className="w-6 h-6" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold text-gray-900">No Orthophoto Map</h3>
                    <p className="text-sm text-gray-500">
                      {selected.imageCount === 0
                        ? "This flight has no images uploaded yet. Upload images and process them with ODM to generate an orthophoto map."
                        : selected.taskStatus === 'running'
                        ? "ODM is currently processing the images for this flight. The map will be available once processing completes."
                        : selected.taskStatus === 'failed'
                        ? "The last ODM task for this flight failed. You can retry processing or check the logs."
                        : selected.taskStatus === 'queued' || selected.taskStatus === 'uploading'
                        ? "An ODM task is queued for this flight. The map will generate once it runs."
                        : "Images are uploaded, but no ODM task has been run yet."}
                    </p>
                  </div>
                  <div className="pt-2">
                    <Link
                      href={`/projects/${projectId}/flight-plans/${flightPlanId}/flights/${selected.flight.id}${from ? `?from=${from}` : ''}`}
                      className={cn(buttonVariants({ variant: 'default' }), "gap-1.5 w-full justify-center")}
                    >
                      <span>Open Flight Details to {selected.imageCount === 0 ? "Upload" : "Process"}</span>
                      <ExternalLink className="w-4 h-4" />
                    </Link>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="w-full h-full bg-gray-50 flex items-center justify-center p-6">
              <div className="max-w-md text-center space-y-4">
                <div className="mx-auto w-12 h-12 bg-gray-100 text-gray-400 rounded-full flex items-center justify-center">
                  <Layers className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-gray-900">Select a Flight</h3>
                  <p className="text-sm text-gray-500">
                    {rows.length === 0
                      ? "Log a new flight in the sidebar to get started."
                      : "Choose a flight from the sidebar list to view its orthophoto map."}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
