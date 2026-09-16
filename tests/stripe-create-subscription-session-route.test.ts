// WillViral Stripe Server Runtime Initialization -- Build-Safety Local
// Remediation Gate. Route-level tests for
// app/api/stripe/create-subscription-session/route.ts. Real lib/stripe.ts
// (PLANS, requirePriceId, resolveCanonicalAppOrigin are real), only
// getStripeClient's SDK surface is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUserMock = vi.fn()
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: getUserMock } }),
  createAdminClient: () => fakeAdmin,
}))

const stripeClientMock = {
  customers: { create: vi.fn(), del: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
}
let getStripeClientImpl = () => stripeClientMock

vi.mock('@/lib/stripe', async () => {
  const actual = await vi.importActual<typeof import('@/lib/stripe')>('@/lib/stripe')
  return {
    ...actual,
    getStripeClient: (...args: unknown[]) => getStripeClientImpl(),
    PLANS: {
      ...actual.PLANS,
      starter: { ...actual.PLANS.starter, priceId: 'price_starter' },
    },
  }
})

type FakeResult = { data?: any; error?: any }
function makeQuery(result: FakeResult) {
  const query: any = {
    select: vi.fn(() => query),
    upsert: vi.fn(() => query),
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
  fakeAdmin = { from: vi.fn(() => makeQuery({ data: null, error: { code: 'PGRST116' } })) }
  process.env.NEXT_PUBLIC_APP_URL = 'https://tubegenius-hu.vercel.app'
})

function unauth() {
  getUserMock.mockResolvedValue({ data: { user: null }, error: null })
}
function authed() {
  getUserMock.mockResolvedValue({ data: { user: FAKE_USER }, error: null })
}

async function callCreate(plan: unknown) {
  const { POST } = await import('@/app/api/stripe/create-subscription-session/route')
  const { NextRequest } = await import('next/server')
  const req = new NextRequest('http://localhost/api/stripe/create-subscription-session', {
    method: 'POST',
    body: JSON.stringify({ plan }),
    headers: { 'content-type': 'application/json' },
  })
  return POST(req)
}

describe('unauthenticated -> 401, never a config error, DB and Stripe never touched', () => {
  it('no session', async () => {
    unauth()
    const res = await callCreate('starter')
    expect(res.status).toBe(401)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
  })
})

describe('invalid plan -> 400, not a config error, before any config/DB/Stripe access', () => {
  it('unknown plan key', async () => {
    authed()
    const res = await callCreate('not_a_real_plan')
    expect(res.status).toBe(400)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
  })
})

describe('authenticated, valid plan, missing config -> redacted 500, DB and Stripe never touched', () => {
  it('missing price id for the requested plan blocks only this operation', async () => {
    authed()
    const res = await callCreate('creator') // priceId undefined (only 'starter' overridden in the mock)
    expect(res.status).toBe(500)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/STRIPE_PRICE|creator/)
  })

  it('Stripe secret key not configured', async () => {
    authed()
    getStripeClientImpl = () => {
      throw new Error('STRIPE_SECRET_KEY is not configured')
    }
    const res = await callCreate('starter')
    expect(res.status).toBe(500)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
  })

  it('NEXT_PUBLIC_APP_URL not configured', async () => {
    authed()
    delete process.env.NEXT_PUBLIC_APP_URL
    const res = await callCreate('starter')
    expect(res.status).toBe(500)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
  })
})

describe('already has an active subscription -> 409, before creating a Stripe customer', () => {
  it('active subscription blocks a new checkout', async () => {
    authed()
    fakeAdmin.from = vi.fn(() => makeQuery({ data: { stripe_subscription_id: 'sub_1', subscription_status: 'active' }, error: null }))
    const res = await callCreate('starter')
    expect(res.status).toBe(409)
    expect(stripeClientMock.customers.create).not.toHaveBeenCalled()
  })
})

describe('authenticated, valid plan, correct config -> Stripe called exactly once, no retry, no secret leaked', () => {
  it('creates a new Stripe customer and a checkout session', async () => {
    authed()
    let call = 0
    fakeAdmin.from = vi.fn(() => {
      call += 1
      if (call === 1) return makeQuery({ data: null, error: { code: 'PGRST116' } }) // no existing customer
      return makeQuery({ data: null, error: null }) // upsert ok
    })
    stripeClientMock.customers.create.mockResolvedValue({ id: 'cus_new' })
    stripeClientMock.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/session/abc' })

    const res = await callCreate('starter')
    expect(res.status).toBe(200)
    expect(stripeClientMock.customers.create).toHaveBeenCalledTimes(1)
    expect(stripeClientMock.checkout.sessions.create).toHaveBeenCalledTimes(1)
    const sessionArg = stripeClientMock.checkout.sessions.create.mock.calls[0][0]
    expect(sessionArg.line_items).toEqual([{ price: 'price_starter', quantity: 1 }])
    expect(sessionArg.success_url).toBe('https://tubegenius-hu.vercel.app/dashboard/credits?success=true')
    expect(sessionArg.cancel_url).toBe('https://tubegenius-hu.vercel.app/dashboard/credits?canceled=true')
  })

  it('reuses an existing Stripe customer id -- never calls customers.create again', async () => {
    authed()
    fakeAdmin.from = vi.fn(() => makeQuery({ data: { stripe_customer_id: 'cus_existing', stripe_subscription_id: null, subscription_status: null }, error: null }))
    stripeClientMock.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/session/xyz' })

    const res = await callCreate('starter')
    expect(res.status).toBe(200)
    expect(stripeClientMock.customers.create).not.toHaveBeenCalled()
    expect(stripeClientMock.checkout.sessions.create).toHaveBeenCalledTimes(1)
  })

  it('no user id or email leaks into a Stripe-failure error response', async () => {
    authed()
    fakeAdmin.from = vi.fn(() => makeQuery({ data: { stripe_customer_id: 'cus_existing', stripe_subscription_id: null, subscription_status: null }, error: null }))
    stripeClientMock.checkout.sessions.create.mockRejectedValue(new Error('user_1 / reviewer@example.test rejected'))
    const res = await callCreate('starter')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/user_1|reviewer@example\.test/)
  })
})
