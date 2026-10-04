// Backend error contract (wave 1) -- strict request-lock acquisition.
// DB-free: the Supabase admin client is a hand-written fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type InsertResult = { data: { id: string } | null; error: { code?: string; message?: string; details?: string } | null }
const state = {
  insertResult: { data: { id: 'lock-1' }, error: null } as InsertResult,
  insertThrows: null as unknown,
  deleteResult: { error: null } as { error: { code?: string; message?: string } | null },
  deleteThrows: null as unknown,
  inserts: 0,
  deletes: 0,
  ltArgs: [] as Array<[string, string]>,
}

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    from: (table: string) => {
      expect(table).toBe('in_flight_requests')
      return {
        delete: () => {
          state.deletes += 1
          const chain: Record<string, unknown> = {}
          const self = () => chain
          chain.eq = self
          chain.lt = async (column: string, value: string) => { state.ltArgs.push([column, value]); if (state.deleteThrows) throw state.deleteThrows; return state.deleteResult }
          return chain
        },
        insert: () => {
          state.inserts += 1
          return { select: () => ({ single: async () => { if (state.insertThrows) throw state.insertThrows; return state.insertResult } }) }
        },
      }
    },
  }),
}))

import { LOCK_STALE_MARGIN_MS, LOCK_TTL_MS, LOCK_UNIQUE_INDEX, ROUTE_MAX_DURATION_MS, acquireRequestLock, acquireRequestLockStrict, isLockKeyViolation } from '@/lib/request-lock'

const KEY = { userId: '33333333-3333-4333-8333-333333333333', toolType: 'title_studio', inputHash: 'h' }
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.insertResult = { data: { id: 'lock-1' }, error: null }
  state.insertThrows = null
  state.deleteResult = { error: null }
  state.deleteThrows = null
  state.inserts = 0
  state.deletes = 0
  state.ltArgs = []
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { errorSpy.mockRestore() })

