'use client'

import { useEffect, useRef, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Map, Layers, Image, Video, Pentagon, Trash2, X, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { createGeofence, deleteGeofence, updateGeofenceColor } from '@/app/actions/geofences'
import 'maplibre-gl/dist/maplibre-gl.css'

const popupCss = `
.maplibregl-popup-close-button {
  right: 8px !important;
  top: 4px !important;
  font-size: 18px;
  padding: 2px 6px;
}
`

interface RouteEntry {
  id: string
  name: string
  description: string | null
  location: string
  imageCount: number
  videoCount: number
  flightCount: number
  flightDates: string[]
  thumbnails: { key: string; etag: string; fileId: string; flightId: string }[]
  latestFlightId: string | null
  latestFlightTimestamp: string | null
}

interface GeofenceEntry {
  id: string
  name: string
  geometry: string
  color: string
}

interface FileMarker {
  fileId: string
  key: string
  etag: string
  latitude: number
  longitude: number
  type: 'video' | 'image'
  planName: string
  flightId: string
  flightPlanId: string
  filename: string
  flightTimestamp: string | null
  fishCount: number
  geofenceTags: string[]
  durationSeconds: number | null
}

interface Props {
  projectId: string
  timezone: string
  routes: RouteEntry[]
  fileMarkers?: FileMarker[]
  geofences: GeofenceEntry[]
  canWrite: boolean
}

function getRouteColor(route: RouteEntry): string {
  if (route.videoCount > 0 && route.imageCount > 0) return '#8b5cf6' // purple — both
  if (route.videoCount > 0) return '#3b82f6' // blue — videos
  if (route.imageCount > 0) return '#22c55e' // green — images
  return '#6b7280' // gray — no files
}

function getBounds(routes: RouteEntry[]): [number, number, number, number] | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  let hasCoords = false

  for (const route of routes) {
    try {
      const geom = JSON.parse(route.location)
      if (geom.type === 'Point') {
        const [lng, lat] = geom.coordinates
        minLng = Math.min(minLng, lng); minLat = Math.min(minLat, lat)
        maxLng = Math.max(maxLng, lng); maxLat = Math.max(maxLat, lat)
        hasCoords = true
      } else if (geom.type === 'Polygon') {
        for (const ring of geom.coordinates) {
          for (const [lng, lat] of ring) {
            minLng = Math.min(minLng, lng); minLat = Math.min(minLat, lat)
            maxLng = Math.max(maxLng, lng); maxLat = Math.max(maxLat, lat)
            hasCoords = true
          }
        }
      }
    } catch { /* skip */ }
  }

  return hasCoords ? [minLng, minLat, maxLng, maxLat] : null
}

function buildPopupHtml(route: RouteEntry, projectId: string): string {
  const thumbsHtml = route.thumbnails.length > 0
    ? `<div style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;">${route.thumbnails
        .map(
          (t) =>
            `<img src="/api/files/thumbnail?key=${encodeURIComponent(t.key)}&etag=${encodeURIComponent(t.etag)}&size=120" style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;" />`
        )
        .join('')}</div>`
    : ''

  const colorDot = (color: string, label: string, count: number) =>
    count > 0
      ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:#374151;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};"></span>${count} ${label}</span>`
      : ''

  const stats = [
    colorDot('#22c55e', 'images', route.imageCount),
    colorDot('#3b82f6', 'videos', route.videoCount),
  ].filter(Boolean).join('<span style="color:#d1d5db;margin:0 4px;">·</span>')

  const datesHtml = route.flightDates.length > 0
    ? `<p style="font-size:10px;color:#6b7280;margin:4px 0 0;">${route.flightDates.slice(0, 3).join(', ')}${route.flightDates.length > 3 ? ` +${route.flightDates.length - 3} more` : ''}</p>`
    : '<p style="font-size:10px;color:#9ca3af;margin:4px 0 0;font-style:italic;">No flights logged</p>'

  const detailLink = route.latestFlightId
    ? `<a href="/projects/${projectId}/flight-plans/${route.id}/flights" style="display:inline-block;margin-top:10px;font-size:11px;font-weight:600;color:#2563eb;text-decoration:none;">View flights →</a>`
    : `<a href="/projects/${projectId}/flight-plans/${route.id}/flights" style="display:inline-block;margin-top:10px;font-size:11px;font-weight:600;color:#2563eb;text-decoration:none;">View route →</a>`

  return `
    <div style="font-family:ui-sans-serif,system-ui,sans-serif;padding:12px;max-width:280px;">
      <h3 style="font-weight:700;font-size:14px;color:#111827;margin:0;">${route.name}</h3>
      ${route.description ? `<p style="font-size:12px;color:#6b7280;margin-top:4px;margin-bottom:0;">${route.description}</p>` : ''}
      <div style="margin-top:8px;">${stats}</div>
      ${datesHtml}
      ${thumbsHtml}
      ${detailLink}
    </div>
  `
}

