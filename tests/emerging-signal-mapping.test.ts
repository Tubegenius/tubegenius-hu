import { describe, expect, it } from 'vitest'
import {
  deriveYoutubeSourceKey,
  deriveWebSourceKey,
  buildYoutubeEvidenceCandidate,
  buildWebEvidenceCandidate,
  buildYoutubeObservationCandidates,
} from '@/lib/emerging-signal/capture'
import type { VideoWithRelevance, SerperResult } from '@/lib/trend-radar'

function video(overrides: Partial<VideoWithRelevance> = {}): VideoWithRelevance {
  return {
    videoId: 'abcdefghijk',
    title: 'Test Video',
    channelTitle: 'Test Channel',
    channelId: 'UC_test',
    publishedAt: '2026-08-01T00:00:00.000Z',
    viewCount: 1000,
    likeCount: 50,
    commentCount: 5,
    thumbnailUrl: 'https://i.ytimg.com/x.jpg',
    description: 'A description',
    relevance_score: 80,
    region_relevance: 90,
    is_region_relevant: true,
    relevance_signals: [],
    market_label: 'hungarian_market',
    ...overrides,
  }
}

function serperResult(overrides: Partial<SerperResult> = {}): SerperResult {
  return {
    title: 'Test Article',
    link: 'https://example.test/article-1',
    snippet: 'A snippet',
    date: '2026-08-01T00:00:00.000Z',
    source: 'example.test',
    ...overrides,
  }
}

describe('deriveYoutubeSourceKey', () => {
  it('uses the actually-available channelId', () => {
    expect(deriveYoutubeSourceKey(video())).toEqual({ sourceType: 'youtube_channel', externalId: 'UC_test' })
  })
  it('controlled skip (null) when channelId is empty — never fabricates one', () => {
    expect(deriveYoutubeSourceKey(video({ channelId: '' }))).toBeNull()
  })
})

describe('deriveWebSourceKey', () => {
  it('uses the canonical domain extracted from the link', () => {
    expect(deriveWebSourceKey(serperResult())).toEqual({ sourceType: 'web_domain', externalId: 'example.test', canonicalDomain: 'example.test' })
  })
  it('controlled skip (null) when the link is not a parseable URL', () => {
    expect(deriveWebSourceKey(serperResult({ link: 'not a url' }))).toBeNull()
  })
})

describe('buildYoutubeEvidenceCandidate', () => {
  it('maps the actually-available fields, canonical_url always null for youtube_video', () => {
    const ev = buildYoutubeEvidenceCandidate(video())
    expect(ev).toEqual({
      evidenceType: 'youtube_video',
      externalRef: 'abcdefghijk',
      title: 'Test Video',
      snippet: 'A description',
      publishedAt: '2026-08-01T00:00:00.000Z',
      canonicalUrl: null,
    })
  })
  it('unparseable publishedAt -> null, not a fabricated timestamp', () => {
    const ev = buildYoutubeEvidenceCandidate(video({ publishedAt: 'not a date' }))
    expect(ev!.publishedAt).toBeNull()
  })
  it('missing videoId -> controlled skip', () => {
    expect(buildYoutubeEvidenceCandidate(video({ videoId: '' }))).toBeNull()
  })
})

describe('buildWebEvidenceCandidate', () => {
  it('raw link as external_ref, normalized canonical_url', () => {
    const ev = buildWebEvidenceCandidate(serperResult({ link: 'https://WWW.Example.test/article-1?utm=x' }))
    expect(ev!.externalRef).toBe('https://WWW.Example.test/article-1?utm=x')
    expect(ev!.canonicalUrl).toBe('https://example.test/article-1')
    expect(ev!.evidenceType).toBe('serper_web')
  })
  it('unparseable link -> controlled skip (no evidence row at all)', () => {
    expect(buildWebEvidenceCandidate(serperResult({ link: 'not a url' }))).toBeNull()
  })
  it('fuzzy relative date ("2 days ago") -> publishedAt null, not fabricated', () => {
    const ev = buildWebEvidenceCandidate(serperResult({ date: '2 days ago' }))
    expect(ev!.publishedAt).toBeNull()
  })
})

describe('buildYoutubeObservationCandidates', () => {
  it('emits one observation per actually-present raw metric', () => {
    const obs = buildYoutubeObservationCandidates(video({ viewCount: 100, likeCount: 10, commentCount: 2 }))
    expect(obs).toEqual([
      { metricType: 'youtube_view_count', metricValue: 100 },
      { metricType: 'youtube_like_count', metricValue: 10 },
      { metricType: 'youtube_comment_count', metricValue: 2 },
    ])
  })
  it('does not fabricate an observation for a non-finite/negative value', () => {
    const obs = buildYoutubeObservationCandidates(video({ viewCount: Number.NaN, likeCount: -5, commentCount: 3 }))
    expect(obs).toEqual([{ metricType: 'youtube_comment_count', metricValue: 3 }])
  })
})

describe('sensitive data never appears in writer payload shapes', () => {
  it('evidence candidate objects never contain an API key/token/secret-shaped field', () => {
    const ev = buildYoutubeEvidenceCandidate(video())
    const json = JSON.stringify(ev)
    expect(json.toLowerCase()).not.toMatch(/api[_-]?key|secret|token|password/)
  })
  it('the mapping functions never receive or emit anything resembling a stack trace', () => {
    const ev = buildWebEvidenceCandidate(serperResult())
    const json = JSON.stringify(ev)
    expect(json).not.toMatch(/at .*\(.*:\d+:\d+\)/)
  })
})
