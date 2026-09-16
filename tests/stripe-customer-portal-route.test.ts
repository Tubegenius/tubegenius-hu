// WillViral Stripe Server Runtime Initialization -- Build-Safety Local
// Remediation Gate. Route-level tests for
// app/api/stripe/customer-portal/route.ts. Uses the REAL lib/stripe.ts
// (resolveCanonicalAppOrigin, requirePriceId are real) with only
// getStripeClient's Stripe-SDK-facing surface mocked, so these tests prove
// the route's actual config-validation wiring, not a re-implementation of
// it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUserMock = vi.fn()
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: getUserMock } }),
  createAdminClient: () => fakeAdmin,
}))

const stripeClientMock = {
  billingPortal: { sessions: { create: vi.fn() } },
}
let getStripeClientImpl = () => stripeClientMock

vi.mock('@/lib/stripe', async () => {
  const actual = await vi.importActual<typeof import('@/lib/stripe')>('@/lib/stripe')
  return {
    ...actual,
    getStripeClient: (...args: unknown[]) => getStripeClientImpl(),
  }
})

type FakeResult = { data?: any; error?: any }
function makeQuery(result: FakeResult) {
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(() => Promise.resolve(result)),
  }
  return query
}
let fakeAdmin: { from: ReturnType<typeof vi.fn> }

const FAKE_USER = { id: 'user_1', email: 'reviewer@example.test' }

beforeEach(() => {
  vi.clearAllMocks()
  getStripeClientImpl = () => stripeClientMock
  fakeAdmin = { from: vi.fn(() => makeQuery({ data: { stripe_customer_id: 'cus_1' }, error: null })) }
  delete process.env.NEXT_PUBLIC_APP_URL
  process.env.NEXT_PUBLIC_APP_URL = 'https://tubegenius-hu.vercel.app'
})

function unauth() {
  getUserMock.mockResolvedValue({ data: { user: null }, error: null })
}
function authed() {
  getUserMock.mockResolvedValue({ data: { user: FAKE_USER }, error: null })
}

async function callPortal() {
  const { POST } = await import('@/app/api/stripe/customer-portal/route')
  const { NextRequest } = await import('next/server')
  const req = new NextRequest('http://localhost/api/stripe/customer-portal', { method: 'POST' })
  return POST(req)
}

describe('unauthenticated -> 401, never a config/DB/Stripe error, DB and Stripe never touched', () => {
  it('no session', async () => {
    unauth()
    const res = await callPortal()
    expect(res.status).toBe(401)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.billingPortal.sessions.create).not.toHaveBeenCalled()
  })
})

describe('authenticated, missing Stripe config -> redacted 500, DB never touched', () => {
  it('Stripe secret key not configured', async () => {
    authed()
    getStripeClientImpl = () => {
      throw new Error('STRIPE_SECRET_KEY is not configured')
    }
    const res = await callPortal()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/STRIPE_SECRET_KEY|sk_/)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
  })

  it('NEXT_PUBLIC_APP_URL not configured', async () => {
    authed()
    delete process.env.NEXT_PUBLIC_APP_URL
    const res = await callPortal()
    expect(res.status).toBe(500)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.billingPortal.sessions.create).not.toHaveBeenCalled()
  })
})

describe('authenticated, correct config -> Stripe called exactly once, no retry, no secret in response', () => {
  it('returns the portal URL', async () => {
    authed()
    stripeClientMock.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/session/abc' })
    const res = await callPortal()
    expect(res.status).toBe(200)
    expect(stripeClientMock.billingPortal.sessions.create).toHaveBeenCalledTimes(1)
    expect(stripeClientMock.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: 'https://tubegenius-hu.vercel.app/dashboard/credits',
    })
    const body = await res.json()
    expect(body).toEqual({ url: 'https://billing.stripe.com/session/abc' })
  })

  it('no user id, email, or Stripe customer id leaks into the error path when Stripe itself fails', async () => {
    authed()
    stripeClientMock.billingPortal.sessions.create.mockRejectedValue(new Error('cus_1 not found on Stripe'))
    const res = await callPortal()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/cus_1|user_1|reviewer@example\.test/)
  })
})

describe('no subscription on file -> 404, not a config error', () => {
  it('missing stripe_customer_id', async () => {
    authed()
    fakeAdmin.from = vi.fn(() => makeQuery({ data: null, error: { code: 'PGRST116' } }))
    const res = await callPortal()
    expect(res.status).toBe(404)
    expect(stripeClientMock.billingPortal.sessions.create).not.toHaveBeenCalled()
  })
})
