// Route regression tests for the PFM-2B emerging-signal capture wiring in
// app/api/opportunity/route.ts.
//
// SCOPE, EXPLICITLY STATED (nincs korabbi dedikalt teszt-harness ehhez a
// route-hoz — `tests/opportunity-scoring.test.ts` egy MASIK modult tesztel):
// ez a fajl KIZAROLAG azt bizonyitja, amit a PFM-2B feladat kifejezetten
// ker — hogy a capture-hivas jelenlete/hianya/hibaja NEM valtoztatja meg a
// route validalhato viselkedeset (response payload/status, cache-hit vs
// cache-miss capture-dontes, nincs extra kulso hivas/kredit). NEM celja a
// route TELJES, minden agat lefedo regresszios tesztje (az egy onallo,
// ezt a kort meghaladó feladat lenne, es a route-nak korabban SEM volt
// ilyen teljes tesztje).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// ── 1) Statikus forras-ellenorzes — a capture hivasi hely tulajdonsagai ──
describe('opportunity route — emerging-signal capture call site (static source check)', () => {
  const src = readFileSync(join(process.cwd(), 'app', 'api', 'opportunity', 'route.ts'), 'utf-8')

  it('captureOpportunitySignals is imported', () => {
    expect(src).toMatch(/import\s*\{\s*captureOpportunitySignals\s*\}\s*from\s*'@\/lib\/emerging-signal\/capture'/)
  })

  it('the call site is awaited and wrapped in its own try/catch', () => {
    const idx = src.indexOf('captureOpportunitySignals({')
    expect(idx).toBeGreaterThan(-1)
    const before = src.slice(Math.max(0, idx - 250), idx)
    expect(before).toMatch(/=\s*await\s*$/)
    expect(before).toContain('try {')
  })

  it('the call site is gated by isFreshTrendData (does not run on a trend_candidate_cache hit)', () => {
    const idx = src.indexOf('captureOpportunitySignals({')
    const before = src.slice(Math.max(0, idx - 300), idx)
    expect(before).toContain('if (isFreshTrendData)')
  })

  it('nothing derived from the capture call feeds into responsePayload construction', () => {
    const captureIdx = src.indexOf('captureOpportunitySignals({')
    const responsePayloadIdx = src.indexOf('const responsePayload')
    expect(captureIdx).toBeLessThan(responsePayloadIdx)

    // A `captureResult` valtozonev az egesz fajlban KIZAROLAG a sajat,
    // helyi if(isFreshTrendData){...} blokkjan belul fordulhat elo (deklaracio
    // + a sajat catch-aganak logolasa) — sehol masutt, kulonosen nem a
    // responsePayload epitesenel vagy azutan.
    const occurrences = [...src.matchAll(/captureResult/g)].map(m => m.index as number)
    expect(occurrences.length).toBeGreaterThan(0)
    const blockStart = src.indexOf('if (isFreshTrendData) {', captureIdx - 300)
    const blockEnd = src.indexOf("console.log('[Opportunity] Validation result:'", captureIdx)
    expect(blockStart).toBeGreaterThan(-1)
    expect(blockEnd).toBeGreaterThan(blockStart)
    for (const occ of occurrences) {
      expect(occ).toBeGreaterThanOrEqual(blockStart)
      expect(occ).toBeLessThanOrEqual(blockEnd)
    }
  })

  it('the failure branch logs only a non-sensitive, fixed message (no raw error interpolation)', () => {
    const idx = src.indexOf("Emerging signal capture threw unexpectedly")
    expect(idx).toBeGreaterThan(-1)
    const line = src.slice(idx - 80, idx + 80)
    expect(line).not.toMatch(/\$\{.*error.*\}/i)
  })
})

