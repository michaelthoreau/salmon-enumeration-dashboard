import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans } from '@/lib/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import CreateFlightPlanForm from './create-flight-plan-form'
import { DeleteFlightPlanButton, RestoreFlightPlanButton, EditFlightPlanButton } from './flight-plan-actions'
import SyncProjectButton from './sync-project-button'
import DjiSyncButton from './dji-sync-button'

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function FlightPlansPage({ params }: PageProps) {
  const { projectId } = await params
  const session = await getSession()
  const isAdmin = session?.role === 'admin'
  const canWrite = session?.role === 'read-write' || session?.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project) notFound()

  const allPlans = await db
    .select()
    .from(flightPlans)
    .where(eq(flightPlans.projectId, projectId))
    .orderBy(desc(flightPlans.createdAt))

  const active = allPlans.filter((p) => !p.deletedAt)
  const deleted = allPlans.filter((p) => p.deletedAt)

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Flight routes{' '}
            <span className="text-sm font-normal text-gray-500">({active.length})</span>
          </h2>
          <div className="flex items-center gap-2">
            {canWrite && <DjiSyncButton projectId={projectId} />}
            {canWrite && <SyncProjectButton projectId={projectId} />}
            {isAdmin && <CreateFlightPlanForm projectId={projectId} timezone={project.timezone} />}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {active.length === 0 ? (
            <p className="text-sm text-gray-500 p-6">No flight routes yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Name</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Description</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Created</th>
                  {isAdmin && <th className="px-6 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {active.map((plan) => (
                  <tr key={plan.id}>
                    <td className="px-6 py-3">
                      <Link
                        href={`/projects/${projectId}/flight-plans/${plan.id}/flights?from=list`}
                        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                      >
                        {plan.displayName || plan.name}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-gray-500">
                      {plan.description ?? '—'}
                    </td>
                    <td className="px-6 py-3 text-gray-500">
                      {plan.createdAt.toLocaleDateString()}
                    </td>
                    {isAdmin && (
                      <td className="px-6 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <EditFlightPlanButton plan={plan} projectId={projectId} />
                          <DeleteFlightPlanButton plan={plan} projectId={projectId} />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {isAdmin && deleted.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-500 mb-4">
            Archived ({deleted.length})
          </h2>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden opacity-60">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                {deleted.map((plan) => (
                  <tr key={plan.id}>
                    <td className="px-6 py-3 text-gray-500">{plan.displayName || plan.name}</td>
                    <td className="px-6 py-3 text-gray-400">{plan.description ?? '—'}</td>
                    <td className="px-6 py-3 text-right">
                      <RestoreFlightPlanButton plan={plan} projectId={projectId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
