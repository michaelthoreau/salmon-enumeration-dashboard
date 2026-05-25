'use client'

import { useActionState, useEffect } from 'react'
import { deleteInvite } from '@/app/actions/admin'

export default function DeleteInviteButton({
  inviteId,
  onDeleted,
}: {
  inviteId: string
  onDeleted: () => void
}) {
  const [state, action, pending] = useActionState(deleteInvite, null)

  useEffect(() => {
    if (state?.success) onDeleted()
  }, [state])

  return (
    <form action={action}>
      <input type="hidden" name="id" value={inviteId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
      >
        {pending ? '…' : 'Clear'}
      </button>
    </form>
  )
}
