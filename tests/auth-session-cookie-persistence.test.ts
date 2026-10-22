// Session-cookie behaviour of the auth paths, with the REAL handler / helper, the REAL @supabase/ssr +
// auth-js (installed versions) and a FAKE GoTrue HTTP layer (global fetch). No network, no DB.
//
// What is observed here: the calls made to cookies().set() (the cookie writes the route hands to Next) and
// the response headers the handler returns. The real HTTP Set-Cookie headers and the production
// Cache-Control behaviour of Next are NOT observable in vitest; they were checked separately in a local
// `next build` + `next start` run against a fake GoTrue (see the PR notes), not by this file.
//
// Covered:
//   H1  GET /api/credits -- a TRANSIENT failure answers 503 WITHOUT deleting the browser's valid session;
//       a PROVEN-invalid session is still cleared; a successful refresh reaches the browser as a whole.
//   H1b a successful rotation followed by a transient /user failure keeps the COMPLETE rotation
//       (including the deletion of the stale chunk cookies that belong to it) and drops only the
//       session removal caused by the transient failure.
//   M1  resolveUserAuth() (title-studio) hands a refreshed session to the browser.
//   chunked (> ~3180 char) session cookies, getAll() visibility of buffered writes, SSR cache headers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const USER_ID = '77777777-7777-4777-8777-777777777777'
const COOKIE = 'sb-faketest-auth-token'
const SSR_CACHE_HEADERS = { 'cache-control': 'private, no-cache, no-store, must-revalidate, max-age=0', expires: '0', pragma: 'no-cache' }

type Write = { name: string; value: string; options?: { maxAge?: number } }
const h = vi.hoisted(() => {
  const jar = new Map<string, string>()   // what the browser holds between requests
  const live = new Map<string, string>()  // the request's cookie view: getAll() sees writes made in the same request (as in Next)
  const writes: Array<{ name: string; value: string; options?: { maxAge?: number } }> = []
  const store = {
    getAll: () => [...live].map(([name, value]) => ({ name, value })),
    get: (name: string) => (live.has(name) ? { name, value: live.get(name)! } : undefined),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      writes.push({ name, value, options })
      if (options?.maxAge === 0 || value === '') live.delete(name); else live.set(name, value)
    },
    delete: (name: string) => { writes.push({ name, value: '', options: { maxAge: 0 } }); live.delete(name) },
  }
  return { jar, live, writes, store }
})

vi.mock('next/headers', () => ({ cookies: () => h.store }))
vi.mock('@/lib/supabase-server', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/supabase-server')>()
  return {
    ...actual,
    createAdminClient: () => ({
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { balance: 40, subscription_credit_balance: 40, purchased_credit_balance: 0, total_used: 10, plan: 'beta', monthly_allowance: 50, renews_at: null, subscription_status: 'free', stripe_customer_id: null }, error: null }) }) }) }),
      rpc: async () => ({ data: null, error: null }),
    }),
  }
})

import { GET } from '@/app/api/credits/route'
import { resolveUserAuth } from '@/lib/credits'
import { resolveSessionAuth, withSessionResponseHeaders, type SessionResponseHeaders } from '@/lib/auth/resolve-session-auth'

