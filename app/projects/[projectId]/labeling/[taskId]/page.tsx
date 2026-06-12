import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import { labelingTasks, files, flights, flightPlans, projects } from '@/lib/schema'
import { eq } from 'drizzle-orm'

interface PageProps {
  params: Promise<{ projectId: string; taskId: string }>
}

export default async function LabelingTaskPage({ params }: PageProps) {
  const { projectId, taskId } = await params

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  const [task] = await db
    .select({
      id: labelingTasks.id,
      queueId: labelingTasks.queueId,
    })
    .from(labelingTasks)
    .innerJoin(files, eq(labelingTasks.fileId, files.id))
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .where(eq(labelingTasks.id, taskId))

  if (!task) notFound()

  // If the task belongs to a queue, redirect to the queue session page
  if (task.queueId) {
    redirect(`/projects/${projectId}/labeling/queue/${task.queueId}?task=${taskId}`)
  }

  // Task exists but is not in any queue — show a blocker
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center">
        <svg className="w-7 h-7 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Task not in a queue</h1>
        <p className="text-sm text-gray-500 mt-1 max-w-xs">
          Annotation is only available inside a labeling queue. Add this task to a queue first.
        </p>
      </div>
      <Link
        href={`/projects/${projectId}/labeling`}
        className="inline-flex items-center gap-2 rounded-xl bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 hover:bg-blue-700 transition-colors"
      >
        ← Back to labeling
      </Link>
    </div>
  )
}
