'use client'

import { useState } from 'react'
import ResendInviteButton from './resend-invite-button'
import DeleteInviteButton from './delete-invite-button'
import type { Role } from '@/lib/schema'

const roleLabels: Record<Role, string> = {
  read: 'Viewer',
  'read-write': 'Editor',
  admin: 'Admin',
}

const roleBadgeClass: Record<Role, string> = {
  read: 'bg-gray-100 text-gray-700',
  'read-write': 'bg-blue-100 text-blue-700',
  admin: 'bg-purple-100 text-purple-700',
}

type Invite = {
  id: string
  email: string
  role: Role
  sentAt: Date
  acceptedAt: Date | null
}

export default function InviteRow({ invite }: { invite: Invite }) {
  const [removed, setRemoved] = useState(false)

  if (removed) return null

  return (
    <tr>
      <td className="px-6 py-3 text-gray-900">{invite.email}</td>
      <td className="px-6 py-3">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${roleBadgeClass[invite.role]}`}
        >
          {roleLabels[invite.role]}
        </span>
      </td>
      <td className="px-6 py-3 text-gray-500">{invite.sentAt.toLocaleDateString()}</td>
      <td className="px-6 py-3">
        {invite.acceptedAt ? (
          <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
            Accepted
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-700">
            Pending
          </span>
        )}
      </td>
      <td className="px-6 py-3 text-right">
        <div className="flex items-center gap-3 justify-end">
          {!invite.acceptedAt && <ResendInviteButton inviteId={invite.id} />}
          <DeleteInviteButton inviteId={invite.id} onDeleted={() => setRemoved(true)} />
        </div>
      </td>
    </tr>
  )
}
