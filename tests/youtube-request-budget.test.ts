import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fetchExternal-t teljesen lecsereljuk, hogy ne induljon valodi halozati
// hivas — csak a hivasok szamat/formajat ellenorizzuk.
vi.mock('@/lib/external-fetch', () => ({
  fetchExternal: vi.fn(),
}))

import { fetchExternal } from '@/lib/external-fetch'
import {
  youtubeSearch,
  youtubeStats,
  createRequestBudgetContext,
  getEffectiveBudget,
} from '@/lib/youtube-service'

const mockedFetchExternal = vi.mocked(fetchExternal)

function fakeResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

beforeEach(() => {
  process.env.YOUTUBE_API_KEY = 'test-youtube-key'
  delete process.env.YOUTUBE_API_KEY_DEV_BACKUP
  mockedFetchExternal.mockReset()
  mockedFetchExternal.mockImplementation(async (_service: string, input: unknown) => {
    const url = String(input)
    if (url.includes('/youtube/v3/search')) {
      const q = new URL(url).searchParams.get('q') || 'q'
      return fakeResponse({
        items: [{
          id: { videoId: `v-${q}` },
          snippet: {
            title: `Title for ${q}`,
            channelTitle: 'Channel',
            channelId: 'chan-1',
            publishedAt: new Date().toISOString(),
            thumbnails: {},
          },
        }],
      })
    }
    if (url.includes('/youtube/v3/videos')) {
      const idsParam = new URL(url).searchParams.get('id') || ''
      const ids = idsParam ? idsParam.split(',') : []
      return fakeResponse({
        items: ids.map(id => ({ id, statistics: { viewCount: '100', likeCount: '1', commentCount: '1' } })),
      })
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  })
})

describe('RequestBudgetContext — per-request isolation (no shared module state)', () => {
  it('two concurrent requests using separate contexts do not mix search counters', async () => {
    const ctxA = createRequestBudgetContext()
    const ctxB = createRequestBudgetContext()
    await Promise.all([
      youtubeSearch('alpha-1', 'US', 'en', 30, 5, 'similarVideos', ctxA),
      youtubeSearch('beta-1', 'US', 'en', 30, 5, 'similarVideos', ctxB),
    ])
    expect(ctxA.youtubeSearchCounts.similarVideos).toBe(1)
    expect(ctxB.youtubeSearchCounts.similarVideos).toBe(1)
    expect(ctxA.requestId).not.toBe(ctxB.requestId)
  })

  it('five broad-discovery packs sharing one context consume at most 5 YouTube searches total, even under a fully concurrent burst', async () => {
    const shared = createRequestBudgetContext()
    // 5 pack x 2 query-proba = 10 kiserlet, EGYETLEN kozos contexten, teljesen
    // lapos (nem pack-enkent sorosan futo) Promise.all-lal — ez pontosan az a
    // race, amit korabban a modul-szintu currentRequestId okozott.
    const allQueries = Array.from({ length: 5 }, (_, p) => [`pack${p}-q1`, `pack${p}-q2`]).flat()
    await Promise.all(allQueries.map(q => youtubeSearch(q, 'US', 'en', 30, 5, 'opportunityEngine', shared)))
    expect(shared.youtubeSearchCounts.opportunityEngine).toBe(5)
    expect(shared.externalAttempts).toBe(5)
  })

  it('trying more queries than the budget allows still caps at the budget (query fallback)', async () => {
    const ctx = createRequestBudgetContext()
    const queries = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']
    for (const q of queries) {
      await youtubeSearch(q, 'US', 'en', 30, 5, 'opportunityEngine', ctx)
    }
    expect(ctx.youtubeSearchCounts.opportunityEngine).toBe(5)
  })

  it('counts different endpoints separately within the same context', async () => {
    const ctx = createRequestBudgetContext()
    await youtubeSearch('e1', 'US', 'en', 30, 5, 'similarVideos', ctx)
    await youtubeSearch('e2', 'US', 'en', 30, 5, 'opportunityEngine', ctx)
    expect(ctx.youtubeSearchCounts.similarVideos).toBe(1)
    expect(ctx.youtubeSearchCounts.opportunityEngine).toBe(1)
  })

  it('a cache hit does not consume search budget, and is measured as a cache hit', async () => {
    const ctx1 = createRequestBudgetContext()
    await youtubeSearch('cache-me', 'US', 'en', 30, 5, 'similarVideos', ctx1)
    expect(ctx1.youtubeSearchCounts.similarVideos).toBe(1)

    const callsBefore = mockedFetchExternal.mock.calls.length
    const ctx2 = createRequestBudgetContext()
    const items = await youtubeSearch('cache-me', 'US', 'en', 30, 5, 'similarVideos', ctx2)
    expect(items.length).toBe(1)
    expect(mockedFetchExternal.mock.calls.length).toBe(callsBefore) // nincs uj kulso hivas
    expect(ctx2.cacheHits).toBe(1)
    expect(ctx2.youtubeSearchCounts.similarVideos ?? 0).toBe(0)
    expect(ctx2.externalAttempts).toBe(0)
  })

  it('a stats call is measured separately from the search budget', async () => {
    const ctx = createRequestBudgetContext()
    const stats = await youtubeStats(['vid-1', 'vid-2'], ctx)
    expect(stats.size).toBe(2)
    expect(ctx.youtubeStatsCalls).toBe(1)
    expect(ctx.youtubeSearchCounts.opportunityEngine ?? 0).toBe(0)
  })

  it('the budget context never carries query text or user-identifying fields', async () => {
    const ctx = createRequestBudgetContext()
    await youtubeSearch('a very specific user search phrase', 'US', 'en', 30, 5, 'similarVideos', ctx)
    expect(Object.keys(ctx).sort()).toEqual([
      'backupKeyRetries', 'cacheHits', 'createdAt', 'externalAttempts',
      'haikuRewriteCount', 'lastSerperError', 'requestId', 'serperAttempts',
      'serperFailures', 'youtubeSearchCounts', 'youtubeStatsCalls',
    ].sort())
    expect(JSON.stringify(ctx)).not.toContain('very specific user search phrase')
  })

  it('the context parameter is mandatory — a caller cannot silently omit it (compile-time enforced)', async () => {
    // Ez a teszt maga a bizonyitek: ha a context opcionalis maradt volna,
    // ez a hivas (context nelkul) lefordulna. Mivel kotelezo, a helyes hivas
    // mindig egy explicit contextet ad at — ugyanugy, ahogy a valodi hivok
    // (keyword-research.ts/viral-score/deep-refresh) most mar teszik.
    const ctx = createRequestBudgetContext()
    const items = await youtubeSearch('explicit-context-call', 'US', 'en', 365, 25, 'manualTopicSearch', ctx)
    expect(items.length).toBe(1)
    const stats = await youtubeStats([items[0].id.videoId], ctx)
    expect(stats.size).toBe(1)
    expect(ctx.youtubeSearchCounts.manualTopicSearch).toBe(1)
    expect(ctx.youtubeStatsCalls).toBe(1)
  })

  it('getEffectiveBudget is unaffected by the context refactor (pure, global-throttle based)', () => {
    expect(getEffectiveBudget('opportunityEngine')).toBe(5)
    expect(getEffectiveBudget('similarVideos')).toBe(3)
    expect(getEffectiveBudget('videoPackage')).toBe(0)
  })
})
