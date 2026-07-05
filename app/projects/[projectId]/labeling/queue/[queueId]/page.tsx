import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import {
  labelingTasks,
  labelingTaskPoints,
  labelingQueues,
  files,
  flights,
  flightPlans,
  projects,
  users,
} from '@/lib/schema'
import { eq, asc, sql, count } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import QueueAnnotator from './queue-annotator'

interface PageProps {
  params: Promise<{ projectId: string; queueId: string }>
  searchParams: Promise<{ task?: string }>
}

export default async function QueueLabelingPage({ params, searchParams }: PageProps) {
  const { projectId, queueId } = await params
  const { task: taskIdParam } = await searchParams

  const session = await getSession()
  const canWrite = session?.role === 'read-write' || session?.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  const [queue] = await db.select().from(labelingQueues).where(eq(labelingQueues.id, queueId))
  if (!queue || queue.projectId !== projectId) notFound()

  // All tasks in this queue, ordered by creation (stable order)
  const queueTaskRows = await db
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
      completedByEmail: users.email,
      createdAt: labelingTasks.createdAt,
      flightPlanName: flightPlans.name,
      pointCount: count(labelingTaskPoints.id),
    })
    .from(labelingTasks)
    .innerJoin(files, eq(labelingTasks.fileId, files.id))
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .leftJoin(labelingTaskPoints, eq(labelingTasks.id, labelingTaskPoints.taskId))
    .leftJoin(users, eq(labelingTasks.completedBy, users.id))
    .where(eq(labelingTasks.queueId, queueId))
    .groupBy(labelingTasks.id, users.email)
    .orderBy(asc(labelingTasks.createdAt))

  if (queueTaskRows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="text-gray-400 text-sm">This queue has no tasks yet.</p>
      </div>
    )
  }

  // Determine active task
  const activeTaskId = taskIdParam ?? queueTaskRows.find(t => !t.completedBy)?.id ?? queueTaskRows[0].id
  const activeIdx = queueTaskRows.findIndex(t => t.id === activeTaskId)
  if (activeIdx === -1) notFound()

  const task = queueTaskRows[activeIdx]
  const prevTask = activeIdx > 0 ? queueTaskRows[activeIdx - 1] : null
  const nextTask = activeIdx < queueTaskRows.length - 1 ? queueTaskRows[activeIdx + 1] : null

  // Points for the active task
  const points = await db
    .select({ id: labelingTaskPoints.id, x: labelingTaskPoints.x, y: labelingTaskPoints.y })
    .from(labelingTaskPoints)
    .where(eq(labelingTaskPoints.taskId, activeTaskId))

  const totalCount = queueTaskRows.length
  const completeCount = queueTaskRows.filter(t => t.completedBy).length
  const positionInQueue = activeIdx + 1 // 1-based

  return (
    <QueueAnnotator
      key={task.id}
      projectId={projectId}
      queueId={queueId}
      queueName={queue.name}
      task={{
        id: task.id,
        fileKey: task.fileKey,
        x1: task.x1,
        y1: task.y1,
        x2: task.x2,
        y2: task.y2,
        frame: task.frame,
        completedBy: task.completedBy ?? null,
        flightPlanName: task.flightPlanName,
      }}
      initialPoints={points}
      canWrite={canWrite}
      positionInQueue={positionInQueue}
      totalInQueue={totalCount}
      completeCount={completeCount}
      prevTaskId={prevTask?.id ?? null}
      nextTaskId={nextTask?.id ?? null}
      queueTasks={queueTaskRows.map(t => ({
        id: t.id,
        fileKey: t.fileKey,
        x1: t.x1,
        y1: t.y1,
        x2: t.x2,
        y2: t.y2,
        frame: t.frame,
        completedBy: t.completedBy ?? null,
        completedByEmail: t.completedByEmail ?? null,
        pointCount: t.pointCount,
      }))}
    />
  )
}
