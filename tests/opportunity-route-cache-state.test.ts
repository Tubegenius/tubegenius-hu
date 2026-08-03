// PFM-2E korrekció — az opportunity_cache (a paid_results-tól FÜGGETLEN,
// második cache-mechanizmus) döntési ágainak regressziós tesztjei.
//
// SCOPE: ugyanaz a mockolási minta, mint a
// tests/opportunity-route-paid-result-freshness.test.ts-ben — a paid_results
// réteg mindenütt null-t ad vissza (nincs paid_result egyáltalán), így a
// route garantáltan az opportunity_cache ágakra fut. Azt bizonyítja, hogy:
// 1) a pontos kulcsú, még nem lejárt (fresh) opportunity_cache találat
//    változatlanul visszaadja a valódi tartalmat (cached:true);
// 2) a 7 napos, nap-váltás-toleráns fallback találat, ha MÁR lejárt, a
//    PFM-2E egységesítés szerint SOSE játssza vissza a régi topics/pool_topics
//    tartalmat — csak stale_cache_available metaadatot ad, tartalom nélkül,
//    és eközben 0 provider-/writer-/kredit-hívás történik;
// 3) teljes cache-miss esetén a válasz egyértelműen 'miss' állapotú.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/emerging-signal/capture', () => ({ captureOpportunitySignals: vi.fn(async () => ({ outcome: 'completed', clustersCompleted: 0, clustersSkipped: 0, clustersFailed: 0 })) }))
vi.mock('@/lib/trend-radar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trend-radar')>()
  return { ...actual, buildTrendCandidates: vi.fn(), getSerperHealthStatus: actual.getSerperHealthStatus }
})
vi.mock('@/lib/broad-niche-discovery', () => ({
  detectNicheIntent: vi.fn(() => 'specific_topic'),
  buildBroadNicheDiscoveryPacks: vi.fn(async () => []),
  buildDrilldownSeedsForDirection: vi.fn(() => ({ seeds: [], freshnessWindowDays: 120, category: 'default' })),
}))
vi.mock('@/lib/niche-expansion', () => ({ buildNicheExpansion: vi.fn(async () => ({ seeds: [], validation_seeds: ['seed a'], freshness_window_days: 120, category: 'default', source: 'test', rejected_seed_topics: [] })) }))
vi.mock('@/lib/usage-protection', () => ({
  logYouTubeSearch: vi.fn(async () => {}),
  checkUsagePermission: vi.fn(async () => ({ canRun: true, currency: 'free' })),
  chargeProtectedFeature: vi.fn(async () => ({ success: true, credit_transaction_id: 'tx-1' })),
  logFreeProductUse: vi.fn(async () => {}),
}))
vi.mock('@/lib/credits', () => ({
  logUsage: vi.fn(async () => {}),
  refundCreditsAfterPersistenceFailure: vi.fn(async () => ({ success: true })),
}))
vi.mock('@/lib/trend-tracking', () => ({ promoteToTrackedCandidate: vi.fn(async () => {}) }))
vi.mock('@/lib/search/validate-focus', () => ({ validateSpecificFocus: vi.fn(() => ({ status: 'ok' })) }))
vi.mock('@/lib/request-lock', () => ({
  acquireRequestLock: vi.fn(async () => ({ acquired: true, lockId: 'lock-1' })),
  releaseRequestLock: vi.fn(async () => {}),
  REQUEST_IN_PROGRESS_ERROR: 'in progress',
}))
vi.mock('@/lib/services/ai-provider-service', () => ({
  callAIProvider: vi.fn(async () => ({ text: '{"explanations":[]}', provider: 'anthropic', model: 'claude', usage: { inputTokens: 1, outputTokens: 1 }, estimatedCost: 0, promptTemplateId: 't', promptVersion: 'v1' })),
  extractJson: vi.fn((text: string) => JSON.parse(text)),
}))
vi.mock('@/lib/paid-results/paid-results-service', () => ({
  buildPaidResultHash: vi.fn(() => 'hash-1'),
  getPaidResultByHash: vi.fn(async () => null),
  getPaidResultById: vi.fn(async () => null),
  normalizePaidResultInput: vi.fn(() => ({})),
  openPaidResult: vi.fn(async (p: unknown) => p),
  paidCacheStatus: vi.fn(() => 'stale_saved'),
  paidResultResponseMeta: vi.fn((record: any) => ({ from_paid_result: true, cache_status: 'fresh', requires_credit: false, paid_result_id: record.id })),
  savePaidResult: vi.fn(async () => ({ success: true, record: { id: 'paid-new' } })),
}))

