import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── mock api-auth ───────────────────────────────────────────────────────────
const mockValidateApiKey = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-auth', () => ({ validateApiKey: mockValidateApiKey }))

// ─── mock db ────────────────────────────────────────────────────────────────
const mockDb = vi.hoisted(() => {
  const state = { selectResult: [] as unknown[] }
  function makeChain(): Record<string, unknown> {
    const c: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy']) c[m] = vi.fn(() => c)
    c.then = (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResult).then(res, rej)
    c.catch = (rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResult).catch(rej)
    return c
  }
  return { state, select: vi.fn(() => makeChain()) }
})
vi.mock('@/lib/db', () => ({ db: mockDb }))

// ─── route under test ────────────────────────────────────────────────────────
import { GET } from '@/app/api/v1/projects/route'

// ─── helpers ─────────────────────────────────────────────────────────────────
function makeRequest(authHeader?: string) {
  return new NextRequest('http://localhost/api/v1/projects', {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

// ─── tests ───────────────────────────────────────────────────────────────────
describe('GET /api/v1/projects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.state.selectResult = []
  })

  it('returns 401 when no API key is provided', async () => {
    mockValidateApiKey.mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toMatchObject({ error: expect.any(String) })
  })

  it('returns 401 when API key is invalid', async () => {
    mockValidateApiKey.mockResolvedValue(null)
    const res = await GET(makeRequest('Bearer invalid'))
    expect(res.status).toBe(401)
  })

  it('returns 200 with an empty array when no projects exist', async () => {
    mockValidateApiKey.mockResolvedValue({ id: 'key-1' })
    mockDb.state.selectResult = []
    const res = await GET(makeRequest('Bearer sockeye_valid'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns 200 with shaped project objects', async () => {
    mockValidateApiKey.mockResolvedValue({ id: 'key-1' })
    mockDb.state.selectResult = [
      {
        id: 'proj-1',
        name: 'salmon-run',
        description: 'A test project',
        timezone: 'America/Vancouver',
        deletedAt: null,
        createdAt: new Date(),
      },
    ]
    const res = await GET(makeRequest('Bearer sockeye_valid'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      id: 'proj-1',
      name: 'salmon-run',
      description: 'A test project',
      timezone: 'America/Vancouver',
    })
  })

  it('does not leak internal fields (deletedAt, createdAt)', async () => {
    mockValidateApiKey.mockResolvedValue({ id: 'key-1' })
    mockDb.state.selectResult = [
      { id: 'p', name: 'n', description: null, timezone: 'UTC', deletedAt: null, createdAt: new Date() },
    ]
    const body = await (await GET(makeRequest('Bearer sockeye_valid'))).json()
    expect(body[0]).not.toHaveProperty('deletedAt')
    expect(body[0]).not.toHaveProperty('createdAt')
  })
})
