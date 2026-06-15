import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { flightPlans, projects } from '@/lib/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { randomUUID } from 'crypto'

// POST /api/v1/flight-plans
// Body: { projectId, name, displayName?, description? }
export async function POST(request: NextRequest) {
  const key = await validateApiKey(request.headers.get('authorization'))
  if (!key) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { projectId: string; name: string; displayName?: string; description?: string }
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { projectId, name, displayName, description } = body
  if (!projectId || !name) {
    return NextResponse.json({ error: 'projectId and name are required' }, { status: 400 })
  }

  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const slugged = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  if (!slugged) return NextResponse.json({ error: 'Invalid name' }, { status: 400 })

  const id = randomUUID()
  await db.insert(flightPlans).values({
    id,
    projectId,
    name: slugged,
    displayName: displayName?.trim() || null,
    description: description?.trim() || null,
    createdBy: `api:${key.id}`,
    createdAt: new Date(),
  })

  return NextResponse.json({ id, name: slugged, displayName: displayName?.trim() || null }, { status: 201 })
}

// GET /api/v1/flight-plans?projectId=
export async function GET(request: NextRequest) {
  const key = await validateApiKey(request.headers.get('authorization'))
  if (!key) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const projectId = request.nextUrl.searchParams.get('projectId')
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })

  const plans = await db.select().from(flightPlans).where(and(eq(flightPlans.projectId, projectId), isNull(flightPlans.deletedAt)))
  return NextResponse.json(plans.map((p) => ({ id: p.id, name: p.name, displayName: p.displayName, description: p.description, createdAt: p.createdAt })))
}
