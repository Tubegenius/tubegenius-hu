// Opportunity Evidence Snapshot -- application-layer resolver + RPC wrappers.
//
// SECURITY-CRITICAL BOUNDARY: this module is the ONLY place that reads a
// client-supplied {paid_result_id, topic_id} pointer and turns it into
// evidence content. It NEVER accepts score/sources/description/timestamp
// fields from the client -- those are always re-derived here, from the
// caller's OWN previously-saved paid_results row (owner-scoped via
// getPaidResultById). The two SQL RPCs this module calls independently
// re-verify that video_idea_id belongs to the same user_id -- this module
// does not rely on the DB layer alone, but it is likewise not the sole
// authority: the API routes that call these functions must derive userId
// from the authenticated session, never from the request body.
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPaidResultById } from '@/lib/paid-results/paid-results-service'
import type { OpportunityTopic } from '@/types'

export interface ResolvedOpportunityEvidence {
  videoIdeaCandidate: { topic: string; keyword: string | null; platform: string | null; region: string | null; niche: string | null }
  schemaVersion: number
  capturedAt: string
  expiresAt: string | null
  title: string
  description: string | null
  hookSuggestion: string | null
  opportunityScore: number | null
  scoreBreakdown: unknown
  confidence: string | null
  trendSourceType: string | null
  trendSourceLabel: string | null
  riskFlags: unknown
  topicIntelligence: unknown
  webSources: unknown
  evidenceVideos: unknown
}

export type ResolveEvidenceResult =
  | { success: true; evidence: ResolvedOpportunityEvidence }
  | { success: false; error: 'not_found' | 'topic_not_found' }

const SNAPSHOT_SCHEMA_VERSION = 1

// Finds the exact topic the client is pointing at, inside the user's OWN
// stored paid_results row -- never trusts anything else from the client.
export async function resolveOpportunityEvidence(
  userId: string,
  paidResultId: string,
  topicId: string,
): Promise<ResolveEvidenceResult> {
  const record = await getPaidResultById(userId, paidResultId)
  if (!record || record.tool_type !== 'opportunity_engine') return { success: false, error: 'not_found' }

  const payload = record.result_json as { topics?: OpportunityTopic[]; pool_topics?: OpportunityTopic[] } | null
  const all = [...(payload?.topics || []), ...(payload?.pool_topics || [])]
  const topic = all.find(t => t.id === topicId)
  if (!topic) return { success: false, error: 'topic_not_found' }

  return {
    success: true,
    evidence: {
      videoIdeaCandidate: {
        topic: topic.title,
        keyword: topic.keyword || null,
        platform: topic.platform || null,
        region: topic.region || null,
        niche: topic.niche || null,
      },
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      capturedAt: topic.generated_at,
      expiresAt: topic.expires_at || null,
      title: topic.title,
      description: topic.description || null,
      hookSuggestion: topic.hook_suggestion || null,
      opportunityScore: topic.opportunity_score ?? null,
      scoreBreakdown: topic.score_breakdown ?? null,
      confidence: topic.confidence || null,
      trendSourceType: topic.trend_source_type || null,
      trendSourceLabel: topic.trend_source_label || null,
      riskFlags: [],
      topicIntelligence: {
        expanded_from_query: topic.expanded_from_query,
        expansion_type: topic.expansion_type,
        story_potential_score: topic.story_potential_score,
        recommended_angle: (topic as unknown as { recommended_angle?: string }).recommended_angle,
        recommended_format: (topic as unknown as { recommended_format?: string }).recommended_format,
        hook_pattern: (topic as unknown as { hook_pattern?: string }).hook_pattern,
      },
      webSources: topic.web_sources || [],
      evidenceVideos: topic.evidence_videos || [],
    },
  }
}

export interface EnsureSnapshotResult { success: boolean; snapshotId?: string; updated?: boolean; error?: string }

// Direct-create path: idea + snapshot only, no creator_memory/event touch.
export async function ensureOpportunityEvidenceSnapshot(
  admin: SupabaseClient,
  input: { userId: string; videoIdeaId: string; evidence: ResolvedOpportunityEvidence },
): Promise<EnsureSnapshotResult> {
  const e = input.evidence
  const { data, error } = await admin.rpc('ensure_opportunity_evidence_snapshot', {
    p_user_id: input.userId,
    p_video_idea_id: input.videoIdeaId,
    p_schema_version: e.schemaVersion,
    p_captured_at: e.capturedAt,
    p_expires_at: e.expiresAt,
    p_title: e.title,
    p_description: e.description,
    p_hook_suggestion: e.hookSuggestion,
    p_opportunity_score: e.opportunityScore,
    p_score_breakdown: e.scoreBreakdown,
    p_confidence: e.confidence,
    p_trend_source_type: e.trendSourceType,
    p_trend_source_label: e.trendSourceLabel,
    p_risk_flags: e.riskFlags,
    p_topic_intelligence: e.topicIntelligence,
    p_web_sources: e.webSources,
    p_evidence_videos: e.evidenceVideos,
    p_region: e.videoIdeaCandidate.region,
    p_platform: e.videoIdeaCandidate.platform,
    p_niche: e.videoIdeaCandidate.niche,
  })
  if (error) return { success: false, error: error.message }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { success: false, error: 'ensure_opportunity_evidence_snapshot_no_row' }
  return { success: true, snapshotId: row.out_snapshot_id, updated: row.out_updated }
}

