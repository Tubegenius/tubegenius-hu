// Remaining-time guard (2026-10-01 incident fix, follow-up) -- tests the
// REAL app/api/video-package/route.ts POST handler, not a stand-in harness.
// DB-/provider-free: every I/O boundary (Supabase, credits, paid-results,
// request-lock, the two AI calls) is mocked below; nothing here touches a
// real database or the Anthropic API.
//
// IMPORTANT -- what this file does and does NOT prove: these two guards
// (hasTimeBudgetForPackaging / hasTimeBudgetForChargeAndSave, defined in
// lib/video-package.ts) reduce the RISK of a timing-triggered "charged but
// not saved" failure, based on an ESTIMATED, deliberately generous safety
// margin (20s) that has never been measured against a real near-worst-case
// run. They do not, and cannot, GUARANTEE that 20s is always enough real
// wall-clock time for chargeFeature()+savePaidResult()+lock release on the
// actual platform -- only that, in this controlled, mocked environment, the
// documented code path (skip charge/save, keep the usage log, release the
// lock) behaves as designed when a guard trips.
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetUserId, mockCheckPaidFeatureAccess, mockLogUsage, mockEstimateCost,
  mockBuildPaidResultHash, mockNormalizePaidResultInput,
  mockGetPaidResultByHashStrict, mockGetPaidResultById, mockOpenPaidResult, mockPaidResultResponseMeta,
  mockChargeFeatureAndSavePaidResult,
  mockAcquireRequestLock, mockReleaseRequestLock,
  mockCreateAdminClient,
  mockGetOpportunityEvidenceSnapshot, mockVerifyOwnVideoIdea,
  mockResolveCreatorNicheContext,
  mockPolishHungarianOutput,
  mockGenerateCreativeCore, mockGeneratePackaging,
} = vi.hoisted(() => ({
  mockGetUserId: vi.fn(),
  mockCheckPaidFeatureAccess: vi.fn(),
  mockLogUsage: vi.fn(),
  mockEstimateCost: vi.fn(() => 0),
  mockBuildPaidResultHash: vi.fn(() => 'hash-fixed'),
  mockNormalizePaidResultInput: vi.fn((x: unknown) => x),
  mockGetPaidResultByHashStrict: vi.fn(),
  mockGetPaidResultById: vi.fn(),
  mockOpenPaidResult: vi.fn(),
  mockPaidResultResponseMeta: vi.fn(() => ({})),
  mockChargeFeatureAndSavePaidResult: vi.fn(),
  mockAcquireRequestLock: vi.fn(),
  mockReleaseRequestLock: vi.fn(),
  mockCreateAdminClient: vi.fn(),
  mockGetOpportunityEvidenceSnapshot: vi.fn(),
  mockVerifyOwnVideoIdea: vi.fn(),
  mockResolveCreatorNicheContext: vi.fn(),
  mockPolishHungarianOutput: vi.fn((x: unknown) => x),
  mockGenerateCreativeCore: vi.fn(),
  mockGeneratePackaging: vi.fn(),
}))

vi.mock('@/lib/credits', () => ({
  getUserId: mockGetUserId,
  checkPaidFeatureAccess: mockCheckPaidFeatureAccess,
  logUsage: mockLogUsage,
  CREDIT_COSTS: { video_package_shorts: 2, video_package_long: 6 },
  estimateCost: mockEstimateCost,
}))
vi.mock('@/lib/daily-soft-limit', () => ({ dailySoftLimitError: vi.fn() }))
vi.mock('@/lib/paid-results/paid-results-service', () => ({
  buildPaidResultHash: mockBuildPaidResultHash,
  normalizePaidResultInput: mockNormalizePaidResultInput,
  getPaidResultByHashStrict: mockGetPaidResultByHashStrict,
  getPaidResultById: mockGetPaidResultById,
  openPaidResult: mockOpenPaidResult,
  paidResultResponseMeta: mockPaidResultResponseMeta,
}))
vi.mock('@/lib/paid-results/atomic-charge-save', () => ({
  chargeFeatureAndSavePaidResult: mockChargeFeatureAndSavePaidResult,
}))
vi.mock('@/lib/hungarian-output-polish', () => ({ polishHungarianOutput: mockPolishHungarianOutput }))
vi.mock('@/lib/request-lock', () => ({
  acquireRequestLock: mockAcquireRequestLock,
  releaseRequestLock: mockReleaseRequestLock,
  REQUEST_IN_PROGRESS_ERROR: 'Már folyamatban van egy generálásod egy másik lapon vagy eszközön.',
}))
vi.mock('@/lib/supabase-server', () => ({ createAdminClient: mockCreateAdminClient }))
vi.mock('@/lib/opportunity-evidence/evidence-service', () => ({
  getOpportunityEvidenceSnapshot: mockGetOpportunityEvidenceSnapshot,
  verifyOwnVideoIdea: mockVerifyOwnVideoIdea,
}))
vi.mock('@/lib/creator-profile-context', () => ({ resolveCreatorNicheContext: mockResolveCreatorNicheContext }))

