'use server'

import { db } from '@/lib/db'
import { flights, flightPlans, files as filesTable, odmTasks, georefTasks, annotations, geofences, fileGeofenceTags } from '@/lib/schema'
import { eq, and, isNull, inArray, desc, sql, lt, gte } from 'drizzle-orm'
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

export async function createFlightForUpload(data: {
  flightPlanId: string
  timestamp: string
  timezone: string
  notes?: string
}): Promise<{ id: string; existed: boolean; error?: string }> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) {
    return { id: '', existed: false, error: 'Unauthorized.' }
  }

  const { flightPlanId, timestamp, timezone, notes } = data
  if (!flightPlanId || !timestamp) {
    return { id: '', existed: false, error: 'flightPlanId and timestamp are required.' }
  }

  // Deduplicate by notes (folder name)
  if (notes) {
    const [existing] = await db
      .select()
      .from(flights)
      .where(and(eq(flights.flightPlanId, flightPlanId), eq(flights.notes, notes)))
    if (existing) return { id: existing.id, existed: true }
  }

  const ts = parseInTimezone(timestamp, timezone || 'UTC')
  if (isNaN(ts.getTime())) return { id: '', existed: false, error: 'Invalid timestamp.' }

  const id = randomUUID()
  await db.insert(flights).values({
    id,
    flightPlanId,
    timestamp: ts,
    notes: notes?.trim() || null,
    createdBy: session.userId,
    createdAt: new Date(),
  })

  return { id, existed: false }
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

// Returns midnight UTC for the start of `dateStr` (YYYY-MM-DD) in the given timezone.
function localMidnightUTC(dateStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  // Start at noon UTC to avoid DST edge cases, then walk back to local midnight
  const noon = new Date(Date.UTC(y, m - 1, d, 12))
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(noon)
  const h = parseInt(parts.find((p) => p.type === 'hour')!.value)
  const mi = parseInt(parts.find((p) => p.type === 'minute')!.value)
  return new Date(noon.getTime() - (h * 60 + mi) * 60_000)
}

