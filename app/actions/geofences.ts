'use server'

import { db } from '@/lib/db'
import { geofences, fileGeofenceTags, files, flights, flightPlans } from '@/lib/schema'
import { eq, and, isNull, inArray, isNotNull } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'

function pointInPolygon(lat: number, lng: number, polygon: number[][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export async function createGeofence(
  projectId: string,
  name: string,
  geometryJson: string,
  color: string,
): Promise<{ error?: string; id?: string }> {
  const session = await getSession()
  if (!session || session.role === 'read') return { error: 'Unauthorized.' }

  if (!name.trim()) return { error: 'Name is required.' }

  const id = randomUUID()
  await db.insert(geofences).values({
    id,
    projectId,
    name: name.trim(),
    geometry: geometryJson,
    color,
    createdBy: session.userId,
    createdAt: new Date(),
  })

  // Auto-tag files within the geofence
  const geom = JSON.parse(geometryJson)
  const ring: number[][] = geom.coordinates[0] // outer ring [lng, lat]

  const plans = await db
    .select({ id: flightPlans.id })
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), isNull(flightPlans.deletedAt)))

  if (plans.length > 0) {
    const planIds = plans.map((p) => p.id)
    const allFlights = await db
      .select({ id: flights.id })
      .from(flights)
      .where(and(inArray(flights.flightPlanId, planIds), isNull(flights.deletedAt)))

    if (allFlights.length > 0) {
      const flightIds = allFlights.map((f) => f.id)
      const allFiles = await db
        .select({ id: files.id, latitude: files.latitude, longitude: files.longitude })
        .from(files)
        .where(and(inArray(files.flightId, flightIds), isNotNull(files.latitude), isNotNull(files.longitude)))

      const tags = allFiles
        .filter((f) => f.latitude != null && f.longitude != null && pointInPolygon(f.latitude!, f.longitude!, ring))
        .map((f) => ({ fileId: f.id, geofenceId: id }))

      if (tags.length > 0) {
        await db.insert(fileGeofenceTags).values(tags)
      }
    }
  }

  revalidatePath(`/projects/${projectId}`)
  return { id }
}

export async function deleteGeofence(
  geofenceId: string,
  projectId: string,
): Promise<{ error?: string; success?: string }> {
  const session = await getSession()
  if (!session || session.role === 'read') return { error: 'Unauthorized.' }

  await db.delete(fileGeofenceTags).where(eq(fileGeofenceTags.geofenceId, geofenceId))
  await db.delete(geofences).where(eq(geofences.id, geofenceId))

  revalidatePath(`/projects/${projectId}`)
  return { success: 'Geofence deleted.' }
}

export async function retagGeofence(
  geofenceId: string,
  projectId: string,
): Promise<{ error?: string; tagged?: number }> {
  const session = await getSession()
  if (!session || session.role === 'read') return { error: 'Unauthorized.' }

  const [geofence] = await db.select().from(geofences).where(eq(geofences.id, geofenceId))
  if (!geofence) return { error: 'Geofence not found.' }

  const geom = JSON.parse(geofence.geometry)
  const ring: number[][] = geom.coordinates[0]

  // Clear existing tags
  await db.delete(fileGeofenceTags).where(eq(fileGeofenceTags.geofenceId, geofenceId))

  const plans = await db
    .select({ id: flightPlans.id })
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), isNull(flightPlans.deletedAt)))

  if (plans.length === 0) return { tagged: 0 }

  const planIds = plans.map((p) => p.id)
  const allFlights = await db
    .select({ id: flights.id })
    .from(flights)
    .where(and(inArray(flights.flightPlanId, planIds), isNull(flights.deletedAt)))

  if (allFlights.length === 0) return { tagged: 0 }

  const flightIds = allFlights.map((f) => f.id)
  const allFiles = await db
    .select({ id: files.id, latitude: files.latitude, longitude: files.longitude })
    .from(files)
    .where(and(inArray(files.flightId, flightIds), isNotNull(files.latitude), isNotNull(files.longitude)))

  const tags = allFiles
    .filter((f) => f.latitude != null && f.longitude != null && pointInPolygon(f.latitude!, f.longitude!, ring))
    .map((f) => ({ fileId: f.id, geofenceId }))

  if (tags.length > 0) {
    await db.insert(fileGeofenceTags).values(tags)
  }

  revalidatePath(`/projects/${projectId}`)
  return { tagged: tags.length }
}
