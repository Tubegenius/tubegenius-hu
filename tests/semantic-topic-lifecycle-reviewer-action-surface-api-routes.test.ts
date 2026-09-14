// PFM Lifecycle Reviewer Action Surface v1 -- API route security/validation
// tests for the two new write routes (decision/cancel). Mirrors the
// established tests/human-review-admin-api-routes.test.ts and
// tests/semantic-topic-lifecycle-reviewer-read-surface-088-api-routes.test.ts
// idiom: dynamic import of the route's exported handler + a real Request,
// vi.mock on the underlying action-wrapper module (never a real DB call
// here -- that's the DB-integration test's job).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const getUserMock = vi.fn()
const adminClientMock = vi.fn(() => ({ __kind: 'admin-client-should-never-be-used-here' }))

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: getUserMock } }),
  createAdminClient: adminClientMock,
}))

const recordLifecycleDecision = vi.fn()
const cancelLifecycleReview = vi.fn()

vi.mock('@/lib/semantic-topic/lifecycle-review-actions', () => ({
  recordLifecycleDecision: (...args: unknown[]) => recordLifecycleDecision(...args),
  cancelLifecycleReview: (...args: unknown[]) => cancelLifecycleReview(...args),
}))

const FAKE_USER = { id: 'c5e4da64-7e23-4e56-9620-6cdcafb395d5' }
const FAKE_REQUEST_ID = 'd0000000-0000-4000-8000-000000000001'

// The Origin/CSRF guard runs before auth on both routes -- every test in
// this file (old and new) now needs a passing Origin by default so the
// pre-existing 25 tests keep exercising exactly what they did before this
// gate, while the guard itself is exercised for real (not mocked) in
// PRODUCTION mode, matching real runtime behavior. Origin-specific
// rejection scenarios explicitly override `origin` per-call below.
const TRUSTED_ORIGIN = 'https://tubegenius-hu.vercel.app'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NODE_ENV', 'production')
  process.env.NEXT_PUBLIC_APP_URL = TRUSTED_ORIGIN
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env.NEXT_PUBLIC_APP_URL
})

function unauth() {
  getUserMock.mockResolvedValue({ data: { user: null } })
}
function authed() {
  getUserMock.mockResolvedValue({ data: { user: FAKE_USER } })
}

const VALID_DECISION_BODY = {
  outcome: 'approved',
  reasonCode: 'identity_consistency_confirmed',
  reviewerRationale: 'Confirmed after review.',
  sameSemanticIdentityConfirmed: true,
  noMaterialIdentityConflict: true,
  canonicalDefinitionScopeFitConfirmed: true,
  provenanceRelationshipReviewed: true,
  reviewPolicyVersion: 1,
  idempotencyKey: 'client-key-1',
}

const VALID_CANCEL_BODY = {
  cancelReasonCode: 'REVIEW_WITHDRAWN',
  cancelRationale: 'Withdrawn by the requester.',
  idempotencyKey: 'client-key-2',
}

// origin: undefined -> default TRUSTED_ORIGIN (existing tests need no
// change); null -> omit the Origin header entirely; a string -> send that
// exact value. secFetchSite, when given, sets Sec-Fetch-Site.
type OriginOverrides = { origin?: string | null; secFetchSite?: string }

function buildHeaders(contentType: string, overrides: OriginOverrides): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': contentType }
  const origin = overrides.origin === undefined ? TRUSTED_ORIGIN : overrides.origin
  if (origin !== null) headers.origin = origin
  if (overrides.secFetchSite) headers['sec-fetch-site'] = overrides.secFetchSite
  return headers
}

