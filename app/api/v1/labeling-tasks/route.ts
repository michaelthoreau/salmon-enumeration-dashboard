import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { labelingTasks, labelingTaskPoints, files, flights, flightPlans, projects } from '@/lib/schema'
import { eq, and, isNull, isNotNull, inArray, desc } from 'drizzle-orm'

export async function GET(request: NextRequest) {
  const apiKey = await validateApiKey(request.headers.get('authorization'))
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const searchParams = request.nextUrl.searchParams
  const projectId = searchParams.get('projectId')
  const flightPlanId = searchParams.get('flightPlanId')
  const flightId = searchParams.get('flightId')
  const fileId = searchParams.get('fileId')
  const completed = searchParams.get('completed')
  const limit = Math.min(1000, Math.max(1, Number(searchParams.get('limit') ?? '50')))
  const offset = Math.max(0, Number(searchParams.get('offset') ?? '0'))

  const conditions = []

  // Soft delete filters
  conditions.push(isNull(flights.deletedAt))
  conditions.push(isNull(flightPlans.deletedAt))
  conditions.push(isNull(projects.deletedAt))

  if (projectId) {
    conditions.push(eq(flightPlans.projectId, projectId))
  }
  if (flightPlanId) {
    conditions.push(eq(flights.flightPlanId, flightPlanId))
  }
  if (flightId) {
    conditions.push(eq(files.flightId, flightId))
  }
  if (fileId) {
    conditions.push(eq(labelingTasks.fileId, fileId))
  }
  if (completed === 'true') {
    conditions.push(isNotNull(labelingTasks.completedBy))
  } else if (completed === 'false') {
    conditions.push(isNull(labelingTasks.completedBy))
  }

  // Fetch labeling tasks
  const tasksRows = await db
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
      createdBy: labelingTasks.createdBy,
      createdAt: labelingTasks.createdAt,
      queueId: labelingTasks.queueId,
      projectId: flightPlans.projectId,
      flightPlanId: flights.flightPlanId,
      flightId: files.flightId,
    })
    .from(labelingTasks)
    .innerJoin(files, eq(labelingTasks.fileId, files.id))
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .innerJoin(projects, eq(flightPlans.projectId, projects.id))
    .where(and(...conditions))
    .orderBy(desc(labelingTasks.createdAt))
    .limit(limit)
    .offset(offset)

  // Fetch points for the retrieved tasks
  const taskIds = tasksRows.map((t) => t.id)
  const pointsMap = new Map<string, { id: string; x: number; y: number; createdBy: string; createdAt: Date }[]>()

  if (taskIds.length > 0) {
    const pointsRows = await db
      .select({
        id: labelingTaskPoints.id,
        taskId: labelingTaskPoints.taskId,
        x: labelingTaskPoints.x,
        y: labelingTaskPoints.y,
        createdBy: labelingTaskPoints.createdBy,
        createdAt: labelingTaskPoints.createdAt,
      })
      .from(labelingTaskPoints)
      .where(inArray(labelingTaskPoints.taskId, taskIds))

    for (const p of pointsRows) {
      if (!pointsMap.has(p.taskId)) {
        pointsMap.set(p.taskId, [])
      }
      pointsMap.get(p.taskId)!.push({
        id: p.id,
        x: p.x,
        y: p.y,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
      })
    }
  }

  // Combine tasks with their points annotations
  const results = tasksRows.map((t) => ({
    ...t,
    points: pointsMap.get(t.id) ?? [],
  }))

  return NextResponse.json(results)
}
