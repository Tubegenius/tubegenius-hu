// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, expire
// cron route tests. Mirrors tests/emerging-signal-collector-route.test.ts's
// exact idiom.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const expireStaleReviewRequests = vi.fn()
vi.mock('@/lib/semantic-topic/human-review-service', () => ({
  expireStaleReviewRequests: (...args: unknown[]) => expireStaleReviewRequests(...args),
}))

const isHumanReviewEnabled = vi.fn()
vi.mock('@/lib/semantic-topic/human-review-flag', () => ({
  isHumanReviewEnabled: () => isHumanReviewEnabled(),
}))

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET
})

async function call(secret?: string) {
  const { GET } = await import('@/app/api/cron/expire-semantic-topic-reviews/route')
  const { NextRequest } = await import('next/server')
  return GET(
    new NextRequest('http://localhost/api/cron/expire-semantic-topic-reviews', {
      headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` },
    }),
  )
}

describe('cron/expire-semantic-topic-reviews auth (fail-closed)', () => {
  it('missing CRON_SECRET config -> 503, RPC never called', async () => {
    delete process.env.CRON_SECRET
    const res = await call('anything')
    expect(res.status).toBe(503)
    expect(expireStaleReviewRequests).not.toHaveBeenCalled()
  })

  it('missing Authorization header -> 401, RPC never called', async () => {
    process.env.CRON_SECRET = 'test-secret'
    const res = await call(undefined)
    expect(res.status).toBe(401)
    expect(expireStaleReviewRequests).not.toHaveBeenCalled()
  })

  it('wrong secret -> 401, RPC never called', async () => {
    process.env.CRON_SECRET = 'test-secret'
    const res = await call('wrong-secret')
    expect(res.status).toBe(401)
    expect(expireStaleReviewRequests).not.toHaveBeenCalled()
  })
})

describe('cron/expire-semantic-topic-reviews feature-flag gating', () => {
  it('flag disabled (the default) -> 200 no-op, RPC never called', async () => {
    process.env.CRON_SECRET = 'test-secret'
    isHumanReviewEnabled.mockReturnValue(false)
    const res = await call('test-secret')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, skipped: true, reason: 'flag_disabled' })
    expect(expireStaleReviewRequests).not.toHaveBeenCalled()
  })

  it('flag enabled -> calls expireStaleReviewRequests with a fixed, non-caller-controllable batch limit', async () => {
    process.env.CRON_SECRET = 'test-secret'
    isHumanReviewEnabled.mockReturnValue(true)
    expireStaleReviewRequests.mockResolvedValue({ outcome: 'success', expiredCount: 3, expiredIds: ['a', 'b', 'c'] })
    const res = await call('test-secret')
    expect(res.status).toBe(200)
    expect(expireStaleReviewRequests).toHaveBeenCalledTimes(1)
    expect(expireStaleReviewRequests).toHaveBeenCalledWith({ batchLimit: 100 })
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, expiredCount: 3 })
  })

  it('an RPC failure surfaces as 500 without a raw DB error in the response', async () => {
    process.env.CRON_SECRET = 'test-secret'
    isHumanReviewEnabled.mockReturnValue(true)
    expireStaleReviewRequests.mockResolvedValue({ outcome: 'database_error', operation: 'expire_stale_topic_assignment_review_requests', error: { message: 'connection reset' } })
    const res = await call('test-secret')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/connection reset/)
  })
})
