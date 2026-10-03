// Backend error contract (wave 1) -- pure classification of getUser() outcomes.
// DB-/network-/provider-free. The error objects are built from the REAL classes of
// the installed auth-js (re-exported by @supabase/supabase-js), so an SDK upgrade
// that renames a class or changes its status/code fails here instead of silently
// reclassifying a gateway outage as "logged out" (or the reverse).
import { describe, expect, it } from 'vitest'
import {
  AuthApiError,
  AuthInvalidJwtError,
  AuthRefreshDiscardedError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from '@supabase/supabase-js'
import { PROVEN_INVALID_SESSION_CODES, classifyAuthOutcome, resolveAuthWith } from '@/lib/auth/resolve-auth'

const USER = { id: '11111111-1111-4111-8111-111111111111' }
const noUser = (error: unknown) => classifyAuthOutcome({ user: null, error })

describe('classifyAuthOutcome -- authenticated', () => {
  it('a user with an id is authenticated', () => {
    expect(classifyAuthOutcome({ user: USER, error: null })).toEqual({ kind: 'authenticated', userId: USER.id })
  })
  it('a user object without a usable id is NOT authenticated', () => {
    expect(classifyAuthOutcome({ user: { id: '' }, error: null }).kind).toBe('unauthenticated')
    expect(classifyAuthOutcome({ user: { id: 42 }, error: null }).kind).toBe('unauthenticated')
  })
})

describe('classifyAuthOutcome -- PROVEN missing/invalid session => unauthenticated (the only logout-capable class)', () => {
  it('AuthSessionMissingError (no cookie / session_not_found)', () => {
    expect(noUser(new AuthSessionMissingError())).toEqual({ kind: 'unauthenticated', reason: 'no_session' })
  })
  it.each([...PROVEN_INVALID_SESSION_CODES])('AuthApiError 401 with proven code %s', code => {
    expect(noUser(new AuthApiError('invalid', 401, code))).toEqual({ kind: 'unauthenticated', reason: 'invalid_session' })
  })
  it('AuthApiError 403 with a proven code', () => {
    expect(noUser(new AuthApiError('bad jwt', 403, 'bad_jwt')).kind).toBe('unauthenticated')
  })
  it('AuthInvalidJwtError (code invalid_jwt)', () => {
    expect(noUser(new AuthInvalidJwtError('bad token')).kind).toBe('unauthenticated')
  })
  it('no user and no error at all is the ordinary "not signed in" answer (compat with existing route tests)', () => {
    expect(classifyAuthOutcome({ user: null, error: null })).toEqual({ kind: 'unauthenticated', reason: 'no_user_no_error' })
    expect(classifyAuthOutcome({ user: undefined, error: undefined }).kind).toBe('unauthenticated')
  })
})

describe('classifyAuthOutcome -- everything else => unavailable (503, NEVER logout-capable)', () => {
  it('network failure (AuthRetryableFetchError status 0)', () => {
    expect(noUser(new AuthRetryableFetchError('fetch failed', 0))).toMatchObject({ kind: 'unavailable', cause: 'network' })
  })
  it.each([502, 503, 504, 520, 521, 522, 523, 524, 530])('gateway status %i (AuthRetryableFetchError)', status => {
    expect(noUser(new AuthRetryableFetchError('gateway', status)).kind).toBe('unavailable')
  })
  it('refresh race (AuthRefreshDiscardedError) is unavailable, not a logout', () => {
    expect(noUser(new AuthRefreshDiscardedError())).toMatchObject({ kind: 'unavailable', cause: 'refresh_race' })
  })
  it('rate limit by code and by status 429', () => {
    expect(noUser(new AuthApiError('slow down', 429, 'over_request_rate_limit'))).toMatchObject({ kind: 'unavailable', cause: 'rate_limited' })
    expect(noUser(new AuthApiError('slow down', 429, undefined)).kind).toBe('unavailable')
  })
  it('request_timeout code and 504 as an API error', () => {
    expect(noUser(new AuthApiError('timeout', 504, 'request_timeout')).kind).toBe('unavailable')
  })
  it('a 401 or 403 WITHOUT an auth error code is a gateway/API-key problem, never a logout', () => {
    expect(noUser(new AuthApiError('Invalid authentication credentials', 401, undefined))).toMatchObject({ kind: 'unavailable', cause: 'gateway_auth_misconfig' })
    expect(noUser(new AuthApiError('forbidden', 403, undefined))).toMatchObject({ kind: 'unavailable', cause: 'gateway_auth_misconfig' })
  })
  it('a 401 with an UNKNOWN code is not promoted to logged-out', () => {
    expect(noUser(new AuthApiError('something new', 401, 'some_future_code')).kind).toBe('unavailable')
  })
  it('an allowlisted code on a NON-auth error name is not trusted', () => {
    expect(noUser({ name: 'SomethingElse', status: 401, code: 'bad_jwt', message: 'x' }).kind).toBe('unavailable')
  })
  it('5xx API errors, AuthUnknownError, plain Errors, TypeError(fetch failed), strings and objects without fields', () => {
    expect(noUser(new AuthApiError('boom', 500, 'unexpected_failure')).kind).toBe('unavailable')
    expect(noUser(new AuthUnknownError('???', new Error('x'))).kind).toBe('unavailable')
    expect(noUser(new Error('boom')).kind).toBe('unavailable')
    expect(noUser(new TypeError('fetch failed')).kind).toBe('unavailable')
    expect(noUser('boom').kind).toBe('unavailable')
    expect(noUser({}).kind).toBe('unavailable')
  })
  it('carries the SDK name/status/code and a Retry-After hint for logging and the 503', () => {
    const r = noUser(new AuthRetryableFetchError('x', 503))
    expect(r).toMatchObject({ kind: 'unavailable', sdkName: 'AuthRetryableFetchError', sdkStatus: 503, cause: 'gateway_5xx' })
    expect((r as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0)
  })
  it('NEGATIVE CONTROL: no error class other than the proven ones can yield unauthenticated', () => {
    const candidates: unknown[] = [
      new AuthRetryableFetchError('x', 0), new AuthRefreshDiscardedError(), new AuthUnknownError('x', null),
      new AuthApiError('x', 500, 'unexpected_failure'), new AuthApiError('x', 429, 'over_request_rate_limit'),
      new AuthApiError('x', 401, undefined), new AuthApiError('x', 403, undefined), new AuthApiError('x', 401, 'weak_password'),
      new Error('x'), new TypeError('fetch failed'), 'x', {},
    ]
    for (const c of candidates) expect(noUser(c).kind, String((c as { name?: string })?.name ?? c)).toBe('unavailable')
  })
})

describe('resolveAuthWith -- never throws', () => {
  it('maps a rejected/thrown getUser to unavailable(thrown)', async () => {
    expect(await resolveAuthWith(async () => { throw new TypeError('fetch failed') })).toMatchObject({ kind: 'unavailable', cause: 'thrown' })
    expect(await resolveAuthWith(() => Promise.reject('plain string'))).toMatchObject({ kind: 'unavailable', cause: 'thrown' })
  })
  it('passes the resolved user/error through the classifier', async () => {
    expect(await resolveAuthWith(async () => ({ data: { user: USER }, error: null }))).toEqual({ kind: 'authenticated', userId: USER.id })
    expect((await resolveAuthWith(async () => ({ data: { user: null }, error: new AuthSessionMissingError() }))).kind).toBe('unauthenticated')
    expect((await resolveAuthWith(async () => ({ data: { user: null }, error: new AuthRetryableFetchError('x', 0) }))).kind).toBe('unavailable')
    expect((await resolveAuthWith(async () => ({ data: null as never, error: null }))).kind).toBe('unauthenticated')
  })
})

describe('the proven-invalid-session allowlist is itemised, exact-match, wildcard-free', () => {
  it('contains exactly these codes -- adding or removing one must be a deliberate, reviewed test change', () => {
    expect([...PROVEN_INVALID_SESSION_CODES].sort()).toEqual([
      'bad_jwt',
      'invalid_jwt',
      'no_authorization',
      'refresh_token_already_used',
      'refresh_token_not_found',
      'session_expired',
      'session_not_found',
      'user_not_found',
    ])
  })

  it.each([
    'refresh_token_', 'refresh_token', 'refresh_token_expired', 'refresh_token_revoked', 'refresh_token_not_found_x',
    'REFRESH_TOKEN_NOT_FOUND', 'Refresh_Token_Already_Used', ' refresh_token_not_found', 'refresh_token_not_found ',
    'session_', 'session_revoked', 'jwt_expired', 'bad_jwt2', 'invalid_jwt_signature', 'user_', 'no_authorization_header', '*', '.*',
  ])('near-miss code %j on a 401 AuthApiError is NOT promoted to logged-out', code => {
    const r = noUser(new AuthApiError('x', 401, code))
    expect(r.kind).toBe('unavailable')
  })

  it.each(['refresh_token_not_found', 'refresh_token_already_used'])('the real refresh-token failure %s (HTTP 400, as GoTrue sends it) -> unauthenticated', code => {
    expect(noUser(new AuthApiError('Invalid Refresh Token', 400, code))).toEqual({ kind: 'unauthenticated', reason: 'invalid_session' })
  })

  it('session_not_found: the SDK itself converts it to AuthSessionMissingError; as an API error it is also unauthenticated', () => {
    expect(noUser(new AuthSessionMissingError())).toMatchObject({ kind: 'unauthenticated' })
    expect(noUser(new AuthApiError('x', 403, 'session_not_found'))).toMatchObject({ kind: 'unauthenticated' })
  })

  it('the classifier source contains no prefix/suffix/regex matching of the code', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/auth/resolve-auth.ts', 'utf8').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/\bstartsWith\b|\bendsWith\b|\bRegExp\b|\.test\(|\.match\(|\.includes\(|\.indexOf\(|toLowerCase|toUpperCase/)
    expect(src).toMatch(/PROVEN_INVALID_SESSION_CODES\.has\(code\)/)
  })
})
