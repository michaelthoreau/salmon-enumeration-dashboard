import { cookies } from 'next/headers'
import LoginForm from './login-form'

interface PageProps {
  searchParams: Promise<{ email?: string }>
}

export default async function LoginPage({ searchParams }: PageProps) {
  const { email: urlEmail } = await searchParams
  const cookieStore = await cookies()
  const lastEmail = cookieStore.get('last_email')?.value

  const prefilledEmail = urlEmail ? decodeURIComponent(urlEmail) : undefined
  // Only show the cookie button if it differs from the URL-prefilled email
  const suggestedEmail = lastEmail && lastEmail !== prefilledEmail ? lastEmail : undefined

  return <LoginForm suggestedEmail={suggestedEmail} prefilledEmail={prefilledEmail} />
}