// Partial mock: keep the REAL hasTimeBudgetForPackaging/hasTimeBudgetForChargeAndSave
// (and every other pure helper/constant) from lib/video-package.ts -- these
// guards are exactly what this file is testing -- but replace the two
// provider-calling functions so no real AI call is ever made.
vi.mock('@/lib/video-package', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/video-package')>()
  return {
    ...actual,
    generateCreativeCore: mockGenerateCreativeCore,
    generatePackaging: mockGeneratePackaging,
  }
})

import { POST } from '@/app/api/video-package/route'
import { MODELS } from '@/lib/models'

const coreParsedFixture = {
  hook: 'hook', hook_variations: [], narration: 'narration text',
  scene_structure: [], broll_ideas: [], timestamps: [], cta: 'cta', sources_used: [],
}
const packagingParsedFixture = {
  thumbnail_texts: [], title_variations: [], caption: 'caption', description: 'description',
  hashtags: {}, pinned_comment: null, why_it_works: null, risks: [], production_checklist: [],
}

// Realistic phase model: the fake clock is advanced in the same stages the
// real route goes through -- route-prep, then core (bounded by its own real
// CORE_STREAM_DEADLINE_MS=200_000 deadline), then the core-usage DB write,
// then packaging (bounded by its own real PACKAGING_TIMEOUT_MS=60_000
// deadline), then the packaging-usage DB write -- rather than one single
// jump. Neither mocked AI call is ever given a duration that would exceed
// its own real deadline; only the elapsed SUM across phases is what trips a
// guard, exactly as in the real route.
//
// LOG_USAGE_DURATION_MS is an illustrative, NOT measured, placeholder for a
// single logUsage() DB write -- applied to every logUsage() call in every
// test in this file via the shared mock below.
const LOG_USAGE_DURATION_MS = 400

