'use client'

import { useActionState, useState, useEffect } from 'react'
import { removeUser, updateUserRole } from '@/app/actions/admin'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import type { Role } from '@/lib/schema'

interface UserActionsProps {
  userId: string
  userEmail: string
  currentRole: Role
  isSelf: boolean
  onRoleChange: (role: Role) => void
  onRemoved: () => void
}

export default function UserActions({ userId, userEmail, currentRole, isSelf, onRoleChange, onRemoved }: UserActionsProps) {
  return (
    <div className="flex items-center gap-3 justify-end">
      <EditRoleButton userId={userId} userEmail={userEmail} currentRole={currentRole} onRoleChange={onRoleChange} />
      {!isSelf && <RemoveUserButton userId={userId} userEmail={userEmail} onRemoved={onRemoved} />}
    </div>
  )
}

function EditRoleButton({
  userId,
  userEmail,
  currentRole,
  onRoleChange,
}: {
  userId: string
  userEmail: string
  currentRole: Role
  onRoleChange: (role: Role) => void
}) {
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<Role>(currentRole)
  const [state, action, pending] = useActionState(updateUserRole, null)

  useEffect(() => {
    if (state?.success) {
      onRoleChange(role)
      setOpen(false)
    }
  }, [state])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-blue-600 hover:underline"
      >
        Edit role
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Edit role</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            Change role for <strong>{userEmail}</strong>.
          </p>
          <form action={action} className="space-y-4">
            <input type="hidden" name="id" value={userId} />
            <Select name="role" value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Viewer (read)</SelectItem>
                <SelectItem value="read-write">Editor (read-write)</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
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

function RemoveUserButton({ userId, userEmail, onRemoved }: { userId: string; userEmail: string; onRemoved: () => void }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(removeUser, null)

  useEffect(() => {
    if (state?.success) {
      setOpen(false)
      onRemoved()
    }
  }, [state])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-red-600 hover:underline"
      >
        Remove
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Remove user?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            Are you sure you want to remove <strong>{userEmail}</strong>? They will lose access
            immediately.
          </p>
          {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <form action={action}>
              <input type="hidden" name="id" value={userId} />
              <Button
                type="submit"
                disabled={pending}
                variant="ghost"
                className="text-destructive hover:text-destructive"
              >
                {pending ? '…' : 'Remove'}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
