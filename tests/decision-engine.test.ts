import { afterEach, describe, expect, it, vi } from 'vitest'
import { ageDays, decideSimilarVideo, hasVideoMarketValidation, isValidVideoDecisionInput, scoreValidatedVideo } from '@/lib/scoring/willviral-decision-engine'

afterEach(() => vi.useRealTimers())

describe('WillViral decision engine safety gates', () => {
  it('treats invalid and future timestamps as stale, never fresh', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    expect(ageDays('invalid')).toBe(9999)
    expect(ageDays('2026-08-15T12:00:00Z')).toBe(9999)
  })

  it('fails closed to score zero on non-finite numeric input', () => {
    expect(scoreValidatedVideo({ relevance_score: NaN, freshness_score: 90, velocity_score: 90, engagement_score: 90, outlier_score: 90, view_count: 10000, views_per_day: 1000, published_at: '2026-07-15T00:00:00Z' })).toBe(0)
  })

  it('does not classify a future-dated video as production-ready', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const result = decideSimilarVideo({ relevance_score: 90, freshness_score: 100, velocity_score: 90, engagement_score: 90, outlier_score: 90, view_count: 100000, views_per_day: 10000, published_at: '2026-08-15T12:00:00Z' })
    expect(result.status).not.toBe('ready')
    expect(result.gates.freshness).toBe(false)
  })

  it.each([
    { relevance_score: 101 },
    { freshness_score: -1 },
    { view_count: Number.POSITIVE_INFINITY },
    { views_per_day: Number.NaN },
    { engagement_score: Number.POSITIVE_INFINITY },
  ])('rejects corrupt numeric evidence instead of opening a market gate: %s', override => {
    const input = {
      relevance_score: 90, freshness_score: 90, velocity_score: 90, engagement_score: 90,
      outlier_score: 90, view_count: 10000, views_per_day: 1000,
      published_at: '2026-07-15T00:00:00Z', ...override,
    }
    expect(isValidVideoDecisionInput(input)).toBe(false)
    expect(hasVideoMarketValidation(input)).toBe(false)
    expect(decideSimilarVideo(input)).toMatchObject({ status: 'rejected', score: 0 })
  })
})
