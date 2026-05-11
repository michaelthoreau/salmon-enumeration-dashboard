import { cookies } from 'next/headers'
import LoginForm from './login-form'

export default async function LoginPage() {
  const cookieStore = await cookies()
  const lastEmail = cookieStore.get('last_email')?.value

  return <LoginForm defaultEmail={lastEmail} />
}
