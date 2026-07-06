'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

interface VideoEntry {
  id: string
  key: string
  size: number
  compressionStatus: string
  filename: string
  projectName: string
  flightPlanName: string
  flightTimestamp: string | null
}

interface InvokeResult {
  key: string
  status: 'invoked' | 'error'
  error?: string
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function CompressionBackfillView({ videos }: { videos: VideoEntry[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<InvokeResult[]>([])
  const [isRunning, setIsRunning] = useState(false)

  const allSelected = videos.length > 0 && selected.size === videos.length
  const someSelected = selected.size > 0

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(videos.map((v) => v.key)))
    }
  }

  function toggleOne(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function invoke(keys: string[]) {
    setIsRunning(true)
    setResults([])
    try {
      const res = await fetch('/api/admin/compression-backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResults([{ key: '—', status: 'error', error: data.error ?? 'Unknown error' }])
      } else {
        setResults(data.results)
      }
    } catch (err) {
      setResults([{ key: '—', status: 'error', error: err instanceof Error ? err.message : String(err) }])
    } finally {
      setIsRunning(false)
    }
  }

  const resultMap = Object.fromEntries(results.map((r) => [r.key, r]))

  if (videos.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
        All videos already have a compression status. Nothing to backfill.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          {videos.length} video{videos.length !== 1 ? 's' : ''} without compression
          {someSelected && ` · ${selected.size} selected`}
        </p>
        <div className="flex items-center gap-2">
          {someSelected && selected.size === 1 && (
            <button
              onClick={() => invoke([...selected])}
              disabled={isRunning}
              className="px-3 py-1.5 text-sm font-medium border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Test 1 video
            </button>
          )}
          {someSelected && (
            <button
              onClick={() => invoke([...selected])}
              disabled={isRunning}
              className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRunning ? 'Invoking…' : `Run ${selected.size} selected`}
            </button>
          )}
        </div>
      </div>

      {/* Results banner */}
      {results.length > 0 && (
        <div className={cn(
          'rounded-xl border p-4 text-sm space-y-1',
          results.every((r) => r.status === 'invoked')
            ? 'bg-green-50 border-green-200 text-green-800'
            : 'bg-amber-50 border-amber-200 text-amber-800'
        )}>
          <p className="font-semibold mb-2">
            {results.filter((r) => r.status === 'invoked').length} invoked
            {results.filter((r) => r.status === 'error').length > 0 &&
              ` · ${results.filter((r) => r.status === 'error').length} failed`}
          </p>
          {results.filter((r) => r.status === 'error').map((r) => (
            <p key={r.key} className="font-mono text-xs text-red-700">
              {r.key}: {r.error}
            </p>
          ))}
          <p className="text-xs mt-2 text-green-700">
            Lambda invocations are async — check the video&apos;s compression status in a minute to confirm it worked.
          </p>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="rounded border-gray-300"
                />
              </th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">File</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Project / Route</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Size</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="px-4 py-3 w-24" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {videos.map((v) => {
              const result = resultMap[v.key]
              return (
                <tr
                  key={v.id}
                  className={cn('transition-colors', selected.has(v.key) ? 'bg-blue-50/50' : 'hover:bg-gray-50')}
                  onClick={() => toggleOne(v.key)}
                >
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(v.key)}
                      onChange={() => toggleOne(v.key)}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900 truncate max-w-[240px]" title={v.filename}>{v.filename}</p>
                    <p className="text-xs text-gray-400 font-mono truncate max-w-[240px]" title={v.key}>{v.key}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    <p>{v.projectName}</p>
                    <p className="text-xs text-gray-400">{v.flightPlanName}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-500 tabular-nums">
                    {v.size ? formatBytes(v.size) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'inline-block text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded',
                      v.compressionStatus === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'
                    )}>
                      {v.compressionStatus}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {result && (
                      <span className={cn(
                        'text-xs font-medium',
                        result.status === 'invoked' ? 'text-green-600' : 'text-red-600'
                      )}>
                        {result.status === 'invoked' ? 'Invoked' : 'Error'}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
