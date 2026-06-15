'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Calendar, Layers, Map, Navigation, ArrowRight, Play, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import 'maplibre-gl/dist/maplibre-gl.css'

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
}

function getLocalDateStr(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
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
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-purple-50 border border-purple-200 px-2 py-0.5 text-[11px] text-purple-700 font-medium">
        <Play className="w-3.5 h-3.5 text-purple-500 fill-purple-500" />
        <span>Ready</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-[11px] text-gray-400 font-medium">
      <span>No Images</span>
    </span>
  )
}

function updateMapBasemap(map: any, currentBasemap: 'street' | 'satellite') {
  if (!map) return

  // Toggle satellite layer
  if (map.getLayer('esri-satellite-layer')) {
    map.setLayoutProperty(
      'esri-satellite-layer',
      'visibility',
      currentBasemap === 'satellite' ? 'visible' : 'none'
    )
  }

  // Toggle vector background/fill layers
  const style = map.getStyle()
  if (style && style.layers) {
    for (const layer of style.layers) {
      if (layer.type === 'fill' || layer.type === 'background') {
        if (
          layer.id === 'today-flights-fill' ||
          layer.id === 'today-flights-line' ||
          layer.id === 'today-flights-point'
        ) {
          continue
        }
        map.setLayoutProperty(
          layer.id,
          'visibility',
          currentBasemap === 'street' ? 'visible' : 'none'
        )
      }
    }
  }
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
}: Props) {
  const [selectedDate, setSelectedDate] = useState(initialDate)
  const [basemap, setBasemap] = useState<'street' | 'satellite'>('street')
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any | null>(null)
  const [mapReady, setMapReady] = useState(false)

  // Filter flights matching the selected local date
  const filteredFlights = flights.filter(
    (f) => getLocalDateStr(f.timestamp, timezone) === selectedDate
  )

  // Generate GeoJSON representation for the map
  const geojsonFeatures = filteredFlights
    .map((f) => {
      if (!f.flightPlanLocation) return null
      try {
        const geom = JSON.parse(f.flightPlanLocation)
        return {
          type: 'Feature' as const,
          geometry: geom,
          properties: {
            id: f.id,
            flightPlanId: f.flightPlanId,
            name: f.flightPlanName,
            time: formatTimeOnly(f.timestamp, timezone),
          },
        }
      } catch (e) {
        return null
      }
    })
    .filter((feat): feat is NonNullable<typeof feat> => feat !== null)

  const geojson = {
    type: 'FeatureCollection' as const,
    features: geojsonFeatures as any[],
  }

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

  // ── Stats Calculations ─────────────────────────────────────────────────────
  const totalFlights = filteredFlights.length
  const totalImages = filteredFlights.reduce((acc, curr) => acc + curr.imageCount, 0)
  const completedMaps = filteredFlights.filter((f) => f.taskStatus === 'completed').length
  const pendingProcessing = filteredFlights.filter((f) =>
    ['queued', 'running', 'uploading'].includes(f.taskStatus || '')
  ).length

  // ── Init Maplibre map ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current) return
    let cancelled = false

    async function init() {
      try {
        const maplibre = (await import('maplibre-gl')).default
        if (cancelled || !mapContainerRef.current) return

        const map = new maplibre.Map({
          container: mapContainerRef.current,
          style: 'https://tiles.openfreemap.org/styles/liberty',
          zoom: 2,
          center: [-152, 61], // Center Alaska by default
          attributionControl: false,
        })

        mapRef.current = map
        map.addControl(new maplibre.AttributionControl({ compact: true }))
        map.addControl(new maplibre.NavigationControl(), 'top-right')

        map.on('load', () => {
          if (cancelled) return
          setMapReady(true)

          // Add Esri satellite source
          map.addSource('esri-satellite', {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            attribution: 'Tiles &copy; Esri',
            maxzoom: 19,
          })

          // Add Esri satellite layer at bottom
          const layersStyle = map.getStyle().layers
          const firstLayerId = layersStyle && layersStyle.length > 0 ? layersStyle[0].id : undefined
          map.addLayer({
            id: 'esri-satellite-layer',
            type: 'raster',
            source: 'esri-satellite',
            layout: { visibility: basemap === 'satellite' ? 'visible' : 'none' },
          }, firstLayerId)

          updateMapBasemap(map, basemap)

          // Add dynamic today flights layers
          map.addSource('today-flights', {
            type: 'geojson',
            data: geojson,
          })

          map.addLayer({
            id: 'today-flights-fill',
            type: 'fill',
            source: 'today-flights',
            paint: {
              'fill-color': '#10b981',
              'fill-opacity': 0.15,
            },
            filter: ['==', '$type', 'Polygon'],
          })

          map.addLayer({
            id: 'today-flights-line',
            type: 'line',
            source: 'today-flights',
            paint: {
              'line-color': '#059669',
              'line-width': 2.5,
            },
            filter: ['in', '$type', 'LineString', 'Polygon'],
          })

          map.addLayer({
            id: 'today-flights-point',
            type: 'circle',
            source: 'today-flights',
            paint: {
              'circle-color': '#10b981',
              'circle-radius': 8,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
            filter: ['==', '$type', 'Point'],
          })

          // Click handler for popup
          map.on('click', 'today-flights-fill', (e: any) => {
            const f = e.features[0]
            const { id, flightPlanId, name, time } = f.properties
            new maplibre.Popup()
              .setLngLat(e.lngLat)
              .setHTML(`
                <div style="font-family: ui-sans-serif, system-ui, sans-serif; padding: 8px;">
                  <h4 style="font-weight: 700; color: #111827; margin: 0 0 2px 0;">${name}</h4>
                  <p style="font-size: 11px; color: #6b7280; margin: 0 0 8px 0;">Logged at ${time}</p>
                  <a href="/projects/${projectId}/flight-plans/${flightPlanId}/flights/${id}" style="font-size: 11px; font-weight: 600; color: #10b981; text-decoration: none;">
                    Open Flight Details →
                  </a>
                </div>
              `)
              .addTo(map)
          })

          map.on('mouseenter', 'today-flights-fill', () => {
            map.getCanvas().style.cursor = 'pointer'
          })
          map.on('mouseleave', 'today-flights-fill', () => {
            map.getCanvas().style.cursor = ''
          })
        })
      } catch (err) {
        console.error('Failed to init calendar map:', err)
      }
    }

    init()

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        setMapReady(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Sync basemap changes ───────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    updateMapBasemap(mapRef.current, basemap)
  }, [basemap, mapReady])

  // ── Update GeoJSON data and fit map bounds on date change ──────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const map = mapRef.current
    const source = map.getSource('today-flights')
    if (source) {
      source.setData(geojson)
    }

    // Fit bounds of flights today
    if (geojsonFeatures.length > 0) {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
      let hasCoords = false

      for (const feat of geojsonFeatures) {
        const geom = feat.geometry
        if (geom.type === 'Point') {
          const [lng, lat] = geom.coordinates
          minLng = Math.min(minLng, lng)
          minLat = Math.min(minLat, lat)
          maxLng = Math.max(maxLng, lng)
          maxLat = Math.max(maxLat, lat)
          hasCoords = true
        } else if (geom.type === 'Polygon') {
          for (const ring of geom.coordinates) {
            for (const [lng, lat] of ring) {
              minLng = Math.min(minLng, lng)
              minLat = Math.min(minLat, lat)
              maxLng = Math.max(maxLng, lng)
              maxLat = Math.max(maxLat, lat)
              hasCoords = true
            }
          }
        }
      }

      if (hasCoords) {
        const isSinglePoint = minLng === maxLng && minLat === maxLat
        if (isSinglePoint) {
          map.flyTo({ center: [minLng, minLat], zoom: 14 })
        } else {
          map.fitBounds([minLng, minLat, maxLng, maxLat], { padding: 50, maxZoom: 15, animate: true })
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, mapReady])

  // Focus a specific flight plan's geometry on map
  function handleFocusPlan(planLocation: string | null) {
    if (!mapRef.current || !mapReady || !planLocation) return
    try {
      const geom = JSON.parse(planLocation)
      if (geom.type === 'Point') {
        mapRef.current.flyTo({ center: geom.coordinates, zoom: 14 })
      } else if (geom.type === 'Polygon') {
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
        for (const ring of geom.coordinates) {
          for (const [lng, lat] of ring) {
            minLng = Math.min(minLng, lng)
            minLat = Math.min(minLat, lat)
            maxLng = Math.max(maxLng, lng)
            maxLat = Math.max(maxLat, lat)
          }
        }
        mapRef.current.fitBounds([minLng, minLat, maxLng, maxLat], { padding: 40, maxZoom: 15 })
      }
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="space-y-6">
      {/* Upper Calendar Navigation Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-gray-200">
        <div>
          <h1 className="text-xl font-bold text-gray-900 leading-tight">Today&apos;s Flights</h1>
          <p className="text-xs text-gray-500 mt-1">
            Logged flights and processing queues for {formatLongDate(selectedDate)}
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
            <span className="font-mono">{selectedDate}</span>
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

      {/* Main Grid View */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        
        {/* Left Side: Flights List */}
        <section className="lg:col-span-6 flex flex-col gap-4 min-h-[400px]">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400 select-none">
              Logged Flights ({totalFlights})
            </h2>
          </div>

          <div className="space-y-3 overflow-y-auto no-scrollbar flex-1 max-h-[600px] pr-1">
            {filteredFlights.length === 0 ? (
              <div className="text-center py-16 text-gray-400 bg-white rounded-2xl border border-gray-200/60 p-6 shadow-sm border-dashed">
                <span className="text-3xl block mb-2">✈️</span>
                <p className="text-sm font-semibold text-gray-600">No flights logged on this date.</p>
                <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
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
                          {dt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              filteredFlights.map((flight) => {
                const hasLoc = !!flight.flightPlanLocation
                return (
                  <div
                    key={flight.id}
                    className="group bg-white rounded-2xl border border-gray-200/80 p-4 transition-all shadow-sm hover:shadow-md flex flex-col gap-3 relative"
                  >
                    {/* Header: Plan link, Time and zooming icon */}
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Link
                            href={`/projects/${projectId}/flight-plans/${flight.flightPlanId}/flights`}
                            className="text-sm font-semibold text-gray-900 hover:text-blue-600 transition-colors leading-tight"
                          >
                            {flight.flightPlanName}
                          </Link>
                          {hasLoc && (
                            <button
                              onClick={() => handleFocusPlan(flight.flightPlanLocation)}
                              className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                              title="Zoom to location on map"
                            >
                              <Navigation className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-400 font-medium block">
                          Logged: {formatTimeOnly(flight.timestamp, timezone)} local time
                        </span>
                      </div>
                      
                      <Link
                        href={`/projects/${projectId}/flight-plans/${flight.flightPlanId}/flights/${flight.id}`}
                        className={cn(
                          buttonVariants({ variant: 'outline', size: 'sm' }),
                          "text-xs font-semibold gap-1.5 h-8"
                        )}
                      >
                        <span>Open Details</span>
                        <ArrowRight className="w-3.5 h-3.5 text-gray-500 group-hover:translate-x-0.5 transition-transform" />
                      </Link>
                    </div>

                    {/* Flight notes */}
                    {flight.notes && (
                      <p className="text-xs text-gray-500 border-t border-gray-50 pt-2 leading-relaxed">
                        {flight.notes}
                      </p>
                    )}

                    {/* Footer: status and stats */}
                    <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-gray-50 pt-3 mt-1">
                      <div className="flex flex-wrap gap-2 items-center text-xs">
                        <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs text-gray-600 font-medium">
                          <span>{flight.imageCount} images</span>
                        </span>
                        <StatusBadge status={flight.taskStatus} imageCount={flight.imageCount} />
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        {/* Right Side: Map Area */}
        <section className="lg:col-span-6 flex flex-col min-h-[400px]">
          <div className="flex-1 rounded-2xl border border-gray-200 overflow-hidden shadow-sm relative min-h-[400px]">
            <div ref={mapContainerRef} className="w-full h-full absolute inset-0" />

            {/* Map Info Overlay Banner */}
            {geojsonFeatures.length > 0 && (
              <div className="absolute bottom-4 left-4 z-40 bg-white/95 backdrop-blur-sm px-3 py-2 rounded-xl shadow-md border border-gray-200/60 flex items-center gap-2 pointer-events-none select-none max-w-xs">
                <Sparkles className="w-4 h-4 text-emerald-500 animate-pulse flex-shrink-0" />
                <p className="text-[10px] font-medium text-gray-600 leading-snug">
                  Click shapes on the map to jump straight into today&apos;s flights.
                </p>
              </div>
            )}

            {/* Basemap Switcher Control */}
            <div className="absolute bottom-12 right-4 z-40 bg-white/90 hover:bg-white backdrop-blur-sm p-1 rounded-xl shadow-md border border-gray-200/80 flex gap-1 pointer-events-auto select-none transition-all">
              <button
                type="button"
                onClick={() => setBasemap('street')}
                className={cn(
                  "px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1.5 h-7",
                  basemap === 'street'
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                )}
              >
                <Map className="w-3.5 h-3.5" />
                <span>Street</span>
              </button>
              <button
                type="button"
                onClick={() => setBasemap('satellite')}
                className={cn(
                  "px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1.5 h-7",
                  basemap === 'satellite'
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                )}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Satellite</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
