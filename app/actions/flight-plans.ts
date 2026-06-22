'use server'

import { db } from '@/lib/db'
import { flightPlans } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'

type State = { error?: string; success?: string } | null

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

export async function findOrCreateFlightPlan(
  projectId: string,
  name: string,
  displayName?: string,
): Promise<{ id: string; existed: boolean; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { id: '', existed: false, error: 'Unauthorized.' }
  }

  const slug = slugify(name)
  if (!slug) return { id: '', existed: false, error: 'Invalid name.' }

  const [existing] = await db
    .select()
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), eq(flightPlans.name, slug)))

  if (existing) return { id: existing.id, existed: true }

  const id = randomUUID()
  await db.insert(flightPlans).values({
    id,
    projectId,
    name: slug,
    displayName: displayName?.trim() || null,
    createdBy: session.userId,
    createdAt: new Date(),
    deletedAt: null,
  })

  revalidatePath(`/projects/${projectId}/flight-plans`)
  return { id, existed: false }
}

export async function createFlightPlan(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  const rawName = (formData.get('name') as string | null)?.trim() ?? ''
  const displayName = (formData.get('displayName') as string | null)?.trim() || null
  const description = (formData.get('description') as string | null)?.trim() || null
  const name = slugify(rawName)

  if (!projectId) return { error: 'Project is required.' }
  if (!name) return { error: 'Flight route name is required.' }

  const [existing] = await db
    .select()
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), eq(flightPlans.name, name)))

  if (existing) return { error: `A flight route named "${name}" already exists in this project.` }

  await db.insert(flightPlans).values({
    id: randomUUID(),
    projectId,
    name,
    displayName,
    description,
    createdBy: session.userId,
    createdAt: new Date(),
    deletedAt: null,
  })

  revalidatePath(`/projects/${projectId}/flight-plans`)
  revalidatePath(`/projects/${projectId}`)
  return { success: `Flight route "${displayName || name}" created.` }
}

export async function updateFlightPlan(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  const name = (formData.get('name') as string | null)?.trim() ?? ''
  const displayName = (formData.get('displayName') as string | null)?.trim() || null
  const description = (formData.get('description') as string | null)?.trim() || null

  if (!id) return { error: 'Flight route ID is required.' }
  if (!name) return { error: 'Name is required.' }

  await db.update(flightPlans).set({ name, displayName, description }).where(eq(flightPlans.id, id))

  revalidatePath(`/projects/${projectId}/flight-plans`)
  revalidatePath(`/projects/${projectId}`)
  return { success: 'Flight route updated.' }
}

export async function deleteFlightPlan(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  if (!id) return { error: 'Flight route ID is required.' }

  await db.update(flightPlans).set({ deletedAt: new Date() }).where(eq(flightPlans.id, id))

  revalidatePath(`/projects/${projectId}/flight-plans`)
  revalidatePath(`/projects/${projectId}`)
  return { success: 'Flight route deleted.' }
}

export async function restoreFlightPlan(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  const id = (formData.get('id') as string | null)?.trim() ?? ''
  const projectId = (formData.get('projectId') as string | null)?.trim() ?? ''
  if (!id) return { error: 'Flight route ID is required.' }

  await db.update(flightPlans).set({ deletedAt: null }).where(eq(flightPlans.id, id))
  revalidatePath(`/projects/${projectId}/flight-plans`)
  revalidatePath(`/projects/${projectId}`)
  return { success: 'Flight route restored.' }
}

export async function updateFlightPlanLocation(
  flightPlanId: string,
  locationJson: string | null
): Promise<{ error?: string; success?: string }> {
  const session = await getSession()
  if (!session || session.role === 'read') return { error: 'Unauthorized.' }

  await db
    .update(flightPlans)
    .set({ location: locationJson })
    .where(eq(flightPlans.id, flightPlanId))

  const [plan] = await db.select().from(flightPlans).where(eq(flightPlans.id, flightPlanId))
  if (plan) {
    revalidatePath(`/projects/${plan.projectId}`)
  }
  return { success: 'Flight route location updated.' }
}

export async function toggleFlightPlanDashboardVisibility(
  flightPlanId: string,
  showOnDashboard: boolean
): Promise<{ error?: string; success?: string }> {
  const session = await getSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized.' }

  await db
    .update(flightPlans)
    .set({ showOnDashboard })
    .where(eq(flightPlans.id, flightPlanId))

  const [plan] = await db.select().from(flightPlans).where(eq(flightPlans.id, flightPlanId))
  if (plan) {
    revalidatePath(`/projects/${plan.projectId}`)
  }
  return { success: 'Dashboard visibility updated.' }
}
