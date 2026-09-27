import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { getOpportunityEvidenceSnapshot } from '@/lib/opportunity-evidence/evidence-service'

// GET /api/video-ideas/[id]/opportunity-snapshot -- owner-scoped read.
// {id} is the video_idea_id. Returns {found:false} (never a fabricated or
// partial snapshot) when the idea has no snapshot yet -- e.g. a
// pre-migration saved idea, or one only ever reached via the generic
// (non-Opportunity) save path. Used by both the direct-create path (right
// after ensure_opportunity_evidence_snapshot) and by the "reopen from
// Memory" path -- this is the single, shared read contract both paths use
// (sessionStorage on the client is at most a same-tab display cache in
// front of this endpoint, never the sole source).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: videoIdeaId } = await params
  if (!videoIdeaId) return NextResponse.json({ error: 'Azonosító kötelező' }, { status: 400 })

  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const admin = createAdminClient()
  const snapshot = await getOpportunityEvidenceSnapshot(admin, { userId: user.id, videoIdeaId })
  if (!snapshot) return NextResponse.json({ found: false })

  return NextResponse.json({
    found: true,
    snapshot: {
      schema_version: snapshot.schema_version,
      captured_at: snapshot.captured_at,
      expires_at: snapshot.expires_at,
      title: snapshot.title,
      description: snapshot.description,
      hook_suggestion: snapshot.hook_suggestion,
      opportunity_score: snapshot.opportunity_score,
      score_breakdown: snapshot.score_breakdown,
      confidence: snapshot.confidence,
      trend_source_type: snapshot.trend_source_type,
      trend_source_label: snapshot.trend_source_label,
      risk_flags: snapshot.risk_flags,
      topic_intelligence: snapshot.topic_intelligence,
      web_sources: snapshot.web_sources,
      evidence_videos: snapshot.evidence_videos,
      region: snapshot.region,
      platform: snapshot.platform,
      niche: snapshot.niche,
    },
  })
}
