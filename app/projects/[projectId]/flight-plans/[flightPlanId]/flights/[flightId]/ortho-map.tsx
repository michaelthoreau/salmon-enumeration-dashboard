'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { MapPin, Map, Check, X, RotateCcw, Trash2, Edit, ChevronDown, Image as ImageIcon, Layers, Ruler, Loader2, Plus, Minus, Sparkles } from 'lucide-react'
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
  annotations?: any[]
  onAddAnnotation?: (anno: { shape: 'point' | 'polygon' | 'linestring'; geometry: string; fishCount: number; confidence: number }) => Promise<void>
  onUpdateAnnotation?: (id: string, updates: { fishCount?: number; confidence?: number; geometry?: string }) => Promise<void>
  onDeleteAnnotation?: (id: string) => Promise<void>
}

function haversineDistance(coords1: [number, number], coords2: [number, number]): number {
  const [lon1, lat1] = coords1
  const [lon2, lat2] = coords2
  const R = 6371000 // Radius of Earth in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c // returns distance in meters
}

function getMeasureGeoJSON(points: [number, number][], cursorCoords: [number, number] | null) {
  if (points.length === 0) {
    return {
      type: 'FeatureCollection',
      features: [],
    }
  }

  const features: any[] = []

  // Add individual points
  points.forEach((pt, index) => {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: pt,
      },
      properties: {
        index: index + 1,
      },
    })
  })

  // Add connecting LineString (including current cursor position if active)
  const linePoints = cursorCoords ? [...points, cursorCoords] : points
  if (linePoints.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: linePoints,
      },
      properties: {},
    })
  }

  return {
    type: 'FeatureCollection',
    features,
  }
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
  annotations = [],
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
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
  const [showPhotos, setShowPhotos] = useState(true)
  const [basemap, setBasemap] = useState<'street' | 'satellite'>('satellite')

  // ── Annotation states ──────────────────────────────────────────────────────
  const [isAnnotating, setIsAnnotating] = useState(false)
  const isAnnotatingRef = useRef(false)
  const isMeasuringRef = useRef(false)
  // Refs for callbacks used inside stale-closure map handlers
  const onDeleteAnnotationRef = useRef(onDeleteAnnotation)

  // ── Prediction states ───────────────────────────────────────────────────────
  const [isPredicting, setIsPredicting] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [predictedPoints, setPredictedPoints] = useState<{ lng: number; lat: number; score: number }[]>([])
  const [predictError, setPredictError] = useState<string | null>(null)

  // ── Measurement states ──────────────────────────────────────────────────────
  const [isMeasuring, setIsMeasuring] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<[number, number][]>([])
  const [measureUnit, setMeasureUnit] = useState<'metric' | 'imperial'>('metric')
  const [cursorCoords, setCursorCoords] = useState<[number, number] | null>(null)
  const [isTilesLoading, setIsTilesLoading] = useState(false)

  // Sync showPhotos state if outputKey transitions from null to loaded
  useEffect(() => {
    setShowPhotos(true)
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
          maxZoom: 26,
        })

        mapRef.current = map
        map.addControl(new maplibre.AttributionControl({ compact: true }))
        map.addControl(new maplibre.NavigationControl(), 'top-right')

        const compass = containerRef.current.querySelector('.maplibregl-ctrl-compass') as HTMLButtonElement | null
        if (compass) {
          compass.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            map.resetNorthPitch()
          }, { capture: true })
        }

        const handleSourceData = (e: any) => {
          if (e.sourceId === 'ortho') {
            const loaded = map.isSourceLoaded('ortho')
            setIsTilesLoading(!loaded)
          }
        }

        const handleSourceDataLoading = (e: any) => {
          if (e.sourceId === 'ortho') {
            setIsTilesLoading(true)
          }
        }

        map.on('sourcedataloading', handleSourceDataLoading)
        map.on('sourcedata', handleSourceData)

        map.on('moveend', () => {
          if (cancelled) return
          onViewportChange?.({
            center: map.getCenter().toArray() as [number, number],
            zoom: map.getZoom(),
          })
        })

        // Also listen to style.load as a fallback in case load event already fired
        map.on('style.load', () => {
          if (cancelled || mapReadyRef.current) return
          console.log('[OrthoMap] Map style.load event fired')
          mapReadyRef.current = true
          map.resize()
          setupMapLayers(map)
        })

        map.on('load', () => {
          if (cancelled || mapReadyRef.current) return
          console.log('[OrthoMap] Map load event fired')
          mapReadyRef.current = true
          map.resize()
          setupMapLayers(map)
        })

        // Fallback: if map style is already loaded, set mapReadyRef.current to true immediately
        if (map.isStyleLoaded()) {
          console.log('[OrthoMap] Map style is already loaded on init')
          mapReadyRef.current = true
          setupMapLayers(map)
        }

        function setupMapLayers(map: any) {
          // Guard check: if layers already exist, don't re-add them
          if (map.getSource('esri-satellite')) return

          // Add Esri satellite source
          map.addSource('esri-satellite', {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            attribution: 'Tiles &copy; Esri',
            maxzoom: 17
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

          // Add annotations source and layers
          map.addSource('annotations-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })

          map.addLayer({
            id: 'annotations-layer',
            type: 'circle',
            source: 'annotations-source',
            paint: {
              'circle-color': '#ef4444',
              'circle-radius': 7,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
          })

          map.addLayer({
            id: 'annotations-hover-layer',
            type: 'circle',
            source: 'annotations-source',
            paint: {
              'circle-color': '#dc2626',
              'circle-radius': 10,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2.5,
              'circle-opacity': 0.9,
            },
            filter: ['==', 'id', ''],
          })

          // Add predictions source and layer (orange, preview mode)
          map.addSource('predictions-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })

          map.addLayer({
            id: 'predictions-layer',
            type: 'circle',
            source: 'predictions-source',
            paint: {
              'circle-color': '#f97316',
              'circle-radius': 7,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
          })

          // Add measure source and layers
          map.addSource('measure-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })

          map.addLayer({
            id: 'measure-line',
            type: 'line',
            source: 'measure-source',
            paint: {
              'line-color': '#f59e0b',
              'line-width': 3,
              'line-dasharray': [2, 2],
            },
            filter: ['==', '$type', 'LineString'],
          })

          map.addLayer({
            id: 'measure-point-halo',
            type: 'circle',
            source: 'measure-source',
            paint: {
              'circle-color': '#f59e0b',
              'circle-radius': 7,
              'circle-opacity': 0.4,
            },
            filter: ['==', '$type', 'Point'],
          })

          map.addLayer({
            id: 'measure-point',
            type: 'circle',
            source: 'measure-source',
            paint: {
              'circle-color': '#ffffff',
              'circle-radius': 4,
              'circle-stroke-color': '#d97706',
              'circle-stroke-width': 2,
            },
            filter: ['==', '$type', 'Point'],
          })

          // Hover handlers for photos
          map.on('mouseenter', 'photo-layer', (e: any) => {
            if (isAnnotatingRef.current || isMeasuringRef.current) return
            map.getCanvas().style.cursor = 'pointer'
            const features = map.queryRenderedFeatures(e.point, { layers: ['photo-layer'] })
            if (features.length > 0) {
              const hoveredKey = features[0].properties?.key
              map.setFilter('photo-hover-layer', ['==', 'key', hoveredKey || ''])
            }
          })

          map.on('mouseleave', 'photo-layer', () => {
            if (isAnnotatingRef.current || isMeasuringRef.current) return
            map.getCanvas().style.cursor = ''
            map.setFilter('photo-hover-layer', ['==', 'key', ''])
          })

          // Hover handlers for annotations
          map.on('mouseenter', 'annotations-layer', (e: any) => {
            map.getCanvas().style.cursor = 'pointer'
            const features = map.queryRenderedFeatures(e.point, { layers: ['annotations-layer'] })
            if (features.length > 0) {
              const hoveredId = features[0].properties?.id
              map.setFilter('annotations-hover-layer', ['==', 'id', hoveredId || ''])
            }
          })

          map.on('mouseleave', 'annotations-layer', () => {
            map.getCanvas().style.cursor = (isAnnotatingRef.current || isMeasuringRef.current) ? 'crosshair' : ''
            map.setFilter('annotations-hover-layer', ['==', 'id', ''])
          })

          // Click handler for annotations showing a popup with edit/delete controls
          map.on('click', 'annotations-layer', (e: any) => {
            const features = map.queryRenderedFeatures(e.point, { layers: ['annotations-layer'] })
            if (features.length > 0) {
              const feature = features[0]
              const coordinates = (feature.geometry as any).coordinates.slice()
              const { id, label, fishCount, confidence } = feature.properties

              while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
                coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360
              }

              const container = document.createElement('div')
              container.className = 'p-3 font-sans select-none flex flex-col gap-2.5 min-w-[180px]'

              const titleEl = document.createElement('div')
              titleEl.className = 'text-xs font-bold text-gray-800 border-b border-gray-100 pb-1.5 flex items-center justify-between'
              titleEl.innerHTML = `<span>🐟 Fish Annotation</span>`
              container.appendChild(titleEl)

              // Fish Count Input Row
              const countRow = document.createElement('div')
              countRow.className = 'flex items-center justify-between gap-2 text-xs'
              countRow.innerHTML = `<span className="text-gray-500 font-medium">Count:</span>`
              
              const countControls = document.createElement('div')
              countControls.className = 'flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-lg p-0.5'
              
              const decBtn = document.createElement('button')
              decBtn.className = 'p-1 hover:bg-gray-200 rounded text-gray-600 cursor-pointer'
              decBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`
              
              const countVal = document.createElement('span')
              countVal.className = 'font-bold text-gray-800 px-1 min-w-[16px] text-center'
              countVal.textContent = String(fishCount)

              const incBtn = document.createElement('button')
              incBtn.className = 'p-1 hover:bg-gray-200 rounded text-gray-600 cursor-pointer'
              incBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`

              countControls.appendChild(decBtn)
              countControls.appendChild(countVal)
              countControls.appendChild(incBtn)
              countRow.appendChild(countControls)
              container.appendChild(countRow)

              // Delete Button
              const deleteBtn = document.createElement('button')
              deleteBtn.className = 'w-full bg-red-50 hover:bg-red-100 text-red-600 font-semibold py-1.5 px-2 rounded-lg text-[10px] text-center border border-red-100 transition-colors cursor-pointer flex items-center justify-center gap-1 mt-1'
              deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Delete Annotation`

              container.appendChild(deleteBtn)

              const popup = new maplibre.Popup({ closeButton: true, closeOnClick: true, className: 'custom-annotation-popup' })
                .setLngLat(coordinates)

              decBtn.onclick = async (event) => {
                event.preventDefault()
                event.stopPropagation()
                const current = parseInt(countVal.textContent || '1', 10)
                if (current > 1) {
                  const next = current - 1
                  countVal.textContent = String(next)
                  if (onUpdateAnnotation) {
                    await onUpdateAnnotation(id, { fishCount: next })
                  }
                }
              }

              incBtn.onclick = async (event) => {
                event.preventDefault()
                event.stopPropagation()
                const current = parseInt(countVal.textContent || '1', 10)
                const next = current + 1
                countVal.textContent = String(next)
                if (onUpdateAnnotation) {
                  await onUpdateAnnotation(id, { fishCount: next })
                }
              }

              deleteBtn.onclick = async (event) => {
                event.preventDefault()
                event.stopPropagation()
                if (onDeleteAnnotation) {
                  await onDeleteAnnotation(id)
                }
                popup.remove()
              }

              popup.setDOMContent(container).addTo(map)
            }
          })

          // Right-click on an annotation = instant delete (no popup)
          map.on('contextmenu', 'annotations-layer', async (e: any) => {
            e.preventDefault()
            const features = map.queryRenderedFeatures(e.point, { layers: ['annotations-layer'] })
            if (features.length > 0) {
              const { id } = features[0].properties
              if (onDeleteAnnotationRef.current) {
                await onDeleteAnnotationRef.current(id)
              }
            }
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
        }
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
      const startTime = Date.now()
      console.log(`[OrthoMap] Starting applyLayer. outputKey: "${outputKey}", mapReadyRef: ${mapReadyRef.current}, mapRef: ${!!mapRef.current}`)
      
      // Wait for the map to be ready (style loaded)
      console.log('[OrthoMap] Waiting for mapReadyRef.current to be true...')
      const waitStart = Date.now()
      await new Promise<void>((resolve) => {
        if (mapReadyRef.current && mapRef.current) {
          console.log('[OrthoMap] Map is already ready on applyLayer start')
          return resolve()
        }
        let checkCount = 0
        const check = setInterval(() => {
          checkCount++
          if (cancelled) {
            console.log('[OrthoMap] applyLayer wait cancelled')
            clearInterval(check)
            return
          }
          if (!mapRef.current) {
            console.log(`[OrthoMap] [Check #${checkCount}] mapRef.current is still null/undefined`)
            return
          }
          if (mapReadyRef.current) {
            console.log(`[OrthoMap] mapReadyRef became true after ${Date.now() - waitStart}ms (${checkCount} checks)`)
            clearInterval(check)
            resolve()
          } else if (checkCount % 10 === 0) {
            console.log(`[OrthoMap] [Check #${checkCount}] Still waiting for mapReadyRef.current to be true... (mapRef.current: ${!!mapRef.current}, styleLoaded: ${mapRef.current?.isStyleLoaded()})`)
          }
        }, 100)
      })

      if (cancelled) {
        console.log('[OrthoMap] applyLayer cancelled after waiting for map readiness')
        return
      }
      if (!mapRef.current) {
        console.error('[OrthoMap] mapRef.current is null after wait block!')
        return
      }

      const map = mapRef.current

      // Remove existing ortho layer/source if present
      console.log('[OrthoMap] Cleaning up existing ortho layers/sources if present')
      if (map.getLayer('ortho-layer')) map.removeLayer('ortho-layer')
      if (map.getSource('ortho')) map.removeSource('ortho')

      if (!outputKey) {
        console.log('[OrthoMap] No outputKey provided, setting status to ready immediately')
        boundsRef.current = null
        setStatus('ready')
        setIsTilesLoading(false)
        return
      }

      console.log(`[OrthoMap] outputKey exists ("${outputKey}"). Setting status to loading...`)
      setStatus('loading')
      setIsTilesLoading(true)

      try {
        const cacheBusterParam = cacheBuster ? `&t=${encodeURIComponent(cacheBuster)}` : ''
        const infoFetchStart = Date.now()
        console.log(`[OrthoMap] Fetching tile info from /api/tiles/info for key: ${outputKey}`)
        const infoRes = await fetch(`/api/tiles/info?key=${encodeURIComponent(outputKey)}${cacheBusterParam}`)
        console.log(`[OrthoMap] Tile info fetch completed in ${Date.now() - infoFetchStart}ms with status: ${infoRes.status}`)
        
        if (!infoRes.ok) throw new Error(`Failed to load tile info (${infoRes.status})`)
        const { bounds, minzoom, maxzoom } = (await infoRes.json()) as {
          bounds: [number, number, number, number]
          minzoom: number
          maxzoom: number
        }

        console.log(`[OrthoMap] Parsed tile info: bounds=${JSON.stringify(bounds)}, minzoom=${minzoom}, maxzoom=${maxzoom}`)

        if (cancelled) {
          console.log('[OrthoMap] applyLayer cancelled after fetching tile info')
          return
        }

        const tileUrl = `/api/tiles/{z}/{x}/{y}?key=${encodeURIComponent(outputKey)}${cacheBusterParam}&tilesize=512`

        console.log('[OrthoMap] Adding ortho source and layer to map')
        map.addSource('ortho', {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 512,
          minzoom: 0,
          maxzoom,
        })
        map.addLayer({ id: 'ortho-layer', type: 'raster', source: 'ortho' })

        // Re-order layers above the orthophoto layer.
        // Stack order (bottom → top): annotations → predictions → location → photos → measure
        console.log('[OrthoMap] Re-ordering layers to keep photos/locations/measurements on top')

        // Annotations sit just above the ortho raster but below photo markers
        if (map.getLayer('annotations-layer')) {
          map.moveLayer('annotations-layer')
        }
        if (map.getLayer('annotations-hover-layer')) {
          map.moveLayer('annotations-hover-layer')
        }

        // Predicted points sit alongside annotations, above the ortho raster
        if (map.getLayer('predictions-layer')) {
          map.moveLayer('predictions-layer')
        }

        // Move location layers above annotations
        if (map.getLayer('location-fill')) {
          map.moveLayer('location-fill')
          map.moveLayer('location-line')
          map.moveLayer('location-point')
        }

        // Photo markers above location
        if (map.getLayer('photo-hover-layer')) {
          map.moveLayer('photo-hover-layer')
        }
        if (map.getLayer('photo-layer')) {
          map.moveLayer('photo-layer')
        }

        // Measure tool on top of everything
        if (map.getLayer('measure-line')) {
          map.moveLayer('measure-line')
          map.moveLayer('measure-point-halo')
          map.moveLayer('measure-point')
        }

        boundsRef.current = bounds
        if (!initialFitDoneRef.current) {
          console.log('[OrthoMap] Performing initial fitBounds to orthophoto bounds')
          map.resize()
          setTimeout(() => {
            if (!cancelled && mapRef.current) {
              mapRef.current.fitBounds([bounds[0], bounds[1], bounds[2], bounds[3]], {
                padding: 20,
                animate: false,
              })
              console.log('[OrthoMap] fitBounds completed')
            }
          }, 100)
          initialFitDoneRef.current = true
        }

        console.log(`[OrthoMap] applyLayer completed successfully in ${Date.now() - startTime}ms`)
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

    // 1. Check if we have initialLocation (flight route pin/polygon)
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

  // ── Handle Map Clicks for drawing, measuring, and annotating ──────────────────────────
  useEffect(() => {
    if (!mapRef.current) return
    const map = mapRef.current

    const handleClick = (e: any) => {
      if (isMeasuring) {
        const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]
        setMeasurePoints((prev) => [...prev, lngLat])
        return
      }

      if (isAnnotating && onAddAnnotation) {
        // Don't place a new annotation if we clicked an existing one or a photo dot
        const hits = map.queryRenderedFeatures(e.point, {
          layers: ['annotations-layer', 'photo-layer'],
        })
        if (hits.length > 0) return

        const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]
        onAddAnnotation({
          shape: 'point',
          geometry: JSON.stringify({ type: 'Point', coordinates: lngLat }),
          fishCount: 1,
          confidence: 1.0,
        })
        return
      }

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
  }, [isEditing, isMeasuring, isAnnotating, onAddAnnotation])

  // ── Handle Map Mouse Move for live measurement preview ──────────────────────
  useEffect(() => {
    if (!mapRef.current) return
    const map = mapRef.current

    const handleMouseMove = (e: any) => {
      if (isMeasuring && measurePoints.length > 0) {
        setCursorCoords([e.lngLat.lng, e.lngLat.lat])
      } else {
        setCursorCoords(null)
      }
    }

    map.on('mousemove', handleMouseMove)
    return () => {
      map.off('mousemove', handleMouseMove)
    }
  }, [isMeasuring, measurePoints.length])

  // ── Handle Escape key to cancel measurement ──────────────────────────────
  useEffect(() => {
    if (!isMeasuring) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMeasuring(false)
        setMeasurePoints([])
        setCursorCoords(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isMeasuring])

  // Keep refs in sync so stale-closure map handlers always read current values
  useEffect(() => { isAnnotatingRef.current = isAnnotating }, [isAnnotating])
  useEffect(() => { isMeasuringRef.current = isMeasuring }, [isMeasuring])
  useEffect(() => { onDeleteAnnotationRef.current = onDeleteAnnotation }, [onDeleteAnnotation])

  // Toggle crosshair cursor during edit, measure, or annotate mode
  useEffect(() => {
    if (!mapRef.current) return
    const canvas = mapRef.current.getCanvas()
    if (isEditing || isMeasuring || isAnnotating) {
      canvas.style.cursor = 'crosshair'
    } else {
      canvas.style.cursor = ''
    }
  }, [isEditing, isMeasuring, isAnnotating])

  // Update GeoJSON source representation when drawing/loading state changes
  useEffect(() => {
    if (!mapRef.current || !mapReadyRef.current) return
    const source = mapRef.current.getSource('location-source')
    if (source) {
      source.setData(getGeoJSON(pin, points))
    }
  }, [pin, points, status])

  // Update Measure GeoJSON source representation when points or cursor position change
  useEffect(() => {
    if (!mapRef.current || !mapReadyRef.current) return
    const source = mapRef.current.getSource('measure-source')
    if (source) {
      source.setData(getMeasureGeoJSON(measurePoints, cursorCoords))
    }
  }, [measurePoints, cursorCoords, status])

  // Show/hide measure layers based on isMeasuring state
  useEffect(() => {
    if (!mapRef.current || !mapReadyRef.current) return
    const map = mapRef.current
    const visibility = isMeasuring ? 'visible' : 'none'

    if (map.getLayer('measure-line')) {
      map.setLayoutProperty('measure-line', 'visibility', visibility)
    }
    if (map.getLayer('measure-point-halo')) {
      map.setLayoutProperty('measure-point-halo', 'visibility', visibility)
    }
    if (map.getLayer('measure-point')) {
      map.setLayoutProperty('measure-point', 'visibility', visibility)
    }
  }, [isMeasuring, status])

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

  // Update annotations GeoJSON source
  useEffect(() => {
    if (!mapRef.current || !mapReadyRef.current || !annotations) return
    const source = mapRef.current.getSource('annotations-source')
    if (source) {
      const features = annotations
        .map((anno) => {
          try {
            const geom = JSON.parse(anno.geometry)
            return {
              type: 'Feature' as const,
              geometry: geom,
              properties: {
                id: anno.id,
                label: anno.label,
                fishCount: anno.fishCount,
                confidence: anno.confidence,
              },
            }
          } catch (e) {
            console.error('Failed to parse annotation geometry:', e)
            return null
          }
        })
        .filter(Boolean) as any[]

      source.setData({
        type: 'FeatureCollection',
        features,
      })
    }
  }, [annotations, status])

  // Sync predicted points to the predictions MapLibre source
  useEffect(() => {
    if (!mapRef.current || !mapReadyRef.current) return
    const source = mapRef.current.getSource('predictions-source')
    if (!source) return
    source.setData({
      type: 'FeatureCollection',
      features: predictedPoints.map((p, i) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        properties: { score: p.score, index: i },
      })),
    })
  }, [predictedPoints, status])

  async function handlePredict() {
    if (!outputKey) return
    setIsPredicting(true)
    setPredictError(null)
    try {
      const res = await fetch('/api/ml/predict-ortho', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputKey, score_thresh: 0.25 }),
      })
      if (!res.ok) throw new Error(`Prediction failed (${res.status})`)
      const data = await res.json()
      if (!Array.isArray(data.points)) throw new Error('Invalid response from prediction API')
      setPredictedPoints(data.points)
      setIsPreviewing(true)
      if (data.points.length > 0 && mapRef.current) {
        const lngs = data.points.map((p: any) => p.lng)
        const lats = data.points.map((p: any) => p.lat)
        mapRef.current.fitBounds(
          [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
          { padding: 80, maxZoom: 22, duration: 800 }
        )
      }
    } catch (err: any) {
      setPredictError(err.message || 'Prediction failed')
    } finally {
      setIsPredicting(false)
    }
  }

  async function handleAcceptPredictions() {
    for (const p of predictedPoints) {
      await onAddAnnotation?.({
        shape: 'point',
        geometry: JSON.stringify({ type: 'Point', coordinates: [p.lng, p.lat] }),
        fishCount: 1,
        confidence: p.score,
      })
    }
    setPredictedPoints([])
    setIsPreviewing(false)
  }

  function handleDiscardPredictions() {
    setPredictedPoints([])
    setIsPreviewing(false)
    setPredictError(null)
  }

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
    if (!confirm('Are you sure you want to clear the location for this flight route?')) return
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

      {/* ─── Draw & Measure Panel Overlay ─── */}
      {status === 'ready' && (
        <div className="absolute top-4 left-4 z-40 pointer-events-auto flex flex-col gap-2">
          {/* Default State: Show both "Show Photos on Map" and "Measure Distance" buttons side by side if neither mode is active */}
          {!isMeasuring && (
            <div className="flex gap-2">
              {photos && photos.length > 0 && (
                <div className="bg-white/95 backdrop-blur-sm px-3.5 h-auto py-1.5 rounded-xl shadow-md border border-gray-200/80 flex items-center gap-2.5 select-none">
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
              )}
              
              {/* Annotate Toggle Button */}
              {editable && (
                <Button
                  size="sm"
                  variant={isAnnotating ? "default" : "outline"}
                  className={cn(
                    "rounded-xl shadow-md text-xs font-semibold gap-2 transition-all h-auto py-1.5",
                    isAnnotating
                      ? "bg-red-600 hover:bg-red-700 text-white border-red-600"
                      : "bg-white/95 border border-gray-200/80 hover:bg-gray-50"
                  )}
                  onClick={() => {
                    setIsAnnotating(!isAnnotating)
                    setIsMeasuring(false)
                    setMeasurePoints([])
                    setCursorCoords(null)
                  }}
                >
                  <span className="text-sm">🐟</span>
                  <span className="flex flex-col items-start leading-tight">
                    <span>{isAnnotating ? 'Annotating (Click Map)' : 'Annotate Fish'}</span>
                    <span className="text-[10px] font-normal opacity-75">Right-click marker to remove</span>
                  </span>
                </Button>
              )}

              {/* Predict Fish Button */}
              {editable && outputKey && !isPreviewing && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPredicting}
                  className="bg-white/95 border border-gray-200/80 hover:bg-orange-50 text-xs font-semibold gap-2 h-auto py-1.5 rounded-xl shadow-md"
                  onClick={handlePredict}
                >
                  {isPredicting ? (
                    <Loader2 className="w-4 h-4 text-orange-500 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4 text-orange-500" />
                  )}
                  <span>{isPredicting ? 'Predicting…' : 'Predict Fish'}</span>
                </Button>
              )}

              {/* Accept / Discard panel when previewing predictions */}
              {isPreviewing && (
                <div className="bg-white/95 backdrop-blur-sm px-3 py-2 rounded-xl shadow-md border border-orange-200 flex items-center gap-2 text-xs font-semibold">
                  <span className="text-orange-600">🐟 {predictedPoints.length} predicted</span>
                  <Button
                    size="sm"
                    className="h-7 px-2.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded-lg"
                    onClick={handleAcceptPredictions}
                  >
                    <Check className="w-3.5 h-3.5 mr-1" /> Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-xs rounded-lg border-gray-300"
                    onClick={handleDiscardPredictions}
                  >
                    <X className="w-3.5 h-3.5 mr-1" /> Discard
                  </Button>
                </div>
              )}

              {/* Prediction error toast */}
              {predictError && !isPreviewing && (
                <div className="bg-red-50 border border-red-200 text-red-600 text-[10px] px-3 py-1.5 rounded-xl shadow-sm max-w-[200px] truncate" title={predictError}>
                  {predictError}
                </div>
              )}

              <Button
                size="sm"
                variant="outline"
                className="bg-white/95 border border-gray-200/80 hover:bg-gray-50 text-xs font-semibold gap-2 h-auto py-1.5 rounded-xl shadow-md"
                onClick={() => {
                  setIsMeasuring(true)
                  setMeasurePoints([])
                  setCursorCoords(null)
                  setIsEditing(null)
                  setPanelOpen(false)
                  setIsAnnotating(false)
                }}
              >
                <Ruler className="w-4 h-4 text-amber-500" />
                <span>Measure</span>
              </Button>
            </div>
          )}

          {/* Active Distance Measurement Panel */}
          {isMeasuring && (
            <div className="bg-white/95 backdrop-blur-sm px-4 py-3.5 rounded-2xl shadow-xl border border-gray-200/80 flex flex-col gap-3 min-w-[240px] animate-in fade-in slide-in-from-top-2 duration-250">
              <div className="flex items-center justify-between pb-1.5 border-b border-gray-100">
                <div className="flex items-center gap-1.5">
                  <Ruler className="w-4 h-4 text-amber-500" />
                  <p className="text-xs font-semibold text-gray-700 select-none">
                    Measure
                  </p>
                </div>
                <button
                  onClick={() => {
                    setIsMeasuring(false)
                    setMeasurePoints([])
                    setCursorCoords(null)
                  }}
                  className="p-1 hover:bg-gray-100 rounded-md transition-colors text-gray-400 hover:text-gray-600 cursor-pointer"
                  title="Close measurement tool"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Cumulative Distance Display */}
              <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 flex flex-col items-center justify-center select-none text-center">
                <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">
                  Total Distance
                </span>
                <span className="text-xl font-bold text-gray-900 mt-0.5 tabular-nums">
                  {measureUnit === 'metric' ? (
                    // Decimal meters with cm resolution (2 decimal places)
                    <>
                      {(() => {
                        const baseMeters = measurePoints.reduce((acc, pt, idx) => {
                          if (idx === 0) return 0
                          return acc + haversineDistance(measurePoints[idx - 1], pt)
                        }, 0)
                        const extraMeters = (measurePoints.length > 0 && cursorCoords)
                          ? haversineDistance(measurePoints[measurePoints.length - 1], cursorCoords)
                          : 0
                        return (baseMeters + extraMeters).toFixed(2)
                      })()}{' '}
                      <span className="text-sm font-medium text-gray-500">m</span>
                    </>
                  ) : (
                    // Inches (1 decimal place)
                    <>
                      {(() => {
                        const baseMeters = measurePoints.reduce((acc, pt, idx) => {
                          if (idx === 0) return 0
                          return acc + haversineDistance(measurePoints[idx - 1], pt)
                        }, 0)
                        const extraMeters = (measurePoints.length > 0 && cursorCoords)
                          ? haversineDistance(measurePoints[measurePoints.length - 1], cursorCoords)
                          : 0
                        const totalInches = (baseMeters + extraMeters) * 39.3700787
                        return totalInches.toFixed(1)
                      })()}{' '}
                      <span className="text-sm font-medium text-gray-500">in</span>
                    </>
                  )}
                </span>
                <p className="text-[9px] text-gray-400 mt-1.5 font-medium leading-tight">
                  {measurePoints.length === 0
                    ? 'Click on the map to start measuring'
                    : `Segment path with ${measurePoints.length} node${measurePoints.length === 1 ? '' : 's'}`}
                </p>
              </div>

              {/* Unit Toggle Control (Metric vs Inches) */}
              <div className="flex items-center justify-between bg-gray-100/80 p-0.5 rounded-lg border border-gray-250 select-none">
                <button
                  type="button"
                  onClick={() => setMeasureUnit('metric')}
                  className={cn(
                    "flex-1 text-[10px] font-bold py-1 px-2.5 rounded-md transition-all cursor-pointer",
                    measureUnit === 'metric'
                      ? "bg-white text-gray-900 shadow-sm border border-gray-250/30"
                      : "text-gray-555 hover:text-gray-800"
                  )}
                >
                  Metric (m)
                </button>
                <button
                  type="button"
                  onClick={() => setMeasureUnit('imperial')}
                  className={cn(
                    "flex-1 text-[10px] font-bold py-1 px-2.5 rounded-md transition-all cursor-pointer",
                    measureUnit === 'imperial'
                      ? "bg-white text-gray-900 shadow-sm border border-gray-250/30"
                      : "text-gray-555 hover:text-gray-800"
                  )}
                >
                  Inches (in)
                </button>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 border-t border-gray-100 pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 text-xs h-8 hover:bg-gray-50 font-medium cursor-pointer"
                  onClick={() => setMeasurePoints((prev) => prev.slice(0, -1))}
                  disabled={measurePoints.length === 0}
                  title="Remove last coordinate node"
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1" />
                  Undo
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1 text-xs h-8 text-red-655 hover:text-red-700 hover:bg-red-50 font-semibold cursor-pointer"
                  onClick={() => {
                    setMeasurePoints([])
                    setCursorCoords(null)
                  }}
                  disabled={measurePoints.length === 0}
                  title="Clear path"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  Clear
                </Button>
              </div>
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

      {isTilesLoading && (
        <div className="absolute bottom-12 left-4 z-40 bg-white/95 backdrop-blur-sm px-3 py-2 rounded-xl shadow-md border border-gray-200/80 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-gray-500 pointer-events-none select-none animate-in fade-in duration-200">
          <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin" />
          <span>Loading Tiles...</span>
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
