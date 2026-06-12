import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files, labelingTasks } from '@/lib/schema'
import { eq, desc, count, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import DatasetView from './dataset-view'

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function DatasetPage({ params }: PageProps) {
  const { projectId } = await params
  const session = await getSession()
  const canWrite = session?.role === 'read-write' || session?.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  const rows = await db
    .select({
      fileId: files.id,
      key: files.key,
      etag: files.etag,
      split: files.split,
      uploadedAt: files.uploadedAt,
      imageWidth: files.imageWidth,
      imageHeight: files.imageHeight,
      size: files.size,
      flightId: flights.id,
      flightTimestamp: flights.timestamp,
      flightPlanName: flightPlans.name,
    })
    .from(files)
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .where(eq(flightPlans.projectId, projectId))
    .orderBy(desc(files.uploadedAt))

  const entries = rows.map(r => ({
    ...r,
    split: r.split ?? null,
    imageWidth: r.imageWidth ?? null,
    imageHeight: r.imageHeight ?? null,
    size: r.size ?? null,
    flightTimestampIso: r.flightTimestamp.toISOString(),
    uploadedAtIso: r.uploadedAt.toISOString(),
  }))

  // Task counts per file
  const fileIds = rows.map(r => r.fileId)
  const taskCountRows = fileIds.length > 0
    ? await db
        .select({ fileId: labelingTasks.fileId, count: count() })
        .from(labelingTasks)
        .where(inArray(labelingTasks.fileId, fileIds))
        .groupBy(labelingTasks.fileId)
    : []
  const taskCountByFileId = new Map(taskCountRows.map(r => [r.fileId, r.count]))

  return (
    <div className="space-y-6">
      <DatasetView entries={entries} taskCountByFileId={taskCountByFileId} canWrite={canWrite} timezone={project.timezone} />
    </div>
  )
}
