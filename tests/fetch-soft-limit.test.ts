import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithDailySoftLimit } from '@/lib/client/fetch-with-daily-soft-limit'

afterEach(() => vi.unstubAllGlobals())
describe('daily soft limit client retry', () => {
  it('retries once with an explicit override header after confirmation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ requires_soft_limit_override: true, message: 'Limit' }), { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { confirm: vi.fn(() => true) })
    const result = await fetchWithDailySoftLimit('/api/test', { method: 'POST' })
    expect(result.status).toBe(200)
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('x-daily-soft-limit-override')).toBe('true')
  })
  it('does not retry when the user declines', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ requires_soft_limit_override: true }), { status: 429 }))
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('window', { confirm: vi.fn(() => false) })
    expect((await fetchWithDailySoftLimit('/api/test')).status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
