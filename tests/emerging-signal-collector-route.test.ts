import { beforeEach, describe, expect, it, vi } from 'vitest'

const runSignalCollector = vi.fn()
const createYouTubeCollectorProviders = vi.fn(() => ({
  discovery: { search: vi.fn() },
  observation: { fetchVideoStats: vi.fn() },
}))

vi.mock('@/lib/emerging-signal/collection-orchestrator', () => ({ runSignalCollector }))
vi.mock('@/lib/emerging-signal/youtube-collector-provider', () => ({ createYouTubeCollectorProviders }))

async function call(secret?: string) {
  const { GET } = await import('@/app/api/cron/collect-signals/route')
  const { NextRequest } = await import('next/server')
  return GET(new NextRequest('http://localhost/api/cron/collect-signals', {
    headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` },
  }))
}

describe('Premium signal collector cron route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    delete process.env.YOUTUBE_API_KEY
  })

  it('returns 503 before DB/provider setup when CRON_SECRET is missing', async () => {
    const response = await call()
    expect(response.status).toBe(503)
    expect(runSignalCollector).not.toHaveBeenCalled()
    expect(createYouTubeCollectorProviders).not.toHaveBeenCalled()
  })

  it('returns 401 before DB/provider setup for an invalid bearer secret', async () => {
    process.env.CRON_SECRET = 'correct-secret'
    const response = await call('wrong-secret')
    expect(response.status).toBe(401)
    expect(runSignalCollector).not.toHaveBeenCalled()
    expect(createYouTubeCollectorProviders).not.toHaveBeenCalled()
  })

  it('maps a disabled or unavailable DB control to a neutral 200 skip', async () => {
    process.env.CRON_SECRET = 'correct-secret'
    process.env.YOUTUBE_API_KEY = 'youtube-key'
    runSignalCollector.mockResolvedValueOnce({ outcome: 'skipped', reason: 'disabled' })

    const response = await call('correct-secret')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, skipped: true, reason: 'collector_inactive' })
    expect(runSignalCollector).toHaveBeenCalledWith(expect.objectContaining({
      providerConfigured: true, softDeadlineMs: 240_000, minimumRemainingMs: 20_000,
    }))
  })

  it('fails closed with 503 when the enabled collector lacks YouTube configuration', async () => {
    process.env.CRON_SECRET = 'correct-secret'
    runSignalCollector.mockResolvedValueOnce({ outcome: 'failed', stage: 'provider_not_configured', runId: null })

    const response = await call('correct-secret')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ ok: false, error: 'Collector unavailable' })
    expect(runSignalCollector).toHaveBeenCalledWith(expect.objectContaining({ providerConfigured: false }))
  })

  it('returns a bounded successful summary without exposing credentials', async () => {
    process.env.CRON_SECRET = 'top-secret-value'
    process.env.YOUTUBE_API_KEY = 'youtube-key'
    runSignalCollector.mockResolvedValueOnce({
      outcome: 'partially_completed', runId: 'run-id', deadlineReached: true,
      providerQuotaExhausted: false, phases: [],
    })

    const response = await call('top-secret-value')
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, outcome: 'partially_completed', deadline_reached: true })
    expect(JSON.stringify(body)).not.toContain('top-secret-value')
    expect(JSON.stringify(body)).not.toContain('youtube-key')
  })
})
