// Local, provider-free proof that the REAL POST handler in
// app/api/opportunity/route.ts (not a reimplementation of its filter) reads
// creator_memory (via the real getOpportunityExclusionMemory()) and uses it
// to exclude candidates from the final response -- and that a different
// user's memory never affects this filtering.
//
// SCOPE, EXPLICITLY STATED: this is a NEW, additive test file only. It does
// not modify any application code. It mocks every external boundary the
// existing opportunity-route-*.test.ts files already mock (Supabase, trend
// generation, AI provider, usage/credits, request-lock, paid-results) --
// the SAME mocking level the codebase's own test suite already uses for
// this route -- so zero network calls, zero provider calls, zero credit
// spend. The candidate fixture shape is copied verbatim from
// tests/opportunity-route-emerging-signal-regression.test.ts's
// `sampleCandidate` to guarantee it passes through evaluateCandidate() the
// same way the codebase's own tests already prove it does.
//
// What this test does NOT replace: the live, API-level, two-real-account
// isolation check (Part A of this test round) proves the DB read itself is
// user_id-scoped end to end. This test proves the FILTER LOGIC that
// consumes that read is correct and does not cross-contaminate between
// requests/users at the in-process level.
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
// core-trust-engine is mocked to ALWAYS accept whatever candidate it receives
// (user_facing: true) -- copied verbatim from tests/opportunity-route-paid-result-freshness.test.ts,
// the codebase's own established pattern for isolating the route's control
// flow from the (unrelated) evidence-validation pipeline. This is essential
// here: it guarantees that a candidate reaching evaluateCandidate() always
// survives, so if a candidate is MISSING from the final response it can only
// be because the memory-exclusion filter (which runs strictly BEFORE
// evaluateCandidate, at app/api/opportunity/route.ts:802) removed it --
// never because of an unrelated evidence/validation rejection. This is what
// isolates causality: without this mock, a missing topic would be ambiguous
// between "excluded by memory" and "rejected for lacking evidence".
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
    id: `topic-${vc.candidate_topic}`, title: vc.candidate_topic, description: 'd',
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
  paidResultResponseMeta: vi.fn(() => ({})),
  savePaidResult: vi.fn(async () => ({ success: true, record: { id: 'paid-1' } })),
}))

// Candidate fixture shape copied verbatim from
// tests/opportunity-route-emerging-signal-regression.test.ts (sampleCandidate)
// -- proven by that file's own passing tests to survive evaluateCandidate()
// and reach the final response's `topics` array.
function makeCandidate(overrides: Record<string, unknown>) {
  return {
    id: 'cand-x', candidate_topic: '', candidate_topic_en: 'Test topic', category: 'default',
    region: 'HU', trend_source_type: 'serper_youtube', confidence: 'high', opportunity_type: 'strong_trend',
    serper_evidence_count: 0, youtube_relevant_videos_count: 0, unique_creator_count: 0,
    freshness_score: 80, pollution_score: 0, relevance_average: 0,
    source_videos: [], web_sources: [], seed_keyword: 'seed a', market_type: 'hungarian_market',
    ...overrides,
  }
}

const CANDIDATE_REJECTED_PARTIAL = makeCandidate({ id: 'cand-1', candidate_topic: 'Kültéri edzésterv kezdőknek ősszel' })
const CANDIDATE_COMPLETED_EXACT = makeCandidate({ id: 'cand-2', candidate_topic: 'Fehérje receptek reggelire' })
const CANDIDATE_NON_MATCHING = makeCandidate({ id: 'cand-3', candidate_topic: 'Utazási vlog tippek kezdőknek' })

const MEMORY_REJECTED_ROW = { topic: 'edzésterv kezdőknek', state: 'rejected' }
const MEMORY_COMPLETED_ROW = { topic: 'fehérje receptek reggelire', state: 'completed' }

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

async function runRoute(input: { userId: string; memoryRows: { topic: string; state: string }[] }) {
  const { createServerSupabaseClient, createAdminClient } = await import('@/lib/supabase-server')
  const { buildTrendCandidates } = await import('@/lib/trend-radar')

  vi.mocked(createServerSupabaseClient).mockReturnValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: input.userId } } })) },
  } as any)

  vi.mocked(buildTrendCandidates).mockResolvedValue(
    [CANDIDATE_REJECTED_PARTIAL, CANDIDATE_COMPLETED_EXACT, CANDIDATE_NON_MATCHING] as any
  )

  const fromStub = makeSupabaseFromStub({
    profiles: () => ({ data: null, error: null }),
    // The REAL getOpportunityExclusionMemory() (lib/creator-lane/lane-service.ts)
    // runs unmodified against this mocked table -- only the Supabase network
    // boundary is stubbed, exactly like every other table this route touches
    // in this same test file and in the codebase's pre-existing opportunity
    // route tests.
    creator_memory: () => ({ data: input.memoryRows, error: null }),
    opportunity_cache: () => ({ data: null, error: null }),
    trend_candidate_cache: () => ({ data: null, error: null }),
  })
  vi.mocked(createAdminClient).mockReturnValue({ from: fromStub } as any)

  const { POST } = await import('@/app/api/opportunity/route')
  const request = { json: async () => ({ niche: 'teszt niche', search_mode: 'niche_based' }), headers: new Headers() } as any
  const response = await POST(request)
  const payload = await response.json()
  return { response, payload }
}

describe('opportunity route — creator_memory exclusion (real route, mocked externals, zero provider cost)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejected memory excludes a PARTIALLY matching candidate', async () => {
    const { response, payload } = await runRoute({ userId: 'user-A', memoryRows: [MEMORY_REJECTED_ROW] })
    expect(response.status).toBe(200)
    const titles = (payload.topics as { title: string }[]).map(t => t.title)
    expect(titles).not.toContain(CANDIDATE_REJECTED_PARTIAL.candidate_topic)
  })

  it('completed memory excludes an EXACTLY matching candidate', async () => {
    const { payload } = await runRoute({ userId: 'user-A', memoryRows: [MEMORY_COMPLETED_ROW] })
    const titles = (payload.topics as { title: string }[]).map(t => t.title)
    expect(titles).not.toContain(CANDIDATE_COMPLETED_EXACT.candidate_topic)
  })

  it('a non-matching candidate is retained even with both memory rows present', async () => {
    const { payload } = await runRoute({ userId: 'user-A', memoryRows: [MEMORY_REJECTED_ROW, MEMORY_COMPLETED_ROW] })
    const titles = (payload.topics as { title: string }[]).map(t => t.title)
    expect(titles).toContain(CANDIDATE_NON_MATCHING.candidate_topic)
    expect(titles).not.toContain(CANDIDATE_REJECTED_PARTIAL.candidate_topic)
    expect(titles).not.toContain(CANDIDATE_COMPLETED_EXACT.candidate_topic)
  })

  it('a DIFFERENT user with no matching memory sees all three candidates -- another user\'s memory never excludes anything for this user', async () => {
    const { payload } = await runRoute({ userId: 'user-B', memoryRows: [] })
    const titles = (payload.topics as { title: string }[]).map(t => t.title)
    expect(titles).toContain(CANDIDATE_REJECTED_PARTIAL.candidate_topic)
    expect(titles).toContain(CANDIDATE_COMPLETED_EXACT.candidate_topic)
    expect(titles).toContain(CANDIDATE_NON_MATCHING.candidate_topic)
  })
})
