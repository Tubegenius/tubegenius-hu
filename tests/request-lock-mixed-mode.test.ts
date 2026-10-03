// Backend error contract (wave 1) -- MIXED MODE on the SHARED lock.
// The legacy helper (not-yet-migrated routes) and the strict helper (title-studio) use
// the same table and the same user-wide lock key, so they must agree on when a lock is
// stale. This file runs both helpers against ONE stateful in-memory table that honours
// the unique key and the created_at cutoff of the delete -- DB-free.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Row { id: string; user_id: string; tool_type: string; input_hash: string; created_at: number }
const table = { rows: [] as Row[], seq: 0 }

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    from: (name: string) => {
      expect(name).toBe('in_flight_requests')
      return {
        delete: () => {
          const filters: Array<(r: Row) => boolean> = []
          const chain: Record<string, unknown> = {}
          chain.eq = (col: keyof Row, value: unknown) => { filters.push(r => r[col] === value); return chain }
          // `.lt('created_at', iso)` runs the delete, like the real query (the stale cutoff)
          chain.lt = async (col: keyof Row, iso: string) => {
            const limit = Date.parse(iso)
            filters.push(r => (r[col] as number) < limit)
            table.rows = table.rows.filter(r => !filters.every(f => f(r)))
            return { error: null }
          }
          // plain release: delete().eq('id', lockId)
          ;(chain as { then?: unknown }).then = (resolve: (v: unknown) => void) => {
            table.rows = table.rows.filter(r => !filters.every(f => f(r)))
            resolve({ error: null })
          }
          return chain
        },
        insert: (row: { user_id: string; tool_type: string; input_hash: string }) => ({
          select: () => ({
            single: async () => {
              const clash = table.rows.some(r => r.user_id === row.user_id && r.tool_type === row.tool_type && r.input_hash === row.input_hash)
              if (clash) {
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_in_flight_requests_unique"', details: 'Key (user_id, tool_type, input_hash)=(x, __user_paid_operation__, active) already exists.' } }
              }
              const created: Row = { id: `lock-${++table.seq}`, ...row, created_at: Date.now() }
              table.rows.push(created)
              return { data: { id: created.id }, error: null }
            },
          }),
        }),
      }
    },
  }),
}))

import { LOCK_TTL_MS, acquireRequestLock, acquireRequestLockStrict, releaseRequestLock } from '@/lib/request-lock'

const KEY = { userId: '44444444-4444-4444-8444-444444444444', toolType: 'whatever', inputHash: 'h' }
const T0 = new Date('2026-10-03T12:00:00.000Z').getTime()
const S = 1000

/** Create a lock with the given helper at T0, then let `ageMs` pass. */
async function lockAged(by: 'strict' | 'legacy', ageMs: number): Promise<string> {
  vi.setSystemTime(T0)
  if (by === 'strict') {
    const r = await acquireRequestLockStrict(KEY)
    if (r.status !== 'acquired') throw new Error('setup: strict lock not acquired')
    vi.setSystemTime(T0 + ageMs)
    return r.lockId
  }
  const r = await acquireRequestLock(KEY)
  if (!r.acquired || !r.lockId) throw new Error('setup: legacy lock not acquired')
  vi.setSystemTime(T0 + ageMs)
  return r.lockId
}

beforeEach(() => {
  table.rows = []
  table.seq = 0
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('a lock younger than or exactly 420 s is NEVER reaped or re-acquired, in any helper combination', () => {
  const combos: Array<['strict' | 'legacy', 'strict' | 'legacy']> = [
    ['strict', 'legacy'], ['strict', 'strict'], ['legacy', 'strict'], ['legacy', 'legacy'],
  ]
  for (const [owner, contender] of combos) {
    for (const age of [299 * S, 300 * S, 301 * S, 350 * S, 419 * S, 420 * S]) {
      it(`${owner} lock aged ${age / S} s: a ${contender} acquire does not delete it and does not get the lock`, async () => {
        const lockId = await lockAged(owner, age)
        if (contender === 'legacy') expect(await acquireRequestLock(KEY)).toEqual({ acquired: false })
        else expect(await acquireRequestLockStrict(KEY)).toEqual({ status: 'conflict' })
        expect(table.rows).toHaveLength(1)
        expect(table.rows[0].id).toBe(lockId) // the original lock row is untouched
      })
    }
  }
})

describe('a lock genuinely OLDER than 420 s is reaped and the contender acquires a fresh one (crash recovery)', () => {
  const combos: Array<['strict' | 'legacy', 'strict' | 'legacy']> = [
    ['strict', 'legacy'], ['strict', 'strict'], ['legacy', 'strict'], ['legacy', 'legacy'],
  ]
  for (const [owner, contender] of combos) {
    for (const age of [LOCK_TTL_MS + 1, LOCK_TTL_MS + 1000, 600 * S]) {
      it(`${owner} lock aged ${age / S} s: a ${contender} acquire reaps it and acquires a NEW lock`, async () => {
        const staleId = await lockAged(owner, age)
        if (contender === 'legacy') {
          const r = await acquireRequestLock(KEY)
          expect(r.acquired).toBe(true)
          expect(r.lockId).toBeDefined()
          expect(r.lockId).not.toBe(staleId)
        } else {
          const r = await acquireRequestLockStrict(KEY)
          expect(r.status).toBe('acquired')
          if (r.status === 'acquired') expect(r.lockId).not.toBe(staleId)
        }
        expect(table.rows).toHaveLength(1)
        expect(table.rows[0].id).not.toBe(staleId)
      })
    }
  }
})

describe('boundary and lifecycle', () => {
  it('the cut is exact: at 420.000 s kept, at 420.001 s reaped (same instant, both helpers)', async () => {
    await lockAged('strict', LOCK_TTL_MS)
    expect(await acquireRequestLock(KEY)).toEqual({ acquired: false })
    vi.setSystemTime(T0 + LOCK_TTL_MS + 1)
    expect((await acquireRequestLock(KEY)).acquired).toBe(true)
  })

  it('a released lock is immediately available to either helper', async () => {
    const lockId = await lockAged('strict', 10 * S)
    await releaseRequestLock(lockId)
    expect(table.rows).toHaveLength(0)
    expect((await acquireRequestLock(KEY)).acquired).toBe(true)
  })

  it('the lock is user-wide: a different user is never blocked by this user\'s lock', async () => {
    await lockAged('strict', 100 * S)
    const other = await acquireRequestLockStrict({ ...KEY, userId: '66666666-6666-4666-8666-666666666666' })
    expect(other.status).toBe('acquired')
    expect(table.rows).toHaveLength(2)
  })

  it('the lock key does not depend on the tool: a legacy route of another tool is still blocked by a live strict lock', async () => {
    await lockAged('strict', 350 * S)
    expect(await acquireRequestLock({ ...KEY, toolType: 'video_package', inputHash: 'other' })).toEqual({ acquired: false })
  })

  it('NEGATIVE CONTROL (documents the bug this prevents): a 300 s reaper WOULD have deleted the 301-420 s strict lock', async () => {
    await lockAged('strict', 350 * S)
    const oldCutoff = Date.now() - 300 * S
    expect(table.rows[0].created_at < oldCutoff).toBe(true)
  })
})
