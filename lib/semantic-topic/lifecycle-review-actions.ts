// PFM Lifecycle Reviewer Action Surface v1 -- reviewer-session write
// wrapper for 087's already-production decision/cancel RPCs.
//
// SECURITY BOUNDARY: both functions here take the CALLER'S OWN, request-
// bound user-session Supabase client (createServerSupabaseClient()'s
// return value) as a REQUIRED parameter -- there is no service-role
// fallback anywhere in this file, mirroring lifecycle-review-reader.ts's
// own header note and human-review-reviewer.ts's established pattern
// exactly. auth.uid() inside the underlying 087 RPCs resolves from THIS
// client's own session; reviewer identity is never a parameter this
// module passes in -- neither function accepts a reviewer/actor user id.
//
// This module calls ONLY the two already-production 087 write RPCs
// (record_semantic_topic_lifecycle_review_decision,
// cancel_semantic_topic_lifecycle_review_request). It never calls
// execute_approved_semantic_topic_lifecycle_transition (the executor) or
// create_semantic_topic_lifecycle_review_request -- those remain entirely
// out of this action surface's scope.
//
// No generated Supabase Database types are version-controlled in this
// repo (confirmed during the 087/088 gates) and there is no codegen
// script/CI step, so `.rpc()` calls to 087's RPC names are untyped by
// construction. The resulting `as any` is narrowed to this ONE call()
// helper -- every call site below goes through it, never its own inline
// cast (same rule as lifecycle-review-reader.ts).
import type {
  LifecycleActionFailure,
  LifecycleCancelActionResult,
  LifecycleCancelRequestBody,
  LifecycleDecisionActionResult,
  LifecycleDecisionRequestBody,
  LifecycleReviewUserSessionClient,
} from './lifecycle-review-types'
import { mapLifecycleActionRpcError } from './lifecycle-review-types'

async function call(client: any, fn: string, params: Record<string, unknown>): Promise<{ data: any; error: any }> {
  return client.rpc(fn, params)
}

export type RecordLifecycleDecisionResult = { outcome: 'success'; result: LifecycleDecisionActionResult } | LifecycleActionFailure

// decisionInput.idempotencyKey is ALWAYS caller-supplied (never generated
// inside this wrapper or the route) -- a wrapper that minted its own key on
// every call would silently defeat retry safety for exactly the caller
// that needs it most (a client retrying after a dropped connection).
export async function recordLifecycleDecision(
  client: LifecycleReviewUserSessionClient,
  reviewRequestId: string,
  input: LifecycleDecisionRequestBody,
): Promise<RecordLifecycleDecisionResult> {
  const { data, error } = await call(client, 'record_semantic_topic_lifecycle_review_decision', {
    p_review_request_id: reviewRequestId,
    p_decision_idempotency_key: input.idempotencyKey,
    p_outcome: input.outcome,
    p_reason_code: input.reasonCode,
    p_reviewer_rationale: input.reviewerRationale,
    p_same_semantic_identity_confirmed: input.sameSemanticIdentityConfirmed,
    p_no_material_identity_conflict: input.noMaterialIdentityConflict,
    p_canonical_definition_scope_fit_confirmed: input.canonicalDefinitionScopeFitConfirmed,
    p_provenance_relationship_reviewed: input.provenanceRelationshipReviewed,
    p_review_policy_version: input.reviewPolicyVersion,
  })
  if (error) return mapLifecycleActionRpcError('record_semantic_topic_lifecycle_review_decision', error)
  const body = data as { ok?: boolean; reasonCode?: string; outcomeKind?: string; reviewRequestId?: string; status?: string } | null
  if (!body) return { outcome: 'invalid_rpc_response', operation: 'record_semantic_topic_lifecycle_review_decision' }
  // REQUEST_EXPIRED is a normal {ok:false} return (persisted expiry), never
  // an exception -- checked BEFORE the generic invalid-response fallback,
  // matching getLifecycleReview's NOT_FOUND handling in
  // lifecycle-review-reader.ts.
  if (body.ok === false && body.reasonCode === 'REQUEST_EXPIRED') return { outcome: 'expired' }
  if (body.ok !== true || !body.outcomeKind || !body.reviewRequestId || !body.status) {
    return { outcome: 'invalid_rpc_response', operation: 'record_semantic_topic_lifecycle_review_decision' }
  }
  return {
    outcome: 'success',
    result: {
      outcomeKind: body.outcomeKind as LifecycleDecisionActionResult['outcomeKind'],
      reviewRequestId: body.reviewRequestId,
      status: body.status,
    },
  }
}

export type CancelLifecycleReviewResult = { outcome: 'success'; result: LifecycleCancelActionResult } | LifecycleActionFailure

export async function cancelLifecycleReview(
  client: LifecycleReviewUserSessionClient,
  reviewRequestId: string,
  input: LifecycleCancelRequestBody,
): Promise<CancelLifecycleReviewResult> {
  const { data, error } = await call(client, 'cancel_semantic_topic_lifecycle_review_request', {
    p_review_request_id: reviewRequestId,
    p_idempotency_key: input.idempotencyKey,
    p_cancel_reason_code: input.cancelReasonCode,
    p_cancel_rationale: input.cancelRationale,
  })
  if (error) return mapLifecycleActionRpcError('cancel_semantic_topic_lifecycle_review_request', error)
  const body = data as { ok?: boolean; outcomeKind?: string; reviewRequestId?: string; status?: string } | null
  if (!body || body.ok !== true || !body.outcomeKind || !body.reviewRequestId || !body.status) {
    return { outcome: 'invalid_rpc_response', operation: 'cancel_semantic_topic_lifecycle_review_request' }
  }
  return {
    outcome: 'success',
    result: {
      outcomeKind: body.outcomeKind as LifecycleCancelActionResult['outcomeKind'],
      reviewRequestId: body.reviewRequestId,
      status: body.status,
    },
  }
}
