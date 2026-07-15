import { describe, expect, it } from 'vitest'
import { computeConfidence, isAuditPlatform, scoreManualBackend, scoreYouTubeBackend, validateManualPlatformData, type YouTubeApiData } from '@/lib/video-audit-scoring'

const youtubeData: YouTubeApiData = {
  title: 'Hogyan készíts jobb videót 7 lépésben?', description: 'x'.repeat(250),
  duration_seconds: 600, views: 100_000, likes: 10_000, comments: 1000,
  published_at: '2026-07-15T18:00:00Z', tags: ['a', 'b', 'c', 'd', 'e'],
  thumbnail_url: 'https://example.com/thumb.jpg',
}

describe('video audit evidence boundaries', () => {
  it('does not claim high confidence from views and API metadata alone', () => {
    expect(computeConfidence('youtube_long', 1_000_000, true)).toBe('medium')
    expect(computeConfidence('youtube_long', 1_000_000, true, true)).toBe('high')
  })

  it('does not treat likes, description or thumbnail existence as retention/visual quality', () => {
    const scores = scoreYouTubeBackend(youtubeData, 'youtube_long')
    expect(scores.retention_potential.score).toBe(65)
    expect(scores.retention_potential.weaknesses.join(' ')).toContain('szerkezeti becslés')
    expect(scores.packaging_quality.score).toBe(70)
    expect(scores.packaging_quality.signals.join(' ')).toContain('nem mérhető')
  })

  it('handles zero-view manual data without infinite save-rate bonuses', () => {
    const base = { platform: 'tiktok' as const, topic: 'teszt', title: 'Teszt videó', duration_seconds: 45, views: 0, likes: 0, comments: 0, saves: 10 }
    const withSaves = scoreManualBackend(base)
    const withoutSaves = scoreManualBackend({ ...base, saves: 0 })
    expect(withSaves.engagement_quality.score).toBe(withoutSaves.engagement_quality.score)
  })

  it('treats an explicit zero completion rate as evidence, not missing data', () => {
    const scores = scoreManualBackend({ platform: 'tiktok', topic: 'teszt', title: 'Teszt videó', duration_seconds: 45, views: 1000, likes: 0, comments: 0, completion_rate: 0 })
    expect(scores.retention_potential.score).toBeLessThan(70)
  })

  it('rejects platform mismatch, negative metrics and impossible watch time', () => {
    expect(isAuditPlatform('unknown')).toBe(false)
    const base = { platform: 'tiktok', topic: 'teszt', title: 'Teszt', duration_seconds: 45, views: 100, likes: 2, comments: 1 }
    expect(validateManualPlatformData({ ...base, platform: 'instagram_reels' }, 'tiktok')).toMatchObject({ ok: false })
    expect(validateManualPlatformData({ ...base, views: -1 }, 'tiktok')).toMatchObject({ ok: false })
    expect(validateManualPlatformData({ ...base, avg_watch_time_seconds: 46 }, 'tiktok')).toMatchObject({ ok: false })
    expect(validateManualPlatformData({ ...base, completion_rate: 1.1 }, 'tiktok')).toMatchObject({ ok: false })
    expect(validateManualPlatformData(base, 'tiktok')).toMatchObject({ ok: true })
  })
})
