import { notFound } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files, labelingTasks, labelingTaskPoints } from '@/lib/schema'
import { eq, desc, count, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { cn } from '@/lib/utils'

interface PageProps {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ filter?: string }>
}

export default async function LabelingPage({ params, searchParams }: PageProps) {
  const { projectId } = await params
  const { filter = 'incomplete' } = await searchParams
  const session = await getSession()
  const canWrite = session?.role === 'read-write' || session?.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  // All tasks for files in this project
  const taskRows = await db
    .select({
      taskId: labelingTasks.id,
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
    .where(eq(flightPlans.projectId, projectId))
    .orderBy(desc(labelingTasks.createdAt))

  // Point counts per task
  const taskIds = taskRows.map(r => r.taskId)
  const pointCountRows = taskIds.length > 0
    ? await db
        .select({ taskId: labelingTaskPoints.taskId, count: count() })
        .from(labelingTaskPoints)
        .where(inArray(labelingTaskPoints.taskId, taskIds))
        .groupBy(labelingTaskPoints.taskId)
    : []
  const pointCountByTaskId = new Map(pointCountRows.map(r => [r.taskId, r.count]))

  const total = taskRows.length
  const completedCount = taskRows.filter(r => r.completedBy).length
  const incompleteCount = total - completedCount

  const filtered = filter === 'complete'
    ? taskRows.filter(r => r.completedBy)
    : filter === 'all'
    ? taskRows
    : taskRows.filter(r => !r.completedBy)

  const TABS = [
    { key: 'incomplete', label: 'Incomplete', count: incompleteCount },
    { key: 'complete', label: 'Complete', count: completedCount },
    { key: 'all', label: 'All', count: total },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Labeling</h1>
        <p className="text-sm text-gray-500 mt-1">
          {incompleteCount} task{incompleteCount !== 1 ? 's' : ''} remaining of {total} total
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {TABS.map(tab => (
          <Link
            key={tab.key}
            href={`/projects/${projectId}/labeling?filter=${tab.key}`}
            className={cn(
              'px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
              filter === tab.key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800',
            )}
          >
            {tab.label}
            <span className={cn(
              'ml-1.5 rounded-full px-1.5 py-0.5 text-xs',
              filter === tab.key ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500',
            )}>
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {/* Task list */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-500 p-6">No tasks.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">File</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Flight plan</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Region</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Points</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(task => {
                const filename = task.fileKey.split('/').pop() ?? task.fileKey
                const points = pointCountByTaskId.get(task.taskId) ?? 0
                const complete = !!task.completedBy
                return (
                  <tr key={task.taskId} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-[200px] truncate" title={filename}>
                      {filename}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{task.flightPlanName}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-400">
                      {task.x1},{task.y1}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {points > 0
                        ? <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{points}</span>
                        : <span className="text-xs text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {complete
                        ? <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">Done</span>
                        : <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">Pending</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/projects/${projectId}/labeling/${task.taskId}`}
                        className="text-xs font-medium text-blue-600 hover:text-blue-800"
                      >
                        {complete ? 'Review' : 'Annotate'} →
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
