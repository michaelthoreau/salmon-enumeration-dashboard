import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable, annotations, geofences, fileGeofenceTags } from '@/lib/schema'
import { eq, and, isNull, inArray, desc, sql, gte, lt } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import VideosView from './videos-view'

interface PageProps {
  params: Promise<{ projectId: string }>
}

const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv']

export default async function VideosPage({ params }: PageProps) {
  const { projectId } = await params
  const session = await getSession()
  if (!session) notFound()
  const canWrite = session.role === 'read-write' || session.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  const allPlans = await db
    .select()
    .from(flightPlans)
    .where(and(
      eq(flightPlans.projectId, projectId),
      isNull(flightPlans.deletedAt),
    ))

  if (allPlans.length === 0) {
    return (
      <VideosView
        projectId={projectId}
        timezone={project.timezone}
        videos={[]}
        canWrite={canWrite}
      />
    )
  }

  const planIds = allPlans.map((p) => p.id)
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000)

  const allFlights = await db
    .select()
    .from(flights)
    .where(and(
      inArray(flights.flightPlanId, planIds),
      isNull(flights.deletedAt),
      gte(flights.timestamp, cutoff),
    ))
    .orderBy(desc(flights.timestamp))

  const [olderCheck] = await db
    .select({ count: sql<number>`count(*)`.as('count') })
    .from(flights)
    .where(and(
      inArray(flights.flightPlanId, planIds),
      isNull(flights.deletedAt),
      lt(flights.timestamp, cutoff),
    ))
  const hasMore = (olderCheck?.count ?? 0) > 0

  // All-time flight IDs for accurate queue count (no date filter)
  const allFlightIds = planIds.length > 0
    ? (await db.select({ id: flights.id }).from(flights)
        .where(and(inArray(flights.flightPlanId, planIds), isNull(flights.deletedAt)))).map((r) => r.id)
    : []

  const [totalQueueRow] = allFlightIds.length > 0
    ? await db.select({ count: sql<number>`count(*)`.as('count') })
        .from(filesTable)
        .where(and(
          inArray(filesTable.flightId, allFlightIds),
          inArray(filesTable.reviewStatus, ['not_reviewed', 'in_review']),
          sql`(lower(${filesTable.key}) like '%.mp4' or lower(${filesTable.key}) like '%.mov' or lower(${filesTable.key}) like '%.avi' or lower(${filesTable.key}) like '%.mkv')`,
        ))
    : [{ count: 0 }]
  const totalQueueCount = totalQueueRow?.count ?? 0

  if (allFlights.length === 0) {
    return (
      <VideosView
        projectId={projectId}
        timezone={project.timezone}
        videos={[]}
        canWrite={canWrite}
        hasMore={hasMore}
        totalQueueCount={totalQueueCount}
      />
    )
  }

  const flightIds = allFlights.map((f) => f.id)

  const allFiles = await db
    .select()
    .from(filesTable)
    .where(inArray(filesTable.flightId, flightIds))

  const flightMap = new Map(allFlights.map((f) => [f.id, f]))
  const planMap = new Map(allPlans.map((p) => [p.id, p]))

  // Fetch video annotations (fish counts and notes)
  const videoFileIds = allFiles
    .filter((f) => VIDEO_EXTS.includes(f.key.split('.').pop()?.toLowerCase() ?? ''))
    .map((f) => f.id)

  const videoAnnotations = videoFileIds.length > 0
    ? await db
        .select()
        .from(annotations)
        .where(and(
          inArray(annotations.fileId, videoFileIds),
          isNull(annotations.deletedAt),
        ))
    : []

  const fishCountMap = new Map<string, number>()
  for (const a of videoAnnotations) {
    if (!a.fileId) continue
    if (a.label === 'video-count') {
      fishCountMap.set(a.fileId, a.fishCount)
    }
  }

  // Fetch geofence tags for video files
  const allGeofences = await db
    .select()
    .from(geofences)
    .where(eq(geofences.projectId, projectId))

  const allTags = videoFileIds.length > 0
    ? await db
        .select()
        .from(fileGeofenceTags)
        .where(inArray(fileGeofenceTags.fileId, videoFileIds))
    : []

  const tagsByFileId = new Map<string, { name: string; color: string }[]>()
  const geofenceMap = new Map(allGeofences.map((g) => [g.id, g]))
  for (const tag of allTags) {
    const g = geofenceMap.get(tag.geofenceId)
    if (!g) continue
    if (!tagsByFileId.has(tag.fileId)) tagsByFileId.set(tag.fileId, [])
    const tags = tagsByFileId.get(tag.fileId)!
    if (!tags.find((t) => t.name === g.name)) tags.push({ name: g.name, color: g.color })
  }

  const videos = allFiles
    .filter((f) => {
      const ext = f.key.split('.').pop()?.toLowerCase() ?? ''
      return VIDEO_EXTS.includes(ext)
    })
    .map((f) => {
      const flight = flightMap.get(f.flightId)!
      const plan = planMap.get(flight.flightPlanId)!
      return {
        fileId: f.id,
        key: f.key,
        etag: f.etag,
        uploadedAt: f.uploadedAt.toISOString(),
        flightTimestamp: flight.timestamp.toISOString(),
        flightNotes: flight.notes,
        planName: plan.displayName || plan.name,
        flightId: flight.id,
        flightPlanId: flight.flightPlanId,
        fishCount: fishCountMap.has(f.id) ? fishCountMap.get(f.id)! : null,
        durationSeconds: f.durationSeconds ?? null,
        locationTags: tagsByFileId.get(f.id) ?? [],
        latitude: f.latitude ?? null,
        longitude: f.longitude ?? null,
        reviewStatus: f.reviewStatus,
        reviewRating: f.reviewRating ?? null,
        reviewedBy: f.reviewedBy ?? null,
        reviewedAt: f.reviewedAt?.toISOString() ?? null,
        hidden: f.hidden ?? false,
      }
    })
    .sort((a, b) => new Date(b.flightTimestamp).getTime() - new Date(a.flightTimestamp).getTime())

  const availableTags = [...new Set(allGeofences.map((g) => g.name))].sort()

  const geofenceData = allGeofences.map((g) => ({
    id: g.id,
    name: g.name,
    geometry: g.geometry,
    color: g.color,
  }))

  return (
    <VideosView
      projectId={projectId}
      timezone={project.timezone}
      videos={videos}
      canWrite={canWrite}
      currentUserEmail={session.email}
      availableLocationTags={availableTags}
      geofences={geofenceData}
      hasMore={hasMore}
      totalQueueCount={totalQueueCount}
    />
  )
}
