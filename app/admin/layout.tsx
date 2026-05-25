import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { AppNavBar } from '@/app/app-navbar'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()

  if (!session || session.role !== 'admin') {
    redirect('/')
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <AppNavBar />
      {children}
    </div>
  )
}
