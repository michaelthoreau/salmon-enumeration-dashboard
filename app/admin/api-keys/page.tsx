import { db } from '@/lib/db'
import { apiKeys } from '@/lib/schema'
import { desc } from 'drizzle-orm'
import { CreateApiKeyButton, RevokeApiKeyButton } from './api-key-actions'

function fmt(d: Date | null) {
  if (!d) return '—'
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}

export default async function ApiKeysPage() {
  const keys = await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt))
  const active = keys.filter((k) => !k.revokedAt)
  const revoked = keys.filter((k) => k.revokedAt)

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">API Keys</h1>
          <p className="text-sm text-gray-500 mt-1">Keys allow programmatic access to the API.</p>
        </div>
        <CreateApiKeyButton />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {active.length === 0 ? (
          <p className="text-sm text-gray-500 p-6">No active API keys.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Name</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Created</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Last used</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {active.map((k) => (
                <tr key={k.id}>
                  <td className="px-6 py-3 font-medium text-gray-900">{k.name}</td>
                  <td className="px-6 py-3 text-gray-500">{fmt(k.createdAt)}</td>
                  <td className="px-6 py-3 text-gray-500">{fmt(k.lastUsedAt)}</td>
                  <td className="px-6 py-3 text-right">
                    <RevokeApiKeyButton keyId={k.id} keyName={k.name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {revoked.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden opacity-60">
          <div className="px-6 py-3 border-b border-gray-200 bg-gray-50">
            <h2 className="text-sm font-medium text-gray-500">Revoked ({revoked.length})</h2>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {revoked.map((k) => (
                <tr key={k.id}>
                  <td className="px-6 py-3 text-gray-400 line-through">{k.name}</td>
                  <td className="px-6 py-3 text-gray-400">{fmt(k.createdAt)}</td>
                  <td className="px-6 py-3 text-gray-400">Revoked {fmt(k.revokedAt)}</td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
