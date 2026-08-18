// PFM-2E — a paid_results hash/explicit-ID döntési ág regressziós tesztjei
// az app/api/opportunity/route.ts-ben.
//
// SCOPE: kizárólag a PFM-2E-ben módosított döntési sorrendet teszteli —
// explicit paidResultId vs. hash-találat, és a hash-találat frissesség szerinti
// szétválasztása (fresh cache-hit / stale+cache_only biztonságos early-return /
// stale+!cache_only normál usage-döntéshez továbbhaladás). A trend-radar,
// core-trust-engine és niche-expansion üzleti logikáját mockoljuk, hogy kizárólag
// a kontrollfolyam legyen vizsgálva (ld. tests/opportunity-route-emerging-signal-regression.test.ts
// hasonló, korábbi scope-nyilatkozatát).
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
vi.mock('@/lib/core-trust-engine', () => ({
  evaluateCandidate: vi.fn((c: any) => ({
    candidate_topic: c.candidate_topic,
    seed_keyword: c.seed_keyword,
    trend_source_type: c.trend_source_type,
    raw_confidence: c.confidence,
    decision: { user_facing: true, final_decision: 'accepted' },
    scores: { total: 80 },
    validation: { valid_web_sources: [], valid_video_sources: [] },
  })),
  applySafeOutput: vi.fn((vc: any) => vc),
  toOpportunityTopic: vi.fn((vc: any) => ({
    id: 'topic-1', title: vc.candidate_topic, description: 'd',
    opportunity_score: vc.scores.total,
    score_breakdown: { trend_momentum: 0, niche_match: 0, content_gap: 0, competition: 0, freshness: 0, total: vc.scores.total },
    region: 'HU', platform: 'youtube', niche: 'x',
    generated_at: new Date().toISOString(), expires_at: new Date().toISOString(),
    evidence_videos: [], web_sources: [], engine_version: 'test-engine',
  })),
  buildClaudePromptContext: vi.fn(() => ''),
  ENGINE_VERSION: 'test-engine',
}))
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

