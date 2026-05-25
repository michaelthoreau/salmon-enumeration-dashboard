'use server'

import { db } from '@/lib/db'
import { users, invites } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { sendInviteEmail } from '@/lib/email'
import { normalizeEmail } from '@/lib/utils'
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
  const email = typeof raw === 'string' ? normalizeEmail(raw) : ''
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

export async function resendInvite(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await getSession()
  if (!session || session.role !== 'admin') {
    return { error: 'Unauthorized.' }
  }

  const id = formData.get('id') as string | null
  if (!id) return { error: 'Invite ID is required.' }

  const [invite] = await db.select().from(invites).where(eq(invites.id, id))
  if (!invite) return { error: 'Invite not found.' }
  if (invite.acceptedAt) return { error: 'This invite has already been accepted.' }

  await db.update(invites).set({ sentAt: new Date() }).where(eq(invites.id, id))
  await sendInviteEmail(invite.email, invite.role, session.email)

  return { success: `Invite resent to ${invite.email}.` }
}

export async function removeUser(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await getSession()
  if (!session || session.role !== 'admin') {
    return { error: 'Unauthorized.' }
  }

  const id = formData.get('id') as string | null
  if (!id) return { error: 'User ID is required.' }
  if (id === session.userId) return { error: 'You cannot remove your own account.' }

  const [user] = await db.select().from(users).where(eq(users.id, id))
  if (!user) return { error: 'User not found.' }

  await db.delete(users).where(eq(users.id, id))
  await db.delete(invites).where(eq(invites.email, user.email))

  return { success: `${user.email} has been removed.` }
}

export async function deleteInvite(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await getSession()
  if (!session || session.role !== 'admin') {
    return { error: 'Unauthorized.' }
  }

  const id = formData.get('id') as string | null
  if (!id) return { error: 'Invite ID is required.' }

  await db.delete(invites).where(eq(invites.id, id))

  return { success: 'Invite removed.' }
}

export async function updateUserRole(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await getSession()
  if (!session || session.role !== 'admin') {
    return { error: 'Unauthorized.' }
  }

  const id = formData.get('id') as string | null
  const role = formData.get('role') as Role | null

  if (!id) return { error: 'User ID is required.' }
  if (!role || !VALID_ROLES.includes(role)) return { error: 'Please select a valid role.' }

  const [user] = await db.select().from(users).where(eq(users.id, id))
  if (!user) return { error: 'User not found.' }

  await db.update(users).set({ role }).where(eq(users.id, id))

  return { success: `Role updated to ${role} for ${user.email}.` }
}