const CURRENT_ENGINE_VERSION_TOPIC = (engineVersion: string, needsExplanation = false) => ({
  id: 't1', title: 'Topic', description: 'd', opportunity_score: 80,
  score_breakdown: { trend_momentum: 0, niche_match: 0, content_gap: 0, competition: 0, freshness: 0, total: 80 },
  region: 'HU', platform: 'youtube', niche: 'x',
  generated_at: new Date().toISOString(), expires_at: new Date().toISOString(),
  evidence_videos: [], web_sources: [], engine_version: engineVersion, needs_explanation: needsExplanation,
})

function makeSupabaseFromStub(overrides: Record<string, () => unknown> = {}) {
  return vi.fn((table: string) => {
    const builder: any = {
      select: vi.fn(() => builder),
      insert: vi.fn(() => builder),
      update: vi.fn(() => builder),
      upsert: vi.fn(() => Promise.resolve({ data: null, error: null })),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      like: vi.fn(() => builder),
      gt: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(() => Promise.resolve(overrides[table]?.() ?? { data: null, error: null })),
      single: vi.fn(() => Promise.resolve(overrides[table]?.() ?? { data: null, error: null })),
      then: (resolve: any) => resolve(overrides[table]?.() ?? { data: [], error: null }),
    }
    return builder
  })
}

async function callRoute(body: Record<string, unknown>, oppCacheOverrides: { exactHit?: unknown; fallbackHit?: unknown } = {}) {
  const { createServerSupabaseClient, createAdminClient } = await import('@/lib/supabase-server')
  const { ENGINE_VERSION } = await import('@/lib/core-trust-engine')

  vi.mocked(createServerSupabaseClient).mockReturnValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
  } as any)

  // opportunity_cache: az admin.from('opportunity_cache') KÉTSZER hívódik
  // (exact-key fresh check, majd — csak cache_only esetén — a 7 napos
  // fallback). Egy egyszerű cursor-alapú stub adja vissza sorban a két választ.
  let oppCacheCallCount = 0
  const fromStub = vi.fn((table: string) => {
    if (table === 'opportunity_cache') {
      oppCacheCallCount += 1
      const isFirstCall = oppCacheCallCount === 1
      const data = isFirstCall ? (oppCacheOverrides.exactHit ?? null) : (oppCacheOverrides.fallbackHit ?? null)
      const builder: any = {
        select: vi.fn(() => builder),
        like: vi.fn(() => builder),
        gt: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        maybeSingle: vi.fn(() => Promise.resolve({ data, error: null })),
      }
      return builder
    }
    const generic = makeSupabaseFromStub({
      profiles: () => ({ data: null, error: null }),
      creator_memory: () => ({ data: [], error: null }),
      trend_candidate_cache: () => ({ data: null, error: null }),
    })(table)
    return generic
  })
  vi.mocked(createAdminClient).mockReturnValue({ from: fromStub } as any)

  const { POST } = await import('@/app/api/opportunity/route')
  const request = { json: async () => body, headers: new Headers() } as any
  const response = await POST(request)
  const payload = await response.json()
  return { response, payload, ENGINE_VERSION }
}

