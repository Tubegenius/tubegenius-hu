// Same-origin/CSRF guard unit tests (pure function -- a real Request object
// + process.env, no mocking). Production vs. development behavior is
// exercised via vi.stubEnv('NODE_ENV', ...) rather than an injectable
// parameter on the guard itself, since checkOriginGuard()'s public
// contract has no test-only override -- this proves the SAME code path a
// real request hits, not a weakened stand-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkOriginGuard, originGuardFailureToResponse } from '@/lib/http-origin-guard'

const TRUSTED_ORIGIN = 'https://tubegenius-hu.vercel.app'

function req(init: { origin?: string | null; contentType?: string | null; secFetchSite?: string | null } = {}): Request {
  const headers = new Headers()
  if (init.origin !== null) headers.set('origin', init.origin ?? TRUSTED_ORIGIN)
  if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/json')
  if (init.secFetchSite) headers.set('sec-fetch-site', init.secFetchSite)
  return new Request('https://tubegenius-hu.vercel.app/api/admin/semantic-topic-lifecycle-reviews/x/decision', { method: 'POST', headers })
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = TRUSTED_ORIGIN
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env.NEXT_PUBLIC_APP_URL
})

describe('checkOriginGuard -- production mode', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
  })

  it('the correct production same-origin request passes', () => {
    const result = checkOriginGuard(req({ origin: TRUSTED_ORIGIN }))
    expect(result.ok).toBe(true)
  })

  it('wrong scheme (http instead of https) -> 403', () => {
    const result = checkOriginGuard(req({ origin: 'http://tubegenius-hu.vercel.app' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'foreign_origin' } })
  })

  it('wrong host entirely -> 403', () => {
    const result = checkOriginGuard(req({ origin: 'https://attacker.example' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'foreign_origin' } })
  })

  it('a subdomain of the trusted host -> 403 (no suffix/subdomain matching)', () => {
    const result = checkOriginGuard(req({ origin: 'https://evil.tubegenius-hu.vercel.app' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'foreign_origin' } })
  })

  it('an explicit, non-default port on an otherwise-correct origin -> 403', () => {
    const result = checkOriginGuard(req({ origin: 'https://tubegenius-hu.vercel.app:8443' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'foreign_origin' } })
  })

  it('missing Origin header -> 403 in production (no server-side/test/user-agent bypass)', () => {
    const result = checkOriginGuard(req({ origin: null }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'missing_or_invalid_origin' } })
  })

  it('empty-string Origin -> 403', () => {
    const result = checkOriginGuard(req({ origin: '' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'missing_or_invalid_origin' } })
  })

  it('the literal string "null" Origin (sandboxed iframe / file:// convention) -> 403', () => {
    const result = checkOriginGuard(req({ origin: 'null' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'missing_or_invalid_origin' } })
  })

  it('a malformed, unparseable Origin -> 403', () => {
    const result = checkOriginGuard(req({ origin: 'not a url at all' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'missing_or_invalid_origin' } })
  })

  it('a non-HTTP(S) scheme Origin (e.g. javascript:) -> 403', () => {
    const result = checkOriginGuard(req({ origin: 'javascript://tubegenius-hu.vercel.app' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'missing_or_invalid_origin' } })
  })

  it('prefix deception: trusted.example.attacker.tld-style suffix -> 403', () => {
    const result = checkOriginGuard(req({ origin: 'https://tubegenius-hu.vercel.app.attacker.tld' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'foreign_origin' } })
  })

  it('suffix deception: attacker-trusted.example-style prefix -> 403', () => {
    const result = checkOriginGuard(req({ origin: 'https://attacker-tubegenius-hu.vercel.app' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'foreign_origin' } })
  })

  it('Sec-Fetch-Site: cross-site is rejected even with a correct Origin', () => {
    const result = checkOriginGuard(req({ origin: TRUSTED_ORIGIN, secFetchSite: 'cross-site' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'cross_site_fetch_metadata' } })
  })

  it('Sec-Fetch-Site: same-origin passes (with a correct Origin)', () => {
    const result = checkOriginGuard(req({ origin: TRUSTED_ORIGIN, secFetchSite: 'same-origin' }))
    expect(result.ok).toBe(true)
  })

  it('non-JSON Content-Type -> 415 (checked only after Origin already passed)', () => {
    const result = checkOriginGuard(req({ origin: TRUSTED_ORIGIN, contentType: 'text/plain' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'unsupported_content_type' } })
  })

  it('application/json with a charset parameter is accepted', () => {
    const result = checkOriginGuard(req({ origin: TRUSTED_ORIGIN, contentType: 'application/json; charset=utf-8' }))
    expect(result.ok).toBe(true)
  })

  it('missing Content-Type -> 415', () => {
    const result = checkOriginGuard(req({ origin: TRUSTED_ORIGIN, contentType: null }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'unsupported_content_type' } })
  })

  it('a cross-origin request is rejected as an origin failure, never masked as a content-type failure', () => {
    const result = checkOriginGuard(req({ origin: 'https://attacker.example', contentType: 'text/plain' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'foreign_origin' } })
  })

  it('missing NEXT_PUBLIC_APP_URL -> fail closed (origin_not_configured), never a silent pass', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    const result = checkOriginGuard(req({ origin: TRUSTED_ORIGIN }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'origin_not_configured' } })
  })

  it('NEXT_PUBLIC_APP_URL configured as http:// (not https://) in production -> fail closed', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://tubegenius-hu.vercel.app'
    const result = checkOriginGuard(req({ origin: 'http://tubegenius-hu.vercel.app' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'origin_not_configured' } })
  })

  it('NEXT_PUBLIC_APP_URL configured as a malformed value -> fail closed', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'not-a-valid-url'
    const result = checkOriginGuard(req({ origin: TRUSTED_ORIGIN }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'origin_not_configured' } })
  })

  it('the trusted origin is never sourced from the Host or X-Forwarded-Host header', () => {
    const headers = new Headers({ origin: TRUSTED_ORIGIN, 'content-type': 'application/json', host: 'attacker.example', 'x-forwarded-host': 'attacker.example' })
    const request = new Request('https://tubegenius-hu.vercel.app/api/x', { method: 'POST', headers })
    // Still passes -- Host/X-Forwarded-Host are attacker-controlled and
    // never consulted; only NEXT_PUBLIC_APP_URL + the Origin header matter.
    expect(checkOriginGuard(request).ok).toBe(true)
  })
})

