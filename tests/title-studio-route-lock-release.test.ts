// /api/title-studio POST with the REAL route handler AND the REAL request-lock helper; only I/O is
// mocked (the lock table is an in-memory fake behind a mocked @supabase/ssr client, credits /
// paid-results / AI provider are spies). DB-/provider-free.
//
// Proves, for the exit paths listed below, that the lock acquired by THIS request is released by id
// exactly once, that someone else's lock is never released, and that a FAILED release is logged without
// identifiers/secrets (on every console channel) and does not change an already-built response.
//
// Exit paths covered after the lock was acquired: success, cache hit, 402 (access), 429, provider throw,
// provider output that fails validation, charge failure, save failure + refund ok, save failure + refund
// failed, savePaidResult throwing, cache lookup throwing. Not covered: logUsage / chargeFeature throwing,
// force_refresh, an exception thrown while the profile row is read (that happens BEFORE the lock exists).
//
// NOT proven here: a DELETE that never settles. The real client has no timeout, so a hanging release would
// hold the already-built response until the platform kills the function (see the open-risk note in
// lib/request-lock.ts). No test or comment claims otherwise.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const USER_ID = '88888888-8888-4888-8888-888888888888'
const LOCK_KEY = { user_id: USER_ID, tool_type: '__user_paid_operation__', input_hash: 'active' }

type Row = { id: string; user_id: string; tool_type: string; input_hash: string; created_at: number }
const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; user_id: string; tool_type: string; input_hash: string; created_at: number }>,
  seq: 0,
  deletedIds: [] as string[],
  releaseMode: 'ok' as 'ok' | 'error' | 'network' | 'throw',
  insertError: null as null | { code: string; message: string },
  insertThrows: false,
  spies: {
    cache: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    open: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ result_json: { topic: 'cached', variations: [] } })),
    access: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ allowed: true })),
    ai: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    usage: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
    charge: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ success: true, new_balance: 9, credit_transaction_id: 'tx-1' })),
    save: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ success: true, record: { id: 'paid-1' } })),
    refund: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ success: true })),
  },
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    from: (table: string) => {
      if (table !== 'in_flight_requests') throw new Error(`unexpected table ${table}`)
      return {
        delete: () => {
          const filters: Array<[string, unknown]> = []
          const exec = async () => {
            const byId = filters.find(f => f[0] === 'id')
            if (byId) {
              // 'network' is what the REAL postgrest-js returns for a rejected fetch: it does not throw, it resolves with
              // { error: { code: '', message: 'TypeError: fetch failed', details: <stack/cause>, hint: '' } }.
              if (h.releaseMode === 'network') return { error: { code: '', message: 'TypeError: fetch failed secret-message', details: 'secret-details: TypeError at https://secret-host.example/rest/v1/in_flight_requests?id=eq.lock-1', hint: 'secret-hint' } }
              // 'throw' is NOT what postgrest-js does for fetch failures; it models an unexpected exception only.
              if (h.releaseMode === 'throw') throw new TypeError('secret-thrown-message')
              if (h.releaseMode === 'error') return { error: { code: '57014', message: 'secret-should-not-be-logged', details: 'secret-details lock-1', hint: 'secret-hint' } }
              h.rows = h.rows.filter(r => r.id !== byId[1])
              h.deletedIds.push(String(byId[1]))
              return { error: null }
            }
            const cutoff = Date.parse(String(filters.find(f => f[0] === 'created_at<')?.[1]))
            h.rows = h.rows.filter(r => !(r.created_at < cutoff))
            return { error: null }
          }
          const b: Record<string, unknown> = {
            eq: (c: string, v: unknown) => { filters.push([c, v]); return b },
            lt: (c: string, v: unknown) => { filters.push([`${c}<`, v]); return exec() },
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
          }
          return b
        },
        insert: (row: { user_id: string; tool_type: string; input_hash: string }) => ({
          select: () => ({
            single: async () => {
              if (h.insertThrows) throw new TypeError('insert exploded')
              if (h.insertError) return { data: null, error: h.insertError }
              if (h.rows.some(r => r.user_id === row.user_id && r.tool_type === row.tool_type && r.input_hash === row.input_hash)) {
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_in_flight_requests_unique"', details: 'Key (user_id, tool_type, input_hash)=(x, y, z) already exists.' } }
              }
              const id = `lock-${++h.seq}`
              h.rows.push({ id, ...row, created_at: Date.now() })
              return { data: { id }, error: null }
            },
          }),
        }),
      }
    },
  }),
}))

