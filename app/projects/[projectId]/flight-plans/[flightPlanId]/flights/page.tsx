import React from 'react'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable, odmTasks, georefTasks } from '@/lib/schema'
import { eq, desc, inArray, sql } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import FlightsView from './flights-view'
import type { FlightRow } from './flights-view'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ projectId: string; flightPlanId: string }>
  searchParams: Promise<{ from?: string }>
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

export default async function FlightsPage({ params, searchParams }: PageProps) {
  const { projectId, flightPlanId } = await params
  const { from } = await searchParams
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
  const odmTaskRows = flightIds.length > 0
    ? await db
        .select()
        .from(odmTasks)
        .where(inArray(odmTasks.flightId, flightIds))
        .orderBy(desc(odmTasks.createdAt))
    : []

  // Latest Georef task per flight
  const georefTaskRows = flightIds.length > 0
    ? await db
        .select()
        .from(georefTasks)
        .where(inArray(georefTasks.flightId, flightIds))
        .orderBy(desc(georefTasks.createdAt))
    : []

  const fileCountMap = new Map(fileCounts.map((r) => [r.flightId, r.count]))

  const latestOdmMap = new Map<string, typeof odmTaskRows[number]>()
  for (const task of odmTaskRows) {
    if (!latestOdmMap.has(task.flightId)) latestOdmMap.set(task.flightId, task)
  }

  const latestGeorefMap = new Map<string, typeof georefTaskRows[number]>()
  for (const task of georefTaskRows) {
    if (!latestGeorefMap.has(task.flightId)) latestGeorefMap.set(task.flightId, task)
  }

  const rows: FlightRow[] = active.map((flight) => {
    const odmTask = latestOdmMap.get(flight.id)
    const georefTask = latestGeorefMap.get(flight.id)

    // Determine the most recent task for this flight
    let task: { status: string; outputKey: string | null; createdAt: Date; completedAt: Date | null } | null = null
    if (odmTask && georefTask) {
      task = new Date(odmTask.createdAt) > new Date(georefTask.createdAt) ? odmTask : georefTask
    } else {
      task = odmTask || georefTask || null
    }

    return {
      flight,
      formattedTime: formatInTz(flight.timestamp, project.timezone),
      localTimestamp: toLocalInputValue(flight.timestamp, project.timezone),
      imageCount: fileCountMap.get(flight.id) ?? 0,
      taskStatus: (task?.status as any) ?? null,
      outputKey: task?.outputKey ?? null,
      taskCompletedAt: task?.completedAt ?? null,
    }
  })

  return (
    <FlightsView
      rows={rows}
      projectId={projectId}
      flightPlanId={flightPlanId}
      timezone={project.timezone}
      canWrite={canWrite}
      projectName={project.name}
      flightPlan={{
        name: flightPlan.displayName || flightPlan.name,
        description: flightPlan.description,
      }}
      from={from}
    />
  )
}
