import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// lib/trend-radar.ts a SERPER_API_KEY-t modul-betoltodeskor olvassa be egy
// constba — ezert dinamikus import()-tal, a kornyezeti valtozo beallitasa
// UTAN toltjuk be.
vi.mock('@/lib/external-fetch', () => ({ fetchExternal: vi.fn() }))

let fetchSerperNews: typeof import('@/lib/trend-radar')['fetchSerperNews']
let getSerperHealthStatus: typeof import('@/lib/trend-radar')['getSerperHealthStatus']
let createRequestBudgetContext: typeof import('@/lib/youtube-service')['createRequestBudgetContext']

beforeAll(async () => {
  process.env.SERPER_API_KEY = 'test-serper-key'
  const trendRadar = await import('@/lib/trend-radar')
  const youtubeService = await import('@/lib/youtube-service')
  fetchSerperNews = trendRadar.fetchSerperNews
  getSerperHealthStatus = trendRadar.getSerperHealthStatus
  createRequestBudgetContext = youtubeService.createRequestBudgetContext
})

import { fetchExternal } from '@/lib/external-fetch'
const mockedFetchExternal = vi.mocked(fetchExternal)

function okResponse() {
  return { ok: true, status: 200, json: async () => ({ news: [{ title: 't', link: 'https://x.test/a', snippet: 's' }] }) } as unknown as Response
}
function failResponse() {
  return { ok: false, status: 500, json: async () => ({ message: 'serper down' }) } as unknown as Response
}

beforeEach(() => {
  mockedFetchExternal.mockReset()
})

describe('Serper health — request-scoped RequestBudgetContext (no more module-level state)', () => {
  it('five broad-discovery packs sharing one context aggregate their Serper attempts, not resetting per pack', async () => {
    mockedFetchExternal.mockResolvedValue(okResponse())
    const shared = createRequestBudgetContext()

    await Promise.all(Array.from({ length: 5 }, (_, p) => fetchSerperNews(`pack-${p}-query`, 'US', shared)))

    const health = getSerperHealthStatus(shared)
    expect(health.attempts).toBe(5)
    expect(health.failures).toBe(0)
    expect(health.unavailable).toBe(false)
    expect(health.state).toBe('available')
  })

  it('two concurrent requests (separate contexts) do not mix Serper health state', async () => {
    mockedFetchExternal.mockImplementation(async (_service: string, input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      return body.q === 'fails-everywhere' ? failResponse() : okResponse()
    })

    const ctxA = createRequestBudgetContext()
    const ctxB = createRequestBudgetContext()
    await Promise.all([
      fetchSerperNews('fails-everywhere', 'US', ctxA),
      fetchSerperNews('succeeds-fine', 'US', ctxB),
    ])

    expect(getSerperHealthStatus(ctxA)).toMatchObject({ attempts: 1, failures: 1, unavailable: true, state: 'unavailable' })
    expect(getSerperHealthStatus(ctxB)).toMatchObject({ attempts: 1, failures: 0, unavailable: false, state: 'available' })
  })

  it('one failing call plus another succeeding call in the SAME context aggregates correctly (partial outage is not automatically full unavailability)', async () => {
    let callCount = 0
    mockedFetchExternal.mockImplementation(async () => {
      callCount++
      return callCount === 1 ? failResponse() : okResponse()
    })

    const shared = createRequestBudgetContext()
    await fetchSerperNews('first-call-fails', 'US', shared)
    await fetchSerperNews('second-call-succeeds', 'US', shared)

    const health = getSerperHealthStatus(shared)
    expect(health.attempts).toBe(2)
    expect(health.failures).toBe(1)
    // Reszleges kieses — NEM az osszes hivas hibazott, tehat nem "unavailable"
    // (az uzleti szabaly, ami ezt "unavailable"=csak-akkor-ha-MINDEGYIK-
    // hibazott mintaval rogziti, valtozatlan maradt ebben a menetben).
    expect(health.unavailable).toBe(false)
    expect(health.state).toBe('partial_failure')
  })

  it('total outage (every attempt in the context fails) is correctly reported as unavailable', async () => {
    mockedFetchExternal.mockResolvedValue(failResponse())
    const shared = createRequestBudgetContext()

    await fetchSerperNews('q1', 'US', shared)
    await fetchSerperNews('q2', 'US', shared)
    await fetchSerperNews('q3', 'US', shared)

    const health = getSerperHealthStatus(shared)
    expect(health.attempts).toBe(3)
    expect(health.failures).toBe(3)
    expect(health.unavailable).toBe(true)
    expect(health.lastError).toBeTruthy()
    expect(health.state).toBe('unavailable')
  })

  it('a context with zero Serper attempts (key configured, just not tried yet) is reported as not_attempted, not unavailable', () => {
    const fresh = createRequestBudgetContext()
    expect(getSerperHealthStatus(fresh)).toEqual({ state: 'not_attempted', unavailable: false, attempts: 0, failures: 0, lastError: null })
  })
})
