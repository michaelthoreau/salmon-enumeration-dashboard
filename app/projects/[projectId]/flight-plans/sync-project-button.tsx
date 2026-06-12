'use client'

import { useState, useTransition, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { RefreshCw, CheckCircle, AlertCircle } from 'lucide-react'
import { getProjectFlightsForSync, syncFlightFiles } from '@/app/actions/files'
import { cn } from '@/lib/utils'

interface Props {
  projectId: string
}

interface SyncResultItem {
  flightId: string
  added: number
  removed: number
  flightLabel: string
}

export default function SyncProjectButton({ projectId }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  
  // Sync states
  const [stage, setStage] = useState<'idle' | 'syncing' | 'completed' | 'error'>('idle')
  const [total, setTotal] = useState(0)
  const [progress, setProgress] = useState(0)
  const [currentLabel, setCurrentLabel] = useState('')
  const [results, setResults] = useState<SyncResultItem[]>([])
  const [error, setError] = useState<string | null>(null)

  const handleSync = () => {
    setStage('syncing')
    setError(null)
    setResults([])
    setProgress(0)
    setTotal(0)
    setCurrentLabel('Initializing...')
    setOpen(true)

    startTransition(async () => {
      try {
        const initRes = await getProjectFlightsForSync(projectId)
        if (!initRes.ok) {
          throw new Error(initRes.error ?? 'Failed to fetch flight list.')
        }

        const flights = initRes.flights
        setTotal(flights.length)
        
        if (flights.length === 0) {
          setStage('completed')
          return
        }

        const collected: SyncResultItem[] = []

        for (let i = 0; i < flights.length; i++) {
          const flight = flights[i]
          setCurrentLabel(flight.flightLabel)

          try {
            const syncRes = await syncFlightFiles(projectId, flight.flightPlanId, flight.flightId)
            if (syncRes.ok && (syncRes.added > 0 || syncRes.removed > 0)) {
              collected.push({
                flightId: flight.flightId,
                added: syncRes.added,
                removed: syncRes.removed,
                flightLabel: flight.flightLabel,
              })
              setResults([...collected])
            }
          } catch (err) {
            console.error(`Failed to sync flight ${flight.flightLabel}:`, err)
          }

          setProgress(i + 1)
        }

        setStage('completed')
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setStage('error')
      }
    })
  }

  const progressPercent = total > 0 ? Math.round((progress / total) * 100) : 0

  return (
    <>
      <Button
        variant="outline"
        className="flex items-center gap-2 hover:bg-gray-50 active:bg-gray-100 transition-colors"
        onClick={handleSync}
        disabled={isPending}
      >
        <RefreshCw className={cn("w-4 h-4 text-gray-500", isPending && "animate-spin")} />
        <span>{isPending ? 'Syncing...' : 'Sync S3 Files'}</span>
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (stage !== 'syncing') setOpen(v) }}>
        <DialogContent className="sm:max-w-md" showCloseButton={stage !== 'syncing'}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              {stage === 'syncing' && (
                <>
                  <RefreshCw className="w-5 h-5 text-blue-500 animate-spin" />
                  <span>Syncing S3 Files…</span>
                </>
              )}
              {stage === 'completed' && (
                <>
                  <CheckCircle className="w-5 h-5 text-green-500" />
                  <span>S3 Sync Complete</span>
                </>
              )}
              {stage === 'error' && (
                <>
                  <AlertCircle className="w-5 h-5 text-red-500" />
                  <span>Sync Failed</span>
                </>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="py-2 text-sm text-gray-600 space-y-4">
            {/* Live Progress Bar */}
            {stage === 'syncing' && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-semibold text-gray-500">
                  <span className="truncate max-w-[260px]">Current: {currentLabel}</span>
                  <span>{progress} / {total} flights</span>
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

            {/* Error Message */}
            {stage === 'error' && error && (
              <p className="text-red-600 font-medium">{error}</p>
            )}

            {/* Results Section */}
            {stage === 'completed' && results.length === 0 && !error && (
              <p>All flight plans and flights are fully synchronized with S3. No mismatches found.</p>
            )}

            {(results.length > 0 || (stage === 'syncing' && results.length > 0)) && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {stage === 'syncing' ? 'Mismatches resolved so far:' : `Resolved mismatches for ${results.length} flight(s):`}
                </p>
                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50 font-mono text-xs">
                  {results.map((item) => (
                    <div key={item.flightId} className="flex justify-between border-b border-gray-200/50 pb-1.5 last:border-0 last:pb-0">
                      <span className="truncate max-w-[240px] text-gray-700 font-medium">{item.flightLabel}</span>
                      <span className="flex-shrink-0 text-right font-medium">
                        {item.added > 0 && <span className="text-green-600">+{item.added}</span>}
                        {item.added > 0 && item.removed > 0 && <span className="text-gray-300 mx-1">/</span>}
                        {item.removed > 0 && <span className="text-red-600">-{item.removed}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button onClick={() => setOpen(false)} disabled={stage === 'syncing'}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
