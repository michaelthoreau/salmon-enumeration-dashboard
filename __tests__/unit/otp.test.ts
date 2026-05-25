import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── mock db ────────────────────────────────────────────────────────────────
const mockDb = vi.hoisted(() => {
  const state = {
    selectResult: [] as unknown[],
    insertCalls: [] as unknown[],
    updateCalls: [] as unknown[],
  }

  function makeSelectChain(): Record<string, unknown> {
    const c: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy']) c[m] = vi.fn(() => c)
    c.then = (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResult).then(res, rej)
    c.catch = (rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResult).catch(rej)
    return c
  }

  const mockInsertValues = vi.fn(async (vals: unknown) => {
    state.insertCalls.push(vals)
  })
  const mockUpdateWhere = vi.fn(async (vals: unknown) => {
    state.updateCalls.push(vals)
  })

  return {
    state,
    mockInsertValues,
    mockUpdateWhere,
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: mockUpdateWhere, run: vi.fn() })),
    })),
  }
})

vi.mock('@/lib/db', () => ({ db: mockDb }))

// ─── module under test ───────────────────────────────────────────────────────
import { createOtp, verifyOtp } from '@/lib/otp'

// ─── tests ───────────────────────────────────────────────────────────────────
describe('createOtp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.state.insertCalls = []
  })

  it('returns a 6-digit numeric string', async () => {
    const code = await createOtp('user@example.com')
    expect(code).toMatch(/^\d{6}$/)
  })

  it('inserts a row with the hashed code (not plaintext)', async () => {
    const code = await createOtp('user@example.com')
    expect(mockDb.state.insertCalls).toHaveLength(1)
    const inserted = mockDb.state.insertCalls[0] as Record<string, unknown>
    // The stored hash must NOT equal the plaintext code
    expect(inserted.codeHash).not.toBe(code)
    // Must be a 64-char hex SHA-256
    expect(inserted.codeHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('inserts with the provided email', async () => {
    await createOtp('alice@test.com')
    const inserted = mockDb.state.insertCalls[0] as Record<string, unknown>
    expect(inserted.email).toBe('alice@test.com')
  })

  it('sets an expiry ~10 minutes in the future', async () => {
    const before = Date.now()
    await createOtp('user@example.com')
    const after = Date.now()
    const inserted = mockDb.state.insertCalls[0] as Record<string, string>
    const expiry = new Date(inserted.expiresAt).getTime()
    expect(expiry).toBeGreaterThan(before + 9 * 60 * 1000)
    expect(expiry).toBeLessThan(after + 11 * 60 * 1000)
  })

  it('generates different codes for successive calls', async () => {
    const c1 = await createOtp('a@a.com')
    const c2 = await createOtp('a@a.com')
    // Statistically extremely unlikely to collide
    expect(c1).not.toBe(c2)
  })
})

describe('verifyOtp', () => {
  const baseOtp = {
    id: 'otp-1',
    email: 'user@example.com',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    usedAt: null,
    // We derive the hash below after importing the hashing logic
    codeHash: '',
  }

  // Access the internal hash function via verifyOtp test (create an OTP so we
  // know what hash to store).  We do this by capturing the insert call.
  async function seedOtp(email: string): Promise<{ code: string; otp: typeof baseOtp }> {
    mockDb.state.insertCalls = []
    const code = await createOtp(email)
    const inserted = mockDb.state.insertCalls[0] as typeof baseOtp
    return { code, otp: { ...baseOtp, ...inserted } }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.state.selectResult = []
    mockDb.state.insertCalls = []
    mockDb.state.updateCalls = []
  })

  it('returns false when no matching OTP is found', async () => {
    mockDb.state.selectResult = []
    expect(await verifyOtp('user@example.com', '123456')).toBe(false)
  })

  it('returns true and marks usedAt when OTP matches', async () => {
    const { code, otp } = await seedOtp('user@example.com')
    mockDb.state.selectResult = [otp]
    const result = await verifyOtp('user@example.com', code)
    expect(result).toBe(true)
    // The OTP should be marked as used
    expect(mockDb.mockUpdateWhere).toHaveBeenCalled()
  })

  it('returns false for a wrong code', async () => {
    // The DB WHERE clause filters by codeHash; a wrong code produces a
    // different hash so the query returns no rows.
    mockDb.state.selectResult = []
    expect(await verifyOtp('user@example.com', '000000')).toBe(false)
  })
})