vi.mock('@/lib/credits', () => ({
  resolveUserAuth: async () => ({ kind: 'authenticated', userId: USER_ID }),
  checkPaidFeatureAccess: (...a: unknown[]) => h.spies.access(...a),
  chargeFeature: (...a: unknown[]) => h.spies.charge(...a),
  logUsage: (...a: unknown[]) => h.spies.usage(...a),
  refundCreditsAfterPersistenceFailure: (...a: unknown[]) => h.spies.refund(...a),
  CREDIT_COSTS: { title_studio: 1 },
}))
vi.mock('@/lib/paid-results/paid-results-service', () => ({
  buildPaidResultHash: () => 'hash',
  normalizePaidResultInput: () => 'normalized',
  getPaidResultByHash: (...a: unknown[]) => h.spies.cache(...a),
  getPaidResultById: async () => null,
  openPaidResult: (...a: unknown[]) => h.spies.open(...a),
  paidResultResponseMeta: () => ({}),
  savePaidResult: (...a: unknown[]) => h.spies.save(...a),
}))
vi.mock('@/lib/services/ai-provider-service', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/services/ai-provider-service')>()
  return { ...actual, callAIProvider: (...a: unknown[]) => h.spies.ai(...a) }
})
vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) }),
}))

import { POST } from '@/app/api/title-studio/route'

const VARIATIONS = ['Egyszerű útmutató kezdőknek', 'Ezt senki sem mondja el rólad', 'Öt hiba, amit elkerülhetsz', 'Így indulj el lépésről lépésre', 'A legnagyobb tévhitek lelepleződnek']
  .map((title, i) => ({ title, curiosity_score: 60 + i, clarity_score: 70, clickability_score: 65, risk_score: 20, reasoning: 'Rövid indoklás.' }))
