'use server'

import { db } from '@/lib/db'
import { files, flightPlans, flights, annotations, geofences, fileGeofenceTags, labelingTasks } from '@/lib/schema'
import { eq, and, isNull, inArray, isNotNull, desc, lt, gte, sql, count } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { headObject, listFlightObjects } from '@/lib/s3'
import { randomUUID } from 'crypto'
import type { Split, ReviewStatus } from '@/lib/schema'
import { extractExifGps, extractVideoDurationOnly } from '@/lib/exif'
import { tagFilesAgainstGeofences } from '@/lib/geofence-tagger'

const VALID_SPLITS = new Set<string>(['train', 'val', 'test'])

export async function assignFileSplit(
  key: string,
  split: Split | null,
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { error: 'Unauthorized' }
  }
  if (split !== null && !VALID_SPLITS.has(split)) {
    return { error: 'Invalid split value' }
  }

  const [existing] = await db.select({ id: files.id }).from(files).where(eq(files.key, key))

  if (existing) {
    await db.update(files).set({ split }).where(eq(files.key, key))
  } else if (split !== null) {
    // File was uploaded before the register step existed — auto-register it now.
    // Key structure: {projectId}/{flightPlanId}/{flightId}/filename
    const segments = key.split('/')
    const flightId = segments[2]
    if (!flightId) return { error: 'Could not derive flightId from key' }
    const { etag, contentLength } = await headObject(key)
    const coords = await extractExifGps(key)
    await db.insert(files).values({
      id: randomUUID(),
      flightId,
      key,
      etag,
      size: contentLength,
      split,
      uploadedAt: new Date(),
      uploadedBy: session.userId,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
    })
  }

  return { ok: true }
}

export async function syncFlightFiles(
  projectId: string,
  flightPlanId: string,
  flightId: string,
): Promise<{ ok: boolean; added: number; removed: number; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { ok: false, added: 0, removed: 0, error: 'Unauthorized' }
  }

  try {
    const s3Objects = await listFlightObjects(projectId, flightPlanId, flightId)
    const s3Images = s3Objects.filter((o) => {
      const lower = o.key.toLowerCase()
      return (
        (lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') ||
          lower.endsWith('.png') ||
          lower.endsWith('.tif') ||
          lower.endsWith('.tiff') ||
          lower.endsWith('.mp4') ||
          lower.endsWith('.mov')) &&
        !o.key.includes('/odm/')
      )
    })

    const dbFiles = await db.select().from(files).where(eq(files.flightId, flightId))

    const s3Keys = new Set(s3Images.map((o) => o.key))
    const dbKeys = new Set(dbFiles.map((f) => f.key))

    const missingInDb = s3Images.filter((o) => !dbKeys.has(o.key))
    const orphanedInDb = dbFiles.filter((f) => !s3Keys.has(f.key))

    let added = 0
    let removed = 0

    for (const file of missingInDb) {
      const coords = await extractExifGps(file.key)
      await db.insert(files).values({
        id: randomUUID(),
        flightId,
        key: file.key,
        etag: file.etag,
        size: file.size,
        uploadedAt: file.lastModified,
        uploadedBy: session.userId,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
        durationSeconds: coords?.durationSeconds ?? null,
      })
      added++
    }

    for (const row of orphanedInDb) {
      await db.delete(files).where(eq(files.id, row.id))
      removed++
    }

    // Backfill coordinates for existing files in DB
    const needsBackfill = dbFiles.filter(
      (f) => f.latitude === null && f.longitude === null &&
             (f.key.toLowerCase().endsWith('.jpg') || f.key.toLowerCase().endsWith('.jpeg'))
    )
    const backfilledFiles: { id: string; latitude: number | null; longitude: number | null }[] = []
    for (const f of needsBackfill) {
      const coords = await extractExifGps(f.key)
      if (coords) {
        await db
          .update(files)
          .set({ latitude: coords.latitude, longitude: coords.longitude, durationSeconds: coords.durationSeconds ?? null })
          .where(eq(files.id, f.id))
        backfilledFiles.push({ id: f.id, latitude: coords.latitude, longitude: coords.longitude })
      }
    }

    // Also backfill duration for video files that have GPS but no duration yet
    const needsDuration = dbFiles.filter((f) => {
      if (f.durationSeconds !== null) return false
      const lower = f.key.toLowerCase()
      return lower.endsWith('.mp4') || lower.endsWith('.mov')
    })
    for (const f of needsDuration) {
      const meta = await extractExifGps(f.key)
      if (meta?.durationSeconds) {
        await db.update(files).set({ durationSeconds: meta.durationSeconds }).where(eq(files.id, f.id))
      }
    }

    // Auto-tag new and backfilled files against existing geofences
    if (added > 0 || backfilledFiles.length > 0) {
      const newlyAdded = await db
        .select({ id: files.id, latitude: files.latitude, longitude: files.longitude })
        .from(files)
        .where(and(
          eq(files.flightId, flightId),
          isNotNull(files.latitude),
          isNotNull(files.longitude),
        ))

      await tagFilesAgainstGeofences(projectId, newlyAdded).catch((err) => {
        console.error('Failed to auto-tag files against geofences:', err)
      })
    }

    return { ok: true, added, removed }
  } catch (err) {
    console.error('Failed to sync flight files:', err)
    return { ok: false, added: 0, removed: 0, error: String(err) }
  }
}

