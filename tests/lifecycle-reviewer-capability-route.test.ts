// PFM Lifecycle Reviewer Self-Capability v1 -- API route tests for
// GET /api/admin/semantic-topic-lifecycle-reviews/capability. Mirrors the
// established tests/semantic-topic-lifecycle-reviewer-read-surface-088-api-routes.test.ts
// idiom: dynamic import of the route's exported handler, vi.mock on the
// underlying reader module -- never a real DB call here (that is the
// 089 DB-integration test's job).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUserMock = vi.fn()
const adminClientMock = vi.fn(() => ({ __kind: 'admin-client-should-never-be-used-here' }))

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: getUserMock }, __kind: 'session-client' }),
  createAdminClient: adminClientMock,
}))

const getLifecycleReviewerCapability = vi.fn()

vi.mock('@/lib/semantic-topic/lifecycle-reviewer-capability', async () => {
  const actual = await vi.importActual<typeof import('@/lib/semantic-topic/lifecycle-reviewer-capability')>(
    '@/lib/semantic-topic/lifecycle-reviewer-capability',
  )
  return {
    ...actual,
    getLifecycleReviewerCapability: (...args: unknown[]) => getLifecycleReviewerCapability(...args),
  }
})

const FAKE_USER = { id: 'c5e4da64-7e23-4e56-9620-6cdcafb395d5' }

beforeEach(() => {
  vi.clearAllMocks()
})

function unauth() {
  getUserMock.mockResolvedValue({ data: { user: null } })
}
function authed() {
  getUserMock.mockResolvedValue({ data: { user: FAKE_USER } })
}

async function callCapability() {
  const { GET } = await import('@/app/api/admin/semantic-topic-lifecycle-reviews/capability/route')
  return GET()
}

describe('unauthenticated -> 401, reader never called, admin client never constructed', () => {
  it('no session', async () => {
    unauth()
    const res = await callCapability()
    expect(res.status).toBe(401)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(getLifecycleReviewerCapability).not.toHaveBeenCalled()
    expect(adminClientMock).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body).toEqual({ error: expect.any(String) })
  })
})

describe('authenticated active reviewer -> 200 { canReviewSemanticTopicLifecycle: true }', () => {
  it('true', async () => {
    authed()
    getLifecycleReviewerCapability.mockResolvedValue({ outcome: 'success', canReviewSemanticTopicLifecycle: true })
    const res = await callCapability()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body).toEqual({ canReviewSemanticTopicLifecycle: true })
    expect(adminClientMock).not.toHaveBeenCalled()
  })
})

describe('authenticated inactive/non-reviewer -> 200 { canReviewSemanticTopicLifecycle: false }, same shape as the true case', () => {
  it('false', async () => {
    authed()
    getLifecycleReviewerCapability.mockResolvedValue({ outcome: 'success', canReviewSemanticTopicLifecycle: false })
    const res = await callCapability()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body).toEqual({ canReviewSemanticTopicLifecycle: false })
    expect(Object.keys(body)).toEqual(['canReviewSemanticTopicLifecycle'])
  })
})

describe('DB/RPC error -> redacted 500, NEVER silently answered as false', () => {
  it('database_error', async () => {
    authed()
    getLifecycleReviewerCapability.mockResolvedValue({
      outcome: 'database_error',
      operation: 'get_semantic_topic_lifecycle_reviewer_capability',
      error: { code: '08006', message: 'connection to server was lost' },
    })
    const res = await callCapability()
    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body).not.toEqual({ canReviewSemanticTopicLifecycle: false })
    expect(JSON.stringify(body)).not.toMatch(/08006|connection to server was lost/)
  })

  it('invalid_rpc_response', async () => {
    authed()
    getLifecycleReviewerCapability.mockResolvedValue({ outcome: 'invalid_rpc_response', operation: 'get_semantic_topic_lifecycle_reviewer_capability' })
    const res = await callCapability()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).not.toEqual({ canReviewSemanticTopicLifecycle: false })
  })
})

describe('response never carries any field besides canReviewSemanticTopicLifecycle -- no reviewer uuid/role/email/list', () => {
  it('success response shape is exactly one boolean field', async () => {
    authed()
    getLifecycleReviewerCapability.mockResolvedValue({ outcome: 'success', canReviewSemanticTopicLifecycle: true })
    const res = await callCapability()
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['canReviewSemanticTopicLifecycle'])
    expect(typeof body.canReviewSemanticTopicLifecycle).toBe('boolean')
  })
})

describe('route module source policy', () => {
  it('force-dynamic is set, and no service-role/admin client is ever referenced in the route source', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'app/api/admin/semantic-topic-lifecycle-reviews/capability/route.ts'), 'utf8')
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/)
    expect(src).not.toMatch(/createAdminClient/)
  })
})