const post = () => new NextRequest('http://localhost/api/title-studio', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vercel-id': 'iad1::rel-1' }, body: JSON.stringify({ topic: 'Node.js async await', platform: 'youtube', region: 'HU' }) })
const spies: Array<ReturnType<typeof vi.spyOn>> = []
/** Everything logged on ANY console channel during the test. */
const logged = () => spies.flatMap(sp => sp.mock.calls.map((c: unknown[]) => c.map(String).join(' '))).join('\n')

beforeEach(() => {
  h.rows = []; h.seq = 0; h.deletedIds = []; h.releaseMode = 'ok'; h.insertError = null; h.insertThrows = false
  for (const s of Object.values(h.spies)) (s as ReturnType<typeof vi.fn>).mockClear()
  h.spies.cache.mockResolvedValue(null)
  h.spies.access.mockResolvedValue({ allowed: true })
  h.spies.ai.mockResolvedValue({ text: JSON.stringify(VARIATIONS), provider: 'anthropic', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, estimatedCost: 0, promptTemplateId: 't', promptVersion: 'v1' })
  h.spies.charge.mockResolvedValue({ success: true, new_balance: 9, credit_transaction_id: 'tx-1' })
  h.spies.save.mockResolvedValue({ success: true, record: { id: 'paid-1' } })
  h.spies.refund.mockResolvedValue({ success: true })
  spies.length = 0
  for (const ch of ['error', 'warn', 'log', 'info', 'debug'] as const) spies.push(vi.spyOn(console, ch).mockImplementation(() => {}))
})

/** The lock of THIS request was created and then released by id, exactly once, leaving the table empty. */
function expectOwnLockReleasedOnce() {
  expect(h.seq).toBe(1) // exactly one lock acquired
  expect(h.deletedIds).toEqual(['lock-1']) // released by the id of the lock this request acquired
  expect(h.rows).toHaveLength(0)
}

describe('POST /api/title-studio -- the lock of this request is released on EVERY exit path (real handler + real lock helper)', () => {
  it('success (charged and saved) -> 200 and released', async () => {
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect((await res.json()).paid_result_id).toBe('paid-1')
    expect(h.spies.charge).toHaveBeenCalledTimes(1)
    expectOwnLockReleasedOnce()
  })
  it('cache hit -> 200 and released (no provider call, no charge)', async () => {
    h.spies.cache.mockResolvedValue({ id: 'cached' })
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(h.spies.ai).not.toHaveBeenCalled()
    expect(h.spies.charge).not.toHaveBeenCalled()
    expectOwnLockReleasedOnce()
  })
  it('not enough credits at the access check -> 402 and released, provider never called', async () => {
    h.spies.access.mockResolvedValue({ allowed: false })
    expect((await POST(post())).status).toBe(402)
    expect(h.spies.ai).not.toHaveBeenCalled()
    expectOwnLockReleasedOnce()
  })
  it('daily soft limit -> 429 and released, provider never called', async () => {
    h.spies.access.mockResolvedValue({ allowed: false, reason: 'daily_soft_limit', dailyLimit: 5 })
    expect((await POST(post())).status).toBe(429)
    expect(h.spies.ai).not.toHaveBeenCalled()
    expectOwnLockReleasedOnce()
  })
  it('provider throws -> 500 and released, nothing charged', async () => {
    h.spies.ai.mockRejectedValue(new Error('provider down'))
    expect((await POST(post())).status).toBe(500)
    expect(h.spies.charge).not.toHaveBeenCalled()
    expectOwnLockReleasedOnce()
  })
  it('charge fails -> 402 and released, nothing saved', async () => {
    h.spies.charge.mockResolvedValue({ success: false, error: 'Nincs elég kredit' })
    expect((await POST(post())).status).toBe(402)
    expect(h.spies.save).not.toHaveBeenCalled()
    expectOwnLockReleasedOnce()
  })
  it('save fails and the refund succeeds -> 500 "credit returned" and released', async () => {
    h.spies.save.mockResolvedValue({ success: false, error: 'db down' })
    const res = await POST(post())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/kreditet visszaadtuk/)
    expect(h.spies.refund).toHaveBeenCalledTimes(1)
    expectOwnLockReleasedOnce()
  })
  it('save fails and the refund ALSO fails -> 500 "logged for follow-up" and released', async () => {
    h.spies.save.mockResolvedValue({ success: false, error: 'db down' })
    h.spies.refund.mockResolvedValue({ success: false })
    const res = await POST(post())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/visszatérítés sikertelen/)
    expectOwnLockReleasedOnce()
  })
  it('provider output that fails validation -> 500 and released, nothing charged', async () => {
    h.spies.ai.mockResolvedValue({ text: '["only one title"]', provider: 'anthropic', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, estimatedCost: 0, promptTemplateId: 't', promptVersion: 'v1' })
    expect((await POST(post())).status).toBe(500)
    expect(h.spies.charge).not.toHaveBeenCalled()
    expectOwnLockReleasedOnce()
  })
  it('cache lookup throws -> 500 and released, nothing paid', async () => {
    h.spies.cache.mockRejectedValue(new Error('cache read failed'))
    expect((await POST(post())).status).toBe(500)
    expect(h.spies.ai).not.toHaveBeenCalled()
    expect(h.spies.charge).not.toHaveBeenCalled()
    expectOwnLockReleasedOnce()
  })
  // NOTE (characterisation of EXISTING behaviour, not an endorsement): when savePaidResult THROWS (instead of
  // returning success:false) after the charge, the route answers 500 without refunding -- this is a separate
  // open paid-path risk and is NOT changed here. The test only pins that the lock is still released.
  it('savePaidResult THROWS after the charge -> 500 and the lock is still released (no refund happens in this existing path)', async () => {
    h.spies.save.mockRejectedValue(new Error('save exploded'))
    expect((await POST(post())).status).toBe(500)
    expect(h.spies.charge).toHaveBeenCalledTimes(1)
    expect(h.spies.refund).not.toHaveBeenCalled()
    expectOwnLockReleasedOnce()
  })
})

describe('POST /api/title-studio -- locks it must NOT touch', () => {
  it('another operation holds the lock -> 409, nothing paid, and THAT lock is left alone', async () => {
    h.rows.push({ id: 'other-lock', ...LOCK_KEY, created_at: Date.now() })
    const res = await POST(post())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('request_in_progress')
    expect(h.spies.cache).not.toHaveBeenCalled()
    expect(h.spies.ai).not.toHaveBeenCalled()
    expect(h.deletedIds).toEqual([])
    expect(h.rows.map(r => r.id)).toEqual(['other-lock'])
  })
  it('lock service failure -> 503 fail-closed, nothing paid, no release attempted', async () => {
    h.insertError = { code: '57014', message: 'statement timeout' }
    const res = await POST(post())
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('lock_unavailable')
    for (const s of [h.spies.cache, h.spies.access, h.spies.ai, h.spies.usage, h.spies.charge, h.spies.save]) expect(s).not.toHaveBeenCalled()
    expect(h.deletedIds).toEqual([])
  })
  it('the lock acquisition itself THROWS -> 503 fail-closed, nothing paid, no release attempted', async () => {
    h.insertThrows = true
    const res = await POST(post())
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('lock_unavailable')
    for (const s of [h.spies.cache, h.spies.access, h.spies.ai, h.spies.usage, h.spies.charge, h.spies.save]) expect(s).not.toHaveBeenCalled()
    expect(h.deletedIds).toEqual([])
  })
})