export async function syncProjectFiles(
  projectId: string,
): Promise<{
  ok: boolean
  results: { flightId: string; added: number; removed: number; flightLabel: string }[]
  error?: string
}> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { ok: false, results: [], error: 'Unauthorized' }
  }

  try {
    const activeFlights = await db
      .select({
        flightId: flights.id,
        flightTimestamp: flights.timestamp,
        flightPlanId: flightPlans.id,
        flightPlanName: flightPlans.name,
      })
      .from(flights)
      .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
      .where(
        and(
          eq(flightPlans.projectId, projectId),
          isNull(flights.deletedAt),
          isNull(flightPlans.deletedAt),
        ),
      )

    const results: { flightId: string; added: number; removed: number; flightLabel: string }[] = []

    for (const flight of activeFlights) {
      const flightLabel = `${flight.flightPlanName} (${new Date(flight.flightTimestamp).toLocaleDateString()})`
      
      const s3Objects = await listFlightObjects(projectId, flight.flightPlanId, flight.flightId)
      const s3Images = s3Objects.filter((o) => {
        const lower = o.key.toLowerCase()
        return (
          (lower.endsWith('.jpg') ||
            lower.endsWith('.jpeg') ||
            lower.endsWith('.png') ||
            lower.endsWith('.tif') ||
            lower.endsWith('.tiff') ||
            lower.endsWith('.mp4') ||
            lower.endsWith('.mov')) &&
          !o.key.includes('/odm/')
        )
      })

      const dbFiles = await db.select().from(files).where(eq(files.flightId, flight.flightId))

      const s3Keys = new Set(s3Images.map((o) => o.key))
      const dbKeys = new Set(dbFiles.map((f) => f.key))

      const missingInDb = s3Images.filter((o) => !dbKeys.has(o.key))
      const orphanedInDb = dbFiles.filter((f) => !s3Keys.has(f.key))

      let added = 0
      let removed = 0

      for (const file of missingInDb) {
        const coords = await extractExifGps(file.key)
        await db.insert(files).values({
          id: randomUUID(),
          flightId: flight.flightId,
          key: file.key,
          etag: file.etag,
          size: file.size,
          uploadedAt: file.lastModified,
          uploadedBy: session.userId,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        })
        added++
      }

      for (const row of orphanedInDb) {
        await db.delete(files).where(eq(files.id, row.id))
        removed++
      }

      // Backfill coordinates for existing files in DB for this flight
      const needsBackfill = dbFiles.filter(
        (f) => f.latitude === null && f.longitude === null &&
               (f.key.toLowerCase().endsWith('.jpg') || f.key.toLowerCase().endsWith('.jpeg'))
      )
      for (const f of needsBackfill) {
        const coords = await extractExifGps(f.key)
        if (coords) {
          await db
            .update(files)
            .set({ latitude: coords.latitude, longitude: coords.longitude })
            .where(eq(files.id, f.id))
        }
      }

      if (added > 0 || removed > 0 || needsBackfill.length > 0) {
        results.push({
          flightId: flight.flightId,
          added,
          removed,
          flightLabel,
        })
      }
    }

    return { ok: true, results }
  } catch (err) {
    console.error('Failed to sync project files:', err)
    return { ok: false, results: [], error: String(err) }
  }
}

