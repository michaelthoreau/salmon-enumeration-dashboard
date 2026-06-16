'use client'

import { useActionState, useEffect, useState } from 'react'
import { deleteFlightPlan, restoreFlightPlan, updateFlightPlan } from '@/app/actions/flight-plans'
import type { flightPlans } from '@/lib/schema'
import type { InferSelectModel } from 'drizzle-orm'
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

type FlightPlan = InferSelectModel<typeof flightPlans>

export function DeleteFlightPlanButton({
  plan,
  projectId,
}: {
  plan: FlightPlan
  projectId: string
}) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(deleteFlightPlan, null)
  return (
    <>
      <Button type="button" variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Delete flight route?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">Are you sure you want to delete <strong>{plan.displayName || plan.name}</strong>?</p>
          {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <form action={action}>
              <input type="hidden" name="id" value={plan.id} />
              <input type="hidden" name="projectId" value={projectId} />
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

export function RestoreFlightPlanButton({
  plan,
  projectId,
}: {
  plan: FlightPlan
  projectId: string
}) {
  const [state, action, pending] = useActionState(restoreFlightPlan, null)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={plan.id} />
      <input type="hidden" name="projectId" value={projectId} />
      <Button type="submit" disabled={pending} variant="ghost" size="xs" className="text-green-600 hover:text-green-600">
        {pending ? '…' : 'Restore'}
      </Button>
      {state?.error && <span className="ml-2 text-xs text-destructive">{state.error}</span>}
    </form>
  )
}

export function EditFlightPlanButton({
  plan,
  projectId,
  label = 'Edit',
  variant = 'ghost',
  size = 'xs',
  className,
}: {
  plan: { id: string; name: string; displayName: string | null; description: string | null }
  projectId: string
  label?: React.ReactNode
  variant?: 'ghost' | 'outline' | 'default' | 'secondary'
  size?: 'xs' | 'sm' | 'default' | 'icon'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(updateFlightPlan, null)

  useEffect(() => {
    if (state?.success) setOpen(false)
  }, [state])

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
      >
        {label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Edit flight route</DialogTitle>
          </DialogHeader>

          <form action={action} className="flex flex-col gap-4 py-2">
            <input type="hidden" name="id" value={plan.id} />
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="name" value={plan.name} />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-edit-name">Name</Label>
              <Input
                id="fp-edit-name"
                defaultValue={plan.name}
                disabled
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-edit-display-name">Display Name</Label>
              <Input
                id="fp-edit-display-name"
                name="displayName"
                defaultValue={plan.displayName ?? ''}
                placeholder="Optional display name override"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-edit-description">Description</Label>
              <Input
                id="fp-edit-description"
                name="description"
                defaultValue={plan.description ?? ''}
                placeholder="Optional description"
              />
            </div>

            {state?.error && <p className="text-sm text-destructive">{state.error}</p>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
