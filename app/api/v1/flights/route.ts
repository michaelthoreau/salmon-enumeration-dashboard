import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { flights, flightPlans, projects } from '@/lib/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { randomUUID } from 'crypto'

function parseInTimezone(localStr: string, tz: string): Date {
  const [datePart, timePart] = localStr.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = (timePart ?? '00:00').split(':').map(Number)
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute))
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcGuess)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const tzWallClock = new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`)
  return new Date(utcGuess.getTime() + (utcGuess.getTime() - tzWallClock.getTime()))
}

// POST /api/v1/flights
// Body: { flightPlanId, timestamp (YYYY-MM-DDTHH:mm in project timezone), notes? }
export async function POST(request: NextRequest) {
  const key = await validateApiKey(request.headers.get('authorization'))
  if (!key) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { flightPlanId: string; timestamp: string; notes?: string }
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { flightPlanId, timestamp, notes } = body
  if (!flightPlanId || !timestamp) {
    return NextResponse.json({ error: 'flightPlanId and timestamp are required' }, { status: 400 })
  }

  const [plan] = await db.select().from(flightPlans).where(and(eq(flightPlans.id, flightPlanId), isNull(flightPlans.deletedAt)))
  if (!plan) return NextResponse.json({ error: 'Flight plan not found' }, { status: 404 })

  const [project] = await db.select().from(projects).where(and(eq(projects.id, plan.projectId), isNull(projects.deletedAt)))
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let ts: Date
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timestamp)) {
    ts = parseInTimezone(timestamp, project.timezone)
  } else {
    ts = new Date(timestamp)
  }
  if (isNaN(ts.getTime())) return NextResponse.json({ error: 'Invalid timestamp' }, { status: 400 })

  const id = randomUUID()
  await db.insert(flights).values({
    id,
    flightPlanId,
    timestamp: ts,
    notes: notes?.trim() || null,
    createdBy: `api:${key.id}`,
    createdAt: new Date(),
  })

  return NextResponse.json({ id, timestamp: ts.toISOString() }, { status: 201 })
}

// GET /api/v1/flights?flightPlanId=
export async function GET(request: NextRequest) {
  const key = await validateApiKey(request.headers.get('authorization'))
  if (!key) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const flightPlanId = request.nextUrl.searchParams.get('flightPlanId')
  if (!flightPlanId) return NextResponse.json({ error: 'flightPlanId is required' }, { status: 400 })

  const rows = await db.select().from(flights).where(and(eq(flights.flightPlanId, flightPlanId), isNull(flights.deletedAt)))
  return NextResponse.json(rows.map((f) => ({ id: f.id, timestamp: f.timestamp, notes: f.notes })))
}
