import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createYouTubeCollectorProviders } from '@/lib/emerging-signal/youtube-collector-provider'

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Premium YouTube collector provider', () => {
  it('contains no Serper, Claude, AI provider or backup-key fallback path', () => {
    const files = [
      'lib/emerging-signal/youtube-collector-provider.ts',
      'lib/emerging-signal/collection-orchestrator.ts',
      'app/api/cron/collect-signals/route.ts',
    ].map(file => readFileSync(path.join(process.cwd(), file), 'utf8'))
    const source = files.join('\n')
    expect(source).not.toMatch(/from\s+['"][^'"]*(serper|anthropic|claude|ai-provider)[^'"]*['"]/i)
    expect(source).not.toMatch(/YOUTUBE_(BACKUP|SECONDARY)_API_KEY|BACKUP_YOUTUBE_API_KEY/)
  })

  it('maps discovery results and omits regionCode for BOTH', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response({ items: [{
      id: { videoId: 'video_1' },
      snippet: {
        title: 'Early signal', description: 'Primary evidence', channelId: 'channel_1',
        channelTitle: 'Signal Lab', publishedAt: '2026-08-04T08:00:00.000Z',
      },
    }] }))
    const providers = createYouTubeCollectorProviders({
      apiKey: 'test-key', fetchImpl: fetchMock as unknown as typeof fetch, now: () => new Date('2026-08-04T12:00:00.000Z'),
    })

    const result = await providers.discovery.search({ query: 'robotics', region: 'BOTH', language: 'en', maxResults: 25 })

    expect(result).toMatchObject({ outcome: 'success', videos: [{ videoId: 'video_1', title: 'Early signal' }] })
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.hostname).toBe('www.googleapis.com')
    expect(url.pathname).toBe('/youtube/v3/search')
    expect(url.searchParams.get('regionCode')).toBeNull()
    expect(url.searchParams.get('maxResults')).toBe('25')
    expect(url.searchParams.get('publishedAfter')).toBe('2026-07-05T12:00:00.000Z')
  })

  it('sets an explicit region and maps observation statistics', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response({ items: [] }))
      .mockResolvedValueOnce(response({ items: [] }))
      .mockResolvedValueOnce(response({ items: [{
        id: 'video_1', statistics: { viewCount: '1234', likeCount: '45', commentCount: '6' },
      }] }))
    const providers = createYouTubeCollectorProviders({ apiKey: 'test-key', fetchImpl: fetchMock as unknown as typeof fetch })

    await providers.discovery.search({ query: 'trend', region: 'HU', language: 'hu', maxResults: 25 })
    const observation = await providers.observation.fetchVideoStats(['video_1'])

    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('regionCode')).toBe('HU')
    expect(observation).toEqual({
      outcome: 'success', videos: [{ videoId: 'video_1', viewCount: 1234, likeCount: 45, commentCount: 6 }],
    })
    const statsUrl = new URL(String(fetchMock.mock.calls[1][0]))
    expect(statsUrl.pathname).toBe('/youtube/v3/videos')
    expect(statsUrl.searchParams.get('id')).toBe('video_1')
  })

  it('classifies provider quota exhaustion without a backup-key retry', async () => {
    const fetchImpl = vi.fn(async () => response({
      error: { errors: [{ reason: 'quotaExceeded' }] },
    }, 403)) as unknown as typeof fetch
    const providers = createYouTubeCollectorProviders({ apiKey: 'only-key', fetchImpl })

    expect(await providers.discovery.search({ query: 'trend', region: 'US', language: 'en', maxResults: 25 }))
      .toEqual({ outcome: 'quota_exhausted' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fails closed on transport ambiguity, malformed payloads and missing configuration', async () => {
    const network = vi.fn(async () => { throw new TypeError('network') }) as unknown as typeof fetch
    const malformed = vi.fn(async () => response({ items: [{ id: 'video_1', statistics: { viewCount: 'NaN' } }] })) as unknown as typeof fetch

    expect(await createYouTubeCollectorProviders({ apiKey: 'key', fetchImpl: network }).observation.fetchVideoStats(['video_1']))
      .toEqual({ outcome: 'outcome_unknown', errorClass: 'connection_lost' })
    expect(await createYouTubeCollectorProviders({ apiKey: 'key', fetchImpl: malformed }).observation.fetchVideoStats(['video_1']))
      .toEqual({ outcome: 'failure', errorClass: 'invalid_response' })
    expect(await createYouTubeCollectorProviders({ apiKey: '' }).discovery.search({
      query: 'trend', region: 'BOTH', language: 'en', maxResults: 25,
    })).toEqual({ outcome: 'failure', errorClass: 'provider_rejected' })
  })

  it('requests two IDs, gets stats back for only one, and the parser reports exactly that one video as found', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response({ items: [
      { id: 'video_found', statistics: { viewCount: '500', likeCount: '20', commentCount: '3' } },
    ] }))
    const provider = createYouTubeCollectorProviders({ apiKey: 'key', fetchImpl: fetchImpl as unknown as typeof fetch }).observation

    const result = await provider.fetchVideoStats(['video_found', 'video_missing'])

    expect(result).toEqual({
      outcome: 'success', videos: [{ videoId: 'video_found', viewCount: 500, likeCount: 20, commentCount: 3 }],
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = new URL(String(fetchImpl.mock.calls[0][0]))
    expect(url.searchParams.get('id')).toBe('video_found,video_missing')
  })

  it('rejects observation calls outside the one-to-fifty ID contract before fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const provider = createYouTubeCollectorProviders({ apiKey: 'key', fetchImpl }).observation
    expect(await provider.fetchVideoStats([])).toEqual({ outcome: 'failure', errorClass: 'invalid_response' })
    expect(await provider.fetchVideoStats(Array.from({ length: 51 }, (_, index) => `v${index}`)))
      .toEqual({ outcome: 'failure', errorClass: 'invalid_response' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
