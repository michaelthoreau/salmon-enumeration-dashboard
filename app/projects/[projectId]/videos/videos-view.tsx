'use client'

import { useState, useMemo, useRef, useEffect, useTransition, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Video, Search, RefreshCw, Fish, MapPin,
  Archive, ChevronDown, ChevronRight, EyeOff, Eye,
  Clock, CheckCircle2, Circle, Loader2,
} from 'lucide-react'
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
import { updateFileLocation, updateVideoReview, setVideoHidden } from '@/app/actions/files'
import type { ReviewStatus } from '@/lib/schema'

interface VideoEntry {
  fileId: string
  key: string
  etag: string
  uploadedAt: string
  flightTimestamp: string
  flightNotes: string | null
  planName: string
  flightId: string
  flightPlanId: string
  fishCount: number | null
  durationSeconds: number | null
  locationTags: { name: string; color: string }[]
  latitude: number | null
  longitude: number | null
  reviewStatus: ReviewStatus
  reviewRating: number | null
  reviewedBy: string | null
  reviewedAt: string | null
  hidden: boolean
}

interface ReviewState {
  status: ReviewStatus
  rating: number | null
  reviewedBy: string | null
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
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

function shortEmail(email: string): string {
  return email.split('@')[0]
}

const RATING_LABELS: Record<number, string> = {
  1: 'Not usable for training',
  2: 'Somewhat usable',
  3: 'Very usable',
}

const RATING_COLORS: Record<number, string> = {
  1: 'bg-red-100 text-red-700 border-red-300',
  2: 'bg-yellow-100 text-yellow-700 border-yellow-300',
  3: 'bg-green-100 text-green-700 border-green-300',
}

const RATING_COLORS_ACTIVE: Record<number, string> = {
  1: 'bg-red-500 text-white border-red-500',
  2: 'bg-yellow-500 text-white border-yellow-500',
  3: 'bg-green-500 text-white border-green-500',
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
  currentUserEmail?: string
  availableLocationTags?: string[]
  geofences?: GeofenceEntry[]
}

export default function VideosView({
  projectId,
  timezone,
  videos,
  canWrite,
  currentUserEmail,
  availableLocationTags = [],
  geofences = [],
}: VideosViewProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [locationFilter, setLocationFilter] = useState<string>('')
  const [archivedOpen, setArchivedOpen] = useState(false)

  // Optimistic review state: fileId → ReviewState
  const [reviewOverrides, setReviewOverrides] = useState<Map<string, ReviewState>>(new Map())
  // Optimistic hidden state: fileId → boolean
  const [hiddenOverrides, setHiddenOverrides] = useState<Map<string, boolean>>(new Map())

  const [, startTransition] = useTransition()

  // Merge server state with optimistic overrides
  const getReview = useCallback((v: VideoEntry): ReviewState => {
    const override = reviewOverrides.get(v.fileId)
    if (override) return override
    return { status: v.reviewStatus, rating: v.reviewRating, reviewedBy: v.reviewedBy }
  }, [reviewOverrides])

  const isHidden = useCallback((v: VideoEntry): boolean => {
    const override = hiddenOverrides.get(v.fileId)
    return override !== undefined ? override : v.hidden
  }, [hiddenOverrides])

  function handleReviewChange(v: VideoEntry, status: ReviewStatus, rating: number | null) {
    const reviewedBy = status === 'not_reviewed' ? null : (currentUserEmail ?? v.reviewedBy)
    setReviewOverrides((prev) => new Map(prev).set(v.fileId, { status, rating, reviewedBy }))
    startTransition(async () => {
      await updateVideoReview(v.fileId, status, rating)
      router.refresh()
    })
  }

  function handleHide(v: VideoEntry, hide: boolean) {
    setHiddenOverrides((prev) => new Map(prev).set(v.fileId, hide))
    startTransition(async () => {
      await setVideoHidden(v.fileId, hide)
      router.refresh()
    })
  }

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

  useEffect(() => {
    if (!locationDialogFileId) return
    let cancelled = false

    async function initMiniMap() {
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

        const geofenceFeatures = geofences
          .map((g) => {
            try {
              return { type: 'Feature' as const, geometry: JSON.parse(g.geometry), properties: { name: g.name, color: g.color } }
            } catch { return null }
          })
          .filter(Boolean)

        map.addSource('geofences-source', { type: 'geojson', data: { type: 'FeatureCollection', features: geofenceFeatures as any[] } })
        map.addLayer({ id: 'geofences-fill', type: 'fill', source: 'geofences-source', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.15 } })
        map.addLayer({ id: 'geofences-line', type: 'line', source: 'geofences-source', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [3, 2] } })
        map.addLayer({ id: 'geofences-label', type: 'symbol', source: 'geofences-source', layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-anchor': 'center' }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } })

        map.addSource('pin-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: locationPin ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: locationPin }, properties: {} }] : [] },
        })
        map.addLayer({ id: 'pin-layer', type: 'circle', source: 'pin-source', paint: { 'circle-color': '#ef4444', 'circle-radius': 8, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } })
      })

      map.on('click', (e: any) => {
        const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]
        setLocationPin(lngLat)
        const src = map.getSource('pin-source')
        if (src) (src as any).setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: lngLat }, properties: {} }] })
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
    if (result.error) { alert(result.error); return }
    closeLocationDialog()
    router.refresh()
  }

  const handleRefresh = () => {
    setIsRefreshing(true)
    router.refresh()
    setTimeout(() => setIsRefreshing(false), 1000)
  }

  // Partition into visible / hidden
  const { visible, archived } = useMemo(() => {
    let result = videos
    if (locationFilter) result = result.filter((v) => v.locationTags.some((t) => t.name === locationFilter))
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((v) => {
        const filename = v.key.split('/').pop()?.toLowerCase() ?? ''
        const notes = (v.flightNotes ?? '').toLowerCase()
        return filename.includes(q) || notes.includes(q) || v.planName.toLowerCase().includes(q)
      })
    }
    const visible: VideoEntry[] = []
    const archived: VideoEntry[] = []
    for (const v of result) {
      if (isHidden(v)) archived.push(v)
      else visible.push(v)
    }
    return { visible, archived }
  }, [videos, search, locationFilter, isHidden])

  // Queue: not_reviewed + in_review, newest first
  const queue = useMemo(() =>
    visible
      .filter((v) => {
        const s = getReview(v).status
        return s === 'not_reviewed' || s === 'in_review'
      })
      .sort((a, b) => new Date(b.flightTimestamp).getTime() - new Date(a.flightTimestamp).getTime()),
    [visible, getReview]
  )

  // All visible videos date-grouped
  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; videos: VideoEntry[] }>()
    for (const v of visible) {
      const key = getDateKey(v.flightTimestamp, timezone)
      if (!map.has(key)) map.set(key, { label: formatDate(v.flightTimestamp, timezone), videos: [] })
      map.get(key)!.videos.push(v)
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [visible, timezone])

  const queueCounts = useMemo(() => {
    const notReviewed = visible.filter((v) => getReview(v).status === 'not_reviewed').length
    const inReview = visible.filter((v) => getReview(v).status === 'in_review').length
    return { notReviewed, inReview }
  }, [visible, getReview])

  return (
    <div className="space-y-8">
      {/* ── Review Queue ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">
              Review Queue{' '}
              <span className="text-sm font-normal text-gray-500">({queue.length})</span>
            </h2>
            {queueCounts.notReviewed > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600 border border-gray-200">
                <Circle className="w-3 h-3" /> {queueCounts.notReviewed} unreviewed
              </span>
            )}
            {queueCounts.inReview > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-50 text-blue-600 border border-blue-200">
                <Loader2 className="w-3 h-3" /> {queueCounts.inReview} in review
              </span>
            )}
          </div>
        </div>

        {queue.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200">
            <div className="text-center py-10 space-y-2">
              <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto" />
              <p className="text-sm font-medium text-gray-600">All caught up — no videos awaiting review.</p>
            </div>
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
            {queue.map((v) => {
              const filename = v.key.split('/').pop() ?? v.key
              const review = getReview(v)
              return (
                <div
                  key={v.fileId}
                  className="flex-none w-72 bg-white rounded-xl border border-gray-200 p-4 flex flex-col gap-3 snap-start"
                >
                  {/* Header: filename + archive */}
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/projects/${projectId}/flight-plans/${v.flightPlanId}/flights/${v.flightId}?file=${v.fileId}`}
                      className="text-sm font-medium text-blue-600 hover:text-blue-800 truncate leading-snug"
                      title={filename}
                    >
                      {filename}
                    </Link>
                    {canWrite && (
                      <button
                        type="button"
                        onClick={() => handleHide(v, true)}
                        title="Move to archive"
                        className="flex-none p-1 rounded text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition-colors"
                      >
                        <Archive className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Meta row */}
                  <div className="flex items-center gap-2 text-xs text-gray-400 font-mono">
                    <span>{formatTime(v.flightTimestamp, timezone)}</span>
                    {v.durationSeconds != null && (
                      <>
                        <span>·</span>
                        <span>{formatDuration(v.durationSeconds)}</span>
                      </>
                    )}
                  </div>

                  {/* Location */}
                  <div className="min-h-[20px]">
                    <LocationCell v={v} canWrite={canWrite} onOpenDialog={() => openLocationDialog(v)} />
                  </div>

                  <div className="border-t border-gray-100" />

                  {/* Status buttons */}
                  <StatusButtons
                    status={review.status}
                    canWrite={canWrite}
                    onChange={(s) => handleReviewChange(v, s, review.rating)}
                  />

                  {/* Rating + reviewer */}
                  <div className="flex items-center justify-between">
                    <RatingButtons
                      rating={review.rating}
                      canWrite={canWrite}
                      onChange={(r) => handleReviewChange(v, review.status, r)}
                    />
                    {review.reviewedBy && (
                      <span className="text-xs text-gray-400 truncate ml-2">{shortEmail(review.reviewedBy)}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── All Videos ── */}
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

        {videos.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="text-center py-16 space-y-3">
              <Video className="w-12 h-12 text-gray-300 mx-auto" />
              <p className="text-sm text-gray-500 font-medium">No videos have been synced yet.</p>
              <p className="text-xs text-gray-400">Videos from DJI FlightHub2 will appear here automatically when synced.</p>
            </div>
          </div>
        ) : grouped.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="text-center py-16">
              <p className="text-sm text-gray-500">No videos match your search.</p>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Filename</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Location</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Time</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Fish/hr</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Length</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Status</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              {grouped.map(([dateKey, group], i) => (
                <tbody key={dateKey} className="divide-y divide-gray-100">
                  <tr className="bg-gray-100/70">
                    <td colSpan={7} className={`px-3 py-2 ${i > 0 ? 'border-t-2 border-gray-300' : 'border-t border-gray-200'}`}>
                      <span className="text-sm font-semibold text-gray-700">{group.label}</span>
                      <span className="ml-2 text-xs text-gray-400">{group.videos.length} video{group.videos.length !== 1 ? 's' : ''}</span>
                    </td>
                  </tr>
                  {group.videos.map((v) => {
                    const filename = v.key.split('/').pop() ?? v.key
                    const review = getReview(v)
                    return (
                      <tr key={v.fileId} className="hover:bg-gray-50 transition-colors group">
                        <td className="px-3 py-2">
                          <Link
                            href={`/projects/${projectId}/flight-plans/${v.flightPlanId}/flights/${v.flightId}?file=${v.fileId}`}
                            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'truncate max-w-[160px] text-xs')}
                          >
                            {filename}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <LocationCell v={v} canWrite={canWrite} onOpenDialog={() => openLocationDialog(v)} />
                        </td>
                        <td className="px-3 py-2 text-gray-500 font-mono text-xs whitespace-nowrap">
                          {formatTime(v.flightTimestamp, timezone)}
                        </td>
                        <td className="px-3 py-2">
                          {v.fishCount === null ? (
                            <span className="text-gray-400 text-xs italic">—</span>
                          ) : v.durationSeconds != null && v.durationSeconds > 0 ? (
                            <span className="inline-flex items-center gap-1 text-red-500 text-xs">
                              <Fish className="w-3 h-3" />
                              {(v.fishCount / (v.durationSeconds / 3600)).toFixed(1)}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-red-500 text-xs">
                              <Fish className="w-3 h-3" />
                              {v.fishCount}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-500 font-mono text-xs whitespace-nowrap">
                          {v.durationSeconds != null ? formatDuration(v.durationSeconds) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {canWrite
                            ? <StatusButtons status={review.status} canWrite={canWrite} compact onChange={(s) => handleReviewChange(v, s, review.rating)} />
                            : <StatusBadge status={review.status} reviewedBy={review.reviewedBy} />}
                        </td>
                        <td className="px-2 py-2">
                          {canWrite && (
                            <button
                              type="button"
                              onClick={() => handleHide(v, true)}
                              title="Move to archive"
                              className="p-1 rounded text-gray-200 hover:text-gray-500 hover:bg-gray-100 transition-colors opacity-0 group-hover:opacity-100"
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}

        {/* ── Archived ── */}
        {archived.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setArchivedOpen((o) => !o)}
              className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-600 transition-colors mb-2"
            >
              {archivedOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              <EyeOff className="w-4 h-4" />
              Archived ({archived.length})
            </button>

            {archivedOpen && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden opacity-70">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-6 py-3 font-medium text-gray-500">Filename</th>
                      <th className="text-left px-6 py-3 font-medium text-gray-500">Location</th>
                      <th className="text-left px-6 py-3 font-medium text-gray-500">Time</th>
                      <th className="text-left px-6 py-3 font-medium text-gray-500">Length</th>
                      <th className="text-left px-6 py-3 font-medium text-gray-500">Status</th>
                      <th className="text-left px-6 py-3 font-medium text-gray-500">Rating</th>
                      <th className="px-6 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {archived
                      .sort((a, b) => new Date(b.flightTimestamp).getTime() - new Date(a.flightTimestamp).getTime())
                      .map((v) => {
                        const filename = v.key.split('/').pop() ?? v.key
                        const review = getReview(v)
                        return (
                          <tr key={v.fileId} className="hover:bg-gray-50 transition-colors">
                            <td className="px-6 py-3">
                              <Link
                                href={`/projects/${projectId}/flight-plans/${v.flightPlanId}/flights/${v.flightId}?file=${v.fileId}`}
                                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'truncate max-w-[220px]')}
                              >
                                {filename}
                              </Link>
                            </td>
                            <td className="px-6 py-3">
                              <LocationCell v={v} canWrite={false} onOpenDialog={() => {}} />
                            </td>
                            <td className="px-6 py-3 text-gray-400 font-mono text-xs whitespace-nowrap">
                              {formatTime(v.flightTimestamp, timezone)}
                            </td>
                            <td className="px-6 py-3 text-gray-400 font-mono text-xs whitespace-nowrap">
                              {v.durationSeconds != null ? formatDuration(v.durationSeconds) : '—'}
                            </td>
                            <td className="px-6 py-3">
                              <StatusBadge status={review.status} reviewedBy={review.reviewedBy} />
                            </td>
                            <td className="px-6 py-3">
                              {review.rating != null ? (
                                <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border', RATING_COLORS_ACTIVE[review.rating])}>
                                  {review.rating}
                                </span>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-6 py-3">
                              {canWrite && (
                                <button
                                  type="button"
                                  onClick={() => handleHide(v, false)}
                                  title="Restore from archive"
                                  className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600 transition-colors"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  Restore
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            )}
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
          <div ref={locationMapRef} className="w-full h-[640px] rounded-lg border border-gray-200 overflow-hidden" />
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

// ── Sub-components ────────────────────────────────────────────────────────────

function LocationCell({ v, canWrite, onOpenDialog }: { v: VideoEntry; canWrite: boolean; onOpenDialog: () => void }) {
  if (v.latitude != null && v.longitude != null) {
    return (
      <div className="flex flex-wrap gap-1">
        {v.locationTags.length > 0 ? v.locationTags.map((tag) => (
          <button
            key={tag.name}
            type="button"
            onClick={onOpenDialog}
            className="inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium border transition-opacity hover:opacity-80"
            style={{ backgroundColor: tag.color + '22', borderColor: tag.color + '66', color: tag.color }}
            title={`${v.latitude!.toFixed(4)}, ${v.longitude!.toFixed(4)}`}
          >
            {tag.name}
          </button>
        )) : (
          <button
            type="button"
            onClick={onOpenDialog}
            className="inline-flex items-center gap-1 text-green-600 hover:text-green-700 transition-colors text-xs"
            title={`${v.latitude!.toFixed(4)}, ${v.longitude!.toFixed(4)}`}
          >
            <MapPin className="w-3.5 h-3.5" />
            <span>Set</span>
          </button>
        )}
      </div>
    )
  }
  if (canWrite) {
    return (
      <button
        type="button"
        onClick={onOpenDialog}
        className="inline-flex items-center gap-1 text-red-500 hover:text-red-600 transition-colors text-xs font-medium"
      >
        <MapPin className="w-3.5 h-3.5" />
        <span>Not set</span>
      </button>
    )
  }
  return <span className="text-red-400 text-xs">Not set</span>
}

function StatusBadge({ status, reviewedBy }: { status: ReviewStatus; reviewedBy: string | null }) {
  if (status === 'not_reviewed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500 border border-gray-200">
        <Circle className="w-2.5 h-2.5" /> Not reviewed
      </span>
    )
  }
  if (status === 'in_review') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-50 text-blue-600 border border-blue-200">
        <Clock className="w-2.5 h-2.5" />
        In review{reviewedBy ? ` · ${shortEmail(reviewedBy)}` : ''}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-50 text-green-700 border border-green-200">
      <CheckCircle2 className="w-2.5 h-2.5" />
      Reviewed{reviewedBy ? ` · ${shortEmail(reviewedBy)}` : ''}
    </span>
  )
}

function StatusButtons({ status, canWrite, onChange, compact = false }: { status: ReviewStatus; canWrite: boolean; onChange: (s: ReviewStatus) => void; compact?: boolean }) {
  const options: { value: ReviewStatus; label: string; icon: React.ReactNode; active: string; inactive: string }[] = [
    {
      value: 'not_reviewed',
      label: 'Not reviewed',
      icon: <Circle className="w-3 h-3" />,
      active: 'bg-gray-200 text-gray-700 border-gray-300',
      inactive: 'bg-white text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600',
    },
    {
      value: 'in_review',
      label: 'In review',
      icon: <Clock className="w-3 h-3" />,
      active: 'bg-blue-500 text-white border-blue-500',
      inactive: 'bg-white text-gray-400 border-gray-200 hover:border-blue-300 hover:text-blue-500',
    },
    {
      value: 'reviewed',
      label: 'Reviewed',
      icon: <CheckCircle2 className="w-3 h-3" />,
      active: 'bg-green-500 text-white border-green-500',
      inactive: 'bg-white text-gray-400 border-gray-200 hover:border-green-300 hover:text-green-600',
    },
  ]

  return (
    <div className="flex rounded-md border border-gray-200 overflow-hidden w-fit">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.label}
          disabled={!canWrite}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-xs font-medium border-r last:border-r-0 transition-colors',
            status === opt.value ? opt.active : opt.inactive,
            !canWrite && 'cursor-default opacity-70',
          )}
        >
          {opt.icon}
          {!compact && <span className="hidden sm:inline">{opt.label.split(' ')[0]}</span>}
        </button>
      ))}
    </div>
  )
}

function RatingButtons({ rating, canWrite, onChange }: { rating: number | null; canWrite: boolean; onChange: (r: number | null) => void }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3].map((n) => (
        <button
          key={n}
          type="button"
          title={RATING_LABELS[n]}
          disabled={!canWrite}
          onClick={() => onChange(rating === n ? null : n)}
          className={cn(
            'w-6 h-6 rounded text-xs font-bold border transition-colors',
            rating === n ? RATING_COLORS_ACTIVE[n] : RATING_COLORS[n],
            !canWrite && 'cursor-default',
          )}
        >
          {n}
        </button>
      ))}
    </div>
  )
}
