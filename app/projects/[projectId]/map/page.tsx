import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable, geofences, fileGeofenceTags, annotations, odmTasks, georefTasks } from '@/lib/schema'
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

  // Find flights with a completed orthophoto (either ODM or georef pipeline)
  const [completedOdm, completedGeoref] = flightIds.length > 0
    ? await Promise.all([
        db.select({ flightId: odmTasks.flightId })
          .from(odmTasks)
          .where(and(inArray(odmTasks.flightId, flightIds), eq(odmTasks.status, 'completed'))),
        db.select({ flightId: georefTasks.flightId })
          .from(georefTasks)
          .where(and(inArray(georefTasks.flightId, flightIds), eq(georefTasks.status, 'completed'))),
      ])
    : [[], []]

  const orthoFlightIds = new Set([
    ...completedOdm.map((r) => r.flightId),
    ...completedGeoref.map((r) => r.flightId),
  ])

  const orthoFlightPlanIds = new Set(
    allFlights.filter((f) => orthoFlightIds.has(f.id)).map((f) => f.flightPlanId)
  )

  // Build route data — only flight plans with a completed ortho map
  const routes = allPlans
    .filter((plan) => {
      if (!orthoFlightPlanIds.has(plan.id)) return false
      if (plan.location) return true
      // Need a map location — derive from image files with coordinates
      const planFlights = allFlights.filter((f) => f.flightPlanId === plan.id)
      const planFlightIds = new Set(planFlights.map((f) => f.id))
      return allFiles.some((f) => planFlightIds.has(f.flightId) && f.latitude != null && f.longitude != null && getFileType(f.key) === 'image')
    })
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

      // Use plan location if set, otherwise derive from first image with coordinates
      let location = plan.location
      if (!location) {
        const firstWithCoords = planFiles.find((f) => f.latitude != null && f.longitude != null && getFileType(f.key) === 'image')
        if (firstWithCoords) {
          location = JSON.stringify({ type: 'Point', coordinates: [firstWithCoords.longitude, firstWithCoords.latitude] })
        }
      }

      return {
        id: plan.id,
        name: plan.displayName || plan.name,
        description: plan.description,
        location: location!,
        imageCount,
        videoCount,
        flightCount: planFlights.length,
        flightDates,
        thumbnails,
        latestFlightId: latestFlight?.id ?? null,
        latestFlightTimestamp: latestFlight?.timestamp.toISOString() ?? null,
      }
    })

  // Build individual file markers: only videos with coordinates
  // Images are represented by their route point, not individually
  const flightToPlan = new Map(allFlights.map((f) => [f.id, f.flightPlanId]))
  const flightTimestampMap = new Map(allFlights.map((f) => [f.id, f.timestamp.toISOString()]))
  const planNameMap = new Map(allPlans.map((p) => [p.id, p.displayName || p.name]))

  const videoFileIds = allFiles
    .filter((f) => f.latitude != null && f.longitude != null && getFileType(f.key) === 'video')
    .map((f) => f.id)

  // Fish counts from video-count annotations
  const fishCountMap = new Map<string, number>()
  if (videoFileIds.length > 0) {
    const fishAnnotations = await db
      .select({ fileId: annotations.fileId, fishCount: annotations.fishCount })
      .from(annotations)
      .where(and(inArray(annotations.fileId, videoFileIds), eq(annotations.label, 'video-count')))
    for (const a of fishAnnotations) {
      if (a.fileId) fishCountMap.set(a.fileId, (fishCountMap.get(a.fileId) ?? 0) + (a.fishCount ?? 0))
    }
  }

  // Geofence tags per file
  const geofenceTagsMap = new Map<string, string[]>()
  if (videoFileIds.length > 0) {
    const geofenceNameMap = new Map(allGeofences.map((g) => [g.id, g.name]))
    const tags = await db
      .select({ fileId: fileGeofenceTags.fileId, geofenceId: fileGeofenceTags.geofenceId })
      .from(fileGeofenceTags)
      .where(inArray(fileGeofenceTags.fileId, videoFileIds))
    for (const t of tags) {
      const name = geofenceNameMap.get(t.geofenceId)
      if (!name) continue
      if (!geofenceTagsMap.has(t.fileId)) geofenceTagsMap.set(t.fileId, [])
      geofenceTagsMap.get(t.fileId)!.push(name)
    }
  }

  const fileMarkers = allFiles
    .filter((f) => {
      if (f.latitude == null || f.longitude == null) return false
      return getFileType(f.key) === 'video'
    })
    .map((f) => {
      const planId = flightToPlan.get(f.flightId) ?? ''
      return {
        fileId: f.id,
        key: f.key,
        etag: f.etag,
        latitude: f.latitude!,
        longitude: f.longitude!,
        type: getFileType(f.key)! as 'video' | 'image',
        planName: planNameMap.get(planId) ?? '',
        flightId: f.flightId,
        flightPlanId: planId,
        filename: f.key.split('/').pop() ?? f.key,
        flightTimestamp: flightTimestampMap.get(f.flightId) ?? null,
        fishCount: fishCountMap.get(f.id) ?? 0,
        geofenceTags: geofenceTagsMap.get(f.id) ?? [],
        durationSeconds: f.durationSeconds ?? null,
      }
    })

  return (
    <MapView
      projectId={projectId}
      timezone={project.timezone}
      routes={routes}
      fileMarkers={fileMarkers}
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
