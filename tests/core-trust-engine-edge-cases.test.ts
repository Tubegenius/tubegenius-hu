import { describe, expect, it } from 'vitest'
import { computeTrustScores } from '@/lib/core-trust-engine/score'
import { decideTrust } from '@/lib/core-trust-engine/decide'
import { validateCandidate } from '@/lib/core-trust-engine/validate'
import type { ValidationResult } from '@/lib/core-trust-engine/types'
import type { TrendCandidate } from '@/lib/trend-radar'

function candidate(overrides: Partial<TrendCandidate> = {}): TrendCandidate {
  return {
    id: 'candidate-1',
    candidate_topic: 'mesterséges intelligencia oktatás',
    category: 'tech_ai',
    region: 'HU',
    trend_source_type: 'serper_youtube',
    confidence: 'high',
    opportunity_type: 'strong_trend',
    serper_evidence_count: 0,
    youtube_relevant_videos_count: 1,
    unique_creator_count: 1,
    freshness_score: 80,
    pollution_score: 0,
    relevance_average: 80,
    source_videos: [{
      videoId: 'abcdefghijk',
      title: 'Mesterséges intelligencia az oktatásban',
      channelTitle: 'Tesztcsatorna',
      channelId: 'channel-1',
      publishedAt: '2026-01-01T00:00:00.000Z',
      viewCount: 5000,
      likeCount: 200,
      commentCount: 20,
      thumbnailUrl: 'https://i.ytimg.com/test.jpg',
      description: 'Mesterséges intelligencia oktatási alkalmazása',
      relevance_score: 90,
      region_relevance: 100,
      is_region_relevant: true,
      relevance_signals: ['topic'],
      market_label: 'hungarian_market',
    }],
    web_sources: [],
    seed_keyword: 'mesterséges intelligencia oktatás',
    market_type: 'hungarian_market',
    ...overrides,
  }
}

function validation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid_web_sources: [],
    valid_video_sources: [],
    rejected_web_sources: [],
    rejected_video_sources: [],
    consistency: {
      topic_consistency_score: 80,
      valid_sources: [],
      removed_sources: [],
      valid_videos: [],
      removed_videos: [],
      hook_topic_match: true,
      is_polluted: false,
      quality_status: 'consistent',
      reasons: [],
    },
    niche_fit_score: 80,
    niche_matched_categories: ['tech_ai'],
    ...overrides,
  }
}

describe('Core Trust Engine edge cases', () => {
  it('bounds non-finite and out-of-range score inputs', () => {
    const scores = computeTrustScores(candidate({ freshness_score: Number.NaN }), validation({ niche_fit_score: Number.POSITIVE_INFINITY }))
    expect(scores.freshness).toBe(0)
    expect(scores.niche_fit).toBe(0)
    expect(Number.isFinite(scores.total)).toBe(true)
    expect(scores.total).toBeGreaterThanOrEqual(1)
    expect(scores.total).toBeLessThanOrEqual(99)
  })

  it('does not use an untrusted raw niche score to grant a production decision', () => {
    const validated = validation({
      niche_fit_score: Number.POSITIVE_INFINITY,
      valid_web_sources: [
        { title: 'A', url: 'https://example.com/a/2026/story', snippet: '', relevance_score: 80 },
        { title: 'B', url: 'https://example.org/b/2026/story', snippet: '', relevance_score: 80 },
      ],
      valid_video_sources: [{
        videoId: 'abcdefghijk', title: 'A', channelTitle: 'C', thumbnailUrl: '', viewCount: 5000,
        likeCount: 10, commentCount: 1, publishedAt: '2026-01-01T00:00:00Z', relevance_score: 80,
        engagement_score: 10, is_strong: true,
      }],
    })
    const scores = computeTrustScores(candidate(), validated)
    expect(decideTrust(scores, validated).final_decision).not.toBe('make_now')
  })

  it.each([
    [{ viewCount: Number.NaN }, 'invalid_video_metrics'],
    [{ relevance_score: 101 }, 'invalid_relevance_score'],
    [{ publishedAt: 'not-a-date' }, 'invalid_published_at'],
    [{ publishedAt: '2099-01-01T00:00:00Z' }, 'invalid_published_at'],
    [{ videoId: 'bad' }, 'invalid_video_id'],
  ])('rejects corrupt video evidence: %s', (videoOverride, reason) => {
    const base = candidate()
    const result = validateCandidate({ ...base, source_videos: [{ ...base.source_videos[0], ...videoOverride }] }, 'mesterséges intelligencia')
    expect(result.valid_video_sources).toHaveLength(0)
    expect(result.rejected_video_sources[0]?.reason).toBe(reason)
  })

  it('rejects non-http web evidence URLs', () => {
    const result = validateCandidate(candidate({
      source_videos: [],
      web_sources: [{
        title: 'Mesterséges intelligencia oktatási kutatás',
        link: 'ftp://example.com/2026/research/article',
        snippet: 'Mesterséges intelligencia az oktatásban',
      }],
    }), 'mesterséges intelligencia')
    expect(result.valid_web_sources).toHaveLength(0)
    expect(result.rejected_web_sources[0]?.reason).toBe('invalid_evidence_url')
  })
})
