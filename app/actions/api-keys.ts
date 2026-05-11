'use server'

import { db } from '@/lib/db'
import { apiKeys } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { generateApiKey, hashApiKey } from '@/lib/api-auth'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'

type State = { error?: string; newKey?: string } | null

export async function createApiKey(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const name = (formData.get('name') as string | null)?.trim()
  if (!name) return { error: 'Name is required.' }

  const raw = generateApiKey()
  const hash = hashApiKey(raw)

  await db.insert(apiKeys).values({
    id: randomUUID(),
    name,
    keyHash: hash,
    createdBy: session.userId,
    createdAt: new Date(),
  })

  revalidatePath('/admin/api-keys')
  // Return the raw key once — it won't be retrievable again
  return { newKey: raw }
}

export async function revokeApiKey(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const id = formData.get('id') as string | null
  if (!id) return { error: 'Key ID is required.' }

  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id))
  revalidatePath('/admin/api-keys')
  return null
}
