'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { MapPin, Map, Check, X, RotateCcw, Trash2, Edit, ChevronDown, Image as ImageIcon, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import 'maplibre-gl/dist/maplibre-gl.css'

interface OrthoMapProps {
  outputKey?: string | null
  cacheBuster?: string | null
  photos?: { key: string; name: string; latitude: number | null; longitude: number | null; etag: string; size: number }[]
  onSelectPhoto?: (key: string) => void
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
  outputKey = null,
  cacheBuster = null,
  photos = [],
  onSelectPhoto,
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
  const [showPhotos, setShowPhotos] = useState(!outputKey)
  const [basemap, setBasemap] = useState<'street' | 'satellite'>('street')

  // Sync showPhotos state if outputKey transitions from null to loaded
  useEffect(() => {
    setShowPhotos(!outputKey)
  }, [outputKey])

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

  // ── Sync Basemap Layer Visibility ──────────────────────────────────────────
  useEffect(() => {
    if (!mapReadyRef.current || !mapRef.current) return
    updateMapBasemap(mapRef.current, basemap)
  }, [basemap])

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

          // Add Esri satellite source
          map.addSource('esri-satellite', {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            attribution: 'Tiles &copy; Esri',
            maxzoom: 19
          })

          // Add Esri satellite layer at bottom
          const layersStyle = map.getStyle().layers;
          const firstLayerId = layersStyle && layersStyle.length > 0 ? layersStyle[0].id : undefined;
          map.addLayer({
            id: 'esri-satellite-layer',
            type: 'raster',
            source: 'esri-satellite',
            layout: { visibility: basemap === 'satellite' ? 'visible' : 'none' }
          }, firstLayerId)

          updateMapBasemap(map, basemap)

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

