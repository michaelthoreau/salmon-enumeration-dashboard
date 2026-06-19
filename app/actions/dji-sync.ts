'use server'

import { db } from '@/lib/db'
import { flights, flightPlans } from '@/lib/schema'
import { eq, and, isNull, like } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import {
  getDjiSession,
  listDjiProjects as djiListProjects,
  fetchAllDjiMedia,
  buildFlightTree,
  isChinookPath,
  parsePlanName,
  parseTimestamp,
  slugify,
  resolveFilename,
  FILE_TYPE_FOLDER,
  FILE_TYPE_IMAGE,
  FILE_TYPE_VIDEO,
} from '@/lib/dji'
import { files } from '@/lib/schema'
import { sql } from 'drizzle-orm'

function canWrite(role: string) {
  return role === 'read-write' || role === 'admin'
}

export interface MissingFlight {
  fh2FilePath:  string
  displayName:  string
  planName:     string
  timestamp:    string | null
  imageCount:   number
  videoCount:   number
  fileCount:    number
}

// ─── List DJI projects ────────────────────────────────────────────────────────

export async function listDjiProjects(): Promise<{
  ok: boolean
  projects?: { uuid: string; name: string }[]
  error?: string
}> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) return { ok: false, error: 'Unauthorized' }

  try {
    const dji = getDjiSession()
    const projects = await djiListProjects(dji)
    return { ok: true, projects }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// ─── Diff: which DJI flights are not yet in the dashboard ────────────────────

export async function getDjiSyncDiff(
  projectId: string,
  djiProjectUuid: string,
): Promise<{ ok: boolean; flights?: MissingFlight[]; error?: string }> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) return { ok: false, error: 'Unauthorized' }

  try {
    const dji     = getDjiSession()
    const items   = await fetchAllDjiMedia(dji, djiProjectUuid)
    const tree    = buildFlightTree(items)

    const missing: MissingFlight[] = []

    for (const flight of tree) {
      const planName = parsePlanName(flight.fh2FilePath)
      if (!planName) continue // mirrors Lambda's skip

      const slug = slugify(planName)

      const [plan] = await db
        .select({ id: flightPlans.id })
        .from(flightPlans)
        .where(and(eq(flightPlans.projectId, projectId), eq(flightPlans.name, slug), isNull(flightPlans.deletedAt)))

      if (plan) {
        // Match by exact notes, or by Chinook flight name suffix to catch
        // the same flight stored with/without the drone ID prefix.
        const chinookSegment = isChinookPath(flight.fh2FilePath)
          ? (flight.fh2FilePath.includes('/') ? flight.fh2FilePath.split('/').slice(1).join('/') : flight.fh2FilePath)
          : null

        const [existing] = await db
          .select({ id: flights.id })
          .from(flights)
          .where(and(
            eq(flights.flightPlanId, plan.id),
            chinookSegment
              ? like(flights.notes, `%${chinookSegment}`)
              : eq(flights.notes, flight.fh2FilePath),
            isNull(flights.deletedAt),
          ))

        if (existing) continue // already synced
      }

      const imageCount = flight.files.filter((f) => f.file_type === FILE_TYPE_IMAGE).length
      const videoCount = flight.files.filter((f) => f.file_type === FILE_TYPE_VIDEO).length
      const fileCount  = flight.files.filter((f) => f.file_type !== FILE_TYPE_FOLDER).length

      missing.push({
        fh2FilePath: flight.fh2FilePath,
        displayName: flight.displayName,
        planName,
        timestamp:   parseTimestamp(flight.fh2FilePath),
        imageCount,
        videoCount,
        fileCount,
      })
    }

    return { ok: true, flights: missing }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// ─── Pull a single DJI flight via webhook ───────────────────────────────────

const WEBHOOK_URL =
  process.env.DJI_WEBHOOK_URL ??
  'https://dohhl47k9d.execute-api.us-east-1.amazonaws.com/prod/dji/notify'

export async function pullDjiFlight(
  projectId: string,
  djiProjectUuid: string,
  fh2FilePath: string,
): Promise<{
  ok: boolean
  flightLabel?: string
  total?: number
  error?: string
}> {
  const session = await getSession()
  if (!session || !canWrite(session.role)) return { ok: false, error: 'Unauthorized' }

  try {
    const dji   = getDjiSession()
    const items = await fetchAllDjiMedia(dji, djiProjectUuid)
    const tree  = buildFlightTree(items)

    const flight = tree.find((f) => f.fh2FilePath === fh2FilePath)
    if (!flight) return { ok: false, error: `Flight not found in DJI data: ${fh2FilePath}` }

    const mediaFiles = flight.files.filter((f) => f.file_type !== FILE_TYPE_FOLDER)

    const payload = {
      type:       'sync_flight',
      org_id:     dji.orgUuid,
      project_id: djiProjectUuid,
      data: {
        fh2_file_path: fh2FilePath,
        files: mediaFiles.map((f) => ({
          id:           f.id,
          name:         resolveFilename(f),
          suffix:       f.suffix ?? '',
          size:         f.size ?? 0,
          download_url: f.original_url ?? f.download_url ?? f.url ?? '',
        })),
      },
    }

    // API Gateway has a 29s timeout but the Lambda continues running behind it.
    // A 504 (gateway timeout) is expected for large flights — the Lambda keeps
    // downloading in the background and we poll for progress.
    try {
      const resp = await fetch(WEBHOOK_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(30_000),
      })
      if (!resp.ok && resp.status !== 504) {
        return { ok: false, error: `Webhook returned ${resp.status}` }
      }
    } catch (fetchErr) {
      // Timeout is expected — Lambda is still running
      if (!(fetchErr instanceof DOMException && fetchErr.name === 'TimeoutError')) {
        throw fetchErr
      }
    }

    return {
      ok:          true,
      flightLabel: flight.displayName,
      total:       mediaFiles.length,
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// ─── Poll sync progress ─────────────────────────────────────────────────────

export async function getSyncProgress(
  projectId: string,
  fh2FilePath: string,
): Promise<{ fileCount: number }> {
  const planName = parsePlanName(fh2FilePath)
  if (!planName) return { fileCount: 0 }

  const slug = slugify(planName)

  const chinookSegment = isChinookPath(fh2FilePath)
    ? (fh2FilePath.includes('/') ? fh2FilePath.split('/').slice(1).join('/') : fh2FilePath)
    : null

  const [plan] = await db
    .select({ id: flightPlans.id })
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), eq(flightPlans.name, slug), isNull(flightPlans.deletedAt)))

  if (!plan) return { fileCount: 0 }

  const [flight] = await db
    .select({ id: flights.id })
    .from(flights)
    .where(and(
      eq(flights.flightPlanId, plan.id),
      chinookSegment
        ? like(flights.notes, `%${chinookSegment}`)
        : eq(flights.notes, fh2FilePath),
      isNull(flights.deletedAt),
    ))

  if (!flight) return { fileCount: 0 }

  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(eq(files.flightId, flight.id))

  return { fileCount: result?.count ?? 0 }
}
