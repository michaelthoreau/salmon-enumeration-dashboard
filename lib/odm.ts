/**
 * NodeODM API client (status polling + result download).
 *
 * Task initialisation and image uploading are handled by the Modal worker
 * (modal/odm_worker.py) which runs without Next.js timeout constraints.
 *
 * Set ODM_NODE_URL to the base URL of your NodeODM instance, including the
 * token if required, e.g. http://your-odm-server:3000?token=abc123
 */

export type OdmStatusCode = 10 | 20 | 30 | 40 | 50

export const ODM_STATUS: Record<OdmStatusCode, string> = {
  10: 'queued',
  20: 'running',
  30: 'failed',
  40: 'completed',
  50: 'canceled',
}

export interface OdmTaskInfo {
  uuid: string
  name: string
  dateCreated: number
  status: { code: OdmStatusCode }
  processingTime: number
  imagesCount: number
  progress: number   // 0–100; provided by NodeODM during processing
  output?: string[]
}

/**
 * Build a full NodeODM endpoint URL, preserving any query params (e.g. token)
 * already present in ODM_NODE_URL and merging in any extra params.
 */
function odmUrl(path: string, extra?: Record<string, string>): string {
  const raw = process.env.ODM_NODE_URL
  if (!raw) throw new Error('ODM_NODE_URL environment variable is not set')
  const parsed = new URL(raw)
  if (extra) Object.entries(extra).forEach(([k, v]) => parsed.searchParams.set(k, v))
  parsed.pathname = path
  return parsed.toString()
}

/** Fetch task status and optional log lines starting at `outputLine`. */
export async function odmGetTaskInfo(
  odmUuid: string,
  outputLine = 0,
): Promise<OdmTaskInfo> {
  const res = await fetch(
    odmUrl(`/task/${odmUuid}/info`, { with_output: String(outputLine) }),
    { cache: 'no-store', signal: AbortSignal.timeout(30_000) },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ODM info failed (${res.status}): ${text}`)
  }
  return res.json() as Promise<OdmTaskInfo>
}

/**
 * Download the all.zip asset from a completed task as an ArrayBuffer.
 * The COG GeoTIFF lives at odm_orthophoto/odm_orthophoto.tif inside the zip.
 */
export async function odmDownloadAllZip(odmUuid: string): Promise<ArrayBuffer> {
  const res = await fetch(odmUrl(`/task/${odmUuid}/download/all.zip`), {
    cache: 'no-store',
    signal: AbortSignal.timeout(10 * 60_000), // 10 min — zip can be large
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ODM download failed (${res.status}): ${text}`)
  }
  return res.arrayBuffer()
}

