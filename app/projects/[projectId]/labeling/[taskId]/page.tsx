import { notFound } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import { labelingTasks, labelingTaskPoints, files, flights, flightPlans, projects } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import Annotator from './annotator'

interface PageProps {
  params: Promise<{ projectId: string; taskId: string }>
}

export default async function LabelingTaskPage({ params }: PageProps) {
  const { projectId, taskId } = await params
  const session = await getSession()
  const canWrite = session?.role === 'read-write' || session?.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  const [task] = await db
    .select({
      id: labelingTasks.id,
      fileId: labelingTasks.fileId,
      fileKey: files.key,
      x1: labelingTasks.x1,
      y1: labelingTasks.y1,
      x2: labelingTasks.x2,
      y2: labelingTasks.y2,
      frame: labelingTasks.frame,
      completedBy: labelingTasks.completedBy,
      createdAt: labelingTasks.createdAt,
      flightPlanName: flightPlans.name,
    })
    .from(labelingTasks)
    .innerJoin(files, eq(labelingTasks.fileId, files.id))
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .where(eq(labelingTasks.id, taskId))

  if (!task) notFound()

  const points = await db
    .select({ id: labelingTaskPoints.id, x: labelingTaskPoints.x, y: labelingTaskPoints.y })
    .from(labelingTaskPoints)
    .where(eq(labelingTaskPoints.taskId, taskId))

  // Adjacent tasks for prev/next navigation (same file, ordered by x1/y1)
  const sibling = await db
    .select({ id: labelingTasks.id, x1: labelingTasks.x1, y1: labelingTasks.y1 })
    .from(labelingTasks)
    .innerJoin(files, eq(labelingTasks.fileId, files.id))
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .where(eq(flightPlans.projectId, projectId))

  const sorted = [...sibling].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
  const idx = sorted.findIndex(t => t.id === taskId)
  const prevTaskId = idx > 0 ? sorted[idx - 1].id : null
  const nextTaskId = idx < sorted.length - 1 ? sorted[idx + 1].id : null

  const filename = task.fileKey.split('/').pop() ?? task.fileKey

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            href={`/projects/${projectId}/labeling`}
            className="text-sm text-gray-500 hover:text-gray-900"
          >
            ← Labeling queue
          </Link>
          <h1 className="text-lg font-semibold text-gray-900 mt-1">
            {filename}
            <span className="ml-2 font-mono text-sm font-normal text-gray-400">
              {task.x1},{task.y1} — {task.x2},{task.y2}
            </span>
          </h1>
          <p className="text-sm text-gray-500">{task.flightPlanName}</p>
        </div>
        <div className="flex items-center gap-2">
          {prevTaskId ? (
            <Link
              href={`/projects/${projectId}/labeling/${prevTaskId}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm"
            >
              ← Prev
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-100 bg-gray-50 text-sm font-medium text-gray-300 cursor-not-allowed select-none">
              ← Prev
            </span>
          )}
          {nextTaskId ? (
            <Link
              href={`/projects/${projectId}/labeling/${nextTaskId}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm"
            >
              Next →
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-100 bg-gray-50 text-sm font-medium text-gray-300 cursor-not-allowed select-none">
              Next →
            </span>
          )}
        </div>
      </div>

      <Annotator
        task={{
          id: task.id,
          fileKey: task.fileKey,
          x1: task.x1,
          y1: task.y1,
          x2: task.x2,
          y2: task.y2,
          completedBy: task.completedBy ?? null,
        }}
        initialPoints={points}
        canWrite={canWrite}
        projectId={projectId}
      />
    </div>
  )
}