function buildRequest() {
  return new NextRequest('http://localhost/api/video-package', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic: 'Node.js Async/Await',
      platform: 'youtube',
      video_length: '6-10min',
      narration_style: 'storytelling',
      intensity: 'classic',
      goal: 'views',
      channel_context: 'tech csatorna', // avoids the profiles DB read branch
    }),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.clearAllMocks()
  mockGetUserId.mockResolvedValue('user-1')
  mockCheckPaidFeatureAccess.mockResolvedValue({ allowed: true })
  mockGetPaidResultByHashStrict.mockResolvedValue(null)
  mockAcquireRequestLock.mockResolvedValue({ acquired: true, lockId: 'lock-1' })
  mockReleaseRequestLock.mockResolvedValue(undefined)
  // Every logUsage() call costs a small, fixed, illustrative amount of real
  // wall-clock time (a DB write) -- applies uniformly across phases/tests.
  mockLogUsage.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + LOG_USAGE_DURATION_MS)
  })
  mockChargeFeatureAndSavePaidResult.mockResolvedValue({
    success: true, duplicate: false, newBalance: 94, creditTransactionId: 'tx-1',
    paidResult: { id: 'paid-1', result_json: {} },
  })
  mockPolishHungarianOutput.mockImplementation((x: unknown) => x)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/video-package -- real handler, checkpoint 1 (before packaging)', () => {
  it('route-prep + near-cap core (both within their own real limits) cumulatively trip checkpoint 1: no packaging call, no charge, no save -- but core usage IS logged, and the lock IS released', async () => {
    // Phase 1 -- route-prep (auth/cache-check/lock-acquire etc.). 21_000ms is
    // DELIBERATELY much slower than the ~7.8s documented baseline from the
    // real incident -- it is the only lever available to reach checkpoint 1
    // in this scenario without giving the core call more than its own real
    // 200_000ms deadline, so treat it as an atypical-prep stress case, not
    // the expected case.
    const PREP_MS = 21_000
    // Phase 2 -- core generation, strictly UNDER its own real
    // CORE_STREAM_DEADLINE_MS (200_000ms) cap: a realistic near-worst-case
    // stream that still finished in time on its own terms.
    const CORE_MS = 199_600
    mockAcquireRequestLock.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + PREP_MS)
      return { acquired: true, lockId: 'lock-1' }
    })
    mockGenerateCreativeCore.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + CORE_MS)
      return { parsed: coreParsedFixture, inputTokens: 2255, outputTokens: 5990, estimatedCost: 0.12 }
    })
    // Phase 3 (core-usage logUsage) advances by LOG_USAGE_DURATION_MS via the
    // shared beforeEach mock -- cumulative elapsed right before checkpoint 1
    // is evaluated: 21_000 + 199_600 + 400 = 221_000ms. hasTimeBudgetForPackaging
    // requires remaining >= 80_000ms (300_000 - elapsed >= 80_000); here
    // remaining = 79_000ms, so the guard correctly declines to proceed.

    const res = await POST(buildRequest())
    const body = await res.json()

    expect(res.status).toBe(504)
    expect(body.error).toMatch(/biztonságos időkereten belül/)

    // the already-completed core call's usage must not be lost
    expect(mockLogUsage).toHaveBeenCalledTimes(1)
    expect(mockLogUsage).toHaveBeenCalledWith('user-1', 'video_package_long', MODELS.primary, 2255, 5990, expect.objectContaining({ sub_step: 'core' }))

    expect(mockGeneratePackaging).not.toHaveBeenCalled()
    expect(mockChargeFeatureAndSavePaidResult).not.toHaveBeenCalled()

    expect(mockReleaseRequestLock).toHaveBeenCalledTimes(1)
    expect(mockReleaseRequestLock).toHaveBeenCalledWith('lock-1')
  })
})

describe('POST /api/video-package -- real handler, checkpoint 2 (before charge/save)', () => {
  it('checkpoint 1 passes on its own terms, then packaging using its FULL own budget tips checkpoint 2: no charge, no save -- but BOTH core and packaging usage ARE logged, and the lock IS released', async () => {
    // Phase 1 -- route-prep, same atypically-slow stress value as the
    // checkpoint-1 test (see its comment for why 21_000ms, not ~7.8s).
    const PREP_MS = 20_000
    // Phase 2 -- core generation, strictly under its own 200_000ms cap.
    const CORE_MS = 199_600
    // Cumulative elapsed right before checkpoint 1 is evaluated:
    // 20_000 + 199_600 + 400 (core-usage log) = 220_000ms -- exactly the
    // hasTimeBudgetForPackaging boundary (remaining = 80_000ms), so checkpoint
    // 1 passes on its own terms and packaging is allowed to start.
    const PACKAGING_MS = 60_000 // packaging uses its FULL own PACKAGING_TIMEOUT_MS budget -- the cap itself, not exceeded
    mockAcquireRequestLock.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + PREP_MS)
      return { acquired: true, lockId: 'lock-1' }
    })
    mockGenerateCreativeCore.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + CORE_MS)
      return { parsed: coreParsedFixture, inputTokens: 2255, outputTokens: 5990, estimatedCost: 0.12 }
    })
    mockGeneratePackaging.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + PACKAGING_MS)
      return { parsed: packagingParsedFixture, inputTokens: 500, outputTokens: 300, estimatedCost: 0.01 }
    })
    // Phase 5 (packaging-usage logUsage) advances by another
    // LOG_USAGE_DURATION_MS -- cumulative elapsed right before checkpoint 2
    // is evaluated: 220_000 + 60_000 + 400 = 280_400ms. hasTimeBudgetForChargeAndSave
    // requires remaining >= 20_000ms; here remaining = 19_600ms, so the guard
    // correctly declines to charge/save -- even though packaging itself never
    // exceeded its own real deadline.

    const res = await POST(buildRequest())
    const body = await res.json()

    expect(res.status).toBe(504)
    expect(body.error).toMatch(/biztonságos mentéshez már nem maradt elég idő/)

    expect(mockGeneratePackaging).toHaveBeenCalledTimes(1) // packaging DID run, within its own cap
    expect(mockLogUsage).toHaveBeenCalledTimes(2) // both core and packaging usage logged
    expect(mockLogUsage).toHaveBeenNthCalledWith(1, 'user-1', 'video_package_long', MODELS.primary, 2255, 5990, expect.objectContaining({ sub_step: 'core' }))
    expect(mockLogUsage).toHaveBeenNthCalledWith(2, 'user-1', 'video_package_long', MODELS.fast, 500, 300, expect.objectContaining({ sub_step: 'packaging' }))

    expect(mockChargeFeatureAndSavePaidResult).not.toHaveBeenCalled() // the exact risk this guard exists to prevent

    expect(mockReleaseRequestLock).toHaveBeenCalledTimes(1)
    expect(mockReleaseRequestLock).toHaveBeenCalledWith('lock-1')
  })
})

