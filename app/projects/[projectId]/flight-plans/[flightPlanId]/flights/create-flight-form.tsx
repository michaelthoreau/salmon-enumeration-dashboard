'use client'

import { useActionState, useEffect, useState } from 'react'
import { createFlight } from '@/app/actions/flights'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

function nowInTz(tz: string): string {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

export default function CreateFlightForm({
  projectId,
  flightPlanId,
  timezone,
  className,
}: {
  projectId: string
  flightPlanId: string
  timezone: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [timestamp, setTimestamp] = useState(() => nowInTz(timezone))
  const [notes, setNotes] = useState('')
  const [state, action, pending] = useActionState(createFlight, null)

  useEffect(() => {
    if (state?.success) setOpen(false)
  }, [state])

  function handleOpen() {
    setTimestamp(nowInTz(timezone))
    setNotes('')
    setOpen(true)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={handleOpen} className={className}>+ Log flight</Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log a new flight</DialogTitle>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="flightPlanId" value={flightPlanId} />
          <input type="hidden" name="timezone" value={timezone} />
          <div className="space-y-1.5">
            <Label>
              Timestamp{' '}
              <span className="font-normal text-muted-foreground">({timezone})</span>
            </Label>
            <Input
              name="timestamp"
              type="datetime-local"
              required
              value={timestamp}
              onChange={e => setTimestamp(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Input
              name="notes"
              placeholder="e.g. Clear skies, 15kt wind"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
          {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Log flight'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
