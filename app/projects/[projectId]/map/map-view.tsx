'use client'

import { useEffect, useRef, useState, useMemo } from 'react'
import { Map, Layers, MapPin, Image, Video, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'
import 'maplibre-gl/dist/maplibre-gl.css'

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

interface Props {
  projectId: string
  timezone: string
  routes: RouteEntry[]
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

export default function MapView({ projectId, timezone, routes, geofences, canWrite }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [basemap, setBasemap] = useState<'street' | 'satellite'>('satellite')
  const [filterType, setFilterType] = useState<'all' | 'images' | 'videos'>('all')

  const filteredRoutes = useMemo(() => {
    if (filterType === 'all') return routes
    if (filterType === 'images') return routes.filter((r) => r.imageCount > 0)
    return routes.filter((r) => r.videoCount > 0)
  }, [routes, filterType])

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
        zoom: 2,
        center: [-152, 61],
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

  // Sync basemap
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    updateMapBasemap(mapRef.current, basemap)
  }, [basemap, mapReady])

  return (
    <div className="fixed top-[44px] bottom-0 left-0 right-0 z-10 bg-gray-50">
      <div className="w-full h-full relative">
        <div ref={mapContainerRef} className="w-full h-full absolute inset-0" />

        {/* Filter controls */}
        <div className="absolute top-4 left-4 z-40 flex flex-col gap-2">
          {/* File type filter */}
          <div className="bg-white/90 hover:bg-white backdrop-blur-sm p-1 rounded-xl shadow-md border border-gray-200/80 flex gap-1 select-none transition-all">
            {([
              { value: 'all', label: 'All', icon: MapPin },
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
        </div>

        {/* Route count badge */}
        <div className="absolute top-4 right-16 z-40 bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-xl shadow-md border border-gray-200/80 select-none">
          <span className="text-xs font-semibold text-gray-700">
            {filteredRoutes.length} route{filteredRoutes.length !== 1 ? 's' : ''}
          </span>
        </div>

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
      'geofences-fill', 'geofences-line',
    ])
    for (const layer of style.layers) {
      if ((layer.type === 'fill' || layer.type === 'background') && !skipIds.has(layer.id)) {
        map.setLayoutProperty(layer.id, 'visibility', currentBasemap === 'street' ? 'visible' : 'none')
      }
    }
  }
}