describe('POST /api/title-studio -- every exit of the paid flow carries Cache-Control: private, no-store', () => {
  const PNS = 'private, no-store'
  const exits: Array<[string, number, () => void]> = [
    ['success (charged and saved)', 200, () => {}],
    ['cache hit', 200, () => h.spies.cache.mockResolvedValue({ id: 'cached' })],
    ['402 at the access check', 402, () => h.spies.access.mockResolvedValue({ allowed: false })],
    ['429 daily soft limit', 429, () => h.spies.access.mockResolvedValue({ allowed: false, reason: 'daily_soft_limit', dailyLimit: 5 })],
    ['500 provider failure', 500, () => h.spies.ai.mockRejectedValue(new Error('provider down'))],
    ['402 charge failure', 402, () => h.spies.charge.mockResolvedValue({ success: false, error: 'Nincs elég kredit' })],
    ['500 save failure + refund', 500, () => h.spies.save.mockResolvedValue({ success: false, error: 'db down' })],
    ['409 lock held by another operation', 409, () => { h.rows.push({ id: 'other-lock', ...LOCK_KEY, created_at: Date.now() }) }],
    ['503 lock outage', 503, () => { h.insertError = { code: '57014', message: 'statement timeout' } }],
  ]
  it.each(exits)('%s -> %i with private, no-store', async (_label, status, arrange) => {
    arrange()
    const res = await POST(post())
    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe(PNS)
    expect(res.headers.get('expires')).toBeNull()
    expect(res.headers.get('pragma')).toBeNull()
  })
  it('400 validation (before auth and lock) carries it too', async () => {
    const res = await POST(new NextRequest('http://localhost/api/title-studio', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }))
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe(PNS)
  })
})

describe('POST /api/title-studio -- a FAILED release is logged (identifier-free) and does not change the response', () => {
  /** What may never appear on ANY console channel. */
  function expectNothingSensitiveLogged() {
    const text = logged()
    for (const secret of ['secret-message', 'secret-details', 'secret-hint', 'secret-host', 'secret-should-not-be-logged', 'secret-thrown-message', 'in_flight_requests', 'fetch failed', 'lock-1', USER_ID, 'hash', 'rel-1']) {
      expect(text, `logged text must not contain "${secret}"`).not.toContain(secret)
    }
  }

  it('REAL network-failure shape ({ error: { code: "" , details, hint } }) after a charged success: still 200 + paid_result_id, one "code=-" line, no details/hint/message', async () => {
    h.releaseMode = 'network'
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect((await res.json()).paid_result_id).toBe('paid-1')
    expect(h.spies.charge).toHaveBeenCalledTimes(1)
    expect(logged()).toMatch(/\[RequestLock\] release failed code=- /)
    expectNothingSensitiveLogged()
    expect(h.rows.map(r => r.id)).toEqual(['lock-1']) // the lock stays until the TTL expires
  })
  it('DB error with details and hint after a charged success: still 200, only the error CODE is logged', async () => {
    h.releaseMode = 'error'
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect((await res.json()).paid_result_id).toBe('paid-1')
    expect(logged()).toMatch(/\[RequestLock\] release failed code=57014/)
    expectNothingSensitiveLogged()
  })
  it('an unexpected exception from the release (not how postgrest-js reports fetch failures) after a charged success: still 200, only the error CLASS is logged', async () => {
    h.releaseMode = 'throw'
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect((await res.json()).paid_result_id).toBe('paid-1')
    expect(logged()).toMatch(/\[RequestLock\] release threw TypeError/)
    expectNothingSensitiveLogged()
  })
  it('release failure after a 402 keeps the 402 (not a 500)', async () => {
    h.releaseMode = 'network'
    h.spies.charge.mockResolvedValue({ success: false, error: 'Nincs elég kredit' })
    expect((await POST(post())).status).toBe(402)
  })
  it('release failure after a cache hit keeps the 200', async () => {
    h.releaseMode = 'error'
    h.spies.cache.mockResolvedValue({ id: 'cached' })
    expect((await POST(post())).status).toBe(200)
  })
})