describe('POST /api/video-package -- real handler, sanity: neither guard false-trips on a normal-speed run', () => {
  it('typical-speed phases (modest prep, comfortably-sub-cap core and packaging): both guards pass, charge/save/lock-release all happen -- proves the two 504 tests above are the guards firing, not some unrelated early exit', async () => {
    // Typical-case phase durations, comfortably inside both real deadlines
    // and both guard margins -- not a stress scenario like the two tests
    // above.
    mockAcquireRequestLock.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5_000) // route-prep
      return { acquired: true, lockId: 'lock-1' }
    })
    mockGenerateCreativeCore.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 45_000) // well under the 200_000ms core cap
      return { parsed: coreParsedFixture, inputTokens: 2255, outputTokens: 5990, estimatedCost: 0.12 }
    })
    mockGeneratePackaging.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 8_000) // well under the 60_000ms packaging cap
      return { parsed: packagingParsedFixture, inputTokens: 500, outputTokens: 300, estimatedCost: 0.01 }
    })

    const res = await POST(buildRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.paid_result_id).toBe('paid-1')

    expect(mockLogUsage).toHaveBeenCalledTimes(2)
    expect(mockChargeFeatureAndSavePaidResult).toHaveBeenCalledTimes(1)
    expect(mockReleaseRequestLock).toHaveBeenCalledTimes(1)
  })
})

