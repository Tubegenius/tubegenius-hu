import { beforeEach, describe, expect, it, vi } from 'vitest'

// Ez a fajl azt bizonyitja, hogy a tobblepeses (kereses + stats, vagy tobb
// elemen ciklusban futo) hivok EGYETLEN, kozos RequestBudgetContextet
// hasznalnak a sajat belso hivasaikhoz — nem hoznak letre uj, izolalt
// contextet minden egyes belso hivasnal/iteracional (ami a budget/health
// aggregaciot ertelmetlenne tenne).

vi.mock('@/lib/youtube-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube-service')>()
  return {
    ...actual,
    youtubeSearch: vi.fn(),
    youtubeStats: vi.fn(),
  }
})

import { youtubeSearch, youtubeStats } from '@/lib/youtube-service'

const mockedYoutubeSearch = vi.mocked(youtubeSearch)
const mockedYoutubeStats = vi.mocked(youtubeStats)

describe('fetchSeedVideoStats (keyword-research.ts) shares one context between its search and stats call', () => {
  beforeEach(() => {
    mockedYoutubeSearch.mockReset()
    mockedYoutubeStats.mockReset()
    mockedYoutubeSearch.mockResolvedValue([
      { id: { videoId: 'v1' }, snippet: { title: 't', channelTitle: 'c', publishedAt: new Date().toISOString(), thumbnails: {} } },
    ] as any)
    mockedYoutubeStats.mockResolvedValue(new Map([['v1', { id: 'v1', statistics: { viewCount: '10', likeCount: '1', commentCount: '1' } }]]) as any)
  })

  it('passes the same context reference to youtubeSearch and youtubeStats', async () => {
    const { fetchSeedVideoStats } = await import('@/lib/keyword-research')
    await fetchSeedVideoStats('some seed', 'HU')

    expect(mockedYoutubeSearch).toHaveBeenCalledTimes(1)
    expect(mockedYoutubeStats).toHaveBeenCalledTimes(1)
    const searchContext = mockedYoutubeSearch.mock.calls[0][6]
    const statsContext = mockedYoutubeStats.mock.calls[0][1]
    expect(searchContext).toBe(statsContext)
  })

  it('two separate fetchSeedVideoStats calls (two separate logical operations) do NOT share a context', async () => {
    const { fetchSeedVideoStats } = await import('@/lib/keyword-research')
    await fetchSeedVideoStats('seed one', 'HU')
    await fetchSeedVideoStats('seed two', 'HU')

    const ctx1 = mockedYoutubeSearch.mock.calls[0][6]
    const ctx2 = mockedYoutubeSearch.mock.calls[1][6]
    expect(ctx1).not.toBe(ctx2)
  })
})

function makeFakeSupabaseAdmin(tableResults: Record<string, Array<{ data: unknown; error: unknown }>>) {
  const cursors: Record<string, number> = {}
  const from = vi.fn((table: string) => {
    const i = cursors[table] ?? 0
    cursors[table] = i + 1
    const list = tableResults[table] || []
    const result = list[i] ?? { data: null, error: null }
    const query: any = {
      select: vi.fn(() => query),
      insert: vi.fn(() => query),
      update: vi.fn(() => query),
      delete: vi.fn(() => query),
      eq: vi.fn(() => query),
      lte: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      single: vi.fn(() => Promise.resolve(result)),
      then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    }
    return query
  })
  return { from }
}

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}))

describe('refreshDueCandidates (trend-tracking.ts cron batch) shares one context across all candidates in the batch', () => {
  beforeEach(async () => {
    mockedYoutubeStats.mockReset()
    mockedYoutubeStats.mockResolvedValue(new Map([['v1', { id: 'v1', statistics: { viewCount: '10', likeCount: '1', commentCount: '1' } }]]) as any)

    const candidates = [
      { id: 'cand-1', candidate_topic: 'topic 1', youtube_video_ids: ['v1'], created_at: new Date().toISOString(), opportunity_score: 50, confidence: 'low' },
      { id: 'cand-2', candidate_topic: 'topic 2', youtube_video_ids: ['v1'], created_at: new Date().toISOString(), opportunity_score: 50, confidence: 'low' },
    ]

    const fakeAdmin = makeFakeSupabaseAdmin({
      tracked_trend_candidates: [
        { data: candidates, error: null }, // due-candidates query
        { data: { id: 'cand-1' }, error: null }, // update after cand-1
        { data: { id: 'cand-2' }, error: null }, // update after cand-2
      ],
      trend_candidate_snapshots: [
        { data: [], error: null }, // prev snapshot lookup, cand-1
        { data: { id: 'snap-1' }, error: null }, // insert, cand-1
        { data: [], error: null }, // prev snapshot lookup, cand-2
        { data: { id: 'snap-2' }, error: null }, // insert, cand-2
      ],
    })

    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as any)
  })

  it('passes the same context reference to every youtubeStats call across the whole batch', async () => {
    const { refreshDueCandidates } = await import('@/lib/trend-tracking')
    const result = await refreshDueCandidates(20)

    expect(result.processed).toBe(2)
    expect(result.updated).toBe(2)
    expect(mockedYoutubeStats).toHaveBeenCalledTimes(2)
    const ctxCand1 = mockedYoutubeStats.mock.calls[0][1]
    const ctxCand2 = mockedYoutubeStats.mock.calls[1][1]
    expect(ctxCand1).toBe(ctxCand2)
  })
})
