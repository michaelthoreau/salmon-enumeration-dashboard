import { createHash, randomInt } from 'crypto'
import { randomUUID } from 'crypto'
import { db } from './db'
import { otps } from './schema'
import { eq, and, gt, isNull } from 'drizzle-orm'

const OTP_TTL_MS = 10 * 60 * 1000 // 10 minutes

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export async function createOtp(email: string): Promise<string> {
  const code = String(randomInt(100000, 999999))
  const now = new Date()
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS)

  await db.insert(otps).values({
    id: randomUUID(),
    email,
    codeHash: hashCode(code),
    expiresAt,
    usedAt: null,
    createdAt: now,
  })

  return code
}

export async function verifyOtp(email: string, code: string): Promise<boolean> {
  const now = new Date()
  const codeHash = hashCode(code)

  const results = await db
    .select()
    .from(otps)
    .where(
      and(
        eq(otps.email, email),
        eq(otps.codeHash, codeHash),
        gt(otps.expiresAt, now),
        isNull(otps.usedAt),
      ),
    )

  const otp = results[0]
  if (!otp) return false

  await db.update(otps).set({ usedAt: now }).where(eq(otps.id, otp.id))

  return true
}
