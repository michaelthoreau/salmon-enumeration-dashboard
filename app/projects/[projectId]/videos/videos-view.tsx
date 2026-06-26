'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Video, Search, RefreshCw, Fish, NotebookPen, MapPin } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { updateFileLocation } from '@/app/actions/files'

interface VideoEntry {
  fileId: string
  key: string
  size: number
  etag: string
  uploadedAt: string
  flightTimestamp: string
  flightNotes: string | null
  planName: string
  flightId: string
  flightPlanId: string
  fishCount: number
  noteCount: number
  locationTags: string[]
  latitude: number | null
  longitude: number | null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getDateKey(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso))
  const y = parts.find((p) => p.type === 'year')!.value
  const m = parts.find((p) => p.type === 'month')!.value
  const d = parts.find((p) => p.type === 'day')!.value
  return `${y}-${m}-${d}`
}

interface GeofenceEntry {
  id: string
  name: string
  geometry: string
  color: string
}

export interface VideosViewProps {
  projectId: string
  timezone: string
  videos: VideoEntry[]
  canWrite: boolean
  availableLocationTags?: string[]
  geofences?: GeofenceEntry[]
}

export default function VideosView({ projectId, timezone, videos, canWrite, availableLocationTags = [], geofences = [] }: VideosViewProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [locationFilter, setLocationFilter] = useState<string>('')

  // Location dialog state
  const [locationDialogFileId, setLocationDialogFileId] = useState<string | null>(null)
  const [locationDialogFileName, setLocationDialogFileName] = useState<string>('')
  const [locationPin, setLocationPin] = useState<[number, number] | null>(null)
  const [isSavingLocation, setIsSavingLocation] = useState(false)
  const locationMapRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locationMapInstanceRef = useRef<any | null>(null)

  function openLocationDialog(video: VideoEntry) {
    const filename = video.key.split('/').pop() ?? video.key
    setLocationDialogFileId(video.fileId)
    setLocationDialogFileName(filename)
    setLocationPin(video.latitude != null && video.longitude != null ? [video.longitude, video.latitude] : null)
  }

  function closeLocationDialog() {
    setLocationDialogFileId(null)
    setLocationDialogFileName('')
    setLocationPin(null)
  }

  // Init mini map when dialog opens (defer to let portal mount)
  useEffect(() => {
    if (!locationDialogFileId) return
    let cancelled = false

    async function initMiniMap() {
      // Wait for dialog portal to mount the container
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const maplibre = (await import('maplibre-gl')).default
      await import('maplibre-gl/dist/maplibre-gl.css')
      if (cancelled || !locationMapRef.current) return

      const initialCenter: [number, number] = locationPin ?? [-158.65, 59.25]

      const map = new maplibre.Map({
        container: locationMapRef.current,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        zoom: 10,
        center: initialCenter,
        attributionControl: false,
      })

      locationMapInstanceRef.current = map
      map.addControl(new maplibre.NavigationControl(), 'top-right')

      map.on('load', () => {
        if (cancelled) return
        map.addSource('esri-satellite', {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          maxzoom: 17,
        })
        const firstLayerId = map.getStyle().layers?.[0]?.id
        map.addLayer({ id: 'esri-satellite-layer', type: 'raster', source: 'esri-satellite' }, firstLayerId)

        const style = map.getStyle()
        if (style?.layers) {
          for (const layer of style.layers) {
            if ((layer.type === 'fill' || layer.type === 'background') && layer.id !== 'esri-satellite-layer') {
              map.setLayoutProperty(layer.id, 'visibility', 'none')
            }
          }
        }

        // Geofence layers
        const geofenceFeatures = geofences
          .map((g) => {
            try {
              return {
                type: 'Feature' as const,
                geometry: JSON.parse(g.geometry),
                properties: { name: g.name, color: g.color },
              }
            } catch { return null }
          })
          .filter(Boolean)

        map.addSource('geofences-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: geofenceFeatures as any[] },
        })
        map.addLayer({
          id: 'geofences-fill',
          type: 'fill',
          source: 'geofences-source',
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.15 },
        })
        map.addLayer({
          id: 'geofences-line',
          type: 'line',
          source: 'geofences-source',
          paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [3, 2] },
        })
        // Geofence name labels
        map.addLayer({
          id: 'geofences-label',
          type: 'symbol',
          source: 'geofences-source',
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 12,
            'text-anchor': 'center',
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.5,
          },
        })

        // Pin layer
        map.addSource('pin-source', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: locationPin
              ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: locationPin }, properties: {} }]
              : [],
          },
        })
        map.addLayer({
          id: 'pin-layer',
          type: 'circle',
          source: 'pin-source',
          paint: {
            'circle-color': '#ef4444',
            'circle-radius': 8,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        })
      })

      map.on('click', (e: any) => {
        const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]
        setLocationPin(lngLat)
        const src = map.getSource('pin-source')
        if (src) {
          (src as any).setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: lngLat }, properties: {} }],
          })
        }
      })

      map.getCanvas().style.cursor = 'crosshair'
    }

    initMiniMap()
    return () => {
      cancelled = true
      if (locationMapInstanceRef.current) {
        locationMapInstanceRef.current.remove()
        locationMapInstanceRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationDialogFileId])

  async function handleSaveLocation() {
    if (!locationDialogFileId || !locationPin) return
    setIsSavingLocation(true)
    const result = await updateFileLocation(locationDialogFileId, locationPin[1], locationPin[0])
    setIsSavingLocation(false)
    if (result.error) {
      alert(result.error)
      return
    }
    closeLocationDialog()
    router.refresh()
  }

  const handleRefresh = () => {
    setIsRefreshing(true)
    router.refresh()
    setTimeout(() => setIsRefreshing(false), 1000)
  }

  const filtered = useMemo(() => {
    let result = videos
    if (locationFilter) {
      result = result.filter((v) => v.locationTags.includes(locationFilter))
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((v) => {
        const filename = v.key.split('/').pop()?.toLowerCase() ?? ''
        const notes = (v.flightNotes ?? '').toLowerCase()
        return filename.includes(q) || notes.includes(q) || v.planName.toLowerCase().includes(q)
      })
    }
    return result
  }, [videos, search, locationFilter])

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; videos: VideoEntry[] }>()
    for (const v of filtered) {
      const key = getDateKey(v.flightTimestamp, timezone)
      if (!map.has(key)) {
        map.set(key, {
          label: formatDate(v.flightTimestamp, timezone),
          videos: [],
        })
      }
      map.get(key)!.videos.push(v)
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [filtered, timezone])

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Videos{' '}
            <span className="text-sm font-normal text-gray-500">({videos.length})</span>
          </h2>
          <div className="flex items-center gap-3">
            {availableLocationTags.length > 0 && (
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <select
                  value={locationFilter}
                  onChange={(e) => setLocationFilter(e.target.value)}
                  className="pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent appearance-none bg-white cursor-pointer"
                >
                  <option value="">All locations</option>
                  {availableLocationTags.map((tag) => (
                    <option key={tag} value={tag}>{tag}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {grouped.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="text-center py-16 space-y-3">
              <Video className="w-12 h-12 text-gray-300 mx-auto" />
              <p className="text-sm text-gray-500 font-medium">
                {videos.length === 0 ? 'No videos have been synced yet.' : 'No videos match your search.'}
              </p>
              {videos.length === 0 && (
                <p className="text-xs text-gray-400">
                  Videos from DJI FlightHub2 will appear here automatically when synced.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {grouped.map(([dateKey, group]) => (
              <div key={dateKey}>
                <h3 className="text-sm font-medium text-gray-500 mb-2">{group.label}</h3>
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="text-left px-6 py-3 font-medium text-gray-600">Filename</th>
                        <th className="text-left px-6 py-3 font-medium text-gray-600">Route</th>
                        <th className="text-left px-6 py-3 font-medium text-gray-600">Time</th>
                        <th className="text-left px-6 py-3 font-medium text-gray-600">Size</th>
                        <th className="text-left px-6 py-3 font-medium text-gray-600">Fish</th>
                        <th className="text-left px-6 py-3 font-medium text-gray-600">Location</th>
                        <th className="text-left px-6 py-3 font-medium text-gray-600">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {group.videos.map((v) => {
                        const filename = v.key.split('/').pop() ?? v.key

                        return (
                          <tr key={v.fileId} className="hover:bg-gray-50 transition-colors">
                            <td className="px-6 py-3">
                              <Link
                                href={`/projects/${projectId}/flight-plans/${v.flightPlanId}/flights/${v.flightId}?file=${v.fileId}`}
                                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), "truncate max-w-[220px]")}
                              >
                                {filename}
                              </Link>
                            </td>
                            <td className="px-6 py-3 text-gray-500">{v.planName}</td>
                            <td className="px-6 py-3 text-gray-500 font-mono text-xs">
                              {formatTime(v.flightTimestamp, timezone)}
                            </td>
                            <td className="px-6 py-3 text-gray-500">{formatBytes(v.size)}</td>
                            <td className="px-6 py-3">
                              {v.fishCount > 0 ? (
                                <span className="inline-flex items-center gap-1 text-red-500">
                                  <Fish className="w-3.5 h-3.5" />
                                  {v.fishCount}
                                </span>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-6 py-3">
                              {v.latitude != null && v.longitude != null ? (
                                <button
                                  type="button"
                                  onClick={() => openLocationDialog(v)}
                                  className="inline-flex items-center gap-1 text-green-600 hover:text-green-700 transition-colors text-xs"
                                  title={`${v.latitude.toFixed(4)}, ${v.longitude.toFixed(4)}`}
                                >
                                  <MapPin className="w-3.5 h-3.5" />
                                  <span>{v.locationTags.length > 0 ? v.locationTags.join(', ') : 'Set'}</span>
                                </button>
                              ) : canWrite ? (
                                <button
                                  type="button"
                                  onClick={() => openLocationDialog(v)}
                                  className="inline-flex items-center gap-1 text-red-500 hover:text-red-600 transition-colors text-xs font-medium"
                                >
                                  <MapPin className="w-3.5 h-3.5" />
                                  <span>Not set</span>
                                </button>
                              ) : (
                                <span className="text-red-400 text-xs">Not set</span>
                              )}
                            </td>
                            <td className="px-6 py-3">
                              {v.noteCount > 0 ? (
                                <span className="inline-flex items-center gap-1 text-yellow-600">
                                  <NotebookPen className="w-3.5 h-3.5" />
                                  {v.noteCount}
                                </span>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Set Location Dialog */}
      <Dialog open={!!locationDialogFileId} onOpenChange={(open) => { if (!open) closeLocationDialog() }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Set video location</DialogTitle>
            <DialogDescription>
              Click the map to place a pin for <strong>{locationDialogFileName}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div
            ref={locationMapRef}
            className="w-full h-[640px] rounded-lg border border-gray-200 overflow-hidden"
          />
          {locationPin && (
            <p className="text-xs text-gray-500 font-mono">
              {locationPin[1].toFixed(6)}, {locationPin[0].toFixed(6)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeLocationDialog}>Cancel</Button>
            <Button onClick={handleSaveLocation} disabled={!locationPin || isSavingLocation}>
              {isSavingLocation ? 'Saving...' : 'Set Location'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
