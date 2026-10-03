// ============================================================
// WILLVIRAL -- cookie-aware session auth resolution (backend error contract)
// ============================================================
// Problem. supabase.auth.getUser() refreshes an expired access token with the refresh token and
// @supabase/ssr hands every resulting cookie change to setAll(cookies, headers):
//   * a SUCCESSFUL refresh  -> one operation: delete the stale cookie/chunk names + set the new ones;
//   * a FAILED refresh with any non-retryable auth error -> auth-js removes the session -> an operation
//     that only DELETES the auth cookies.
// With a plain pass-through setAll, a TRANSIENT failure (GoTrue 500, rate limit, bad gateway key, HTML
// error page) is classified 503 by classifyAuthOutcome() but its response still deletes the browser's
// (still valid) session cookie. With a no-op setAll, a successful rotation is thrown away and the
// browser keeps the already-rotated refresh token.
//
// So every setAll CALL is recorded as one indivisible operation and the decision is taken after the
// classification of the same getUser():
//   * authenticated    -> apply ALL operations, in order (a rotation reaches the browser as a whole,
//                         including the deletion of the stale chunks that belong to it);
//   * unauthenticated  -> apply all operations only when `persistOnInvalidSession` (the session is PROVEN
//                         dead, clearing its cookie is correct); otherwise apply none;
//   * unavailable      -> apply only the operations that contain a non-empty cookie value, i.e. a complete
//                         SUCCESSFUL rotation (e.g. refresh ok, then /user answers 500); DROP the
//                         deletion-only operations (the session removal caused by the transient failure).
// getAll() sees the recorded-but-not-yet-applied writes (as it would if they had been written
// immediately), so a later operation of the same request computes its chunk deletions from the true state.
// The cache headers @supabase/ssr passes as the second setAll argument (Cache-Control: private, no-cache,
// no-store..., Expires, Pragma) are collected and exposed to the caller ONLY when cookies were applied;
// the route must put them on its response (withSessionResponseHeaders below).
//
// Not covered: this only changes the routes that call resolveSessionAuth (/api/credits, and
// resolveUserAuth() used by /api/title-studio). The legacy getUserId() routes and the routes that call
// auth.getUser() inline are untouched.
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { resolveAuthWith, type AuthResolution } from '@/lib/auth/resolve-auth'

type CookieStore = Awaited<ReturnType<typeof cookies>>
type Cookie = { name: string; value: string; options?: Record<string, unknown> }
type Operation = { cookies: Cookie[]; headers: Record<string, string> }

/** Out-parameter: the response headers to add to the HTTP response when session cookies were applied. */
export interface SessionResponseHeaders { headers: Record<string, string> }

export interface SessionAuthOptions {
  /** API key the auth client is created with (anon key or, for parity with getUserId(), the service-role key). */
  apiKey: string
  /** Apply the cookie operations of a PROVEN-invalid session (cookie deletion) to the response. */
  persistOnInvalidSession: boolean
}

/** A complete successful rotation (or any set) contains at least one non-empty cookie value. */
const containsSet = (op: Operation) => op.cookies.some(c => c.value !== '')

export async function resolveSessionAuth(options: SessionAuthOptions, session?: SessionResponseHeaders): Promise<AuthResolution> {
  let store: CookieStore | null = null
  let decided: AuthResolution['kind'] | null = null
  const recorded: Operation[] = []
  const overlay = new Map<string, string | null>() // name -> value, null = deleted (as setAll would leave the store)

  const shouldApply = (kind: AuthResolution['kind'], op: Operation) =>
    kind === 'authenticated' ||
    (kind === 'unauthenticated' && options.persistOnInvalidSession) ||
    (kind === 'unavailable' && containsSet(op))

  const apply = (op: Operation) => {
    // One try/catch per operation (the same granularity as the previous per-setAll loop): cookies
    // cannot be written from a read-only context.
    try { for (const c of op.cookies) (store as CookieStore).set(c.name, c.value, c.options as never) } catch { /* read-only context */ }
    if (session && op.cookies.length > 0) Object.assign(session.headers, op.headers)
  }

  const resolution = await resolveAuthWith(async () => {
    store = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      options.apiKey,
      {
        cookies: {
          getAll() {
            const view = new Map((store as CookieStore).getAll().map(c => [c.name, c.value] as const))
            for (const [name, value] of overlay) { if (value === null) view.delete(name); else view.set(name, value) }
            return [...view].map(([name, value]) => ({ name, value }))
          },
          setAll(cookiesToSet, headers) {
            const op: Operation = { cookies: cookiesToSet as Cookie[], headers: { ...(headers ?? {}) } }
            for (const c of op.cookies) overlay.set(c.name, c.value === '' ? null : c.value)
            if (decided === null) recorded.push(op)
            else if (shouldApply(decided, op)) apply(op) // a write arriving after the decision
          },
        },
      },
    )
    return supabase.auth.getUser()
  })

  decided = resolution.kind
  if (store) for (const op of recorded) if (shouldApply(decided, op)) apply(op)
  recorded.length = 0
  return resolution
}

/**
 * Runs a route handler and adds the session cache headers collected by resolveSessionAuth() to ITS response
 * (headers only exist when session cookies were applied). Setting headers cannot fail the response.
 */
export async function withSessionResponseHeaders(run: (session: SessionResponseHeaders) => Promise<Response>): Promise<Response> {
  const session: SessionResponseHeaders = { headers: {} }
  const response = await run(session)
  for (const [name, value] of Object.entries(session.headers)) {
    try { response.headers.set(name, value) } catch { /* immutable response headers: leave the response unchanged */ }
  }
  return response
}
