'use server'

import { db } from '@/lib/db'
import { files, flightPlans, flights } from '@/lib/schema'
import { eq, and, isNull, inArray, isNotNull } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { headObject, listFlightObjects } from '@/lib/s3'
import { randomUUID } from 'crypto'
import type { Split } from '@/lib/schema'
import { extractExifGps } from '@/lib/exif'
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
      .where(and(inArray(files.flightId, flightIds)))

    const needsDuration = videoFiles.filter((f) => {
      const lower = f.key.toLowerCase()
      return lower.endsWith('.mp4') || lower.endsWith('.mov')
    })

    let updated = 0
    for (const f of needsDuration) {
      const meta = await extractExifGps(f.key)
      if (meta?.durationSeconds) {
        await db.update(files).set({ durationSeconds: meta.durationSeconds }).where(eq(files.id, f.id))
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

