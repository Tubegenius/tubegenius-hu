import { describe, expect, it, vi } from 'vitest'
import { ExternalServiceTimeoutError, fetchExternal, requireOk } from '@/lib/external-fetch'

describe('external service boundary', () => {
  it('fails with a typed timeout instead of hanging a paid request', async () => {
    vi.useFakeTimers()
    const neverFetch = vi.fn((_input, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof fetch
    const pending = fetchExternal('YouTube', 'https://example.test', {}, 50, neverFetch)
    const assertion = expect(pending).rejects.toBeInstanceOf(ExternalServiceTimeoutError)
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    vi.useRealTimers()
  })
  it('preserves caller cancellation and rejects non-success status', async () => {
    await expect(requireOk(new Response('', { status: 429, headers: { 'retry-after': '10' } }), 'Serper'))
      .rejects.toThrow('Serper HTTP 429; retry-after=10')
  })
})
