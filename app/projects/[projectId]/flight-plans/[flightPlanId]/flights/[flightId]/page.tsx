import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { flights, flightPlans, projects, files as filesTable, odmTasks } from '@/lib/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { listFlightObjects, createPresignedGetUrl } from '@/lib/s3'
import FlightSplitView from './flight-split-view'

interface PageProps {
  params: Promise<{ projectId: string; flightPlanId: string; flightId: string }>
}

function formatInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).format(date)
}

function toLocalInputValue(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

export default async function FlightDetailPage({ params }: PageProps) {
  const { projectId, flightPlanId, flightId } = await params
  const session = await getSession()
  const canWrite = session?.role === 'read-write' || session?.role === 'admin'

  const [flight] = await db.select().from(flights).where(eq(flights.id, flightId))
  if (!flight || flight.deletedAt) notFound()

  const [flightPlan] = await db.select().from(flightPlans).where(eq(flightPlans.id, flightPlanId))
  if (!flightPlan || flightPlan.deletedAt) notFound()

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  // S3 is source of truth for file listing
  let objects: { key: string; size: number; lastModified: Date; etag: string }[] = []
  try {
    objects = await listFlightObjects(projectId, flightPlanId, flightId)
  } catch {
    // S3 unavailable — show empty state, don't crash
  }

  const dbFiles = await db.select().from(filesTable).where(eq(filesTable.flightId, flightId))
  const splitByKeyMap = new Map(dbFiles.map(f => [f.key, f.split ?? null]))
  const splitByKey = Object.fromEntries(dbFiles.map(f => [f.key, f.split ?? null]))

  // Most recent ODM task for this flight (if any)
  const [latestOdmTask] = await db
    .select()
    .from(odmTasks)
    .where(eq(odmTasks.flightId, flightId))
    .orderBy(desc(odmTasks.createdAt))
    .limit(1)

  // Filter out any generated ODM outputs from the main file list
  const displayObjects = objects.filter((o) => !o.key.includes('/odm/'))

  // Find processed outputs in S3 list, fallback to db records if S3 fails
  const geotiffKey = objects.find((o) => o.key.includes('/odm/') && (o.key.endsWith('.tif') || o.key.endsWith('.tiff')))?.key || latestOdmTask?.outputKey
  const reportPdfKey = objects.find((o) => o.key.includes('/odm/') && o.key.endsWith('.pdf'))?.key || latestOdmTask?.reportKey

  let geotiffDownloadUrl = ''
  let reportPdfViewUrl = ''

  if (geotiffKey) {
    try {
      geotiffDownloadUrl = await createPresignedGetUrl(geotiffKey, 3600, 'attachment')
    } catch (err) {
      console.error('Failed to presign geotiff:', err)
    }
  }
  if (reportPdfKey) {
    try {
      reportPdfViewUrl = await createPresignedGetUrl(reportPdfKey, 3600, 'inline')
    } catch (err) {
      console.error('Failed to presign report pdf:', err)
    }
  }

  return (
    <FlightSplitView
      projectId={projectId}
      flightPlanId={flightPlanId}
      flightId={flightId}
      flight={flight}
      flightPlan={flightPlan}
      project={project}
      displayObjects={displayObjects.map((o) => ({
        key: o.key,
        size: o.size,
        lastModifiedIso: o.lastModified.toISOString(),
        etag: o.etag,
        split: splitByKey[o.key] ?? null,
      }))}
      geotiffKey={geotiffKey ?? null}
      reportPdfKey={reportPdfKey ?? null}
      geotiffDownloadUrl={geotiffDownloadUrl}
      reportPdfViewUrl={reportPdfViewUrl}
      latestOdmTask={latestOdmTask ?? null}
      splitByKey={splitByKey}
      canWrite={canWrite}
      formattedTime={formatInTz(flight.timestamp, project.timezone)}
      localTimestamp={toLocalInputValue(flight.timestamp, project.timezone)}
    />
  )
}