type RefreshMode = 'ok' | '500' | '429' | 'html500' | 'network' | 'gateway401' | 'refresh_token_not_found' | 'refresh_token_already_used'
type UserMode = 'ok' | '500' | '429' | 'network' | 'session_not_found'
const gt = { refresh: 'ok' as RefreshMode, user: 'ok' as UserMode, big: false, expireIssued: false, used: new Set<string>(), validAccess: new Set<string>(), seq: 1, refreshCalls: 0, userCalls: 0 }
const nowSec = () => Math.floor(Date.now() / 1000)
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (exp: number, n: number) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: USER_ID, exp, aud: 'authenticated', role: 'authenticated', n })}.sig`
const userObject = () => ({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 't@example.test', app_metadata: {}, user_metadata: gt.big ? { pad: 'x'.repeat(4600) } : {}, created_at: '2026-01-01T00:00:00Z' })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function issueSession() {
  gt.seq += 1
  const exp = gt.expireIssued ? nowSec() - 30 : nowSec() + 3600
  const access = jwt(exp, gt.seq)
  gt.validAccess.add(access)
  return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: `RT${gt.seq}`, user: userObject() }
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url)
  if (url.hostname !== 'faketest.supabase.co') throw new Error(`unexpected network access: ${url.hostname}`)
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    gt.refreshCalls += 1
    const rt = JSON.parse(String(init?.body)).refresh_token as string
    switch (gt.refresh) {
      case 'network': throw new TypeError('fetch failed')
      case '500': return json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error' })
      case '429': return json(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' })
      case 'html500': return new Response('<html>Internal Server Error</html>', { status: 500, headers: { 'content-type': 'text/html' } })
      case 'gateway401': return json(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' })
      case 'refresh_token_not_found': return json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' })
      case 'refresh_token_already_used': return json(400, { code: 400, error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' })
      case 'ok':
        // real GoTrue rotation: a refresh token that was already used (outside the reuse interval) is rejected
        if (gt.used.has(rt)) return json(400, { code: 400, error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' })
        gt.used.add(rt)
        return json(200, issueSession())
    }
  }
  if (url.pathname === '/auth/v1/user') {
    gt.userCalls += 1
    switch (gt.user) {
      case 'network': throw new TypeError('fetch failed')
      case '500': return json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error' })
      case '429': return json(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' })
      case 'session_not_found': return json(403, { code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' })
      case 'ok': {
        const bearer = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? (init?.headers as Headers | undefined)?.get?.('Authorization') ?? '').replace(/^Bearer /, '')
        return gt.validAccess.has(bearer) ? json(200, userObject()) : json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' })
      }
    }
  }
  throw new Error(`unexpected fake GoTrue call: ${url.pathname}`)
}

function sessionCookie(refresh: string, state: 'expired' | 'fresh') {
  const exp = state === 'expired' ? nowSec() - 60 : nowSec() + 3000
  const access = jwt(exp, 0)
  if (state === 'fresh') gt.validAccess.add(access)
  return 'base64-' + Buffer.from(JSON.stringify({ access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: refresh, user: userObject() })).toString('base64url')
}
const refreshTokenOf = (cookieValue: string) => JSON.parse(Buffer.from(cookieValue.replace(/^base64-/, ''), 'base64url').toString('utf8')).refresh_token as string
const jarNames = () => [...h.jar.keys()].sort()

const isDeletion = (w: Write) => w.name.startsWith(COOKIE) && (w.options?.maxAge === 0 || w.value === '')
const deleted = (ws: Write[]) => ws.some(isDeletion)
const setsOf = (ws: Write[]) => ws.filter(w => w.name.startsWith(COOKIE) && w.value && w.options?.maxAge !== 0)

function beginRequest() { h.live.clear(); for (const [k, v] of h.jar) h.live.set(k, v); h.writes.length = 0 }
function endRequest() { h.jar.clear(); for (const [k, v] of h.live) h.jar.set(k, v); return [...h.writes] }
async function callCredits() {
  beginRequest()
  const res = await GET(new Request('http://localhost/api/credits'))
  const ws = endRequest()
  return { res, ws, body: await res.json() as Record<string, unknown> }
}
async function callResolveUserAuth() {
  beginRequest()
  const session: SessionResponseHeaders = { headers: {} }
  const auth = await resolveUserAuth(session)
  return { auth, ws: endRequest(), headers: session.headers }
}
// auth-js retries a network-level refresh failure with exponential backoff for ~25 s (real timers); run that
// call under fake timers so the suite stays fast. Only used for the 'network' refresh mode.
async function underFakeBackoff<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    let done = false
    const p = run().finally(() => { done = true })
    for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(500)
    return await p
  } finally { vi.useRealTimers() }
}
/** Browser holding a CHUNKED (name.0 / name.1) expired session, produced by the real SSR chunker. */
async function holdChunkedExpiredSession() {
  h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
  gt.big = true; gt.expireIssued = true
  const r = await callCredits()
  expect(r.res.status).toBe(200)
  const chunks = jarNames()
  expect(chunks.length).toBeGreaterThanOrEqual(2)
  expect(chunks.every(n => /\.\d+$/.test(n) && n.startsWith(COOKIE))).toBe(true)
  gt.big = false; gt.expireIssued = false
  gt.refreshCalls = 0; gt.userCalls = 0
  return chunks
}

beforeEach(() => {
  h.jar.clear(); h.live.clear(); h.writes.length = 0
  Object.assign(gt, { refresh: 'ok', user: 'ok', big: false, expireIssued: false, used: new Set<string>(), validAccess: new Set<string>(), seq: 1, refreshCalls: 0, userCalls: 0 })
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://faketest.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-test-key')
  vi.stubGlobal('fetch', fakeFetch)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('H1 -- GET /api/credits and the browser session cookie when the REFRESH fails', () => {
  it.each(['500', '429', 'html500', 'network', 'gateway401'] as const)(
    'transient refresh failure (%s): 503, the valid session cookie is NOT deleted, no session cache headers, next request recovers',
    async mode => {
      h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
      gt.refresh = mode
      const first = await (mode === 'network' ? underFakeBackoff(callCredits) : callCredits())
      expect(first.res.status).toBe(503)
      expect(first.body).toMatchObject({ code: 'auth_unavailable', retryable: true })
      expect(first.ws, 'a 503 for a failed refresh writes no cookie at all').toHaveLength(0)
      expect(first.res.headers.get('cache-control')).toBe('private, no-store') // explicit default; the SSR session headers only come with a cookie write
      expect(first.res.headers.get('expires')).toBeNull()
      expect(first.res.headers.get('pragma')).toBeNull()
      expect(refreshTokenOf(h.jar.get(COOKIE)!)).toBe('RT1')

      gt.refresh = 'ok'
      const second = await callCredits()
      expect(second.res.status).toBe(200)
      expect(refreshTokenOf(h.jar.get(COOKIE)!)).toBe('RT2')
    },
  )

  it('successful refresh: 200, the rotated session reaches the browser with the SSR cache headers; the next request needs no refresh', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
    const first = await callCredits()
    expect(first.res.status).toBe(200)
    expect(setsOf(first.ws)).toHaveLength(1)
    expect(refreshTokenOf(setsOf(first.ws)[0].value)).toBe('RT2')
    expect(deleted(first.ws)).toBe(false)
    for (const [k, v] of Object.entries(SSR_CACHE_HEADERS)) expect(first.res.headers.get(k), k).toBe(v)
    const second = await callCredits()
    expect(second.res.status).toBe(200)
    expect(gt.refreshCalls).toBe(1)
    expect(second.res.headers.get('cache-control')).toBe('private, no-store') // personal 200 without a cookie write: explicit default
    expect(second.res.headers.get('expires')).toBeNull() // no cookie written -> no SSR Expires/Pragma
    expect(second.res.headers.get('pragma')).toBeNull()
  })

  it('valid, unexpired session: 200, no cookie writes and no session cache headers', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'fresh'))
    const r = await callCredits()
    expect(r.res.status).toBe(200)
    expect(r.ws).toHaveLength(0)
    expect(r.res.headers.get('cache-control')).toBe('private, no-store')
    expect(r.res.headers.get('expires')).toBeNull()
    expect(r.res.headers.get('pragma')).toBeNull()
    expect(gt.refreshCalls).toBe(0)
  })

  it.each(['refresh_token_not_found', 'refresh_token_already_used'] as const)(
    'PROVEN-invalid session (%s): 401, the dead session cookie IS cleared (with the SSR cache headers); the next request has no session',
    async mode => {
      h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
      gt.refresh = mode
      const first = await callCredits()
      expect(first.res.status).toBe(401)
      expect(first.body).toMatchObject({ code: 'unauthenticated', retryable: false })
      expect(deleted(first.ws), 'proven-invalid session must still be cleared').toBe(true)
      expect(h.jar.has(COOKIE)).toBe(false)
      for (const [k, v] of Object.entries(SSR_CACHE_HEADERS)) expect(first.res.headers.get(k), k).toBe(v)
      const refreshesBefore = gt.refreshCalls
      const second = await callCredits()
      expect(second.res.status).toBe(401)
      expect(gt.refreshCalls).toBe(refreshesBefore) // no cookie -> no GoTrue refresh attempt
    },
  )

  it('no session cookie at all: 401 with the explicit private, no-store, no GoTrue call, no cookie writes', async () => {
    const r = await callCredits()
    expect(r.res.status).toBe(401)
    expect(r.res.headers.get('cache-control')).toBe('private, no-store')
    expect(r.ws).toHaveLength(0)
    expect(gt.refreshCalls).toBe(0)
  })
})

describe('H1b -- a SUCCESSFUL rotation followed by a transient /user failure', () => {
  it.each(['500', '429', 'network'] as const)(
    'refresh ok then /user %s: 503, the COMPLETE rotation is applied (new session, SSR cache headers), no deletion, next request needs no refresh',
    async userMode => {
      h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
      gt.user = userMode
      const first = await callCredits()
      expect(first.res.status).toBe(503)
      expect(first.body).toMatchObject({ code: 'auth_unavailable' })
      expect(deleted(first.ws), 'the transient failure must not delete the session').toBe(false)
      expect(setsOf(first.ws)).toHaveLength(1)
      expect(refreshTokenOf(h.jar.get(COOKIE)!)).toBe('RT2') // the browser holds the rotated token, not the already-used RT1
      for (const [k, v] of Object.entries(SSR_CACHE_HEADERS)) expect(first.res.headers.get(k), k).toBe(v)

      gt.user = 'ok'
      const second = await callCredits()
      expect(second.res.status).toBe(200)
      expect(gt.refreshCalls, 'RT2 is still valid, no second refresh').toBe(1)
    },
  )

  it('the same through resolveUserAuth() (title-studio): unavailable, rotation applied, session headers exposed', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
    gt.user = '500'
    const { auth, ws, headers } = await callResolveUserAuth()
    expect(auth.kind).toBe('unavailable')
    expect(deleted(ws)).toBe(false)
    expect(refreshTokenOf(h.jar.get(COOKIE)!)).toBe('RT2')
    expect(headers).toMatchObject({ 'Cache-Control': SSR_CACHE_HEADERS['cache-control'], Expires: '0', Pragma: 'no-cache' })
  })

  it('refresh ok then the session turns out dead (/user session_not_found): 401 and the rotated + removed session ends up cleared', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
    gt.user = 'session_not_found'
    const r = await callCredits()
    expect(r.res.status).toBe(401)
    expect(deleted(r.ws)).toBe(true)
    expect(jarNames()).toEqual([])
  })
})

describe('chunked session cookies (name.0 / name.1)', () => {
  it('chunked -> single rotation: the stale chunks are deleted together with the new cookie (complete operation)', async () => {
    await holdChunkedExpiredSession()
    const r = await callCredits()
    expect(r.res.status).toBe(200)
    expect(jarNames()).toEqual([COOKIE])
    expect(refreshTokenOf(h.jar.get(COOKIE)!)).toBe('RT3')
  })

  it('chunked -> single rotation then a TRANSIENT /user failure: 503, but the whole rotation (incl. stale-chunk deletion) is kept', async () => {
    await holdChunkedExpiredSession()
    gt.user = '500'
    const r = await callCredits()
    expect(r.res.status).toBe(503)
    expect(jarNames(), 'no stale chunk left next to the new cookie').toEqual([COOKIE])
    expect(refreshTokenOf(h.jar.get(COOKIE)!)).toBe('RT3')
    for (const [k, v] of Object.entries(SSR_CACHE_HEADERS)) expect(r.res.headers.get(k), k).toBe(v)
  })

  it('single -> chunked rotation then the session is dead (/user session_not_found): getAll() sees the buffered chunks, so NO chunk is left behind', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
    gt.big = true
    gt.user = 'session_not_found'
    const r = await callCredits()
    expect(r.res.status).toBe(401)
    expect(jarNames()).toEqual([])
  })

  it('chunked session with a PROVEN-invalid refresh: every chunk is cleared', async () => {
    await holdChunkedExpiredSession()
    gt.refresh = 'refresh_token_not_found'
    const r = await callCredits()
    expect(r.res.status).toBe(401)
    expect(jarNames()).toEqual([])
  })

  it('chunked session with a TRANSIENT refresh failure: no write, every chunk untouched', async () => {
    const chunks = await holdChunkedExpiredSession()
    gt.refresh = '500'
    const r = await callCredits()
    expect(r.res.status).toBe(503)
    expect(r.ws).toHaveLength(0)
    expect(jarNames()).toEqual(chunks)
  })
})

describe('M1 -- resolveUserAuth() (title-studio) and the rotated refresh token', () => {
  it('successful refresh: the rotated session is handed to the browser and the SSR cache headers are exposed', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
    const { auth, ws, headers } = await callResolveUserAuth()
    expect(auth).toEqual({ kind: 'authenticated', userId: USER_ID })
    expect(setsOf(ws), 'the new tokens must not be thrown away').toHaveLength(1)
    expect(refreshTokenOf(setsOf(ws)[0].value)).toBe('RT2')
    expect(headers).toMatchObject({ 'Cache-Control': SSR_CACHE_HEADERS['cache-control'], Expires: '0', Pragma: 'no-cache' })
  })

  it('without persistence the browser would keep the already-rotated token: the NEXT request must not be logged out', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
    expect((await callResolveUserAuth()).auth.kind).toBe('authenticated')
    const second = await callResolveUserAuth()
    expect(second.auth).toEqual({ kind: 'authenticated', userId: USER_ID })
    expect(gt.refreshCalls).toBe(1)
  })

  it.each(['500', '429', 'html500', 'network', 'gateway401'] as const)('transient refresh failure (%s): unavailable, NO cookie writes, no headers', async mode => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
    gt.refresh = mode
    const { auth, ws, headers } = await (mode === 'network' ? underFakeBackoff(callResolveUserAuth) : callResolveUserAuth())
    expect(auth.kind).toBe('unavailable')
    expect(ws).toHaveLength(0)
    expect(headers).toEqual({})
    expect(refreshTokenOf(h.jar.get(COOKIE)!)).toBe('RT1')
  })

  it.each(['refresh_token_not_found', 'refresh_token_already_used'] as const)(
    'proven-invalid session (%s): unauthenticated; this path keeps its previous behaviour of NOT writing cookie deletions',
    async mode => {
      h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
      gt.refresh = mode
      const { auth, ws, headers } = await callResolveUserAuth()
      expect(auth.kind).toBe('unauthenticated')
      expect(ws).toHaveLength(0)
      expect(headers).toEqual({})
    },
  )

  it('valid, unexpired session: authenticated, no cookie writes, no headers', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'fresh'))
    const { auth, ws, headers } = await callResolveUserAuth()
    expect(auth.kind).toBe('authenticated')
    expect(ws).toHaveLength(0)
    expect(headers).toEqual({})
  })
})

describe('helper contracts', () => {
  it('no state is shared between calls: a rotation in one call leaves nothing for the next call', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
    const first = await callResolveUserAuth()
    expect(first.ws.length).toBeGreaterThan(0)
    h.jar.clear()
    const second = await callResolveUserAuth() // no cookie
    expect(second.auth.kind).toBe('unauthenticated')
    expect(second.ws).toHaveLength(0)
    expect(second.headers).toEqual({})
  })

  it('every response gets Cache-Control: private, no-store by default; other headers and the body are untouched', async () => {
    const res = await withSessionResponseHeaders(async () => new Response('body', { status: 418, headers: { 'x-a': '1', 'Cache-Control': 'public, max-age=600' } }))
    expect(res.headers.get('cache-control')).toBe('private, no-store') // a weaker/public handler value is replaced
    expect(res.headers.get('x-a')).toBe('1')
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('body')
    expect(res.headers.get('expires')).toBeNull()
    expect(res.headers.get('pragma')).toBeNull()
  })

  it('the stronger SSR session headers REPLACE the default (never weaker) and bring Expires/Pragma', async () => {
    const res = await withSessionResponseHeaders(async s => {
      s.headers['Cache-Control'] = SSR_CACHE_HEADERS['cache-control']; s.headers.Expires = '0'; s.headers.Pragma = 'no-cache'
      return new Response('x')
    })
    expect(res.headers.get('cache-control')).toBe(SSR_CACHE_HEADERS['cache-control'])
    expect(res.headers.get('expires')).toBe('0')
    expect(res.headers.get('pragma')).toBe('no-cache')
    // HTTP header names are case-insensitive: a lower-case session header still wins over the default
    const lower = await withSessionResponseHeaders(async s => { s.headers['cache-control'] = SSR_CACHE_HEADERS['cache-control']; return new Response('x') })
    expect(lower.headers.get('cache-control')).toBe(SSR_CACHE_HEADERS['cache-control'])
  })

  it('a response with immutable headers is rebuilt (same status, body and Location) instead of being left without the header', async () => {
    const immutable = await withSessionResponseHeaders(async s => { s.headers.Pragma = 'no-cache'; return Response.redirect('http://localhost/x', 302) })
    expect(immutable.status).toBe(302)
    expect(immutable.headers.get('location')).toBe('http://localhost/x')
    expect(immutable.headers.get('cache-control')).toBe('private, no-store')
    expect(immutable.headers.get('pragma')).toBe('no-cache')
  })

  it('resolveSessionAuth without a session out-parameter still works (headers are simply not exposed)', async () => {
    h.jar.set(COOKIE, sessionCookie('RT1', 'expired'))
    beginRequest()
    const auth = await resolveSessionAuth({ apiKey: 'service-test-key', persistOnInvalidSession: false })
    endRequest()
    expect(auth.kind).toBe('authenticated')
  })
})
