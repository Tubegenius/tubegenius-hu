// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, reviewer-
// session application wrapper.
//
// SECURITY BOUNDARY: every function here takes the CALLER'S OWN, request-
// bound user-session Supabase client (createServerSupabaseClient()'s return
// value) as a REQUIRED parameter -- there is no optional fallback to
// createAdminClient() anywhere in this file, unlike human-review-service.ts's
// admin() helper. auth.uid() inside the underlying 078 RPCs resolves from
// THIS client's own session; reviewer identity can never be a parameter this
// module passes in, matching the RPCs' own "no p_reviewer_user_id, no
// p_reviewer_role, no p_cancelled_by_user_id" contract exactly (see the
// Security and Concurrency Closure gate that removed cancel's old
// p_cancelled_by_user_id parameter for precisely this reason).
import {
  mapReviewRpcError,
  type ReviewOperationFailure,
  type ReviewRequestDetail,
  type ReviewRequestSummary,
  type SemanticTopicUserSessionClient,
  type StructuredDecisionInput,
} from './human-review-types'

export type ListPendingReviewsResult =
  | { outcome: 'success'; requests: ReviewRequestSummary[] }
  | ReviewOperationFailure

export interface ListPendingReviewsInput {
  limit?: number
  afterRequestedAt?: string | null
  afterId?: string | null
}

interface ListRpcRow {
  review_request_id: string
  generation: number
  requested_at: string
  expires_at: string
  extraction_run_id: string
  evidence: { evidence_id: string; title: string | null; external_ref: string | null; published_at: string | null; canonical_url: string | null }
  source: { source_type: string; source_family_key: string }
  candidate_label: string | null
  specificity: string | null
  content_format: string | null
  model_reported_confidence: string | null
  supporting_spans: unknown
}

function toSummary(row: ListRpcRow): ReviewRequestSummary {
  return {
    reviewRequestId: row.review_request_id,
    generation: row.generation,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    extractionRunId: row.extraction_run_id,
    evidence: {
      evidenceId: row.evidence.evidence_id,
      title: row.evidence.title,
      externalRef: row.evidence.external_ref,
      publishedAt: row.evidence.published_at,
      canonicalUrl: row.evidence.canonical_url,
    },
    source: { sourceType: row.source.source_type, sourceFamilyKey: row.source.source_family_key },
    candidateLabel: row.candidate_label,
    specificity: row.specificity,
    contentFormat: row.content_format,
    modelReportedConfidence: row.model_reported_confidence,
    supportingSpans: row.supporting_spans,
  }
}

export async function listPendingReviews(
  client: SemanticTopicUserSessionClient,
  input: ListPendingReviewsInput = {},
): Promise<ListPendingReviewsResult> {
  const { data, error } = await client.rpc('list_pending_topic_assignment_review_requests', {
    p_limit: input.limit ?? 20,
    p_after_requested_at: input.afterRequestedAt ?? null,
    p_after_id: input.afterId ?? null,
  })
  if (error) return mapReviewRpcError('list_pending_topic_assignment_review_requests', error)
  const body = data as { ok?: boolean; requests?: ListRpcRow[] } | null
  if (!body || body.ok !== true || !Array.isArray(body.requests)) {
    return { outcome: 'invalid_rpc_response', operation: 'list_pending_topic_assignment_review_requests' }
  }
  return { outcome: 'success', requests: body.requests.map(toSummary) }
}

export type GetReviewResult = { outcome: 'success'; request: ReviewRequestDetail } | ReviewOperationFailure

interface GetRpcRow extends ListRpcRow {
  status: string
  label_language: string | null
  subject_entities: unknown
  action_or_event: string | null
  location: string | null
  temporal_context: string | null
  decision: {
    decided_at: string
    canonical_topic_label: string | null
    topic_definition: string | null
    scope: string | null
    inclusion_criteria: string | null
    exclusion_criteria: string | null
    lane_neutral_confirmed: boolean | null
    evidence_adequacy: string | null
    duplicate_search_outcome: string | null
    proposed_outcome: string | null
    target_semantic_topic_id: string | null
    uncertainty_classification: string | null
    reviewer_rationale: string | null
    rejection_reason: string | null
  } | null
}

export async function getReview(client: SemanticTopicUserSessionClient, reviewRequestId: string): Promise<GetReviewResult> {
  const { data, error } = await client.rpc('get_topic_assignment_review_request', { p_review_request_id: reviewRequestId })
  if (error) return mapReviewRpcError('get_topic_assignment_review_request', error)
  const body = data as { ok?: boolean; request?: GetRpcRow } | null
  if (!body || body.ok !== true || !body.request) {
    return { outcome: 'invalid_rpc_response', operation: 'get_topic_assignment_review_request' }
  }
  const row = body.request
  return {
    outcome: 'success',
    request: {
      ...toSummary(row),
      status: row.status as ReviewRequestDetail['status'],
      labelLanguage: row.label_language,
      subjectEntities: row.subject_entities,
      actionOrEvent: row.action_or_event,
      location: row.location,
      temporalContext: row.temporal_context,
      decision: row.decision
        ? {
            decidedAt: row.decision.decided_at,
            canonicalTopicLabel: row.decision.canonical_topic_label,
            topicDefinition: row.decision.topic_definition,
            scope: row.decision.scope,
            inclusionCriteria: row.decision.inclusion_criteria,
            exclusionCriteria: row.decision.exclusion_criteria,
            laneNeutralConfirmed: row.decision.lane_neutral_confirmed,
            evidenceAdequacy: row.decision.evidence_adequacy,
            duplicateSearchOutcome: row.decision.duplicate_search_outcome,
            proposedOutcome: row.decision.proposed_outcome,
            targetSemanticTopicId: row.decision.target_semantic_topic_id,
            uncertaintyClassification: row.decision.uncertainty_classification,
            reviewerRationale: row.decision.reviewer_rationale,
            rejectionReason: row.decision.rejection_reason,
          }
        : null,
    },
  }
}

