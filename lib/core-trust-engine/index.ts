import type { ViralCandidate, SafeOutput } from './types'
import { ENGINE_VERSION } from './types'
import type { TrendCandidate } from '@/lib/trend-radar'
import type { OpportunityTopic } from '@/types'
import type { TopicExpansionResult } from '@/lib/topic-expansion'
import {
  findExpansionForSeed,
  scoreStoryPotentialFromText,
  recommendedAngleForExpansion,
  recommendedFormatForExpansion,
  hookPatternForExpansion,
} from '@/lib/topic-expansion'
import { validateCandidate } from './validate'
import { computeTrustScores } from './score'
import { decideTrust } from './decide'
import { buildSafeOutput, buildClaudePromptContext } from './safe-output'
import { trendSourceLabel, type TrendSourceType } from '@/lib/trend-radar'

export { ENGINE_VERSION }
export { buildCacheKey, buildTrendCacheKey } from './cache'
export { buildClaudePromptContext } from './safe-output'
export type { ViralCandidate, TrustScores, TrustDecision, SafeOutput, ValidationResult } from './types'

export function evaluateCandidate(
  candidate: TrendCandidate,
  niche: string,
  expansion?: TopicExpansionResult,
): ViralCandidate | null {
  const validation = validateCandidate(candidate, niche)

  if (validation.consistency.is_polluted) {
    const scores = computeTrustScores(candidate, validation)
    const decision = decideTrust(scores, validation)
    const safe_output = buildSafeOutput({
      candidate_topic: candidate.candidate_topic,
      decision,
      validation,
    })
    return {
      id: candidate.id,
      engine_version: ENGINE_VERSION,
      candidate_topic: candidate.candidate_topic,
      seed_keyword: candidate.seed_keyword,
      category: candidate.category,
      trend_source_type: candidate.trend_source_type,
      raw_confidence: candidate.confidence as 'high' | 'medium' | 'low',
      validation,
      scores,
      decision,
      safe_output,
      raw_candidate: candidate,
    }
  }

  if (validation.valid_web_sources.length === 0 && validation.valid_video_sources.length === 0) {
    return null
  }

  const scores = computeTrustScores(candidate, validation)
  const decision = decideTrust(scores, validation)

  if (!decision.user_facing) return null

  const expansionMatch = findExpansionForSeed(
    candidate.seed_keyword || candidate.candidate_topic,
    expansion,
  )
  const expansionType = expansionMatch?.expansion_type
  const storyPotential = scoreStoryPotentialFromText([
    candidate.candidate_topic,
    candidate.seed_keyword,
    ...validation.valid_web_sources.map(s => `${s.title} ${s.snippet || ''}`),
    ...validation.valid_video_sources.map(v => `${v.title} ${v.description || ''}`),
  ].join(' '), expansionType)

  const safe_output = buildSafeOutput({
    candidate_topic: candidate.candidate_topic,
    decision,
    validation,
  })

  return {
    id: candidate.id,
    engine_version: ENGINE_VERSION,
    candidate_topic: candidate.candidate_topic,
    seed_keyword: candidate.seed_keyword,
    category: candidate.category,
    trend_source_type: candidate.trend_source_type,
    raw_confidence: candidate.confidence as 'high' | 'medium' | 'low',
    validation,
    scores,
    decision,
    safe_output,
    raw_candidate: candidate,
    expansion_type: expansionType,
    expansion_intent: expansionMatch?.intent,
    expanded_from_query: expansionMatch?.query || candidate.seed_keyword,
    story_potential_score: storyPotential.total,
    story_potential_breakdown: storyPotential,
    recommended_angle: recommendedAngleForExpansion(expansionType, candidate.candidate_topic),
    recommended_format: recommendedFormatForExpansion(expansionType, storyPotential.total),
    hook_pattern: hookPatternForExpansion(expansionType, candidate.candidate_topic),
  }
}

export function applySafeOutput(
  candidate: ViralCandidate,
  claudeExplanation?: { title: string; description: string; hook?: string },
): ViralCandidate {
  if (!claudeExplanation) return candidate

  const safe_output = buildSafeOutput({
    candidate_topic: candidate.candidate_topic,
    decision: candidate.decision,
    validation: candidate.validation,
    claude_title: claudeExplanation.title,
    claude_description: claudeExplanation.description,
    claude_hook: claudeExplanation.hook,
  })

  return { ...candidate, safe_output }
}

