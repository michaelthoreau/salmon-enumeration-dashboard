'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { MapPin, Map, Check, X, RotateCcw, Trash2, Edit, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import 'maplibre-gl/dist/maplibre-gl.css'

interface OrthoMapProps {
  outputKey: string
  className?: string
  fitBoundsTrigger?: number
  onViewportChange?: (viewport: { center: [number, number]; zoom: number }) => void
  editable?: boolean
  flightPlanId?: string
  initialLocation?: string | null
  onSaveLocation?: (locationJson: string | null) => Promise<void>
}

function getGeoJSON(pin: [number, number] | null, points: [number, number][]) {
  if (pin) {
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: pin,
          },
          properties: {},
        },
      ],
    }
  }

  if (points.length > 0) {
    if (points.length === 1) {
      return {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: points[0],
            },
            properties: {},
          },
        ],
      }
    }

    if (points.length === 2) {
      return {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: points,
            },
            properties: {},
          },
        ],
      }
    }

    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[...points, points[0]]],
          },
          properties: {},
        },
      ],
    }
  }

  return {
    type: 'FeatureCollection',
    features: [],
  }
}

export default function OrthoMap({
  outputKey,
  className,
  fitBoundsTrigger,
  onViewportChange,
  editable = false,
  initialLocation = null,
  onSaveLocation,
}: OrthoMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any | null>(null)
  const mapReadyRef = useRef(false)
  const boundsRef = useRef<[number, number, number, number] | null>(null)
  const initialFitDoneRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  // ── Drawing states ─────────────────────────────────────────────────────────
  const [panelOpen, setPanelOpen] = useState(false)
  const [isEditing, setIsEditing] = useState<'pin' | 'polygon' | null>(null)
  const [pin, setPin] = useState<[number, number] | null>(null)
  const [points, setPoints] = useState<[number, number][]>([])
  const [isSaving, setIsSaving] = useState(false)

  // Load initial location
  useEffect(() => {
    if (!initialLocation) {
      setPin(null)
      setPoints([])
      return
    }
    try {
      const geo = JSON.parse(initialLocation)
      if (geo.type === 'Point') {
        setPin(geo.coordinates as [number, number])
        setPoints([])
      } else if (geo.type === 'Polygon') {
        setPin(null)
        const coords = geo.coordinates[0] as [number, number][]
        setPoints(coords.slice(0, -1)) // Drop the duplicate closing point
      }
    } catch (err) {
      console.error('[OrthoMap] Failed to parse initialLocation:', err)
    }
  }, [initialLocation])

  // ── Init map once ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false

    async function init() {
      try {
        const maplibre = (await import('maplibre-gl')).default
        if (cancelled || !containerRef.current) return

        const map = new maplibre.Map({
          container: containerRef.current,
          style: 'https://tiles.openfreemap.org/styles/liberty',
          zoom: 2,
          center: [0, 20],
          attributionControl: false,
        })

        mapRef.current = map
        map.addControl(new maplibre.AttributionControl({ compact: true }))

        map.on('moveend', () => {
          if (cancelled) return
          onViewportChange?.({
            center: map.getCenter().toArray() as [number, number],
            zoom: map.getZoom(),
          })
        })

        map.on('load', () => {
          if (cancelled) return
          mapReadyRef.current = true
          map.resize()

          // Add location source and layers for drawing/saving
          map.addSource('location-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })

          map.addLayer({
            id: 'location-fill',
            type: 'fill',
            source: 'location-source',
            layout: { visibility: 'none' },
            paint: {
              'fill-color': '#3b82f6',
              'fill-opacity': 0.2,
            },
            filter: ['==', '$type', 'Polygon'],
          })

          map.addLayer({
            id: 'location-line',
            type: 'line',
            source: 'location-source',
            layout: { visibility: 'none' },
            paint: {
              'line-color': '#2563eb',
              'line-width': 2.5,
            },
            filter: ['in', '$type', 'LineString', 'Polygon'],
          })

          map.addLayer({
            id: 'location-point',
            type: 'circle',
            source: 'location-source',
            layout: { visibility: 'none' },
            paint: {
              'circle-color': '#2563eb',
              'circle-radius': 6,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
            filter: ['==', '$type', 'Point'],
          })
        })
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[OrthoMap] init error:', err)
          setErrorMsg(msg)
          setStatus('error')
        }
      }
    }

    init()

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        mapReadyRef.current = false
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // run once

  // ── Swap layer when outputKey changes ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function applyLayer() {
      setStatus('loading')
      try {
        const infoRes = await fetch(`/api/tiles/info?key=${encodeURIComponent(outputKey)}`)
        if (!infoRes.ok) throw new Error(`Failed to load tile info (${infoRes.status})`)
        const { bounds, minzoom, maxzoom } = (await infoRes.json()) as {
          bounds: [number, number, number, number]
          minzoom: number
          maxzoom: number
        }

        if (cancelled) return

        const tileUrl = `/api/tiles/{z}/{x}/{y}?key=${encodeURIComponent(outputKey)}`

        // Wait for the map to be ready (style loaded)
        await new Promise<void>((resolve) => {
          if (mapReadyRef.current && mapRef.current) return resolve()
          const check = setInterval(() => {
            if (cancelled || !mapRef.current) {
              clearInterval(check)
              return
            }
            if (mapReadyRef.current) {
              clearInterval(check)
              resolve()
            }
          }, 100)
        })

        if (cancelled || !mapRef.current) return
        const map = mapRef.current

        // Remove existing ortho layer/source if present
        if (map.getLayer('ortho-layer')) map.removeLayer('ortho-layer')
        if (map.getSource('ortho')) map.removeSource('ortho')

        map.addSource('ortho', {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          minzoom,
          maxzoom,
        })
        map.addLayer({ id: 'ortho-layer', type: 'raster', source: 'ortho' })

        // Move location layers to the top if they exist
        if (map.getLayer('location-fill')) {
          map.moveLayer('location-fill')
          map.moveLayer('location-line')
          map.moveLayer('location-point')
        }

        boundsRef.current = bounds
        if (!initialFitDoneRef.current) {
          map.resize()
          setTimeout(() => {
            if (!cancelled && mapRef.current) {
              mapRef.current.fitBounds([bounds[0], bounds[1], bounds[2], bounds[3]], {
                padding: 20,
                animate: false,
              })
            }
          }, 100)
          initialFitDoneRef.current = true
        }

        setStatus('ready')
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[OrthoMap] layer error:', err)
          setErrorMsg(msg)
          setStatus('error')
        }
      }
    }

    applyLayer()
    return () => {
      cancelled = true
    }
  }, [outputKey])

  // ── Fit bounds when fitBoundsTrigger changes ────────────────────────────────
  useEffect(() => {
    if (fitBoundsTrigger && fitBoundsTrigger > 0 && mapRef.current && boundsRef.current) {
      mapRef.current.resize()
      mapRef.current.fitBounds(boundsRef.current, { padding: 20, animate: true, duration: 300 })
    }
  }, [fitBoundsTrigger])

  // ── Handle Map Clicks for drawing ──────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return
    const map = mapRef.current

    const handleClick = (e: any) => {
      if (!isEditing) return
      const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]

      if (isEditing === 'pin') {
        setPin(lngLat)
        setPoints([])
      } else if (isEditing === 'polygon') {
        setPin(null)
        setPoints((prev) => [...prev, lngLat])
      }
    }

    map.on('click', handleClick)
    return () => {
      map.off('click', handleClick)
    }
  }, [isEditing])

  // Toggle crosshair cursor during edit mode
  useEffect(() => {
    if (!mapRef.current) return
    const canvas = mapRef.current.getCanvas()
    if (isEditing) {
      canvas.style.cursor = 'crosshair'
    } else {
      canvas.style.cursor = ''
    }
  }, [isEditing])

  // Update GeoJSON source representation when drawing/loading state changes
  useEffect(() => {
    if (!mapRef.current || !mapReadyRef.current) return
    const source = mapRef.current.getSource('location-source')
    if (source) {
      source.setData(getGeoJSON(pin, points))
    }
  }, [pin, points, status])

  // Show/hide location layer on map based on panelOpen/isEditing state
  useEffect(() => {
    if (!mapRef.current || !mapReadyRef.current) return
    const map = mapRef.current
    const visibility = (panelOpen || isEditing !== null) ? 'visible' : 'none'

    if (map.getLayer('location-fill')) {
      map.setLayoutProperty('location-fill', 'visibility', visibility)
    }
    if (map.getLayer('location-line')) {
      map.setLayoutProperty('location-line', 'visibility', visibility)
    }
    if (map.getLayer('location-point')) {
      map.setLayoutProperty('location-point', 'visibility', visibility)
    }
  }, [panelOpen, isEditing, status])

  // ── Save/Cancel handlers ───────────────────────────────────────────────────
  async function handleSave() {
    if (!onSaveLocation) return
    setIsSaving(true)
    try {
      let geojson: string | null = null
      if (isEditing === 'pin' && pin) {
        geojson = JSON.stringify({ type: 'Point', coordinates: pin })
      } else if (isEditing === 'polygon' && points.length >= 3) {
        geojson = JSON.stringify({ type: 'Polygon', coordinates: [[...points, points[0]]] })
      }

      await onSaveLocation(geojson)
      setIsEditing(null)
    } catch (err) {
      console.error('[OrthoMap] Error saving location:', err)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleClearSaved() {
    if (!confirm('Are you sure you want to clear the location for this flight plan?')) return
    setIsSaving(true)
    try {
      if (onSaveLocation) {
        await onSaveLocation(null)
      }
      setPin(null)
      setPoints([])
      setIsEditing(null)
    } catch (err) {
      console.error('[OrthoMap] Error clearing location:', err)
    } finally {
      setIsSaving(false)
    }
  }

  function handleCancel() {
    // Reset to initial location values
    setIsEditing(null)
    if (!initialLocation) {
      setPin(null)
      setPoints([])
      return
    }
    try {
      const geo = JSON.parse(initialLocation)
      if (geo.type === 'Point') {
        setPin(geo.coordinates as [number, number])
        setPoints([])
      } else if (geo.type === 'Polygon') {
        setPin(null)
        const coords = geo.coordinates[0] as [number, number][]
        setPoints(coords.slice(0, -1))
      }
    } catch (err) {
      console.error('[OrthoMap] Failed to reset initialLocation:', err)
    }
  }

  const hasSavedLocation = !!pin || points.length > 0
  const canSave =
    (isEditing === 'pin' && !!pin) || (isEditing === 'polygon' && points.length >= 3)

  return (
    <div
      className={cn(
        'relative w-full bg-gray-100',
        className || 'h-96 rounded-xl border border-gray-200 overflow-hidden'
      )}
    >
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <p className="text-sm text-gray-500 bg-white/80 px-3 py-1.5 rounded-lg shadow-sm border border-gray-200/50 backdrop-blur-sm animate-pulse">
            Loading orthophoto…
          </p>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <p className="text-sm text-red-500 px-4 py-2 bg-red-50 rounded-lg shadow-sm border border-red-200 text-center font-medium">
            {errorMsg}
          </p>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full" />

      {/* ─── Draw Panel Overlay ─── */}
      {editable && status === 'ready' && (
        <div className="absolute top-4 left-4 z-40 pointer-events-auto">
          {!panelOpen && isEditing === null ? (
            <Button
              size="sm"
              variant="outline"
              className="bg-white/95 border border-gray-200/80 hover:bg-gray-50 text-xs font-semibold gap-2 h-9 rounded-xl shadow-md"
              onClick={() => setPanelOpen(true)}
            >
              <MapPin className="w-4 h-4 text-blue-600" />
              <span>Flight Plan Location</span>
              <ChevronDown className="w-3.5 h-3.5 text-gray-500 ml-0.5" />
            </Button>
          ) : (
            <div className="bg-white/95 backdrop-blur-sm px-4 py-3 rounded-2xl shadow-xl border border-gray-200/80 flex flex-col gap-3 min-w-[220px]">
              {isEditing === null ? (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between pb-1.5 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-700 select-none">
                      Flight Plan Location
                    </p>
                    <button
                      onClick={() => setPanelOpen(false)}
                      className="p-1 hover:bg-gray-100 rounded-md transition-colors text-gray-400 hover:text-gray-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full justify-start text-xs font-medium gap-2 h-8 hover:bg-gray-50"
                      onClick={() => setIsEditing('pin')}
                    >
                      <MapPin className="w-3.5 h-3.5 text-blue-500" />
                      <span>Set Location Pin</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full justify-start text-xs font-medium gap-2 h-8 hover:bg-gray-50"
                      onClick={() => setIsEditing('polygon')}
                    >
                      <Map className="w-3.5 h-3.5 text-indigo-500" />
                      <span>Draw Location Area</span>
                    </Button>
                    {hasSavedLocation && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="w-full justify-start text-xs font-medium gap-2 h-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={handleClearSaved}
                        disabled={isSaving}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Clear Location</span>
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-800 animate-pulse select-none flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />
                      {isEditing === 'pin' ? 'Dropping Pin...' : 'Drawing Area...'}
                    </span>
                    <span className="text-[10px] text-gray-400 font-medium">Click on map</span>
                  </div>

                  {isEditing === 'polygon' && (
                    <div className="text-[10px] text-gray-500 bg-gray-50 p-2 rounded-lg border border-gray-100 flex justify-between items-center select-none font-medium">
                      <span>Points: {points.length}</span>
                      {points.length > 0 && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="w-5 h-5 hover:bg-gray-200 rounded-md"
                          onClick={() => setPoints((prev) => prev.slice(0, -1))}
                          title="Undo last point"
                        >
                          <RotateCcw className="w-3 h-3 text-gray-600" />
                        </Button>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2 border-t border-gray-100 pt-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 text-xs h-8 border-gray-200/80 hover:bg-gray-50"
                      onClick={handleCancel}
                      disabled={isSaving}
                    >
                      <X className="w-3.5 h-3.5 mr-1 text-gray-500" />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className={cn(
                        'flex-1 text-xs h-8 text-white font-semibold',
                        canSave
                          ? 'bg-blue-600 hover:bg-blue-700 shadow-sm shadow-blue-200'
                          : 'bg-gray-300 cursor-not-allowed hover:bg-gray-300'
                      )}
                      onClick={handleSave}
                      disabled={!canSave || isSaving}
                    >
                      <Check className="w-3.5 h-3.5 mr-1" />
                      {isSaving ? 'Saving...' : 'Save'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
