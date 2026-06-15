'use client'

import { useActionState, useEffect, useState } from 'react'
import { deleteProject, restoreProject, updateProject } from '@/app/actions/projects'
import type { projects } from '@/lib/schema'
import type { InferSelectModel } from 'drizzle-orm'
import { TIMEZONE_OPTIONS } from '@/lib/timezones'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

type Project = InferSelectModel<typeof projects>

export function ProjectCardActions({ project }: { project: Project }) {
  return (
    <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
      <EditProjectButton project={project} />
      <DeleteProjectButton project={project} />
    </div>
  )
}

export function DeleteProjectButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(deleteProject, null)
  return (
    <>
      <Button type="button" variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">Are you sure you want to delete <strong>{project.name}</strong>? This can be undone from the archived list.</p>
          {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <form action={action}>
              <input type="hidden" name="id" value={project.id} />
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

export function RestoreProjectButton({ project }: { project: Project }) {
  const [state, action, pending] = useActionState(restoreProject, null)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={project.id} />
      <Button type="submit" disabled={pending} variant="ghost" size="xs" className="text-green-600 hover:text-green-600">
        {pending ? '…' : 'Restore'}
      </Button>
      {state?.error && <span className="ml-2 text-xs text-destructive">{state.error}</span>}
    </form>
  )
}

export function EditProjectButton({ project, label = 'Edit', variant: buttonVariant = 'ghost', size: buttonSize = 'xs' }: { project: Project; label?: string; variant?: 'ghost' | 'outline' | 'default'; size?: 'xs' | 'sm' | 'default' }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(updateProject, null)

  // Close on success
  useEffect(() => {
    if (state?.success) setOpen(false)
  }, [state])

  return (
    <>
      <Button variant={buttonVariant} size={buttonSize} onClick={() => setOpen(true)}>
        {label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
          </DialogHeader>

          <form action={action} className="flex flex-col gap-4 py-2">
            <input type="hidden" name="id" value={project.id} />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-name">Project Name</Label>
              <Input
                id="edit-name"
                name="name"
                defaultValue={project.name}
                required
                placeholder="Project name"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-description">Description</Label>
              <Input
                id="edit-description"
                name="description"
                defaultValue={project.description ?? ''}
                placeholder="Optional description"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-timezone">Timezone</Label>
              <Select name="timezone" defaultValue={project.timezone}>
                <SelectTrigger id="edit-timezone" className="w-full">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONE_OPTIONS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