export interface SaveToMemoryResult {
  success: boolean
  memoryId?: string
  snapshotId?: string
  snapshotUpdated?: boolean
  eventLogged?: boolean
  error?: string
}

// Save-to-memory path: creator_memory + video_idea_events + snapshot, atomic.
export async function saveOpportunityRecommendationToMemory(
  admin: SupabaseClient,
  input: { userId: string; videoIdeaId: string; evidence: ResolvedOpportunityEvidence; searchKeyword?: string | null },
): Promise<SaveToMemoryResult> {
  const e = input.evidence
  const { data, error } = await admin.rpc('save_opportunity_recommendation_to_memory', {
    p_user_id: input.userId,
    p_video_idea_id: input.videoIdeaId,
    p_topic: e.videoIdeaCandidate.topic,
    p_search_keyword: input.searchKeyword ?? e.videoIdeaCandidate.keyword,
    p_platform: e.videoIdeaCandidate.platform,
    p_opportunity_score: e.opportunityScore,
    p_schema_version: e.schemaVersion,
    p_captured_at: e.capturedAt,
    p_expires_at: e.expiresAt,
    p_title: e.title,
    p_description: e.description,
    p_hook_suggestion: e.hookSuggestion,
    p_score_breakdown: e.scoreBreakdown,
    p_confidence: e.confidence,
    p_trend_source_type: e.trendSourceType,
    p_trend_source_label: e.trendSourceLabel,
    p_risk_flags: e.riskFlags,
    p_topic_intelligence: e.topicIntelligence,
    p_web_sources: e.webSources,
    p_evidence_videos: e.evidenceVideos,
    p_region: e.videoIdeaCandidate.region,
    p_niche: e.videoIdeaCandidate.niche,
  })
  if (error) return { success: false, error: error.message }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { success: false, error: 'save_opportunity_recommendation_to_memory_no_row' }
  return {
    success: true,
    memoryId: row.out_memory_id,
    snapshotId: row.out_snapshot_id,
    snapshotUpdated: row.out_snapshot_updated,
    eventLogged: row.out_event_logged,
  }
}

export interface OpportunityEvidenceSnapshotRow {
  id: string
  video_idea_id: string
  schema_version: number
  captured_at: string
  expires_at: string | null
  title: string
  description: string | null
  hook_suggestion: string | null
  opportunity_score: number | null
  score_breakdown: unknown
  confidence: string | null
  trend_source_type: string | null
  trend_source_label: string | null
  risk_flags: unknown
  topic_intelligence: unknown
  web_sources: unknown
  evidence_videos: unknown
  region: string | null
  platform: string | null
  niche: string | null
}

// Owner-scoped read. Callers MUST pass the authenticated user's own id --
// this is plain SELECT (RLS also backstops this at the DB layer for any
// direct PostgREST access), so the .eq('user_id', userId) filter here is
// the primary, always-present guard for the app's own admin-client reads.
export async function getOpportunityEvidenceSnapshot(
  admin: SupabaseClient,
  input: { userId: string; videoIdeaId: string },
): Promise<OpportunityEvidenceSnapshotRow | null> {
  const { data } = await admin
    .from('video_idea_opportunity_snapshots')
    .select('*')
    .eq('user_id', input.userId)
    .eq('video_idea_id', input.videoIdeaId)
    .maybeSingle()
  return (data as OpportunityEvidenceSnapshotRow | null) || null
}

// Distinguishes "my own idea, just no snapshot yet" from "this id doesn't
// exist, or belongs to someone else" -- getOpportunityEvidenceSnapshot()
// alone returns null identically for both, which is exactly right for a
// passive READ (no information leak either way), but a WRITER (the
// video-package generation route) needs the distinction: a foreign/
// non-existent video_idea_id must fail closed (404, no charge, no provider
// call, no silent fallback to client-supplied "evidence"), while an own
// idea with no snapshot may still proceed, just without server-verified
// evidence.
export async function verifyOwnVideoIdea(
  admin: SupabaseClient,
  input: { userId: string; videoIdeaId: string },
): Promise<boolean> {
  const { data } = await admin
    .from('video_ideas')
    .select('id')
    .eq('id', input.videoIdeaId)
    .eq('user_id', input.userId)
    .maybeSingle()
  return !!data
}
