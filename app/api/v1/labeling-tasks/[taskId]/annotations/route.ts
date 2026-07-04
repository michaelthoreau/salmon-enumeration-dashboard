import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { labelingTasks, labelingTaskPoints } from '@/lib/schema'
import { eq } from 'drizzle-orm'

interface RouteParams {
  params: Promise<{ taskId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const apiKey = await validateApiKey(request.headers.get('authorization'))
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { taskId } = await params
  const [task] = await db.select().from(labelingTasks).where(eq(labelingTasks.id, taskId))
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const rows = await db
    .select({
      id: labelingTaskPoints.id,
      x: labelingTaskPoints.x,
      y: labelingTaskPoints.y,
      createdBy: labelingTaskPoints.createdBy,
      createdAt: labelingTaskPoints.createdAt,
    })
    .from(labelingTaskPoints)
    .where(eq(labelingTaskPoints.taskId, taskId))

  return NextResponse.json(rows)
}