          // Add photo markers source and layers
          map.addSource('photo-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })

          map.addLayer({
            id: 'photo-layer',
            type: 'circle',
            source: 'photo-source',
            layout: { visibility: showPhotos ? 'visible' : 'none' },
            paint: {
              'circle-color': '#3b82f6',
              'circle-radius': 6,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1.5,
            },
          })

          map.addLayer({
            id: 'photo-hover-layer',
            type: 'circle',
            source: 'photo-source',
            layout: { visibility: showPhotos ? 'visible' : 'none' },
            paint: {
              'circle-color': '#2563eb',
              'circle-radius': 9,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
              'circle-opacity': 0.8,
            },
            filter: ['==', 'key', ''],
          })

          // Hover handlers for photos
          map.on('mouseenter', 'photo-layer', (e: any) => {
            map.getCanvas().style.cursor = 'pointer'
            const features = map.queryRenderedFeatures(e.point, { layers: ['photo-layer'] })
            if (features.length > 0) {
              const hoveredKey = features[0].properties?.key
              map.setFilter('photo-hover-layer', ['==', 'key', hoveredKey || ''])
            }
          })

          map.on('mouseleave', 'photo-layer', () => {
            map.getCanvas().style.cursor = ''
            map.setFilter('photo-hover-layer', ['==', 'key', ''])
          })

          // Click handler for photos showing a thumbnail popup with an navigation link
          map.on('click', 'photo-layer', (e: any) => {
            const features = map.queryRenderedFeatures(e.point, { layers: ['photo-layer'] })
            if (features.length > 0) {
              const feature = features[0]
              const coordinates = (feature.geometry as any).coordinates.slice()
              const { key, name, etag } = feature.properties

              while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
                coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360
              }

              const thumbUrl = `/api/files/thumbnail?key=${encodeURIComponent(key)}&etag=${encodeURIComponent(etag)}&size=320`

              const container = document.createElement('div')
              container.className = 'p-2 font-sans select-none'
              container.style.minWidth = '140px'

              const imgEl = document.createElement('img')
              imgEl.src = thumbUrl
              imgEl.className = 'w-32 h-20 object-cover rounded-md mb-2 shadow-sm border border-gray-100'
              container.appendChild(imgEl)

              const nameEl = document.createElement('div')
              nameEl.className = 'font-mono text-[10px] text-gray-700 truncate max-w-[128px] mb-2'
              nameEl.title = name
              nameEl.textContent = name
              container.appendChild(nameEl)

              const btnEl = document.createElement('button')
              btnEl.className = 'w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-1.5 px-2 rounded-lg text-[10px] text-center shadow-sm transition-colors cursor-pointer'
              btnEl.textContent = 'View Image'

              const popup = new maplibre.Popup({ closeButton: true, closeOnClick: true, className: 'custom-photo-popup' })
                .setLngLat(coordinates)

              btnEl.onclick = (event) => {
                event.preventDefault()
                event.stopPropagation()
                onSelectPhoto?.(key)
                popup.remove()
              }
              container.appendChild(btnEl)

              popup.setDOMContent(container).addTo(map)
            }
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

      if (!outputKey) {
        boundsRef.current = null
        setStatus('ready')
        return
      }

      try {
        const cacheBusterParam = cacheBuster ? `&t=${encodeURIComponent(cacheBuster)}` : ''
        const infoRes = await fetch(`/api/tiles/info?key=${encodeURIComponent(outputKey)}${cacheBusterParam}`)
        if (!infoRes.ok) throw new Error(`Failed to load tile info (${infoRes.status})`)
        const { bounds, minzoom, maxzoom } = (await infoRes.json()) as {
          bounds: [number, number, number, number]
          minzoom: number
          maxzoom: number
        }

        if (cancelled) return

        const tileUrl = `/api/tiles/{z}/{x}/{y}?key=${encodeURIComponent(outputKey)}${cacheBusterParam}`

        map.addSource('ortho', {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          minzoom: 0,
          maxzoom,
        })
        map.addLayer({ id: 'ortho-layer', type: 'raster', source: 'ortho' })

        // Move photo layers to the top above the orthophoto layer
        if (map.getLayer('photo-hover-layer')) {
          map.moveLayer('photo-hover-layer')
        }
        if (map.getLayer('photo-layer')) {
          map.moveLayer('photo-layer')
        }

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
  }, [outputKey, cacheBuster])

  // ── Fit bounds when fitBoundsTrigger changes ────────────────────────────────
  useEffect(() => {
    if (fitBoundsTrigger && fitBoundsTrigger > 0 && mapRef.current) {
      const map = mapRef.current
      map.resize()
      if (boundsRef.current) {
        map.fitBounds(boundsRef.current, { padding: 20, animate: true, duration: 300 })
      } else if (photos && photos.length > 0) {
        const validPhotos = photos.filter(
          (p) => typeof p.latitude === 'number' && typeof p.longitude === 'number'
        )
        if (validPhotos.length > 0) {
          const bounds = validPhotos.reduce(
            (acc, curr) => {
              return [
                Math.min(acc[0], curr.longitude!),
                Math.min(acc[1], curr.latitude!),
                Math.max(acc[2], curr.longitude!),
                Math.max(acc[3], curr.latitude!),
              ]
            },
            [
              validPhotos[0].longitude!,
              validPhotos[0].latitude!,
              validPhotos[0].longitude!,
              validPhotos[0].latitude!,
            ]
          ) as [number, number, number, number]

          const isSinglePoint = bounds[0] === bounds[2] && bounds[1] === bounds[3]
          if (isSinglePoint) {
            map.easeTo({ center: [bounds[0], bounds[1]], zoom: 16, duration: 300 })
          } else {
            map.fitBounds(bounds, { padding: 40, animate: true, duration: 300 })
          }
        }
      }
    }
  }, [fitBoundsTrigger])

  // ── Initial fit bounds for photos / initialLocation when outputKey is null ─
  useEffect(() => {
    if (status !== 'ready' || !mapRef.current || outputKey) return
    if (initialFitDoneRef.current) return

    const map = mapRef.current
    map.resize()

    // 1. Check if we have initialLocation (flight plan pin/polygon)
    if (initialLocation) {
      try {
        const geo = JSON.parse(initialLocation)
        if (geo.type === 'Point') {
          map.jumpTo({ center: geo.coordinates, zoom: 16 })
          initialFitDoneRef.current = true
          return
        } else if (geo.type === 'Polygon') {
          const coords = geo.coordinates[0] as [number, number][]
          const bounds = coords.reduce(
            (acc, curr) => {
              return [
                Math.min(acc[0], curr[0]),
                Math.min(acc[1], curr[1]),
                Math.max(acc[2], curr[0]),
                Math.max(acc[3], curr[1]),
              ]
            },
            [coords[0][0], coords[0][1], coords[0][0], coords[0][1]]
          ) as [number, number, number, number]

          map.fitBounds(bounds, { padding: 20, animate: false })
          initialFitDoneRef.current = true
          return
        }
      } catch (e) {
        console.error('[OrthoMap] failed to parse initialLocation for fit:', e)
      }
    }

    // 2. Check if we have photo locations
    if (photos && photos.length > 0) {
      const validPhotos = photos.filter(
        (p) => typeof p.latitude === 'number' && typeof p.longitude === 'number'
      )
      if (validPhotos.length > 0) {
        const bounds = validPhotos.reduce(
          (acc, curr) => {
            return [
              Math.min(acc[0], curr.longitude!),
              Math.min(acc[1], curr.latitude!),
              Math.max(acc[2], curr.longitude!),
              Math.max(acc[3], curr.latitude!),
            ]
          },
          [
            validPhotos[0].longitude!,
            validPhotos[0].latitude!,
            validPhotos[0].longitude!,
            validPhotos[0].latitude!,
          ]
        ) as [number, number, number, number]

        const isSinglePoint = bounds[0] === bounds[2] && bounds[1] === bounds[3]
        if (isSinglePoint) {
          map.jumpTo({ center: [bounds[0], bounds[1]], zoom: 16 })
        } else {
          map.fitBounds(bounds, { padding: 40, animate: false })
        }
        initialFitDoneRef.current = true
      }
    }
  }, [status, outputKey, initialLocation, photos])

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

  // Show/hide photo layer based on showPhotos state
  useEffect(() => {
    if (!mapRef.current || !mapReadyRef.current) return
    const map = mapRef.current
    const visibility = showPhotos ? 'visible' : 'none'

    if (map.getLayer('photo-layer')) {
      map.setLayoutProperty('photo-layer', 'visibility', visibility)
    }
    if (map.getLayer('photo-hover-layer')) {
      map.setLayoutProperty('photo-hover-layer', 'visibility', visibility)
    }
  }, [showPhotos, status])

  // Update photo markers GeoJSON source
  useEffect(() => {
    if (!mapRef.current || !mapReadyRef.current || !photos) return
    const source = mapRef.current.getSource('photo-source')
    if (source) {
      const features = photos
        .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number')
        .map((p) => ({
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [p.longitude!, p.latitude!],
          },
          properties: {
            key: p.key,
            name: p.name,
            etag: p.etag,
            size: p.size,
          },
        }))

      source.setData({
        type: 'FeatureCollection',
        features,
      })
    }
  }, [photos, status])

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

