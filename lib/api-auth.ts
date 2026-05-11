import { createHash } from 'crypto'
import { db } from './db'
import { apiKeys } from './schema'
import { eq, isNull } from 'drizzle-orm'

/** Hash a raw API key for storage/lookup */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Generate a new random API key (prefix + 32 random bytes) */
export function generateApiKey(): string {
  const bytes = Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
  return `sockeye_${bytes.toString('hex')}`
}

/**
 * Validate a Bearer token from an Authorization header.
 * Returns the apiKey row if valid and not revoked, null otherwise.
 * Side-effect: updates last_used_at.
 */
export async function validateApiKey(authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const raw = authHeader.slice(7).trim()
  if (!raw) return null

  const hash = hashApiKey(raw)
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash))
  if (!key || key.revokedAt) return null

  // Update last_used_at asynchronously (don't block the request)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .run()

  return key
}
