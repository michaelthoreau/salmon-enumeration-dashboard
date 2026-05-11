import { redirect } from 'next/navigation'
import VerifyForm from './verify-form'

interface PageProps {
  searchParams: Promise<{ email?: string }>
}

export default async function VerifyPage({ searchParams }: PageProps) {
  const { email } = await searchParams

  if (!email) {
    redirect('/login')
  }

  return <VerifyForm email={decodeURIComponent(email)} />
}
