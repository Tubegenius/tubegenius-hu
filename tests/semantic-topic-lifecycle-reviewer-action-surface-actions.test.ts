// PFM Lifecycle Reviewer Action Surface v1 -- lifecycle-review-actions.ts
// mapping tests (mocked client.rpc, no DB, no module mocking of the
// actions module itself -- this file exercises the REAL implementation).
// Kept in its own file, separate from the API-route tests, for the same
// reason as lifecycle-review-reader.test.ts: the route-level file mocks
// '@/lib/semantic-topic/lifecycle-review-actions', which -- being hoisted
// -- would otherwise shadow the real implementation tested here.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LifecycleCancelRequestBody, LifecycleDecisionRequestBody } from '@/lib/semantic-topic/lifecycle-review-types'

function fakeClient(data: unknown, error: unknown = null) {
  return { rpc: vi.fn(async () => ({ data, error })) }
}

const DECISION_INPUT: LifecycleDecisionRequestBody = {
  outcome: 'approved',
  reasonCode: 'identity_consistency_confirmed',
  reviewerRationale: 'Confirmed.',
  sameSemanticIdentityConfirmed: true,
  noMaterialIdentityConflict: true,
  canonicalDefinitionScopeFitConfirmed: true,
  provenanceRelationshipReviewed: true,
  reviewPolicyVersion: 1,
  idempotencyKey: 'k-1',
}

const CANCEL_INPUT: LifecycleCancelRequestBody = {
  cancelReasonCode: 'REVIEW_WITHDRAWN',
  cancelRationale: 'Withdrawn.',
  idempotencyKey: 'k-2',
}

