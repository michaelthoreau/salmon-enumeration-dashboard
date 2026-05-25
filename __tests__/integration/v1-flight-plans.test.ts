import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── mock api-auth ───────────────────────────────────────────────────────────
const mockValidateApiKey = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-auth', () => ({ validateApiKey: mockValidateApiKey }))

// ─── mock db ────────────────────────────────────────────────────────────────
const mockDb = vi.hoisted(() => {
  const state = {
    selectResult: [] as unknown[],
    insertedValues: null as unknown,
  }
  function makeChain(): Record<string, unknown> {
    const c: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy', 'and']) c[m] = vi.fn(() => c)
    c.then = (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResult).then(res, rej)
    c.catch = (rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResult).catch(rej)
    return c
  }
  const mockValues = vi.fn(async (vals: unknown) => {
    state.insertedValues = vals
  })
  return {
    state,
    mockValues,
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => ({ values: mockValues })),
  }
})
vi.mock('@/lib/db', () => ({ db: mockDb }))

// ─── route under test ────────────────────────────────────────────────────────
import { GET, POST } from '@/app/api/v1/flight-plans/route'

// ─── helpers ─────────────────────────────────────────────────────────────────
function makeGet(url: string, authHeader?: string) {
  return new NextRequest(url, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePost(body: unknown, authHeader = 'Bearer sockeye_valid') {
  return new NextRequest('http://localhost/api/v1/flight-plans', {
    method: 'POST',
    headers: { authorization: authHeader, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID_KEY = { id: 'key-1' }
const EXISTING_PROJECT = {
  id: 'proj-1',
  name: 'salmon-run',
  description: null,
  timezone: 'UTC',
  deletedAt: null,
  createdAt: new Date(),
}

// ─── tests ───────────────────────────────────────────────────────────────────
describe('GET /api/v1/flight-plans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.state.selectResult = []
    mockDb.state.insertedValues = null
  })

  it('returns 401 with no auth', async () => {
    mockValidateApiKey.mockResolvedValue(null)
    const res = await GET(makeGet('http://localhost/api/v1/flight-plans'))
    expect(res.status).toBe(401)
  })

  it('returns 400 when projectId query param is missing', async () => {
    mockValidateApiKey.mockResolvedValue(VALID_KEY)
    const res = await GET(makeGet('http://localhost/api/v1/flight-plans', 'Bearer sockeye_valid'))
    expect(res.status).toBe(400)
  })

  it('returns 200 with array when projectId is provided', async () => {
    mockValidateApiKey.mockResolvedValue(VALID_KEY)
    mockDb.state.selectResult = [
      { id: 'fp-1', name: 'plan-a', description: null, createdAt: new Date() },
    ]
    const res = await GET(
      makeGet('http://localhost/api/v1/flight-plans?projectId=proj-1', 'Bearer sockeye_valid'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ id: 'fp-1', name: 'plan-a' })
  })
})

describe('POST /api/v1/flight-plans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.state.selectResult = []
    mockDb.state.insertedValues = null
  })

  it('returns 401 with no auth', async () => {
    mockValidateApiKey.mockResolvedValue(null)
    const res = await POST(makePost({ projectId: 'p', name: 'test' }, undefined))
    expect(res.status).toBe(401)
  })

  it('returns 400 when body is missing projectId', async () => {
    mockValidateApiKey.mockResolvedValue(VALID_KEY)
    const res = await POST(makePost({ name: 'test' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when body is missing name', async () => {
    mockValidateApiKey.mockResolvedValue(VALID_KEY)
    const res = await POST(makePost({ projectId: 'proj-1' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when project does not exist', async () => {
    mockValidateApiKey.mockResolvedValue(VALID_KEY)
    mockDb.state.selectResult = []   // no project found
    const res = await POST(makePost({ projectId: 'nope', name: 'plan' }))
    expect(res.status).toBe(404)
  })

  it('returns 201 and inserts a new flight plan', async () => {
    mockValidateApiKey.mockResolvedValue(VALID_KEY)
    // First select call returns the project; subsequent calls would return []
    mockDb.state.selectResult = [EXISTING_PROJECT]
    const res = await POST(makePost({ projectId: 'proj-1', name: 'Survey Alpha' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ name: 'survey-alpha' })
    expect(typeof body.id).toBe('string')
  })

  it('slugifies the flight plan name', async () => {
    mockValidateApiKey.mockResolvedValue(VALID_KEY)
    mockDb.state.selectResult = [EXISTING_PROJECT]
    const res = await POST(makePost({ projectId: 'proj-1', name: '  My  Survey!!  ' }))
    expect(res.status).toBe(201)
    // spaces → single dash; special chars stripped; trimmed → 'my-survey'
    expect((await res.json()).name).toBe('my-survey')
  })

  it('returns 400 when the slugified name is empty', async () => {
    mockValidateApiKey.mockResolvedValue(VALID_KEY)
    mockDb.state.selectResult = [EXISTING_PROJECT]
    const res = await POST(makePost({ projectId: 'proj-1', name: '!!!' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid JSON', async () => {
    mockValidateApiKey.mockResolvedValue(VALID_KEY)
    const req = new NextRequest('http://localhost/api/v1/flight-plans', {
      method: 'POST',
      headers: { authorization: 'Bearer sockeye_valid', 'content-type': 'application/json' },
      body: 'not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})
