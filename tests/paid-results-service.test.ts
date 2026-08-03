// PFM-2E — pontosító regressziós/dokumentáló tesztek a lib/paid-results/
// paid-results-service.ts jelenlegi, VÁLTOZATLAN viselkedésére.
//
// Ez a fájl NEM módosítja és NEM teszteli újra a service belső logikáját —
// azt bizonyítja, amit a PFM-2E audit és terv kifejezetten megkövetel:
// 1) getPaidResultByHash/getPaidResultById MA IS frissségtől függetlenül ad
//    vissza találatot (ezt a route.ts kompenzálja explicit paidCacheStatus()
//    ellenőrzéssel — ld. tests/opportunity-route-paid-result-freshness.test.ts).
// 2) paidCacheStatus() helyesen különbözteti meg a friss/lejárt állapotot.
// 3) savePaidResult() ütközéskor (user_id,tool_type,input_hash) UGYANAZT a
//    sort frissíti — az id-t a DB adja vissza változatlanul, a service nem
//    generál új id-t —, ez a jelenlegi, dokumentált korlát (PFM-2F: history
//    verziózás külön feladat, ebben a körben NEM változik).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))

function makeFakeAdmin(result: { data: unknown; error: unknown }) {
  const query: any = {
    select: vi.fn(() => query),
    upsert: vi.fn(() => query),
    update: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(() => Promise.resolve(result)),
  }
  return { from: vi.fn(() => query), _query: query }
}

describe('paidCacheStatus', () => {
  it('returns "fresh" when fresh_until is in the future', async () => {
    const { paidCacheStatus } = await import('@/lib/paid-results/paid-results-service')
    const status = paidCacheStatus({
      fresh_until: new Date(Date.now() + 3600_000).toISOString(),
      last_refreshed_at: new Date().toISOString(),
    })
    expect(status).toBe('fresh')
  })

  it('returns "stale_saved" when fresh_until is in the past', async () => {
    const { paidCacheStatus } = await import('@/lib/paid-results/paid-results-service')
    const status = paidCacheStatus({
      fresh_until: new Date(Date.now() - 3600_000).toISOString(),
      last_refreshed_at: new Date().toISOString(),
    })
    expect(status).toBe('stale_saved')
  })

  it('returns "stale_saved" when fresh_until is null (documents current behavior)', async () => {
    const { paidCacheStatus } = await import('@/lib/paid-results/paid-results-service')
    const status = paidCacheStatus({ fresh_until: null, last_refreshed_at: new Date().toISOString() })
    expect(status).toBe('stale_saved')
  })
})

describe('getPaidResultByHash / getPaidResultById — freshness-blind lookup (unchanged, documented)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('getPaidResultByHash returns an already-expired record as-is (no fresh_until filter)', async () => {
    const expiredRecord = {
      id: 'paid-1', status: 'completed',
      fresh_until: new Date(Date.now() - 999_000_000).toISOString(),
      result_json: { topics: ['old'] },
    }
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(makeFakeAdmin({ data: expiredRecord, error: null }) as any)

    const { getPaidResultByHash } = await import('@/lib/paid-results/paid-results-service')
    const result = await getPaidResultByHash({ userId: 'u1', toolType: 'opportunity_engine', inputHash: 'h1' })
    expect(result).toEqual(expiredRecord)
  })

  it('getPaidResultById returns an already-expired record as-is (explicit open stays freshness-independent)', async () => {
    const expiredRecord = {
      id: 'paid-2', status: 'completed',
      fresh_until: new Date(Date.now() - 999_000_000).toISOString(),
      result_json: { topics: ['old'] },
    }
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(makeFakeAdmin({ data: expiredRecord, error: null }) as any)

    const { getPaidResultById } = await import('@/lib/paid-results/paid-results-service')
    const result = await getPaidResultById('u1', 'paid-2')
    expect(result).toEqual(expiredRecord)
  })
})

describe('savePaidResult — upsert-on-conflict behavior (PFM-2F scope note: no history/versioning yet)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('upserts with onConflict "user_id,tool_type,input_hash" and status always "completed"', async () => {
    const fakeAdmin = makeFakeAdmin({ data: { id: 'paid-3', status: 'completed' }, error: null })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as any)

    const { savePaidResult } = await import('@/lib/paid-results/paid-results-service')
    await savePaidResult({
      userId: 'u1', toolType: 'opportunity_engine', inputHash: 'h1',
      normalizedInput: 'norm', originalInput: 'orig',
      resultJson: { topics: ['new'] }, freshForHours: 24,
    })

    expect(fakeAdmin._query.upsert).toHaveBeenCalledTimes(1)
    const [payload, options] = fakeAdmin._query.upsert.mock.calls[0]
    expect(options).toEqual({ onConflict: 'user_id,tool_type,input_hash' })
    expect(payload.status).toBe('completed')
    expect(payload.result_json).toEqual({ topics: ['new'] })
  })

  it('documents that a conflicting save returns the SAME id the DB already had — no new row, no history preserved', async () => {
    // Ez a teszt a Postgres ON CONFLICT ... DO UPDATE szemantikáját szimulálja:
    // a mockolt DB-válasz UGYANAZT az id-t adja vissza, mint egy "korábbi" mentésnél —
    // a service ezt változtatás nélkül adja tovább, tehát az id sosem a service-ben
    // generálódik újra ütközéskor.
    const existingId = 'paid-stable-id-123'
    const fakeAdmin = makeFakeAdmin({
      data: { id: existingId, status: 'completed', result_json: { topics: ['második keresés eredménye'] } },
      error: null,
    })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as any)

    const { savePaidResult } = await import('@/lib/paid-results/paid-results-service')
    const second = await savePaidResult({
      userId: 'u1', toolType: 'opportunity_engine', inputHash: 'same-hash',
      normalizedInput: 'norm', originalInput: 'orig',
      resultJson: { topics: ['második keresés eredménye'] }, freshForHours: 24,
    })

    expect(second.success).toBe(true)
    expect(second.record?.id).toBe(existingId)
    // A régi result_json-nak (pl. { topics: ['első keresés eredménye'] }) NINCS
    // semmilyen külön tárolt helye ebben a válaszban vagy sémában — ezt a
    // PFM-2F feladat (történeti verziózás) fogja kezelni, ebben a körben nem.
  })

  it('sets fresh_until based on freshForHours', async () => {
    const fakeAdmin = makeFakeAdmin({ data: { id: 'paid-4' }, error: null })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as any)

    const { savePaidResult } = await import('@/lib/paid-results/paid-results-service')
    const before = Date.now()
    await savePaidResult({
      userId: 'u1', toolType: 'opportunity_engine', inputHash: 'h1',
      normalizedInput: 'norm', originalInput: 'orig',
      resultJson: {}, freshForHours: 24,
    })
    const [payload] = fakeAdmin._query.upsert.mock.calls[0]
    const freshUntilMs = new Date(payload.fresh_until).getTime()
    expect(freshUntilMs).toBeGreaterThan(before + 23 * 3600_000)
    expect(freshUntilMs).toBeLessThan(before + 25 * 3600_000)
  })
})
