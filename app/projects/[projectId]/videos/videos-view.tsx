'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Video, Search, RefreshCw, Fish, NotebookPen } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

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

export interface VideosViewProps {
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
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Videos{' '}
            <span className="text-sm font-normal text-gray-500">({videos.length})</span>
          </h2>
          <div className="flex items-center gap-3">
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
                                href={`/projects/${projectId}/flight-plans/${v.flightPlanId}/flights/${v.flightId}`}
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
    </div>
  )
}
