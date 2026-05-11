import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { projects } from '@/lib/schema'
import { isNull } from 'drizzle-orm'
import { desc } from 'drizzle-orm'

// GET /api/v1/projects
export async function GET(request: NextRequest) {
  const key = await validateApiKey(request.headers.get('authorization'))
  if (!key) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rows = await db.select().from(projects).where(isNull(projects.deletedAt)).orderBy(desc(projects.createdAt))
  return NextResponse.json(rows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    timezone: p.timezone,
  })))
}
