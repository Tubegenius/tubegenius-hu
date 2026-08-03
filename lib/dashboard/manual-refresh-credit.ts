// A Dashboard "Extra keresés" gombjának (handleManualRefresh, DashboardClient.tsx)
// kredit-előellenőrzése — kiszervezve saját, tisztán tesztelhető modulba, mert
// korábban a komponensen belüli catch-ág hálózati/JSON hiba esetén közvetlenül
// force_refresh=true Opportunity keresést indított (fail-open). Ez a modul
// SOSE dönt keresésről — csak megmondja, sikerült-e a kredit-egyenleg lekérése,
// a komponens a `ok:false` esetén garantáltan nem hívja meg a keresést.
export interface ManualRefreshCreditCheckResult {
  ok: boolean
  balance: number
  error?: string
}

export async function checkManualRefreshCredit(
  fetchImpl: typeof fetch = fetch,
): Promise<ManualRefreshCreditCheckResult> {
  try {
    const res = await fetchImpl('/api/credits')
    if (!res.ok) {
      return { ok: false, balance: 0, error: 'credit_check_http_error' }
    }
    const credits = await res.json()
    const balance = Number(credits?.balance ?? 0)
    if (!Number.isFinite(balance)) {
      return { ok: false, balance: 0, error: 'invalid_balance_response' }
    }
    return { ok: true, balance }
  } catch {
    return { ok: false, balance: 0, error: 'network_error' }
  }
}
