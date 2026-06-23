import { db } from '@/lib/db'
import { geofences, fileGeofenceTags, flightPlans, flights } from '@/lib/schema'
import { eq, and, isNull, inArray } from 'drizzle-orm'

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

export async function tagFilesAgainstGeofences(
  projectId: string,
  newFiles: { id: string; latitude: number | null; longitude: number | null }[],
) {
  const filesWithCoords = newFiles.filter((f) => f.latitude != null && f.longitude != null)
  if (filesWithCoords.length === 0) return

  const allGeofences = await db
    .select()
    .from(geofences)
    .where(eq(geofences.projectId, projectId))

  if (allGeofences.length === 0) return

  const fileIds = filesWithCoords.map((f) => f.id)
  const existingTags = await db
    .select()
    .from(fileGeofenceTags)
    .where(inArray(fileGeofenceTags.fileId, fileIds))

  const existingSet = new Set(existingTags.map((t) => `${t.fileId}:${t.geofenceId}`))

  const tags: { fileId: string; geofenceId: string }[] = []
  for (const g of allGeofences) {
    try {
      const geom = JSON.parse(g.geometry)
      const ring: number[][] = geom.coordinates[0]
      for (const f of filesWithCoords) {
        const key = `${f.id}:${g.id}`
        if (!existingSet.has(key) && pointInPolygon(f.latitude!, f.longitude!, ring)) {
          tags.push({ fileId: f.id, geofenceId: g.id })
        }
      }
    } catch { /* skip malformed geofences */ }
  }

  if (tags.length > 0) {
    await db.insert(fileGeofenceTags).values(tags)
  }
}

export async function getProjectIdForFlight(flightId: string): Promise<string | null> {
  const [flight] = await db
    .select({ flightPlanId: flights.flightPlanId })
    .from(flights)
    .where(eq(flights.id, flightId))

  if (!flight) return null

  const [plan] = await db
    .select({ projectId: flightPlans.projectId })
    .from(flightPlans)
    .where(eq(flightPlans.id, flight.flightPlanId))

  return plan?.projectId ?? null
}
