'use server'

import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import { users, invites } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { createOtp, verifyOtp } from '@/lib/otp'
import { sendOtpEmail } from '@/lib/email'
import { createSession, deleteSession } from '@/lib/session'
import { randomUUID } from 'crypto'

type ActionState = { error: string } | null

export async function requestOtp(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formData.get('email')
  const email = typeof raw === 'string' ? raw.toLowerCase().trim() : ''

  if (!email || !email.includes('@')) {
    return { error: 'Please enter a valid email address.' }
  }

  const [existingUser] = await db.select().from(users).where(eq(users.email, email))
  const [invite] = await db.select().from(invites).where(eq(invites.email, email))

  if (!existingUser && !invite) {
    return { error: 'This email has not been invited. Please contact an administrator.' }
  }

  const otp = await createOtp(email)
  await sendOtpEmail(email, otp)

  const cookieStore = await cookies()
  cookieStore.set('last_email', email, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365, // 1 year
    path: '/',
  })

  redirect(`/verify?email=${encodeURIComponent(email)}`)
}

export async function verifyOtpAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const email = (formData.get('email') as string | null)?.toLowerCase().trim() ?? ''
  const code = (formData.get('code') as string | null)?.trim() ?? ''

  if (!email || !code) {
    return { error: 'Email and code are required.' }
  }

  const valid = await verifyOtp(email, code)
  if (!valid) {
    return { error: 'Invalid or expired code. Please request a new one.' }
  }

  // Get or create the user record
  let [user] = await db.select().from(users).where(eq(users.email, email))

  if (!user) {
    const [invite] = await db.select().from(invites).where(eq(invites.email, email))
    if (!invite) {
      return { error: 'No invitation found for this email address.' }
    }

    const newUser = {
      id: randomUUID(),
      email,
      role: invite.role,
      createdAt: new Date(),
    }
    await db.insert(users).values(newUser)
    await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id))

    user = newUser
  }

  await createSession({
    userId: user.id,
    email: user.email,
    role: user.role,
  })

  redirect('/')
}

export async function logout(): Promise<never> {
  await deleteSession()
  redirect('/login')
}
