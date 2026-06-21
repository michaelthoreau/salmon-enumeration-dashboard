import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── mock session ────────────────────────────────────────────────────────────
const mockGetSession = vi.hoisted(() => vi.fn())
vi.mock('@/lib/session', () => ({ getSession: mockGetSession }))

// ─── mock db ─────────────────────────────────────────────────────────────────
const mockDb = vi.hoisted(() => {
  const state = { rows: [] as unknown[][] }   // per-select-call results (FIFO)

  function makeChain(): Record<string, unknown> {
    const c: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy']) c[m] = vi.fn(() => c)
    // Each chain consumes the first entry in state.rows
    c.then = (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(state.rows.shift() ?? []).then(res, rej)
    c.catch = (rej: (e: unknown) => unknown) =>
      Promise.resolve([]).catch(rej)
    return c
  }

  return {
    state,
    select: vi.fn(() => makeChain()),
  }
})
vi.mock('@/lib/db', () => ({ db: mockDb }))

// ─── mock s3 ─────────────────────────────────────────────────────────────────
const mockCreatePresignedUploadPost = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    url: 'https://bucket.s3.amazonaws.com',
    fields: { key: 'test-key' },
  }),
)
vi.mock('@/lib/s3', () => ({
  createPresignedUploadPost: mockCreatePresignedUploadPost,
  flightPrefix: vi.fn(() => 'projects/proj-1/fp-1/flight-1/'),
}))

// ─── route under test ────────────────────────────────────────────────────────
import { POST } from '@/app/api/upload/presign/route'

// ─── fixtures ────────────────────────────────────────────────────────────────
const ADMIN_SESSION = { userId: 'u1', email: 'admin@test.com', role: 'admin' }
const FLIGHT = { id: 'flight-1', flightPlanId: 'fp-1', deletedAt: null }
const FLIGHT_PLAN = { id: 'fp-1', projectId: 'proj-1', deletedAt: null }
const PROJECT = { id: 'proj-1', name: 'test', deletedAt: null }

function makePost(body: unknown, session = ADMIN_SESSION) {
  mockGetSession.mockResolvedValue(session)
  return new NextRequest('http://localhost/api/upload/presign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ─── tests ───────────────────────────────────────────────────────────────────
describe('POST /api/upload/presign', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.state.rows = []
  })

  it('returns 403 when unauthenticated', async () => {
    mockGetSession.mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/upload/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
  })

  it('returns 403 for read-only users', async () => {
    const res = await POST(
      makePost({ flightId: 'f1', files: [] }, { userId: 'u2', email: 'r@t.com', role: 'read' }),
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 when body has no flightId', async () => {
    const res = await POST(makePost({ files: [{ name: 'a.jpg', type: 'image/jpeg', size: 100 }] }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when files array is empty', async () => {
    const res = await POST(makePost({ flightId: 'flight-1', files: [] }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when files array exceeds 500', async () => {
    const files = Array.from({ length: 501 }, (_, i) => ({
      name: `f${i}.jpg`,
      type: 'image/jpeg',
      size: 100,
    }))
    const res = await POST(makePost({ flightId: 'flight-1', files }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when the flight does not exist', async () => {
    mockDb.state.rows = [[]]   // select for flight returns empty
    const res = await POST(
      makePost({ flightId: 'nope', files: [{ name: 'a.jpg', type: 'image/jpeg', size: 100 }] }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for a disallowed file type', async () => {
    mockDb.state.rows = [[FLIGHT], [FLIGHT_PLAN], [PROJECT]]
    const res = await POST(
      makePost({
        flightId: 'flight-1',
        files: [{ name: 'script.exe', type: 'application/x-msdownload', size: 100 }],
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when a file exceeds 5 GB', async () => {
    mockDb.state.rows = [[FLIGHT], [FLIGHT_PLAN], [PROJECT]]
    const res = await POST(
      makePost({
        flightId: 'flight-1',
        files: [{ name: 'huge.jpg', type: 'image/jpeg', size: 6 * 1024 * 1024 * 1024 }],
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for .tif or .tiff files', async () => {
    mockDb.state.rows = [[FLIGHT], [FLIGHT_PLAN], [PROJECT]]
    const res = await POST(
      makePost({
        flightId: 'flight-1',
        files: [{ name: 'photo.tiff', type: 'image/tiff', size: 1024 }],
      }),
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('TIFF files')
  })

  it('returns 200 with presigned upload data for valid request', async () => {
    mockDb.state.rows = [[FLIGHT], [FLIGHT_PLAN], [PROJECT]]
    const res = await POST(
      makePost({
        flightId: 'flight-1',
        files: [{ name: 'photo.jpg', type: 'image/jpeg', size: 1024 }],
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('uploads')
    expect(body.uploads).toHaveLength(1)
    expect(body.uploads[0]).toMatchObject({ name: 'photo.jpg', url: expect.any(String) })
  })

  it('sanitizes file names with path separators', async () => {
    mockDb.state.rows = [[FLIGHT], [FLIGHT_PLAN], [PROJECT]]
    await POST(
      makePost({
        flightId: 'flight-1',
        files: [{ name: '../../../etc/passwd', type: 'image/jpeg', size: 100 }],
      }),
    )
    const calledWith = mockCreatePresignedUploadPost.mock.calls[0]
    // The sanitized file name passed to S3 must not contain slashes
    const sanitizedName = calledWith?.[3] as string
    expect(sanitizedName).not.toContain('/')
    expect(sanitizedName).not.toContain('\\')
  })
})
