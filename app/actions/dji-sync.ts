'use server'

import { db } from '@/lib/db'
import { flights, flightPlans } from '@/lib/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import {
  getDjiSession,
  listDjiProjects as djiListProjects,
  fetchAllDjiMedia,
  buildFlightTree,
  parsePlanName,
  parseTimestamp,
  slugify,
  resolveFilename,
  FILE_TYPE_FOLDER,
  FILE_TYPE_IMAGE,
  FILE_TYPE_VIDEO,
} from '@/lib/dji'
import { uploadStream } from '@/lib/s3'

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
    console.log('[DJI-SYNC] Total media items from DJI:', items.length)
    const tree    = buildFlightTree(items)
    console.log('[DJI-SYNC] Flight tree:', tree.map(f => ({ path: f.fh2FilePath, fileCount: f.files.length })))

    const missing: MissingFlight[] = []

    for (const flight of tree) {
      const planName = parsePlanName(flight.fh2FilePath)
      console.log('[DJI-SYNC] Flight:', flight.fh2FilePath, '→ planName:', planName)
      if (!planName) continue // mirrors Lambda's skip

      const slug = slugify(planName)

      const [plan] = await db
        .select({ id: flightPlans.id })
        .from(flightPlans)
        .where(and(eq(flightPlans.projectId, projectId), eq(flightPlans.name, slug), isNull(flightPlans.deletedAt)))

      if (plan) {
        const [existing] = await db
          .select({ id: flights.id })
          .from(flights)
          .where(and(eq(flights.flightPlanId, plan.id), eq(flights.notes, flight.fh2FilePath), isNull(flights.deletedAt)))

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

// ─── Pull a single DJI flight into the dashboard ─────────────────────────────

export async function pullDjiFlight(
  projectId: string,
  djiProjectUuid: string,
  fh2FilePath: string,
): Promise<{
  ok: boolean
  flightLabel?: string
  total?: number
  succeeded?: number
  failed?: string[]
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

    const webhookUrl =
      process.env.DJI_WEBHOOK_URL ??
      'https://dohhl47k9d.execute-api.us-east-1.amazonaws.com/prod/dji/notify'

    let succeeded = 0
    const failed: string[] = []

    for (const f of mediaFiles) {
      const name        = resolveFilename(f)
      const downloadUrl = f.original_url ?? f.download_url ?? f.url

      if (!downloadUrl) {
        failed.push(`${name}: no download URL`)
        continue
      }

      const s3Key = `landing/fh_sync/${dji.orgUuid}/${djiProjectUuid}/media/${f.id}/${name}`

      try {
        // Stream DJI → S3 landing zone
        const dlResp = await fetch(downloadUrl, { signal: AbortSignal.timeout(300_000) })
        if (!dlResp.ok || !dlResp.body) throw new Error(`DJI download returned ${dlResp.status}`)
        await uploadStream(s3Key, dlResp.body)

        // Fire existing Lambda webhook synchronously — it creates/matches flight plan+flight,
        // moves the object to its final S3 location, and registers it in the files table.
        const webhookPayload = JSON.stringify({
          type:       'sync_file_success',
          org_id:     dji.orgUuid,
          project_id: djiProjectUuid,
          data: {
            fh2_file_path:    fh2FilePath,
            file_bytes_size:  f.size ?? 0,
            file_external_key: s3Key,
            file_id:          f.id,
            file_type:        'media',
          },
        })

        const hookResp = await fetch(webhookUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    webhookPayload,
          signal:  AbortSignal.timeout(30_000),
        })

        if (!hookResp.ok) throw new Error(`Webhook returned ${hookResp.status}`)
        succeeded++
      } catch (err) {
        failed.push(`${name}: ${String(err)}`)
      }
    }

    return {
      ok:         true,
      flightLabel: flight.displayName,
      total:      mediaFiles.length,
      succeeded,
      failed,
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
