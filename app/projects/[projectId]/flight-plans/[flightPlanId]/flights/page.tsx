import React from 'react'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable, odmTasks, georefTasks, geofences, fileGeofenceTags } from '@/lib/schema'
import { eq, desc, inArray, sql, and, isNull } from 'drizzle-orm'
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

  // Fetch geofence tags per flight
  const allGeofences = await db
    .select()
    .from(geofences)
    .where(eq(geofences.projectId, projectId))

  const geofenceNameMap = new Map(allGeofences.map((g) => [g.id, g.name]))
  const flightTagsMap = new Map<string, string[]>()

  if (flightIds.length > 0 && allGeofences.length > 0) {
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

      const fileToFlight = new Map(allFiles.map((f) => [f.id, f.flightId]))
      for (const tag of allTags) {
        const flightId = fileToFlight.get(tag.fileId)
        const gName = geofenceNameMap.get(tag.geofenceId)
        if (!flightId || !gName) continue
        if (!flightTagsMap.has(flightId)) flightTagsMap.set(flightId, [])
        const tags = flightTagsMap.get(flightId)!
        if (!tags.includes(gName)) tags.push(gName)
      }
    }
  }

  const availableLocationTags = [...new Set(allGeofences.map((g) => g.name))].sort()

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
      fileCount: fileCountMap.get(flight.id) ?? 0,
      taskStatus: (task?.status as any) ?? null,
      outputKey: task?.outputKey ?? null,
      taskCompletedAt: task?.completedAt ?? null,
      locationTags: flightTagsMap.get(flight.id) ?? [],
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
      flightPlan={flightPlan}
      from={from}
      isAdmin={session?.role === 'admin'}
      availableLocationTags={availableLocationTags}
    />
  )
}
