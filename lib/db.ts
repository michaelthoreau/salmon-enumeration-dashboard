import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema'
import path from 'path'

const client = createClient({
  url: `file:${path.join(process.cwd(), 'data.db')}`,
})

export const db = drizzle(client, { schema })
