'use server'

import { db } from '@/lib/db'
import { users, invites } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { sendInviteEmail } from '@/lib/email'
import { randomUUID } from 'crypto'
import type { Role } from '@/lib/schema'

type ActionState = { error?: string; success?: string } | null

const VALID_ROLES: Role[] = ['read', 'read-write', 'admin']

export async function sendInvite(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await getSession()
  if (!session || session.role !== 'admin') {
    return { error: 'Unauthorized.' }
  }

  const raw = formData.get('email')
  const email = typeof raw === 'string' ? raw.toLowerCase().trim() : ''
  const role = formData.get('role') as Role

  if (!email || !email.includes('@')) {
    return { error: 'Please enter a valid email address.' }
  }
  if (!VALID_ROLES.includes(role)) {
    return { error: 'Please select a valid role.' }
  }

  const [existingInvite] = await db.select().from(invites).where(eq(invites.email, email))
  if (existingInvite) {
    return { error: 'This email has already been invited.' }
  }

  const [existingUser] = await db.select().from(users).where(eq(users.email, email))
  if (existingUser) {
    return { error: 'A user with this email already exists.' }
  }

  await db.insert(invites).values({
    id: randomUUID(),
    email,
    role,
    invitedBy: session.userId,
    sentAt: new Date(),
    acceptedAt: null,
  })

  await sendInviteEmail(email, role, session.email)

  return { success: `Invite sent to ${email}.` }
}