// ── 2) Dinamikus, mockolt lefutas — capture-hivas szamlalasa cache-hit vs
//    cache-miss eseten, es a valasz invarianciaja capture-hiba mellett. ──

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/emerging-signal/capture', () => ({ captureOpportunitySignals: vi.fn() }))
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
vi.mock('@/lib/paid-results/paid-results-service', () => ({
  buildPaidResultHash: vi.fn(() => 'hash-1'),
  getPaidResultByHash: vi.fn(async () => null),
  getPaidResultById: vi.fn(async () => null),
  normalizePaidResultInput: vi.fn(() => ({})),
  openPaidResult: vi.fn(async (p: unknown) => p),
  paidResultResponseMeta: vi.fn(() => ({})),
  savePaidResult: vi.fn(async () => ({ success: true, record: { id: 'paid-1' } })),
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

describe('opportunity route — dynamic capture invocation behavior (mocked dependencies)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { checkUsagePermission } = await import('@/lib/usage-protection')
    vi.mocked(checkUsagePermission).mockResolvedValue({ canRun: true, currency: 'free' } as any)
  })

  async function runRoute(opts: { trendCacheHit: boolean; oppCacheHit?: boolean }) {
    const { createServerSupabaseClient, createAdminClient } = await import('@/lib/supabase-server')
    const { buildTrendCandidates } = await import('@/lib/trend-radar')
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')

    vi.mocked(createServerSupabaseClient).mockReturnValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    } as any)

    const sampleCandidate = {
      id: 'cand-1', candidate_topic: 'Teszt téma', candidate_topic_en: 'Test topic', category: 'default',
      region: 'HU', trend_source_type: 'serper_youtube', confidence: 'high', opportunity_type: 'strong_trend',
      serper_evidence_count: 0, youtube_relevant_videos_count: 0, unique_creator_count: 0,
      freshness_score: 80, pollution_score: 0, relevance_average: 0,
      source_videos: [], web_sources: [], seed_keyword: 'seed a', market_type: 'hungarian_market',
    }

    vi.mocked(buildTrendCandidates).mockResolvedValue([] as any) // ures -> gyors, korai-fallback ag (elegendo a capture-hivas szamlalasahoz)

    const fromStub = makeSupabaseFromStub({
      profiles: () => ({ data: null, error: null }),
      creator_memory: () => ({ data: [], error: null }),
      opportunity_cache: () => ({ data: opts.oppCacheHit ? { topics: [], generated_at: new Date().toISOString() } : null, error: null }),
      trend_candidate_cache: () => ({ data: opts.trendCacheHit ? { candidates: [sampleCandidate] } : null, error: null }),
    })
    vi.mocked(createAdminClient).mockReturnValue({ from: fromStub } as any)

    const { POST } = await import('@/app/api/opportunity/route')
    const request = { json: async () => ({ niche: 'teszt niche', search_mode: 'niche_based' }), headers: new Headers() } as any
    const response = await POST(request)
    const payload = await response.json()
    return { response, payload, captureOpportunitySignals: vi.mocked(captureOpportunitySignals) }
  }

  it('cache MISS (fresh trendCandidates): capture IS invoked exactly once', async () => {
    const { captureOpportunitySignals } = await runRoute({ trendCacheHit: false })
    expect(captureOpportunitySignals).toHaveBeenCalledTimes(1)
  })

  it('cache HIT (trend_candidate_cache populated): capture is NOT invoked', async () => {
    const { captureOpportunitySignals } = await runRoute({ trendCacheHit: true })
    expect(captureOpportunitySignals).not.toHaveBeenCalled()
  })

  it('response payload/status is identical whether capture succeeds or throws', async () => {
    const { captureOpportunitySignals: mockedCapture } = await import('@/lib/emerging-signal/capture')

    vi.mocked(mockedCapture).mockResolvedValueOnce({ outcome: 'completed', runId: 'r1', clustersCompleted: 1, clustersSkipped: 0, clustersFailed: 0 })
    const successRun = await runRoute({ trendCacheHit: false })

    vi.mocked(mockedCapture).mockRejectedValueOnce(new Error('boom'))
    const failureRun = await runRoute({ trendCacheHit: false })

    expect(failureRun.response.status).toBe(successRun.response.status)
    expect(failureRun.payload).toEqual(successRun.payload)
  })
})
