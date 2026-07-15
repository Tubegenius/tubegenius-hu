import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  calcCompetitionScore,
  calcFreshness,
  calcNicheMatch,
  calcSearchRelevance,
  calcTrendVelocity,
  calcUploadDensity,
  calcVideoVelocity,
  type YouTubeVideoStats,
} from '@/lib/opportunity-scoring'

const video = (overrides: Partial<YouTubeVideoStats> = {}): YouTubeVideoStats => ({
  videoId: 'v1', title: 'Árvíztűrő növény gondozása', channelTitle: 'Creator',
  publishedAt: '2026-07-14T12:00:00Z', viewCount: 1000, likeCount: 50,
  commentCount: 10, thumbnailUrl: '', ...overrides,
})

afterEach(() => vi.useRealTimers())

describe('opportunity scoring methodology', () => {
  it('matches accents consistently instead of penalizing Hungarian input', () => {
    expect(calcSearchRelevance(video(), 'arvizturo noveny')).toBe(100)
  })

  it('does not award freshness or velocity to invalid and future dates', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const invalid = video({ publishedAt: 'not-a-date' })
    const future = video({ publishedAt: '2026-08-15T12:00:00Z' })
    expect(calcVideoVelocity(invalid)).toBe(0)
    expect(calcTrendVelocity([future])).toBe(15)
    expect(calcFreshness([invalid, future])).toBe(0)
  })

  it('calibrates saturation and competition to the observed API sample', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const recent = Array.from({ length: 8 }, (_, i) => video({ videoId: String(i), channelTitle: `c${i}` }))
    expect(calcUploadDensity(recent, 8).level).toBe('high')
    expect(calcUploadDensity(recent, 25).level).toBe('saturated')
    const lowSampleCompetition = calcCompetitionScore(recent, 2, { score: 65, level: 'high' })
    const fullSampleCompetition = calcCompetitionScore(recent, 25, { score: 35, level: 'saturated' })
    expect(fullSampleCompetition).toBeGreaterThan(lowSampleCompetition + 20)
  })

  it('treats missing niche as neutral and explicit mismatch as weak', () => {
    expect(calcNicheMatch('otthoni edzés', '')).toBe(50)
    expect(calcNicheMatch('otthoni edzés', 'kertészeti tippek')).toBe(10)
    expect(calcNicheMatch('arvizturo növény', 'Árvíztűrő növények')).toBeGreaterThanOrEqual(75)
  })
})
