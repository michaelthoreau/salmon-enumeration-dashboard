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
import { MapPin, CheckCircle, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { backfillVideoGps } from '@/app/actions/files'

export default function BackfillGpsButton({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<{ updated: number; failed: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  function handleClick() {
    setStage('running')
    setResult(null)
    setError(null)
    setOpen(true)
    startTransition(async () => {
      const res = await backfillVideoGps(projectId)
      if (!res.ok) {
        setError(res.error ?? 'Unknown error')
        setStage('error')
      } else {
        setResult({ updated: res.updated, failed: res.failed })
        setStage('done')
        router.refresh()
      }
    })
  }

  return (
    <>
      <Button
        variant="outline"
        className="flex items-center gap-2 hover:bg-gray-50 transition-colors"
        onClick={handleClick}
        disabled={isPending}
      >
        <MapPin className={cn('w-4 h-4 text-gray-500', isPending && 'animate-pulse')} />
        <span>{isPending ? 'Extracting…' : 'Extract Video GPS'}</span>
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (stage !== 'running') setOpen(v) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              {stage === 'running' && <><MapPin className="w-5 h-5 text-blue-500 animate-pulse" /><span>Extracting GPS…</span></>}
              {stage === 'done' && <><CheckCircle className="w-5 h-5 text-green-500" /><span>GPS Extraction Complete</span></>}
              {stage === 'error' && <><AlertCircle className="w-5 h-5 text-red-500" /><span>Extraction Failed</span></>}
            </DialogTitle>
          </DialogHeader>

          <div className="py-2 text-sm text-gray-600">
            {stage === 'running' && (
              <p>Reading GPS metadata from video files with missing coordinates. This may take a while…</p>
            )}
            {stage === 'done' && result && (
              <div className="space-y-1">
                <p><span className="font-semibold text-green-600">{result.updated}</span> video{result.updated !== 1 ? 's' : ''} updated with GPS coordinates.</p>
                {result.failed > 0 && <p className="text-gray-400 text-xs">{result.failed} file{result.failed !== 1 ? 's' : ''} had no readable GPS metadata.</p>}
                {result.updated === 0 && result.failed === 0 && <p className="text-gray-400">No videos were missing GPS coordinates.</p>}
              </div>
            )}
            {stage === 'error' && <p className="text-red-600">{error}</p>}
          </div>

          <DialogFooter>
            <Button onClick={() => setOpen(false)} disabled={stage === 'running'}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