describe('acquireRequestLockStrict', () => {
  it('acquired -> status acquired with the lock id', async () => {
    expect(await acquireRequestLockStrict(KEY)).toEqual({ status: 'acquired', lockId: 'lock-1' })
  })

  it('a REAL conflict is exactly unique_violation 23505 -> conflict', async () => {
    state.insertResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_in_flight_requests_unique"' } }
    expect(await acquireRequestLockStrict(KEY)).toEqual({ status: 'conflict' })
  })

  it.each([
    ['57014 statement timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['08006 connection failure', { code: '08006', message: 'connection failure' }],
    ['PGRST301 JWT / API problem', { code: 'PGRST301', message: 'JWT expired' }],
    ['PGRST000 could not connect', { code: 'PGRST000', message: 'Could not connect to the database' }],
    ['network error (supabase-js empty code)', { code: '', message: 'TypeError: fetch failed' }],
    ['error without a code', { message: 'boom' }],
    ['42501 permission denied', { code: '42501', message: 'permission denied for table in_flight_requests' }],
  ])('%s -> unavailable (never a conflict)', async (_label, error) => {
    state.insertResult = { data: null, error }
    const result = await acquireRequestLockStrict(KEY)
    expect(result.status).toBe('unavailable')
    expect(state.inserts).toBe(1) // no hidden retry
  })

  it('a missing table (42P01) is unavailable -- there is NO fail-open any more', async () => {
    state.insertResult = { data: null, error: { code: '42P01', message: 'relation "in_flight_requests" does not exist' } }
    expect(await acquireRequestLockStrict(KEY)).toMatchObject({ status: 'unavailable', cause: '42P01' })
    expect(errorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')).toMatch(/request_lock_table_missing_or_unknown_to_api code=42P01.*CLOSED/)
  })

  it('PGRST205 (table unknown to the API schema cache) is unavailable and is NOT retried automatically', async () => {
    state.insertResult = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.in_flight_requests' in the schema cache" } }
    expect(await acquireRequestLockStrict(KEY)).toMatchObject({ status: 'unavailable', cause: 'PGRST205' })
    expect(state.inserts).toBe(1)
  })

  it('an insert that returns neither a row nor an error is unavailable', async () => {
    state.insertResult = { data: null, error: null }
    expect(await acquireRequestLockStrict(KEY)).toMatchObject({ status: 'unavailable', cause: 'no_row_returned' })
  })

  it('a thrown insert (fetch/abort) is unavailable, not an unhandled rejection', async () => {
    state.insertThrows = new TypeError('fetch failed')
    expect(await acquireRequestLockStrict(KEY)).toEqual({ status: 'unavailable', cause: 'thrown' })
  })

  it('a failing stale-lock cleanup is logged and does NOT block or fake the acquisition', async () => {
    state.deleteResult = { error: { code: '57014', message: 'timeout' } }
    expect(await acquireRequestLockStrict(KEY)).toEqual({ status: 'acquired', lockId: 'lock-1' })
    expect(errorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')).toContain('stale-lock cleanup failed')
  })

  it('a thrown cleanup is unavailable (fail closed), never acquired', async () => {
    state.deleteThrows = new Error('socket hang up')
    expect(await acquireRequestLockStrict(KEY)).toEqual({ status: 'unavailable', cause: 'thrown' })
    expect(state.inserts).toBe(0)
  })

  it('NEGATIVE CONTROL: only 23505 can be a conflict; no other code, including unknown ones, ever is', async () => {
    for (const code of ['23503', '23502', '40001', '40P01', '55P03', 'PGRST116', 'PGRST205', '42P01', 'XX000', '']) {
      state.insertResult = { data: null, error: { code, message: 'x' } }
      expect((await acquireRequestLockStrict(KEY)).status, code).toBe('unavailable')
    }
  })
})


describe('23505 must come from the lock-key unique index, not from just any constraint', () => {
  const DETAILS = 'Key (user_id, tool_type, input_hash)=(33333333-3333-4333-8333-333333333333, __user_paid_operation__, active) already exists.'
  it('the index name is the one migration 027 creates', async () => {
    const { readFileSync } = await import('node:fs')
    expect(LOCK_UNIQUE_INDEX).toBe('idx_in_flight_requests_unique')
    const sql = readFileSync('supabase/migrations/027_in_flight_request_locks.sql', 'utf8').replace(/\s+/g, ' ')
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_in_flight_requests_unique ON in_flight_requests(user_id, tool_type, input_hash)')
  })
  it('the real PostgREST shape (index name in message, key columns in details) -> conflict', async () => {
    state.insertResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_in_flight_requests_unique"', details: DETAILS } }
    expect(await acquireRequestLockStrict(KEY)).toEqual({ status: 'conflict' })
  })
  it('either identifier alone is enough (message-only / details-only)', async () => {
    expect(isLockKeyViolation({ code: '23505', message: `duplicate key value violates unique constraint "${LOCK_UNIQUE_INDEX}"` })).toBe(true)
    expect(isLockKeyViolation({ code: '23505', message: 'x', details: DETAILS })).toBe(true)
  })
  it.each([
    ['primary key', { code: '23505', message: 'duplicate key value violates unique constraint "in_flight_requests_pkey"', details: 'Key (id)=(abc) already exists.' }],
    ['a different table/index', { code: '23505', message: 'duplicate key value violates unique constraint "user_credits_pkey"', details: 'Key (user_id)=(abc) already exists.' }],
    ['no message and no details', { code: '23505' }],
  ])('23505 from %s -> unavailable (fail closed), never a "conflict"', async (_label, error) => {
    state.insertResult = { data: null, error }
    expect(await acquireRequestLockStrict(KEY)).toEqual({ status: 'unavailable', cause: '23505_other_constraint' })
    expect(errorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')).toContain('NOT attributable to the lock-key index')
  })
  it('the index name alone does not turn a NON-23505 error into a conflict', () => {
    expect(isLockKeyViolation({ code: '23503', message: LOCK_UNIQUE_INDEX, details: DETAILS })).toBe(false)
    expect(isLockKeyViolation(null)).toBe(false)
    expect(isLockKeyViolation('23505')).toBe(false)
  })
})

describe('lock TTL -- ONE shared 420 s threshold for both helpers (they share one table and one lock key)', () => {
  afterEach(() => { vi.useRealTimers() })
  const NOW = new Date('2026-10-03T12:00:00.000Z')
  const cutoff = () => Date.parse(state.ltArgs[0][1])
  const reaped = (ageMs: number) => NOW.getTime() - ageMs < cutoff() // a lock of that age is deleted

  async function cutoffOf(acquire: () => Promise<unknown>) {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    state.ltArgs = []
    await acquire()
    expect(state.ltArgs).toHaveLength(1)
    expect(state.ltArgs[0][0]).toBe('created_at')
    return cutoff()
  }

  it('constant: ceiling 300 s + 120 s margin = 420 s, margin >= 60 s, still short enough to recover from a crash', () => {
    expect(ROUTE_MAX_DURATION_MS).toBe(300_000)
    expect(LOCK_TTL_MS).toBe(420_000)
    expect(LOCK_TTL_MS).toBe(ROUTE_MAX_DURATION_MS + LOCK_STALE_MARGIN_MS)
    expect(LOCK_TTL_MS - ROUTE_MAX_DURATION_MS).toBeGreaterThanOrEqual(60_000)
    expect(LOCK_TTL_MS).toBeLessThanOrEqual(10 * 60_000)
  })

  it.each([
    ['strict', () => acquireRequestLockStrict(KEY)],
    ['legacy', () => acquireRequestLock(KEY)],
  ])('%s path: the cutoff is exactly now - 420 s; 0/299/300/301/419/420 s locks are kept, only older than 420 s is reaped', async (_label, acquire) => {
    expect(await cutoffOf(acquire)).toBe(NOW.getTime() - 420_000)
    for (const age of [0, 299_000, 300_000, 301_000, 419_000, 420_000]) expect(reaped(age), `age ${age}`).toBe(false)
    for (const age of [420_001, 421_000, 600_000]) expect(reaped(age), `age ${age}`).toBe(true)
  })

  it('both helpers compute the SAME cutoff', async () => {
    const strict = await cutoffOf(() => acquireRequestLockStrict(KEY))
    const legacy = await cutoffOf(() => acquireRequestLock(KEY))
    expect(strict).toBe(legacy)
  })


  it('source guard: exactly one TTL constant, used by both helpers; no second threshold', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/request-lock.ts', 'utf8')
    expect(src).not.toContain('STRICT_LOCK_TTL_MS')
    expect(src).not.toContain('5 * 60 * 1000')
    expect(src.match(/Date\.now\(\) - LOCK_TTL_MS/g)).toHaveLength(2)
    expect(src.match(/export const LOCK_TTL_MS/g)).toHaveLength(1)
  })
})

describe('acquireRequestLock (legacy) is untouched by wave 1 -- characterisation, so later waves migrate deliberately', () => {
  it('still fails OPEN for a missing table and still maps any other error to acquired:false', async () => {
    state.insertResult = { data: null, error: { code: '42P01', message: 'x' } }
    expect(await acquireRequestLock(KEY)).toEqual({ acquired: true })
    state.insertResult = { data: null, error: { code: '57014', message: 'x' } }
    expect(await acquireRequestLock(KEY)).toEqual({ acquired: false })
  })
})
