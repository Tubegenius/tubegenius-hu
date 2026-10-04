// Backend error contract (wave 1) -- exact status / body / headers of the classified
// failures. DB-free, provider-free.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_UNAVAILABLE_MESSAGE, LOCK_UNAVAILABLE_MESSAGE, UNAUTHENTICATED_MESSAGE,
  authUnavailableResponse, lockConflictResponse, lockUnavailableResponse, unauthenticatedResponse,
} from '@/lib/http/api-error'
import type { AuthResolution } from '@/lib/auth/resolve-auth'

const unavailable = (overrides: Partial<Extract<AuthResolution, { kind: 'unavailable' }>> = {}): Extract<AuthResolution, { kind: 'unavailable' }> => ({
  kind: 'unavailable', cause: 'network', sdkName: 'AuthRetryableFetchError', sdkStatus: 0, sdkCode: null, retryAfterSeconds: 2, ...overrides,
})
const req = (id?: string) => new Request('http://localhost/api/x', { headers: id ? { 'x-vercel-id': id } : {} })

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errorSpy.mockRestore() })

describe('401 unauthenticated', () => {
  it('has the unchanged message text plus additive code/retryable/request_id, and is not cacheable', async () => {
    const res = unauthenticatedResponse(req('fra1::abc'))
    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('retry-after')).toBeNull()
    expect(await res.json()).toEqual({ error: 'Nem vagy bejelentkezve', code: 'unauthenticated', retryable: false, request_id: 'fra1::abc' })
    expect(UNAUTHENTICATED_MESSAGE).toBe('Nem vagy bejelentkezve')
  })
})

describe('503 auth_unavailable', () => {
  it('is retryable, no-store, carries Retry-After, and is NOT a 401', async () => {
    const res = authUnavailableResponse(unavailable({ retryAfterSeconds: 5 }), '/api/credits', req('iad1::r1'))
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('retry-after')).toBe('5')
    const body = await res.json()
    expect(body).toEqual({ error: AUTH_UNAVAILABLE_MESSAGE, code: 'auth_unavailable', retryable: true, request_id: 'iad1::r1' })
    expect(body.error).not.toMatch(/Nem vagy bejelentkezve/)
  })
  it('generates a request_id when the platform header is absent', async () => {
    const body = await authUnavailableResponse(unavailable(), '/api/x', req()).json()
    expect(typeof body.request_id).toBe('string')
    expect(body.request_id.length).toBeGreaterThan(8)
  })
  it('logs route, cause and SDK class/status/code with the same request id -- and nothing secret', () => {
    authUnavailableResponse(unavailable({ cause: 'gateway_5xx', sdkStatus: 503 }), '/api/credits', req('iad1::r2'))
    const logged = errorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
    expect(logged).toContain('route=/api/credits')
    expect(logged).toContain('cause=gateway_5xx')
    expect(logged).toContain('sdk=AuthRetryableFetchError')
    expect(logged).toContain('status=503')
    expect(logged).toContain('request_id=iad1::r2')
    expect(logged).not.toMatch(/bearer|eyJ|cookie|apikey|service_role|sb_secret/i)
  })
  it('a gateway_auth_misconfig outage gets an extra, explicit log line (not a user session problem)', () => {
    authUnavailableResponse(unavailable({ cause: 'gateway_auth_misconfig', sdkName: 'AuthApiError', sdkStatus: 401 }), '/api/credits', req('x'))
    expect(errorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')).toContain('gateway_auth_misconfig')
  })
})

describe('409 request_in_progress and 503 lock_unavailable', () => {
  it('a real conflict is 409 with the existing text and a code', async () => {
    const res = lockConflictResponse('Már folyamatban van egy generálásod', req('a::b'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Már folyamatban van egy generálásod', code: 'request_in_progress', retryable: true, request_id: 'a::b' })
  })
  it('a lock-service failure is a 503 that says no credit was charged (true: it is returned before any provider call or charge)', async () => {
    const res = lockUnavailableResponse(req('c::d'))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('2')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body).toMatchObject({ code: 'lock_unavailable', retryable: true, error: LOCK_UNAVAILABLE_MESSAGE })
    expect(body.error).toMatch(/Kredit nem lett levonva/)
  })
})
