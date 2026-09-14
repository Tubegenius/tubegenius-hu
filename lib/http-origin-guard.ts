import { NextResponse } from 'next/server'

// Shared same-origin/CSRF guard for session-cookie-authenticated, state-
// mutating admin routes. Fail-closed by construction: any ambiguity
// (missing config, missing/malformed Origin, foreign Origin, cross-site
// fetch metadata, non-JSON content type) rejects the request BEFORE the
// caller ever reaches auth.getUser() or any RPC call.
//
// Trusted-origin source: process.env.NEXT_PUBLIC_APP_URL, read directly
// from the server process -- NEVER from a client-controlled header (Host,
// X-Forwarded-Host, or the incoming Origin itself). This is the SAME
// variable resolveOAuthOrigin() (lib/youtube-analytics.ts) already trusts
// for constructing OAuth redirect URIs in production, with the identical
// "must be configured, must be https:// in production, or fail" contract
// -- this module reuses that established trust source rather than
// inventing a parallel one, per the audit this gate's item 1 required.
// Confirmed present in Vercel's Production environment (`vercel env ls`,
// read-only) and already relied upon by live Stripe/OAuth code -- if it
// were wrong, those already-shipped features would be visibly broken.
//
// Production vs. development is decided SOLELY by process.env.NODE_ENV
// === 'production' -- not an injectable parameter on the exported
// function, so there is no test-only bypass surface in the guard's public
// contract. Tests exercise both branches via vi.stubEnv('NODE_ENV', ...),
// which changes which branch runs, never what either branch enforces.

const JSON_CONTENT_TYPE_RE = /^application\/json(?:\s*;\s*charset=[\w-]+)?$/i

export type OriginGuardFailure =
  | { outcome: 'cross_site_fetch_metadata' }
  | { outcome: 'missing_or_invalid_origin' }
  | { outcome: 'foreign_origin' }
  | { outcome: 'unsupported_content_type' }
  // Production's trusted-origin source is absent or malformed -- a server
  // misconfiguration, never a client's fault, but still rejected the same
  // way (fail closed, no silent bypass, no distinguishing response).
  | { outcome: 'origin_not_configured' }

export type OriginGuardResult = { ok: true } | { ok: false; failure: OriginGuardFailure }

// Development-only, narrow, documented allowance: the app has no fixed
// canonical domain in local dev (port varies), so http://localhost or
// http://127.0.0.1 (any port) is accepted here -- and ONLY here, gated by
// the same NODE_ENV check every production path in this file uses. This
// can never apply when NODE_ENV==='production'.
function isAllowedDevOrigin(origin: URL): boolean {
  return origin.protocol === 'http:' && (origin.hostname === 'localhost' || origin.hostname === '127.0.0.1')
}

function resolveTrustedProductionOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (!configured) return null
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  return url.origin
}

function parseOrigin(rawOrigin: string): URL | null {
  try {
    const url = new URL(rawOrigin)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return url
  } catch {
    return null
  }
}

export function checkOriginGuard(request: Request): OriginGuardResult {
  // 1. Fetch Metadata: an explicit cross-site signal from the browser
  // itself -- rejected regardless of what Origin claims, since a
  // same-site request never carries Sec-Fetch-Site: cross-site.
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return { ok: false, failure: { outcome: 'cross_site_fetch_metadata' } }
  }

  const isProduction = process.env.NODE_ENV === 'production'
  const rawOrigin = request.headers.get('origin')

  if (isProduction) {
    const trustedOrigin = resolveTrustedProductionOrigin()
    if (!trustedOrigin) {
      return { ok: false, failure: { outcome: 'origin_not_configured' } }
    }
    if (!rawOrigin) {
      return { ok: false, failure: { outcome: 'missing_or_invalid_origin' } }
    }
    const parsed = parseOrigin(rawOrigin)
    if (!parsed) {
      return { ok: false, failure: { outcome: 'missing_or_invalid_origin' } }
    }
    // Exact origin equality: scheme + hostname + explicit port (URL's own
    // `.origin` serialization already omits a scheme's default port on
    // both sides consistently, so this comparison is never fooled by a
    // trailing slash, path, query, fragment, or credentials, and never
    // does prefix/suffix/substring matching of any kind).
    if (parsed.origin !== trustedOrigin) {
      return { ok: false, failure: { outcome: 'foreign_origin' } }
    }
  } else {
    // Development: narrow localhost/127.0.0.1-only allowance, never
    // reachable when NODE_ENV==='production'.
    if (!rawOrigin) {
      return { ok: false, failure: { outcome: 'missing_or_invalid_origin' } }
    }
    const parsed = parseOrigin(rawOrigin)
    if (!parsed || !isAllowedDevOrigin(parsed)) {
      return { ok: false, failure: { outcome: 'foreign_origin' } }
    }
  }

  // 2. Content-Type: mutating routes accept only application/json (an
  // optional charset parameter is tolerated). Checked after the
  // origin/fetch-metadata checks so a cross-origin attempt is always
  // reported as an origin failure, never masked as a content-type one.
  const contentType = (request.headers.get('content-type') ?? '').trim()
  if (!JSON_CONTENT_TYPE_RE.test(contentType)) {
    return { ok: false, failure: { outcome: 'unsupported_content_type' } }
  }

  return { ok: true }
}

// Deliberately NOT a re-export/dependency on
// lib/semantic-topic/human-review-http-mapping.ts's jsonNoStore -- this
// module lives outside the semantic-topic feature area (it is meant to be
// reusable by any future session-cookie-authenticated mutating route), so
// it owns its own tiny, identical no-store constant rather than creating a
// generic-module -> feature-module dependency for one header object.
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const

// Every branch returns the SAME generic message per status code -- never
// the raw Origin/Host header value, the configured trusted origin, or any
// other request/config detail, matching item 6's redaction requirement.
// Nothing here is ever passed to console.* either.
export function originGuardFailureToResponse(failure: OriginGuardFailure): NextResponse {
  switch (failure.outcome) {
    case 'unsupported_content_type':
      return NextResponse.json({ error: 'A kérés Content-Type fejléce nem támogatott' }, { status: 415, headers: NO_STORE_HEADERS })
    case 'cross_site_fetch_metadata':
    case 'missing_or_invalid_origin':
    case 'foreign_origin':
    case 'origin_not_configured':
      return NextResponse.json({ error: 'A kérés nem engedélyezett forrásból érkezett' }, { status: 403, headers: NO_STORE_HEADERS })
    default: {
      const exhaustiveCheck: never = failure
      void exhaustiveCheck
      return NextResponse.json({ error: 'A kérés nem engedélyezett forrásból érkezett' }, { status: 403, headers: NO_STORE_HEADERS })
    }
  }
}
