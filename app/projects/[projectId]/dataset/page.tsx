import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files, labelingTasks } from '@/lib/schema'
import { eq, desc, count, inArray, and } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import DatasetView from './dataset-view'
import type { DatasetEntry } from '@/app/actions/files'

interface PageProps {
  params: Promise<{ projectId: string }>
}

const PAGE_SIZE = 500

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
      reviewRating: files.reviewRating,
      durationSeconds: files.durationSeconds,
      flightId: flights.id,
      flightPlanId: flights.flightPlanId,
      flightTimestamp: flights.timestamp,
      flightPlanName: flightPlans.name,
      surveyType: flights.surveyType,
    })
    .from(files)
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .where(eq(flightPlans.projectId, projectId))
    .orderBy(desc(files.uploadedAt))
    .limit(PAGE_SIZE + 1)

  const hasMore = rows.length > PAGE_SIZE
  const batch = hasMore ? rows.slice(0, PAGE_SIZE) : rows

  const entries: DatasetEntry[] = batch.map(r => ({
    fileId: r.fileId,
    key: r.key,
    etag: r.etag,
    split: r.split ?? null,
    imageWidth: r.imageWidth ?? null,
    imageHeight: r.imageHeight ?? null,
    size: r.size ?? null,
    reviewRating: r.reviewRating ?? null,
    durationSeconds: r.durationSeconds ?? null,
    flightId: r.flightId,
    flightPlanId: r.flightPlanId,
    flightTimestampIso: r.flightTimestamp.toISOString(),
    flightPlanName: r.flightPlanName,
    surveyType: r.surveyType,
    uploadedAtIso: r.uploadedAt.toISOString(),
  }))

  // Task counts only for the initial batch
  const fileIds = batch.map(r => r.fileId)
  const taskCountRows = fileIds.length > 0
    ? await db
        .select({ fileId: labelingTasks.fileId, n: count() })
        .from(labelingTasks)
        .where(inArray(labelingTasks.fileId, fileIds))
        .groupBy(labelingTasks.fileId)
    : []
  const taskCountByFileId = new Map(taskCountRows.map(r => [r.fileId, r.n]))

  // Global split counts across ALL files (not just the first page)
  const splitCountRows = await db
    .select({ split: files.split, n: count() })
    .from(files)
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .where(eq(flightPlans.projectId, projectId))
    .groupBy(files.split)

  const globalCounts = { train: 0, val: 0, test: 0, unassigned: 0 }
  for (const r of splitCountRows) {
    if (r.split === 'train') globalCounts.train = r.n
    else if (r.split === 'val') globalCounts.val = r.n
    else if (r.split === 'test') globalCounts.test = r.n
    else globalCounts.unassigned += r.n
  }

  return (
    <div className="space-y-6">
      <DatasetView
        projectId={projectId}
        entries={entries}
        taskCountByFileId={taskCountByFileId}
        canWrite={canWrite}
        timezone={project.timezone}
        hasMore={hasMore}
        globalCounts={globalCounts}
      />
    </div>
  )
}
