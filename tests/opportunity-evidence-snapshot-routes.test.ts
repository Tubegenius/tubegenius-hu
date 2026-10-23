// Route-level tests for the two new Opportunity Evidence Snapshot API
// routes (POST /api/opportunity/evidence-snapshot, GET /api/video-ideas/
// [id]/opportunity-snapshot) and the extended POST /api/memory branch.
// SCOPE: these mock the evidence-service/Supabase boundary and prove the
// ROUTE's own logic (auth gate, input validation, HTTP status mapping,
// pass-through of server-resolved data, and -- critically -- that no
// client-supplied score/source/timestamp field is ever read from the
// request body for the evidence-carrying paths). The RPC/DB layer's own
// correctness (ownership, atomicity, idempotency, overwrite-protection) is
// proven separately, against a real local Postgres, in
// tests/092-opportunity-evidence-snapshot-db-integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
  createAdminClient: vi.fn(() => ({})),
}))
vi.mock('@/lib/video-ideas/video-idea-service', () => ({
  ensureVideoIdea: vi.fn(async () => ({ success: true, idea: { id: 'idea-1' } })),
}))
vi.mock('@/lib/opportunity-evidence/evidence-service', () => ({
  resolveOpportunityEvidence: vi.fn(),
  ensureOpportunityEvidenceSnapshot: vi.fn(),
  getOpportunityEvidenceSnapshot: vi.fn(),
  saveOpportunityRecommendationToMemory: vi.fn(),
}))

const AUTH_USER = { id: 'user-1' }

function authed() {
  return { auth: { getUser: vi.fn(async () => ({ data: { user: AUTH_USER } })) } } as any
}
function anon() {
  return { auth: { getUser: vi.fn(async () => ({ data: { user: null } })) } } as any
}

describe('POST /api/opportunity/evidence-snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('401 when not authenticated -- no resolve/write attempted', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(anon())
    const { resolveOpportunityEvidence } = await import('@/lib/opportunity-evidence/evidence-service')
    const { POST } = await import('@/app/api/opportunity/evidence-snapshot/route')
    const res = await POST({ json: async () => ({ paid_result_id: 'p1', topic_id: 't1' }) } as any)
    expect(res.status).toBe(401)
    expect(resolveOpportunityEvidence).not.toHaveBeenCalled()
  })

  it('400 on missing/invalid paid_result_id or topic_id', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(authed())
    const { POST } = await import('@/app/api/opportunity/evidence-snapshot/route')
    const res = await POST({ json: async () => ({ paid_result_id: '', topic_id: 't1' }) } as any)
    expect(res.status).toBe(400)
  })

  it('404 when resolution fails (not found / wrong owner / topic not in that result)', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(authed())
    const { resolveOpportunityEvidence, ensureOpportunityEvidenceSnapshot } = await import('@/lib/opportunity-evidence/evidence-service')
    vi.mocked(resolveOpportunityEvidence).mockResolvedValue({ success: false, error: 'not_found' })
    const { POST } = await import('@/app/api/opportunity/evidence-snapshot/route')
    const res = await POST({ json: async () => ({ paid_result_id: 'p1', topic_id: 't1' }) } as any)
    expect(res.status).toBe(404)
    expect(ensureOpportunityEvidenceSnapshot).not.toHaveBeenCalled()
  })

  it('success: resolves via {userId, paid_result_id, topic_id} only -- the route never reads score/sources from the request body', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(authed())
    const { resolveOpportunityEvidence, ensureOpportunityEvidenceSnapshot } = await import('@/lib/opportunity-evidence/evidence-service')
    const evidence = { title: 'T', videoIdeaCandidate: { topic: 'T', keyword: 'k', platform: 'youtube', region: 'HU', niche: 'n' } } as any
    vi.mocked(resolveOpportunityEvidence).mockResolvedValue({ success: true, evidence })
    vi.mocked(ensureOpportunityEvidenceSnapshot).mockResolvedValue({ success: true, snapshotId: 'snap-1', updated: true })

    const { POST } = await import('@/app/api/opportunity/evidence-snapshot/route')
    // The request body includes an ATTACKER-SUPPLIED score/title -- these
    // must be completely ignored; only paid_result_id/topic_id are read.
    const res = await POST({ json: async () => ({ paid_result_id: 'p1', topic_id: 't1', opportunity_score: 999, title: 'HACKED', web_sources: ['fake'] }) } as any)
    const json = await res.json()

    expect(resolveOpportunityEvidence).toHaveBeenCalledWith('user-1', 'p1', 't1')
    expect(ensureOpportunityEvidenceSnapshot).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'user-1', videoIdeaId: 'idea-1', evidence }))
    expect(res.status).toBe(200)
    expect(json.video_idea_id).toBe('idea-1')
    expect(json.snapshot_id).toBe('snap-1')
  })

  it('500 when the snapshot write itself fails', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(authed())
    const { resolveOpportunityEvidence, ensureOpportunityEvidenceSnapshot } = await import('@/lib/opportunity-evidence/evidence-service')
    vi.mocked(resolveOpportunityEvidence).mockResolvedValue({ success: true, evidence: { title: 'T', videoIdeaCandidate: {} } as any })
    vi.mocked(ensureOpportunityEvidenceSnapshot).mockResolvedValue({ success: false, error: 'boom' })
    const { POST } = await import('@/app/api/opportunity/evidence-snapshot/route')
    const res = await POST({ json: async () => ({ paid_result_id: 'p1', topic_id: 't1' }) } as any)
    expect(res.status).toBe(500)
  })
})

