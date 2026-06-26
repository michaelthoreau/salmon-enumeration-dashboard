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
import { Clapperboard, CheckCircle, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { backfillVideoMetadata } from '@/app/actions/files'

export default function ExtractMetadataButton({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [updated, setUpdated] = useState(0)
  const [error, setError] = useState<string | null>(null)

  function handleClick() {
    setStage('running')
    setError(null)
    setOpen(true)
    startTransition(async () => {
      const res = await backfillVideoMetadata(projectId)
      if (!res.ok) {
        setError(res.error ?? 'Unknown error')
        setStage('error')
      } else {
        setUpdated(res.updated)
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
        <Clapperboard className={cn('w-4 h-4 text-gray-500', isPending && 'animate-pulse')} />
        <span>{isPending ? 'Extracting…' : 'Extract Video Metadata'}</span>
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (stage !== 'running') setOpen(v) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              {stage === 'running' && <><Clapperboard className="w-5 h-5 text-blue-500 animate-pulse" /><span>Extracting metadata…</span></>}
              {stage === 'done' && <><CheckCircle className="w-5 h-5 text-green-500" /><span>Done</span></>}
              {stage === 'error' && <><AlertCircle className="w-5 h-5 text-red-500" /><span>Failed</span></>}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 text-sm text-gray-600">
            {stage === 'running' && <p>Reading duration from video files in S3. This may take a moment…</p>}
            {stage === 'done' && (
              <div className="space-y-1">
                <p><span className="font-semibold text-green-600">{updated}</span> video{updated !== 1 ? 's' : ''} updated with duration.</p>
                {updated === 0 && <p className="text-gray-400 text-xs">All videos already had duration data.</p>}
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
