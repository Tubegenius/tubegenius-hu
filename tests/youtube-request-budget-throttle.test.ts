import { beforeEach, describe, expect, it, vi } from 'vitest'

// Kulon fajlban, sajat, izolalt modul-peldannyal (vitest per-fajl izolacio),
// mert ez a teszt szandekosan feltolti a globalis napi quotaState.searchCount
// szamlalot a throttle kuszob (80) fole — ha ez ugyanabban a fajlban lenne,
// mint a tobbi budget-teszt, a kesobbi tesztek is throttled (csokkentett)
// budgetet latnanak, nem a normal 5-os/3-as erteket.
vi.mock('@/lib/external-fetch', () => ({
  fetchExternal: vi.fn(),
}))

import { fetchExternal } from '@/lib/external-fetch'
import { youtubeSearch, createRequestBudgetContext, getEffectiveBudget } from '@/lib/youtube-service'

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
    const q = new URL(url).searchParams.get('q') || 'q'
    return fakeResponse({
      items: [{
        id: { videoId: `v-${q}` },
        snippet: { title: `t-${q}`, channelTitle: 'c', publishedAt: new Date().toISOString(), thumbnails: {} },
      }],
    })
  })
})

describe('YouTube daily throttle — preserved, not reset by the per-request context refactor', () => {
  it('a throttled daily quota state reduces the effective per-endpoint budget', async () => {
    expect(getEffectiveBudget('opportunityEngine')).toBe(5)
    expect(getEffectiveBudget('similarVideos')).toBe(3)

    // 80 kulonbozo lekerdezes, mindegyik SAJAT, izolalt contexttel — igy csak
    // a globalis napi szamlalot toljuk fel, egyetlen context sajat
    // request-budgetjet sem fogyasztjuk el ezzel (az mindig ujra 0-rol indul).
    for (let i = 0; i < 80; i++) {
      await youtubeSearch(`throttle-q-${i}`, 'US', 'en', 30, 5, 'similarVideos', createRequestBudgetContext())
    }

    expect(getEffectiveBudget('opportunityEngine')).toBe(2)
    expect(getEffectiveBudget('similarVideos')).toBe(1)
  })
})
