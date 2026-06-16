'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Calendar, Layers, ArrowRight, CheckCircle2, AlertCircle, Sparkles, Pin, PinOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import { highlightFlight } from '@/app/actions/projects'


interface FlightRow {
  id: string
  flightPlanId: string
  flightPlanName: string
  flightPlanLocation: string | null
  timestamp: Date
  notes: string | null
  imageCount: number
  taskStatus: 'uploading' | 'queued' | 'running' | 'failed' | 'completed' | 'canceled' | null
  outputKey: string | null
}

interface Props {
  projectId: string
  projectName: string
  timezone: string
  flightPlans: any[]
  flights: FlightRow[]
  datesWithFlights: string[]
  initialDate: string
  canWrite: boolean
  isAdmin: boolean
  highlightedFlightId: string | null
}

function getLocalDateStr(date: Date | string, tz: string): string {
  const dObj = typeof date === 'string' ? new Date(date) : date
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dObj)
  const y = parts.find((p) => p.type === 'year')!.value
  const m = parts.find((p) => p.type === 'month')!.value
  const d = parts.find((p) => p.type === 'day')!.value
  return `${y}-${m}-${d}`
}

function formatTimeOnly(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function formatLongDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function StatusBadge({ status, imageCount }: { status: string | null; imageCount: number }) {
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-green-50 border border-green-200 px-2 py-0.5 text-[11px] text-green-700 font-medium">
        <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
        <span>Map Ready</span>
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 border border-blue-200 px-2 py-0.5 text-[11px] text-blue-700 font-medium animate-pulse">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
        <span>Running</span>
      </span>
    )
  }
  if (status === 'queued' || status === 'uploading' || status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] text-amber-700 font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping" />
        <span>Queued</span>
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-red-50 border border-red-200 px-2 py-0.5 text-[11px] text-red-700 font-medium">
        <AlertCircle className="w-3.5 h-3.5 text-red-500" />
        <span>Failed</span>
      </span>
    )
  }
  if (imageCount > 0) {
    return null
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-[11px] text-gray-400 font-medium">
      <span>No Images</span>
    </span>
  )
}



