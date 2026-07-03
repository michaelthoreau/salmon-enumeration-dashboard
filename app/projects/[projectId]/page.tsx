import React from 'react'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects, flightPlans, flights, files as filesTable, odmTasks, georefTasks, annotations, geofences, fileGeofenceTags } from '@/lib/schema'
import { eq, and, isNull, inArray, desc, sql, gte, lt } from 'drizzle-orm'
import { getSession } from '@/lib/session'

import TodayFlightsView from './today-view'
import { syncActiveTasks } from '@/lib/tasks-sync'

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
        highlightedFlightId={project.highlightedFlightId || null}
        totalFishCount={0}
        hasMore={false}
      />
    )
  }

  const activePlanIds = plans.map((p) => p.id)
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000)

  let allFlights = activePlanIds.length > 0
    ? await db
        .select()
        .from(flights)
        .where(
          and(
            inArray(flights.flightPlanId, activePlanIds),
            isNull(flights.deletedAt),
            eq(flights.lowPriority, false),
            gte(flights.timestamp, cutoff)
          )
        )
        .orderBy(desc(flights.timestamp))
    : []

  // Always load highlighted flights even if they're outside the 48h window
  const highlightedIds = (project.highlightedFlightId || '').split(',').filter(Boolean)
  if (highlightedIds.length > 0) {
    const loadedIds = new Set(allFlights.map((f) => f.id))
    const missingIds = highlightedIds.filter((id) => !loadedIds.has(id))
    if (missingIds.length > 0) {
      const extra = await db.select().from(flights)
        .where(and(inArray(flights.id, missingIds), isNull(flights.deletedAt)))
      allFlights = [...allFlights, ...extra]
    }
  }

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
        highlightedFlightId={project.highlightedFlightId || null}
        totalFishCount={0}
        hasMore={false}
      />
    )
  }

  const flightIds = allFlights.map((f) => f.id)

  if (flightIds.length > 0) {
    try {
      await syncActiveTasks(flightIds)
    } catch (err) {
      console.error('Failed to sync active tasks on dashboard load:', err)
    }
  }

  // Fetch counts, ODM tasks, and Georef tasks for all flights
  const fileCounts = await db
    .select({ flightId: filesTable.flightId, count: sql<number>`count(*)`.as('count') })
    .from(filesTable)
    .where(inArray(filesTable.flightId, flightIds))
    .groupBy(filesTable.flightId)

  // Fetch geofence tags per flight
  const allGeofences = await db
    .select()
    .from(geofences)
    .where(eq(geofences.projectId, projectId))

  const geofenceNameMap = new Map(allGeofences.map((g) => [g.id, g.name]))
  const flightLocationTags = new Map<string, string[]>()

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
        const fId = fileToFlight.get(tag.fileId)
        const gName = geofenceNameMap.get(tag.geofenceId)
        if (!fId || !gName) continue
        if (!flightLocationTags.has(fId)) flightLocationTags.set(fId, [])
        const tags = flightLocationTags.get(fId)!
        if (!tags.includes(gName)) tags.push(gName)
      }
    }
  }

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

  const [fishCountResult] = await db
    .select({ total: sql<number>`coalesce(sum(${annotations.fishCount}), 0)` })
    .from(annotations)
    .where(and(
      inArray(annotations.flightId, flightIds),
      isNull(annotations.deletedAt),
    ))

  const totalFishCount = fishCountResult?.total ?? 0

  const [olderCheck] = activePlanIds.length > 0
    ? await db
        .select({ count: sql<number>`count(*)`.as('count') })
        .from(flights)
        .where(and(
          inArray(flights.flightPlanId, activePlanIds),
          isNull(flights.deletedAt),
          eq(flights.lowPriority, false),
          lt(flights.timestamp, cutoff)
        ))
    : [{ count: 0 }]
  const hasMore = (olderCheck?.count ?? 0) > 0

  // All-time stats — run cheaply using count queries, not full data loads
  const allFlightIdsForStats = activePlanIds.length > 0
    ? (await db.select({ id: flights.id }).from(flights)
        .where(and(
          inArray(flights.flightPlanId, activePlanIds),
          isNull(flights.deletedAt),
          eq(flights.lowPriority, false),
        ))).map((r) => r.id)
    : []

  const [[totalImagesRow], completedOdmRows, completedGeorefRows] = await Promise.all([
    allFlightIdsForStats.length > 0
      ? db.select({ count: sql<number>`count(*)`.as('count') }).from(filesTable)
          .where(inArray(filesTable.flightId, allFlightIdsForStats))
      : [{ count: 0 }],
    allFlightIdsForStats.length > 0
      ? db.selectDistinct({ flightId: odmTasks.flightId }).from(odmTasks)
          .where(and(inArray(odmTasks.flightId, allFlightIdsForStats), eq(odmTasks.status, 'completed')))
      : [],
    allFlightIdsForStats.length > 0
      ? db.selectDistinct({ flightId: georefTasks.flightId }).from(georefTasks)
          .where(and(inArray(georefTasks.flightId, allFlightIdsForStats), eq(georefTasks.status, 'completed')))
      : [],
  ])

  const globalStats = {
    totalFlights: allFlightIdsForStats.length,
    totalImages: totalImagesRow?.count ?? 0,
    completedMaps: new Set([
      ...completedOdmRows.map((r) => r.flightId),
      ...completedGeorefRows.map((r) => r.flightId),
    ]).size,
  }

  const fileCountMap = new Map(fileCounts.map((r) => [r.flightId, r.count]))

  const fishCountsPerFlight = flightIds.length > 0
    ? await db
        .select({ flightId: annotations.flightId, total: sql<number>`sum(fish_count)`.as('total') })
        .from(annotations)
        .where(and(inArray(annotations.flightId, flightIds), isNull(annotations.deletedAt)))
        .groupBy(annotations.flightId)
    : []
  const fishCountMap = new Map(fishCountsPerFlight.map((r) => [r.flightId, r.total ?? 0]))

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
      locationTags: (flightLocationTags.get(flight.id) ?? []).map((name) => {
        const g = allGeofences.find((gf) => gf.name === name)
        return { name, color: g?.color ?? '#6b7280' }
      }),
      timestamp: flight.timestamp,
      notes: flight.notes,
      fileCount: fileCountMap.get(flight.id) ?? 0,
      totalFish: fishCountMap.get(flight.id) ?? 0,
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
      highlightedFlightId={project.highlightedFlightId || null}
      totalFishCount={totalFishCount}
      hasMore={hasMore}
      globalStats={globalStats}
    />
  )
}
