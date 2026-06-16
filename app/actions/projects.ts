'use server'

import { db } from '@/lib/db'
import { projects, flights, flightPlans } from '@/lib/schema'
import { eq, isNull, and, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { syncActiveTasks } from '@/lib/tasks-sync'
import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'

type State = { error?: string; success?: string } | null

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

export async function createProject(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const rawName = (formData.get('name') as string | null)?.trim() ?? ''
  const description = (formData.get('description') as string | null)?.trim() || null
  const timezone = (formData.get('timezone') as string | null)?.trim() || 'UTC'
  const name = slugify(rawName)

  if (!name) return { error: 'Project name is required.' }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone })
  } catch {
    return { error: 'Invalid timezone.' }
  }

  const [existing] = await db.select().from(projects).where(eq(projects.name, name))
  if (existing) return { error: `A project named "${name}" already exists.` }

  await db.insert(projects).values({
    id: randomUUID(),
    name,
    description,
    timezone,
    createdBy: session.userId,
    createdAt: new Date(),
    deletedAt: null,
  })

  revalidatePath('/')
  return { success: `Project "${name}" created.` }
}

export async function updateProject(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  const rawName = (formData.get('name') as string | null)?.trim() ?? ''
  const description = (formData.get('description') as string | null)?.trim() || null
  const timezone = (formData.get('timezone') as string | null)?.trim() || null

  if (!id) return { error: 'Project ID is required.' }
  if (!rawName) return { error: 'Project name is required.' }

  const name = slugify(rawName)
  if (!name) return { error: 'Invalid project name.' }

  const [existing] = await db.select().from(projects).where(eq(projects.name, name))
  if (existing && existing.id !== id) {
    return { error: `A project named "${name}" already exists.` }
  }

  const patch: { name: string; description: string | null; timezone?: string } = {
    name,
    description,
  }

  if (timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone })
      patch.timezone = timezone
    } catch {
      return { error: 'Invalid timezone.' }
    }
  }

  await db.update(projects).set(patch).where(eq(projects.id, id))

  revalidatePath('/')
  revalidatePath(`/projects/${id}`)
  return { success: 'Project updated.' }
}

export async function deleteProject(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  if (!id) return { error: 'Project ID is required.' }

  await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, id))

  revalidatePath('/')
  revalidatePath(`/projects/${id}`)
  return { success: 'Project deleted.' }
}

export async function restoreProject(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  if (!id) return { error: 'Project ID is required.' }

  await db.update(projects).set({ deletedAt: null }).where(eq(projects.id, id))
  
  revalidatePath('/')
  revalidatePath(`/projects/${id}`)
  return { success: 'Project restored.' }
}

export async function highlightFlight(
  projectId: string,
  flightId: string | null
): Promise<{ error?: string; success?: string }> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  await db
    .update(projects)
    .set({ highlightedFlightId: flightId })
    .where(eq(projects.id, projectId))

  revalidatePath(`/projects/${projectId}`)
  return { success: flightId ? 'Flight highlighted.' : 'Flight highlight cleared.' }
}

export async function syncProjectActiveTasks(
  projectId: string
): Promise<{ success: boolean; error?: string }> {
  const session = await getSession()
  if (!session) return { error: 'Unauthorized.', success: false }

  try {
    const activePlans = await db
      .select({ id: flightPlans.id })
      .from(flightPlans)
      .where(and(eq(flightPlans.projectId, projectId), isNull(flightPlans.deletedAt)))

    if (activePlans.length === 0) return { success: true }
    const planIds = activePlans.map((p) => p.id)

    const activeFlights = await db
      .select({ id: flights.id })
      .from(flights)
      .where(and(inArray(flights.flightPlanId, planIds), isNull(flights.deletedAt)))

    if (activeFlights.length === 0) return { success: true }
    const flightIds = activeFlights.map((f) => f.id)

    await syncActiveTasks(flightIds)

    revalidatePath(`/projects/${projectId}`)
    revalidatePath(`/projects/${projectId}`, 'layout')
    return { success: true }
  } catch (err) {
    console.error('[syncProjectActiveTasks] Failed to sync project tasks:', err)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}