function getLocalDateStr(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}-${parts.find((p) => p.type === 'day')!.value}`
}

export interface FlightRow {
  id: string
  flightPlanId: string
  flightPlanName: string
  flightPlanLocation: string | null
  locationTags: { name: string; color: string }[]
  timestamp: Date
  notes: string | null
  fileCount: number
  totalFish: number
  taskStatus: 'uploading' | 'queued' | 'running' | 'failed' | 'completed' | 'canceled' | null
  outputKey: string | null
}

// Loads the next calendar day of flights (in project timezone) that falls before `beforeDate`.
// `beforeDate` is a YYYY-MM-DD string in the project timezone.
export async function loadFlightsBefore(
  projectId: string,
  beforeDate: string,
  timezone: string,
): Promise<{ flights: FlightRow[]; hasMore: boolean }> {
  const session = await getSession()
  if (!session) return { flights: [], hasMore: false }

  const beforeUTC = localMidnightUTC(beforeDate, timezone)

  const plans = await db
    .select()
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), isNull(flightPlans.deletedAt)))

  if (plans.length === 0) return { flights: [], hasMore: false }
  const planIds = plans.map((p) => p.id)

  // Load flights before the cutoff, newest first — take enough to cover at least one full day
  const batch = await db
    .select()
    .from(flights)
    .where(and(
      inArray(flights.flightPlanId, planIds),
      isNull(flights.deletedAt),
      eq(flights.lowPriority, false),
      lt(flights.timestamp, beforeUTC),
    ))
    .orderBy(desc(flights.timestamp))
    .limit(200)

  if (batch.length === 0) return { flights: [], hasMore: false }

  // Isolate the most recent calendar day in this batch
  const newestDay = getLocalDateStr(batch[0].timestamp, timezone)
  const dayStart = localMidnightUTC(newestDay, timezone)
  const dayFlights = batch.filter((f) => f.timestamp >= dayStart)
  const flightIds = dayFlights.map((f) => f.id)

  // Check if there are older flights beyond this day
  const hasMore = batch.length > dayFlights.length ||
    batch[batch.length - 1].timestamp < dayStart

  // Enrich with metadata (mirrors page.tsx)
  const [fileCounts, odmTaskRows, georefTaskRows, fishCountRows, allGeofences] = await Promise.all([
    db.select({ flightId: filesTable.flightId, count: sql<number>`count(*)`.as('count') })
      .from(filesTable).where(inArray(filesTable.flightId, flightIds)).groupBy(filesTable.flightId),
    db.select().from(odmTasks).where(inArray(odmTasks.flightId, flightIds)).orderBy(desc(odmTasks.createdAt)),
    db.select().from(georefTasks).where(inArray(georefTasks.flightId, flightIds)).orderBy(desc(georefTasks.createdAt)),
    db.select({ flightId: annotations.flightId, total: sql<number>`sum(fish_count)`.as('total') })
      .from(annotations).where(and(inArray(annotations.flightId, flightIds), isNull(annotations.deletedAt))).groupBy(annotations.flightId),
    db.select().from(geofences).where(eq(geofences.projectId, projectId)),
  ])

  const geofenceNameMap = new Map(allGeofences.map((g) => [g.id, g.name]))
  const flightLocationTags = new Map<string, string[]>()

  if (allGeofences.length > 0) {
    const allFiles = await db.select({ id: filesTable.id, flightId: filesTable.flightId })
      .from(filesTable).where(inArray(filesTable.flightId, flightIds))
    if (allFiles.length > 0) {
      const tags = await db.select().from(fileGeofenceTags)
        .where(inArray(fileGeofenceTags.fileId, allFiles.map((f) => f.id)))
      const fileToFlight = new Map(allFiles.map((f) => [f.id, f.flightId]))
      for (const tag of tags) {
        const fId = fileToFlight.get(tag.fileId)
        const gName = geofenceNameMap.get(tag.geofenceId)
        if (!fId || !gName) continue
        const existing = flightLocationTags.get(fId) ?? []
        if (!existing.includes(gName)) existing.push(gName)
        flightLocationTags.set(fId, existing)
      }
    }
  }

  const fileCountMap = new Map(fileCounts.map((r) => [r.flightId, r.count]))
  const fishCountMap = new Map(fishCountRows.map((r) => [r.flightId, r.total ?? 0]))
  const latestOdmMap = new Map<string, typeof odmTaskRows[number]>()
  for (const t of odmTaskRows) { if (!latestOdmMap.has(t.flightId)) latestOdmMap.set(t.flightId, t) }
  const latestGeorefMap = new Map<string, typeof georefTaskRows[number]>()
  for (const t of georefTaskRows) { if (!latestGeorefMap.has(t.flightId)) latestGeorefMap.set(t.flightId, t) }

  const rows: FlightRow[] = dayFlights.map((flight) => {
    const odm = latestOdmMap.get(flight.id)
    const georef = latestGeorefMap.get(flight.id)
    const task = odm && georef
      ? (new Date(odm.createdAt) > new Date(georef.createdAt) ? odm : georef)
      : odm ?? georef ?? null
    const plan = plans.find((p) => p.id === flight.flightPlanId)!
    return {
      id: flight.id,
      flightPlanId: flight.flightPlanId,
      flightPlanName: plan.displayName || plan.name,
      flightPlanLocation: plan.location,
      locationTags: (flightLocationTags.get(flight.id) ?? []).map((name) => {
        const g = allGeofences.find((gf) => gf.name === name)
        return { name, color: g?.color ?? '#6b7280' }
      }),
      timestamp: flight.timestamp,
      notes: flight.notes,
      fileCount: fileCountMap.get(flight.id) ?? 0,
      totalFish: fishCountMap.get(flight.id) ?? 0,
      taskStatus: (task?.status as FlightRow['taskStatus']) ?? null,
      outputKey: task?.outputKey ?? null,
    }
  })

  return { flights: rows, hasMore }
}
