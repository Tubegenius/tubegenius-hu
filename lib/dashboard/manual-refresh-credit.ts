// A Dashboard "Extra keresés" gombjának (handleManualRefresh, DashboardClient.tsx)
// kredit-előellenőrzése — kiszervezve saját, tisztán tesztelhető modulba, mert
// korábban a komponensen belüli catch-ág hálózati/JSON hiba esetén közvetlenül
// force_refresh=true Opportunity keresést indított (fail-open). Ez a modul
// SOSE dönt keresésről — csak megmondja, sikerült-e a kredit-egyenleg lekérése,
// a komponens a `ok:false` esetén garantáltan nem hívja meg a keresést.
export type ManualRefreshCreditCheckResult =
  | { ok: true; balance: number }
  | { ok: false; balance: null; error: string }

export async function checkManualRefreshCredit(
  fetchImpl: typeof fetch = fetch,
): Promise<ManualRefreshCreditCheckResult> {
  try {
    const res = await fetchImpl('/api/credits')
    if (!res.ok) {
      return { ok: false, balance: null, error: 'credit_check_http_error' }
    }
    const credits = await res.json()
    const balance = credits?.balance
    if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) {
      return { ok: false, balance: null, error: 'invalid_balance_response' }
    }
    return { ok: true, balance }
  } catch {
    return { ok: false, balance: null, error: 'network_error' }
  }
}
