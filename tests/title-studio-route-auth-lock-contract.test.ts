// Backend error contract (wave 1) -- /api/title-studio (the first paid + locked route).
// Proves, with spies, that on 401 / 503 auth / 409 / 503 lock the route stops BEFORE
// the cache lookup, the daily-limit check, the provider call, the charge and the
// save -- i.e. before any provider cost or credit movement. DB- and provider-free.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AuthResolution } from '@/lib/auth/resolve-auth'

const USER_ID = '55555555-5555-4555-8555-555555555555'
const AUTHED: AuthResolution = { kind: 'authenticated', userId: USER_ID }

const h = vi.hoisted(() => ({
  auth: null as unknown as AuthResolution,
  lock: null as unknown as { status: string; lockId?: string; cause?: string },
  spies: {
    acquire: vi.fn((..._a: unknown[]): void => {}),
    release: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
    cache: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    byId: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    access: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ allowed: true })),
    ai: vi.fn((..._a: unknown[]): unknown => undefined),
    charge: vi.fn((..._a: unknown[]): unknown => undefined),
    save: vi.fn((..._a: unknown[]): unknown => undefined),
    logUsage: vi.fn((..._a: unknown[]): unknown => undefined),
    refund: vi.fn((..._a: unknown[]): unknown => undefined),
    admin: vi.fn((..._a: unknown[]): void => {}),
    openPaid: vi.fn((..._a: unknown[]): unknown => undefined),
  },
}))

vi.mock('@/lib/credits', () => ({
  resolveUserAuth: async () => h.auth,
  checkPaidFeatureAccess: (...a: unknown[]) => h.spies.access(...a),
  chargeFeature: (...a: unknown[]) => h.spies.charge(...a),
  logUsage: (...a: unknown[]) => h.spies.logUsage(...a),
  refundCreditsAfterPersistenceFailure: (...a: unknown[]) => h.spies.refund(...a),
  CREDIT_COSTS: { title_studio: 1 },
}))
vi.mock('@/lib/request-lock', () => ({
  acquireRequestLockStrict: (...a: unknown[]) => { h.spies.acquire(...a); return Promise.resolve(h.lock) },
  releaseRequestLock: (...a: unknown[]) => h.spies.release(...a),
  REQUEST_IN_PROGRESS_ERROR: 'Már folyamatban van egy generálásod (teszt)',
}))
vi.mock('@/lib/paid-results/paid-results-service', () => ({
  buildPaidResultHash: () => 'hash',
  normalizePaidResultInput: () => 'normalized',
  getPaidResultByHash: (...a: unknown[]) => h.spies.cache(...a),
  getPaidResultById: (...a: unknown[]) => h.spies.byId(...a),
  openPaidResult: (...a: unknown[]) => h.spies.openPaid(...a),
  paidResultResponseMeta: () => ({}),
  savePaidResult: (...a: unknown[]) => h.spies.save(...a),
}))
vi.mock('@/lib/services/ai-provider-service', () => ({
  callAIProvider: (...a: unknown[]) => h.spies.ai(...a),
  extractJson: () => ({}),
}))
vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => { h.spies.admin(); return { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) } },
}))

import { GET, PATCH, POST } from '@/app/api/title-studio/route'

