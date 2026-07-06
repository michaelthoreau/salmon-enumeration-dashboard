import { db } from '@/lib/db'
import { files, flights, flightPlans, projects } from '@/lib/schema'
import { eq, isNull, or, inArray } from 'drizzle-orm'
import CompressionBackfillView from './compression-backfill-view'

export const dynamic = 'force-dynamic'

export default async function CompressionBackfillPage() {
  const VIDEO_EXTS = ['.mp4', '.mov']

  const allFiles = await db
    .select({
      id: files.id,
      key: files.key,
      size: files.size,
      compressionStatus: files.compressionStatus,
      flightId: files.flightId,
    })
    .from(files)

  const uncompressed = allFiles.filter((f) => {
    const lower = f.key.toLowerCase()
    const isVideo = VIDEO_EXTS.some((ext) => lower.endsWith(ext))
    const isExcluded = ['/compressed/', '/odm/', '/outputs/', '/georef/'].some((p) => f.key.includes(p))
    const needsCompression = f.compressionStatus === 'none' || f.compressionStatus === 'failed'
    return isVideo && !isExcluded && needsCompression
  })

  // Enrich with flight/project names for display
  const flightIds = [...new Set(uncompressed.map((f) => f.flightId))]
  const flightRows = flightIds.length > 0
    ? await db.select({ id: flights.id, flightPlanId: flights.flightPlanId, timestamp: flights.timestamp })
        .from(flights)
        .where(inArray(flights.id, flightIds))
    : []

  const flightPlanIds = [...new Set(flightRows.map((f) => f.flightPlanId))]
  const flightPlanRows = flightPlanIds.length > 0
    ? await db.select({ id: flightPlans.id, name: flightPlans.name, displayName: flightPlans.displayName, projectId: flightPlans.projectId })
        .from(flightPlans)
        .where(inArray(flightPlans.id, flightPlanIds))
    : []

  const projectIds = [...new Set(flightPlanRows.map((f) => f.projectId))]
  const projectRows = projectIds.length > 0
    ? await db.select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, projectIds))
    : []

  const flightMap = Object.fromEntries(flightRows.map((f) => [f.id, f]))
  const flightPlanMap = Object.fromEntries(flightPlanRows.map((f) => [f.id, f]))
  const projectMap = Object.fromEntries(projectRows.map((p) => [p.id, p]))

  const enriched = uncompressed.map((f) => {
    const flight = flightMap[f.flightId]
    const flightPlan = flight ? flightPlanMap[flight.flightPlanId] : undefined
    const project = flightPlan ? projectMap[flightPlan.projectId] : undefined
    return {
      id: f.id,
      key: f.key,
      size: f.size ?? 0,
      compressionStatus: f.compressionStatus,
      filename: f.key.split('/').pop() ?? f.key,
      projectName: project?.name ?? '—',
      flightPlanName: flightPlan?.displayName ?? flightPlan?.name ?? '—',
      flightTimestamp: flight?.timestamp?.toISOString() ?? null,
    }
  })

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Compression Backfill</h1>
        <p className="text-sm text-gray-500 mt-1">
          Select videos to compress. Each invokes the Lambda with a synthetic S3 event — same as if the file were uploaded fresh.
        </p>
      </div>
      <CompressionBackfillView videos={enriched} />
    </main>
  )
}
