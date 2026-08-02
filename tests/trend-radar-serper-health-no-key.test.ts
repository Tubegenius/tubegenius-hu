import { beforeAll, describe, expect, it, vi } from 'vitest'

// Kulon fajlban — ez szandekosan NEM allitja be a SERPER_API_KEY-t, hogy a
// "hianyzo kulcs" allapotot a sajat, izolalt modul-peldanyaban tesztelje.
vi.mock('@/lib/external-fetch', () => ({ fetchExternal: vi.fn() }))

let fetchSerperNews: typeof import('@/lib/trend-radar')['fetchSerperNews']
let getSerperHealthStatus: typeof import('@/lib/trend-radar')['getSerperHealthStatus']
let createRequestBudgetContext: typeof import('@/lib/youtube-service')['createRequestBudgetContext']

beforeAll(async () => {
  delete process.env.SERPER_API_KEY
  const trendRadar = await import('@/lib/trend-radar')
  const youtubeService = await import('@/lib/youtube-service')
  fetchSerperNews = trendRadar.fetchSerperNews
  getSerperHealthStatus = trendRadar.getSerperHealthStatus
  createRequestBudgetContext = youtubeService.createRequestBudgetContext
})

describe('Serper health — documented behavior when SERPER_API_KEY is missing', () => {
  it('a missing key makes fetchSerperNews return empty results WITHOUT recording an attempt', async () => {
    const ctx = createRequestBudgetContext()
    const results = await fetchSerperNews('any query', 'US', ctx)

    expect(results).toEqual([])
    expect(ctx.serperAttempts).toBe(0)
    expect(ctx.serperFailures).toBe(0)
  })

  it('a missing key is reported as not_configured, distinct from a merely-not-yet-tried context — and is treated as unavailable so callers do not draw a false niche-quality conclusion', async () => {
    const ctx = createRequestBudgetContext()
    // Meg meg sem hivtuk a fetchSerperNews-t — a not_configured allapotnak
    // FUGGETLENNEK kell lennie az attempts szamlalotol, kizarolag a
    // kulcs hianyabol kell szarmaznia.
    const health = getSerperHealthStatus(ctx)

    expect(health.state).toBe('not_configured')
    // FONTOS viselkedesvaltas a korabbi verziohoz kepest: hianyzo kulcs
    // eseten a hivo (opportunity route) NE mutassa a "nincs eleg friss
    // trend" / "tul tag niche" uzenetet — ezert ez most unavailable:true.
    expect(health.unavailable).toBe(true)
    expect(health.attempts).toBe(0)
    expect(health.failures).toBe(0)
    expect(health.lastError).toBeNull()

    // Meg egy tenyleges (sikertelen, mert nincs kulcs) hivas utan is
    // not_configured marad, nem valtozik "unavailable"-re alapertelmezetten
    // mashogy szamolt attempts/failures miatt.
    await fetchSerperNews('any query', 'US', ctx)
    const healthAfter = getSerperHealthStatus(ctx)
    expect(healthAfter.state).toBe('not_configured')
    expect(healthAfter.attempts).toBe(0)
  })
})
