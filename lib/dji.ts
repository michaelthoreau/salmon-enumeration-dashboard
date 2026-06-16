/**
 * DJI FlightHub2 OpenAPI client + flight-tree builder + path-parsing helpers.
 *
 * Parsing functions (isChinookPath, parsePlanName, parseTimestamp, slugify)
 * are intentional TS ports of the Python equivalents in
 * dji-pipeline/lambda/webhook_handler.py. Keep them behaviourally in sync.
 */

const BASE_URL = 'https://es-flight-api-us.djigate.com'

export const FILE_TYPE_FOLDER = 1
export const FILE_TYPE_IMAGE  = 2
export const FILE_TYPE_VIDEO  = 3

export interface DjiMediaItem {
  id: string
  name: string
  suffix?: string
  file_type: number
  size?: number
  p_infos?: { pid: number }
  original_url?: string
  download_url?: string
  url?: string
}

export interface DjiFlight {
  fh2FilePath: string
  displayName:  string
  files:        DjiMediaItem[]
}

export interface DjiSession {
  token:   string
  orgUuid: string
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1]
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

export function getDjiSession(): DjiSession {
  const token = process.env.DJI_OPENAPI_KEY
  if (!token) throw new Error('DJI_OPENAPI_KEY environment variable is not set')
  const payload = decodeJwt(token)
  const orgUuid = (payload.organization_uuid as string) ?? ''
  return { token, orgUuid }
}

async function djiGet(
  session: DjiSession,
  path: string,
  params?: Record<string, string | number>,
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString(), {
    headers: {
      'X-User-Token': session.token,
      'Content-Type': 'application/json',
      'X-Language':   'en',
      'X-Request-Id': crypto.randomUUID(),
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`DJI API ${path} returned ${res.status}`)
  return res.json()
}

export async function listDjiProjects(
  session: DjiSession,
): Promise<{ uuid: string; name: string }[]> {
  const data = await djiGet(session, '/openapi/v0.1/project', { page: 1, page_size: 50 }) as Record<string, unknown>
  const list = ((data?.data as Record<string, unknown>)?.list ?? []) as Record<string, unknown>[]
  return list.map((p) => ({ uuid: p.uuid as string, name: (p.name as string) ?? 'unnamed' }))
}

export async function fetchAllDjiMedia(
  session: DjiSession,
  projUuid: string,
): Promise<DjiMediaItem[]> {
  const path    = `/media/api/v1/organizations/${session.orgUuid}/data-hub/files`
  const allItems: DjiMediaItem[] = []
  const seenIds  = new Set<string>()
  let page = 1

  while (true) {
    const resp = await djiGet(session, path, { proj_uuid: projUuid, page, page_size: 100 }) as Record<string, unknown>
    const batch = (
      ((resp?.data as Record<string, unknown>)?.list as DjiMediaItem[]) ??
      (resp?.list as DjiMediaItem[]) ??
      []
    )
    const newItems = batch.filter((i) => !seenIds.has(i.id))
    if (newItems.length === 0) break
    for (const item of newItems) seenIds.add(item.id)
    allItems.push(...newItems)
    page++
  }

  return allItems
}

export function buildFlightTree(allItems: DjiMediaItem[]): DjiFlight[] {
  const childrenOf = new Map<number, DjiMediaItem[]>()
  for (const item of allItems) {
    const pid = item.p_infos?.pid ?? 0
    if (!childrenOf.has(pid)) childrenOf.set(pid, [])
    childrenOf.get(pid)!.push(item)
  }

  const flights: DjiFlight[] = []
  const rootFolders = (childrenOf.get(0) ?? []).filter(
    (i) => i.file_type === FILE_TYPE_FOLDER,
  )

  for (const rootFolder of rootFolders) {
    const rootName = rootFolder.name ?? ''
    const rootId   = Number(rootFolder.id)
    const children = childrenOf.get(rootId) ?? []

    const childFolders = children.filter((c) => c.file_type === FILE_TYPE_FOLDER)
    const childFiles   = children.filter((c) => c.file_type !== FILE_TYPE_FOLDER)

    if (childFolders.length > 0) {
      // Chinook: root = drone ID, children = flight folders
      for (const flightFolder of childFolders) {
        const flightName = flightFolder.name ?? ''
        const flightId   = Number(flightFolder.id)
        const gcFiles    = (childrenOf.get(flightId) ?? []).filter(
          (f) => f.file_type !== FILE_TYPE_FOLDER,
        )
        if (gcFiles.length > 0) {
          flights.push({
            fh2FilePath: `${rootName}/${flightName}`,
            displayName: `${rootName}  /  ${flightName}`,
            files:       gcFiles,
          })
        }
      }
    } else if (childFiles.length > 0) {
      // Drone in the Box: root folder name IS the fh2FilePath
      flights.push({
        fh2FilePath: rootName,
        displayName: rootName,
        files:       childFiles,
      })
    }
  }

  // Newest first — folder name contains timestamp so lexicographic sort works
  flights.sort((a, b) => (a.fh2FilePath > b.fh2FilePath ? -1 : 1))
  return flights
}

// ─── Path-parsing helpers — keep in sync with webhook_handler.py ─────────────

export function isChinookPath(fh2FilePath: string): boolean {
  return fh2FilePath.includes('/')
}

export function parsePlanName(fh2FilePath: string): string {
  if (isChinookPath(fh2FilePath)) {
    const right = fh2FilePath.split('/').slice(1).join('/')
    const parts = right.split('_')
    if (parts.length >= 4) return parts.slice(3).join('_')
    return ''
  }
  const m = fh2FilePath.match(/^(.+?)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/)
  return m ? m[1].trim() : ''
}

export function parseTimestamp(fh2FilePath: string): string | null {
  if (isChinookPath(fh2FilePath)) {
    const right = fh2FilePath.split('/').slice(1).join('/')
    const m = right.match(/DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
    if (m) {
      const [, y, mo, d, h, mi] = m
      return `${y}-${mo}-${d}T${h}:${mi}:00`
    }
    return null
  }
  const m = fh2FilePath.match(/^.+?\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/)
  return m ? `${m[1]}T${m[2]}` : null
}

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

export function resolveFilename(f: DjiMediaItem): string {
  const name   = f.name ?? `file_${f.id}`
  const suffix = f.suffix ?? ''
  if (suffix && !name.toLowerCase().endsWith(`.${suffix.toLowerCase().replace(/^\.+/, '')}`)) {
    return `${name}.${suffix.replace(/^\.+/, '')}`
  }
  return name
}