async function callDecision(id: string, body: unknown, contentType = 'application/json', overrides: OriginOverrides = {}) {
  const { POST } = await import('@/app/api/admin/semantic-topic-lifecycle-reviews/[id]/decision/route')
  const init: RequestInit = { method: 'POST', headers: buildHeaders(contentType, overrides) }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  return POST(new Request(`http://localhost/api/admin/semantic-topic-lifecycle-reviews/${id}/decision`, init), { params: Promise.resolve({ id }) })
}
async function callCancel(id: string, body: unknown, contentType = 'application/json', overrides: OriginOverrides = {}) {
  const { POST } = await import('@/app/api/admin/semantic-topic-lifecycle-reviews/[id]/cancel/route')
  const init: RequestInit = { method: 'POST', headers: buildHeaders(contentType, overrides) }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  return POST(new Request(`http://localhost/api/admin/semantic-topic-lifecycle-reviews/${id}/cancel`, init), { params: Promise.resolve({ id }) })
}

describe('unauthenticated -> 401, wrapper never called', () => {
  it('decision', async () => {
    unauth()
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    expect(res.status).toBe(401)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('cancel', async () => {
    unauth()
    const res = await callCancel(FAKE_REQUEST_ID, VALID_CANCEL_BODY)
    expect(res.status).toBe(401)
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })
})

describe('malformed route id -> 422 before any body parsing or wrapper call', () => {
  it('decision', async () => {
    authed()
    const res = await callDecision('not-a-uuid', VALID_DECISION_BODY)
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('cancel', async () => {
    authed()
    const res = await callCancel('not-a-uuid', VALID_CANCEL_BODY)
    expect(res.status).toBe(422)
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })
})

describe('malformed JSON body -> 422 (Content-Type itself was valid, only the payload is broken)', () => {
  it('decision: invalid JSON', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, '{not valid json')
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('cancel: invalid JSON', async () => {
    authed()
    const res = await callCancel(FAKE_REQUEST_ID, '{not valid json')
    expect(res.status).toBe(422)
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })
})

describe('wrong content-type -> 415 (rejected by the origin/CSRF guard, before auth or readJsonBody ever run)', () => {
  it('decision: wrong content-type', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY, 'text/plain')
    expect(res.status).toBe(415)
    expect(getUserMock).not.toHaveBeenCalled()
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('cancel: wrong content-type', async () => {
    authed()
    const res = await callCancel(FAKE_REQUEST_ID, VALID_CANCEL_BODY, 'text/plain')
    expect(res.status).toBe(415)
    expect(getUserMock).not.toHaveBeenCalled()
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })
})

describe('unknown fields are rejected outright, never silently dropped', () => {
  it('decision: a forged reviewerUserId is rejected with 422, never forwarded', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, reviewerUserId: 'someone-elses-uuid' })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('decision: a forged topicId/fromStatus/targetStatus/snapshot/digest/expectedStatusVersion is rejected with 422', async () => {
    authed()
    for (const extra of [
      { topicId: 't-1' },
      { fromStatus: 'corroborating' },
      { targetStatus: 'coherent' },
      { snapshot: {} },
      { digest: 'abc' },
      { expectedStatusVersion: 1 },
      { actorId: 'x' },
    ]) {
      const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, ...extra })
      expect(res.status).toBe(422)
    }
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('cancel: an unexpected field is rejected with 422', async () => {
    authed()
    const res = await callCancel(FAKE_REQUEST_ID, { ...VALID_CANCEL_BODY, reviewerUserId: 'x' })
    expect(res.status).toBe(422)
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })
})

describe('decision field validation', () => {
  it('missing outcome -> 422', async () => {
    authed()
    const { outcome, ...rest } = VALID_DECISION_BODY
    const res = await callDecision(FAKE_REQUEST_ID, rest)
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('invalid outcome value -> 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, outcome: 'maybe' })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('invalid reasonCode -> 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, reasonCode: 'not_a_real_reason' })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('empty (after trim) reviewerRationale -> 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, reviewerRationale: '   ' })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('oversized reviewerRationale -> 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, reviewerRationale: 'x'.repeat(1001) })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('a non-boolean checklist field -> 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, sameSemanticIdentityConfirmed: 'true' })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('a null checklist field is accepted at the route layer (RPC decides if it is actually required)', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'success', result: { outcomeKind: 'rejected', reviewRequestId: FAKE_REQUEST_ID, status: 'rejected' } })
    const res = await callDecision(FAKE_REQUEST_ID, {
      ...VALID_DECISION_BODY,
      outcome: 'rejected',
      reasonCode: 'insufficient_evidence',
      sameSemanticIdentityConfirmed: null,
      noMaterialIdentityConflict: null,
      canonicalDefinitionScopeFitConfirmed: null,
      provenanceRelationshipReviewed: null,
    })
    expect(res.status).toBe(200)
  })
  it('unsupported reviewPolicyVersion -> 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, reviewPolicyVersion: 2 })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('non-integer reviewPolicyVersion -> 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, reviewPolicyVersion: 1.5 })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('missing idempotencyKey -> 422', async () => {
    authed()
    const { idempotencyKey, ...rest } = VALID_DECISION_BODY
    const res = await callDecision(FAKE_REQUEST_ID, rest)
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('oversized idempotencyKey -> 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, idempotencyKey: 'x'.repeat(201) })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
  it('empty-string idempotencyKey -> 422', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, idempotencyKey: '' })
    expect(res.status).toBe(422)
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })
})

describe('cancel field validation', () => {
  it('invalid cancelReasonCode -> 422', async () => {
    authed()
    const res = await callCancel(FAKE_REQUEST_ID, { ...VALID_CANCEL_BODY, cancelReasonCode: 'NOT_A_REAL_REASON' })
    expect(res.status).toBe(422)
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })
  it('empty (after trim) cancelRationale -> 422', async () => {
    authed()
    const res = await callCancel(FAKE_REQUEST_ID, { ...VALID_CANCEL_BODY, cancelRationale: '   ' })
    expect(res.status).toBe(422)
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })
  it('oversized cancelRationale -> 422', async () => {
    authed()
    const res = await callCancel(FAKE_REQUEST_ID, { ...VALID_CANCEL_BODY, cancelRationale: 'x'.repeat(1001) })
    expect(res.status).toBe(422)
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })
  it('missing idempotencyKey -> 422', async () => {
    authed()
    const { idempotencyKey, ...rest } = VALID_CANCEL_BODY
    const res = await callCancel(FAKE_REQUEST_ID, rest)
    expect(res.status).toBe(422)
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })
})

describe('success paths', () => {
  it('decision: 200, no-store, exact result passthrough, rationale is trimmed', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'success', result: { outcomeKind: 'approved', reviewRequestId: FAKE_REQUEST_ID, status: 'approved' } })
    const res = await callDecision(FAKE_REQUEST_ID, { ...VALID_DECISION_BODY, reviewerRationale: '  Confirmed after review.  ' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.result).toEqual({ outcomeKind: 'approved', reviewRequestId: FAKE_REQUEST_ID, status: 'approved' })
    const [, , input] = recordLifecycleDecision.mock.calls[0]
    expect(input.reviewerRationale).toBe('Confirmed after review.')
    expect(input.idempotencyKey).toBe('client-key-1')
  })

  it('cancel: 200, no-store, exact result passthrough', async () => {
    authed()
    cancelLifecycleReview.mockResolvedValue({ outcome: 'success', result: { outcomeKind: 'cancelled', reviewRequestId: FAKE_REQUEST_ID, status: 'cancelled' } })
    const res = await callCancel(FAKE_REQUEST_ID, VALID_CANCEL_BODY)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.result).toEqual({ outcomeKind: 'cancelled', reviewRequestId: FAKE_REQUEST_ID, status: 'cancelled' })
  })
})

