// PFM Lifecycle Reviewer Read Surface v1 -- API route security/validation
// tests. Mirrors the established tests/human-review-admin-api-routes.test.ts
// idiom: dynamic import of the route's exported handler + a real
// NextRequest, vi.mock on the underlying reader module (never a real DB
// call here -- that's the 088 DB-integration test's job). Reader-level
// mapping tests live in the sibling
// semantic-topic-lifecycle-reviewer-read-surface-088-reader.test.ts file,
// kept separate because this file's vi.mock on lifecycle-review-reader.ts
// is hoisted and would otherwise shadow the real implementation.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const getUserMock = vi.fn()
const adminClientMock = vi.fn(() => ({ __kind: 'admin-client-should-never-be-used-here' }))

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: getUserMock } }),
  createAdminClient: adminClientMock,
}))

const listLifecycleReviews = vi.fn()
const getLifecycleReview = vi.fn()

vi.mock('@/lib/semantic-topic/lifecycle-review-reader', () => ({
  listLifecycleReviews: (...args: unknown[]) => listLifecycleReviews(...args),
  getLifecycleReview: (...args: unknown[]) => getLifecycleReview(...args),
}))

const FAKE_USER = { id: 'c5e4da64-7e23-4e56-9620-6cdcafb395d5' }
const FAKE_REQUEST_ID = 'd0000000-0000-4000-8000-000000000001'

beforeEach(() => {
  vi.clearAllMocks()
})

function unauth() {
  getUserMock.mockResolvedValue({ data: { user: null } })
}
function authed() {
  getUserMock.mockResolvedValue({ data: { user: FAKE_USER } })
}

async function callList(url = 'http://localhost/api/admin/semantic-topic-lifecycle-reviews') {
  const { GET } = await import('@/app/api/admin/semantic-topic-lifecycle-reviews/route')
  const { NextRequest } = await import('next/server')
  return GET(new NextRequest(url))
}
async function callGet(id: string) {
  const { GET } = await import('@/app/api/admin/semantic-topic-lifecycle-reviews/[id]/route')
  return GET(new Request(`http://localhost/api/admin/semantic-topic-lifecycle-reviews/${id}`), { params: Promise.resolve({ id }) })
}

describe('unauthenticated -> 401, reader never called', () => {
  it('list', async () => {
    unauth()
    const res = await callList()
    expect(res.status).toBe(401)
    expect(listLifecycleReviews).not.toHaveBeenCalled()
  })
  it('get', async () => {
    unauth()
    const res = await callGet(FAKE_REQUEST_ID)
    expect(res.status).toBe(401)
    expect(getLifecycleReview).not.toHaveBeenCalled()
  })
})

describe('authenticated non-reviewer -> 403 (RPC-derived, not app-side)', () => {
  it('list', async () => {
    authed()
    listLifecycleReviews.mockResolvedValue({ outcome: 'not_a_reviewer' })
    const res = await callList()
    expect(res.status).toBe(403)
  })
  it('get', async () => {
    authed()
    getLifecycleReview.mockResolvedValue({ outcome: 'not_a_reviewer' })
    const res = await callGet(FAKE_REQUEST_ID)
    expect(res.status).toBe(403)
  })
})

describe('list query-param validation (fails before the reader is ever called)', () => {
  it('an invalid status filter -> 422', async () => {
    authed()
    const res = await callList('http://localhost/api/admin/semantic-topic-lifecycle-reviews?status=not_a_real_status')
    expect(res.status).toBe(422)
    expect(listLifecycleReviews).not.toHaveBeenCalled()
  })
  it('a non-numeric limit -> 422', async () => {
    authed()
    const res = await callList('http://localhost/api/admin/semantic-topic-lifecycle-reviews?limit=abc')
    expect(res.status).toBe(422)
    expect(listLifecycleReviews).not.toHaveBeenCalled()
  })
  it('a zero limit -> 422', async () => {
    authed()
    const res = await callList('http://localhost/api/admin/semantic-topic-lifecycle-reviews?limit=0')
    expect(res.status).toBe(422)
    expect(listLifecycleReviews).not.toHaveBeenCalled()
  })
  it('an oversized limit is accepted and simply clamped downstream, not rejected here', async () => {
    authed()
    listLifecycleReviews.mockResolvedValue({ outcome: 'success', requests: [] })
    const res = await callList('http://localhost/api/admin/semantic-topic-lifecycle-reviews?limit=9999')
    expect(res.status).toBe(200)
    const [, arg] = listLifecycleReviews.mock.calls[0]
    expect(arg.limit).toBe(50)
  })
  it('a malformed after_id (not a uuid) -> 422', async () => {
    authed()
    const res = await callList('http://localhost/api/admin/semantic-topic-lifecycle-reviews?after_id=not-a-uuid&after_requested_at=2026-09-01T00:00:00Z')
    expect(res.status).toBe(422)
    expect(listLifecycleReviews).not.toHaveBeenCalled()
  })
  it('a malformed after_requested_at -> 422', async () => {
    authed()
    const res = await callList(`http://localhost/api/admin/semantic-topic-lifecycle-reviews?after_id=${FAKE_REQUEST_ID}&after_requested_at=not-a-date`)
    expect(res.status).toBe(422)
    expect(listLifecycleReviews).not.toHaveBeenCalled()
  })
  it('after_id without after_requested_at (unpaired cursor) -> 422', async () => {
    authed()
    const res = await callList(`http://localhost/api/admin/semantic-topic-lifecycle-reviews?after_id=${FAKE_REQUEST_ID}`)
    expect(res.status).toBe(422)
    expect(listLifecycleReviews).not.toHaveBeenCalled()
  })
  it('after_requested_at without after_id (unpaired cursor) -> 422', async () => {
    authed()
    const res = await callList('http://localhost/api/admin/semantic-topic-lifecycle-reviews?after_requested_at=2026-09-01T00:00:00Z')
    expect(res.status).toBe(422)
    expect(listLifecycleReviews).not.toHaveBeenCalled()
  })
  it('no query params at all succeeds with the reader defaults', async () => {
    authed()
    listLifecycleReviews.mockResolvedValue({ outcome: 'success', requests: [] })
    const res = await callList()
    expect(res.status).toBe(200)
    const [, arg] = listLifecycleReviews.mock.calls[0]
    expect(arg.statusFilter).toBe('actionable')
    expect(arg.limit).toBe(20)
  })
})

