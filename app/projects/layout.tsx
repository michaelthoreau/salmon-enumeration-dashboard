import Link from 'next/link'
import { getSession } from '@/lib/session'
import { logout } from '@/app/actions/auth'

export default async function ProjectsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <Link href="/" className="font-semibold text-gray-900 hover:text-blue-600 transition-colors">
            Salmon Enumeration
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{session?.email}</span>
            {session?.role === 'admin' && (
              <Link href="/admin" className="text-sm font-medium text-blue-600 hover:underline">
                Admin
              </Link>
            )}
            <form action={logout}>
              <button type="submit" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">{children}</main>
    </div>
  )
}
