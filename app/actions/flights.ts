'use server'

import { db } from '@/lib/db'
import { flights, flightPlans } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'

type State = { error?: string; success?: string; flightId?: string; flightPlanId?: string } | null

/**
 * Interprets a "YYYY-MM-DDTHH:mm" datetime-local string as wall-clock time
 * in the given IANA timezone and returns the corresponding UTC Date.
 */
function parseInTimezone(localStr: string, tz: string): Date {
  const [datePart, timePart] = localStr.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = (timePart ?? '00:00').split(':').map(Number)

  // Treat the input as if it were UTC to get an approximate instant
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute))

  // Find what local time that UTC instant corresponds to in the target tz
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcGuess)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  // Append 'Z' so Date.parse treats it as UTC, not server-local time
  const tzWallClock = new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`)

  // Shift utcGuess by the difference to land on the correct UTC instant
  const offset = utcGuess.getTime() - tzWallClock.getTime()
  return new Date(utcGuess.getTime() + offset)
}

function canWrite(role: string): boolean {
  return role === 'read-write' || role === 'admin'
}

export async function createFlight(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) return { error: 'Unauthorized.' }

  const flightPlanId = (formData.get('flightPlanId') as string | null)?.trim() ?? ''
  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  const timestampRaw = formData.get('timestamp') as string | null
  const timezone = (formData.get('timezone') as string | null)?.trim() || 'UTC'
  const notes = (formData.get('notes') as string | null)?.trim() || null

  if (!flightPlanId) return { error: 'Flight route is required.' }
  if (!timestampRaw) return { error: 'Flight timestamp is required.' }

  // datetime-local gives wall-clock time; interpret it in the project timezone
  const timestamp = parseInTimezone(timestampRaw, timezone)
  if (isNaN(timestamp.getTime())) return { error: 'Invalid timestamp.' }

  const newFlightId = randomUUID()
  await db.insert(flights).values({
    id: newFlightId,
    flightPlanId,
    timestamp,
    notes,
    createdBy: session.userId,
    createdAt: new Date(),
    deletedAt: null,
  })

  revalidatePath(`/projects/${projectId}/flight-plans/${flightPlanId}/flights`)
  return { success: 'Flight created.', flightId: newFlightId, flightPlanId }
}

export async function updateFlight(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  const flightPlanId = (formData.get('flightPlanId') as string | null)?.trim() ?? ''
  const timestampRaw = formData.get('timestamp') as string | null
  const timezone = (formData.get('timezone') as string | null)?.trim() || 'UTC'
  const notes = (formData.get('notes') as string | null)?.trim() || null

  if (!id) return { error: 'Flight ID is required.' }
  if (!timestampRaw) return { error: 'Timestamp is required.' }

  const timestamp = parseInTimezone(timestampRaw, timezone)
  if (isNaN(timestamp.getTime())) return { error: 'Invalid timestamp.' }

  await db.update(flights).set({ timestamp, notes }).where(eq(flights.id, id))

  revalidatePath(`/projects/${projectId}/flight-plans/${flightPlanId}/flights`)
  revalidatePath(`/projects/${projectId}/flight-plans/${flightPlanId}/flights/${id}`)
  return { success: 'Flight updated.' }
}

export async function deleteFlight(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  const flightPlanId = (formData.get('flightPlanId') as string | null)?.trim() ?? ''

  if (!id) return { error: 'Flight ID is required.' }

  await db.update(flights).set({ deletedAt: new Date() }).where(eq(flights.id, id))

  revalidatePath(`/projects/${projectId}/flight-plans/${flightPlanId}/flights`)
  revalidatePath(`/projects/${projectId}`)
  return { success: 'Flight deleted.' }
}

export async function restoreFlight(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  const flightPlanId = (formData.get('flightPlanId') as string | null)?.trim() ?? ''

  if (!id) return { error: 'Flight ID is required.' }

  await db.update(flights).set({ deletedAt: null }).where(eq(flights.id, id))

  revalidatePath(`/projects/${projectId}/flight-plans/${flightPlanId}/flights`)
  revalidatePath(`/projects/${projectId}`)
  return { success: 'Flight restored.' }
}

export async function setFlightPriority(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  const flightPlanId = (formData.get('flightPlanId') as string | null)?.trim() ?? ''
  const lowPriority = formData.get('lowPriority') === 'true'

  if (!id) return { error: 'Flight ID is required.' }

  await db.update(flights).set({ lowPriority }).where(eq(flights.id, id))

  revalidatePath(`/projects/${projectId}/flight-plans/${flightPlanId}/flights`)
  revalidatePath(`/projects/${projectId}`)
  return { success: 'Flight priority updated.' }
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

export async function logFlightWithRoute(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) return { error: 'Unauthorized.' }

  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  let flightPlanId = (formData.get('flightPlanId') as string | null)?.trim() ?? ''
  const isNewRoute = formData.get('isNewRoute') === 'true'
  const newRouteName = (formData.get('newRouteName') as string | null)?.trim() ?? ''
  const timestampRaw = formData.get('timestamp') as string | null
  const timezone = (formData.get('timezone') as string | null)?.trim() || 'UTC'
  const notes = (formData.get('notes') as string | null)?.trim() || null

  if (!timestampRaw) return { error: 'Flight timestamp is required.' }

  if (isNewRoute) {
    if (!newRouteName) return { error: 'New route name is required.' }
    const nameSlug = slugify(newRouteName)
    if (!nameSlug) return { error: 'Invalid route name.' }

    // Check if flight route already exists in this project
    const [existing] = await db
      .select()
      .from(flightPlans)
      .where(and(eq(flightPlans.projectId, projectId), eq(flightPlans.name, nameSlug)))

    if (existing) {
      return { error: `A flight route named "${newRouteName}" already exists in this project.` }
    }

    // Create the new route (flight plan)
    const newPlanId = randomUUID()
    await db.insert(flightPlans).values({
      id: newPlanId,
      projectId,
      name: nameSlug,
      displayName: newRouteName,
      createdBy: session.userId,
      createdAt: new Date(),
      deletedAt: null,
    })
    flightPlanId = newPlanId
  }

  if (!flightPlanId) return { error: 'Flight route is required.' }

  const timestamp = parseInTimezone(timestampRaw, timezone)
  if (isNaN(timestamp.getTime())) return { error: 'Invalid timestamp.' }

  const newFlightId = randomUUID()
  await db.insert(flights).values({
    id: newFlightId,
    flightPlanId,
    timestamp,
    notes,
    createdBy: session.userId,
    createdAt: new Date(),
    deletedAt: null,
  })

  revalidatePath(`/projects/${projectId}`)
  revalidatePath(`/projects/${projectId}/flight-plans/${flightPlanId}/flights`)
  return { success: 'Flight logged successfully.', flightId: newFlightId, flightPlanId }
}