export type RecordDecisionResult =
  | { outcome: 'success'; result: 'approved' | 'rejected' | 'replayed'; reviewRequestId: string; approvalDigest?: string; resultingDecisionId?: string }
  | ReviewOperationFailure

// decisionIdempotencyKey is ALWAYS caller-supplied (never generated inside
// this wrapper) -- see human-review-types.ts header and the API route layer,
// which is what actually owns the Idempotency-Key header contract. A
// wrapper that minted its own key on every call would silently defeat retry
// safety for exactly the callers who need it most (a client retrying after
// a dropped connection).
export async function recordDecision(
  client: SemanticTopicUserSessionClient,
  reviewRequestId: string,
  decisionIdempotencyKey: string,
  decision: StructuredDecisionInput,
): Promise<RecordDecisionResult> {
  const params =
    decision.outcome === 'approved'
      ? {
          p_review_request_id: reviewRequestId,
          p_decision_idempotency_key: decisionIdempotencyKey,
          p_outcome: 'approved',
          p_canonical_topic_label: decision.canonicalTopicLabel,
          p_topic_definition: decision.topicDefinition,
          p_scope: decision.scope,
          p_inclusion_criteria: decision.inclusionCriteria,
          p_exclusion_criteria: decision.exclusionCriteria,
          p_lane_neutral_confirmed: decision.laneNeutralConfirmed,
          p_evidence_adequacy: decision.evidenceAdequacy,
          p_duplicate_search_outcome: decision.duplicateSearchOutcome,
          p_proposed_outcome: decision.proposedOutcome,
          p_target_semantic_topic_id: decision.targetSemanticTopicId,
          p_uncertainty_classification: decision.uncertaintyClassification,
          p_reviewer_rationale: decision.reviewerRationale,
          p_review_policy_version: decision.reviewPolicyVersion,
          p_rejection_reason: null,
        }
      : {
          p_review_request_id: reviewRequestId,
          p_decision_idempotency_key: decisionIdempotencyKey,
          p_outcome: 'rejected',
          p_canonical_topic_label: null,
          p_topic_definition: null,
          p_scope: null,
          p_inclusion_criteria: null,
          p_exclusion_criteria: null,
          p_lane_neutral_confirmed: null,
          p_evidence_adequacy: null,
          p_duplicate_search_outcome: null,
          p_proposed_outcome: null,
          p_target_semantic_topic_id: null,
          p_uncertainty_classification: null,
          p_reviewer_rationale: decision.reviewerRationale,
          p_review_policy_version: decision.reviewPolicyVersion,
          p_rejection_reason: decision.rejectionReason,
        }

  const { data, error } = await client.rpc('record_topic_assignment_review_decision', params)
  if (error) return mapReviewRpcError('record_topic_assignment_review_decision', error)
  const body = data as { ok?: boolean; outcome?: string; review_request_id?: string; approval_digest?: string; resulting_decision_id?: string } | null
  if (!body || body.ok !== true || !body.outcome || !body.review_request_id) {
    return { outcome: 'invalid_rpc_response', operation: 'record_topic_assignment_review_decision' }
  }
  return {
    outcome: 'success',
    result: body.outcome as 'approved' | 'rejected' | 'replayed',
    reviewRequestId: body.review_request_id,
    approvalDigest: body.approval_digest,
    resultingDecisionId: body.resulting_decision_id,
  }
}

export type CancelReviewResult = { outcome: 'success'; result: 'cancelled' | 'replayed'; reviewRequestId: string } | ReviewOperationFailure

export async function cancelReview(client: SemanticTopicUserSessionClient, reviewRequestId: string): Promise<CancelReviewResult> {
  const { data, error } = await client.rpc('cancel_topic_assignment_review_request', { p_review_request_id: reviewRequestId })
  if (error) return mapReviewRpcError('cancel_topic_assignment_review_request', error)
  const body = data as { ok?: boolean; outcome?: string; review_request_id?: string } | null
  if (!body || body.ok !== true || !body.outcome || !body.review_request_id) {
    return { outcome: 'invalid_rpc_response', operation: 'cancel_topic_assignment_review_request' }
  }
  return { outcome: 'success', result: body.outcome as 'cancelled' | 'replayed', reviewRequestId: body.review_request_id }
}

export type RevokeApprovalResult = { outcome: 'success'; result: 'revoked' | 'replayed'; reviewRequestId: string } | ReviewOperationFailure

export async function revokeApproval(client: SemanticTopicUserSessionClient, reviewRequestId: string): Promise<RevokeApprovalResult> {
  const { data, error } = await client.rpc('revoke_topic_assignment_review_approval', { p_review_request_id: reviewRequestId })
  if (error) return mapReviewRpcError('revoke_topic_assignment_review_approval', error)
  const body = data as { ok?: boolean; outcome?: string; review_request_id?: string } | null
  if (!body || body.ok !== true || !body.outcome || !body.review_request_id) {
    return { outcome: 'invalid_rpc_response', operation: 'revoke_topic_assignment_review_approval' }
  }
  return { outcome: 'success', result: body.outcome as 'revoked' | 'replayed', reviewRequestId: body.review_request_id }
}
