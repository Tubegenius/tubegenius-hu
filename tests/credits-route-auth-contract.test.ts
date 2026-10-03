// Backend error contract (wave 1) -- GET /api/credits.
// This endpoint's 401 makes the client end the session (hard redirect to the login
// page), so it must answer 401 ONLY for a proven missing/invalid session and 503 for
// a Supabase network/gateway/unknown failure. DB-free: supabase is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'

const USER_ID = '44444444-4444-4444-8444-444444444444'
const state = {
  getUser: (async () => ({ data: { user: { id: USER_ID } }, error: null })) as () => Promise<unknown>,
  adminTouched: 0,
  row: { balance: 40, subscription_credit_balance: 40, purchased_credit_balance: 0, total_used: 10, plan: 'beta', monthly_allowance: 50, renews_at: null, subscription_status: 'free', stripe_customer_id: null },
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: () => state.getUser() } }),
  createAdminClient: () => {
    state.adminTouched += 1
    return {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: state.row, error: null }) }) }) }),
      rpc: async () => ({ data: null, error: null }),
    }
  },
}))

import { GET } from '@/app/api/credits/route'

const req = () => new Request('http://localhost/api/credits', { headers: { 'x-vercel-id': 'iad1::test-1' } })

beforeEach(() => {
  state.getUser = async () => ({ data: { user: { id: USER_ID } }, error: null })
  state.adminTouched = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/credits -- 401 only for a proven missing/invalid session', () => {
  it('no session cookie (AuthSessionMissingError) -> 401 unauthenticated; DB untouched', async () => {
    state.getUser = async () => ({ data: { user: null }, error: new AuthSessionMissingError() })
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Nem vagy bejelentkezve', code: 'unauthenticated', retryable: false })
    expect(state.adminTouched).toBe(0)
  })

  it('invalid / expired JWT (AuthApiError bad_jwt) -> 401', async () => {
    state.getUser = async () => ({ data: { user: null }, error: new AuthApiError('invalid JWT', 401, 'bad_jwt') })
    expect((await GET(req())).status).toBe(401)
    expect(state.adminTouched).toBe(0)
  })

  it('no user and no error object (legacy mock shape) -> 401 as before', async () => {
    state.getUser = async () => ({ data: { user: null } })
    expect((await GET(req())).status).toBe(401)
  })
})

describe('GET /api/credits -- a Supabase failure is a 503 and can NEVER sign the user out', () => {
  it.each([
    ['network error', new AuthRetryableFetchError('fetch failed', 0)],
    ['gateway 502', new AuthRetryableFetchError('bad gateway', 502)],
    ['gateway 503', new AuthRetryableFetchError('unavailable', 503)],
    ['gateway 504', new AuthRetryableFetchError('timeout', 504)],
    ['401 without an auth error code (gateway / API-key problem)', new AuthApiError('Invalid authentication credentials', 401, undefined)],
    ['unknown error', new Error('boom')],
  ])('%s -> 503 auth_unavailable, retryable, no-store, Retry-After; DB untouched', async (_label, error) => {
    state.getUser = async () => ({ data: { user: null }, error })
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'auth_unavailable', retryable: true, request_id: 'iad1::test-1' })
    expect(body.error).not.toMatch(/Nem vagy bejelentkezve/)
    expect(state.adminTouched).toBe(0)
  })

  it('a thrown getUser (fetch rejection) -> 503, not an unhandled 500', async () => {
    state.getUser = async () => { throw new TypeError('fetch failed') }
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('auth_unavailable')
  })

  it('never returns any user data on a 503', async () => {
    state.getUser = async () => ({ data: { user: null }, error: new AuthRetryableFetchError('x', 0) })
    const body = await (await GET(req())).json()
    expect(JSON.stringify(body)).not.toContain(USER_ID)
    expect(body).not.toHaveProperty('balance')
  })
})

describe('GET /api/credits -- authenticated path is unchanged', () => {
  it('returns the balance row plus total_available_credits', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ balance: 40, total_available_credits: 40, plan: 'beta' })
  })
  it('works when called without a request argument (the shape the existing tests use)', async () => {
    expect((await GET()).status).toBe(200)
  })
})
