'use client'

import { useState, useTransition } from 'react'
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
import { syncProjectFiles } from '@/app/actions/files'
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
  const [results, setResults] = useState<SyncResultItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSync = async () => {
    setError(null)
    setResults(null)
    startTransition(async () => {
      try {
        const res = await syncProjectFiles(projectId)
        if (res.ok) {
          setResults(res.results)
          setOpen(true)
          router.refresh()
        } else {
          setError(res.error ?? 'Failed to synchronize flight files.')
          setOpen(true)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setOpen(true)
      }
    })
  }

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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              {error ? (
                <>
                  <AlertCircle className="w-5 h-5 text-red-500" />
                  <span>Sync Failed</span>
                </>
              ) : (
                <>
                  <CheckCircle className="w-5 h-5 text-green-500" />
                  <span>S3 Sync Results</span>
                </>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="py-2 text-sm text-gray-600 space-y-3">
            {error ? (
              <p className="text-red-600 font-medium">{error}</p>
            ) : results && results.length > 0 ? (
              <div className="space-y-3">
                <p>
                  Found and corrected file mismatches for <strong>{results.length}</strong> flight(s):
                </p>
                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50 font-mono text-xs">
                  {results.map((item) => (
                    <div key={item.flightId} className="flex justify-between border-b border-gray-100/50 pb-1.5 last:border-0 last:pb-0">
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
            ) : (
              <p>All flight plans and flights are fully synchronized with S3. No mismatches found.</p>
            )}
          </div>

          <DialogFooter>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
