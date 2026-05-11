import Link from 'next/link'
import { logout } from '@/app/actions/auth'
import { getSession } from '@/lib/session'

export default async function Home() {
  const session = await getSession()

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <span className="font-semibold text-gray-900">Salmon Enumeration Dashboard</span>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{session?.email}</span>
            {session?.role === 'admin' && (
              <Link
                href="/admin"
                className="text-sm font-medium text-blue-600 hover:underline"
              >
                Admin
              </Link>
            )}
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

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h1 className="text-3xl font-semibold text-gray-900 mb-2">Welcome back</h1>
        <p className="text-gray-500 mb-8">Signed in as <strong className="text-gray-700">{session?.email}</strong></p>
        <Link
          href="/projects"
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          View projects →
        </Link>
      </main>
    </div>
  )
}
