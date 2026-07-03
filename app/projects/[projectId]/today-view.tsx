'use client'

import { useEffect, useRef, useState, useActionState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Calendar, Layers, ArrowRight, CheckCircle2, AlertCircle, Sparkles, Pin, PinOff, EyeOff, Thermometer, Wind, Cloud, Waves, Plus, MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { highlightFlight } from '@/app/actions/projects'
I import { setFlightPriority, logFlightWithRoute, loadFlightsBefore } from '@/app/actions/flights'
import type { FlightRow } from '@/app/actions/flights'

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
  totalFishCount: number
  hasMore: boolean
  globalStats?: { totalFlights: number; totalImages: number; completedMaps: number }
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

function StatusBadge({ status, fileCount }: { status: string | null; fileCount: number }) {
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
  if (fileCount > 0) {
    return null
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-[11px] text-gray-400 font-medium">
      <span>No Images</span>
    </span>
  )
}

interface FlightCardProps {
  flight: FlightRow
  projectId: string
  isAdmin: boolean
  currentHighlightIds: string[]
  timezone: string
  handleToggleHighlight: (id: string) => void
  handleHideFlight: (id: string, flightPlanId: string) => void
}

function FlightCard({
  flight,
  projectId,
  isAdmin,
  currentHighlightIds,
  timezone,
  handleToggleHighlight,
  handleHideFlight,
}: FlightCardProps) {
  const [data, setData] = useState<{ weather: any; tides: any } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const loc = flight.flightPlanLocation

  useEffect(() => {
    const lat = 59.1828446
    const lng = -158.5463867

    let active = true
    setLoading(true)
    setError(false)

    fetch(
      `/api/weather-tides?lat=${lat}&lng=${lng}&timestamp=${encodeURIComponent(
        new Date(flight.timestamp).toISOString()
      )}`
    )
      .then((res) => {
        if (!res.ok) throw new Error()
        return res.json()
      })
      .then((resData) => {
        if (active) {
          setData(resData)
          setLoading(false)
        }
      })
      .catch(() => {
        if (active) {
          setError(true)
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [loc, flight.timestamp])

  // Process tide data closest to the flight
  let closestTide = null
  let isTideRising = false
  if (data?.tides?.predictions && data.tides.predictions.length > 0) {
    const predictions = data.tides.predictions
    let closestIdx = 0
    let minDiff = Infinity
    const flightTimeMs = new Date(flight.timestamp).getTime()

    predictions.forEach((p: any, idx: number) => {
      const diff = Math.abs(new Date(p.time).getTime() - flightTimeMs)
      if (diff < minDiff) {
        minDiff = diff
        closestIdx = idx
      }
    })

    closestTide = predictions[closestIdx]
    if (closestIdx < predictions.length - 1) {
      isTideRising = predictions[closestIdx + 1].value > closestTide.value
    } else if (closestIdx > 0) {
      isTideRising = closestTide.value > predictions[closestIdx - 1].value
    }
  }

  // Helper to compute Tide SVG path parameters and last peak time
  const getTideSvgData = (predictionsList: any[], width: number, height: number, padX: number, padY: number) => {
    if (!predictionsList || predictionsList.length === 0) return null

    // Find all extrema across the entire predictions list to determine previous tide events
    const allExtrema: { type: 'high' | 'low'; time: Date; value: number }[] = []
    for (let i = 1; i < predictionsList.length - 1; i++) {
      const prev = predictionsList[i - 1].value
      const curr = predictionsList[i].value
      const next = predictionsList[i + 1].value
      if (curr > prev && curr > next) {
        allExtrema.push({ type: 'high', time: new Date(predictionsList[i].time), value: curr })
      } else if (curr < prev && curr < next) {
        allExtrema.push({ type: 'low', time: new Date(predictionsList[i].time), value: curr })
      }
    }

    const flightTimeMs = new Date(flight.timestamp).getTime()

    // Find the most recent extrema before the flight timestamp
    const pastExtrema = allExtrema
      .filter((e) => e.time.getTime() < flightTimeMs)
      .sort((a, b) => b.time.getTime() - a.time.getTime())

    const lastExtrema = pastExtrema[0]
    let lastPeakText = ''
    if (lastExtrema) {
      const diffMs = flightTimeMs - lastExtrema.time.getTime()
      const diffHrs = Math.floor(diffMs / (1000 * 60 * 60))
      const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
      const typeText = lastExtrema.type === 'high' ? 'high tide' : 'low tide'
      lastPeakText = `${diffHrs}h ${diffMins}m since last ${typeText} (${lastExtrema.value.toFixed(1)} ft)`
    } else {
      lastPeakText = 'No previous peaks found'
    }

    // Filter predictions to a 24-hour window centered on the flight (-12h to +12h)
    const startWindowMs = flightTimeMs - 12 * 60 * 60 * 1000
    const endWindowMs = flightTimeMs + 12 * 60 * 60 * 1000
    const windowPredictions = predictionsList.filter((p: any) => {
      const t = new Date(p.time).getTime()
      return t >= startWindowMs && t <= endWindowMs
    })

    if (windowPredictions.length === 0) {
      return {
        pathD: '',
        fillD: '',
        dotX: 0,
        dotY: 0,
        closestValue: 0,
        isRising: false,
        scaleY0: 0,
        minVal: 0,
        maxVal: 0,
        highsLows: [],
        lastPeakText,
      }
    }

    const values = windowPredictions.map((p) => p.value)
    const minVal = Math.min(...values)
    const maxVal = Math.max(...values)
    const valRange = maxVal - minVal || 1

    const scaleX = (idx: number) => padX + (idx / (windowPredictions.length - 1)) * (width - 2 * padX)
    const scaleY = (val: number) => {
      const pct = (val - minVal) / valRange
      return height - padY - pct * (height - 2 * padY)
    }

    // Build curve path
    const points = windowPredictions.map((p, idx) => `${scaleX(idx).toFixed(1)},${scaleY(p.value).toFixed(1)}`)
    const pathD = `M ${points.join(' L ')}`
    const fillD = `${pathD} L ${scaleX(windowPredictions.length - 1).toFixed(1)},${height} L ${scaleX(0).toFixed(1)},${height} Z`

    // Find closest prediction inside the 24h window
    let closestIdx = 0
    let minDiff = Infinity
    windowPredictions.forEach((p, idx) => {
      const diff = Math.abs(new Date(p.time).getTime() - flightTimeMs)
      if (diff < minDiff) {
        minDiff = diff
        closestIdx = idx
      }
    })

    const closestPred = windowPredictions[closestIdx]
    const dotX = scaleX(closestIdx)
    const dotY = scaleY(closestPred.value)

    // Determine tide direction (rising or falling)
    let isRising = false
    if (closestIdx < windowPredictions.length - 1) {
      isRising = windowPredictions[closestIdx + 1].value > closestPred.value
    } else if (closestIdx > 0) {
      isRising = closestPred.value > windowPredictions[closestIdx - 1].value
    }

    // Local highs/lows inside the 24-hour window
    const windowHighsLows: { type: 'high' | 'low'; x: number; y: number; val: number }[] = []
    for (let i = 1; i < windowPredictions.length - 1; i++) {
      const prev = windowPredictions[i - 1].value
      const curr = windowPredictions[i].value
      const next = windowPredictions[i + 1].value
      if (curr > prev && curr > next) {
        windowHighsLows.push({ type: 'high', x: scaleX(i), y: scaleY(curr), val: curr })
      } else if (curr < prev && curr < next) {
        windowHighsLows.push({ type: 'low', x: scaleX(i), y: scaleY(curr), val: curr })
      }
    }

    return {
      pathD,
      fillD,
      dotX,
      dotY,
      closestValue: closestPred.value,
      isRising,
      scaleY0: scaleY(0),
      minVal,
      maxVal,
      highsLows: windowHighsLows,
      lastPeakText,
    }
  }

  const predictions = data?.tides?.predictions || []
  const tideSvg = predictions.length > 0 ? getTideSvgData(predictions, 350, 80, 15, 15) : null

  const weather = data?.weather

  return (
    <div className="group bg-white rounded-2xl border border-gray-200/80 p-5 transition-all shadow-sm hover:shadow-md flex flex-col md:flex-row items-stretch justify-between gap-6 relative">
      {/* Left Side: Content */}
      <div className="flex-1 flex flex-col justify-between min-w-0">
        <div className="space-y-1.5">
          {/* Header line: Title & Admin Pin */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Link
              href={`/projects/${projectId}/flight-plans/${flight.flightPlanId}/flights/${flight.id}?returnTo=${encodeURIComponent(`/projects/${projectId}`)}`}
              className="text-base font-bold text-gray-900 hover:text-blue-600 transition-colors leading-tight"
            >
              {flight.flightPlanName}
            </Link>
            {isAdmin && (
              <div className="flex items-center gap-1">
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
                <button
                  onClick={() => handleHideFlight(flight.id, flight.flightPlanId)}
                  className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-gray-55 transition-colors cursor-pointer"
                  title="Hide flight permanently"
                >
                  <EyeOff className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Metadata Row */}
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-gray-500 font-medium">
            <span>{formatTimeOnly(flight.timestamp, timezone)} local time</span>
            <span>•</span>
            <span>{flight.fileCount} files</span>
            {flight.totalFish > 0 && (
              <>
                <span>•</span>
                <span className="text-red-500">{flight.totalFish} fish</span>
              </>
            )}
            {(flight.taskStatus || flight.fileCount === 0) && <span>•</span>}
            <StatusBadge status={flight.taskStatus} fileCount={flight.fileCount} />
            {flight.locationTags.length > 0 ? (
              <>
                <span>•</span>
                {flight.locationTags.map((tag) => (
                  <span
                    key={tag.name}
                    className="inline-flex items-center gap-1 text-xs font-medium"
                    style={{ color: tag.color }}
                  >
                    <MapPin className="w-3 h-3" />
                    <span>{tag.name}</span>
                  </span>
                ))}
              </>
            ) : !loc ? (
              <>
                <span>•</span>
                <span className="inline-flex items-center gap-1 text-red-500">
                  <MapPin className="w-3 h-3" />
                  <span>No location</span>
                </span>
              </>
            ) : null}
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
      {/* Right Side: Weather and Tides Info Card with SVG Graph */}
      <div className="md:w-[28rem] flex-shrink-0 flex items-center">
        {loading ? (
          <div className="w-full p-4 rounded-xl border border-gray-150 bg-gray-55/5 flex flex-col gap-3 animate-pulse">
            <div className="h-4 bg-gray-205 rounded w-1/3"></div>
            <div className="grid grid-cols-2 gap-4">
              <div className="h-10 bg-gray-205 rounded"></div>
              <div className="h-10 bg-gray-205 rounded"></div>
            </div>
            <div className="h-14 bg-gray-205 rounded w-full"></div>
          </div>
        ) : error || !data ? (
          <div className="w-full py-6 px-4 rounded-xl border border-gray-155 bg-red-50/20 flex flex-col items-center justify-center text-center text-red-700/60 gap-1 select-none">
            <AlertCircle className="w-5 h-5 text-red-400" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Unavailable</span>
            <span className="text-[9px] text-red-500/50">Error fetching weather/tides</span>
          </div>
        ) : (
          <div className="w-full bg-gray-50/70 border border-gray-150 rounded-xl p-3.5 flex flex-col gap-3.5 text-xs text-gray-655">
            {/* Grid for weather conditions & tide text metrics */}
            <div className="grid grid-cols-2 gap-4">
              {/* Weather info */}
              {weather ? (
                <div className="flex flex-col gap-1.5 min-w-0">
                  <div className="flex items-center justify-between text-[9px] text-gray-450 uppercase font-bold tracking-wider">
                    <span>Conditions</span>
                    <span className="text-[8px] font-mono text-gray-400">Open-Meteo</span>
                  </div>
                  <div className="flex flex-col gap-1.5 text-gray-750 font-medium pt-0.5">
                    <div className="flex items-center gap-1.5">
                      <Thermometer className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />
                      <span className="truncate">{Math.round((weather.temperature * 9) / 5 + 32)}°F</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Cloud className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                      <span className="truncate">{weather.cloudCover}% Cover</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Wind className="w-3.5 h-3.5 text-teal-500 flex-shrink-0" />
                      <span className="truncate">{Math.round(weather.windSpeed * 0.621371)} mph ({weather.windDirection}°)</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-[10px] text-gray-400 flex items-center gap-1 select-none">
                  <span>No weather data</span>
                </div>
              )}

              {/* Tides text metrics */}
              {closestTide ? (
                <div className="flex flex-col gap-1.5 min-w-0">
                  <div className="flex items-center justify-between text-[9px] text-gray-455 uppercase font-bold tracking-wider">
                    <span>Tide</span>
                    <span className="text-[8px] font-mono text-gray-400">NOAA</span>
                  </div>
                  <div className="flex flex-col gap-1 text-gray-750 font-medium pt-0.5">
                    <div className="flex items-center gap-1.5">
                      <Waves className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                      <span className="font-bold text-gray-800">{closestTide.value.toFixed(1)} ft</span>
                    </div>
                    <div>
                      <span className={cn(
                        "text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider",
                        tideSvg?.isRising ? "bg-green-50 text-green-700 border border-green-200" : "bg-blue-50 text-blue-700 border border-blue-200"
                      )}>
                        {tideSvg?.isRising ? 'Rising' : 'Falling'}
                      </span>
                    </div>
                    <span className="text-[9px] text-gray-400 truncate mt-1 animate-in fade-in" title={data.tides.stationName}>
                      {data.tides.stationName}
                    </span>
                    {tideSvg?.lastPeakText && (
                      <span className="text-[9px] text-blue-800 font-semibold block leading-tight mt-1">
                        {tideSvg.lastPeakText}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-[10px] text-gray-400 flex items-center gap-1 select-none">
                  <span>No tide station data</span>
                </div>
              )}
            </div>

            {/* Tide SVG Graph */}
            {tideSvg && tideSvg.pathD && (
              <div className="relative pt-1 w-full border-t border-gray-150/60 pt-2 flex flex-col gap-1">
                <span className="text-[9px] text-gray-455 font-semibold uppercase tracking-wider">Tide Curve (24h centered)</span>
                <svg viewBox="0 0 350 80" className="w-full h-16 overflow-visible mt-0.5">
                  <defs>
                    <linearGradient id={`tide-gradient-${flight.id}`} x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.18" />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.01" />
                    </linearGradient>
                  </defs>

                  {/* 0.0 MLLW reference line */}
                  {tideSvg.minVal < 0 && tideSvg.maxVal > 0 && (
                    <line
                      x1="0"
                      y1={tideSvg.scaleY0}
                      x2="350"
                      y2={tideSvg.scaleY0}
                      stroke="#cbd5e1"
                      strokeDasharray="2,2"
                      strokeWidth="1"
                    />
                  )}

                  {/* Wave Fill Area */}
                  <path d={tideSvg.fillD} fill={`url(#tide-gradient-${flight.id})`} />

                  {/* Wave Curve */}
                  <path
                    d={tideSvg.pathD}
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />

                  {/* Highs and Lows Labels */}
                  {tideSvg.highsLows.map((hl, idx) => (
                    <g key={idx}>
                      <circle cx={hl.x} cy={hl.y} r="2.5" fill={hl.type === 'high' ? '#3b82f6' : '#64748b'} />
                      <text
                        x={hl.x}
                        y={hl.type === 'high' ? hl.y - 6 : hl.y + 10}
                        textAnchor="middle"
                        fontSize="9"
                        fontWeight="700"
                        fill={hl.type === 'high' ? '#1d4ed8' : '#334155'}
                        className="select-none font-sans"
                      >
                        {hl.type === 'high' ? 'H' : 'L'}: {hl.val.toFixed(1)}ft
                      </text>
                    </g>
                  ))}

                  {/* Active Indicator Dot */}
                  <circle
                    cx={tideSvg.dotX}
                    cy={tideSvg.dotY}
                    r="4"
                    fill="#ef4444"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                </svg>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function nowInTz(tz: string): string {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

export default function TodayFlightsView({
  projectId,
  projectName,
  timezone,
  flightPlans,
  flights: initialFlights,
  datesWithFlights,
  initialDate,
  canWrite,
  isAdmin,
  highlightedFlightId,
  totalFishCount,
  hasMore: initialHasMore,
  globalStats,
}: Props) {
  const router = useRouter()

  const [allFlights, setAllFlights] = useState<FlightRow[]>(initialFlights)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          loadMore()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, isLoadingMore])

  async function loadMore() {
    if (isLoadingMore || !hasMore) return
    setIsLoadingMore(true)
    const sortedDaysCurrent = Array.from(
      new Set(allFlights.map((f) => getLocalDateStr(f.timestamp, timezone)))
    ).sort((a, b) => b.localeCompare(a))
    const cursor = sortedDaysCurrent[sortedDaysCurrent.length - 1]
    if (!cursor) { setIsLoadingMore(false); return }
    const result = await loadFlightsBefore(projectId, cursor, timezone)
    setAllFlights((prev) => [...prev, ...result.flights])
    setHasMore(result.hasMore)
    setIsLoadingMore(false)
  }

  const [isLogModalOpen, setIsLogModalOpen] = useState(false)
  const [isNewRoute, setIsNewRoute] = useState(false)
  const [selectedRouteId, setSelectedRouteId] = useState(() => {
    const activePlans = flightPlans.filter((fp) => !fp.deletedAt)
    return activePlans[0]?.id ?? ''
  })
  const [newRouteName, setNewRouteName] = useState('')
  const [logNotes, setLogNotes] = useState('')
  const [logTimestamp, setLogTimestamp] = useState(() => nowInTz(timezone))

  const [logState, logAction, logPending] = useActionState(logFlightWithRoute, null)

  useEffect(() => {
    if (logState?.success && logState.flightId && logState.flightPlanId) {
      setIsLogModalOpen(false)
      setNewRouteName('')
      setLogNotes('')
      router.push(`/projects/${projectId}/flight-plans/${logState.flightPlanId}/flights/${logState.flightId}`)
    }
  }, [logState, projectId, router])

  const [currentHighlightIds, setCurrentHighlightIds] = useState<string[]>(
    highlightedFlightId ? highlightedFlightId.split(',').filter(Boolean) : []
  )

  const handleHideFlight = async (flightId: string, flightPlanId: string) => {
    if (!confirm('Are you sure you want to permanently hide this flight?')) return

    const formData = new FormData()
    formData.append('id', flightId)
    formData.append('projectId', projectId)
    formData.append('flightPlanId', flightPlanId)
    formData.append('lowPriority', 'true')

    try {
      const res = await setFlightPriority(null, formData)
      if (res?.error) {
        alert(res.error)
      } else {
        router.refresh()
      }
    } catch (err) {
      alert('Failed to hide flight: ' + String(err))
    }
  }

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

  const highlightedFlights = allFlights.filter((f) => currentHighlightIds.includes(f.id))

  // Group flights by calendar day in project timezone
  const flightsByDay: Record<string, typeof allFlights> = {}
  allFlights.forEach((flight) => {
    const dayStr = getLocalDateStr(flight.timestamp, timezone)
    if (!flightsByDay[dayStr]) {
      flightsByDay[dayStr] = []
    }
    flightsByDay[dayStr].push(flight)
  })

  // Get sorted list of days in descending order (newest first)
  const sortedDays = Object.keys(flightsByDay).sort((a, b) => b.localeCompare(a))

  // Stats — use all-time server values when available, fall back to loaded data
  const totalFlights = globalStats?.totalFlights ?? allFlights.length
  const totalImages = globalStats?.totalImages ?? allFlights.reduce((acc, curr) => acc + curr.fileCount, 0)
  const completedMaps = globalStats?.completedMaps ?? allFlights.filter((f) => f.taskStatus === 'completed').length
  const pendingProcessing = allFlights.filter((f) =>
    ['queued', 'running', 'uploading'].includes(f.taskStatus || '')
  ).length

  return (
    <div className="space-y-6">
      {/* Flights Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-gray-200">
        <div>
          <h1 className="text-xl font-bold text-gray-900 leading-tight">Flights</h1>
          <p className="text-xs text-gray-555 mt-1">
            Complete history of logged flights and map processing queues
          </p>
        </div>
        {canWrite && (
          <Button
            onClick={() => {
              setLogTimestamp(nowInTz(timezone))
              // Auto-select first route if none is selected
              if (!selectedRouteId) {
                const activePlans = flightPlans.filter((fp) => !fp.deletedAt)
                if (activePlans[0]) setSelectedRouteId(activePlans[0].id)
              }
              setIsLogModalOpen(true)
            }}
            className="flex items-center gap-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-sm h-9 px-4 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Log Flight
          </Button>
        )}
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
                  <p className="text-sm font-semibold text-gray-700">
                    {formatLongDate(getLocalDateStr(highlightedFlight.timestamp, timezone))} at {formatTimeOnly(highlightedFlight.timestamp, timezone)}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                    <span>{highlightedFlight.fileCount} files</span>
                    {highlightedFlight.totalFish > 0 && (
                      <>
                        <span className="text-gray-300">•</span>
                        <span className="text-red-500">{highlightedFlight.totalFish} fish</span>
                      </>
                    )}
                    {(highlightedFlight.taskStatus || highlightedFlight.fileCount === 0) && <span className="text-gray-300">•</span>}
                    <StatusBadge status={highlightedFlight.taskStatus} fileCount={highlightedFlight.fileCount} />
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
        {allFlights.length === 0 ? (
          <div className="text-center py-16 text-gray-400 bg-white rounded-2xl border border-gray-200/60 p-6 shadow-sm border-dashed">
            <span className="text-3xl block mb-2">✈️</span>
            <p className="text-sm font-semibold text-gray-600">No flights logged in this project yet.</p>
          </div>
        ) : (
          <div className="space-y-10">
            {sortedDays.map((dayStr) => (
              <div key={dayStr} className="space-y-4">
                <div className="sticky top-0 z-20 py-2 bg-gray-50/90 backdrop-blur-xs border-b border-gray-200/50 flex items-center justify-between">
                  <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-gray-500" />
                    <span>{formatLongDate(dayStr)}</span>
                  </h2>
                  <span className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
                    {flightsByDay[dayStr].length} {flightsByDay[dayStr].length === 1 ? 'Flight' : 'Flights'}
                  </span>
                </div>
                <div className="space-y-4">
                  {flightsByDay[dayStr].map((flight) => (
                    <FlightCard
                      key={flight.id}
                      flight={flight}
                      projectId={projectId}
                      isAdmin={isAdmin}
                      currentHighlightIds={currentHighlightIds}
                      timezone={timezone}
                      handleToggleHighlight={handleToggleHighlight}
                      handleHideFlight={handleHideFlight}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div ref={sentinelRef} className="h-1" />
        {isLoadingMore && (
          <div className="flex items-center justify-center py-6 text-gray-400 text-xs gap-2">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Loading older flights…
          </div>
        )}
      </section>

      {/* Log Flight Dialog */}
      <Dialog open={isLogModalOpen} onOpenChange={setIsLogModalOpen}>
        <DialogContent className="sm:max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <DialogHeader>
            <DialogTitle className="text-slate-900 dark:text-white">Log a new flight</DialogTitle>
          </DialogHeader>
          <form action={logAction} className="space-y-4 text-left">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="timezone" value={timezone} />
            
            {/* Toggle between choosing existing route vs adding new route */}
            <div className="space-y-2">
              <Label className="text-slate-700 dark:text-slate-350 text-xs font-semibold">Route Option</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setIsNewRoute(false)}
                  className={cn(
                    "px-3 py-2 text-xs font-semibold border rounded-lg transition-colors cursor-pointer text-center",
                    !isNewRoute
                      ? "border-blue-600 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                      : "border-slate-250 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-350"
                  )}
                >
                  Choose Existing Route
                </button>
                <button
                  type="button"
                  onClick={() => setIsNewRoute(true)}
                  className={cn(
                    "px-3 py-2 text-xs font-semibold border rounded-lg transition-colors cursor-pointer text-center",
                    isNewRoute
                      ? "border-blue-600 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                      : "border-slate-250 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-350"
                  )}
                >
                  Add New Route
                </button>
              </div>
            </div>

            <input type="hidden" name="isNewRoute" value={isNewRoute ? "true" : "false"} />

            {!isNewRoute ? (
              <div className="space-y-1.5 animate-in fade-in duration-150 flex flex-col">
                <Label htmlFor="flightPlanId" className="text-slate-700 dark:text-slate-350 text-xs font-semibold">Select Route</Label>
                {flightPlans.filter(fp => !fp.deletedAt).length === 0 ? (
                  <p className="text-xs text-red-500 font-medium">No routes exist yet. Please create a new route.</p>
                ) : (
                  <select
                    id="flightPlanId"
                    name="flightPlanId"
                    value={selectedRouteId}
                    onChange={(e) => setSelectedRouteId(e.target.value)}
                    className="w-full text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2.5 font-medium focus:outline-none focus:ring-1 cursor-pointer transition-colors text-slate-900 dark:text-white"
                  >
                    {flightPlans
                      .filter((fp) => !fp.deletedAt)
                      .map((fp) => (
                        <option key={fp.id} value={fp.id}>
                          {fp.displayName || fp.name}
                        </option>
                      ))}
                  </select>
                )}
              </div>
            ) : (
              <div className="space-y-1.5 animate-in fade-in duration-150">
                <Label htmlFor="newRouteName" className="text-slate-700 dark:text-slate-350 text-xs font-semibold">New Route Name</Label>
                <Input
                  id="newRouteName"
                  name="newRouteName"
                  required
                  placeholder="e.g. Lower River Section"
                  value={newRouteName}
                  onChange={(e) => setNewRouteName(e.target.value)}
                  className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="timestamp" className="text-slate-700 dark:text-slate-350 text-xs font-semibold">
                Timestamp{' '}
                <span className="font-normal text-muted-foreground">({timezone})</span>
              </Label>
              <Input
                id="timestamp"
                name="timestamp"
                type="datetime-local"
                required
                value={logTimestamp}
                onChange={(e) => setLogTimestamp(e.target.value)}
                className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="notes" className="text-slate-700 dark:text-slate-350 text-xs font-semibold">Notes (optional)</Label>
              <Input
                id="notes"
                name="notes"
                placeholder="e.g. Overcast, 10kt wind"
                value={logNotes}
                onChange={(e) => setLogNotes(e.target.value)}
                className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white"
              />
            </div>

            {logState?.error && <p className="text-xs text-red-650 font-medium">{logState.error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={logPending} className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-sm text-xs font-semibold px-4 cursor-pointer">
                {logPending ? 'Saving…' : 'Log flight'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