function makeSupabaseFromStub(overrides: Record<string, () => unknown> = {}) {
  return vi.fn((table: string) => {
    const builder: any = {
      select: vi.fn(() => builder),
      insert: vi.fn(() => builder),
      update: vi.fn(() => builder),
      upsert: vi.fn(() => Promise.resolve({ data: null, error: null })),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      or: vi.fn(() => builder),
      is: vi.fn(() => builder),
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

const sampleCandidate = {
  id: 'cand-1', candidate_topic: 'Teszt téma', candidate_topic_en: 'Test topic', category: 'default',
  region: 'HU', trend_source_type: 'serper_youtube', confidence: 'high', opportunity_type: 'strong_trend',
  serper_evidence_count: 1, youtube_relevant_videos_count: 1, unique_creator_count: 1,
  freshness_score: 80, pollution_score: 0, relevance_average: 50,
  source_videos: [], web_sources: [], seed_keyword: 'seed a', market_type: 'hungarian_market',
}

async function setupRoute(opts: { withCandidates?: boolean } = {}) {
  const { createServerSupabaseClient, createAdminClient } = await import('@/lib/supabase-server')
  const { buildTrendCandidates } = await import('@/lib/trend-radar')

  vi.mocked(createServerSupabaseClient).mockReturnValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
  } as any)

  vi.mocked(buildTrendCandidates).mockResolvedValue((opts.withCandidates ? [sampleCandidate] : []) as any)

  const fromStub = makeSupabaseFromStub({
    profiles: () => ({ data: null, error: null }),
    creator_memory: () => ({ data: [], error: null }),
    opportunity_cache: () => ({ data: null, error: null }),
    trend_candidate_cache: () => ({ data: null, error: null }),
  })
  vi.mocked(createAdminClient).mockReturnValue({ from: fromStub } as any)
}

async function callRoute(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/opportunity/route')
  const request = { json: async () => body, headers: new Headers() } as any
  const response = await POST(request)
  const payload = await response.json()
  return { response, payload }
}

describe('opportunity route — explicit paidResultId vs. hash-based paid result (PFM-2E)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('1) explicit paidResultId opens an EXPIRED record regardless of freshness — no search, no credit, no writer', async () => {
    await setupRoute()
    const { getPaidResultById, getPaidResultByHash, openPaidResult } = await import('@/lib/paid-results/paid-results-service')
    const { chargeProtectedFeature, logFreeProductUse } = await import('@/lib/usage-protection')
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const { buildTrendCandidates } = await import('@/lib/trend-radar')

    const expiredRecord = { id: 'paid-old', status: 'completed', fresh_until: new Date(Date.now() - 999_000_000).toISOString(), result_json: { topics: ['old topic'] } }
    vi.mocked(getPaidResultById).mockResolvedValueOnce(expiredRecord as any)

    const { response, payload } = await callRoute({ niche: 'teszt niche', search_mode: 'niche_based', paidResultId: 'paid-old' })

    expect(response.status).toBe(200)
    expect(payload.cached).toBe(true)
    expect(payload.topics).toEqual(['old topic'])
    expect(openPaidResult).toHaveBeenCalledTimes(1)
    expect(getPaidResultByHash).not.toHaveBeenCalled()
    expect(buildTrendCandidates).not.toHaveBeenCalled()
    expect(chargeProtectedFeature).not.toHaveBeenCalled()
    expect(logFreeProductUse).not.toHaveBeenCalled()
    expect(captureOpportunitySignals).not.toHaveBeenCalled()
  })

  it('2) no explicit ID, hash match FRESH, cache_only=true -> cache-hit, 0 provider calls', async () => {
    await setupRoute()
    const { getPaidResultByHash, openPaidResult, paidCacheStatus } = await import('@/lib/paid-results/paid-results-service')
    const { buildTrendCandidates } = await import('@/lib/trend-radar')

    const freshRecord = { id: 'paid-fresh', status: 'completed', fresh_until: new Date(Date.now() + 999_000_000).toISOString(), result_json: { topics: ['fresh topic'] } }
    vi.mocked(getPaidResultByHash).mockResolvedValueOnce(freshRecord as any)
    vi.mocked(paidCacheStatus).mockReturnValueOnce('fresh')

    const { response, payload } = await callRoute({ niche: 'teszt niche', search_mode: 'niche_based', cache_only: true })

    expect(response.status).toBe(200)
    expect(payload.cached).toBe(true)
    expect(payload.topics).toEqual(['fresh topic'])
    expect(openPaidResult).toHaveBeenCalledTimes(1)
    expect(buildTrendCandidates).not.toHaveBeenCalled()
  })

  it('3) no explicit ID, hash match STALE, cache_only=true -> safe early return, NO openPaidResult, NO stale content playback', async () => {
    await setupRoute()
    const { getPaidResultByHash, openPaidResult, paidCacheStatus, savePaidResult } = await import('@/lib/paid-results/paid-results-service')
    const { buildTrendCandidates } = await import('@/lib/trend-radar')
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const { chargeProtectedFeature, logFreeProductUse, logYouTubeSearch } = await import('@/lib/usage-protection')

    const staleRecord = { id: 'paid-stale', status: 'completed', fresh_until: new Date(Date.now() - 999_000_000).toISOString(), result_json: { topics: ['STALE_SHOULD_NOT_APPEAR'] } }
    vi.mocked(getPaidResultByHash).mockResolvedValueOnce(staleRecord as any)
    vi.mocked(paidCacheStatus).mockReturnValueOnce('stale_saved')

    const { response, payload } = await callRoute({ niche: 'teszt niche', search_mode: 'niche_based', cache_only: true })

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      topics: [],
      pool_topics: [],
      cached: false,
      stale_saved_available: true,
      opportunity_cache_state: 'stale_saved_paid_result',
      cache_status: 'stale_saved',
      paid_result_id: 'paid-stale',
      requires_credit: false,
      message: expect.any(String),
    })
    expect(JSON.stringify(payload)).not.toContain('STALE_SHOULD_NOT_APPEAR')
    expect(openPaidResult).not.toHaveBeenCalled()
    expect(buildTrendCandidates).not.toHaveBeenCalled()
    expect(captureOpportunitySignals).not.toHaveBeenCalled()
    expect(chargeProtectedFeature).not.toHaveBeenCalled()
    expect(logFreeProductUse).not.toHaveBeenCalled()
    expect(logYouTubeSearch).not.toHaveBeenCalled()
    expect(savePaidResult).not.toHaveBeenCalled()
  })

  it('4) no explicit ID, hash match STALE, cache_only=false, weekly free run available -> proceeds to a real search at 0 credit', async () => {
    await setupRoute({ withCandidates: true })
    const { getPaidResultByHash, paidCacheStatus, savePaidResult } = await import('@/lib/paid-results/paid-results-service')
    const { buildTrendCandidates } = await import('@/lib/trend-radar')
    const { checkUsagePermission, chargeProtectedFeature, logFreeProductUse } = await import('@/lib/usage-protection')

    vi.mocked(checkUsagePermission).mockResolvedValue({ canRun: true, currency: 'free' } as any)
    const staleRecord = { id: 'paid-stale-2', status: 'completed', fresh_until: new Date(Date.now() - 999_000_000).toISOString(), result_json: { topics: ['old'] } }
    vi.mocked(getPaidResultByHash).mockResolvedValueOnce(staleRecord as any)
    vi.mocked(paidCacheStatus).mockReturnValueOnce('stale_saved')

    const { response, payload } = await callRoute({ niche: 'teszt niche', search_mode: 'niche_based', cache_only: false })

    expect(response.status).toBe(200)
    expect(buildTrendCandidates).toHaveBeenCalledTimes(1)
    expect(chargeProtectedFeature).not.toHaveBeenCalled()
    expect(logFreeProductUse).toHaveBeenCalledTimes(1)
    expect(payload.charged).toBe(false)
    expect(payload.credits_charged).toBe(0)
    expect(savePaidResult).toHaveBeenCalledTimes(1)
  })

  it('5) no explicit ID, hash match STALE, cache_only=false, NO weekly free run left -> needs_confirmation, no search, no credit', async () => {
    await setupRoute({ withCandidates: true })
    const { getPaidResultByHash, paidCacheStatus, savePaidResult } = await import('@/lib/paid-results/paid-results-service')
    const { buildTrendCandidates } = await import('@/lib/trend-radar')
    const { checkUsagePermission, chargeProtectedFeature } = await import('@/lib/usage-protection')

    vi.mocked(checkUsagePermission).mockResolvedValue({ canRun: true, currency: 'credit', cost: 2, message: 'kredit kell' } as any)
    const staleRecord = { id: 'paid-stale-3', status: 'completed', fresh_until: new Date(Date.now() - 999_000_000).toISOString(), result_json: { topics: ['old'] } }
    vi.mocked(getPaidResultByHash).mockResolvedValueOnce(staleRecord as any)
    vi.mocked(paidCacheStatus).mockReturnValueOnce('stale_saved')

    const { response, payload } = await callRoute({ niche: 'teszt niche', search_mode: 'niche_based', cache_only: false })

    expect(response.status).toBe(200)
    expect(payload.needs_confirmation).toBe(true)
    expect(payload.confirmation_cost).toBe(2)
    expect(payload.charged).toBe(false)
    expect(payload.credits_charged).toBe(0)
    expect(buildTrendCandidates).not.toHaveBeenCalled()
    expect(chargeProtectedFeature).not.toHaveBeenCalled()
    expect(savePaidResult).not.toHaveBeenCalled()
  })

  it('6) force_refresh=true bypasses the explicit-ID/hash paid-result lookup entirely (regression: unchanged behavior)', async () => {
    await setupRoute({ withCandidates: true })
    const { getPaidResultById, getPaidResultByHash } = await import('@/lib/paid-results/paid-results-service')
    const { checkUsagePermission, chargeProtectedFeature } = await import('@/lib/usage-protection')
    vi.mocked(checkUsagePermission).mockResolvedValue({ canRun: true, currency: 'free' } as any)

    await callRoute({ niche: 'teszt niche', search_mode: 'niche_based', force_refresh: true, paidResultId: 'whatever' })

    expect(getPaidResultById).not.toHaveBeenCalled()
    expect(getPaidResultByHash).not.toHaveBeenCalled()
    // force_refresh mindig a chargeProtectedFeature ágon megy (meglévő, változatlan szabály).
    expect(chargeProtectedFeature).toHaveBeenCalledTimes(1)
  })
})
