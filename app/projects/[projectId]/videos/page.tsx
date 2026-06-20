import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable } from '@/lib/schema'
import { eq, and, isNull, inArray, desc, sql } from 'drizzle-orm'
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

  const allFlights = await db
    .select()
    .from(flights)
    .where(and(
      inArray(flights.flightPlanId, planIds),
      isNull(flights.deletedAt),
    ))
    .orderBy(desc(flights.timestamp))

  if (allFlights.length === 0) {
    return (
      <VideosView
        projectId={projectId}
        timezone={project.timezone}
        videos={[]}
        canWrite={canWrite}
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
        size: f.size ?? 0,
        etag: f.etag,
        uploadedAt: f.uploadedAt.toISOString(),
        flightTimestamp: flight.timestamp.toISOString(),
        flightNotes: flight.notes,
        planName: plan.displayName || plan.name,
        flightId: flight.id,
        flightPlanId: flight.flightPlanId,
      }
    })
    .sort((a, b) => new Date(b.flightTimestamp).getTime() - new Date(a.flightTimestamp).getTime())

  return (
    <VideosView
      projectId={projectId}
      timezone={project.timezone}
      videos={videos}
      canWrite={canWrite}
    />
  )
}