describe('HTTP status mapping from wrapper outcomes', () => {
  it('not_a_reviewer -> 403', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'not_a_reviewer' })
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    expect(res.status).toBe(403)
  })
  it('not_found -> 404', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'not_found' })
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    expect(res.status).toBe(404)
  })
  it('expired -> 410', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'expired' })
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    expect(res.status).toBe(410)
  })
  it('conflict -> 409', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'conflict' })
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    expect(res.status).toBe(409)
  })
  it('not_decidable -> 409', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'not_decidable' })
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    expect(res.status).toBe(409)
  })
  it('not_cancellable -> 409', async () => {
    authed()
    cancelLifecycleReview.mockResolvedValue({ outcome: 'not_cancellable' })
    const res = await callCancel(FAKE_REQUEST_ID, VALID_CANCEL_BODY)
    expect(res.status).toBe(409)
  })
  it('validation_error (RPC-side) -> 422', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'validation_error', message: 'coherent approval requires all four structured checklist fields to be TRUE' })
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    expect(res.status).toBe(422)
  })
})

describe('raw DB-error redaction', () => {
  it('a database_error outcome never leaks the raw Postgres message/code/constraint name', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({
      outcome: 'database_error',
      operation: 'record_semantic_topic_lifecycle_review_decision',
      error: { code: '23514', message: 'new row for relation "semantic_topic_lifecycle_review_requests" violates check constraint "sltrr_coherent_checklist_required"' },
    })
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/23514|violates check constraint|sltrr_coherent_checklist_required/)
  })
  it('an invalid_rpc_response outcome maps to a generic 500', async () => {
    authed()
    cancelLifecycleReview.mockResolvedValue({ outcome: 'invalid_rpc_response', operation: 'cancel_semantic_topic_lifecycle_review_request' })
    const res = await callCancel(FAKE_REQUEST_ID, VALID_CANCEL_BODY)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/cancel_semantic_topic_lifecycle_review_request/)
  })
})

