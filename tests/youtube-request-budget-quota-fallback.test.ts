import { beforeEach, describe, expect, it, vi } from 'vitest'

// Kulon fajlban, sajat modul-peldannyal — ez a teszt szandekosan beallitja
// a globalis quotaState.quotaExceededAt-ot, ami minden mas, ugyanabban a
// fajlban futo teszt budgetjet 0-ra csokkentene (ld. getEffectiveBudget).
vi.mock('@/lib/external-fetch', () => ({
  fetchExternal: vi.fn(),
}))

import { fetchExternal } from '@/lib/external-fetch'
import { youtubeSearch, createRequestBudgetContext } from '@/lib/youtube-service'

const mockedFetchExternal = vi.mocked(fetchExternal)

function fakeResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

beforeEach(() => {
  process.env.YOUTUBE_API_KEY = 'test-youtube-key'
  delete process.env.YOUTUBE_API_KEY_DEV_BACKUP
  mockedFetchExternal.mockReset()
})

describe('Quota-exceeded event does not reset a request context', () => {
  it('a quota-exceeded response leaves the context own counters intact (only the global quota flag changes)', async () => {
    mockedFetchExternal.mockImplementationOnce(async (_service: string, input: unknown) => {
      const q = new URL(String(input)).searchParams.get('q') || 'q'
      return fakeResponse({
        items: [{ id: { videoId: `v-${q}` }, snippet: { title: `t-${q}`, channelTitle: 'c', publishedAt: new Date().toISOString(), thumbnails: {} } }],
      })
    })

    const ctx = createRequestBudgetContext()
    await youtubeSearch('normal-1', 'US', 'en', 30, 5, 'opportunityEngine', ctx)
    expect(ctx.youtubeSearchCounts.opportunityEngine).toBe(1)

    // Masodik hivas kvota-tullepest szimulal a YouTube API-tol
    mockedFetchExternal.mockImplementationOnce(async () => fakeResponse({
      error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' },
    }))
    await youtubeSearch('quota-hit', 'US', 'en', 30, 5, 'opportunityEngine', ctx)

    // A context sajat, mar felhalmozott szamlaloja nem nullazodik — csak a
    // globalis quotaState allt at, a per-request context fuggetlen marad tole.
    expect(ctx.youtubeSearchCounts.opportunityEngine).toBeGreaterThanOrEqual(1)
  })
})
