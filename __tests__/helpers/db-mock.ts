import { vi } from 'vitest'

/**
 * Creates a mock of the Drizzle ORM `db` object.
 *
 * Each call creates fresh vi.fn() instances. Call `resetDbMock(mock)` in
 * beforeEach to clear call history between tests.
 *
 * Default behaviour: selects resolve to [], inserts/updates resolve to
 * undefined.  Override per-test by calling e.g.
 *   mock.selectResult = [{ id: '1', name: 'test' }]
 * before the code under test runs.
 */
export function createDbMock() {
  // We use a mutable ref so tests can override the resolved value.
  const state = {
    selectResult: [] as unknown[],
    insertResult: undefined as unknown,
    updateResult: undefined as unknown,
  }

  /**
   * A chainable object that is also thenable so `await db.select().from().where()`
   * (or any length of chain) resolves to `state.selectResult`.
   */
  function makeSelectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {}
    for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
      chain[method] = vi.fn(() => chain)
    }
    chain.then = (
      onFulfilled: (v: unknown[]) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(state.selectResult).then(onFulfilled, onRejected)
    chain.catch = (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResult).catch(onRejected)
    chain.finally = (cb: () => void) => Promise.resolve(state.selectResult).finally(cb)
    return chain
  }

  const mock = {
    state,

    select: vi.fn(() => makeSelectChain()),

    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue(state.insertResult),
    })),

    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(state.updateResult),
        run: vi.fn(),
      })),
    })),

    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(state.updateResult),
    })),
  }

  return mock
}

export type DbMock = ReturnType<typeof createDbMock>

/** Reset all call counts and restore default resolved values. */
export function resetDbMock(mock: DbMock) {
  mock.state.selectResult = []
  mock.state.insertResult = undefined
  mock.state.updateResult = undefined
  vi.clearAllMocks()
}
