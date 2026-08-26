// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow,
// service-role-only application wrapper.
//
// SECURITY BOUNDARY: this module wraps the three 078 RPCs that require the
// service_role grant (create/expire/execute) -- record_topic_assignment_review_decision,
// cancel_topic_assignment_review_request, and revoke_topic_assignment_review_approval
// are deliberately NOT exported from here; they are `authenticated`-only at
// the database grant level (078 REVOKEs EXECUTE from service_role on all
// three), and their application-layer wrapper lives in
// human-review-reviewer.ts, which always uses the caller's own session
// client, never this module's admin client.
//
// This module must never be imported from anything under components/ or any
// 'use client' file -- it calls createAdminClient(), which reads
// SUPABASE_SERVICE_ROLE_KEY. Enforced at BUILD TIME (not just by
// convention) via `import 'server-only'` -- a LOCAL, network-free
// reimplementation of the official `server-only` npm package (that package
// is not present anywhere in this repo's dependency graph, and installing
// one from the network was out of scope for this gate; see
// docs/architecture/semantic-topic-identity-v0-contract.md SS34 for the
// exact rationale and the build-time proof this reproduction really works).
// A client-bundle import of this module now fails the Next.js build itself,
// not just a source-scan test.
import 'server-only'
import { createAdminClient } from '@/lib/supabase-server'
import { mapReviewRpcError, type ReviewOperationFailure, type SemanticTopicAdminClient } from './human-review-types'

function admin(client?: SemanticTopicAdminClient): SemanticTopicAdminClient {
  return client ?? createAdminClient()
}

export type CreateReviewRequestResult =
  | { outcome: 'success'; result: 'created' | 'replayed'; reviewRequestId: string; generation: number; status: string; expiresAt: string }
  | ReviewOperationFailure

// idempotencyKey is ALWAYS caller-supplied -- this wrapper never generates
// one internally. A retry of the SAME logical create attempt must pass the
// SAME key it used before; see human-review-extraction-hook.ts for the one
// caller in this codebase that derives a stable, deterministic key rather
// than a fresh random one per call.
export async function createReviewRequest(
  input: { extractionRunId: string; idempotencyKey: string },
  client?: SemanticTopicAdminClient,
): Promise<CreateReviewRequestResult> {
  const { data, error } = await admin(client).rpc('create_topic_assignment_review_request', {
    p_extraction_run_id: input.extractionRunId,
    p_idempotency_key: input.idempotencyKey,
  })
  if (error) return mapReviewRpcError('create_topic_assignment_review_request', error)
  const body = data as { ok?: boolean; outcome?: string; review_request_id?: string; generation?: number; status?: string; expires_at?: string } | null
  if (!body || body.ok !== true || !body.outcome || !body.review_request_id || typeof body.generation !== 'number' || !body.status || !body.expires_at) {
    return { outcome: 'invalid_rpc_response', operation: 'create_topic_assignment_review_request' }
  }
  return {
    outcome: 'success',
    result: body.outcome as 'created' | 'replayed',
    reviewRequestId: body.review_request_id,
    generation: body.generation,
    status: body.status,
    expiresAt: body.expires_at,
  }
}

export type ExpireStaleReviewRequestsResult = { outcome: 'success'; expiredCount: number; expiredIds: string[] } | ReviewOperationFailure

// batchLimit is always caller-supplied and expected to already be validated/
// fixed by the caller (the cron route in this codebase's case) -- this
// wrapper does not itself impose a default beyond what the RPC already
// clamps to [1,500].
export async function expireStaleReviewRequests(
  input: { batchLimit: number },
  client?: SemanticTopicAdminClient,
): Promise<ExpireStaleReviewRequestsResult> {
  const { data, error } = await admin(client).rpc('expire_stale_topic_assignment_review_requests', { p_batch_limit: input.batchLimit })
  if (error) return mapReviewRpcError('expire_stale_topic_assignment_review_requests', error)
  const body = data as { ok?: boolean; expired_count?: number; expired_ids?: string[] } | null
  if (!body || body.ok !== true || typeof body.expired_count !== 'number' || !Array.isArray(body.expired_ids)) {
    return { outcome: 'invalid_rpc_response', operation: 'expire_stale_topic_assignment_review_requests' }
  }
  return { outcome: 'success', expiredCount: body.expired_count, expiredIds: body.expired_ids }
}

export type ExecuteApprovedReviewResult =
  | {
      outcome: 'success'
      result: 'executed' | 'replayed'
      reviewRequestId: string
      proposedOutcome?: string
      semanticTopicId?: string
      resultingMembershipId?: string
      resultingDecisionId?: string
    }
  | ReviewOperationFailure

// Not called automatically by anything in this codebase in this phase (see
// human-review-extraction-hook.ts and the contract doc SS33) -- the first
// real execution remains a separately-gated, felügyelt (supervised) local/
// staging pilot, exactly like every other first-production-write gate in
// this whole rollout.
export async function executeApprovedReview(
  input: { reviewRequestId: string; idempotencyKey: string },
  client?: SemanticTopicAdminClient,
): Promise<ExecuteApprovedReviewResult> {
  const { data, error } = await admin(client).rpc('execute_approved_topic_assignment_review', {
    p_review_request_id: input.reviewRequestId,
    p_idempotency_key: input.idempotencyKey,
  })
  if (error) return mapReviewRpcError('execute_approved_topic_assignment_review', error)
  const body = data as {
    ok?: boolean
    outcome?: string
    review_request_id?: string
    proposed_outcome?: string
    semantic_topic_id?: string
    resulting_membership_id?: string
    resulting_decision_id?: string
  } | null
  if (!body || body.ok !== true || !body.outcome || !body.review_request_id) {
    return { outcome: 'invalid_rpc_response', operation: 'execute_approved_topic_assignment_review' }
  }
  return {
    outcome: 'success',
    result: body.outcome as 'executed' | 'replayed',
    reviewRequestId: body.review_request_id,
    proposedOutcome: body.proposed_outcome,
    semanticTopicId: body.semantic_topic_id,
    resultingMembershipId: body.resulting_membership_id,
    resultingDecisionId: body.resulting_decision_id,
  }
}
