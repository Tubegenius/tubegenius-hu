// PFM Lifecycle Reviewer Read Surface v1 -- reviewer-session read wrapper.
//
// SECURITY BOUNDARY: both functions here take the CALLER'S OWN, request-
// bound user-session Supabase client (createServerSupabaseClient()'s
// return value) as a REQUIRED parameter -- there is no service-role
// fallback anywhere in this file, mirroring human-review-reviewer.ts's own
// header note exactly. auth.uid() inside the underlying 088 RPCs resolves
// from THIS client's own session; reviewer identity is never a parameter
// this module passes in.
//
// No generated Supabase Database types are version-controlled in this
// repo (confirmed during the 087 hardening gate) and there is no codegen
// script/CI step, so `.rpc()` calls to 088's RPC names are untyped by
// construction. The resulting `as any` is narrowed to this ONE call()
// helper -- every call site below goes through it, never its own inline
// cast.
import type {
  LifecycleCancelReasonCode,
  LifecycleEvidenceVector,
  LifecycleReadFailure,
  LifecycleReasonCode,
  LifecycleReviewDetail,
  LifecycleReviewListItem,
  LifecycleReviewUserSessionClient,
  LifecycleStatusFilter,
} from './lifecycle-review-types'
import { mapLifecycleReadRpcError } from './lifecycle-review-types'

async function call(client: any, fn: string, params: Record<string, unknown>): Promise<{ data: any; error: any }> {
  return client.rpc(fn, params)
}

export type ListLifecycleReviewsResult = { outcome: 'success'; requests: LifecycleReviewListItem[] } | LifecycleReadFailure

export interface ListLifecycleReviewsInput {
  statusFilter?: LifecycleStatusFilter
  limit?: number
  afterRequestedAt?: string | null
  afterId?: string | null
}

interface ListRpcRow {
  review_request_id: string
  generation: number
  semantic_topic_id: string
  topic_canonical_label: string
  from_status: string
  target_status: string
  request_status: string
  requested_at: string
  expires_at: string
  decided_at: string | null
  stale_reason_code: string | null
}

function toListItem(row: ListRpcRow): LifecycleReviewListItem {
  return {
    reviewRequestId: row.review_request_id,
    generation: row.generation,
    semanticTopicId: row.semantic_topic_id,
    topicCanonicalLabel: row.topic_canonical_label,
    fromStatus: row.from_status as LifecycleReviewListItem['fromStatus'],
    targetStatus: row.target_status as LifecycleReviewListItem['targetStatus'],
    requestStatus: row.request_status as LifecycleReviewListItem['requestStatus'],
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    staleReasonCode: row.stale_reason_code as LifecycleReviewListItem['staleReasonCode'],
  }
}

export async function listLifecycleReviews(
  client: LifecycleReviewUserSessionClient,
  input: ListLifecycleReviewsInput = {},
): Promise<ListLifecycleReviewsResult> {
  const { data, error } = await call(client, 'list_semantic_topic_lifecycle_review_requests', {
    p_status_filter: input.statusFilter ?? 'actionable',
    p_limit: input.limit ?? 20,
    p_after_requested_at: input.afterRequestedAt ?? null,
    p_after_id: input.afterId ?? null,
  })
  if (error) return mapLifecycleReadRpcError('list_semantic_topic_lifecycle_review_requests', error)
  const body = data as { ok?: boolean; requests?: ListRpcRow[] } | null
  if (!body || body.ok !== true || !Array.isArray(body.requests)) {
    return { outcome: 'invalid_rpc_response', operation: 'list_semantic_topic_lifecycle_review_requests' }
  }
  return { outcome: 'success', requests: body.requests.map(toListItem) }
}

export type GetLifecycleReviewResult = { outcome: 'success'; request: LifecycleReviewDetail } | LifecycleReadFailure

