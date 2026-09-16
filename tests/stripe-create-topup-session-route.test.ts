// WillViral Stripe Server Runtime Initialization -- Build-Safety Local
// Remediation Gate. Route-level tests for
// app/api/stripe/create-topup-session/route.ts. Real lib/stripe.ts
// (TOPUPS, requirePriceId, resolveCanonicalAppOrigin are real), only
// getStripeClient's SDK surface is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUserMock = vi.fn()
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: getUserMock } }),
  createAdminClient: () => fakeAdmin,
}))

const stripeClientMock = {
  checkout: { sessions: { create: vi.fn() } },
}
let getStripeClientImpl = () => stripeClientMock

vi.mock('@/lib/stripe', async () => {
  const actual = await vi.importActual<typeof import('@/lib/stripe')>('@/lib/stripe')
  return {
    ...actual,
    getStripeClient: (...args: unknown[]) => getStripeClientImpl(),
    TOPUPS: {
      ...actual.TOPUPS,
      topup_50: { ...actual.TOPUPS.topup_50, priceId: 'price_topup_50' },
    },
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
const ACTIVE_CUSTOMER = { stripe_customer_id: 'cus_1', subscription_status: 'active' }

beforeEach(() => {
  vi.clearAllMocks()
  getStripeClientImpl = () => stripeClientMock
  fakeAdmin = { from: vi.fn(() => makeQuery({ data: ACTIVE_CUSTOMER, error: null })) }
  process.env.NEXT_PUBLIC_APP_URL = 'https://tubegenius-hu.vercel.app'
})

function unauth() {
  getUserMock.mockResolvedValue({ data: { user: null }, error: null })
}
function authed() {
  getUserMock.mockResolvedValue({ data: { user: FAKE_USER }, error: null })
}

async function callCreate(pkg: unknown) {
  const { POST } = await import('@/app/api/stripe/create-topup-session/route')
  const { NextRequest } = await import('next/server')
  const req = new NextRequest('http://localhost/api/stripe/create-topup-session', {
    method: 'POST',
    body: JSON.stringify({ package: pkg }),
    headers: { 'content-type': 'application/json' },
  })
  return POST(req)
}

describe('unauthenticated -> 401, never a config error, DB and Stripe never touched', () => {
  it('no session', async () => {
    unauth()
    const res = await callCreate('topup_50')
    expect(res.status).toBe(401)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
  })
})

describe('invalid package -> 400, not a config error, before any config/DB/Stripe access', () => {
  it('unknown package key', async () => {
    authed()
    const res = await callCreate('not_a_real_package')
    expect(res.status).toBe(400)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
  })
})

describe('authenticated, valid package, missing config -> redacted 500, DB and Stripe never touched', () => {
  it('missing price id for the requested package blocks only this operation', async () => {
    authed()
    const res = await callCreate('topup_150') // priceId undefined (only topup_50 overridden)
    expect(res.status).toBe(500)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/STRIPE_PRICE|topup_150/)
  })

  it('Stripe secret key not configured', async () => {
    authed()
    getStripeClientImpl = () => {
      throw new Error('STRIPE_SECRET_KEY is not configured')
    }
    const res = await callCreate('topup_50')
    expect(res.status).toBe(500)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
  })

  it('NEXT_PUBLIC_APP_URL not configured', async () => {
    authed()
    delete process.env.NEXT_PUBLIC_APP_URL
    const res = await callCreate('topup_50')
    expect(res.status).toBe(500)
    expect(fakeAdmin.from).not.toHaveBeenCalled()
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
  })
})

describe('business-rule guards run AFTER config validation but still before Stripe, unchanged from before this gate', () => {
  it('no active subscription -> 403, Stripe never touched', async () => {
    authed()
    fakeAdmin.from = vi.fn(() => makeQuery({ data: { stripe_customer_id: 'cus_1', subscription_status: 'canceled' }, error: null }))
    const res = await callCreate('topup_50')
    expect(res.status).toBe(403)
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('missing Stripe customer id -> 409, Stripe never touched', async () => {
    authed()
    fakeAdmin.from = vi.fn(() => makeQuery({ data: { stripe_customer_id: null, subscription_status: 'active' }, error: null }))
    const res = await callCreate('topup_50')
    expect(res.status).toBe(409)
    expect(stripeClientMock.checkout.sessions.create).not.toHaveBeenCalled()
  })
})

describe('authenticated, valid package, correct config -> Stripe called exactly once, no retry, no secret leaked', () => {
  it('creates a checkout session with the expected price/urls', async () => {
    authed()
    stripeClientMock.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/session/topup' })
    const res = await callCreate('topup_50')
    expect(res.status).toBe(200)
    expect(stripeClientMock.checkout.sessions.create).toHaveBeenCalledTimes(1)
    const sessionArg = stripeClientMock.checkout.sessions.create.mock.calls[0][0]
    expect(sessionArg.customer).toBe('cus_1')
    expect(sessionArg.line_items).toEqual([{ price: 'price_topup_50', quantity: 1 }])
    expect(sessionArg.success_url).toBe('https://tubegenius-hu.vercel.app/dashboard/credits?success=true')
    expect(sessionArg.cancel_url).toBe('https://tubegenius-hu.vercel.app/dashboard/credits?canceled=true')
  })

  it('no user id or email leaks into a Stripe-failure error response', async () => {
    authed()
    stripeClientMock.checkout.sessions.create.mockRejectedValue(new Error('user_1 / reviewer@example.test rejected'))
    const res = await callCreate('topup_50')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/user_1|reviewer@example\.test/)
  })
})
