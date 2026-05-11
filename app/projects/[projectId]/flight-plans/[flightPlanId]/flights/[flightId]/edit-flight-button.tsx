'use client'

import { useActionState, useEffect, useState } from 'react'
import { updateFlight } from '@/app/actions/flights'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

interface Props {
  flightId: string
  projectId: string
  flightPlanId: string
  timezone: string
  /** Current flight timestamp formatted as YYYY-MM-DDTHH:mm in project timezone */
  localTimestamp: string
  currentNotes: string | null
}

export default function EditFlightButton({
  flightId,
  projectId,
  flightPlanId,
  timezone,
  localTimestamp,
  currentNotes,
}: Props) {
  const [open, setOpen] = useState(false)
  const [timestamp, setTimestamp] = useState(localTimestamp)
  const [notes, setNotes] = useState(currentNotes ?? '')
  const [state, action, pending] = useActionState(updateFlight, null)

  useEffect(() => {
    if (open) {
      setTimestamp(localTimestamp)
      setNotes(currentNotes ?? '')
    }
  }, [open, localTimestamp, currentNotes])

  useEffect(() => {
    if (state?.success) setOpen(false)
  }, [state])

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit flight</DialogTitle>
          </DialogHeader>
          <form action={action} className="space-y-4">
            <input type="hidden" name="id" value={flightId} />
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
                {pending ? 'Saving…' : 'Save changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
