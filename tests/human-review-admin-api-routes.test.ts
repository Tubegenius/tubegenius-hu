// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, reviewer
// admin API route security tests. Follows the established
// tests/emerging-signal-collector-route.test.ts idiom: dynamic import of the
// route's exported handler + a real NextRequest, vi.mock on the underlying
// lib modules (never a real DB call here -- that's the E2E test's job).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Pure Node.js recursive scan -- deliberately NOT shelling out to `grep`
// (execSync's default Windows shell has no grep binary, which would make a
// grep-based check vacuously pass by finding "no matches" only because the
// command itself failed, not because there truly are none).
function findFilesContaining(dir: string, needle: RegExp): string[] {
  const hits: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return hits
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue
      hits.push(...findFilesContaining(full, needle))
    } else if (stat.isFile() && (entry.endsWith('.ts') || entry.endsWith('.tsx'))) {
      const content = readFileSync(full, 'utf8')
      if (needle.test(content)) hits.push(full)
    }
  }
  return hits
}

const getUserMock = vi.fn()
const adminClientMock = vi.fn(() => ({ __kind: 'admin-client-should-never-be-used-here' }))

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: getUserMock } }),
  createAdminClient: adminClientMock,
}))

const listPendingReviews = vi.fn()
const getReview = vi.fn()
const recordDecision = vi.fn()
const cancelReview = vi.fn()
const revokeApproval = vi.fn()

