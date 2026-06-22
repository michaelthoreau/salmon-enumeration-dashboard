import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable, geofences, fileGeofenceTags } from '@/lib/schema'
import { eq, and, isNull, inArray, desc, sql } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import MapView from './map-view'

interface PageProps {
  params: Promise<{ projectId: string }>
}

const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv'])
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif'])

function getFileType(key: string): 'video' | 'image' | null {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (IMAGE_EXTS.has(ext)) return 'image'
  return null
}

export default async function MapPage({ params }: PageProps) {
  const { projectId } = await params
  const session = await getSession()
  if (!session) notFound()
  const canWrite = session.role === 'read-write' || session.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  const allPlans = await db
    .select()
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), isNull(flightPlans.deletedAt)))

  const allGeofences = await db
    .select()
    .from(geofences)
    .where(eq(geofences.projectId, projectId))

  if (allPlans.length === 0) {
    return (
      <MapView
        projectId={projectId}
        timezone={project.timezone}
        routes={[]}
        geofences={allGeofences.map((g) => ({
          id: g.id,
          name: g.name,
          geometry: g.geometry,
          color: g.color,
        }))}
        canWrite={canWrite}
      />
    )
  }

  const planIds = allPlans.map((p) => p.id)

  const allFlights = await db
    .select()
    .from(flights)
    .where(and(inArray(flights.flightPlanId, planIds), isNull(flights.deletedAt)))
    .orderBy(desc(flights.timestamp))

  const flightIds = allFlights.map((f) => f.id)

  const allFiles = flightIds.length > 0
    ? await db.select().from(filesTable).where(inArray(filesTable.flightId, flightIds))
    : []

  // Build route data
  const routes = allPlans
    .filter((p) => p.location)
    .map((plan) => {
      const planFlights = allFlights.filter((f) => f.flightPlanId === plan.id)
      const planFlightIds = new Set(planFlights.map((f) => f.id))
      const planFiles = allFiles.filter((f) => planFlightIds.has(f.flightId))

      let imageCount = 0
      let videoCount = 0
      const thumbnails: { key: string; etag: string; fileId: string; flightId: string }[] = []

      for (const f of planFiles) {
        const type = getFileType(f.key)
        if (type === 'image') {
          imageCount++
          if (thumbnails.length < 4) {
            thumbnails.push({ key: f.key, etag: f.etag, fileId: f.id, flightId: f.flightId })
          }
        } else if (type === 'video') {
          videoCount++
        }
      }

      const flightDates = [...new Set(
        planFlights.map((f) =>
          f.timestamp.toLocaleDateString('en-US', {
            timeZone: project.timezone,
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        )
      )]

      const latestFlight = planFlights[0] ?? null

      return {
        id: plan.id,
        name: plan.displayName || plan.name,
        description: plan.description,
        location: plan.location!,
        imageCount,
        videoCount,
        flightCount: planFlights.length,
        flightDates,
        thumbnails,
        latestFlightId: latestFlight?.id ?? null,
        latestFlightTimestamp: latestFlight?.timestamp.toISOString() ?? null,
      }
    })

  return (
    <MapView
      projectId={projectId}
      timezone={project.timezone}
      routes={routes}
      geofences={allGeofences.map((g) => ({
        id: g.id,
        name: g.name,
        geometry: g.geometry,
        color: g.color,
      }))}
      canWrite={canWrite}
    />
  )
}
