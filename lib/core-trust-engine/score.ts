import type { TrustScores, ValidationResult } from './types'
import type { TrendCandidate } from '@/lib/trend-radar'

function boundedScore(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}

export function computeTrustScores(
  candidate: TrendCandidate,
  validation: ValidationResult,
): TrustScores {
  const validWebCount = validation.valid_web_sources.length
  const web_validation = Math.min(100, validWebCount * 35)

  const niche_fit = boundedScore(validation.niche_fit_score)

  const videoCount = validation.valid_video_sources.length
  const content_gap = videoCount === 0
    ? 90
    : Math.max(10, 90 - videoCount * 12)

  const strongVideoCount = validation.valid_video_sources.filter(v => v.is_strong).length
  const video_engagement = Math.min(100, strongVideoCount * 25)

  const freshness = boundedScore(candidate.freshness_score)

  const total = Math.round(
    web_validation    * 0.30 +
    niche_fit         * 0.20 +
    content_gap       * 0.20 +
    video_engagement  * 0.15 +
    freshness         * 0.15
  )

  return {
    web_validation,
    niche_fit,
    content_gap,
    video_engagement,
    freshness,
    total: Number.isFinite(total) ? Math.min(99, Math.max(1, total)) : 1,
  }
}
