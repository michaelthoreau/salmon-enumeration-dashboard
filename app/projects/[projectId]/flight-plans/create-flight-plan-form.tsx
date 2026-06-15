'use client'

import { useActionState, useEffect, useState } from 'react'
import { createFlightPlan } from '@/app/actions/flight-plans'
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

export default function CreateFlightPlanForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(createFlightPlan, null)

  useEffect(() => {
    if (state?.success) setOpen(false)
  }, [state])

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        New flight plan
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>New flight plan</DialogTitle>
          </DialogHeader>

          <form action={action} className="flex flex-col gap-4 py-2">
            <input type="hidden" name="projectId" value={projectId} />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-name">Name</Label>
              <Input
                id="fp-name"
                name="name"
                required
                placeholder="flight-plan-name"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-display-name">Display Name</Label>
              <Input
                id="fp-display-name"
                name="displayName"
                placeholder="Optional display name override"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-description">Description</Label>
              <Input
                id="fp-description"
                name="description"
                placeholder="Optional description"
              />
            </div>

            {state?.error && <p className="text-sm text-destructive">{state.error}</p>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Creating…' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