describe('GET /api/video-ideas/[id]/opportunity-snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('401 when not authenticated', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(anon())
    const { GET } = await import('@/app/api/video-ideas/[id]/opportunity-snapshot/route')
    const res = await GET({} as any, { params: Promise.resolve({ id: 'idea-1' }) })
    expect(res.status).toBe(401)
  })

  it('{found:false} when the owner-scoped read returns nothing -- never a fabricated snapshot', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(authed())
    const { getOpportunityEvidenceSnapshot } = await import('@/lib/opportunity-evidence/evidence-service')
    vi.mocked(getOpportunityEvidenceSnapshot).mockResolvedValue(null)
    const { GET } = await import('@/app/api/video-ideas/[id]/opportunity-snapshot/route')
    const res = await GET({} as any, { params: Promise.resolve({ id: 'idea-1' }) })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ found: false })
  })

  it('passes the AUTHENTICATED userId (never a client-suppliable value) to the owner-scoped read', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(authed())
    const { getOpportunityEvidenceSnapshot } = await import('@/lib/opportunity-evidence/evidence-service')
    vi.mocked(getOpportunityEvidenceSnapshot).mockResolvedValue({
      id: 's1', video_idea_id: 'idea-1', schema_version: 1, captured_at: '2026-09-27T00:00:00Z', expires_at: null,
      title: 'T', description: null, hook_suggestion: null, opportunity_score: 50, score_breakdown: {}, confidence: null,
      trend_source_type: null, trend_source_label: null, risk_flags: [], topic_intelligence: null, web_sources: [], evidence_videos: [],
      region: null, platform: null, niche: null,
    })
    const { GET } = await import('@/app/api/video-ideas/[id]/opportunity-snapshot/route')
    const res = await GET({} as any, { params: Promise.resolve({ id: 'idea-1' }) })
    const json = await res.json()
    expect(getOpportunityEvidenceSnapshot).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1', videoIdeaId: 'idea-1' })
    expect(json.found).toBe(true)
    expect(json.snapshot.title).toBe('T')
  })
})

describe('POST /api/memory -- opportunity_engine evidence-save branch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('routes to the atomic save path only when source_context=opportunity_engine AND both ids are present; never trusts client score/sources', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(authed())
    const { resolveOpportunityEvidence, saveOpportunityRecommendationToMemory } = await import('@/lib/opportunity-evidence/evidence-service')
    const evidence = { title: 'T', videoIdeaCandidate: { topic: 'T', keyword: 'k', platform: 'youtube', region: 'HU', niche: 'n' } } as any
    vi.mocked(resolveOpportunityEvidence).mockResolvedValue({ success: true, evidence })
    vi.mocked(saveOpportunityRecommendationToMemory).mockResolvedValue({ success: true, memoryId: 'mem-1', snapshotId: 'snap-1', snapshotUpdated: true, eventLogged: true })

    const { POST } = await import('@/app/api/memory/route')
    const res = await POST({
      json: async () => ({
        topic: 'ignored-because-pointer-path', source_context: 'opportunity_engine',
        paid_result_id: 'p1', topic_id: 't1',
        opportunity_score: 999, notes: 'attacker text', // must be ignored
      }),
    } as any)
    const json = await res.json()
    expect(resolveOpportunityEvidence).toHaveBeenCalledWith('user-1', 'p1', 't1')
    expect(res.status).toBe(200)
    expect(json.item.id).toBe('mem-1')
    expect(json.snapshot_id).toBe('snap-1')
  })

  it('404 when the pointer does not resolve -- the generic save path is never used as a fallback for this branch', async () => {
    const { createServerSupabaseClient } = await import('@/lib/supabase-server')
    vi.mocked(createServerSupabaseClient).mockReturnValue(authed())
    const { resolveOpportunityEvidence } = await import('@/lib/opportunity-evidence/evidence-service')
    vi.mocked(resolveOpportunityEvidence).mockResolvedValue({ success: false, error: 'topic_not_found' })
    const { POST } = await import('@/app/api/memory/route')
    const res = await POST({ json: async () => ({ topic: 'x', source_context: 'opportunity_engine', paid_result_id: 'p1', topic_id: 't1' }) } as any)
    expect(res.status).toBe(404)
  })
})
