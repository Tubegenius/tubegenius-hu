import { beforeEach, describe, expect, it, vi } from 'vitest'

// Kulon fajlban — NODE_ENV='development'-re allitjuk (ez kelleti a
// backup-key valtast, ld. switchToBackupKey() dev-only policy — ezt a
// menetben NEM valtoztatjuk), ami mas fajlok tesztjeit nem erintheti
// (vitest per-fajl izolacio).
vi.mock('@/lib/external-fetch', () => ({
  fetchExternal: vi.fn(),
}))

import { fetchExternal } from '@/lib/external-fetch'
import { youtubeSearch, createRequestBudgetContext, getQuotaState } from '@/lib/youtube-service'

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

describe('Worst-case concurrency: 5 parallel, uncached Opportunity searches sharing one context, all primary attempts quota-fail', () => {
  it('reserves 5 logical slots, makes 5 primary attempts, but only ONE backup retry — because usingBackupKey is a single global flag, not per-slot', async () => {
    let primaryAttempts = 0
    let backupAttempts = 0
    mockedFetchExternal.mockImplementation(async (_service: string, input: unknown) => {
      const url = String(input)
      // ensureActiveKey() dev-mode elo-teszt hivasa a primary kulcsra — ez a
      // valodi termelesi kodutvonal resze (egyszeri, folyamat-eleteben elso
      // youtubeSearch hivaskor fut le), de NEM logikai keresesi kiserlet:
      // valaszul egy "nincs hiba" alakot adunk, hogy ne befolyasolja a
      // switchToBackupKey donteset ezen az uton (a val6di kvota-hiba a tenyleges
      // kereses hivasokban jon).
      if (url.includes('q=test&type=video&maxResults=1')) {
        return fakeResponse({ items: [] })
      }
      if (url.includes('key=primary-key')) {
        primaryAttempts++
        return fakeResponse({ error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } })
      }
      if (url.includes('key=backup-key')) {
        backupAttempts++
        return fakeResponse({
          items: [{ id: { videoId: 'v-backup' }, snippet: { title: 't', channelTitle: 'c', publishedAt: new Date().toISOString(), thumbnails: {} } }],
        })
      }
      return fakeResponse({ items: [] })
    })

    const ctx = createRequestBudgetContext()
    // 5 KULONBOZO, nem cache-elt query, egyetlen kozos contexten, teljesen
    // lapos Promise.all-lal — ez a tenylegesen legrosszabb eset: mind az 5
    // slot egyszerre probal foglalni ES egyszerre kapja a kvota-hibat.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        youtubeSearch(`worst-case-query-${i}`, 'US', 'en', 30, 5, 'opportunityEngine', ctx)
      )
    )

    // 1) Logikai foglalasok — mind az 5 slot atment a budget-ellenorzesen
    //    (opportunityEngine budget = 5, tehat pontosan a keret betelik).
    expect(ctx.youtubeSearchCounts.opportunityEngine).toBe(5)

    // 2) Primary kulso kiserletek — MINDEN foglalt slot probal egy primary
    //    hivast, fuggetlenul attol, hogy a tobbi mar hibazott-e.
    expect(primaryAttempts).toBe(5)

    // 3) Backup retry — NEM 5, csak 1. A switchToBackupKey()/usingBackupKey
    //    egyetlen GLOBALIS (nem per-slot) flag: az elso hivas, amelyik a
    //    sajat primary kvota-hibajat feldolgozza, szinkron modon true-ra
    //    allitja — utana MINDEN tobbi hivas (fuggetlenul a tenyleges
    //    lefutasi sorrendtol, mivel JS egyszalu es a check+set atomikus)
    //    mar ugy latja, hogy usingBackupKey=true, es NEM probalkozik ujra.
    expect(backupAttempts).toBe(1)
    expect(ctx.backupKeyRetries).toBe(1)

    // 4) Osszes kulso kiserlet a contexten (a context nem szamolja bele az
    //    ensureActiveKey() elo-tesztjet, csak a logikai kereses/backup
    //    kiserleteket) — 5 primary + 1 backup = 6. EZ a dokumentalt maximum,
    //    NEM 10 (nem "minden slot kap sajat backup retry-t").
    expect(ctx.externalAttempts).toBe(6)

    // 5) A globalis kvota-allapot a backup kulcsra allt at.
    expect(getQuotaState().usingBackupKey).toBe(true)
  })
})