export default function TodayFlightsView({
  projectId,
  projectName,
  timezone,
  flightPlans,
  flights,
  datesWithFlights,
  initialDate,
  canWrite,
  isAdmin,
  highlightedFlightId,
}: Props) {
  const [selectedDate, setSelectedDate] = useState(initialDate)
  const [currentHighlightIds, setCurrentHighlightIds] = useState<string[]>(
    highlightedFlightId ? highlightedFlightId.split(',').filter(Boolean) : []
  )

  useEffect(() => {
    setCurrentHighlightIds(
      highlightedFlightId ? highlightedFlightId.split(',').filter(Boolean) : []
    )
  }, [highlightedFlightId])

  const handleToggleHighlight = async (flightId: string) => {
    const isCurrentlyHighlighted = currentHighlightIds.includes(flightId)
    let nextIds = [...currentHighlightIds]

    if (isCurrentlyHighlighted) {
      nextIds = nextIds.filter((id) => id !== flightId)
    } else {
      nextIds.push(flightId)
      if (nextIds.length > 2) {
        nextIds.shift() // Keep max 2, remove oldest
      }
    }

    const previousIds = currentHighlightIds
    setCurrentHighlightIds(nextIds)

    try {
      const nextValue = nextIds.length > 0 ? nextIds.join(',') : null
      const res = await highlightFlight(projectId, nextValue)
      if (res.error) {
        setCurrentHighlightIds(previousIds)
        alert(res.error)
      }
    } catch (err) {
      setCurrentHighlightIds(previousIds)
      alert('Failed to update highlighted flights: ' + String(err))
    }
  }


  const isToday = selectedDate === initialDate
  const yesterdayDate = (() => {
    const [y, m, d] = initialDate.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    date.setDate(date.getDate() - 1)
    const newY = date.getFullYear()
    const newM = String(date.getMonth() + 1).padStart(2, '0')
    const newD = String(date.getDate()).padStart(2, '0')
    return `${newY}-${newM}-${newD}`
  })()
  const now = new Date()
  const last24hMs = 24 * 60 * 60 * 1000

  // Filter flights matching the selected local date (or last 24h if looking at today's default view)
  const filteredFlights = flights.filter((f) => {
    if (isToday) {
      const diff = now.getTime() - new Date(f.timestamp).getTime()
      return diff >= 0 && diff <= last24hMs
    } else {
      return getLocalDateStr(f.timestamp, timezone) === selectedDate
    }
  })

  // Helper to adjust selected date by days
  const adjustDate = (days: number) => {
    const [y, m, d] = selectedDate.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    date.setDate(date.getDate() + days)
    const newY = date.getFullYear()
    const newM = String(date.getMonth() + 1).padStart(2, '0')
    const newD = String(date.getDate()).padStart(2, '0')
    setSelectedDate(`${newY}-${newM}-${newD}`)
  }

  const highlightedFlights = flights.filter((f) => currentHighlightIds.includes(f.id))

  // ── Stats Calculations ─────────────────────────────────────────────────────
  const totalFlights = filteredFlights.length
  const totalImages = filteredFlights.reduce((acc, curr) => acc + curr.imageCount, 0)
  const completedMaps = filteredFlights.filter((f) => f.taskStatus === 'completed').length
  const pendingProcessing = filteredFlights.filter((f) =>
    ['queued', 'running', 'uploading'].includes(f.taskStatus || '')
  ).length



  return (
    <div className="space-y-6">
      {/* Upper Calendar Navigation Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-gray-200">
        <div>
          <h1 className="text-xl font-bold text-gray-900 leading-tight">Recent Flights</h1>
          <p className="text-xs text-gray-550 mt-1">
            {selectedDate === initialDate
              ? 'Logged flights and processing queues for Today (last 24 hours)'
              : selectedDate === yesterdayDate
              ? 'Logged flights and processing queues for Yesterday'
              : `Logged flights and processing queues for ${formatLongDate(selectedDate)}`}
          </p>
        </div>

        {/* Date Selector Navigation Controls */}
        <div className="flex items-center gap-1.5 self-start sm:self-auto bg-white border border-gray-200 rounded-xl p-1.5 shadow-sm">
          <button
            onClick={() => adjustDate(-1)}
            className="p-1.5 rounded-lg hover:bg-gray-50 text-gray-500 transition-colors"
            title="Previous Day"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          
          <div className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 rounded-lg cursor-pointer transition-colors relative">
            <Calendar className="w-4 h-4 text-gray-400" />
            <span className="font-mono">
              {selectedDate === initialDate
                ? 'Today'
                : selectedDate === yesterdayDate
                ? 'Yesterday'
                : selectedDate}
            </span>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            />
          </div>

          <button
            onClick={() => adjustDate(1)}
            className="p-1.5 rounded-lg hover:bg-gray-50 text-gray-500 transition-colors"
            title="Next Day"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {highlightedFlights.length > 0 && (
        <div className={cn(
          "grid gap-4",
          highlightedFlights.length === 2 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
        )}>
          {highlightedFlights.map((highlightedFlight) => (
            <div key={highlightedFlight.id} className="relative overflow-hidden rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50/30 via-white to-blue-50/10 p-5 sm:p-6 shadow-sm transition-all">
              <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 rounded-bl-full pointer-events-none" />
              <div className="flex flex-col justify-between h-full gap-4 relative z-10">
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-blue-600 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-lg select-none">
                      <Sparkles className="w-3.5 h-3.5 text-yellow-500 fill-yellow-500 animate-pulse" />
                      Featured Flight Route
                    </span>
                    {isAdmin && (
                      <button
                        onClick={() => handleToggleHighlight(highlightedFlight.id)}
                        className="inline-flex items-center gap-1 text-[10px] font-semibold text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                        title="Remove Highlight"
                      >
                        <PinOff className="w-3.5 h-3.5" />
                        <span>Clear Feature</span>
                      </button>
                    )}
                  </div>
                  <h2 className="text-xl font-bold text-gray-900 leading-snug">
                    {highlightedFlight.flightPlanName}
                  </h2>
                  {highlightedFlight.notes && (
                    <p className="text-sm text-gray-600 leading-relaxed line-clamp-2" title={highlightedFlight.notes}>
                      {highlightedFlight.notes}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                    <span className="font-semibold text-gray-700">
                      {formatLongDate(getLocalDateStr(highlightedFlight.timestamp, timezone))}
                    </span>
                    <span className="text-gray-300">•</span>
                    <span className="font-mono">
                      {formatTimeOnly(highlightedFlight.timestamp, timezone)} local time
                    </span>
                    <span className="text-gray-300">•</span>
                    <span>{highlightedFlight.imageCount} images</span>
                    <span className="text-gray-300">•</span>
                    <StatusBadge status={highlightedFlight.taskStatus} imageCount={highlightedFlight.imageCount} />
                  </div>
                </div>
                
                <div className="flex items-center gap-2 mt-2">
                  <Link
                    href={`/projects/${projectId}/flight-plans/${highlightedFlight.flightPlanId}/flights/${highlightedFlight.id}?returnTo=${encodeURIComponent(`/projects/${projectId}`)}`}
                    className={cn(
                      buttonVariants({ variant: 'default', size: 'lg' }),
                      "bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-sm text-xs font-semibold gap-2 px-5 h-11 w-full sm:w-auto justify-center"
                    )}
                  >
                    <span>Enter Flight View</span>
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200/80 rounded-2xl p-4 shadow-sm flex flex-col justify-center">
          <span className="text-[10px] uppercase tracking-wider text-gray-400 font-bold select-none">Flights Flown</span>
          <span className="text-2xl font-bold text-gray-900 mt-1">{totalFlights}</span>
        </div>
        <div className="bg-white border border-gray-200/80 rounded-2xl p-4 shadow-sm flex flex-col justify-center">
          <span className="text-[10px] uppercase tracking-wider text-gray-400 font-bold select-none">Total Images</span>
          <span className="text-2xl font-bold text-gray-900 mt-1">{totalImages}</span>
        </div>
        <div className="bg-white border border-gray-200/80 rounded-2xl p-4 shadow-sm flex flex-col justify-center">
          <span className="text-[10px] uppercase tracking-wider text-gray-400 font-bold select-none">Completed Maps</span>
          <span className="text-2xl font-bold text-emerald-600 mt-1">{completedMaps}</span>
        </div>
        <div className="bg-white border border-gray-200/80 rounded-2xl p-4 shadow-sm flex flex-col justify-center">
          <span className="text-[10px] uppercase tracking-wider text-gray-400 font-bold select-none">Queued/Processing</span>
          <span className="text-2xl font-bold text-blue-600 mt-1">{pendingProcessing}</span>
        </div>
      </div>

      {/* Main Flights Section */}
      <section className="flex flex-col gap-4 max-w-5xl mx-auto min-h-[400px]">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400 select-none">
            Logged Flights ({totalFlights})
          </h2>
        </div>

        <div className="space-y-4">
          {filteredFlights.length === 0 ? (
            <div className="text-center py-16 text-gray-400 bg-white rounded-2xl border border-gray-200/60 p-6 shadow-sm border-dashed">
              <span className="text-3xl block mb-2">✈️</span>
              <p className="text-sm font-semibold text-gray-600">
                {selectedDate === initialDate
                  ? 'No flights logged in the last 24 hours.'
                  : selectedDate === yesterdayDate
                  ? 'No flights logged yesterday.'
                  : 'No flights logged on this date.'}
              </p>
              <p className="text-xs text-gray-550 mt-1 max-w-xs mx-auto">
                Use the navigation header above to browse other days or jump to a day containing data.
              </p>

              {datesWithFlights.length > 0 && (
                <div className="mt-6 pt-6 border-t border-gray-100">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 select-none mb-2.5">
                    Jump directly to dates with flights:
                  </p>
                  <div className="flex flex-wrap gap-1.5 justify-center">
                    {datesWithFlights.slice(0, 5).map((dt) => (
                      <button
                        key={dt}
                        onClick={() => setSelectedDate(dt)}
                        className="inline-flex items-center rounded-lg bg-gray-50 border border-gray-200/80 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 font-medium transition-colors"
                      >
                        {dt === initialDate
                          ? 'Today'
                          : dt === yesterdayDate
                          ? 'Yesterday'
                          : dt}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            filteredFlights.map((flight) => {
              return (
                <div
                  key={flight.id}
                  className="group bg-white rounded-2xl border border-gray-200/80 p-5 transition-all shadow-sm hover:shadow-md flex flex-row items-stretch justify-between gap-6 relative"
                >
                  {/* Left Side: Content */}
                  <div className="flex-1 flex flex-col justify-between min-w-0">
                    <div className="space-y-1.5">
                      {/* Header line: Title & Admin Pin */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Link
                          href={`/projects/${projectId}/flight-plans/${flight.flightPlanId}/flights`}
                          className="text-base font-bold text-gray-900 hover:text-blue-600 transition-colors leading-tight"
                        >
                          {flight.flightPlanName}
                        </Link>
                        {isAdmin && (
                          <button
                            onClick={() => handleToggleHighlight(flight.id)}
                            className={cn(
                              "p-1 rounded transition-colors cursor-pointer",
                              currentHighlightIds.includes(flight.id)
                                ? "text-blue-600 bg-blue-50 hover:bg-blue-100 hover:text-blue-700"
                                : "text-gray-400 hover:text-blue-600 hover:bg-gray-50"
                            )}
                            title={currentHighlightIds.includes(flight.id) ? "Clear Highlight" : "Highlight this flight at top"}
                          >
                            <Pin className={cn("w-3.5 h-3.5", currentHighlightIds.includes(flight.id) && "fill-blue-600")} />
                          </button>
                        )}
                      </div>

                      {/* Metadata Row */}
                      <div className="flex flex-wrap items-center gap-x-2 text-xs text-gray-500 font-medium">
                        <span>{formatTimeOnly(flight.timestamp, timezone)} local time</span>
                        <span>•</span>
                        <span>{flight.imageCount} images</span>
                        <span>•</span>
                        <StatusBadge status={flight.taskStatus} imageCount={flight.imageCount} />
                      </div>

                      {/* Flight Notes */}
                      {flight.notes && (
                        <p className="text-xs text-gray-550 pt-1 leading-relaxed line-clamp-2" title={flight.notes}>
                          {flight.notes}
                        </p>
                      )}
                    </div>

                    {/* Open Details Action */}
                    <div className="mt-4 flex items-center">
                      <Link
                        href={`/projects/${projectId}/flight-plans/${flight.flightPlanId}/flights/${flight.id}?returnTo=${encodeURIComponent(`/projects/${projectId}`)}`}
                        className={cn(
                          buttonVariants({ variant: 'outline', size: 'sm' }),
                          "text-xs font-semibold gap-1.5 h-8 px-3 rounded-lg"
                        )}
                      >
                        <span>Open Details</span>
                        <ArrowRight className="w-3.5 h-3.5 text-gray-500 group-hover:translate-x-0.5 transition-transform" />
                      </Link>
                    </div>
                  </div>

                  {/* Right Side: Orthophoto Preview / Placeholder */}
                  <div className="flex-shrink-0 w-28 h-28 sm:w-32 sm:h-32 relative self-center">
                    {flight.taskStatus === 'completed' && flight.outputKey ? (
                      <img
                        src={`/api/tiles/preview?key=${encodeURIComponent(flight.outputKey)}&size=300`}
                        alt={`${flight.flightPlanName} Orthophoto Preview`}
                        className="w-full h-full object-cover rounded-xl border border-gray-200/60 bg-gray-50"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full rounded-xl border border-dashed border-gray-200 bg-gray-50/50 flex flex-col items-center justify-center text-gray-400 gap-1.5 select-none">
                        <Layers className="w-5 h-5 text-gray-300" />
                        <span className="text-[10px] font-medium tracking-wider uppercase text-gray-400">No Map</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>
    </div>
  )
}