const post = (body: unknown) => new NextRequest('http://localhost/api/title-studio', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vercel-id': 'iad1::ts-1' }, body: JSON.stringify(body) })
const patch = (body: unknown) => new NextRequest('http://localhost/api/title-studio', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = () => new NextRequest('http://localhost/api/title-studio?paidResultId=abc')
const VALID_POST = { topic: 'Node.js async await', platform: 'youtube', region: 'HU' }
const VALID_PATCH = { topic: 'Node.js async await', title: 'Egy cím', paid_result_id: 'abc' }

const unavailable = (cause: 'network' | 'gateway_5xx' = 'network'): AuthResolution => ({ kind: 'unavailable', cause, sdkName: 'AuthRetryableFetchError', sdkStatus: cause === 'network' ? 0 : 503, sdkCode: null, retryAfterSeconds: 2 })

function expectNothingPaidHappened(opts: { lockAttempted: boolean }) {
  expect(h.spies.cache).not.toHaveBeenCalled()
  expect(h.spies.access).not.toHaveBeenCalled()
  expect(h.spies.ai).not.toHaveBeenCalled()
  expect(h.spies.logUsage).not.toHaveBeenCalled()
  expect(h.spies.charge).not.toHaveBeenCalled()
  expect(h.spies.save).not.toHaveBeenCalled()
  expect(h.spies.refund).not.toHaveBeenCalled()
  if (!opts.lockAttempted) expect(h.spies.acquire).not.toHaveBeenCalled()
  expect(h.spies.release).not.toHaveBeenCalled() // no lock row was created, so nothing to release
}

beforeEach(() => {
  for (const s of Object.values(h.spies)) (s as ReturnType<typeof vi.fn>).mockClear()
  h.auth = AUTHED
  h.lock = { status: 'acquired', lockId: 'lock-1' }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/title-studio -- auth', () => {
  it('proven missing session -> 401 unauthenticated; lock, cache, provider, charge never touched', async () => {
    h.auth = { kind: 'unauthenticated', reason: 'no_session' }
    const res = await POST(post(VALID_POST))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Nem vagy bejelentkezve', code: 'unauthenticated', retryable: false })
    expectNothingPaidHappened({ lockAttempted: false })
  })

  it.each(['network', 'gateway_5xx'] as const)('Supabase %s failure -> 503 auth_unavailable (NOT 401); nothing paid happens', async cause => {
    h.auth = unavailable(cause)
    const res = await POST(post(VALID_POST))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('2')
    expect(await res.json()).toMatchObject({ code: 'auth_unavailable', retryable: true, request_id: 'iad1::ts-1' })
    expectNothingPaidHappened({ lockAttempted: false })
  })

  it('request validation still comes first (400 before any auth call)', async () => {
    h.auth = unavailable()
    const res = await POST(post({ topic: '' }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/title-studio -- lock', () => {
  it('a REAL conflict -> 409 request_in_progress with the existing text; provider/charge/cache untouched', async () => {
    h.lock = { status: 'conflict' }
    const res = await POST(post(VALID_POST))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'Már folyamatban van egy generálásod (teszt)', code: 'request_in_progress', retryable: true })
    expectNothingPaidHappened({ lockAttempted: true })
    expect(h.spies.acquire).toHaveBeenCalledTimes(1)
  })

  it('a lock-service failure -> 503 lock_unavailable, fail CLOSED before cache, limit check, provider call, charge and save', async () => {
    h.lock = { status: 'unavailable', cause: 'PGRST205' }
    const res = await POST(post(VALID_POST))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('2')
    const body = await res.json()
    expect(body).toMatchObject({ code: 'lock_unavailable', retryable: true })
    expect(body.error).toMatch(/Kredit nem lett levonva/)
    expectNothingPaidHappened({ lockAttempted: true })
    expect(h.spies.admin).toHaveBeenCalled() // the profile read happens before the lock (unchanged order); nothing paid does
  })

  it('a lock-service failure is NOT reported as the false conflict message', async () => {
    h.lock = { status: 'unavailable', cause: 'thrown' }
    const body = await (await POST(post(VALID_POST))).json()
    expect(body.error).not.toMatch(/folyamatban/)
    expect(body.code).not.toBe('request_in_progress')
  })
})

describe('PATCH / GET /api/title-studio -- the same auth contract on the other handlers of the file', () => {
  it('PATCH: 401 for a proven missing session, 503 for a Supabase failure; no paid-result lookup either way', async () => {
    h.auth = { kind: 'unauthenticated', reason: 'invalid_session' }
    expect((await PATCH(patch(VALID_PATCH))).status).toBe(401)
    h.auth = unavailable()
    const res = await PATCH(patch(VALID_PATCH))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('auth_unavailable')
    expect(h.spies.byId).not.toHaveBeenCalled()
  })

  it('GET (free reopen): 401 for a proven missing session, 503 for a Supabase failure; no paid-result lookup either way', async () => {
    h.auth = { kind: 'unauthenticated', reason: 'no_session' }
    expect((await GET(get())).status).toBe(401)
    h.auth = unavailable('gateway_5xx')
    const res = await GET(get())
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('auth_unavailable')
    expect(h.spies.byId).not.toHaveBeenCalled()
  })
})

describe('Cache-Control: every response of POST / PATCH / GET is explicitly private, no-store', () => {
  const PNS = 'private, no-store'
  const cc = (res: Response) => res.headers.get('cache-control')
  const asRecord = { tool_type: 'title_studio', id: 'abc', user_id: USER_ID, result_json: { topic: 'x', variations: [] } }

  it('POST: 400 validation, 401, 503 auth, 409 lock conflict, 503 lock outage', async () => {
    expect(cc(await POST(post({})))).toBe(PNS) // validation happens before auth
    h.auth = { kind: 'unauthenticated', reason: 'no_session' }
    expect(cc(await POST(post(VALID_POST)))).toBe(PNS)
    h.auth = unavailable()
    expect(cc(await POST(post(VALID_POST)))).toBe(PNS)
    h.auth = AUTHED
    h.lock = { status: 'conflict' }
    const conflict = await POST(post(VALID_POST))
    expect(conflict.status).toBe(409)
    expect(cc(conflict)).toBe(PNS)
    h.lock = { status: 'unavailable', cause: 'PGRST205' }
    const lockDown = await POST(post(VALID_POST))
    expect(lockDown.status).toBe(503)
    expect(cc(lockDown)).toBe(PNS)
    expect(lockDown.headers.get('retry-after')).toBe('2') // other headers of the error response are kept
  })

  it('PATCH: 400 validation, 401, 503 auth, 403 when the title does not belong to the paid result', async () => {
    expect(cc(await PATCH(patch({})))).toBe(PNS)
    h.auth = { kind: 'unauthenticated', reason: 'invalid_session' }
    expect(cc(await PATCH(patch(VALID_PATCH)))).toBe(PNS)
    h.auth = unavailable('gateway_5xx')
    expect(cc(await PATCH(patch(VALID_PATCH)))).toBe(PNS)
    h.auth = AUTHED
    const forbidden = await PATCH(patch(VALID_PATCH))
    expect(forbidden.status).toBe(403)
    expect(cc(forbidden)).toBe(PNS)
  })

  it('GET: 400 missing id, 401, 503 auth, 404 unknown result, 200 reopen of a saved result', async () => {
    expect(cc(await GET(new NextRequest('http://localhost/api/title-studio')))).toBe(PNS) // no paidResultId
    h.auth = { kind: 'unauthenticated', reason: 'no_session' }
    expect(cc(await GET(get()))).toBe(PNS)
    h.auth = unavailable()
    expect(cc(await GET(get()))).toBe(PNS)
    h.auth = AUTHED
    const notFound = await GET(get())
    expect(notFound.status).toBe(404)
    expect(cc(notFound)).toBe(PNS)
    h.spies.byId.mockResolvedValueOnce(asRecord)
    h.spies.openPaid.mockResolvedValueOnce(asRecord)
    const ok = await GET(get())
    expect(ok.status).toBe(200)
    expect(cc(ok), 'a personal 200 that writes no cookie').toBe(PNS)
    expect(ok.headers.get('expires')).toBeNull()
    expect(ok.headers.get('pragma')).toBeNull()
  })
})

describe('wave boundary', () => {
  it('the migrated route no longer uses the legacy getUserId / acquireRequestLock', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('app/api/title-studio/route.ts', 'utf8')
    expect(src).not.toMatch(/\bgetUserId\b/)
    expect(src).not.toMatch(/\bacquireRequestLock\b(?!Strict)/)
    expect(src).toContain('acquireRequestLockStrict')
    expect(src).toContain('resolveUserAuth')
  })
})
