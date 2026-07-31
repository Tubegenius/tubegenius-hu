import { beforeEach, describe, expect, it, vi } from 'vitest'

// A valodi lib/stripe.ts modul letrehozaskor `new Stripe(process.env.STRIPE_SECRET_KEY!, ...)`-t
// hivna, ami teszt-kornyezetben (nincs beallitva a kulcs) azonnal dobna — ezert a teljes
// modult lecsereljuk, mielott a route betoltodne. A route csak PLANS/TOPUPS ertekeket es a
// stripe objektum ket metodusat (webhooks.constructEvent, subscriptions.retrieve) hasznalja,
// egyiket sem hivjuk meg ezekben a tesztekben (dev-mode ag: NODE_ENV!=='production' eseten a
// route sig-ellenorzes nelkul, kozvetlen JSON.parse-szal olvassa be az esemenyt).
vi.mock('@/lib/stripe', () => ({
  stripe: {
    webhooks: { constructEvent: vi.fn() },
    subscriptions: { retrieve: vi.fn() },
  },
  PLANS: {
    starter: { priceId: 'price_starter', credits: 50, rolloverCap: 75, softDailyLimit: 10, price: 2990 },
    creator: { priceId: 'price_creator', credits: 150, rolloverCap: 225, softDailyLimit: 30, price: 5990 },
    pro: { priceId: 'price_pro', credits: 500, rolloverCap: 750, softDailyLimit: 100, price: 11990 },
  },
  TOPUPS: {
    topup_50: { priceId: 'price_topup_50', credits: 50, price: 1990 },
    topup_150: { priceId: 'price_topup_150', credits: 150, price: 4990 },
    topup_500: { priceId: 'price_topup_500', credits: 500, price: 11990 },
  },
}))

type FakeResult = { data?: any; error?: any }

/** Lancolhato, "thenable" stub — minden metodus `this`-t ad vissza, `await`-eleskor
 *  (kozvetlenul vagy `.single()` utan) egy elore beallitott {data,error}-t ad vissza. */
function makeQuery(result: FakeResult) {
  const query: any = {
    insert: vi.fn(() => query),
    update: vi.fn(() => query),
    upsert: vi.fn(() => query),
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(() => Promise.resolve(result)),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}

/** Az admin.from(table) hivasokat tablankent, hivasi sorrendben szolgalja ki egy
 *  elore feltoltott sorbol — a webhook route hivasi sorrendje determinisztikus,
 *  ezt a sorrendet a teszt-esetek pontosan a route kodjabol olvasva allitjak ossze. */
function makeFakeAdmin(queues: Record<string, FakeResult[]>, rpcResults: FakeResult[] = []) {
  const cursors: Record<string, number> = {}
  const rpcCalls: any[] = []
  let rpcCursor = 0

  const from = vi.fn((table: string) => {
    const i = cursors[table] ?? 0
    cursors[table] = i + 1
    const list = queues[table] || []
    const result = list[i] ?? { data: null, error: null }
    return makeQuery(result)
  })

  const rpc = vi.fn((name: string, params: any) => {
    rpcCalls.push({ name, params })
    const result = rpcResults[rpcCursor] ?? { data: null, error: null }
    rpcCursor += 1
    return Promise.resolve(result)
  })

  return { from, rpc, rpcCalls }
}

let fakeAdmin: ReturnType<typeof makeFakeAdmin>

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => fakeAdmin,
}))

/** Megkeresi az .update({status:'skipped', ...}) hivast kapo query-t a from() hivasok kozott. */
function findSkippedUpdateArg(admin: ReturnType<typeof makeFakeAdmin>): { skip_reason: string; status: string } {
  const query = admin.from.mock.results
    .map((r: { value: ReturnType<typeof makeQuery> }) => r.value)
    .find((q: ReturnType<typeof makeQuery>) =>
      q.update.mock.calls.some((c: any[]) => c[0]?.status === 'skipped'))
  const call = query.update.mock.calls.find((c: any[]) => c[0]?.status === 'skipped')
  return call[0]
}

async function callWebhook(event: any) {
  const { POST } = await import('@/app/api/stripe/webhook/route')
  const { NextRequest } = await import('next/server')
  const req = new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST',
    body: JSON.stringify(event),
    headers: { 'content-type': 'application/json' },
  })
  return POST(req)
}

