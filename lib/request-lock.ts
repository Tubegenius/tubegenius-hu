// ============================================================
// WILLVIRAL — In-flight request lock (Beta Hardening Test fix #1)
// ============================================================
// Ket egyideju, azonos tartalmu keres (pl. ket bongeszofulben ugyanazzal
// a userrel) nelkule mindketto vegigfut es mindketto kulon kreditet von
// le ugyanazert az erdemi eredmenyert. Ez a helper egy rovid eletu
// "foglaltsag" sort probal beszurni, mielott egy route elindítana a draga
// AI-hivast. A zár user-szintű, nem csak azonos inputra érvényes: két eltérő
// fizetős kérés se olvashassa egyszerre ugyanazt a kredit-egyenleget, majd
// okozzon utólagos levonási race-t.
import { createServerClient } from '@supabase/ssr'

// ONE stale-lock TTL for BOTH acquire paths (legacy acquireRequestLock and
// acquireRequestLockStrict). They share one table and one user-wide lock key
// (__user_paid_operation__/active), so two different thresholds would let the shorter one
// reap the other path's lock. This also lengthens the wait of every route still on the
// legacy helper after a crashed/killed request: 5 min -> 7 min (see the inventory in the
// wave-1 report).
// A paid route cannot outlive the platform function ceiling. Verified 2026-10-03 (Vercel
// dashboard, read-only): project tubegenius-hu is on the Hobby plan with Fluid compute
// enabled and an EMPTY "Default Max Duration" override (placeholder/default 300 s); in
// code only transcript (60 s) and the cron (300 s) set maxDuration, so every other route
// runs under the 300 s default. That is a settings snapshot, not a measured run time.
// The stale-lock reaper must NEVER consider a lock of a still-running request stale:
//   * created_at is stamped by the DATABASE clock, the threshold below by the APP clock;
//   * the platform kill at the ceiling is not instantaneous;
//   * created_at is written AFTER function start (auth + profile read come first), which
//     only ever helps the margin.
// A TTL equal to the ceiling (the former 5 min) left a margin of just that pre-lock time
// minus the skew. 7 min keeps a 120 s margin; a crashed/killed request frees the user
// 2 min after the ceiling instead of 0 -- a deliberate trade.
// RESIDUAL RISK (accepted, not eliminated): the DB-clock vs app-clock difference is not
// measured or bounded here. The 120 s margin only covers a skew/kill-lag below that; a
// larger skew (or a function that runs past the ceiling) could still let a second request
// reap a live request's lock. Closing it fully needs the cutoff computed by the database
// (e.g. an RPC using now()), which is a schema change and out of scope for this wave.
export const ROUTE_MAX_DURATION_MS = 300 * 1000
export const LOCK_STALE_MARGIN_MS = 120 * 1000
export const LOCK_TTL_MS = ROUTE_MAX_DURATION_MS + LOCK_STALE_MARGIN_MS

// The unique index of migration 027 on (user_id, tool_type, input_hash). The table has
// exactly two unique constraints: the primary key (random uuid) and this one.
export const LOCK_UNIQUE_INDEX = 'idx_in_flight_requests_unique'

