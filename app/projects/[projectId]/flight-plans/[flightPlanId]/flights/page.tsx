import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights } from '@/lib/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import CreateFlightForm from './create-flight-form'
import { DeleteFlightButton } from './flight-actions'
import EditFlightButton from './[flightId]/edit-flight-button'

interface PageProps {
  params: Promise<{ projectId: string; flightPlanId: string }>
}

function formatInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).format(date)
}

function toLocalInputValue(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

export default async function FlightsPage({ params }: PageProps) {
  const { projectId, flightPlanId } = await params
  const session = await getSession()
  const canWrite = session?.role === 'read-write' || session?.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project) notFound()

  const [flightPlan] = await db.select().from(flightPlans).where(eq(flightPlans.id, flightPlanId))
  if (!flightPlan) notFound()

  const allFlights = await db
    .select()
    .from(flights)
    .where(eq(flights.flightPlanId, flightPlanId))
    .orderBy(desc(flights.timestamp))

  const active = allFlights.filter((f) => !f.deletedAt)

  return (
    <div className="space-y-8">
      <div>
        <Link href={`/projects/${projectId}/flight-plans`} className="text-sm text-gray-500 hover:text-gray-900 flex items-center gap-1 mb-4">← {project.name}</Link>
        <h1 className="text-2xl font-semibold text-gray-900">{flightPlan.name}</h1>
        {flightPlan.description && <p className="text-gray-500 mt-1">{flightPlan.description}</p>}
      </div>

      {canWrite && (
        <div>
          <CreateFlightForm projectId={projectId} flightPlanId={flightPlanId} timezone={project.timezone} />
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Flights{' '}
          <span className="text-sm font-normal text-gray-500">({active.length})</span>
        </h2>
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {active.length === 0 ? (
            <p className="text-sm text-gray-500 p-6">No flights logged yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Timestamp</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Notes</th>
                  {canWrite && <th className="px-6 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {active.map((flight) => (
                  <tr key={flight.id}>
                    <td className="px-6 py-3 text-xs text-gray-700">
                      <Link
                        href={`/projects/${projectId}/flight-plans/${flightPlanId}/flights/${flight.id}`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {formatInTz(flight.timestamp, project.timezone)}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-gray-500">{flight.notes ?? '—'}</td>
                    {canWrite && (
                      <td className="px-6 py-3 text-right flex items-center justify-end gap-1">
                        <EditFlightButton
                          flightId={flight.id}
                          projectId={projectId}
                          flightPlanId={flightPlanId}
                          timezone={project.timezone}
                          localTimestamp={toLocalInputValue(flight.timestamp, project.timezone)}
                          currentNotes={flight.notes}
                        />
                        <DeleteFlightButton
                          flight={flight}
                          projectId={projectId}
                          flightPlanId={flightPlanId}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}