export async function getProjectFlightsForSync(
  projectId: string,
): Promise<{
  ok: boolean
  flights: { flightId: string; flightPlanId: string; flightLabel: string }[]
  error?: string
}> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { ok: false, flights: [], error: 'Unauthorized' }
  }

  try {
    const activeFlights = await db
      .select({
        flightId: flights.id,
        flightPlanId: flights.flightPlanId,
        flightTimestamp: flights.timestamp,
        flightPlanName: flightPlans.name,
      })
      .from(flights)
      .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
      .where(
        and(
          eq(flightPlans.projectId, projectId),
          isNull(flights.deletedAt),
          isNull(flightPlans.deletedAt),
        ),
      )

    const mapped = activeFlights.map((r) => ({
      flightId: r.flightId,
      flightPlanId: r.flightPlanId,
      flightLabel: `${r.flightPlanName} (${new Date(r.flightTimestamp).toLocaleDateString()})`,
    }))

    return { ok: true, flights: mapped }
  } catch (err) {
    console.error('Failed to get project flights for sync:', err)
    return { ok: false, flights: [], error: String(err) }
  }
}

export async function backfillVideoMetadata(
  projectId: string,
): Promise<{ ok: boolean; updated: number; error?: string }> {
  const session = await getSession()
  if (!session || (session.role !== 'read-write' && session.role !== 'admin')) {
    return { ok: false, updated: 0, error: 'Unauthorized' }
  }
  try {
    const projectFlights = await db
      .select({ id: flights.id })
      .from(flights)
      .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
      .where(and(eq(flightPlans.projectId, projectId), isNull(flights.deletedAt), isNull(flightPlans.deletedAt)))

    if (projectFlights.length === 0) return { ok: true, updated: 0 }

    const flightIds = projectFlights.map((f) => f.id)
    const videoFiles = await db
      .select({ id: files.id, key: files.key })
      .from(files)
      .where(and(inArray(files.flightId, flightIds), isNull(files.durationSeconds)))

    const needsDuration = videoFiles.filter((f) => {
      const lower = f.key.toLowerCase()
      return lower.endsWith('.mp4') || lower.endsWith('.mov')
    })

    let updated = 0
    for (const f of needsDuration) {
      const durationSeconds = await extractVideoDurationOnly(f.key)
      if (durationSeconds) {
        await db.update(files).set({ durationSeconds }).where(eq(files.id, f.id))
        updated++
      }
    }
    return { ok: true, updated }
  } catch (err) {
    return { ok: false, updated: 0, error: String(err) }
  }
}

export async function updateFileDuration(
  fileId: string,
  durationSeconds: number,
): Promise<void> {
  const session = await getSession()
  if (!session) return
  await db.update(files).set({ durationSeconds }).where(eq(files.id, fileId))
}

export async function updateFileLocation(
  fileId: string,
  latitude: number | null,
  longitude: number | null,
): Promise<{ error?: string; ok?: boolean }> {
  const session = await getSession()
  if (!session || session.role === 'read') return { error: 'Unauthorized.' }

  await db
    .update(files)
    .set({ latitude, longitude })
    .where(eq(files.id, fileId))

  // Clear old tags and retag against geofences
  const { fileGeofenceTags } = await import('@/lib/schema')
  await db.delete(fileGeofenceTags).where(eq(fileGeofenceTags.fileId, fileId))

  if (latitude != null && longitude != null) {
    const [file] = await db.select({ id: files.id, flightId: files.flightId }).from(files).where(eq(files.id, fileId))
    if (file) {
      const { getProjectIdForFlight } = await import('@/lib/geofence-tagger')
      const projectId = await getProjectIdForFlight(file.flightId)
      if (projectId) {
        await tagFilesAgainstGeofences(projectId, [{ id: fileId, latitude, longitude }])
      }
    }
  }

  return { ok: true }
}

export async function updateBulkFileLocation(
  fileIds: string[],
  latitude: number,
  longitude: number,
): Promise<{ error?: string; updated?: number }> {
  const session = await getSession()
  if (!session || session.role === 'read') return { error: 'Unauthorized.' }

  if (fileIds.length === 0) return { updated: 0 }

  await db
    .update(files)
    .set({ latitude, longitude })
    .where(inArray(files.id, fileIds))

  // Clear old tags and retag against geofences
  const { fileGeofenceTags } = await import('@/lib/schema')
  await db.delete(fileGeofenceTags).where(inArray(fileGeofenceTags.fileId, fileIds))

  const [firstFile] = await db.select({ flightId: files.flightId }).from(files).where(eq(files.id, fileIds[0]))
  if (firstFile) {
    const { getProjectIdForFlight } = await import('@/lib/geofence-tagger')
    const projectId = await getProjectIdForFlight(firstFile.flightId)
    if (projectId) {
      const tagFiles = fileIds.map((id) => ({ id, latitude, longitude }))
      await tagFilesAgainstGeofences(projectId, tagFiles)
    }
  }

  return { updated: fileIds.length }
}

