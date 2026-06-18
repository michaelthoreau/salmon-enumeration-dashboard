'use client'

import { useState, useTransition, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Download, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { listDjiProjects, getDjiSyncDiff, pullDjiFlight, type MissingFlight } from '@/app/actions/dji-sync'

type Stage = 'pickProject' | 'loadingDiff' | 'review' | 'pulling' | 'completed' | 'error'

interface PullResult {
  flightLabel: string
  succeeded:   number
  total:       number
  failed:      string[]
}

export default function DjiSyncButton({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [open,  setOpen]  = useState(false)
  const [stage, setStage] = useState<Stage>('pickProject')
  const [error, setError] = useState<string | null>(null)

  // Step 1: project picker
  const [djiProjects,  setDjiProjects]  = useState<{ uuid: string; name: string }[]>([])
  const [selectedUuid, setSelectedUuid] = useState('')
  const [loadingProjects, setLoadingProjects] = useState(false)

  // Step 2: diff list
  const [missingFlights, setMissingFlights] = useState<MissingFlight[]>([])
  const [checkedPaths,   setCheckedPaths]   = useState<Set<string>>(new Set())

  // Step 3: pull progress
  const [pullTotal,    setPullTotal]    = useState(0)
  const [pullProgress, setPullProgress] = useState(0)
  const [currentLabel, setCurrentLabel] = useState('')
  const [results,      setResults]      = useState<PullResult[]>([])

  const handleOpen = useCallback(() => {
    setOpen(true)
    setStage('pickProject')
    setError(null)
    setDjiProjects([])
    setSelectedUuid('')
    setMissingFlights([])
    setCheckedPaths(new Set())
    setResults([])

    setLoadingProjects(true)
    startTransition(async () => {
      const res = await listDjiProjects()
      setLoadingProjects(false)
      if (!res.ok || !res.projects) {
        setError(res.error ?? 'Failed to load DJI projects')
        setStage('error')
        return
      }
      setDjiProjects(res.projects)
      if (res.projects.length === 1) setSelectedUuid(res.projects[0].uuid)
    })
  }, [startTransition])

  const handleFindFlights = useCallback(() => {
    if (!selectedUuid) return
    setStage('loadingDiff')
    setError(null)

    startTransition(async () => {
      const res = await getDjiSyncDiff(projectId, selectedUuid)
      if (!res.ok || !res.flights) {
        setError(res.error ?? 'Failed to compare flights')
        setStage('error')
        return
      }
      setMissingFlights(res.flights)
      setCheckedPaths(new Set(res.flights.map((f) => f.fh2FilePath)))
      setStage('review')
    })
  }, [selectedUuid, projectId, startTransition])

  const handlePull = useCallback(() => {
    const selected = missingFlights.filter((f) => checkedPaths.has(f.fh2FilePath))
    if (selected.length === 0) return

    setStage('pulling')
    setPullTotal(selected.length)
    setPullProgress(0)
    setResults([])
    setError(null)

    startTransition(async () => {
      const collected: PullResult[] = []

      for (let i = 0; i < selected.length; i++) {
        const flight = selected[i]
        setCurrentLabel(flight.displayName)

        const res = await pullDjiFlight(projectId, selectedUuid, flight.fh2FilePath)
        collected.push({
          flightLabel: res.flightLabel ?? flight.displayName,
          succeeded:   res.succeeded ?? 0,
          total:       res.total ?? 0,
          failed:      res.failed ?? [],
        })
        setResults([...collected])
        setPullProgress(i + 1)
      }

      setStage('completed')
      router.refresh()
    })
  }, [missingFlights, checkedPaths, projectId, selectedUuid, startTransition, router])

  const toggleAll = (checked: boolean) => {
    setCheckedPaths(checked ? new Set(missingFlights.map((f) => f.fh2FilePath)) : new Set())
  }

  const toggleOne = (path: string) => {
    setCheckedPaths((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  const progressPercent = pullTotal > 0 ? Math.round((pullProgress / pullTotal) * 100) : 0
  const canClose = stage !== 'pulling' && stage !== 'loadingDiff'

  return (
    <>
      <Button
        variant="outline"
        className="flex items-center gap-2 hover:bg-gray-50 active:bg-gray-100 transition-colors"
        onClick={handleOpen}
        disabled={isPending}
      >
        <Download className="w-4 h-4 text-gray-500" />
        <span>Sync from DJI</span>
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (canClose) setOpen(v) }}>
        <DialogContent className="sm:max-w-lg" showCloseButton={canClose}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              {(stage === 'pickProject' || stage === 'loadingDiff') && (
                <>
                  <Download className="w-5 h-5 text-blue-500" />
                  <span>Sync from DJI FlightHub2</span>
                </>
              )}
              {stage === 'review' && (
                <>
                  <Download className="w-5 h-5 text-blue-500" />
                  <span>New flights available</span>
                </>
              )}
              {stage === 'pulling' && (
                <>
                  <RefreshCw className="w-5 h-5 text-blue-500 animate-spin" />
                  <span>Pulling flights…</span>
                </>
              )}
              {stage === 'completed' && (
                <>
                  <CheckCircle className="w-5 h-5 text-green-500" />
                  <span>Sync complete</span>
                </>
              )}
              {stage === 'error' && (
                <>
                  <AlertCircle className="w-5 h-5 text-red-500" />
                  <span>Sync failed</span>
                </>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="py-2 text-sm text-gray-600 space-y-4">

            {/* Step 1: DJI project picker */}
            {stage === 'pickProject' && (
              <div className="space-y-3">
                {loadingProjects ? (
                  <p className="text-gray-500">Loading DJI projects…</p>
                ) : djiProjects.length === 0 ? (
                  <p className="text-gray-500">No DJI projects found.</p>
                ) : (
                  <Select value={selectedUuid} onValueChange={(v) => { if (v) setSelectedUuid(v) }}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a DJI project…" />
                    </SelectTrigger>
                    <SelectContent>
                      {djiProjects.map((p) => (
                        <SelectItem key={p.uuid} value={p.uuid}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* Step 2: loading diff */}
            {stage === 'loadingDiff' && (
              <p className="text-gray-500">Comparing with DJI FlightHub2…</p>
            )}

            {/* Step 2b: review checklist */}
            {stage === 'review' && (
              <div className="space-y-3">
                {missingFlights.length === 0 ? (
                  <p>All flights from this DJI project are already in the dashboard.</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between text-xs text-gray-500 font-medium">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={checkedPaths.size === missingFlights.length}
                          ref={(el) => {
                            if (el) el.indeterminate = checkedPaths.size > 0 && checkedPaths.size < missingFlights.length
                          }}
                          onChange={(e) => toggleAll(e.target.checked)}
                        />
                        Select all
                      </label>
                      <span>{checkedPaths.size} / {missingFlights.length} selected</span>
                    </div>
                    <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                      {missingFlights.map((f) => (
                        <label
                          key={f.fh2FilePath}
                          className="flex items-start gap-3 px-3 py-2.5 hover:bg-gray-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            className="rounded mt-0.5 flex-shrink-0"
                            checked={checkedPaths.has(f.fh2FilePath)}
                            onChange={() => toggleOne(f.fh2FilePath)}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-gray-800 truncate">{f.displayName}</p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {f.timestamp ?? '—'}
                              {' · '}
                              {[
                                f.imageCount > 0 && `${f.imageCount} img`,
                                f.videoCount > 0 && `${f.videoCount} vid`,
                              ].filter(Boolean).join(', ') || `${f.fileCount} files`}
                            </p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Step 3: pulling progress */}
            {stage === 'pulling' && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-semibold text-gray-500">
                  <span className="truncate max-w-[260px]">Current: {currentLabel}</span>
                  <span>{pullProgress} / {pullTotal} flights</span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-gray-100 overflow-hidden relative shadow-inner">
                  <div
                    className="h-full bg-gradient-to-r from-blue-600 to-indigo-500 transition-all duration-300 rounded-full"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <p className="text-[10px] text-gray-400 font-mono text-right">{progressPercent}% complete</p>
              </div>
            )}

            {/* Results list (shown during pull and after) */}
            {results.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {stage === 'pulling' ? 'Completed so far:' : `${results.length} flight(s) pulled:`}
                </p>
                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50 font-mono text-xs">
                  {results.map((r, i) => (
                    <div key={i} className="flex justify-between border-b border-gray-200/50 pb-1.5 last:border-0 last:pb-0">
                      <span className="truncate max-w-[240px] text-gray-700 font-medium">{r.flightLabel}</span>
                      <span className="flex-shrink-0 text-right">
                        <span className="text-green-600">+{r.succeeded}</span>
                        {r.failed.length > 0 && (
                          <span className="text-red-600 ml-1">({r.failed.length} err)</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Completed with no results */}
            {stage === 'completed' && results.length === 0 && (
              <p>No files were pulled.</p>
            )}

            {/* Error */}
            {stage === 'error' && error && (
              <p className="text-red-600 font-medium">{error}</p>
            )}
          </div>

          <DialogFooter>
            {stage === 'pickProject' && (
              <Button
                onClick={handleFindFlights}
                disabled={!selectedUuid || loadingProjects || isPending}
              >
                Find new flights
              </Button>
            )}
            {stage === 'review' && missingFlights.length > 0 && (
              <Button onClick={handlePull} disabled={checkedPaths.size === 0 || isPending}>
                Pull selected ({checkedPaths.size})
              </Button>
            )}
            {(stage === 'completed' || stage === 'error' || (stage === 'review' && missingFlights.length === 0)) && (
              <Button onClick={() => setOpen(false)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