describe('lifecycle-review-actions.ts -- RPC call shape and response mapping', () => {
  it('recordLifecycleDecision forwards every field to the exact expected p_* RPC parameter names', async () => {
    const { recordLifecycleDecision } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const client = fakeClient({ ok: true, outcomeKind: 'approved', reviewRequestId: 'r1', status: 'approved' })
    await recordLifecycleDecision(client as any, 'r1', DECISION_INPUT)
    expect(client.rpc).toHaveBeenCalledWith('record_semantic_topic_lifecycle_review_decision', {
      p_review_request_id: 'r1',
      p_decision_idempotency_key: 'k-1',
      p_outcome: 'approved',
      p_reason_code: 'identity_consistency_confirmed',
      p_reviewer_rationale: 'Confirmed.',
      p_same_semantic_identity_confirmed: true,
      p_no_material_identity_conflict: true,
      p_canonical_definition_scope_fit_confirmed: true,
      p_provenance_relationship_reviewed: true,
      p_review_policy_version: 1,
    })
  })

  it('recordLifecycleDecision maps a successful RPC response to outcome=success', async () => {
    const { recordLifecycleDecision } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const client = fakeClient({ ok: true, outcomeKind: 'approved', reviewRequestId: 'r1', status: 'approved' })
    const result = await recordLifecycleDecision(client as any, 'r1', DECISION_INPUT)
    expect(result).toEqual({ outcome: 'success', result: { outcomeKind: 'approved', reviewRequestId: 'r1', status: 'approved' } })
  })

  it('recordLifecycleDecision maps a normal {ok:false,reasonCode:REQUEST_EXPIRED} return to outcome=expired (not invalid_rpc_response)', async () => {
    const { recordLifecycleDecision } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const client = fakeClient({ ok: false, reasonCode: 'REQUEST_EXPIRED' })
    const result = await recordLifecycleDecision(client as any, 'r1', DECISION_INPUT)
    expect(result).toEqual({ outcome: 'expired' })
  })

  it('recordLifecycleDecision maps a malformed body (ok!=true and not the expired shape) to invalid_rpc_response', async () => {
    const { recordLifecycleDecision } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const client = fakeClient({ ok: true })
    const result = await recordLifecycleDecision(client as any, 'r1', DECISION_INPUT)
    expect(result).toEqual({ outcome: 'invalid_rpc_response', operation: 'record_semantic_topic_lifecycle_review_decision' })
  })

  it('recordLifecycleDecision maps RPC exceptions via mapLifecycleActionRpcError', async () => {
    const { recordLifecycleDecision } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const notReviewer = fakeClient(null, { message: 'record_semantic_topic_lifecycle_review_decision: caller is not an active reviewer' })
    expect(await recordLifecycleDecision(notReviewer as any, 'r1', DECISION_INPUT)).toEqual({ outcome: 'not_a_reviewer' })

    const notFound = fakeClient(null, { message: 'record_semantic_topic_lifecycle_review_decision: review_request r1 not found' })
    expect(await recordLifecycleDecision(notFound as any, 'r1', DECISION_INPUT)).toEqual({ outcome: 'not_found' })

    const notDecidable = fakeClient(null, { message: 'record_semantic_topic_lifecycle_review_decision: REVIEW_REQUEST_NOT_DECIDABLE -- status=cancelled' })
    expect(await recordLifecycleDecision(notDecidable as any, 'r1', DECISION_INPUT)).toEqual({ outcome: 'not_decidable' })

    const conflict = fakeClient(null, { message: 'record_semantic_topic_lifecycle_review_decision: review_request r1 already decided with different parameters' })
    expect(await recordLifecycleDecision(conflict as any, 'r1', DECISION_INPUT)).toEqual({ outcome: 'conflict' })

    const validation = fakeClient(null, { message: 'record_semantic_topic_lifecycle_review_decision: coherent approval requires all four structured checklist fields to be TRUE' })
    const validationResult = await recordLifecycleDecision(validation as any, 'r1', DECISION_INPUT)
    expect(validationResult.outcome).toBe('validation_error')

    const unauth = fakeClient(null, { message: 'record_semantic_topic_lifecycle_review_decision: authentication required' })
    expect(await recordLifecycleDecision(unauth as any, 'r1', DECISION_INPUT)).toEqual({ outcome: 'unauthenticated' })

    const genericDbError = fakeClient(null, { code: '42P01', message: 'relation does not exist' })
    const dbErrorResult = await recordLifecycleDecision(genericDbError as any, 'r1', DECISION_INPUT)
    expect(dbErrorResult.outcome).toBe('database_error')
  })

  it('cancelLifecycleReview forwards every field to the exact expected p_* RPC parameter names', async () => {
    const { cancelLifecycleReview } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const client = fakeClient({ ok: true, outcomeKind: 'cancelled', reviewRequestId: 'r1', status: 'cancelled' })
    await cancelLifecycleReview(client as any, 'r1', CANCEL_INPUT)
    expect(client.rpc).toHaveBeenCalledWith('cancel_semantic_topic_lifecycle_review_request', {
      p_review_request_id: 'r1',
      p_idempotency_key: 'k-2',
      p_cancel_reason_code: 'REVIEW_WITHDRAWN',
      p_cancel_rationale: 'Withdrawn.',
    })
  })

  it('cancelLifecycleReview maps a successful RPC response to outcome=success', async () => {
    const { cancelLifecycleReview } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const client = fakeClient({ ok: true, outcomeKind: 'cancelled', reviewRequestId: 'r1', status: 'cancelled' })
    const result = await cancelLifecycleReview(client as any, 'r1', CANCEL_INPUT)
    expect(result).toEqual({ outcome: 'success', result: { outcomeKind: 'cancelled', reviewRequestId: 'r1', status: 'cancelled' } })
  })

  it('cancelLifecycleReview maps the "idempotency_key already used with different parameters" exception to conflict', async () => {
    const { cancelLifecycleReview } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const client = fakeClient(null, { message: "cancel_semantic_topic_lifecycle_review_request: idempotency_key k-2 already used with different parameters" })
    expect(await cancelLifecycleReview(client as any, 'r1', CANCEL_INPUT)).toEqual({ outcome: 'conflict' })
  })

  it('cancelLifecycleReview maps REVIEW_REQUEST_NOT_CANCELLABLE to not_cancellable', async () => {
    const { cancelLifecycleReview } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const client = fakeClient(null, { message: 'cancel_semantic_topic_lifecycle_review_request: REVIEW_REQUEST_NOT_CANCELLABLE -- status=executed' })
    expect(await cancelLifecycleReview(client as any, 'r1', CANCEL_INPUT)).toEqual({ outcome: 'not_cancellable' })
  })

  it('cancelLifecycleReview maps a malformed body to invalid_rpc_response', async () => {
    const { cancelLifecycleReview } = await import('@/lib/semantic-topic/lifecycle-review-actions')
    const client = fakeClient({ ok: false })
    const result = await cancelLifecycleReview(client as any, 'r1', CANCEL_INPUT)
    expect(result).toEqual({ outcome: 'invalid_rpc_response', operation: 'cancel_semantic_topic_lifecycle_review_request' })
  })

  it('every RPC call in this file goes through the single call() boundary -- no scattered direct `.rpc(` call sites', () => {
    const src = readFileSync(join(process.cwd(), 'lib/semantic-topic/lifecycle-review-actions.ts'), 'utf8')
    const directRpcCallSites = src.match(/\w+\.rpc\(/g) ?? []
    expect(directRpcCallSites).toEqual(['client.rpc('])
  })

  it('this file never CALLS the executor or the create RPC (the header comment documents that fact by name, so comment lines are stripped before the check)', () => {
    const src = readFileSync(join(process.cwd(), 'lib/semantic-topic/lifecycle-review-actions.ts'), 'utf8')
    const codeOnly = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(codeOnly).not.toMatch(/execute_approved_semantic_topic_lifecycle_transition/)
    expect(codeOnly).not.toMatch(/create_semantic_topic_lifecycle_review_request/)
  })
})