export async function updateVideoReview(
  fileId: string,
  status: ReviewStatus,
  rating: number | null,
): Promise<{ error?: string }> {
  const session = await getSession()
  if (!session || session.role === 'read') return { error: 'Unauthorized' }

  const now = new Date()
  await db.update(files).set({
    reviewStatus: status,
    reviewRating: rating ?? null,
    reviewedBy: status === 'not_reviewed' ? null : session.email,
    reviewedAt: status === 'reviewed' ? now : null,
  }).where(eq(files.id, fileId))

  return {}
}

export async function setVideoHidden(
  fileId: string,
  hidden: boolean,
): Promise<{ error?: string }> {
  const session = await getSession()
  if (!session || session.role === 'read') return { error: 'Unauthorized' }

  await db.update(files).set({ hidden }).where(eq(files.id, fileId))
  return {}
}

const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv']

export interface VideoRow {
  fileId: string
  key: string
  etag: string
  uploadedAt: string
  flightTimestamp: string
  flightNotes: string | null
  planName: string
  flightId: string
  flightPlanId: string
  fishCount: number | null
  durationSeconds: number | null
  locationTags: { name: string; color: string }[]
  latitude: number | null
  longitude: number | null
  reviewStatus: ReviewStatus
  reviewRating: number | null
  reviewedBy: string | null
  reviewedAt: string | null
  hidden: boolean
}

function localMidnightUTC(dateStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const noon = new Date(Date.UTC(y, m - 1, d, 12))
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(noon)
  const h = parseInt(parts.find((p) => p.type === 'hour')!.value)
  const mi = parseInt(parts.find((p) => p.type === 'minute')!.value)
  return new Date(noon.getTime() - (h * 60 + mi) * 60_000)
}

