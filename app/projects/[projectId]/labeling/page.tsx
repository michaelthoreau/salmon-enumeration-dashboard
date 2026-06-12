import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files, labelingTasks, labelingTaskPoints, labelingQueues, users } from '@/lib/schema'
import { eq, desc, count, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import LabelingView from './labeling-view'

interface PageProps {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ filter?: string; queue?: string }>
}

export default async function LabelingPage({ params }: PageProps) {
  const { projectId } = await params
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
      queueId: labelingTasks.queueId,
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

  // Queues for this project
  const queues = await db
    .select()
    .from(labelingQueues)
    .where(eq(labelingQueues.projectId, projectId))
    .orderBy(desc(labelingQueues.createdAt))

  // All users (for assignee display and selection)
  const allUsers = await db.select({ id: users.id, email: users.email }).from(users)

  const tasks = taskRows.map(r => ({
    ...r,
    completedAt: r.completedBy ? r.createdAt : null, // placeholder – use completedBy presence
    pointCount: pointCountByTaskId.get(r.taskId) ?? 0,
    createdAtIso: r.createdAt.toISOString(),
  }))

  return (
    <LabelingView
      projectId={projectId}
      tasks={tasks}
      queues={queues.map(q => ({ ...q, createdAtIso: q.createdAt.toISOString() }))}
      users={allUsers}
      canWrite={canWrite}
    />
  )
}
