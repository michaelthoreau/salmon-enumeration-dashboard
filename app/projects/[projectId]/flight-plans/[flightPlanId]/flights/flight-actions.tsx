'use client'

import { useActionState, useState } from 'react'
import { deleteFlight, restoreFlight } from '@/app/actions/flights'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

export function DeleteFlightButton({
  flight,
  projectId,
  flightPlanId,
}: {
  flight: { id: string }
  projectId: string
  flightPlanId: string
}) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(deleteFlight, null)
  return (
    <>
      <Button type="button" variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Delete flight?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">Are you sure you want to delete this flight? This action can be undone from the archived list.</p>
          {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <form action={action}>
              <input type="hidden" name="id" value={flight.id} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="flightPlanId" value={flightPlanId} />
              <Button type="submit" disabled={pending} variant="ghost" className="text-destructive hover:text-destructive">
                {pending ? '…' : 'Delete'}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function RestoreFlightButton({
  flight,
  projectId,
  flightPlanId,
}: {
  flight: { id: string }
  projectId: string
  flightPlanId: string
}) {
  const [state, action, pending] = useActionState(restoreFlight, null)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={flight.id} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="flightPlanId" value={flightPlanId} />
      <Button type="submit" disabled={pending} variant="ghost" size="xs" className="text-green-600 hover:text-green-600">
        {pending ? '…' : 'Restore'}
      </Button>
      {state?.error && <span className="ml-2 text-xs text-destructive">{state.error}</span>}
    </form>
  )
}
