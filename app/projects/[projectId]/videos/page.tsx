import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable } from '@/lib/schema'
import { eq, and, isNull, like, inArray, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import VideosView from './videos-view'

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function VideosPage({ params }: PageProps) {
  const { projectId } = await params
  const session = await getSession()
  if (!session) notFound()
  const canWrite = session.role === 'read-write' || session.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  const videoPlans = await db
    .select()
    .from(flightPlans)
    .where(and(
      eq(flightPlans.projectId, projectId),
      like(flightPlans.name, '%-videos'),
      isNull(flightPlans.deletedAt),
    ))

  if (videoPlans.length === 0) {
    return (
      <VideosView
        projectId={projectId}
        timezone={project.timezone}
        videos={[]}
        canWrite={canWrite}
      />
    )
  }

  const planIds = videoPlans.map((p) => p.id)

  const videoFlights = await db
    .select()
    .from(flights)
    .where(and(
      inArray(flights.flightPlanId, planIds),
      isNull(flights.deletedAt),
    ))
    .orderBy(desc(flights.timestamp))

  if (videoFlights.length === 0) {
    return (
      <VideosView
        projectId={projectId}
        timezone={project.timezone}
        videos={[]}
        canWrite={canWrite}
      />
    )
  }

  const flightIds = videoFlights.map((f) => f.id)

  const videoFiles = await db
    .select()
    .from(filesTable)
    .where(inArray(filesTable.flightId, flightIds))

  const flightMap = new Map(videoFlights.map((f) => [f.id, f]))
  const planMap = new Map(videoPlans.map((p) => [p.id, p]))

  const videos = videoFiles
    .filter((f) => {
      const ext = f.key.split('.').pop()?.toLowerCase() ?? ''
      return ['mp4', 'mov', 'avi', 'mkv'].includes(ext)
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
