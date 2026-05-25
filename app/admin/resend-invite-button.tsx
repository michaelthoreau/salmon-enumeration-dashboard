'use client'

import { useActionState } from 'react'
import { resendInvite } from '@/app/actions/admin'

export default function ResendInviteButton({ inviteId }: { inviteId: string }) {
  const [state, action, pending] = useActionState(resendInvite, null)

  return (
    <form action={action}>
      <input type="hidden" name="id" value={inviteId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-blue-600 hover:underline disabled:opacity-50"
      >
        {pending ? 'Sending…' : state?.success ? 'Sent ✓' : 'Resend'}
      </button>
    </form>
  )
}