export function toOpportunityTopic(
  candidate: ViralCandidate,
  meta: {
    niche: string
    platform?: string
    region: 'HU' | 'US'
    needsExplanation?: boolean
  },
): OpportunityTopic & Record<string, unknown> {
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  return {
    id: candidate.id,
    title: candidate.safe_output.headline,
    description: candidate.safe_output.explanation,
    opportunity_score: candidate.scores.total,
    score_breakdown: {
      trend_momentum: candidate.scores.web_validation,
      niche_match: candidate.scores.niche_fit,
      content_gap: candidate.scores.content_gap,
      competition: Math.max(0, 100 - candidate.scores.video_engagement),
      freshness: candidate.scores.freshness,
      total: candidate.scores.total,
    },
    region: meta.region,
    platform: (meta.platform || 'youtube') as OpportunityTopic['platform'],
    niche: meta.niche,
    generated_at: now,
    expires_at: expires,
    evidence_videos: candidate.validation.valid_video_sources.map(v => ({
      video_id: v.videoId,
      title: v.title,
      channel_title: v.channelTitle,
      thumbnail_url: v.thumbnailUrl,
      view_count: v.viewCount,
      like_count: v.likeCount,
      comment_count: v.commentCount,
      published_at: v.publishedAt,
      url: `https://youtube.com/watch?v=${v.videoId}`,
      duration: null,
    })),
    web_sources: candidate.validation.valid_web_sources.map(s => ({
      title: s.title,
      url: s.url,
      snippet: s.snippet,
      date: s.date,
      source: s.source,
    })),
    confidence: candidate.raw_confidence === 'high' ? 'magas'
      : candidate.raw_confidence === 'medium' ? 'közepes'
      : 'alacsony',
    keyword: candidate.seed_keyword,
    niche_cluster: candidate.category,
    trend_source_type: candidate.trend_source_type,
    trend_confidence: candidate.raw_confidence,
    trend_source_label: trendSourceLabel(candidate.trend_source_type as TrendSourceType),
    hook_suggestion: candidate.safe_output.hook || undefined,
    user_input: meta.niche,
    expanded_from_query: candidate.expanded_from_query,
    expansion_type: candidate.expansion_type,
    expansion_intent: candidate.expansion_intent,
    story_potential_score: candidate.story_potential_score,
    story_potential_breakdown: candidate.story_potential_breakdown,
    recommended_angle: candidate.recommended_angle,
    recommended_format: candidate.recommended_format,
    hook_pattern: candidate.hook_pattern,
    ready_to_produce_status: mapDecisionToReadyStatus(candidate.decision.final_decision),
    ready_to_produce_label: candidate.decision.label,
    evidence_match_score: candidate.scores.total,
    risk_flags: candidate.safe_output.risk_flags,
    decision_score: candidate.scores.total,
    topic_consistency_score: candidate.validation.consistency.topic_consistency_score,
    topic_consistency_status: candidate.validation.consistency.quality_status,
    validation_summary: {
      validation_type: candidate.decision.type,
      web_validation_score: candidate.scores.web_validation,
      video_validation_score: candidate.scores.video_engagement,
      content_gap_score: candidate.scores.content_gap,
      freshness_score: candidate.scores.freshness,
      topic_consistency_score: candidate.validation.consistency.topic_consistency_score,
      final_decision: candidate.decision.final_decision,
      explanation: candidate.safe_output.explanation,
      label: candidate.decision.label,
      cta_primary: candidate.decision.cta_primary,
      cta_secondary: candidate.decision.cta_secondary,
    },
    safe_output: {
      headline: candidate.safe_output.headline,
      explanation: candidate.safe_output.explanation,
      hook: candidate.safe_output.hook,
      hook_status: candidate.safe_output.hook_status,
      blocked_reason: candidate.safe_output.blocked_reason,
      dashboard_label: candidate.safe_output.dashboard_label,
      detail_label: candidate.safe_output.detail_label,
      ctas: candidate.safe_output.ctas,
      risk_flags: candidate.safe_output.risk_flags,
    },
    engine_version: candidate.engine_version,
    needs_explanation: meta.needsExplanation || false,
  }
}

function mapDecisionToReadyStatus(decision: string): 'ready' | 'watch' | 'research' | 'rejected' {
  switch (decision) {
    case 'make_now': return 'ready'
    case 'early_opportunity': return 'watch'
    case 'validate_more': return 'research'
    case 'reject': return 'rejected'
    default: return 'research'
  }
}
