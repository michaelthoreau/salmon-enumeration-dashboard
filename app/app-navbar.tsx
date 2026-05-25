import Image from 'next/image'
import Link from 'next/link'
import { getSession } from '@/lib/session'
import { UserMenu } from '@/app/user-menu'

export async function AppNavBar() {
  const session = await getSession()

  return (
    <header className="bg-white border-b border-gray-200">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
        <Link href="/" className="shrink-0">
          <Image
            src="/kiwi_logo.webp"
            alt="Project Kiwi"
            width={180}
            height={52}
            className="h-11 w-auto"
            priority
          />
        </Link>
        {session && (
          <UserMenu email={session.email} isAdmin={session.role === 'admin'} />
        )}
      </div>
    </header>
  )
}