describe('list/get success', () => {
  it('list returns 200 with the wrapper payload and a no-store header', async () => {
    authed()
    listLifecycleReviews.mockResolvedValue({ outcome: 'success', requests: [{ reviewRequestId: FAKE_REQUEST_ID }] })
    const res = await callList()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.requests).toHaveLength(1)
  })
  it('get returns 200 for a valid uuid, with a no-store header', async () => {
    authed()
    getLifecycleReview.mockResolvedValue({ outcome: 'success', request: { reviewRequestId: FAKE_REQUEST_ID, requestStatus: 'requested' } })
    const res = await callGet(FAKE_REQUEST_ID)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
  it('get rejects a malformed id with 422 before ever calling the reader', async () => {
    authed()
    const res = await callGet('not-a-uuid')
    expect(res.status).toBe(422)
    expect(getLifecycleReview).not.toHaveBeenCalled()
  })
  it('get on an unknown id (RPC not_found) -> 404, never 410/409', async () => {
    authed()
    getLifecycleReview.mockResolvedValue({ outcome: 'not_found' })
    const res = await callGet(FAKE_REQUEST_ID)
    expect(res.status).toBe(404)
  })
  it('get on an expired/stale/rejected/executed request is a normal 200, never 410/409', async () => {
    authed()
    for (const requestStatus of ['expired', 'stale', 'rejected', 'executed', 'cancelled']) {
      getLifecycleReview.mockResolvedValue({ outcome: 'success', request: { reviewRequestId: FAKE_REQUEST_ID, requestStatus } })
      const res = await callGet(FAKE_REQUEST_ID)
      expect(res.status).toBe(200)
    }
  })
})

describe('DB error mapping never leaks raw detail', () => {
  it('a database_error outcome maps to a generic 500 body', async () => {
    authed()
    listLifecycleReviews.mockResolvedValue({ outcome: 'database_error', operation: 'list_semantic_topic_lifecycle_review_requests', error: { code: '42P01', message: 'relation does not exist' } })
    const res = await callList()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/42P01|relation does not exist/)
  })
  it('an invalid_rpc_response outcome maps to a generic 500 body', async () => {
    authed()
    getLifecycleReview.mockResolvedValue({ outcome: 'invalid_rpc_response', operation: 'get_semantic_topic_lifecycle_review_request' })
    const res = await callGet(FAKE_REQUEST_ID)
    expect(res.status).toBe(500)
  })
})

describe('service-role client is never used by either lifecycle-review route', () => {
  it('createAdminClient is never invoked across list/get', async () => {
    authed()
    listLifecycleReviews.mockResolvedValue({ outcome: 'success', requests: [] })
    getLifecycleReview.mockResolvedValue({ outcome: 'success', request: {} })
    await callList()
    await callGet(FAKE_REQUEST_ID)
    expect(adminClientMock).not.toHaveBeenCalled()
  })
})

describe('static safety checks (source-level, no execution)', () => {
  const repoRoot = process.cwd()

  it('both routes declare force-dynamic (never statically cacheable/prerenderable)', () => {
    for (const file of ['app/api/admin/semantic-topic-lifecycle-reviews/route.ts', 'app/api/admin/semantic-topic-lifecycle-reviews/[id]/route.ts']) {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      expect(src, file).toMatch(/export const dynamic = 'force-dynamic'/)
    }
  })

  it('neither route ever queries a lifecycle table directly or imports createAdminClient', () => {
    for (const file of ['app/api/admin/semantic-topic-lifecycle-reviews/route.ts', 'app/api/admin/semantic-topic-lifecycle-reviews/[id]/route.ts']) {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      expect(src, file).not.toMatch(/createAdminClient/)
      expect(src, file).not.toMatch(/from\(['"]semantic_topic_lifecycle_review_requests['"]\)/)
    }
  })

  it('the reader file never imports createAdminClient', () => {
    const src = readFileSync(join(repoRoot, 'lib/semantic-topic/lifecycle-review-reader.ts'), 'utf8')
    expect(src).not.toMatch(/createAdminClient/)
  })
})