      {/* ─── Floating Photos Toggle Checkbox ─── */}
      {status === 'ready' && photos && photos.length > 0 && (
        <div className="absolute top-4 right-4 z-40 bg-white/95 backdrop-blur-sm px-3.5 py-2.5 rounded-2xl shadow-xl border border-gray-200/80 flex flex-col gap-1.5 select-none pointer-events-auto min-w-[170px]">
          <div className="flex items-center gap-2.5">
            <input
              type="checkbox"
              id="show-photos-toggle"
              checked={showPhotos}
              disabled={!photos.some(p => typeof p.latitude === 'number' && typeof p.longitude === 'number')}
              onChange={(e) => setShowPhotos(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <label
              htmlFor="show-photos-toggle"
              className={cn(
                "text-xs font-semibold cursor-pointer flex items-center gap-1.5",
                photos.some(p => typeof p.latitude === 'number' && typeof p.longitude === 'number') ? "text-gray-700" : "text-gray-400 cursor-not-allowed"
              )}
            >
              <ImageIcon className="w-3.5 h-3.5 text-gray-500" />
              <span>Show Photos on Map</span>
            </label>
          </div>
          {!photos.some(p => typeof p.latitude === 'number' && typeof p.longitude === 'number') && (
            <p className="text-[9px] text-amber-600 font-medium leading-tight max-w-[170px] mt-0.5">
              Click <span className="font-bold">Sync S3</span> in the sidebar to extract GPS data.
            </p>
          )}
        </div>
      )}

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
      {/* Basemap Switcher Control */}
      {status === 'ready' && (
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
      )}
    </div>
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
          layer.id === 'flight-plans-fill' ||
          layer.id === 'flight-plans-line' ||
          layer.id === 'flight-plans-point' ||
          layer.id === 'flight-plans-highlight-line' ||
          layer.id === 'flight-plans-highlight-point' ||
          layer.id === 'location-fill' ||
          layer.id === 'location-line' ||
          layer.id === 'location-point' ||
          layer.id === 'ortho-layer' ||
          layer.id === 'ortho-before-layer' ||
          layer.id === 'ortho-after-layer'
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
