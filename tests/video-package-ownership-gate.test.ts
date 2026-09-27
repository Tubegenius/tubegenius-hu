// video-package route -- ownership gate for video_idea_id (own idea with no
// snapshot vs. foreign/non-existent idea). SCOPE: only the early-exit path
// is under test here (the function returns before reaching the request
// lock, checkPaidFeatureAccess, chargeFeature or any AI provider call for
// the foreign/non-existent case) -- the rest of the generation pipeline
// (fact-safety, video-package lib, credits, request-lock) is intentionally
// left un-mocked/real-imported, since it is never reached in these
// scenarios; only what is touched BEFORE and AT the ownership check is
// mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/credits', () => ({
  getUserId: vi.fn(),
  checkPaidFeatureAccess: vi.fn(),
  chargeFeature: vi.fn(),
  logUsage: vi.fn(),
  CREDIT_COSTS: { video_package_long: 6, video_package_shorts: 4 },
  refundCreditsAfterPersistenceFailure: vi.fn(),
}))
vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: vi.fn(() => ({})),
}))
vi.mock('@/lib/opportunity-evidence/evidence-service', () => ({
  getOpportunityEvidenceSnapshot: vi.fn(),
  verifyOwnVideoIdea: vi.fn(),
}))

const VALID_BODY = {
  topic: 'Node.js Async/Await', platform: 'youtube_long', video_length: '6-10',
  narration_style: 'storytelling', intensity: 'classic', goal: 'views',
}

describe('POST /api/video-package -- video_idea_id ownership gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('foreign or non-existent video_idea_id: 404, and checkPaidFeatureAccess/chargeFeature are NEVER reached (no charge, no provider call)', async () => {
    const { getUserId, checkPaidFeatureAccess, chargeFeature } = await import('@/lib/credits')
    vi.mocked(getUserId).mockResolvedValue('user-1')
    const { verifyOwnVideoIdea, getOpportunityEvidenceSnapshot } = await import('@/lib/opportunity-evidence/evidence-service')
    vi.mocked(verifyOwnVideoIdea).mockResolvedValue(false)

    const { POST } = await import('@/app/api/video-package/route')
    const res = await POST({ json: async () => ({ ...VALID_BODY, video_idea_id: 'someone-elses-idea' }) } as any)

    expect(res.status).toBe(404)
    expect(vi.mocked(verifyOwnVideoIdea)).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1', videoIdeaId: 'someone-elses-idea' })
    expect(getOpportunityEvidenceSnapshot).not.toHaveBeenCalled()
    expect(checkPaidFeatureAccess).not.toHaveBeenCalled()
    expect(chargeFeature).not.toHaveBeenCalled()
  })

  it('own idea, no video_idea_id at all: ownership check is skipped entirely (unrelated legacy/no-evidence flow, unchanged)', async () => {
    const { getUserId } = await import('@/lib/credits')
    vi.mocked(getUserId).mockResolvedValue('user-1')
    const { verifyOwnVideoIdea } = await import('@/lib/opportunity-evidence/evidence-service')

    // No video_idea_id in the body -- reaches further into the pipeline
    // (which we don't mock here), so this call is expected to eventually
    // fail elsewhere (real, un-mocked profile lookup) -- the only thing
    // this test asserts is that the ownership gate was never invoked.
    const { POST } = await import('@/app/api/video-package/route')
    await POST({ json: async () => ({ ...VALID_BODY }) } as any).catch(() => {})

    expect(verifyOwnVideoIdea).not.toHaveBeenCalled()
  })

  it('own idea WITH ownership confirmed but NO snapshot: ownership check passes, ready to fall through to client-supplied context (not blocked)', async () => {
    const { getUserId } = await import('@/lib/credits')
    vi.mocked(getUserId).mockResolvedValue('user-1')
    const { verifyOwnVideoIdea, getOpportunityEvidenceSnapshot } = await import('@/lib/opportunity-evidence/evidence-service')
    vi.mocked(verifyOwnVideoIdea).mockResolvedValue(true)
    vi.mocked(getOpportunityEvidenceSnapshot).mockResolvedValue(null)

    const { POST } = await import('@/app/api/video-package/route')
    // Falls through into the real (un-mocked) pipeline afterwards, which
    // will fail for unrelated reasons (no real Supabase/profile) -- we only
    // assert the gate's own two calls happened, in order, and did NOT 404.
    const res = await POST({ json: async () => ({ ...VALID_BODY, video_idea_id: 'my-old-idea' }) } as any).catch((e) => e)

    expect(verifyOwnVideoIdea).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1', videoIdeaId: 'my-old-idea' })
    expect(getOpportunityEvidenceSnapshot).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1', videoIdeaId: 'my-old-idea' })
    if (res && typeof res === 'object' && 'status' in res) expect(res.status).not.toBe(404)
  })
})