// A 23505 is a REAL lock conflict only when it comes from the lock-key index. PostgREST
// puts the constraint name in `message` and the offending columns in `details`.
export function isLockKeyViolation(error: unknown): boolean {
  const e = (error && typeof error === 'object' ? error : {}) as { code?: unknown; message?: unknown; details?: unknown }
  if (e.code !== '23505') return false
  const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.details === 'string' ? e.details : ''}`
  return text.includes(LOCK_UNIQUE_INDEX) || text.includes('(user_id, tool_type, input_hash)')
}

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

export interface RequestLockKey {
  userId: string
  toolType: string
  inputHash: string
}

export interface RequestLockHandle {
  acquired: boolean
  lockId?: string
}

export async function acquireRequestLock(key: RequestLockKey): Promise<RequestLockHandle> {
  const admin = adminClient()
  const staleThreshold = new Date(Date.now() - LOCK_TTL_MS).toISOString()
  const lockToolType = '__user_paid_operation__'
  const lockInputHash = 'active'

  // Elavult (feltehetoen lezuhant hivasbol maradt) lock opportunista takaritasa,
  // hogy egy korabbi crash ne zarja ki a usert vegleg ugyanarra a bemenetre.
  await admin
    .from('in_flight_requests')
    .delete()
    .eq('user_id', key.userId)
    .eq('tool_type', lockToolType)
    .eq('input_hash', lockInputHash)
    .lt('created_at', staleThreshold)

  const { data, error } = await admin
    .from('in_flight_requests')
    .insert({ user_id: key.userId, tool_type: lockToolType, input_hash: lockInputHash })
    .select('id')
    .single()

  if (error || !data) {
    // "undefined_table" (Postgres 42P01) VAGY PostgREST sajat "nincs a schema
    // cache-ben" hibaja (PGRST205) — mindketto azt jelenti, hogy a 027-es
    // migracio meg nincs lefuttatva. Fail-open: inkabb engedjuk at vedelmi
    // zar nelkul (a regi viselkedes), mint hogy MINDEN fizetos route-ot
    // letiltsunk egy hianyzo tabla miatt.
    const code = (error as { code?: string } | null)?.code
    if (code === '42P01' || code === 'PGRST205') {
      console.error('[RequestLock] in_flight_requests tábla nem létezik — migráció 027 még nem futott le, lock kihagyva.')
      return { acquired: true }
    }
    // barmilyen mas hiba (pl. egyedi kulcs utkozes) = mar fut egy azonos keres ugyanerre a bemenetre
    return { acquired: false }
  }
  return { acquired: true, lockId: data.id as string }
}

// Backend error contract (wave 1): STRICT lock acquisition. acquireRequestLock() above
// keeps its behaviour (fail-open for a missing table, any other error -> acquired:false)
// for the routes that have not migrated yet; only its stale-lock TTL is the shared one.
//
//   acquired    -> the insert succeeded.
//   conflict    -> a REAL conflict only: PostgreSQL unique_violation (23505) raised by the
//                  lock-key index idx_in_flight_requests_unique (user-wide key), i.e. another
//                  paid operation of this user is running. A 23505 from any other constraint
//                  (or one that cannot be attributed) is `unavailable`.
//   unavailable -> EVERYTHING else: network/gateway/timeout/unknown errors, a thrown
//                  fetch error, a missing table (42P01), a table the API schema cache
//                  does not know (PGRST205), or an insert that returned no row.
//
// Unlike acquireRequestLock() there is NO fail-open for a missing table: with no lock
// the double-charge race (migration 027) is back, so a paid route must stop BEFORE any
// provider call or charge. PGRST205 may be transient (schema cache reload) but it is
// deliberately NOT retried here: an automatic retry needs its own proof and decision.
export type RequestLockResult =
  | { status: 'acquired'; lockId: string }
  | { status: 'conflict' }
  | { status: 'unavailable'; cause: string }

export async function acquireRequestLockStrict(key: RequestLockKey): Promise<RequestLockResult> {
  try {
    const admin = adminClient()
    const staleThreshold = new Date(Date.now() - LOCK_TTL_MS).toISOString()
    const lockToolType = '__user_paid_operation__'
    const lockInputHash = 'active'

    // Opportunistic stale-lock cleanup. A failure here is logged, never fatal.
    const { error: cleanupError } = await admin
      .from('in_flight_requests')
      .delete()
      .eq('user_id', key.userId)
      .eq('tool_type', lockToolType)
      .eq('input_hash', lockInputHash)
      .lt('created_at', staleThreshold)
    if (cleanupError) console.error('[RequestLock] stale-lock cleanup failed:', cleanupError.code || cleanupError.message)

    const { data, error } = await admin
      .from('in_flight_requests')
      .insert({ user_id: key.userId, tool_type: lockToolType, input_hash: lockInputHash })
      .select('id')
      .single()

    if (!error && data?.id) return { status: 'acquired', lockId: String(data.id) }

    const code = (error as { code?: string } | null)?.code || ''
    if (isLockKeyViolation(error)) return { status: 'conflict' }
    if (code === '23505') {
      // A unique violation we cannot attribute to the lock-key index must not be reported
      // as "another operation is running": fail closed instead.
      console.error('[RequestLock] unique violation NOT attributable to the lock-key index -- failing CLOSED')
      return { status: 'unavailable', cause: '23505_other_constraint' }
    }

    if (code === '42P01' || code === 'PGRST205') {
      console.error(`[RequestLock] request_lock_table_missing_or_unknown_to_api code=${code} -- failing CLOSED (no lock, no provider call, no charge)`)
    } else {
      console.error(`[RequestLock] lock service unavailable code=${code || '-'} -- failing CLOSED`)
    }
    return { status: 'unavailable', cause: code || (error ? 'error_without_code' : 'no_row_returned') }
  } catch (thrown) {
    console.error('[RequestLock] lock acquisition threw -- failing CLOSED:', thrown instanceof Error ? thrown.name : 'non-error')
    return { status: 'unavailable', cause: 'thrown' }
  }
}

// Releasing is best-effort and runs in a `finally` AFTER the paid work. What this function guarantees:
//   * a release that FAILS (an `{ error }` result, including the `{ error: { code: '' } }` the real
//     postgrest-js returns for a rejected fetch) or THROWS is logged and swallowed, so it does not turn an
//     already-built, charged response into an error; the user-wide lock then stays until the TTL expires,
//     blocking every paid tool for that user;
//   * only the Postgres/PostgREST error CODE (or the thrown error's class name) is logged -- never the lock
//     id, user id, hashes, message, details, hint or URL.
// What it does NOT guarantee -- OPEN PAID-PATH RISK (deliberately not changed here): a DELETE that never
// settles. adminClient() sets no timeout / abort signal and the callers `await` this in a `finally` before
// the response leaves the handler, so a hanging DELETE would hold an already-charged response until the
// platform kills the function (300 s). Verified offline with the installed postgrest-js 2.108.1 (fake fetch):
// without a signal the call never settles; with `.abortSignal(AbortSignal.timeout(ms))` it RESOLVES (does not
// throw) with `{ error: { code: '' } }` after the timeout; an abort cannot tell whether the server already
// executed the DELETE; DELETE is not retried. NOT verified: real Vercel/undici/PostgREST abort behaviour and
// whether a timeout would leave the lock for the full TTL more often than it saves a hung response.
export async function releaseRequestLock(lockId?: string | null): Promise<void> {
  if (!lockId) return
  try {
    const admin = adminClient()
    const { error } = (await admin.from('in_flight_requests').delete().eq('id', lockId)) ?? {}
    if (error) console.error(`[RequestLock] release failed code=${(error as { code?: string }).code || '-'} -- the lock stays until the TTL expires`)
  } catch (thrown) {
    console.error(`[RequestLock] release threw ${thrown instanceof Error ? thrown.name : 'non-error'} -- the lock stays until the TTL expires`)
  }
}

export const REQUEST_IN_PROGRESS_ERROR = 'Már folyamatban van egy generálásod egy másik lapon vagy eszközön. Kérlek várj, amíg befejeződik, mielőtt újat indítasz.'
