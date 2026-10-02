import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { ensureVideoIdea } from '@/lib/video-ideas/video-idea-service'
import { resolveOpportunityEvidence, ensureOpportunityEvidenceSnapshot } from '@/lib/opportunity-evidence/evidence-service'

// POST /api/opportunity/evidence-snapshot -- server-side write endpoint for
// the DIRECT "Készíts csomagot" path. Body is ONLY {paid_result_id,
// topic_id} -- never evidence content itself (see evidence-service.ts's
// header for why). Does NOT touch creator_memory/video_idea_events -- a
// direct click is not an explicit "save to memory" action.
//
// Failure contract (both apply to the auth-http-status client contract
// this route returns, AND to how app/dashboard/opportunities/page.tsx must
// react to it): on 401/403 (auth or ownership failure) the caller must
// NEVER auto-navigate to video-package as if evidence were attached. On
// any other failure (404/500) the client shows an explicit "Folytatás
// bizonyíték nélkül" choice rather than silently degrading or blocking.
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const paidResultId = body?.paid_result_id
  const topicId = body?.topic_id
  if (typeof paidResultId !== 'string' || !paidResultId || typeof topicId !== 'string' || !topicId) {
    return NextResponse.json({ error: 'Érvénytelen ajánlásazonosító' }, { status: 400 })
  }

  const resolved = await resolveOpportunityEvidence(user.id, paidResultId, topicId)
  if (!resolved.success) {
    return NextResponse.json({ error: 'Az ajánlás nem található vagy nem hozzáférhető.' }, { status: 404 })
  }

  const admin = createAdminClient()
  const ideaResult = await ensureVideoIdea(admin, {
    userId: user.id,
    title: resolved.evidence.title,
    topic: resolved.evidence.videoIdeaCandidate.topic,
    platform: resolved.evidence.videoIdeaCandidate.platform || 'youtube',
    opportunityScore: resolved.evidence.opportunityScore,
    metadata: { source_context: 'opportunity_engine' },
  })
  if (!ideaResult.success || !ideaResult.idea?.id) {
    return NextResponse.json({ error: 'A videóötlet mentése sikertelen.' }, { status: 500 })
  }

  const snapshot = await ensureOpportunityEvidenceSnapshot(admin, {
    userId: user.id,
    videoIdeaId: ideaResult.idea.id,
    evidence: resolved.evidence,
  })
  if (!snapshot.success) {
    console.error('[OpportunityEvidenceSnapshot] ensure failed:', snapshot.error)
    return NextResponse.json({ error: 'A bizonyíték mentése sikertelen.' }, { status: 500 })
  }

  return NextResponse.json({ video_idea_id: ideaResult.idea.id, snapshot_id: snapshot.snapshotId })
}