const GEOFENCE_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6']

export default function MapView({ projectId, timezone, routes, fileMarkers = [], geofences, canWrite }: Props) {
  const router = useRouter()
  const mapContainerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [basemap, setBasemap] = useState<'street' | 'satellite'>('satellite')
  const [filterType, setFilterType] = useState<'all' | 'images' | 'videos'>('videos')

  // Geofence drawing state
  const [isDrawing, setIsDrawing] = useState(false)
  const [drawPoints, setDrawPoints] = useState<[number, number][]>([])
  const [cursorCoord, setCursorCoord] = useState<[number, number] | null>(null)
  const [showNameDialog, setShowNameDialog] = useState(false)
  const [geofenceName, setGeofenceName] = useState('')
  const [geofenceColor, setGeofenceColor] = useState(GEOFENCE_COLORS[0])
  const [isSaving, setIsSaving] = useState(false)
  const [showGeofenceList, setShowGeofenceList] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingColorId, setEditingColorId] = useState<string | null>(null)
  const [showImageLabels, setShowImageLabels] = useState(false)
  const [showVideoLabels, setShowVideoLabels] = useState(false)
  const [showGeofenceLabels, setShowGeofenceLabels] = useState(false)
  const [statsStartDate, setStatsStartDate] = useState('')
  const [statsStartTime, setStatsStartTime] = useState('')
  const [statsEndDate, setStatsEndDate] = useState('')
  const [statsEndTime, setStatsEndTime] = useState('')
  const [selectedGeofences, setSelectedGeofences] = useState<string[]>([])
  const [rateMode, setRateMode] = useState<'hourly' | 'daily'>('hourly')
  const [bothBanks, setBothBanks] = useState(false)
  const [statsExpanded, setStatsExpanded] = useState(true)

  const filteredRoutes = useMemo(() => {
    if (filterType === 'all') return routes
    if (filterType === 'images') return routes.filter((r) => r.imageCount > 0)
    return routes.filter((r) => r.videoCount > 0)
  }, [routes, filterType])

  const filteredFileMarkers = useMemo(() => {
    if (filterType === 'all') return fileMarkers
    if (filterType === 'images') return fileMarkers.filter((f) => f.type === 'image')
    return fileMarkers.filter((f) => f.type === 'video')
  }, [fileMarkers, filterType])

  // Stats panel computation
  const statsVideos = useMemo(() => {
    if (!statsStartDate) return null
    const toMs = (date: string, time: string) => {
      const [y, mo, d] = date.split('-').map(Number)
      const [h, m] = time ? time.split(':').map(Number) : [0, 0]
      return new Date(y, mo - 1, d, h, m).getTime()
    }
    const startMs = toMs(statsStartDate, statsStartTime)
    const endMs = statsEndDate
      ? toMs(statsEndDate, statsEndTime || '23:59')
      : toMs(statsStartDate, statsEndTime || '23:59')

    return fileMarkers.filter((f) => {
      if (f.type !== 'video' || !f.flightTimestamp) return false
      const ts = new Date(f.flightTimestamp).getTime()
      if (ts < startMs || ts > endMs) return false
      if (selectedGeofences.length > 0 && !selectedGeofences.some((g) => f.geofenceTags.includes(g))) return false
      return true
    })
  }, [fileMarkers, statsStartDate, statsStartTime, statsEndDate, statsEndTime, selectedGeofences])

  const statsCounted = useMemo(() => statsVideos?.filter((v) => v.fishCount > 0 && v.durationSeconds) ?? [], [statsVideos])
  const statsTotalFish = useMemo(() => statsCounted.reduce((s, v) => s + v.fishCount, 0), [statsCounted])

  const computeRate = (v: typeof fileMarkers[0]) => {
    if (!v.durationSeconds || v.durationSeconds <= 0 || v.fishCount <= 0) return null
    const hourly = v.fishCount / (v.durationSeconds / 3600)
    const rate = rateMode === 'daily' ? hourly * 24 : hourly
    return bothBanks ? rate * 2 : rate
  }

  // Build GeoJSON for routes
  const routeGeojson = useMemo(() => {
    const features = filteredRoutes
      .map((route) => {
        try {
          const geom = JSON.parse(route.location)
          return {
            type: 'Feature' as const,
            geometry: geom,
            properties: {
              id: route.id,
              name: route.name,
              description: route.description ?? '',
              color: getRouteColor(route),
              imageCount: route.imageCount,
              videoCount: route.videoCount,
              flightCount: route.flightCount,
            },
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)

    return { type: 'FeatureCollection' as const, features: features as any[] }
  }, [filteredRoutes])

  // Build GeoJSON for file markers
  const fileMarkerGeojson = useMemo(() => {
    const features = filteredFileMarkers.map((f) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [f.longitude, f.latitude] },
      properties: {
        fileId: f.fileId,
        filename: f.filename,
        type: f.type,
        planName: f.planName,
        color: f.type === 'video' ? '#3b82f6' : '#22c55e',
        flightId: f.flightId,
        flightPlanId: f.flightPlanId,
        key: f.key,
        etag: f.etag,
      },
    }))
    return { type: 'FeatureCollection' as const, features: features as any[] }
  }, [filteredFileMarkers])

  // Build GeoJSON for geofences
  const geofenceGeojson = useMemo(() => {
    const features = geofences
      .map((g) => {
        try {
          const geom = JSON.parse(g.geometry)
          return {
            type: 'Feature' as const,
            geometry: geom,
            properties: { id: g.id, name: g.name, color: g.color },
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)

    return { type: 'FeatureCollection' as const, features: features as any[] }
  }, [geofences])

  // Inject popup CSS
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = popupCss
    document.head.appendChild(style)
    return () => { document.head.removeChild(style) }
  }, [])

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current) return
    let cancelled = false

    async function initMap() {
      const maplibre = (await import('maplibre-gl')).default
      if (cancelled || !mapContainerRef.current) return

      const map = new maplibre.Map({
        container: mapContainerRef.current,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        zoom: 10,
        center: [-158.55, 59.12],
        attributionControl: false,
        maxZoom: 26,
      })

      mapRef.current = map
      map.addControl(new maplibre.AttributionControl({ compact: true }))
      map.addControl(new maplibre.NavigationControl(), 'top-right')

      map.on('load', () => {
        if (cancelled) return
        setMapReady(true)

        // Satellite basemap
        map.addSource('esri-satellite', {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: 'Tiles &copy; Esri',
          maxzoom: 17,
        })

        const firstLayerId = map.getStyle().layers?.[0]?.id
        map.addLayer(
          {
            id: 'esri-satellite-layer',
            type: 'raster',
            source: 'esri-satellite',
            layout: { visibility: 'visible' },
          },
          firstLayerId,
        )

        updateMapBasemap(map, basemap)

        // Geofence layers
        map.addSource('geofences-source', { type: 'geojson', data: geofenceGeojson as any })
        map.addLayer({
          id: 'geofences-fill',
          type: 'fill',
          source: 'geofences-source',
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 },
        })
        map.addLayer({
          id: 'geofences-line',
          type: 'line',
          source: 'geofences-source',
          paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [3, 2] },
        })

        // Route layers
        map.addSource('routes-source', { type: 'geojson', data: routeGeojson as any })
        map.addLayer({
          id: 'routes-fill',
          type: 'fill',
          source: 'routes-source',
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.2 },
          filter: ['==', '$type', 'Polygon'],
        })
        map.addLayer({
          id: 'routes-line',
          type: 'line',
          source: 'routes-source',
          paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
          filter: ['in', '$type', 'LineString', 'Polygon'],
        })
        map.addLayer({
          id: 'routes-point',
          type: 'circle',
          source: 'routes-source',
          paint: {
            'circle-color': ['get', 'color'],
            'circle-radius': 9,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
          filter: ['==', '$type', 'Point'],
        })

        // File marker layers
        map.addSource('file-markers-source', { type: 'geojson', data: fileMarkerGeojson as any })
        map.addLayer({
          id: 'file-markers-point',
          type: 'circle',
          source: 'file-markers-source',
          paint: {
            'circle-color': ['get', 'color'],
            'circle-radius': 7,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
          },
        })
        map.addLayer({
          id: 'file-markers-label',
          type: 'symbol',
          source: 'file-markers-source',
          layout: {
            'text-field': ['get', 'filename'],
            'text-size': 10,
            'text-anchor': 'top',
            'text-offset': [0, 1],
            'visibility': 'none',
          },
          paint: {
            'text-color': '#374151',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1,
          },
        })

        // Geofence label layer
        map.addLayer({
          id: 'geofences-label',
          type: 'symbol',
          source: 'geofences-source',
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 12,
            'text-anchor': 'center',
            'visibility': 'none',
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.5,
          },
        })

        // Click handler for file marker popups
        map.on('click', 'file-markers-point', (e: any) => {
          const feature = e.features[0]
          const props = feature.properties
          const isImage = props.type === 'image'
          const thumbHtml = isImage
            ? `<img src="/api/files/thumbnail?key=${encodeURIComponent(props.key)}&etag=${encodeURIComponent(props.etag)}&size=200" style="width:100%;max-width:200px;height:auto;border-radius:6px;margin-top:8px;border:1px solid #e5e7eb;" />`
            : ''

          const popupHtml = `
            <div style="font-family:ui-sans-serif,system-ui,sans-serif;padding:12px;max-width:240px;">
              <h3 style="font-weight:700;font-size:13px;color:#111827;margin:0;word-break:break-all;">${props.filename}</h3>
              <p style="font-size:11px;color:#6b7280;margin:4px 0 0;">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${props.color};margin-right:4px;vertical-align:middle;"></span>
                ${props.type === 'video' ? 'Video' : 'Image'} · ${props.planName}
              </p>
              ${thumbHtml}
              <a href="/projects/${projectId}/flight-plans/${props.flightPlanId}/flights/${props.flightId}?file=${props.fileId}" style="display:inline-block;margin-top:10px;font-size:11px;font-weight:600;color:#2563eb;text-decoration:none;">
                Open flight details →
              </a>
            </div>
          `

          new maplibre.Popup({ maxWidth: '280px' })
            .setLngLat(e.lngLat)
            .setHTML(popupHtml)
            .addTo(map)
        })

        map.on('mouseenter', 'file-markers-point', () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', 'file-markers-point', () => {
          map.getCanvas().style.cursor = ''
        })

        // Click handler for route popups
        const clickLayers = ['routes-fill', 'routes-point']
        clickLayers.forEach((layerId) => {
          map.on('click', layerId, (e: any) => {
            const feature = e.features[0]
            const routeId = feature.properties.id
            const route = routes.find((r) => r.id === routeId)
            if (!route) return

            new maplibre.Popup({ maxWidth: '320px' })
              .setLngLat(e.lngLat)
              .setHTML(buildPopupHtml(route, projectId))
              .addTo(map)
          })

          map.on('mouseenter', layerId, () => {
            map.getCanvas().style.cursor = 'pointer'
          })
          map.on('mouseleave', layerId, () => {
            map.getCanvas().style.cursor = ''
          })
        })

        // Zoom to bounds
        const bounds = getBounds(routes)
        if (bounds) {
          map.fitBounds(bounds, { padding: 60, maxZoom: 15, animate: false })
        }
      })
    }

    initMap()

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update route data when filter changes
  useEffect(() => {
    if (!mapRef.current || !mapReady) return
    const source = mapRef.current.getSource('routes-source')
    if (source) source.setData(routeGeojson)
  }, [routeGeojson, mapReady])

  // Update file markers when filter changes
  useEffect(() => {
    if (!mapRef.current || !mapReady) return
    const source = mapRef.current.getSource('file-markers-source')
    if (source) source.setData(fileMarkerGeojson)
  }, [fileMarkerGeojson, mapReady])

  // Sync basemap
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    updateMapBasemap(mapRef.current, basemap)
  }, [basemap, mapReady])

  // Update geofence data
  useEffect(() => {
    if (!mapRef.current || !mapReady) return
    const source = mapRef.current.getSource('geofences-source')
    if (source) source.setData(geofenceGeojson)
  }, [geofenceGeojson, mapReady])

  // Label visibility
  useEffect(() => {
    if (!mapRef.current || !mapReady) return
    const map = mapRef.current
    if (map.getLayer('geofences-label')) {
      map.setLayoutProperty('geofences-label', 'visibility', showGeofenceLabels ? 'visible' : 'none')
    }
    if (map.getLayer('file-markers-label')) {
      const types: string[] = []
      if (showImageLabels) types.push('image')
      if (showVideoLabels) types.push('video')
      if (types.length === 0) {
        map.setLayoutProperty('file-markers-label', 'visibility', 'none')
      } else {
        map.setLayoutProperty('file-markers-label', 'visibility', 'visible')
        map.setFilter('file-markers-label', ['in', ['get', 'type'], ['literal', types]])
      }
    }
  }, [showImageLabels, showVideoLabels, showGeofenceLabels, mapReady])

  // Drawing polygon preview layer
  useEffect(() => {
    if (!mapRef.current || !mapReady) return
    const map = mapRef.current

    const allPoints = cursorCoord && isDrawing ? [...drawPoints, cursorCoord] : drawPoints
    const closed = allPoints.length >= 3 ? [...allPoints, allPoints[0]] : allPoints

    const lineData: any = {
      type: 'FeatureCollection',
      features: allPoints.length >= 2
        ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: closed }, properties: {} }]
        : [],
    }
    const pointData: any = {
      type: 'FeatureCollection',
      features: drawPoints.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: p },
        properties: {},
      })),
    }

    if (!map.getSource('draw-line')) {
      map.addSource('draw-line', { type: 'geojson', data: lineData })
      map.addLayer({
        id: 'draw-line-layer',
        type: 'line',
        source: 'draw-line',
        paint: { 'line-color': geofenceColor, 'line-width': 2, 'line-dasharray': [4, 2] },
      })
      map.addSource('draw-points', { type: 'geojson', data: pointData })
      map.addLayer({
        id: 'draw-points-layer',
        type: 'circle',
        source: 'draw-points',
        paint: {
          'circle-color': geofenceColor,
          'circle-radius': 5,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      })
    } else {
      map.getSource('draw-line')?.setData(lineData)
      map.getSource('draw-points')?.setData(pointData)
      if (map.getLayer('draw-line-layer')) {
        map.setPaintProperty('draw-line-layer', 'line-color', geofenceColor)
      }
      if (map.getLayer('draw-points-layer')) {
        map.setPaintProperty('draw-points-layer', 'circle-color', geofenceColor)
      }
    }
  }, [drawPoints, cursorCoord, isDrawing, mapReady, geofenceColor])

  // Map click handler for drawing
  useEffect(() => {
    if (!mapRef.current || !mapReady) return
    const map = mapRef.current

    const handleClick = (e: any) => {
      if (!isDrawing) return
      const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      setDrawPoints((prev) => [...prev, lngLat])
    }

    const handleDblClick = (e: any) => {
      if (!isDrawing) return
      e.preventDefault()
      if (drawPoints.length >= 3) {
        setIsDrawing(false)
        setCursorCoord(null)
        setShowNameDialog(true)
      }
    }

    const handleMouseMove = (e: any) => {
      if (!isDrawing) return
      setCursorCoord([e.lngLat.lng, e.lngLat.lat])
    }

    map.on('click', handleClick)
    map.on('dblclick', handleDblClick)
    map.on('mousemove', handleMouseMove)

    return () => {
      map.off('click', handleClick)
      map.off('dblclick', handleDblClick)
      map.off('mousemove', handleMouseMove)
    }
  }, [isDrawing, drawPoints, mapReady])

  // Escape to cancel drawing
  useEffect(() => {
    if (!isDrawing) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsDrawing(false)
        setDrawPoints([])
        setCursorCoord(null)
      } else if (e.key === 'Enter' && drawPoints.length >= 3) {
        setIsDrawing(false)
        setCursorCoord(null)
        setShowNameDialog(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isDrawing, drawPoints.length])

  // Cursor style while drawing
  useEffect(() => {
    if (!mapRef.current) return
    mapRef.current.getCanvas().style.cursor = isDrawing ? 'crosshair' : ''
  }, [isDrawing])

  function startDrawing() {
    setDrawPoints([])
    setCursorCoord(null)
    setGeofenceName('')
    setGeofenceColor(GEOFENCE_COLORS[0])
    setIsDrawing(true)
  }

  function cancelDrawing() {
    setIsDrawing(false)
    setDrawPoints([])
    setCursorCoord(null)
    setShowNameDialog(false)
    setGeofenceName('')
  }

  async function saveGeofence() {
    if (!geofenceName.trim() || drawPoints.length < 3) return
    setIsSaving(true)

    const ring = [...drawPoints, drawPoints[0]]
    const geometry = JSON.stringify({ type: 'Polygon', coordinates: [ring] })

    const result = await createGeofence(projectId, geofenceName.trim(), geometry, geofenceColor)
    setIsSaving(false)

    if (result.error) {
      alert(result.error)
      return
    }

    setShowNameDialog(false)
    setDrawPoints([])
    setGeofenceName('')
    router.refresh()
  }

  async function handleDeleteGeofence(id: string) {
    setDeletingId(id)
    const result = await deleteGeofence(id, projectId)
    setDeletingId(null)
    if (result.error) {
      alert(result.error)
      return
    }
    router.refresh()
  }

  async function handleUpdateColor(id: string, color: string) {
    setEditingColorId(null)
    await updateGeofenceColor(id, projectId, color)
    router.refresh()
  }

  return (
    <div className="fixed top-[100px] bottom-0 left-0 right-0 z-10 bg-gray-50">
      <div className="w-full h-full relative">
        <div ref={mapContainerRef} className="w-full h-full absolute inset-0" />

        {/* Filter controls */}
        <div className="absolute top-4 left-4 z-40 flex flex-col gap-2">
          {/* File type filter */}
          <div className="bg-white/90 hover:bg-white backdrop-blur-sm p-1 rounded-xl shadow-md border border-gray-200/80 flex gap-1 select-none transition-all">
            {([
              { value: 'all', label: 'All', icon: Layers },
              { value: 'images', label: 'Images', icon: Image },
              { value: 'videos', label: 'Videos', icon: Video },
            ] as const).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilterType(value)}
                className={cn(
                  'px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1.5 h-7',
                  filterType === value
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {/* Label toggles */}
          <div className="bg-white/90 hover:bg-white backdrop-blur-sm p-1 rounded-xl shadow-md border border-gray-200/80 flex gap-1 select-none transition-all">
            <span className="px-2 flex items-center text-[10px] font-bold text-gray-400 uppercase tracking-wider">Labels</span>
            {([
              { label: 'Images', active: showImageLabels, toggle: () => setShowImageLabels((v) => !v) },
              { label: 'Videos', active: showVideoLabels, toggle: () => setShowVideoLabels((v) => !v) },
              { label: 'Geofences', active: showGeofenceLabels, toggle: () => setShowGeofenceLabels((v) => !v) },
            ]).map(({ label, active, toggle }) => (
              <button
                key={label}
                type="button"
                onClick={toggle}
                className={cn(
                  'px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all h-7',
                  active
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Legend */}
          <div className="bg-white/90 backdrop-blur-sm px-3 py-2 rounded-xl shadow-md border border-gray-200/80 select-none">
            <p className="text-[9px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">Legend</p>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-[10px] text-gray-600">
                <span className="w-2.5 h-2.5 rounded-full bg-[#22c55e] flex-shrink-0" />
                <span>Images only</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-600">
                <span className="w-2.5 h-2.5 rounded-full bg-[#3b82f6] flex-shrink-0" />
                <span>Videos only</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-600">
                <span className="w-2.5 h-2.5 rounded-full bg-[#8b5cf6] flex-shrink-0" />
                <span>Both</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-600">
                <span className="w-2.5 h-2.5 rounded-full bg-[#6b7280] flex-shrink-0" />
                <span>No files</span>
              </div>
            </div>
          </div>

          {/* Stats panel — videos only */}
          {filterType === 'videos' && (
            <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-md border border-gray-200/80 select-none w-56 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Statistics</p>
                <button type="button" onClick={() => setStatsExpanded((v) => !v)}
                  className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors text-sm font-bold leading-none">
                  {statsExpanded ? '−' : '+'}
                </button>
              </div>
              {statsExpanded && (
                <div className="p-3 space-y-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-gray-400 font-medium">Start</p>
                      {statsStartTime && <span className="text-[10px] font-mono text-gray-500">{statsStartTime}</span>}
                    </div>
                    <input type="date" value={statsStartDate} onChange={(e) => setStatsStartDate(e.target.value)}
                      className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <input type="range" min={0} max={1439} step={5}
                      value={statsStartTime ? parseInt(statsStartTime.split(':')[0]) * 60 + parseInt(statsStartTime.split(':')[1]) : 0}
                      onChange={(e) => { const m = Number(e.target.value); setStatsStartTime(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`) }}
                      className="w-full accent-blue-500" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-gray-400 font-medium">End</p>
                      {statsEndTime && <span className="text-[10px] font-mono text-gray-500">{statsEndTime}</span>}
                    </div>
                    <input type="date" value={statsEndDate} onChange={(e) => setStatsEndDate(e.target.value)}
                      className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <input type="range" min={0} max={1439} step={5}
                      value={statsEndTime ? parseInt(statsEndTime.split(':')[0]) * 60 + parseInt(statsEndTime.split(':')[1]) : 1439}
                      onChange={(e) => { const m = Number(e.target.value); setStatsEndTime(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`) }}
                      className="w-full accent-blue-500" />
                  </div>
                  {geofences.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[10px] text-gray-400 font-medium">Locations</p>
                      <div className="space-y-1 max-h-28 overflow-y-auto">
                        {geofences.map((g) => (
                          <label key={g.id} className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={selectedGeofences.includes(g.name)}
                              onChange={(e) => setSelectedGeofences((prev) => e.target.checked ? [...prev, g.name] : prev.filter((n) => n !== g.name))}
                              className="rounded" />
                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: g.color }} />
                            <span className="text-xs text-gray-700 truncate">{g.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <div className="flex gap-1">
                      {(['hourly', 'daily'] as const).map((mode) => (
                        <button key={mode} type="button" onClick={() => setRateMode(mode)}
                          className={cn('flex-1 py-1 text-[10px] font-bold rounded-lg transition-all',
                            rateMode === mode ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
                          {mode === 'hourly' ? 'Hourly' : 'Daily'}
                        </button>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={bothBanks} onChange={(e) => setBothBanks(e.target.checked)} className="rounded" />
                      <span className="text-xs text-gray-600">× 2 both banks</span>
                    </label>
                  </div>
                  {statsVideos !== null && (
                    <div className="border-t border-gray-100 pt-2 space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Matched</span>
                        <span className="font-semibold text-gray-800">{statsVideos.length} videos</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Total fish</span>
                        <span className="font-semibold text-gray-800">{statsTotalFish}</span>
                      </div>
                      {statsCounted.length > 0 && (() => {
                        const rates = statsCounted.map((v) => computeRate(v)).filter((r): r is number => r !== null)
                        const avg = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null
                        return avg !== null ? (
                          <div className="flex justify-between text-xs">
                            <span className="text-gray-500">Avg {rateMode}</span>
                            <span className="font-semibold text-gray-800">{Math.round(avg).toLocaleString()}{rateMode === 'hourly' ? '/hr' : '/day'}</span>
                          </div>
                        ) : null
                      })()}
                      <p className="text-[10px] text-gray-400 pt-0.5">{statsCounted.length} of {statsVideos.length} with duration</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Video table */}
          {filterType === 'videos' && statsVideos !== null && statsVideos.length > 0 && (
            <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-md border border-gray-200/80 w-56 overflow-hidden">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2 border-b border-gray-100">Videos ({statsVideos.length})</p>
              <div className="overflow-y-auto" style={{ maxHeight: '12rem', minHeight: '4rem' }}>
                <table className="w-full text-[10px]">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium text-gray-500">File</th>
                      <th className="text-right px-2 py-1.5 font-medium text-gray-500">Fish</th>
                      <th className="text-right px-2 py-1.5 font-medium text-gray-500">{rateMode === 'hourly' ? '/hr' : '/day'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {statsVideos.map((v) => {
                      const rate = computeRate(v)
                      return (
                        <tr key={v.fileId} className="hover:bg-gray-50">
                          <td className="px-2 py-1.5 max-w-[90px]">
                            <p className="truncate text-gray-600" title={v.filename}>{v.filename.replace(/\.[^.]+$/, '')}</p>
                            {v.geofenceTags.length > 0 && <p className="text-gray-400 truncate">{v.geofenceTags[0]}</p>}
                          </td>
                          <td className="px-2 py-1.5 text-right font-medium text-gray-700">
                            {v.fishCount > 0 ? v.fishCount : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right font-medium text-blue-600">
                            {rate !== null ? Math.round(rate).toLocaleString() : <span className="text-gray-300">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Geofence controls */}
        {canWrite && (
          <div className="absolute top-4 right-16 z-40 flex items-center gap-2">
            {geofences.length > 0 && (
              <button
                type="button"
                onClick={() => setShowGeofenceList((v) => !v)}
                className={cn(
                  'bg-white/90 hover:bg-white backdrop-blur-sm px-3 py-1.5 rounded-xl shadow-md border border-gray-200/80 text-xs font-semibold transition-all',
                  showGeofenceList ? 'text-blue-600 border-blue-300' : 'text-gray-700',
                )}
              >
                {geofences.length} geofence{geofences.length !== 1 ? 's' : ''}
              </button>
            )}
            {!isDrawing && (
              <button
                type="button"
                onClick={startDrawing}
                className="bg-white/90 hover:bg-white backdrop-blur-sm px-3 py-1.5 rounded-xl shadow-md border border-gray-200/80 text-xs font-semibold text-gray-700 hover:text-blue-600 transition-all flex items-center gap-1.5"
              >
                <Pentagon className="w-3.5 h-3.5" />
                <span>Draw Geofence</span>
              </button>
            )}
          </div>
        )}

        {/* Route count badge */}
        {!canWrite && (
          <div className="absolute top-4 right-16 z-40 bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-xl shadow-md border border-gray-200/80 select-none">
            <span className="text-xs font-semibold text-gray-700">
              {filteredRoutes.length} route{filteredRoutes.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* Drawing instructions banner */}
        {isDrawing && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-blue-600 text-white px-4 py-2 rounded-xl shadow-lg flex items-center gap-3 select-none">
            <span className="text-xs font-semibold">
              Click to place points ({drawPoints.length} placed) · Enter or double-click to finish · Escape to cancel
            </span>
            <button
              type="button"
              onClick={cancelDrawing}
              className="p-1 hover:bg-blue-500 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Geofence list panel */}
        {showGeofenceList && geofences.length > 0 && (
          <div className="absolute top-16 right-16 z-40 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200/80 w-64 max-h-80 overflow-y-auto">
            <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Geofences</span>
              <button
                type="button"
                onClick={() => setShowGeofenceList(false)}
                className="p-0.5 hover:bg-gray-100 rounded transition-colors"
              >
                <X className="w-3.5 h-3.5 text-gray-400" />
              </button>
            </div>
            <div className="p-2 space-y-1">
              {geofences.map((g) => (
                <div key={g.id}>
                  <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 group">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: g.color }} />
                      <span className="text-xs font-medium text-gray-700 truncate">{g.name}</span>
                    </div>
                    {canWrite && (
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                        <button
                          type="button"
                          onClick={() => setEditingColorId(editingColorId === g.id ? null : g.id)}
                          className="p-1 hover:bg-gray-100 rounded transition-colors text-gray-400 hover:text-gray-600"
                          title="Change color"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteGeofence(g.id)}
                          disabled={deletingId === g.id}
                          className="p-1 hover:bg-red-50 rounded transition-colors text-gray-400 hover:text-red-500"
                          title="Delete geofence"
                        >
                          <Trash2 className={cn('w-3.5 h-3.5', deletingId === g.id && 'animate-spin')} />
                        </button>
                      </div>
                    )}
                  </div>
                  {editingColorId === g.id && (
                    <div className="flex gap-1.5 px-2 pb-2 pt-1">
                      {GEOFENCE_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          onClick={() => handleUpdateColor(g.id, color)}
                          className={cn(
                            'w-5 h-5 rounded-full border-2 transition-all hover:scale-110',
                            g.color === color ? 'border-gray-900 scale-110' : 'border-transparent',
                          )}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Basemap switcher */}
        <div className="absolute bottom-6 right-4 z-40 bg-white/90 hover:bg-white backdrop-blur-sm p-1 rounded-xl shadow-md border border-gray-200/80 flex gap-1 select-none transition-all">
          <button
            type="button"
            onClick={() => setBasemap('street')}
            className={cn(
              'px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1.5 h-7',
              basemap === 'street'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100',
            )}
          >
            <Map className="w-3.5 h-3.5" />
            <span>Street</span>
          </button>
          <button
            type="button"
            onClick={() => setBasemap('satellite')}
            className={cn(
              'px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1.5 h-7',
              basemap === 'satellite'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100',
            )}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Satellite</span>
          </button>
        </div>
      </div>

      {/* Name geofence dialog */}
      <Dialog open={showNameDialog} onOpenChange={(open) => { if (!open) cancelDrawing() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Name this geofence</DialogTitle>
            <DialogDescription>
              Files with coordinates inside this area will be tagged with this name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1.5">Name</label>
              <input
                type="text"
                value={geofenceName}
                onChange={(e) => setGeofenceName(e.target.value)}
                placeholder="e.g. Wood River, Lower Nushagak..."
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && geofenceName.trim()) saveGeofence() }}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1.5">Color</label>
              <div className="flex gap-2">
                {GEOFENCE_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setGeofenceColor(color)}
                    className={cn(
                      'w-7 h-7 rounded-full border-2 transition-all',
                      geofenceColor === color ? 'border-gray-900 scale-110' : 'border-transparent hover:scale-105',
                    )}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={cancelDrawing}>Cancel</Button>
            <Button onClick={saveGeofence} disabled={!geofenceName.trim() || isSaving}>
              {isSaving ? 'Saving...' : 'Save Geofence'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function updateMapBasemap(map: any, currentBasemap: 'street' | 'satellite') {
  if (!map) return

  if (map.getLayer('esri-satellite-layer')) {
    map.setLayoutProperty('esri-satellite-layer', 'visibility', currentBasemap === 'satellite' ? 'visible' : 'none')
  }

  const style = map.getStyle()
  if (style?.layers) {
    const skipIds = new Set([
      'esri-satellite-layer',
      'routes-fill', 'routes-line', 'routes-point',
      'geofences-fill', 'geofences-line', 'geofences-label',
      'file-markers-point', 'file-markers-label',
      'draw-line-layer', 'draw-points-layer',
    ])
    for (const layer of style.layers) {
      if ((layer.type === 'fill' || layer.type === 'background') && !skipIds.has(layer.id)) {
        map.setLayoutProperty(layer.id, 'visibility', currentBasemap === 'street' ? 'visible' : 'none')
      }
    }
  }
}
