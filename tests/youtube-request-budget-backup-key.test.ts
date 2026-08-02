import { beforeEach, describe, expect, it, vi } from 'vitest'

// Kulon fajlban — NODE_ENV='development'-re allitjuk (ez kelleti a backup-key
// vaeltas es az ensureActiveKey() dev-mode ping utjat), ami mas fajlok
// tesztjeit nem erintheti (vitest per-fajl izolacio).
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
  vi.stubEnv('NODE_ENV', 'development')
  process.env.YOUTUBE_API_KEY = 'primary-key'
  process.env.YOUTUBE_API_KEY_DEV_BACKUP = 'backup-key'
  mockedFetchExternal.mockReset()
})

describe('Logical search slot vs. external HTTP attempt — backup-key retry', () => {
  it('a quota-exceeded primary attempt followed by a successful backup retry consumes exactly ONE logical slot but TWO external attempts', async () => {
    mockedFetchExternal.mockImplementation(async (_service: string, input: unknown) => {
      const url = String(input)
      // ensureActiveKey() dev-mode elo-teszt hivasa a primary kulcsra
      if (url.includes('q=test&type=video&maxResults=1')) {
        return fakeResponse({ items: [] })
      }
      if (url.includes('key=primary-key')) {
        return fakeResponse({ error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } })
      }
      if (url.includes('key=backup-key')) {
        return fakeResponse({
          items: [{ id: { videoId: 'v-backup' }, snippet: { title: 't', channelTitle: 'c', publishedAt: new Date().toISOString(), thumbnails: {} } }],
        })
      }
      return fakeResponse({ items: [] })
    })

    const ctx = createRequestBudgetContext()
    const items = await youtubeSearch('a-real-search-query', 'US', 'en', 30, 5, 'opportunityEngine', ctx)

    expect(items.length).toBe(1)
    expect(items[0].id.videoId).toBe('v-backup')
    // EGY logikai slot — a budget-erv. szempontjabol ez egyetlen keresesnek szamit
    expect(ctx.youtubeSearchCounts.opportunityEngine).toBe(1)
    // KETTO kulso HTTP-kiserlet — primary (quotaExceeded) + backup (siker)
    expect(ctx.externalAttempts).toBe(2)
    expect(ctx.backupKeyRetries).toBe(1)
  })

  it('the logical slot cap (5) is not bypassed by backup-key retries — 5 searches that each need a retry still only consume 5 slots', async () => {
    mockedFetchExternal.mockImplementation(async (_service: string, input: unknown) => {
      const url = String(input)
      if (url.includes('q=test&type=video&maxResults=1')) return fakeResponse({ items: [] })
      if (url.includes('key=primary-key')) return fakeResponse({ error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } })
      return fakeResponse({
        items: [{ id: { videoId: 'v-x' }, snippet: { title: 't', channelTitle: 'c', publishedAt: new Date().toISOString(), thumbnails: {} } }],
      })
    })

    const ctx = createRequestBudgetContext()
    for (let i = 0; i < 6; i++) {
      await youtubeSearch(`retry-query-${i}`, 'US', 'en', 30, 5, 'opportunityEngine', ctx)
    }
    expect(ctx.youtubeSearchCounts.opportunityEngine).toBe(5)
  })
})
