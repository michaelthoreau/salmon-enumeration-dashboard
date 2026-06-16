import React from 'react'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable, odmTasks, georefTasks } from '@/lib/schema'
import { eq, and, isNull, inArray, desc, sql } from 'drizzle-orm'
import { getSession } from '@/lib/session'

import TodayFlightsView from './today-view'

interface PageProps {
  params: Promise<{ projectId: string }>
}

function getLocalDateStr(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const y = parts.find((p) => p.type === 'year')!.value
  const m = parts.find((p) => p.type === 'month')!.value
  const d = parts.find((p) => p.type === 'day')!.value
  return `${y}-${m}-${d}`
}

export default async function ProjectTodayPage({ params }: PageProps) {
  const { projectId } = await params
  const session = await getSession()
  const isAdmin = session?.role === 'admin'
  const canWrite = session?.role === 'read-write' || session?.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  const plans = await db
    .select()
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), isNull(flightPlans.deletedAt)))

  const initialDate = getLocalDateStr(new Date(), project.timezone)

  if (plans.length === 0) {
    return (
      <TodayFlightsView
        projectId={projectId}
        projectName={project.name}
        timezone={project.timezone}
        flightPlans={[]}
        flights={[]}
        datesWithFlights={[]}
        initialDate={initialDate}
        canWrite={canWrite}
        isAdmin={isAdmin}
      />
    )
  }

  const visiblePlanIds = plans.filter((p) => p.showOnDashboard).map((p) => p.id)
  const allFlights = visiblePlanIds.length > 0
    ? await db
        .select()
        .from(flights)
        .where(
          and(
            inArray(flights.flightPlanId, visiblePlanIds),
            isNull(flights.deletedAt)
          )
        )
        .orderBy(desc(flights.timestamp))
    : []

  if (allFlights.length === 0) {
    return (
      <TodayFlightsView
        projectId={projectId}
        projectName={project.name}
        timezone={project.timezone}
        flightPlans={plans}
        flights={[]}
        datesWithFlights={[]}
        initialDate={initialDate}
        canWrite={canWrite}
        isAdmin={isAdmin}
      />
    )
  }

  const flightIds = allFlights.map((f) => f.id)



  // Fetch counts, ODM tasks, and Georef tasks for all flights
  const fileCounts = await db
    .select({ flightId: filesTable.flightId, count: sql<number>`count(*)`.as('count') })
    .from(filesTable)
    .where(inArray(filesTable.flightId, flightIds))
    .groupBy(filesTable.flightId)

  const odmTaskRows = await db
    .select()
    .from(odmTasks)
    .where(inArray(odmTasks.flightId, flightIds))
    .orderBy(desc(odmTasks.createdAt))

  const georefTaskRows = await db
    .select()
    .from(georefTasks)
    .where(inArray(georefTasks.flightId, flightIds))
    .orderBy(desc(georefTasks.createdAt))

  const fileCountMap = new Map(fileCounts.map((r) => [r.flightId, r.count]))

  const latestOdmMap = new Map<string, typeof odmTaskRows[number]>()
  for (const task of odmTaskRows) {
    if (!latestOdmMap.has(task.flightId)) latestOdmMap.set(task.flightId, task)
  }

  const latestGeorefMap = new Map<string, typeof georefTaskRows[number]>()
  for (const task of georefTaskRows) {
    if (!latestGeorefMap.has(task.flightId)) latestGeorefMap.set(task.flightId, task)
  }

  const mappedFlights = allFlights.map((flight) => {
    const odmTask = latestOdmMap.get(flight.id)
    const georefTask = latestGeorefMap.get(flight.id)

    let task: { status: string; outputKey: string | null; createdAt: Date; completedAt: Date | null } | null = null
    if (odmTask && georefTask) {
      task = new Date(odmTask.createdAt) > new Date(georefTask.createdAt) ? odmTask : georefTask
    } else {
      task = odmTask || georefTask || null
    }

    const plan = plans.find((p) => p.id === flight.flightPlanId)!

    return {
      id: flight.id,
      flightPlanId: flight.flightPlanId,
      flightPlanName: plan.displayName || plan.name,
      flightPlanLocation: plan.location,
      timestamp: flight.timestamp,
      notes: flight.notes,
      imageCount: fileCountMap.get(flight.id) ?? 0,
      taskStatus: (task?.status as any) ?? null,
      outputKey: task?.outputKey ?? null,
    }
  })

  const datesWithFlights = Array.from(
    new Set(mappedFlights.map((f) => getLocalDateStr(f.timestamp, project.timezone)))
  ).sort((a, b) => b.localeCompare(a))

  return (
    <TodayFlightsView
      projectId={projectId}
      projectName={project.name}
      timezone={project.timezone}
      flightPlans={plans}
      flights={mappedFlights}
      datesWithFlights={datesWithFlights}
      initialDate={initialDate}
      canWrite={canWrite}
      isAdmin={isAdmin}
    />
  )
}