interface DetailRpcRow extends ListRpcRow {
  snapshot: {
    evidence_vector: LifecycleEvidenceVector
    digest: string
    captured_at: string
    from_lifecycle_status: string
    expected_status_version: number
  }
  review_policy_version: number
  decision: {
    reviewer_role_snapshot: string
    decided_at: string
    reason_code: string
    reviewer_rationale: string
    same_semantic_identity_confirmed: boolean | null
    no_material_identity_conflict: boolean | null
    canonical_definition_scope_fit_confirmed: boolean | null
    provenance_relationship_reviewed: boolean | null
    decided_by_current_reviewer: boolean
  } | null
  execution: { executed_at: string } | null
  cancellation: {
    cancelled_at: string
    cancel_reason_code: string
    cancel_rationale: string
    cancelled_by_current_reviewer: boolean
  } | null
  transition_history: { event_type: string; actor_kind: string; created_at: string }[]
  live: {
    lifecycle_status: string
    status_version: number
    evidence_vector: LifecycleEvidenceVector
    vector_digest: string
    mechanical_requirements_currently_met: boolean
  }
  staleness_signals: {
    topic_status_changed: boolean
    topic_version_changed: boolean
    evidence_vector_changed: boolean
    mechanical_requirements_lost: boolean
  }
  is_potentially_stale: boolean
}

function toDetail(row: DetailRpcRow): LifecycleReviewDetail {
  return {
    ...toListItem(row),
    snapshot: {
      evidenceVector: row.snapshot.evidence_vector,
      digest: row.snapshot.digest,
      capturedAt: row.snapshot.captured_at,
      fromLifecycleStatus: row.snapshot.from_lifecycle_status as LifecycleReviewDetail['snapshot']['fromLifecycleStatus'],
      expectedStatusVersion: row.snapshot.expected_status_version,
    },
    reviewPolicyVersion: row.review_policy_version,
    decision: row.decision
      ? {
          reviewerRoleSnapshot: row.decision.reviewer_role_snapshot,
          decidedAt: row.decision.decided_at,
          reasonCode: row.decision.reason_code as LifecycleReasonCode,
          reviewerRationale: row.decision.reviewer_rationale,
          sameSemanticIdentityConfirmed: row.decision.same_semantic_identity_confirmed,
          noMaterialIdentityConflict: row.decision.no_material_identity_conflict,
          canonicalDefinitionScopeFitConfirmed: row.decision.canonical_definition_scope_fit_confirmed,
          provenanceRelationshipReviewed: row.decision.provenance_relationship_reviewed,
          decidedByCurrentReviewer: row.decision.decided_by_current_reviewer,
        }
      : null,
    execution: row.execution ? { executedAt: row.execution.executed_at } : null,
    cancellation: row.cancellation
      ? {
          cancelledAt: row.cancellation.cancelled_at,
          cancelReasonCode: row.cancellation.cancel_reason_code as LifecycleCancelReasonCode,
          cancelRationale: row.cancellation.cancel_rationale,
          cancelledByCurrentReviewer: row.cancellation.cancelled_by_current_reviewer,
        }
      : null,
    transitionHistory: row.transition_history.map((e) => ({
      eventType: e.event_type as LifecycleReviewDetail['transitionHistory'][number]['eventType'],
      actorKind: e.actor_kind as LifecycleReviewDetail['transitionHistory'][number]['actorKind'],
      createdAt: e.created_at,
    })),
    live: {
      lifecycleStatus: row.live.lifecycle_status,
      statusVersion: row.live.status_version,
      evidenceVector: row.live.evidence_vector,
      vectorDigest: row.live.vector_digest,
      mechanicalRequirementsCurrentlyMet: row.live.mechanical_requirements_currently_met,
    },
    stalenessSignals: {
      topicStatusChanged: row.staleness_signals.topic_status_changed,
      topicVersionChanged: row.staleness_signals.topic_version_changed,
      evidenceVectorChanged: row.staleness_signals.evidence_vector_changed,
      mechanicalRequirementsLost: row.staleness_signals.mechanical_requirements_lost,
    },
    isPotentiallyStale: row.is_potentially_stale,
  }
}

export async function getLifecycleReview(
  client: LifecycleReviewUserSessionClient,
  reviewRequestId: string,
): Promise<GetLifecycleReviewResult> {
  const { data, error } = await call(client, 'get_semantic_topic_lifecycle_review_request', { p_review_request_id: reviewRequestId })
  if (error) return mapLifecycleReadRpcError('get_semantic_topic_lifecycle_review_request', error)
  const body = data as { ok?: boolean; reasonCode?: string; request?: DetailRpcRow } | null
  if (!body) return { outcome: 'invalid_rpc_response', operation: 'get_semantic_topic_lifecycle_review_request' }
  if (body.ok === false && body.reasonCode === 'NOT_FOUND') return { outcome: 'not_found' }
  if (body.ok !== true || !body.request) {
    return { outcome: 'invalid_rpc_response', operation: 'get_semantic_topic_lifecycle_review_request' }
  }
  return { outcome: 'success', request: toDetail(body.request) }
}