describe('checkOriginGuard -- development mode (narrow, documented, never reachable in production)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
  })

  it('http://localhost origin passes in development', () => {
    const result = checkOriginGuard(req({ origin: 'http://localhost:3000' }))
    expect(result.ok).toBe(true)
  })

  it('http://127.0.0.1 origin passes in development', () => {
    const result = checkOriginGuard(req({ origin: 'http://127.0.0.1:4000' }))
    expect(result.ok).toBe(true)
  })

  it('a non-localhost origin is still rejected in development', () => {
    const result = checkOriginGuard(req({ origin: 'https://attacker.example' }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'foreign_origin' } })
  })

  it('the production trusted-origin value itself is irrelevant in development (dev never consults NEXT_PUBLIC_APP_URL for validation)', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    const result = checkOriginGuard(req({ origin: 'http://localhost:5173' }))
    expect(result.ok).toBe(true)
  })

  it('missing Origin -> 403 in development too', () => {
    const result = checkOriginGuard(req({ origin: null }))
    expect(result).toEqual({ ok: false, failure: { outcome: 'missing_or_invalid_origin' } })
  })
})

describe('originGuardFailureToResponse -- status mapping and redaction', () => {
  it('maps unsupported_content_type to 415', () => {
    const res = originGuardFailureToResponse({ outcome: 'unsupported_content_type' })
    expect(res.status).toBe(415)
  })
  it('maps every origin-related outcome to 403', () => {
    for (const outcome of ['cross_site_fetch_metadata', 'missing_or_invalid_origin', 'foreign_origin', 'origin_not_configured'] as const) {
      const res = originGuardFailureToResponse({ outcome })
      expect(res.status).toBe(403)
    }
  })
  it('every response carries Cache-Control: no-store', async () => {
    for (const outcome of ['cross_site_fetch_metadata', 'missing_or_invalid_origin', 'foreign_origin', 'origin_not_configured', 'unsupported_content_type'] as const) {
      const res = originGuardFailureToResponse({ outcome })
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })
  it('the response body never leaks the raw Origin/Host header value or the configured trusted origin', async () => {
    process.env.NEXT_PUBLIC_APP_URL = TRUSTED_ORIGIN
    const res = originGuardFailureToResponse({ outcome: 'foreign_origin' })
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/attacker|vercel\.app|tubegenius/)
    delete process.env.NEXT_PUBLIC_APP_URL
  })
})
