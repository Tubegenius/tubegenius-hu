// Starter Credit Contract v1 -- GET /api/credits fallback branch.
// The DB trigger (migration 091) is the primary starter-grant writer; this route
// only creates+grants for a user with NO user_credits row, and must never grant
// to a user whose row exists (no retroactive grant, no double grant).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STARTER_CREDIT, starterCreditExternalRef, starterCreditRpcArgs } from '@/lib/starter-credit'

const USER_ID = '22222222-2222-4222-8222-222222222222'

type QueryResult = { data: unknown; error: { code?: string; message?: string } | null }

const state = {
  user: { id: USER_ID } as { id: string } | null,
  selects: [] as QueryResult[],
  insertResult: { data: null, error: null } as QueryResult,
  rpcResult: { data: { duplicate: false }, error: null } as QueryResult,
  inserts: [] as unknown[],
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => state.selects.shift() ?? { data: null, error: { code: 'PGRST116' } } }) }),
      insert: async (row: unknown) => { state.inserts.push(row); return state.insertResult },
    }),
    rpc: async (name: string, args: unknown) => { state.rpcCalls.push({ name, args }); return state.rpcResult },
  }),
}))

import { GET } from '@/app/api/credits/route'

const ROW = {
  balance: 50, subscription_credit_balance: 50, purchased_credit_balance: 0, total_used: 0, plan: 'beta',
  monthly_allowance: 50, renews_at: '2026-10-20T00:00:00Z', subscription_status: 'free', stripe_customer_id: null,
}

beforeEach(() => {
  state.user = { id: USER_ID }
  state.selects = []
  state.insertResult = { data: null, error: null }
  state.rpcResult = { data: { duplicate: false }, error: null }
  state.inserts = []
  state.rpcCalls = []
})

describe('lib/starter-credit contract constants', () => {
  it('is the 50-credit subscription-bucket grant keyed initial:<user_id>', () => {
    expect(STARTER_CREDIT).toEqual({ amount: 50, bucket: 'subscription', cap: 50, reason: 'initial_credit', externalRefPrefix: 'initial:', plan: 'beta' })
    expect(starterCreditExternalRef(USER_ID)).toBe(`initial:${USER_ID}`)
    expect(starterCreditRpcArgs(USER_ID)).toEqual({
      p_user_id: USER_ID, p_delta: 50, p_bucket: 'subscription', p_cap: 50,
      p_external_ref: `initial:${USER_ID}`, p_reason: 'initial_credit', p_metadata: { plan: 'beta' },
    })
  })
})

describe('GET /api/credits', () => {
  it('unauthenticated -> 401, touches nothing', async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect(state.inserts).toHaveLength(0)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it('existing row (trigger-created, even with a 0 balance) -> returned as is, NO insert and NO grant', async () => {
    state.selects = [{ data: { ...ROW, balance: 0, subscription_credit_balance: 0 }, error: null }]
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).balance).toBe(0)
    expect(state.inserts).toHaveLength(0)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it('missing row (PGRST116) -> creates the row and issues exactly ONE starter grant with the canonical arguments', async () => {
    state.selects = [{ data: null, error: { code: 'PGRST116' } }, { data: ROW, error: null }]
    const res = await GET()
    expect(res.status).toBe(200)
    expect(state.inserts).toEqual([{ user_id: USER_ID }])
    expect(state.rpcCalls).toEqual([{ name: 'apply_bucket_credit_event', args: starterCreditRpcArgs(USER_ID) }])
    const body = await res.json()
    expect(body.balance).toBe(50)
    expect(body.total_available_credits).toBe(50)
  })

  it('transient read error (not PGRST116) on a user who may have a row -> 500, NO insert, NO grant (no retroactive grant)', async () => {
    state.selects = [{ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }]
    const res = await GET()
    expect(res.status).toBe(500)
    expect(state.inserts).toHaveLength(0)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it('insert loses a race (23505: the trigger/another request created the row) -> NO grant from the route, row re-read', async () => {
    state.selects = [{ data: null, error: { code: 'PGRST116' } }, { data: ROW, error: null }]
    state.insertResult = { data: null, error: { code: '23505' } }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toHaveLength(0)
    expect((await res.json()).balance).toBe(50)
  })

  it('other insert error -> 500 and no grant', async () => {
    state.selects = [{ data: null, error: { code: 'PGRST116' } }]
    state.insertResult = { data: null, error: { code: '42501' } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it('grant RPC failure -> 500 (no silent 0-credit success)', async () => {
    state.selects = [{ data: null, error: { code: 'PGRST116' } }]
    state.rpcResult = { data: null, error: { code: 'P0001', message: 'boom' } }
    const res = await GET()
    expect(res.status).toBe(500)
  })
})