function getLocalDateStr(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}-${parts.find((p) => p.type === 'day')!.value}`
}

export async function loadVideosBefore(
  projectId: string,
  beforeDate: string,
  timezone: string,
): Promise<{ videos: VideoRow[]; hasMore: boolean }> {
  const session = await getSession()
  if (!session) return { videos: [], hasMore: false }

  const beforeUTC = localMidnightUTC(beforeDate, timezone)

  const plans = await db
    .select()
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), isNull(flightPlans.deletedAt)))
  if (plans.length === 0) return { videos: [], hasMore: false }

  const planIds = plans.map((p) => p.id)

  // Get flights before the cutoff, newest-first — enough to cover at least one full day
  const batch = await db
    .select()
    .from(flights)
    .where(and(
      inArray(flights.flightPlanId, planIds),
      isNull(flights.deletedAt),
      lt(flights.timestamp, beforeUTC),
    ))
    .orderBy(desc(flights.timestamp))
    .limit(200)

  if (batch.length === 0) return { videos: [], hasMore: false }

  // Isolate the most recent calendar day in this batch
  const newestDay = getLocalDateStr(batch[0].timestamp, timezone)
  const dayStart = localMidnightUTC(newestDay, timezone)
  const dayFlights = batch.filter((f) => f.timestamp >= dayStart)
  const hasMore = batch.length > dayFlights.length

  const flightIds = dayFlights.map((f) => f.id)
  const planMap = new Map(plans.map((p) => [p.id, p]))
  const flightMap = new Map(dayFlights.map((f) => [f.id, f]))

  const allFiles = await db
    .select()
    .from(files)
    .where(inArray(files.flightId, flightIds))

  const videoFiles = allFiles.filter((f) => VIDEO_EXTS.includes(f.key.split('.').pop()?.toLowerCase() ?? ''))
  const videoFileIds = videoFiles.map((f) => f.id)

  if (videoFileIds.length === 0) return { videos: [], hasMore }

  const [videoAnnotations, allGeofences, allTags] = await Promise.all([
    db.select().from(annotations)
      .where(and(inArray(annotations.fileId, videoFileIds), isNull(annotations.deletedAt))),
    db.select().from(geofences).where(eq(geofences.projectId, projectId)),
    db.select().from(fileGeofenceTags).where(inArray(fileGeofenceTags.fileId, videoFileIds)),
  ])

  const fishCountMap = new Map<string, number>()
  for (const a of videoAnnotations) {
    if (a.fileId && a.label === 'video-count') fishCountMap.set(a.fileId, a.fishCount)
  }

  const geofenceMap = new Map(allGeofences.map((g) => [g.id, g]))
  const tagsByFileId = new Map<string, { name: string; color: string }[]>()
  for (const tag of allTags) {
    const g = geofenceMap.get(tag.geofenceId)
    if (!g) continue
    const existing = tagsByFileId.get(tag.fileId) ?? []
    if (!existing.find((t) => t.name === g.name)) existing.push({ name: g.name, color: g.color })
    tagsByFileId.set(tag.fileId, existing)
  }

  const videos: VideoRow[] = videoFiles
    .map((f) => {
      const flight = flightMap.get(f.flightId)!
      const plan = planMap.get(flight.flightPlanId)!
      return {
        fileId: f.id,
        key: f.key,
        etag: f.etag,
        uploadedAt: f.uploadedAt.toISOString(),
        flightTimestamp: flight.timestamp.toISOString(),
        flightNotes: flight.notes,
        planName: plan.displayName || plan.name,
        flightId: flight.id,
        flightPlanId: flight.flightPlanId,
        fishCount: fishCountMap.get(f.id) ?? null,
        durationSeconds: f.durationSeconds ?? null,
        locationTags: tagsByFileId.get(f.id) ?? [],
        latitude: f.latitude ?? null,
        longitude: f.longitude ?? null,
        reviewStatus: f.reviewStatus,
        reviewRating: f.reviewRating ?? null,
        reviewedBy: f.reviewedBy ?? null,
        reviewedAt: f.reviewedAt?.toISOString() ?? null,
        hidden: f.hidden ?? false,
      }
    })
    .sort((a, b) => new Date(b.flightTimestamp).getTime() - new Date(a.flightTimestamp).getTime())

  return { videos, hasMore }
}

// ── Dataset page ───────────────────────────────────────────────────────────────

export interface DatasetEntry {
  fileId: string
  key: string
  etag: string
  split: Split | null
  imageWidth: number | null
  imageHeight: number | null
  size: number | null
  reviewRating: number | null
  durationSeconds: number | null
  flightId: string
  flightTimestampIso: string
  flightPlanName: string
  uploadedAtIso: string
}

const DATASET_PAGE_SIZE = 500

export async function loadDatasetEntriesBefore(
  projectId: string,
  beforeUploadedAt: string,
): Promise<{ entries: DatasetEntry[]; taskCounts: Record<string, number>; hasMore: boolean }> {
  const session = await getSession()
  if (!session) return { entries: [], taskCounts: {}, hasMore: false }

  const batch = await db
    .select({
      fileId: files.id,
      key: files.key,
      etag: files.etag,
      split: files.split,
      imageWidth: files.imageWidth,
      imageHeight: files.imageHeight,
      size: files.size,
      reviewRating: files.reviewRating,
      durationSeconds: files.durationSeconds,
      flightId: flights.id,
      flightTimestamp: flights.timestamp,
      flightPlanName: flightPlans.name,
      uploadedAt: files.uploadedAt,
    })
    .from(files)
    .innerJoin(flights, eq(files.flightId, flights.id))
    .innerJoin(flightPlans, eq(flights.flightPlanId, flightPlans.id))
    .where(and(
      eq(flightPlans.projectId, projectId),
      lt(files.uploadedAt, new Date(beforeUploadedAt)),
    ))
    .orderBy(desc(files.uploadedAt))
    .limit(DATASET_PAGE_SIZE + 1)

  const hasMore = batch.length > DATASET_PAGE_SIZE
  const page = batch.slice(0, DATASET_PAGE_SIZE)

  const entries: DatasetEntry[] = page.map(r => ({
    fileId: r.fileId,
    key: r.key,
    etag: r.etag,
    split: r.split ?? null,
    imageWidth: r.imageWidth ?? null,
    imageHeight: r.imageHeight ?? null,
    size: r.size ?? null,
    reviewRating: r.reviewRating ?? null,
    durationSeconds: r.durationSeconds ?? null,
    flightId: r.flightId,
    flightTimestampIso: r.flightTimestamp.toISOString(),
    flightPlanName: r.flightPlanName,
    uploadedAtIso: r.uploadedAt.toISOString(),
  }))

  const fileIds = page.map(r => r.fileId)
  const taskCounts: Record<string, number> = {}
  if (fileIds.length > 0) {
    const rows = await db
      .select({ fileId: labelingTasks.fileId, n: count() })
      .from(labelingTasks)
      .where(inArray(labelingTasks.fileId, fileIds))
      .groupBy(labelingTasks.fileId)
    for (const r of rows) taskCounts[r.fileId] = r.n
  }

  return { entries, taskCounts, hasMore }
}

