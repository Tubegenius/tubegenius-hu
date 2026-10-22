// ============================================================
// WILLVIRAL -- auth outcome classification (backend error contract, wave 1)
// ============================================================
// Why this exists: supabase.auth.getUser() returns { user: null, error } for
// BOTH "this request has no valid session" and "the Supabase Auth gateway could
// not be reached / answered 5xx". Every route used to read only `user` and
// answer 401 for both, and the client turns a 401 into a hard redirect to the
// login page -- so a transient gateway problem looked like a logout.
//
// Contract (accepted principle):
//   * `unauthenticated` (-> HTTP 401, logout-capable) ONLY for a PROVEN missing
//     or invalid session.
//   * Anything else that is not a user -- network error, gateway 5xx, rate
//     limit, timeout, unknown error, a gateway 401/403 WITHOUT a known auth
//     error code -- is `unavailable` (-> HTTP 503, never logout-capable).
//   * A 503 never carries user data and never grants access (fail closed).
//
// Classification is by duck typing on `name` / `status` / `code` (not
// instanceof) so it keeps working if two copies of auth-js are bundled. The
// unit tests build the REAL error classes from the installed package, so an
// SDK upgrade that renames a class fails the tests instead of silently
// reclassifying outages.
import type { SupabaseClient } from '@supabase/supabase-js'

// Error codes (GoTrue `error_code`) that PROVE the credential/session is bad.
// Deliberately an allowlist, matched by EXACT string equality (Set.has): no prefix,
// suffix, case-insensitive or wildcard matching, so e.g. `refresh_token_expired` or
// `REFRESH_TOKEN_NOT_FOUND` are NOT promoted to "logged out". An unknown code is never
// promoted to "logged out". `refresh_token_already_used` is GoTrue's answer for a refresh
// token that was already rotated and is presented again outside its reuse interval (inside
// the interval GoTrue returns the rotated session instead, no error). That token can no
// longer be used to obtain a session, so THIS request has no valid session -- which is all
// the 401 claims. It does NOT assert that the whole session family was revoked: whether
// GoTrue also revokes the family depends on the project's refresh-token-reuse settings
// and is not something this classifier relies on or verified. A concurrent refresh by
// the same browser can in principle also surface it; that residual case is accepted as
// "this request's token is unusable", not as proof of a global logout.
// `session_not_found` is normally converted by auth-js
// itself into AuthSessionMissingError (lib/fetch.js); it is listed in case it ever
// surfaces as an API error.
export const PROVEN_INVALID_SESSION_CODES: ReadonlySet<string> = new Set([
  'bad_jwt',
  'invalid_jwt',
  'no_authorization',
  'user_not_found',
  'session_expired',
  'session_not_found',
  'refresh_token_not_found',
  'refresh_token_already_used',
])

export type UnauthenticatedReason = 'no_session' | 'invalid_session' | 'no_user_no_error'

export type UnavailableCause =
  | 'network'
  | 'gateway_5xx'
  | 'rate_limited'
  | 'timeout'
  | 'refresh_race'
  | 'gateway_auth_misconfig'
  | 'thrown'
  | 'unknown'

export type AuthResolution =
  | { kind: 'authenticated'; userId: string }
  | { kind: 'unauthenticated'; reason: UnauthenticatedReason }
  | { kind: 'unavailable'; cause: UnavailableCause; sdkName: string | null; sdkStatus: number | null; sdkCode: string | null; retryAfterSeconds: number }

interface ErrorLike {
  name?: unknown
  status?: unknown
  code?: unknown
  message?: unknown
}

function asErrorLike(error: unknown): ErrorLike {
  return error && typeof error === 'object' ? (error as ErrorLike) : {}
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function unavailable(cause: UnavailableCause, error: ErrorLike, retryAfterSeconds = 2): AuthResolution {
  return { kind: 'unavailable', cause, sdkName: str(error.name), sdkStatus: num(error.status), sdkCode: str(error.code), retryAfterSeconds }
}

/**
 * Pure classifier over what getUser() resolved with. `user` is the user object
 * (or null/undefined), `error` whatever getUser() returned as `error`.
 */
export function classifyAuthOutcome(input: { user: { id?: unknown } | null | undefined; error: unknown }): AuthResolution {
  const userId = input.user && typeof input.user.id === 'string' && input.user.id ? input.user.id : null
  if (userId) return { kind: 'authenticated', userId }

  if (input.error == null) {
    // No user and nothing says anything went wrong. There is no evidence of an
    // outage, so this is the ordinary "not signed in" answer (also the shape the
    // existing route tests mock).
    return { kind: 'unauthenticated', reason: 'no_user_no_error' }
  }

  const e = asErrorLike(input.error)
  const name = str(e.name)
  const status = num(e.status)
  const code = str(e.code)

  if (name === 'AuthSessionMissingError') return { kind: 'unauthenticated', reason: 'no_session' }

  if (name === 'AuthRetryableFetchError') {
    return unavailable(status === 0 || status === null ? 'network' : 'gateway_5xx', e)
  }
  if (name === 'AuthRefreshDiscardedError') return unavailable('refresh_race', e, 1)

  if (code === 'over_request_rate_limit' || status === 429) return unavailable('rate_limited', e, 5)
  if (code === 'request_timeout' || status === 408 || status === 504) return unavailable('timeout', e)

  if ((name === 'AuthApiError' || name === 'AuthInvalidJwtError') && code && PROVEN_INVALID_SESSION_CODES.has(code)) {
    return { kind: 'unauthenticated', reason: 'invalid_session' }
  }

  if ((status === 401 || status === 403) && !code) {
    // A 401/403 with no auth error code is not proof about THIS user's session:
    // it is what a gateway answers for a bad API key (see the staging key
    // mismatch). Treating it as "logged out" would sign every user out.
    return unavailable('gateway_auth_misconfig', e, 5)
  }

  if (status !== null && status >= 500) return unavailable('gateway_5xx', e)

  return unavailable('unknown', e)
}

/**
 * Runs getUser() and classifies the outcome. Never throws: a thrown fetch /
 * abort error becomes `unavailable` (cause 'thrown').
 */
export async function resolveAuthWith(
  getUser: () => Promise<{ data?: { user?: { id?: unknown } | null } | null; error?: unknown }>,
): Promise<AuthResolution> {
  try {
    const result = await getUser()
    return classifyAuthOutcome({ user: result?.data?.user ?? null, error: result?.error ?? null })
  } catch (thrown) {
    return unavailable('thrown', asErrorLike(thrown))
  }
}

export function resolveAuth(client: Pick<SupabaseClient, 'auth'>): Promise<AuthResolution> {
  return resolveAuthWith(() => client.auth.getUser())
}
