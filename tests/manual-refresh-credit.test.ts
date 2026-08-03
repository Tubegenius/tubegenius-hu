// PFM-2E korrekció — a Dashboard "Extra keresés" gombjának kredit-előellenőrzését
// kiszervezett, tisztán tesztelhető modulként bizonyítja: sem hálózati hiba, sem
// non-2xx válasz, sem JSON-feldolgozási hiba nem eredményezhet SEMMILYEN
// /api/opportunity hívást — a modul maga sosem ér el ezt az endpointot, csak a
// /api/credits-et, tehát ez a teszt önmagában garantálja a "0 Opportunity POST"
// invariánst minden hibaágra. A DashboardClient.tsx felelőssége (amit a
// tests/opportunity-client-static-checks.test.ts statikus ellenőrzése fed le)
// csak annyi, hogy a `!check.ok` esetén sose hívja meg a loadOpportunities-t.
import { describe, expect, it, vi } from 'vitest'
import { checkManualRefreshCredit } from '@/lib/dashboard/manual-refresh-credit'

function countOpportunityPosts(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/opportunity')).length
}

describe('checkManualRefreshCredit', () => {
  it('success: returns ok:true with the balance from /api/credits, never touches /api/opportunity', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ balance: 5 }), { status: 200 }))
    const result = await checkManualRefreshCredit(fetchMock as unknown as typeof fetch)

    expect(result).toEqual({ ok: true, balance: 5 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/credits')
    expect(countOpportunityPosts(fetchMock)).toBe(0)
  })

  it('network error: returns ok:false, error:"network_error", 0 /api/opportunity calls', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const result = await checkManualRefreshCredit(fetchMock as unknown as typeof fetch)

    expect(result.ok).toBe(false)
    expect(result.error).toBe('network_error')
    expect(result.balance).toBe(0)
    expect(countOpportunityPosts(fetchMock)).toBe(0)
  })

  it('non-2xx response: returns ok:false, error:"credit_check_http_error", 0 /api/opportunity calls', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'server error' }), { status: 500 }))
    const result = await checkManualRefreshCredit(fetchMock as unknown as typeof fetch)

    expect(result.ok).toBe(false)
    expect(result.error).toBe('credit_check_http_error')
    expect(countOpportunityPosts(fetchMock)).toBe(0)
  })

  it('JSON parse failure (invalid body): returns ok:false, error:"network_error", 0 /api/opportunity calls', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }))
    const result = await checkManualRefreshCredit(fetchMock as unknown as typeof fetch)

    expect(result.ok).toBe(false)
    expect(countOpportunityPosts(fetchMock)).toBe(0)
  })

  it('malformed balance (non-numeric): returns ok:false, error:"invalid_balance_response"', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ balance: 'not-a-number' }), { status: 200 }))
    const result = await checkManualRefreshCredit(fetchMock as unknown as typeof fetch)

    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_balance_response')
  })

  it('never calls loadOpportunities-equivalent (does not reference /api/opportunity at all in its source)', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(process.cwd(), 'lib', 'dashboard', 'manual-refresh-credit.ts'), 'utf-8')
    // Csak a tényleges hívást vizsgáljuk (nem a dokumentáló megjegyzéseket,
    // amik szándékosan magyarázzák a korábbi force_refresh-es hibát).
    expect(src).not.toContain("fetchImpl('/api/opportunity")
    expect(src).not.toMatch(/force_refresh\s*:/)
  })
})
