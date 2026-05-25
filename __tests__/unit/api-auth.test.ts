import { describe, it, expect, vi, beforeEach } from 'vitest'

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

  return {
    state,
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ run: vi.fn() })),
      })),
    })),
  }
})

vi.mock('@/lib/db', () => ({ db: mockDb }))

// ─── module under test ───────────────────────────────────────────────────────
import { hashApiKey, generateApiKey, validateApiKey } from '@/lib/api-auth'

// ─── tests ───────────────────────────────────────────────────────────────────
describe('hashApiKey', () => {
  it('returns a 64-char hex string', () => {
    const hash = hashApiKey('sockeye_test')
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic for the same input', () => {
    expect(hashApiKey('abc')).toBe(hashApiKey('abc'))
  })

  it('produces different hashes for different inputs', () => {
    expect(hashApiKey('key1')).not.toBe(hashApiKey('key2'))
  })
})

describe('generateApiKey', () => {
  it('starts with sockeye_ prefix', () => {
    expect(generateApiKey()).toMatch(/^sockeye_/)
  })

  it('is 64 hex chars after the prefix (32 bytes)', () => {
    const key = generateApiKey()
    const hex = key.slice('sockeye_'.length)
    expect(hex).toMatch(/^[a-f0-9]{64}$/)
  })

  it('generates unique keys each call', () => {
    expect(generateApiKey()).not.toBe(generateApiKey())
  })
})

describe('validateApiKey', () => {
  const fakeKey = {
    id: 'key-1',
    keyHash: hashApiKey('sockeye_validkey'),
    revokedAt: null,
    lastUsedAt: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.state.selectResult = []
  })

  it('returns null for a missing Authorization header', async () => {
    expect(await validateApiKey(null)).toBeNull()
  })

  it('returns null when header does not start with Bearer', async () => {
    expect(await validateApiKey('Basic abc')).toBeNull()
  })

  it('returns null when the key is not found in the db', async () => {
    mockDb.state.selectResult = []
    expect(await validateApiKey('Bearer sockeye_unknown')).toBeNull()
  })

  it('returns null for a revoked key', async () => {
    mockDb.state.selectResult = [{ ...fakeKey, revokedAt: new Date() }]
    expect(await validateApiKey('Bearer sockeye_validkey')).toBeNull()
  })

  it('returns the key row for a valid, non-revoked key', async () => {
    mockDb.state.selectResult = [fakeKey]
    const result = await validateApiKey('Bearer sockeye_validkey')
    expect(result).toMatchObject({ id: 'key-1' })
  })
})