describe('service-role client is never used by either action route', () => {
  it('createAdminClient is never invoked across decision/cancel', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'success', result: { outcomeKind: 'approved', reviewRequestId: FAKE_REQUEST_ID, status: 'approved' } })
    cancelLifecycleReview.mockResolvedValue({ outcome: 'success', result: { outcomeKind: 'cancelled', reviewRequestId: FAKE_REQUEST_ID, status: 'cancelled' } })
    await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    await callCancel(FAKE_REQUEST_ID, VALID_CANCEL_BODY)
    expect(adminClientMock).not.toHaveBeenCalled()
  })
})

describe('static safety checks (source-level, no execution)', () => {
  const repoRoot = process.cwd()
  const routeFiles = ['app/api/admin/semantic-topic-lifecycle-reviews/[id]/decision/route.ts', 'app/api/admin/semantic-topic-lifecycle-reviews/[id]/cancel/route.ts']

  it('both routes declare force-dynamic', () => {
    for (const file of routeFiles) {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      expect(src, file).toMatch(/export const dynamic = 'force-dynamic'/)
    }
  })

  it('neither route imports createAdminClient or queries a lifecycle table directly', () => {
    for (const file of routeFiles) {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      expect(src, file).not.toMatch(/createAdminClient/)
      expect(src, file).not.toMatch(/from\(['"]semantic_topic_lifecycle_review_requests['"]\)/)
    }
  })

  it('neither route ever calls the executor or the create RPC (no lifecycle progression beyond decision/cancel)', () => {
    for (const file of routeFiles) {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      expect(src, file).not.toMatch(/execute_approved_semantic_topic_lifecycle_transition/)
      expect(src, file).not.toMatch(/create_semantic_topic_lifecycle_review_request/)
    }
  })

  it('the 088 read-surface routes and reader are byte-for-byte untouched by this gate (no accidental edit)', () => {
    // A pure existence + "still imports the same reader functions" smoke --
    // full behavioral regression is covered by re-running
    // semantic-topic-lifecycle-reviewer-read-surface-088-*.test.ts as part
    // of this gate's own verification step, not duplicated here.
    const listRouteSrc = readFileSync(join(repoRoot, 'app/api/admin/semantic-topic-lifecycle-reviews/route.ts'), 'utf8')
    const detailRouteSrc = readFileSync(join(repoRoot, 'app/api/admin/semantic-topic-lifecycle-reviews/[id]/route.ts'), 'utf8')
    expect(listRouteSrc).toMatch(/listLifecycleReviews/)
    expect(detailRouteSrc).toMatch(/getLifecycleReview/)
    expect(listRouteSrc).not.toMatch(/createAdminClient/)
    expect(detailRouteSrc).not.toMatch(/createAdminClient/)
  })

  it('both routes import checkOriginGuard/originGuardFailureToResponse from the same shared module', () => {
    for (const file of routeFiles) {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      expect(src, file).toMatch(/from '@\/lib\/http-origin-guard'/)
      expect(src, file).toMatch(/checkOriginGuard/)
    }
  })
})

describe('Origin/CSRF guard integration -- runs before auth and before any RPC call', () => {
  it('decision: correct production same-origin request reaches auth normally (implicit in every other test above; this makes it explicit)', async () => {
    authed()
    recordLifecycleDecision.mockResolvedValue({ outcome: 'success', result: { outcomeKind: 'approved', reviewRequestId: FAKE_REQUEST_ID, status: 'approved' } })
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY)
    expect(res.status).toBe(200)
    expect(getUserMock).toHaveBeenCalled()
  })

  it('decision: a foreign Origin -> 403, neither auth.getUser() nor the RPC wrapper is ever called', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY, 'application/json', { origin: 'https://attacker.example' })
    expect(res.status).toBe(403)
    expect(getUserMock).not.toHaveBeenCalled()
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })

  it('cancel: a foreign Origin -> 403, neither auth.getUser() nor the RPC wrapper is ever called', async () => {
    authed()
    const res = await callCancel(FAKE_REQUEST_ID, VALID_CANCEL_BODY, 'application/json', { origin: 'https://attacker.example' })
    expect(res.status).toBe(403)
    expect(getUserMock).not.toHaveBeenCalled()
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })

  it('decision: a missing Origin header -> 403 in production, auth/RPC never called', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY, 'application/json', { origin: null })
    expect(res.status).toBe(403)
    expect(getUserMock).not.toHaveBeenCalled()
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })

  it('cancel: a missing Origin header -> 403 in production, auth/RPC never called', async () => {
    authed()
    const res = await callCancel(FAKE_REQUEST_ID, VALID_CANCEL_BODY, 'application/json', { origin: null })
    expect(res.status).toBe(403)
    expect(getUserMock).not.toHaveBeenCalled()
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })

  it('decision: a subdomain-deception Origin -> 403 (no suffix matching at the route layer either)', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY, 'application/json', { origin: 'https://tubegenius-hu.vercel.app.attacker.tld' })
    expect(res.status).toBe(403)
    expect(getUserMock).not.toHaveBeenCalled()
  })

  it('decision: Sec-Fetch-Site: cross-site -> 403 even with a correct Origin, auth/RPC never called', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY, 'application/json', { secFetchSite: 'cross-site' })
    expect(res.status).toBe(403)
    expect(getUserMock).not.toHaveBeenCalled()
    expect(recordLifecycleDecision).not.toHaveBeenCalled()
  })

  it('cancel: Sec-Fetch-Site: cross-site -> 403 even with a correct Origin, auth/RPC never called', async () => {
    authed()
    const res = await callCancel(FAKE_REQUEST_ID, VALID_CANCEL_BODY, 'application/json', { secFetchSite: 'cross-site' })
    expect(res.status).toBe(403)
    expect(getUserMock).not.toHaveBeenCalled()
    expect(cancelLifecycleReview).not.toHaveBeenCalled()
  })

  it('a guard rejection response carries Cache-Control: no-store and never echoes the raw Origin value', async () => {
    authed()
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY, 'application/json', { origin: 'https://attacker.example' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/attacker/)
  })

  it('an unauthenticated request with a foreign Origin still gets the guard 403, not the auth 401 (guard runs strictly first)', async () => {
    unauth()
    const res = await callDecision(FAKE_REQUEST_ID, VALID_DECISION_BODY, 'application/json', { origin: 'https://attacker.example' })
    expect(res.status).toBe(403)
    expect(getUserMock).not.toHaveBeenCalled()
  })
})
