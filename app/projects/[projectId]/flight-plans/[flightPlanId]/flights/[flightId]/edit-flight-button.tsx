'use client'

import { useActionState, useEffect, useState } from 'react'
import { updateFlight } from '@/app/actions/flights'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import type { SurveyType } from '@/lib/schema'

interface Props {
  flightId: string
  projectId: string
  flightPlanId: string
  timezone: string
  /** Current flight timestamp formatted as YYYY-MM-DDTHH:mm in project timezone */
  localTimestamp: string
  currentNotes: string | null
  currentSurveyType: SurveyType
}

export default function EditFlightButton({
  flightId,
  projectId,
  flightPlanId,
  timezone,
  localTimestamp,
  currentNotes,
  currentSurveyType,
}: Props) {
  const [open, setOpen] = useState(false)
  const [timestamp, setTimestamp] = useState(localTimestamp)
  const [notes, setNotes] = useState(currentNotes ?? '')
  const [surveyType, setSurveyType] = useState<SurveyType>(currentSurveyType)
  const [state, action, pending] = useActionState(updateFlight, null)

  useEffect(() => {
    if (open) {
      setTimestamp(localTimestamp)
      setNotes(currentNotes ?? '')
      setSurveyType(currentSurveyType)
    }
  }, [open, localTimestamp, currentNotes, currentSurveyType])

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
            <div className="space-y-1.5">
              <Label>
                Survey type{' '}
                <span className="font-normal text-muted-foreground">
                  (gates which detection model applies — e.g. spawning-salmon detection only
                  makes sense for spawning-ground orthos, not migration counts)
                </span>
              </Label>
              <input type="hidden" name="surveyType" value={surveyType} />
              <Select value={surveyType} onValueChange={(v) => setSurveyType(v as SurveyType)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Survey type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="migration">Migration (swimming salmon count)</SelectItem>
                  <SelectItem value="spawning">Spawning grounds (stationary red salmon)</SelectItem>
                </SelectContent>
              </Select>
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