function checkoutCompletedEvent(overrides: Partial<any> = {}) {
  return {
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'subscription',
        payment_status: 'paid',
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: { user_id: 'user_1', plan: 'starter' },
        ...overrides,
      },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.STRIPE_WEBHOOK_SECRET
})

describe('Stripe webhook route — subscription checkout payment-status guard', () => {
  it('paid subscription checkout credits once and ends completed', async () => {
    fakeAdmin = makeFakeAdmin(
      {
        stripe_webhook_events: [
          { data: null, error: null }, // claim insert
          { data: { event_id: 'evt_1' }, error: null }, // final completion update
        ],
        user_credits: [
          { data: null, error: null }, // upsert
        ],
      },
      [{ data: { total_balance: 50 }, error: null }] // apply_bucket_credit_event
    )

    const res = await callWebhook(checkoutCompletedEvent())
    expect(res.status).toBe(200)
    expect(fakeAdmin.rpcCalls).toHaveLength(1)
    expect(fakeAdmin.rpcCalls[0].params.p_bucket).toBe('subscription')
    expect(fakeAdmin.rpcCalls[0].params.p_external_ref).toBe('stripe:subscription:evt_1')
  })

  it('unpaid subscription checkout skips with unpaid_subscription_checkout, credits nothing', async () => {
    fakeAdmin = makeFakeAdmin({
      stripe_webhook_events: [
        { data: null, error: null },
        { data: { event_id: 'evt_1' }, error: null },
      ],
    })

    const res = await callWebhook(checkoutCompletedEvent({ payment_status: 'unpaid' }))
    expect(res.status).toBe(200)
    expect(fakeAdmin.rpcCalls).toHaveLength(0)

    const updateArg = findSkippedUpdateArg(fakeAdmin)
    expect(updateArg.skip_reason).toBe('unpaid_subscription_checkout')
  })

  it('no_payment_required subscription checkout skips with no_payment_required_subscription', async () => {
    fakeAdmin = makeFakeAdmin({
      stripe_webhook_events: [
        { data: null, error: null },
        { data: { event_id: 'evt_1' }, error: null },
      ],
    })

    await callWebhook(checkoutCompletedEvent({ payment_status: 'no_payment_required' }))
    expect(fakeAdmin.rpcCalls).toHaveLength(0)
    const updateArg = findSkippedUpdateArg(fakeAdmin)
    expect(updateArg.skip_reason).toBe('no_payment_required_subscription')
  })

  it('unknown/null payment_status skips with unsupported_payment_status', async () => {
    fakeAdmin = makeFakeAdmin({
      stripe_webhook_events: [
        { data: null, error: null },
        { data: { event_id: 'evt_1' }, error: null },
      ],
    })

    await callWebhook(checkoutCompletedEvent({ payment_status: null }))
    expect(fakeAdmin.rpcCalls).toHaveLength(0)
    const updateArg = findSkippedUpdateArg(fakeAdmin)
    expect(updateArg.skip_reason).toBe('unsupported_payment_status')
  })
})

describe('Stripe webhook route — top-up checkout payment-status guard', () => {
  function topupEvent(overrides: Partial<any> = {}) {
    return checkoutCompletedEvent({
      mode: 'payment',
      subscription: undefined,
      metadata: { user_id: 'user_1', package: 'topup_50' },
      ...overrides,
    })
  }

  it('paid top-up credits the purchased bucket once', async () => {
    fakeAdmin = makeFakeAdmin(
      {
        stripe_webhook_events: [
          { data: null, error: null },
          { data: { event_id: 'evt_1' }, error: null },
        ],
      },
      [{ data: { total_balance: 50 }, error: null }]
    )

    const res = await callWebhook(topupEvent())
    expect(res.status).toBe(200)
    expect(fakeAdmin.rpcCalls).toHaveLength(1)
    expect(fakeAdmin.rpcCalls[0].params.p_bucket).toBe('purchased')
    expect(fakeAdmin.rpcCalls[0].params.p_external_ref).toBe('stripe:evt_1')
  })

  it('unpaid top-up skips (no longer throws to failed) and credits nothing', async () => {
    fakeAdmin = makeFakeAdmin({
      stripe_webhook_events: [
        { data: null, error: null },
        { data: { event_id: 'evt_1' }, error: null },
      ],
    })

    const res = await callWebhook(topupEvent({ payment_status: 'unpaid' }))
    expect(res.status).toBe(200)
    expect(fakeAdmin.rpcCalls).toHaveLength(0)
    const updateArg = findSkippedUpdateArg(fakeAdmin)
    expect(updateArg.skip_reason).toBe('unpaid_topup_checkout')
  })

  it('no_payment_required top-up skips with no_payment_required_topup', async () => {
    fakeAdmin = makeFakeAdmin({
      stripe_webhook_events: [
        { data: null, error: null },
        { data: { event_id: 'evt_1' }, error: null },
      ],
    })
    await callWebhook(topupEvent({ payment_status: 'no_payment_required' }))
    expect(fakeAdmin.rpcCalls).toHaveLength(0)
    const updateArg = findSkippedUpdateArg(fakeAdmin)
    expect(updateArg.skip_reason).toBe('no_payment_required_topup')
  })

  it('unknown top-up payment_status skips with unsupported_topup_payment_status', async () => {
    fakeAdmin = makeFakeAdmin({
      stripe_webhook_events: [
        { data: null, error: null },
        { data: { event_id: 'evt_1' }, error: null },
      ],
    })
    await callWebhook(topupEvent({ payment_status: 'weird_future_status' }))
    expect(fakeAdmin.rpcCalls).toHaveLength(0)
    const updateArg = findSkippedUpdateArg(fakeAdmin)
    expect(updateArg.skip_reason).toBe('unsupported_topup_payment_status')
  })
})

