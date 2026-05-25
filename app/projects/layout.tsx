import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { AppNavBar } from '@/app/app-navbar'

export default async function ProjectsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <div className="min-h-screen bg-gray-50">
      <AppNavBar />
      {children}
    </div>
  )
}
