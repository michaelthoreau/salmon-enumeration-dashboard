import { notFound } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import { flights, flightPlans, projects, files as filesTable, odmTasks } from '@/lib/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { listFlightObjects } from '@/lib/s3'
import FlightUploader from './flight-uploader'
import FileLightbox from './file-lightbox'
import EditFlightButton from './edit-flight-button'
import OdmPanel from './odm-panel'
import OrthoMap from './ortho-map'

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
  const splitByKey = new Map(dbFiles.map(f => [f.key, f.split ?? null]))

  // Most recent ODM task for this flight (if any)
  const [latestOdmTask] = await db
    .select()
    .from(odmTasks)
    .where(eq(odmTasks.flightId, flightId))
    .orderBy(desc(odmTasks.createdAt))
    .limit(1)

  return (
    <div className="space-y-8">
      <div>
        <Link href={`/projects/${projectId}/flight-plans/${flightPlanId}/flights`} className="text-sm text-gray-500 hover:text-gray-900 flex items-center gap-1 mb-4">← {flightPlan.name}</Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              {formatInTz(flight.timestamp, project.timezone)}
            </h1>
            <p className="text-xs text-gray-400 mt-1 font-mono">{flight.timestamp.toISOString()} · {project.timezone}</p>
            {flight.notes && <p className="text-gray-500 mt-1">{flight.notes}</p>}
          </div>
          {canWrite && (
            <EditFlightButton
              flightId={flightId}
              projectId={projectId}
              flightPlanId={flightPlanId}
              timezone={project.timezone}
              localTimestamp={toLocalInputValue(flight.timestamp, project.timezone)}
              currentNotes={flight.notes}
            />
          )}
        </div>
      </div>

      {canWrite && (
        <section>
          <FlightUploader flightId={flightId} defaultOpen={objects.length === 0} />
        </section>
      )}

      {latestOdmTask?.status === 'completed' && latestOdmTask.outputKey && (
        <OrthoMap outputKey={latestOdmTask.outputKey} />
      )}

      {canWrite && (
        <OdmPanel
          flightId={flightId}
          projectId={projectId}
          flightPlanId={flightPlanId}
          initialTask={
            latestOdmTask
              ? {
                  taskId: latestOdmTask.id,
                  odmUuid: latestOdmTask.odmUuid,
                  status: latestOdmTask.status,
                  outputKey: latestOdmTask.outputKey ?? null,
                  reportKey: latestOdmTask.reportKey ?? null,
                }
              : null
          }
        />
      )}

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          Files in S3{' '}
          <span className="text-sm font-normal text-gray-500">
            ({objects.length} file{objects.length !== 1 ? 's' : ''})
          </span>
        </h2>
        <p className="text-xs text-gray-400 mb-4 font-mono">
          {projectId}/{flightPlanId}/{flightId}/
        </p>

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {objects.length === 0 ? (
            <p className="text-sm text-gray-500 p-6">No files uploaded yet.</p>
          ) : (
            <FileLightbox
              files={objects.map((o) => ({
                key: o.key,
                size: o.size,
                lastModifiedIso: o.lastModified.toISOString(),
                etag: o.etag,
                split: splitByKey.get(o.key) ?? null,
              }))}
              timezone={project.timezone}
              canWrite={canWrite}
            />
          )}
        </div>
      </section>
    </div>
  )
}
