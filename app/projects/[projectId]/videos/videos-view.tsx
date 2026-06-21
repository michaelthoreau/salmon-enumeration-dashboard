'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Video, Search, RefreshCw, Fish, NotebookPen } from 'lucide-react'
import Link from 'next/link'

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

interface VideosViewProps {
  projectId: string
  timezone: string
  videos: VideoEntry[]
  canWrite: boolean
}

export default function VideosView({ projectId, timezone, videos, canWrite }: VideosViewProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleRefresh = () => {
    setIsRefreshing(true)
    router.refresh()
    setTimeout(() => setIsRefreshing(false), 1000)
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return videos
    const q = search.toLowerCase()
    return videos.filter((v) => {
      const filename = v.key.split('/').pop()?.toLowerCase() ?? ''
      const notes = (v.flightNotes ?? '').toLowerCase()
      return filename.includes(q) || notes.includes(q) || v.planName.toLowerCase().includes(q)
    })
  }, [videos, search])

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
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Video className="w-6 h-6 text-blue-600" />
          <h1 className="text-xl font-bold text-gray-900">Videos</h1>
          <span className="text-sm text-gray-400 font-mono">{videos.length} total</span>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by filename or notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {grouped.length === 0 ? (
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
      ) : (
        <div className="space-y-8">
          {grouped.map(([dateKey, group]) => (
            <section key={dateKey}>
              <div className="flex items-center gap-3 mb-3">
                <h2 className="text-sm font-semibold text-gray-700">{group.label}</h2>
                <span className="text-xs text-gray-400 font-mono">{group.videos.length} video{group.videos.length !== 1 ? 's' : ''}</span>
                <div className="flex-1 border-t border-gray-100" />
              </div>

              <div className="space-y-2">
                {group.videos.map((v) => {
                  const filename = v.key.split('/').pop() ?? v.key

                  return (
                    <Link
                      key={v.fileId}
                      href={`/projects/${projectId}/flight-plans/${v.flightPlanId}/flights/${v.flightId}`}
                      className="flex items-center gap-4 px-4 py-3 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:shadow-sm transition-all group"
                    >
                      <div className="w-10 h-10 rounded-lg bg-slate-900 flex items-center justify-center flex-shrink-0">
                        <Video className="w-5 h-5 text-slate-400" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-700 transition-colors">
                          {filename}
                        </p>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-xs text-gray-400 font-mono">
                            {formatTime(v.flightTimestamp, timezone)}
                          </span>
                          <span className="text-xs text-gray-300">|</span>
                          <span className="text-xs text-gray-400">{formatBytes(v.size)}</span>
                          {v.fishCount > 0 && (
                            <>
                              <span className="text-xs text-gray-300">|</span>
                              <span className="inline-flex items-center gap-1 text-xs text-red-500">
                                <Fish className="w-3 h-3" />
                                {v.fishCount}
                              </span>
                            </>
                          )}
                          {v.noteCount > 0 && (
                            <>
                              <span className="text-xs text-gray-300">|</span>
                              <span className="inline-flex items-center gap-1 text-xs text-yellow-600">
                                <NotebookPen className="w-3 h-3" />
                                {v.noteCount}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
