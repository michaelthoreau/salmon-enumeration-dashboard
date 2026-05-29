import React from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable, odmTasks } from '@/lib/schema'
import { eq, desc, inArray, sql } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import CreateFlightForm from './create-flight-form'
import FlightsView from './flights-view'
import type { FlightRow } from './flights-view'

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
  const flightIds = active.map((f) => f.id)

  // File counts per flight (from DB — registered on upload)
  const fileCounts = flightIds.length > 0
    ? await db
        .select({ flightId: filesTable.flightId, count: sql<number>`count(*)`.as('count') })
        .from(filesTable)
        .where(inArray(filesTable.flightId, flightIds))
        .groupBy(filesTable.flightId)
    : []

  // Latest ODM task per flight
  const taskRows = flightIds.length > 0
    ? await db
        .select()
        .from(odmTasks)
        .where(inArray(odmTasks.flightId, flightIds))
        .orderBy(desc(odmTasks.createdAt))
    : []

  const fileCountMap = new Map(fileCounts.map((r) => [r.flightId, r.count]))
  const latestTaskMap = new Map<string, typeof taskRows[number]>()
  for (const task of taskRows) {
    if (!latestTaskMap.has(task.flightId)) latestTaskMap.set(task.flightId, task)
  }

  const rows: FlightRow[] = active.map((flight) => {
    const task = latestTaskMap.get(flight.id)
    return {
      flight,
      formattedTime: formatInTz(flight.timestamp, project.timezone),
      localTimestamp: toLocalInputValue(flight.timestamp, project.timezone),
      imageCount: fileCountMap.get(flight.id) ?? 0,
      taskStatus: task?.status ?? null,
      outputKey: task?.outputKey ?? null,
    }
  })

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

      <FlightsView
        rows={rows}
        projectId={projectId}
        flightPlanId={flightPlanId}
        timezone={project.timezone}
        canWrite={canWrite}
      />
    </div>
  )
}
