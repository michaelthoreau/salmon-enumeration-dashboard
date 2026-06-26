import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable, geofences, fileGeofenceTags } from '@/lib/schema'
import { eq, desc, and, isNull, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import CreateFlightPlanForm from './create-flight-plan-form'
import { RestoreFlightPlanButton } from './flight-plan-actions'
import SyncProjectButton from './sync-project-button'
import DjiSyncButton from './dji-sync-button'
import FlightPlansView from './flight-plans-view'

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

  // Fetch geofence tags per flight plan
  const allGeofences = await db
    .select()
    .from(geofences)
    .where(eq(geofences.projectId, projectId))

  const geofenceMap = new Map(allGeofences.map((g) => [g.id, { name: g.name, color: g.color }]))
  const availableTags = [...new Set(allGeofences.map((g) => g.name))].sort()

  const planTagsMap = new Map<string, { name: string; color: string }[]>()

  if (active.length > 0 && allGeofences.length > 0) {
    const planIds = active.map((p) => p.id)
    const allFlights = await db
      .select({ id: flights.id, flightPlanId: flights.flightPlanId })
      .from(flights)
      .where(and(inArray(flights.flightPlanId, planIds), isNull(flights.deletedAt)))

    if (allFlights.length > 0) {
      const flightIds = allFlights.map((f) => f.id)
      const allFiles = await db
        .select({ id: filesTable.id, flightId: filesTable.flightId })
        .from(filesTable)
        .where(inArray(filesTable.flightId, flightIds))

      if (allFiles.length > 0) {
        const fileIds = allFiles.map((f) => f.id)
        const allTags = await db
          .select()
          .from(fileGeofenceTags)
          .where(inArray(fileGeofenceTags.fileId, fileIds))

        const fileToFlightPlan = new Map<string, string>()
        const flightToPlan = new Map(allFlights.map((f) => [f.id, f.flightPlanId]))
        for (const f of allFiles) {
          const planId = flightToPlan.get(f.flightId)
          if (planId) fileToFlightPlan.set(f.id, planId)
        }

        for (const tag of allTags) {
          const planId = fileToFlightPlan.get(tag.fileId)
          const gInfo = geofenceMap.get(tag.geofenceId)
          if (!planId || !gInfo) continue
          if (!planTagsMap.has(planId)) planTagsMap.set(planId, [])
          const tags = planTagsMap.get(planId)!
          if (!tags.find((t) => t.name === gInfo.name)) tags.push(gInfo)
        }
      }
    }
  }

  const activePlansData = active.map((plan) => ({
    id: plan.id,
    name: plan.name,
    displayName: plan.displayName,
    description: plan.description,
    createdAt: plan.createdAt.toISOString(),
    locationTags: planTagsMap.get(plan.id) ?? [],
  }))

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
        <FlightPlansView
          plans={activePlansData}
          projectId={projectId}
          isAdmin={isAdmin}
          availableLocationTags={availableTags}
        />
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