describe('opportunity route — opportunity_cache fresh / stale / miss (PFM-2E)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exact-key FRESH opportunity_cache hit -> cached:true, real content, opportunity_cache_state:"fresh_opportunity_cache"', async () => {
    const { ENGINE_VERSION } = await import('@/lib/core-trust-engine')
    const { payload } = await callRoute(
      { niche: 'teszt niche', search_mode: 'niche_based', cache_only: true },
      { exactHit: { topics: [CURRENT_ENGINE_VERSION_TOPIC(ENGINE_VERSION)], generated_at: new Date().toISOString() } },
    )
    expect(payload.cached).toBe(true)
    expect(payload.opportunity_cache_state).toBe('fresh_opportunity_cache')
    expect(payload.topics).toHaveLength(1)
    expect(payload.stale_cache_available).toBeFalsy()
  })

  it('7-day fallback STALE opportunity_cache hit + cache_only=true -> NO content playback, metadata-only', async () => {
    const { getPaidResultByHash } = await import('@/lib/paid-results/paid-results-service')
    const { buildTrendCandidates } = await import('@/lib/trend-radar')
    const { chargeProtectedFeature, logFreeProductUse, logYouTubeSearch } = await import('@/lib/usage-protection')
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    vi.mocked(getPaidResultByHash).mockResolvedValue(null)

    const { ENGINE_VERSION } = await import('@/lib/core-trust-engine')
    const staleTopic = { ...CURRENT_ENGINE_VERSION_TOPIC(ENGINE_VERSION), title: 'STALE_SHOULD_NOT_APPEAR' }
    const { response, payload } = await callRoute(
      { niche: 'teszt niche', search_mode: 'niche_based', cache_only: true },
      { exactHit: null, fallbackHit: { topics: [staleTopic], generated_at: new Date(Date.now() - 3 * 86400000).toISOString() } },
    )

    expect(response.status).toBe(200)
    expect(payload.cached).toBe(false)
    expect(payload.stale_cache_available).toBe(true)
    expect(payload.opportunity_cache_state).toBe('stale_opportunity_cache')
    expect(payload.topics).toEqual([])
    expect(payload.pool_topics).toEqual([])
    expect(JSON.stringify(payload)).not.toContain('STALE_SHOULD_NOT_APPEAR')
    expect(buildTrendCandidates).not.toHaveBeenCalled()
    expect(chargeProtectedFeature).not.toHaveBeenCalled()
    expect(logFreeProductUse).not.toHaveBeenCalled()
    expect(logYouTubeSearch).not.toHaveBeenCalled()
    expect(captureOpportunitySignals).not.toHaveBeenCalled()
  })

  it('total cache miss + cache_only=true -> opportunity_cache_state:"miss", no search', async () => {
    const { buildTrendCandidates } = await import('@/lib/trend-radar')
    const { payload } = await callRoute({ niche: 'teszt niche', search_mode: 'niche_based', cache_only: true }, {})

    expect(payload.cached).toBe(false)
    expect(payload.opportunity_cache_state).toBe('miss')
    expect(payload.stale_cache_available).toBeFalsy()
    expect(payload.stale_saved_available).toBeFalsy()
    expect(payload.topics).toEqual([])
    expect(buildTrendCandidates).not.toHaveBeenCalled()
  })

  it('invariant: no response can have cached:true together with a stale_*_available:true flag (checked across all three states above)', async () => {
    const { ENGINE_VERSION } = await import('@/lib/core-trust-engine')
    const fresh = await callRoute({ niche: 'a', search_mode: 'niche_based', cache_only: true }, { exactHit: { topics: [CURRENT_ENGINE_VERSION_TOPIC(ENGINE_VERSION)], generated_at: new Date().toISOString() } })
    expect(fresh.payload.cached && (fresh.payload.stale_cache_available || fresh.payload.stale_saved_available)).toBeFalsy()

    vi.clearAllMocks()
    const stale = await callRoute({ niche: 'b', search_mode: 'niche_based', cache_only: true }, { fallbackHit: { topics: [CURRENT_ENGINE_VERSION_TOPIC(ENGINE_VERSION)], generated_at: new Date(Date.now() - 3 * 86400000).toISOString() } })
    expect(stale.payload.cached && (stale.payload.stale_cache_available || stale.payload.stale_saved_available)).toBeFalsy()
  })
})