// 2026-10-01 incident follow-up -- atomic charge+save contract tests.
describe('POST /api/video-package -- real handler, pre-flight cache check: completed result returns BEFORE any charge', () => {
  it('a completed result already found by getPaidResultByHashStrict is served from the DB -- no AI call, no charge, no save attempt', async () => {
    const cachedRecord = {
      id: 'paid-cached-1',
      result_json: { hook: 'cached hook from a prior run', _credits_remaining: 999 },
      fresh_until: new Date(Date.now() + 3600_000).toISOString(),
      last_refreshed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }
    mockGetPaidResultByHashStrict.mockResolvedValueOnce(cachedRecord)
    mockOpenPaidResult.mockResolvedValueOnce(cachedRecord)
    mockPaidResultResponseMeta.mockReturnValueOnce({ from_paid_result: true, cache_status: 'fresh', requires_credit: false, paid_result_id: 'paid-cached-1' })

    const res = await POST(buildRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.hook).toBe('cached hook from a prior run')
    expect(body._credits_remaining).toBeUndefined() // stale historical balance stripped, per existing reopen convention
    expect(body.from_paid_result).toBe(true)

    expect(mockGenerateCreativeCore).not.toHaveBeenCalled()
    expect(mockGeneratePackaging).not.toHaveBeenCalled()
    expect(mockChargeFeatureAndSavePaidResult).not.toHaveBeenCalled()
    expect(mockReleaseRequestLock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/video-package -- real handler, pre-flight cache check: a genuine DB read error must NOT be treated as a cache-miss', () => {
  it('getPaidResultByHashStrict throwing stops the route BEFORE any AI call or charge -- explicit 503, not a silent fall-through to a fresh (re-)charge', async () => {
    mockGetPaidResultByHashStrict.mockRejectedValueOnce(new Error('paid_results read failed: connection reset'))

    const res = await POST(buildRequest())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.error).toMatch(/Nem sikerült ellenőrizni/)

    expect(mockGenerateCreativeCore).not.toHaveBeenCalled()
    expect(mockGeneratePackaging).not.toHaveBeenCalled()
    expect(mockChargeFeatureAndSavePaidResult).not.toHaveBeenCalled()
    expect(mockReleaseRequestLock).toHaveBeenCalledTimes(1) // lock still released even on this early stop
  })
})

describe('POST /api/video-package -- real handler, atomic RPC duplicate (idempotent replay) response', () => {
  it('when chargeFeatureAndSavePaidResult returns duplicate:true, the route serves the DB-SAVED payload (not the just-(re)generated, freshly-discarded content), no new charge is implied by the response shape', async () => {
    mockGenerateCreativeCore.mockResolvedValue({ parsed: coreParsedFixture, inputTokens: 2255, outputTokens: 5990, estimatedCost: 0.12 })
    mockGeneratePackaging.mockResolvedValue({ parsed: packagingParsedFixture, inputTokens: 500, outputTokens: 300, estimatedCost: 0.01 })

    const savedPayload = { hook: 'the ORIGINAL saved hook', narration: 'original narration', _credits_remaining: 123 }
    mockChargeFeatureAndSavePaidResult.mockResolvedValueOnce({
      success: true,
      duplicate: true,
      paidResult: { id: 'paid-existing-1', result_json: savedPayload, fresh_until: new Date(Date.now() + 3600_000).toISOString(), last_refreshed_at: new Date().toISOString() },
      newBalance: 88,
    })
    mockOpenPaidResult.mockResolvedValueOnce({ id: 'paid-existing-1', result_json: savedPayload })
    mockPaidResultResponseMeta.mockReturnValueOnce({ from_paid_result: true, cache_status: 'fresh', requires_credit: false, paid_result_id: 'paid-existing-1' })

    const res = await POST(buildRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.hook).toBe('the ORIGINAL saved hook') // from the DB, not coreParsedFixture.hook
    expect(body._credits_remaining).toBeUndefined() // stale balance from the ORIGINAL save stripped
    expect(body.from_paid_result).toBe(true)
    expect(mockOpenPaidResult).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/video-package -- real handler, uncertain-outcome RPC failure must NOT be told to the user as "try again now"', () => {
  it('when chargeFeatureAndSavePaidResult reports errorCode:uncertain_outcome, the route surfaces ITS specific message -- the OUTER catch\'s generic "Generálás sikertelen. Próbáld újra." must never be reached for this case', async () => {
    mockGenerateCreativeCore.mockResolvedValue({ parsed: coreParsedFixture, inputTokens: 2255, outputTokens: 5990, estimatedCost: 0.12 })
    mockGeneratePackaging.mockResolvedValue({ parsed: packagingParsedFixture, inputTokens: 500, outputTokens: 300, estimatedCost: 0.01 })
    mockChargeFeatureAndSavePaidResult.mockResolvedValueOnce({
      success: false,
      errorCode: 'uncertain_outcome',
      error: 'A kérés állapota bizonytalan -- nem lehet megállapítani, hogy a mentés megtörtént-e. Ne indíts új kísérletet; az esetet naplóztuk, és kézi ellenőrzés szükséges.',
    })

    const res = await POST(buildRequest())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toMatch(/bizonytalan/i)
    // the specific, accurate message reached the client -- NOT the outer
    // catch's generic retry-encouraging fallback
    expect(body.error).not.toMatch(/Próbáld újra/i)
    expect(body.error).not.toBe('Generálás sikertelen. Próbáld újra.')
  })
})
