/**
 * Bootstraps the database schema and optionally seeds the first admin user.
 *
 * Usage:
 *   pnpm db:push              — push schema to data.db
 *   pnpm db:seed <email>      — create the first admin user directly (no invite needed)
 *
 * Example:
 *   pnpm db:seed admin@example.com
 */

import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { users } from '../lib/schema.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import path from 'path'

const client = createClient({ url: `file:${path.join(process.cwd(), 'data.db')}` })
const db = drizzle(client)

const email = process.argv[2]?.toLowerCase().trim()

if (!email) {
  console.log('Usage: pnpm db:seed <admin-email>')
  console.log('Example: pnpm db:seed admin@yourcompany.com')
  process.exit(0)
}

const [existing] = await db.select().from(users).where(eq(users.email, email))

if (existing) {
  console.log(`User ${email} already exists with role: ${existing.role}`)
  process.exit(0)
}

await db.insert(users).values({
  id: randomUUID(),
  email,
  role: 'admin',
  createdAt: new Date(),
})

console.log(`✓ Admin user created: ${email}`)
console.log(`  They can now sign in at /login and access /admin`)
client.close()
