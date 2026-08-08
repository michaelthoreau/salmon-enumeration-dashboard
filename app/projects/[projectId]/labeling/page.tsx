import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files, labelingTasks, labelingTaskPoints, labelingQueues, users, annotations } from '@/lib/schema'
import { eq, desc, count, inArray, sql } from 'drizzle-orm'
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
      surveyType: flights.surveyType,
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

  // Labeled points from task annotator
  const labelingTaskFishCounts = await db
    .select({
      createdBy: labelingTaskPoints.createdBy,
      count: count(labelingTaskPoints.id),
    })
    .from(labelingTaskPoints)
    .innerJoin(labelingTasks, eq(labelingTaskPoints.taskId, labelingTasks.id))
    .innerJoin(files, eq(labelingTasks.fileId, files.id))
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .where(eq(flightPlans.projectId, projectId))
    .groupBy(labelingTaskPoints.createdBy)

  // Labeled fish from map annotations
  const mapFishCounts = await db
    .select({
      createdBy: annotations.createdBy,
      count: sql<number>`sum(${annotations.fishCount})`,
    })
    .from(annotations)
    .innerJoin(flights, eq(annotations.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .where(eq(flightPlans.projectId, projectId))
    .groupBy(annotations.createdBy)

  const fishCountByUser = new Map<string, number>()
  labelingTaskFishCounts.forEach(r => {
    fishCountByUser.set(r.createdBy, (fishCountByUser.get(r.createdBy) ?? 0) + r.count)
  })
  mapFishCounts.forEach(r => {
    fishCountByUser.set(r.createdBy, (fishCountByUser.get(r.createdBy) ?? 0) + (r.count ?? 0))
  })

  const fishLeaderboard = Array.from(fishCountByUser.entries()).map(([userId, count]) => ({
    userId,
    count,
  }))

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
      fishLeaderboard={fishLeaderboard}
    />
  )
}
