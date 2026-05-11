import Link from 'next/link'
import { db } from '@/lib/db'
import { users, invites } from '@/lib/schema'
import { desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { logout } from '@/app/actions/auth'
import InviteForm from './invite-form'
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

export default async function AdminPage() {
  const session = await getSession()
  const allInvites = await db.select().from(invites).orderBy(desc(invites.sentAt))
  const allUsers = await db.select().from(users).orderBy(desc(users.createdAt))

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <Link href="/projects" className="text-xl font-semibold text-gray-900 hover:text-blue-600 transition-colors">Admin Dashboard</Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{session?.email}</span>
            <form action={logout}>
              <button
                type="submit"
                className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-10">
        {/* Send invite */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Send an invitation</h2>
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <InviteForm />
          </div>
        </section>

        {/* Users */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Users{' '}
            <span className="text-sm font-normal text-gray-500">({allUsers.length})</span>
          </h2>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {allUsers.length === 0 ? (
              <p className="text-sm text-gray-500 p-6">No users yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-6 py-3 font-medium text-gray-600">Email</th>
                    <th className="text-left px-6 py-3 font-medium text-gray-600">Role</th>
                    <th className="text-left px-6 py-3 font-medium text-gray-600">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {allUsers.map((user) => (
                    <tr key={user.id}>
                      <td className="px-6 py-3 text-gray-900">{user.email}</td>
                      <td className="px-6 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${roleBadgeClass[user.role]}`}
                        >
                          {roleLabels[user.role]}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-500">
                        {user.createdAt.toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Invites */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Invitations{' '}
            <span className="text-sm font-normal text-gray-500">({allInvites.length})</span>
          </h2>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {allInvites.length === 0 ? (
              <p className="text-sm text-gray-500 p-6">No invites sent yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-6 py-3 font-medium text-gray-600">Email</th>
                    <th className="text-left px-6 py-3 font-medium text-gray-600">Role</th>
                    <th className="text-left px-6 py-3 font-medium text-gray-600">Sent</th>
                    <th className="text-left px-6 py-3 font-medium text-gray-600">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {allInvites.map((invite) => (
                    <tr key={invite.id}>
                      <td className="px-6 py-3 text-gray-900">{invite.email}</td>
                      <td className="px-6 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${roleBadgeClass[invite.role]}`}
                        >
                          {roleLabels[invite.role]}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-500">
                        {invite.sentAt.toLocaleDateString()}
                      </td>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* API access */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">API access</h2>
          <div className="bg-white rounded-xl border border-gray-200 p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">API Keys</p>
              <p className="text-xs text-gray-500 mt-0.5">Create and manage keys for programmatic access</p>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/admin/api-docs" className="text-sm text-blue-600 hover:underline">Docs</Link>
              <Link href="/admin/api-keys" className="text-sm font-medium text-blue-600 hover:underline">Manage keys →</Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