vi.mock('@/lib/semantic-topic/human-review-reviewer', () => ({
  listPendingReviews: (...args: unknown[]) => listPendingReviews(...args),
  getReview: (...args: unknown[]) => getReview(...args),
  recordDecision: (...args: unknown[]) => recordDecision(...args),
  cancelReview: (...args: unknown[]) => cancelReview(...args),
  revokeApproval: (...args: unknown[]) => revokeApproval(...args),
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

async function callList(url = 'http://localhost/api/admin/semantic-topic-reviews') {
  const { GET } = await import('@/app/api/admin/semantic-topic-reviews/route')
  const { NextRequest } = await import('next/server')
  return GET(new NextRequest(url))
}
async function callGet(id: string) {
  const { GET } = await import('@/app/api/admin/semantic-topic-reviews/[id]/route')
  return GET(new Request(`http://localhost/api/admin/semantic-topic-reviews/${id}`), { params: Promise.resolve({ id }) })
}
async function callDecision(id: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': 'k-1' }) {
  const { POST } = await import('@/app/api/admin/semantic-topic-reviews/[id]/decision/route')
  return POST(new Request(`http://localhost/api/admin/semantic-topic-reviews/${id}/decision`, { method: 'POST', headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  })
}
async function callCancel(id: string) {
  const { POST } = await import('@/app/api/admin/semantic-topic-reviews/[id]/cancel/route')
  return POST(new Request(`http://localhost/api/admin/semantic-topic-reviews/${id}/cancel`, { method: 'POST' }), { params: Promise.resolve({ id }) })
}
async function callRevoke(id: string) {
  const { POST } = await import('@/app/api/admin/semantic-topic-reviews/[id]/revoke/route')
  return POST(new Request(`http://localhost/api/admin/semantic-topic-reviews/${id}/revoke`, { method: 'POST' }), { params: Promise.resolve({ id }) })
}

const APPROVED_BODY = {
  outcome: 'approved',
  canonicalTopicLabel: 'Test label',
  topicDefinition: 'Definition',
  scope: 'Scope',
  inclusionCriteria: 'Incl',
  exclusionCriteria: 'Excl',
  laneNeutralConfirmed: true,
  evidenceAdequacy: 'adequate',
  duplicateSearchOutcome: 'no_duplicate_found',
  proposedOutcome: 'CREATE_NEW',
  targetSemanticTopicId: null,
  uncertaintyClassification: 'low',
  reviewerRationale: 'Rationale',
  reviewPolicyVersion: 1,
}

describe('unauthenticated reviewer route -> 401, wrapper never called', () => {
  it('list', async () => {
    unauth()
    const res = await callList()
    expect(res.status).toBe(401)
    expect(listPendingReviews).not.toHaveBeenCalled()
  })
  it('get', async () => {
    unauth()
    const res = await callGet(FAKE_REQUEST_ID)
    expect(res.status).toBe(401)
    expect(getReview).not.toHaveBeenCalled()
  })
  it('decision', async () => {
    unauth()
    const res = await callDecision(FAKE_REQUEST_ID, APPROVED_BODY)
    expect(res.status).toBe(401)
    expect(recordDecision).not.toHaveBeenCalled()
  })
  it('cancel', async () => {
    unauth()
    const res = await callCancel(FAKE_REQUEST_ID)
    expect(res.status).toBe(401)
    expect(cancelReview).not.toHaveBeenCalled()
  })
  it('revoke', async () => {
    unauth()
    const res = await callRevoke(FAKE_REQUEST_ID)
    expect(res.status).toBe(401)
    expect(revokeApproval).not.toHaveBeenCalled()
  })
})

describe('authenticated non-reviewer -> 403 (RPC-derived, not app-side)', () => {
  it('list', async () => {
    authed()
    listPendingReviews.mockResolvedValue({ outcome: 'not_a_reviewer' })
    const res = await callList()
    expect(res.status).toBe(403)
  })
  it('decision', async () => {
    authed()
    recordDecision.mockResolvedValue({ outcome: 'not_a_reviewer' })
    const res = await callDecision(FAKE_REQUEST_ID, APPROVED_BODY)
    expect(res.status).toBe(403)
  })
})

describe('reviewer list/get success', () => {
  it('list returns 200 with the wrapper payload and a no-store header', async () => {
    authed()
    listPendingReviews.mockResolvedValue({ outcome: 'success', requests: [{ reviewRequestId: FAKE_REQUEST_ID }] })
    const res = await callList()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.requests).toHaveLength(1)
  })
  it('get returns 200 for a valid uuid', async () => {
    authed()
    getReview.mockResolvedValue({ outcome: 'success', request: { reviewRequestId: FAKE_REQUEST_ID, status: 'pending' } })
    const res = await callGet(FAKE_REQUEST_ID)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
  it('get rejects a malformed id with 422 before ever calling the wrapper', async () => {
    authed()
    const res = await callGet('not-a-uuid')
    expect(res.status).toBe(422)
    expect(getReview).not.toHaveBeenCalled()
  })
  it('unknown (RPC not_found) request -> 404', async () => {
    authed()
    getReview.mockResolvedValue({ outcome: 'not_found' })
    const res = await callGet(FAKE_REQUEST_ID)
    expect(res.status).toBe(404)
  })
})

describe('approve/reject validation', () => {
  it('rejects a missing outcome field with 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...APPROVED_BODY, outcome: undefined })
    expect(res.status).toBe(422)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('rejects an invalid outcome/target-topic combination: CREATE_NEW with a target', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...APPROVED_BODY, proposedOutcome: 'CREATE_NEW', targetSemanticTopicId: 'd0000000-0000-4000-8000-000000000002' })
    expect(res.status).toBe(422)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('rejects an invalid outcome/target-topic combination: ATTACH_EXISTING without a target', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...APPROVED_BODY, proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: null })
    expect(res.status).toBe(422)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('rejects too-long text fields before calling the RPC', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...APPROVED_BODY, canonicalTopicLabel: 'x'.repeat(201) })
    expect(res.status).toBe(422)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('rejects an unknown rejectionReason', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { outcome: 'rejected', rejectionReason: 'made_up_reason', reviewerRationale: 'x', reviewPolicyVersion: 1 })
    expect(res.status).toBe(422)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('a forged reviewerUserId field in the body is silently dropped -- never forwarded to the RPC call', async () => {
    authed()
    recordDecision.mockResolvedValue({ outcome: 'success', result: 'approved', reviewRequestId: FAKE_REQUEST_ID })
    await callDecision(FAKE_REQUEST_ID, { ...APPROVED_BODY, reviewerUserId: 'someone-elses-uuid', reviewer_user_id: 'someone-elses-uuid' })
    expect(recordDecision).toHaveBeenCalledTimes(1)
    const [, , , decisionArg] = recordDecision.mock.calls[0]
    expect(decisionArg).not.toHaveProperty('reviewerUserId')
    expect(decisionArg).not.toHaveProperty('reviewer_user_id')
  })
})

describe('idempotency key handling on the decision route', () => {
  it('missing Idempotency-Key -> 422, RPC never called', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, APPROVED_BODY, { 'content-type': 'application/json' })
    expect(res.status).toBe(422)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('an oversized Idempotency-Key is rejected', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, APPROVED_BODY, { 'content-type': 'application/json', 'idempotency-key': 'x'.repeat(300) })
    expect(res.status).toBe(422)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('a legitimate key is passed through unchanged to the RPC wrapper', async () => {
    authed()
    recordDecision.mockResolvedValue({ outcome: 'success', result: 'approved', reviewRequestId: FAKE_REQUEST_ID })
    await callDecision(FAKE_REQUEST_ID, APPROVED_BODY, { 'content-type': 'application/json', 'idempotency-key': 'client-retry-key-1' })
    const [, , keyArg] = recordDecision.mock.calls[0]
    expect(keyArg).toBe('client-retry-key-1')
  })

  it('IDEMPOTENCY_KEY_REUSE from the RPC maps to 409', async () => {
    authed()
    recordDecision.mockResolvedValue({ outcome: 'idempotency_key_reuse' })
    const res = await callDecision(FAKE_REQUEST_ID, APPROVED_BODY)
    expect(res.status).toBe(409)
  })
})

describe('content-type and body-size limits', () => {
  it('rejects a non-JSON content-type', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, APPROVED_BODY, { 'content-type': 'text/plain', 'idempotency-key': 'k' })
    expect(res.status).toBe(422)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('rejects an oversized body', async () => {
    authed()
    const { POST } = await import('@/app/api/admin/semantic-topic-reviews/[id]/decision/route')
    const oversized = { ...APPROVED_BODY, reviewerRationale: 'x'.repeat(30_000) }
    const res = await POST(
      new Request(`http://localhost/api/admin/semantic-topic-reviews/${FAKE_REQUEST_ID}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
        body: JSON.stringify(oversized),
      }),
      { params: Promise.resolve({ id: FAKE_REQUEST_ID }) },
    )
    expect(res.status).toBe(422)
    expect(recordDecision).not.toHaveBeenCalled()
  })
})

describe('DB error mapping never leaks raw detail', () => {
  it('a database_error outcome maps to a generic 500 body', async () => {
    authed()
    listPendingReviews.mockResolvedValue({ outcome: 'database_error', operation: 'list_pending_topic_assignment_review_requests', error: { code: '42P01', message: 'relation does not exist' } })
    const res = await callList()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/42P01|relation does not exist/)
  })

  it('an expired request maps to 410', async () => {
    authed()
    recordDecision.mockResolvedValue({ outcome: 'expired' })
    const res = await callDecision(FAKE_REQUEST_ID, APPROVED_BODY)
    expect(res.status).toBe(410)
  })

  it('a state conflict (already_decided) maps to 409', async () => {
    authed()
    recordDecision.mockResolvedValue({ outcome: 'already_decided' })
    const res = await callDecision(FAKE_REQUEST_ID, APPROVED_BODY)
    expect(res.status).toBe(409)
  })
})

describe('cancel/revoke: no forged identity, correct status mapping', () => {
  it('cancel never accepts a cancelledByUserId body field (route has no body parsing at all)', async () => {
    authed()
    cancelReview.mockResolvedValue({ outcome: 'success', result: 'cancelled', reviewRequestId: FAKE_REQUEST_ID })
    await callCancel(FAKE_REQUEST_ID)
    expect(cancelReview).toHaveBeenCalledWith(expect.anything(), FAKE_REQUEST_ID)
  })
  it('cancel not_cancellable -> 409', async () => {
    authed()
    cancelReview.mockResolvedValue({ outcome: 'not_cancellable' })
    const res = await callCancel(FAKE_REQUEST_ID)
    expect(res.status).toBe(409)
  })
  it('revoke not_revocable -> 409', async () => {
    authed()
    revokeApproval.mockResolvedValue({ outcome: 'not_revocable' })
    const res = await callRevoke(FAKE_REQUEST_ID)
    expect(res.status).toBe(409)
  })
})

describe('service-role client is never used by any reviewer route', () => {
  it('createAdminClient is never invoked across list/get/decision/cancel/revoke', async () => {
    authed()
    listPendingReviews.mockResolvedValue({ outcome: 'success', requests: [] })
    getReview.mockResolvedValue({ outcome: 'success', request: {} })
    recordDecision.mockResolvedValue({ outcome: 'success', result: 'approved', reviewRequestId: FAKE_REQUEST_ID })
    cancelReview.mockResolvedValue({ outcome: 'success', result: 'cancelled', reviewRequestId: FAKE_REQUEST_ID })
    revokeApproval.mockResolvedValue({ outcome: 'success', result: 'revoked', reviewRequestId: FAKE_REQUEST_ID })

    await callList()
    await callGet(FAKE_REQUEST_ID)
    await callDecision(FAKE_REQUEST_ID, APPROVED_BODY)
    await callCancel(FAKE_REQUEST_ID)
    await callRevoke(FAKE_REQUEST_ID)

    expect(adminClientMock).not.toHaveBeenCalled()
  })
})

describe('static safety checks (source-level, no execution)', () => {
  const repoRoot = process.cwd()

  it('human-review-service.ts is never imported from anything under components/', () => {
    // Mirrors this repo's existing convention check (no components/** file
    // imports createAdminClient today either) -- static scan, not a runtime
    // guarantee, since this codebase has no server-only package/ESLint rule.
    const hits = findFilesContaining(join(repoRoot, 'components'), /human-review-service/)
    expect(hits).toEqual([])
  })

  it('no app/api route imports createReviewRequest or executeApprovedReview (system RPCs stay entirely non-public in this phase; only expire is scheduler-reachable)', () => {
    const hits = findFilesContaining(join(repoRoot, 'app', 'api'), /createReviewRequest|executeApprovedReview/)
    expect(hits).toEqual([])
  })

  it('the decision/cancel/revoke routes never import createAdminClient directly', () => {
    for (const file of [
      'app/api/admin/semantic-topic-reviews/route.ts',
      'app/api/admin/semantic-topic-reviews/[id]/route.ts',
      'app/api/admin/semantic-topic-reviews/[id]/decision/route.ts',
      'app/api/admin/semantic-topic-reviews/[id]/cancel/route.ts',
      'app/api/admin/semantic-topic-reviews/[id]/revoke/route.ts',
    ]) {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      expect(src, file).not.toMatch(/createAdminClient/)
    }
  })
})
