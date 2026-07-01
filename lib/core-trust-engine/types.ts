import type { TrendCandidate } from '@/lib/trend-radar'
import type { ConsistencyResult } from '@/lib/candidate-consistency'

export const ENGINE_VERSION = 'core-trust-v1'

export type TrustDecisionType =
  | 'hybrid_validated_trend'
  | 'web_validated_opportunity'
  | 'video_inspiration'
  | 'research_required'
  | 'polluted_candidate'

export type FinalDecision = 'make_now' | 'early_opportunity' | 'validate_more' | 'reject'

export interface TrustScores {
  web_validation: number
  niche_fit: number
  content_gap: number
  video_engagement: number
  freshness: number
  total: number
}

export interface TrustDecision {
  type: TrustDecisionType
  final_decision: FinalDecision
  confidence: 'high' | 'medium' | 'low'
  user_facing: boolean
  label: string
  explanation: string
  reasons: string[]
  warnings: string[]
  cta_primary: { text: string; action: string }
  cta_secondary?: { text: string; action: string }
}

export interface SafeOutput {
  headline: string
  explanation: string
  hook: string | null
  hook_status: 'generated' | 'blocked'
  blocked_reason?: string
  dashboard_label: string
  detail_label: string
  ctas: Array<{ text: string; action: string }>
  risk_flags: string[]
}

export interface ValidatedWebSource {
  title: string
  url: string
  snippet: string
  date?: string
  source?: string
  relevance_score: number
}

export interface ValidatedVideoSource {
  videoId: string
  title: string
  channelTitle: string
  thumbnailUrl: string
  viewCount: number
  likeCount: number
  commentCount: number
  publishedAt: string
  description?: string
  relevance_score: number
  engagement_score: number
  is_strong: boolean
}

export interface ValidationResult {
  valid_web_sources: ValidatedWebSource[]
  valid_video_sources: ValidatedVideoSource[]
  rejected_web_sources: Array<{ title: string; reason: string }>
  rejected_video_sources: Array<{ title: string; reason: string }>
  consistency: ConsistencyResult
  niche_fit_score: number
  niche_matched_categories: string[]
}

export interface ViralCandidate {
  id: string
  engine_version: string
  candidate_topic: string
  seed_keyword: string
  category: string

  trend_source_type: string
  raw_confidence: 'high' | 'medium' | 'low'

  validation: ValidationResult
  scores: TrustScores
  decision: TrustDecision
  safe_output: SafeOutput

  raw_candidate: TrendCandidate

  expansion_type?: string
  expansion_intent?: string
  expanded_from_query?: string
  story_potential_score?: number
  story_potential_breakdown?: {
    total: number
    mystery_factor: number
    twist_strength: number
    human_element: number
    conflict_or_tension: number
    narrative_payoff: number
    visual_story_potential: number
  }
  recommended_angle?: string
  recommended_format?: string
  hook_pattern?: string
}