describe('Stripe webhook route — idempotency', () => {
  it('duplicate event_id (already completed) is a no-op', async () => {
    fakeAdmin = makeFakeAdmin({
      stripe_webhook_events: [
        { data: null, error: { code: '23505' } }, // claim insert conflicts
        { data: { status: 'completed' }, error: null }, // previous-status lookup
      ],
    })

    const res = await callWebhook(checkoutCompletedEvent())
    const body = await res.json()
    expect(body).toEqual({ received: true, duplicate: true })
    expect(fakeAdmin.rpcCalls).toHaveLength(0)
  })

  it('retrying a failed event reclaims and can credit at most once', async () => {
    fakeAdmin = makeFakeAdmin(
      {
        stripe_webhook_events: [
          { data: null, error: { code: '23505' } }, // claim insert conflicts
          { data: { status: 'failed' }, error: null }, // previous-status lookup
          { data: { event_id: 'evt_1' }, error: null }, // retry-claim update (status -> processing)
          { data: { event_id: 'evt_1' }, error: null }, // final completion update
        ],
        user_credits: [{ data: null, error: null }],
      },
      [{ data: { total_balance: 50 }, error: null }]
    )

    const res = await callWebhook(checkoutCompletedEvent())
    expect(res.status).toBe(200)
    expect(fakeAdmin.rpcCalls).toHaveLength(1)
  })
})

describe('Stripe webhook route — renewal / initial-invoice exclusion (unchanged)', () => {
  it('subscription_create invoice never credits (already handled by checkout)', async () => {
    fakeAdmin = makeFakeAdmin({
      stripe_webhook_events: [
        { data: null, error: null },
        { data: { event_id: 'evt_1' }, error: null },
      ],
    })

    const res = await callWebhook({
      id: 'evt_1',
      type: 'invoice.payment_succeeded',
      data: { object: { subscription: 'sub_1', billing_reason: 'subscription_create' } },
    })
    expect(res.status).toBe(200)
    expect(fakeAdmin.rpcCalls).toHaveLength(0)
  })

  it('renewal invoice credits the subscription bucket with the rollover cap', async () => {
    fakeAdmin = makeFakeAdmin(
      {
        stripe_webhook_events: [
          { data: null, error: null },
          { data: { event_id: 'evt_1' }, error: null },
        ],
        user_credits: [{ data: { user_id: 'user_1', plan: 'starter' }, error: null }],
      },
      [{ data: { total_balance: 100 }, error: null }]
    )

    const res = await callWebhook({
      id: 'evt_1',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_1', subscription: 'sub_1', billing_reason: 'subscription_cycle' } },
    })
    expect(res.status).toBe(200)
    expect(fakeAdmin.rpcCalls).toHaveLength(1)
    expect(fakeAdmin.rpcCalls[0].params.p_cap).toBe(75) // starter.rolloverCap
    expect(fakeAdmin.rpcCalls[0].params.p_external_ref).toBe('stripe:invoice:in_1')
  })
})
