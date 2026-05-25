'use client'

import { useState } from 'react'
import UserActions from './user-actions'
import type { Role } from '@/lib/schema'

type User = {
  id: string
  email: string
  role: Role
  createdAt: Date
}

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

export default function UserRow({ user, isSelf }: { user: User; isSelf: boolean }) {
  const [role, setRole] = useState<Role>(user.role)
  const [removed, setRemoved] = useState(false)

  if (removed) return null

  return (
    <tr>
      <td className="px-6 py-3 text-gray-900">{user.email}</td>
      <td className="px-6 py-3">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${roleBadgeClass[role]}`}
        >
          {roleLabels[role]}
        </span>
      </td>
      <td className="px-6 py-3 text-gray-500">{user.createdAt.toLocaleDateString()}</td>
      <td className="px-6 py-3">
        <UserActions
          userId={user.id}
          userEmail={user.email}
          currentRole={role}
          isSelf={isSelf}
          onRoleChange={setRole}
          onRemoved={() => setRemoved(true)}
        />
      </td>
    </tr>
  )
}
