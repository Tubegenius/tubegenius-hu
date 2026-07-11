// ============================================================
// WILLVIRAL — In-flight request lock (Beta Hardening Test fix #1)
// ============================================================
// Ket egyideju, azonos tartalmu keres (pl. ket bongeszofulben ugyanazzal
// a userrel) nelkule mindketto vegigfut es mindketto kulon kreditet von
// le ugyanazert az erdemi eredmenyert. Ez a helper egy rovid eletu
// "foglaltsag" sort probal beszurni (user_id, tool_type, input_hash)
// egyedi kulccsal, mielott egy route elindítana a draga AI-hivast —
// ha mar letezik ilyen sor, a masodik keres azonnal, AI-hivas es
// kreditlevonas NELKUL kap baratsagos hibat.
import { createServerClient } from '@supabase/ssr'

const LOCK_TTL_MS = 45000 // boven tobb, mint egy tipikus AI-hivas — de nem tart oraig, ha egy hivas lezuhan lock-felszabaditas nelkul

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

  // Elavult (feltehetoen lezuhant hivasbol maradt) lock opportunista takaritasa,
  // hogy egy korabbi crash ne zarja ki a usert vegleg ugyanarra a bemenetre.
  await admin
    .from('in_flight_requests')
    .delete()
    .eq('user_id', key.userId)
    .eq('tool_type', key.toolType)
    .eq('input_hash', key.inputHash)
    .lt('created_at', staleThreshold)

  const { data, error } = await admin
    .from('in_flight_requests')
    .insert({ user_id: key.userId, tool_type: key.toolType, input_hash: key.inputHash })
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

export async function releaseRequestLock(lockId?: string | null): Promise<void> {
  if (!lockId) return
  const admin = adminClient()
  await admin.from('in_flight_requests').delete().eq('id', lockId)
}

export const REQUEST_IN_PROGRESS_ERROR = 'Ez a kérés már folyamatban van egy másik lapon vagy eszközön. Kérlek várj, amíg befejeződik, mielőtt újra elindítod.'
