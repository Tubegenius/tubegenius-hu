// PFM Lifecycle Reviewer Read Surface v1 -- shared types for the reviewer-
// session read wrapper (lifecycle-review-reader.ts) and the two API routes
// that call it. BACKEND-OWNED CONTRACT: the frontend (Codex/
// app/dashboard/semantic-topic-lifecycle-reviews/**) only ever IMPORTS
// from this file -- it must never be edited from that side of the work
// split (see docs/architecture/semantic-topic-identity-v0-contract.md's
// Lifecycle Reviewer Read Surface v1 design-gate section for the full
// rationale).
//
// Deliberately scoped to only what the two read-only 088 RPCs
// (list_semantic_topic_lifecycle_review_requests,
// get_semantic_topic_lifecycle_review_request) actually return -- this is
// NOT a mirror of the 087/088 schema. The RPCs themselves remain the sole
// source of truth for every business rule; this file only shapes their
// JSON responses for the TS side.
import type { SupabaseClient } from '@supabase/supabase-js'

// Same pattern as human-review-types.ts's SemanticTopicUserSessionClient --
// kept as the generic SupabaseClient interface so this module never has to
// import next/headers (which createServerSupabaseClient() pulls in
// transitively). Both 088 RPCs are authenticated-only: there is
// deliberately NO admin/service-role client type exported from this file.
export type LifecycleReviewUserSessionClient = SupabaseClient

// The seven closed request-lifecycle statuses (087's own
// sltrr_status_check CHECK constraint, unchanged by 088).
export type LifecycleRequestStatus = 'requested' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'executed' | 'stale'

// The three lifecycle_status values 087 v1 ever writes as a from/target
// pair (candidate_singleton/split_required/merge_candidate/superseded/
// archived have no v1 writer and never appear here).
export type LifecycleFromStatus = 'corroborating' | 'ambiguous'
export type LifecycleTargetStatus = 'coherent' | 'ambiguous' | 'corroborating'

// 088's own list-filter vocabulary (public.list_semantic_topic_lifecycle_review_requests's
// p_status_filter CASE branches) -- the 7 concrete statuses plus the two
// named composite sets. A value outside this set is INVALID_STATUS_FILTER.
export type LifecycleStatusFilter = LifecycleRequestStatus | 'actionable' | 'history'
export const LIFECYCLE_STATUS_FILTERS: readonly LifecycleStatusFilter[] = [
  'requested', 'approved', 'rejected', 'expired', 'cancelled', 'executed', 'stale', 'actionable', 'history',
]

export type LifecycleReasonCode =
  | 'identity_consistency_confirmed'
  | 'conflicting_identity_signal'
  | 'insufficient_context_for_confirmation'
  | 'suspicion_unfounded'
  | 'insufficient_evidence'
  | 'invalid_identity_claim'
  | 'not_ready_for_decision'
  | 'other_lifecycle_rejection'

// The full closed set 087's record_semantic_topic_lifecycle_review_decision
// draws p_reason_code from, across every outcome/target combination. The
// API route validates membership in this FULL set only -- which subset
// applies to a given request's (outcome, target_status) pair is a business
// rule the RPC alone decides (the route never learns target_status from the
// client, so it cannot and must not pre-narrow this list itself).
export const LIFECYCLE_REASON_CODES: readonly LifecycleReasonCode[] = [
  'identity_consistency_confirmed',
  'conflicting_identity_signal',
  'insufficient_context_for_confirmation',
  'suspicion_unfounded',
  'insufficient_evidence',
  'invalid_identity_claim',
  'not_ready_for_decision',
  'other_lifecycle_rejection',
]

export type LifecycleStaleReasonCode =
  | 'TOPIC_STATE_CHANGED'
  | 'TOPIC_VERSION_CHANGED'
  | 'EVIDENCE_VECTOR_CHANGED'
  | 'INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES'
  | 'EVIDENCE_IDENTITY_INCOMPLETE'
  | 'SOURCE_IDENTITY_UNKNOWN'
  | 'ASSIGNMENT_REASON_BREAKDOWN_INCOMPLETE'

export type LifecycleCancelReasonCode = 'REVIEW_WITHDRAWN' | 'NEW_EVIDENCE_REQUIRES_NEW_REVIEW' | 'REQUEST_CREATED_IN_ERROR'

export const LIFECYCLE_CANCEL_REASON_CODES: readonly LifecycleCancelReasonCode[] = [
  'REVIEW_WITHDRAWN',
  'NEW_EVIDENCE_REQUIRES_NEW_REVIEW',
  'REQUEST_CREATED_IN_ERROR',
]

// Mirrors 087's own v_supported_policy_version CONSTANT INTEGER := 1 inside
// both record_semantic_topic_lifecycle_review_decision and (implicitly, via
// the shared review-policy concept) the rest of the v1 lifecycle review
// framework. This is a fast-fail input check, not a second source of truth
// -- the RPC remains the sole authority and will reject any value this
// constant fails to catch; bump it only if a future migration widens the
// supported set, and only in lockstep with that migration.
export const LIFECYCLE_REVIEW_POLICY_VERSION = 1

// Mirrors 087's reviewer_rationale/cancel_rationale CHECK (length BETWEEN 1
// AND 1000) exactly -- validated here purely so a caller gets a fast, clear
// 422 instead of a raw DB constraint-violation message.
export const LIFECYCLE_RATIONALE_MAX_LENGTH = 1000

// No DB-side length limit exists on the idempotency key columns beyond
// TEXT -- this ceiling is an API-layer defensive limit only, matching the
// established MAX_IDEMPOTENCY_KEY_LENGTH convention already used by the
// 077/078 decision route's Idempotency-Key header.
export const LIFECYCLE_IDEMPOTENCY_KEY_MAX_LENGTH = 200

// Mirrors compute_topic_evidence_vector()'s (086) own JSONB shape exactly
// -- every field here is an aggregate count/boolean/diagnostic, never a
// raw source identity, external_ref, or channel ID. Kept as a single
// shared shape for both the immutable snapshot and the live comparison,
// since both are literally the same RPC's output captured at different
// times.
export interface LifecycleEvidenceVector {
  ok: boolean
  formulaVersion: string
  semanticTopicId: string
  lifecycleStatus: string
  activeMembershipCount: number
  eligibleMembershipCount: number
  syndicationExcludedCount: number
  eligibleDistinctSourceIdentityCount: number
  unknownSourceCount: number
  manualReviewConfirmedSourceCount: number
  manualReviewOverrideSourceCount: number
  automatedAssignmentSourceCount: number
  topicCreationSeedSourceCount: number
  assignmentReasonBreakdownComplete: boolean
  unclassifiedAssignmentReasonEligibleMembershipCount: number
  mixedAlgorithmVersions: boolean
  byAlgorithmVersion: unknown
  confidenceDiagnostics: { min: number | null; max: number | null; count: number }
  evidenceIdentityComplete: boolean
  sourceIdentityKnown: boolean
  inputIntegrityStatus: string
}

// ── List (small, paginated) ────────────────────────────────────────────
export interface LifecycleReviewListItem {
  reviewRequestId: string
  generation: number
  semanticTopicId: string
  topicCanonicalLabel: string
  fromStatus: LifecycleFromStatus
  targetStatus: LifecycleTargetStatus
  requestStatus: LifecycleRequestStatus
  requestedAt: string
  expiresAt: string
  decidedAt: string | null
  staleReasonCode: LifecycleStaleReasonCode | null
}

export interface LifecyclePaginationCursor {
  afterRequestedAt: string | null
  afterId: string | null
}

// ── Detail (full, redacted, one request) ───────────────────────────────
export interface LifecycleReviewSnapshot {
  evidenceVector: LifecycleEvidenceVector
  digest: string
  capturedAt: string
  fromLifecycleStatus: LifecycleFromStatus
  expectedStatusVersion: number
}

export interface LifecycleReviewDecision {
  reviewerRoleSnapshot: string
  decidedAt: string
  reasonCode: LifecycleReasonCode
  reviewerRationale: string
  sameSemanticIdentityConfirmed: boolean | null
  noMaterialIdentityConflict: boolean | null
  canonicalDefinitionScopeFitConfirmed: boolean | null
  provenanceRelationshipReviewed: boolean | null
  // Server-computed from auth.uid() inside the RPC -- the raw reviewer
  // user UUID is deliberately never sent to the client (see 088's design
  // gate item 5: "Adatminimalizálás").
  decidedByCurrentReviewer: boolean
}

export interface LifecycleReviewExecution {
  executedAt: string
  // transitionEventId is deliberately NOT included -- an internal audit
  // primary key with no reviewer-facing purpose.
}

export interface LifecycleReviewCancellation {
  cancelledAt: string
  cancelReasonCode: LifecycleCancelReasonCode
  cancelRationale: string
  cancelledByCurrentReviewer: boolean
}

// Append-only audit trail, redacted to the closed event vocabulary only --
// never a raw event id or actor UUID.
export interface LifecycleTransitionAuditEntry {
  eventType: 'requested' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'executed' | 'stale'
  actorKind: 'service_role_system' | 'authenticated_reviewer'
  createdAt: string
}

// Live topic/vector state -- DIAGNOSTIC ONLY. Never conflate with
// `snapshot` above: snapshot is what was frozen at request-creation time,
// `live` is fetched fresh on every detail read and can differ from one
// call to the next. See `isPotentiallyStale` below.
export interface LifecycleLiveState {
  lifecycleStatus: string
  statusVersion: number
  evidenceVector: LifecycleEvidenceVector
  vectorDigest: string
  mechanicalRequirementsCurrentlyMet: boolean
}

// The individual signals isPotentiallyStale is OR-ed from -- exposed
// separately so the UI can explain WHY a request looks stale, not just
// THAT it does.
export interface LifecycleStalenessSignals {
  topicStatusChanged: boolean
  topicVersionChanged: boolean
  evidenceVectorChanged: boolean
  mechanicalRequirementsLost: boolean
}

export interface LifecycleReviewDetail extends LifecycleReviewListItem {
  snapshot: LifecycleReviewSnapshot
  reviewPolicyVersion: number
  decision: LifecycleReviewDecision | null
  execution: LifecycleReviewExecution | null
  cancellation: LifecycleReviewCancellation | null
  transitionHistory: LifecycleTransitionAuditEntry[]
  live: LifecycleLiveState
  stalenessSignals: LifecycleStalenessSignals
  // UI-WARNING ONLY -- never authoritative. The one and only binding
  // stale determination happens inside 087's own
  // execute_approved_semantic_topic_lifecycle_transition at execution
  // time; this field exists purely so the reviewer UI can show a caveat
  // banner, never to gate or skip any action itself.
  isPotentiallyStale: boolean
}

// ── Error envelope ──────────────────────────────────────────────────────
// Mirrors human-review-types.ts's ReviewOperationFailure/mapReviewRpcError
// pattern, narrowed to the outcomes the two READ RPCs can actually
// produce (no decision/cancel/execution state-transition failures exist
// on a read path).
export type LifecycleReadFailure =
  | { outcome: 'unauthenticated' }
  | { outcome: 'not_a_reviewer' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid_status_filter'; message: string }
  | { outcome: 'validation_error'; message: string }
  | { outcome: 'database_error'; operation: string; error: LifecycleDatabaseErrorShape }
  | { outcome: 'invalid_rpc_response'; operation: string }

export interface LifecycleDatabaseErrorShape {
  code?: string
  message: string
  details?: string
  hint?: string
}

export function toLifecycleDatabaseErrorShape(error: unknown): LifecycleDatabaseErrorShape {
  if (error && typeof error === 'object') {
    const source = error as Record<string, unknown>
    return {
      code: typeof source.code === 'string' ? source.code : undefined,
      message: typeof source.message === 'string' ? source.message : 'Unknown database error',
      details: typeof source.details === 'string' ? source.details : undefined,
      hint: typeof source.hint === 'string' ? source.hint : undefined,
    }
  }
  return { message: error instanceof Error ? error.message : String(error) }
}

// Both 088 RPCs signal auth/reviewer/filter failures via a plain RAISE
// EXCEPTION with a recognizable message (088's own convention, mirroring
// 077/078/087) -- this maps that text, in priority order, to the closed
// LifecycleReadFailure vocabulary. "not found" is NOT handled here: both
// RPCs return it as a normal {ok:false, reasonCode:'NOT_FOUND'} JSONB
// body (never an exception), parsed directly by the reader.
export function mapLifecycleReadRpcError(operation: string, error: unknown): LifecycleReadFailure {
  const shaped = toLifecycleDatabaseErrorShape(error)
  const message = shaped.message

  if (/permission denied/i.test(message)) return { outcome: 'not_a_reviewer' }
  if (/caller is not an active reviewer/.test(message)) return { outcome: 'not_a_reviewer' }
  if (/authentication required/.test(message)) return { outcome: 'unauthenticated' }
  if (/INVALID_STATUS_FILTER/.test(message)) return { outcome: 'invalid_status_filter', message }
  return { outcome: 'database_error', operation, error: shaped }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

// ── Lifecycle Reviewer Action Surface v1 (decision + cancel) ──────────────
// BACKEND-OWNED CONTRACT, same rule as the read surface above: the frontend
// only ever IMPORTS from this file. Both shapes below are the EXACT, closed
// field set a caller may send -- deliberately flat (not a discriminated
// union keyed by outcome) because 087's own
// record_semantic_topic_lifecycle_review_decision RPC takes a single flat
// parameter list for both approved and rejected, and which reason codes /
// checklist fields are actually REQUIRED for a given (outcome, target)
// pair is a business rule the RPC alone decides -- the route never learns
// target_status from the client (see 088's LifecycleReviewListItem/
// LifecycleReviewDetail: target status lives only in the already-created,
// immutable request, never accepted as an action input). The four
// checklist booleans are always optional/nullable here for the same
// reason: enforcement of "all four required for a coherent approval"
// happens exclusively inside the RPC.
export interface LifecycleDecisionRequestBody {
  outcome: 'approved' | 'rejected'
  reasonCode: LifecycleReasonCode
  reviewerRationale: string
  sameSemanticIdentityConfirmed: boolean | null
  noMaterialIdentityConflict: boolean | null
  canonicalDefinitionScopeFitConfirmed: boolean | null
  provenanceRelationshipReviewed: boolean | null
  reviewPolicyVersion: number
  idempotencyKey: string
}

export interface LifecycleCancelRequestBody {
  cancelReasonCode: LifecycleCancelReasonCode
  cancelRationale: string
  idempotencyKey: string
}

export interface LifecycleDecisionActionResult {
  outcomeKind: 'approved' | 'rejected' | 'replayed'
  reviewRequestId: string
  status: string
}

export interface LifecycleCancelActionResult {
  outcomeKind: 'cancelled' | 'replayed'
  reviewRequestId: string
  status: string
}

// Closed outcome vocabulary for the two WRITE RPCs only -- deliberately a
// separate type from LifecycleReadFailure above (the read RPCs can never
// produce expired/not_decidable/not_cancellable/conflict, and the action
// RPCs never produce invalid_status_filter). Mirrors the established
// ReviewOperationFailure/reviewFailureToResponse split pattern in
// human-review-types.ts/human-review-http-mapping.ts, narrowed to exactly
// what 087's decision/cancel RPCs can raise.
export type LifecycleActionFailure =
  | { outcome: 'unauthenticated' }
  | { outcome: 'not_a_reviewer' }
  | { outcome: 'not_found' }
  // REQUEST_EXPIRED is a normal {ok:false,reasonCode} RETURN from the
  // decision RPC (persisted expiry, never an exception) -- parsed directly
  // by the action wrapper, listed here purely as the outcome it maps to.
  | { outcome: 'expired' }
  | { outcome: 'not_decidable' }
  | { outcome: 'not_cancellable' }
  // Covers BOTH "review_request % already decided with different
  // parameters" (decision RPC) and "idempotency_key % already used with
  // different parameters" (cancel RPC) -- both are the same class of
  // problem (a replay attempt whose payload doesn't match the original
  // operation's digest), and the gate's own HTTP-mapping item groups them
  // under the same 409 bucket as not_decidable/not_cancellable.
  | { outcome: 'conflict' }
  | { outcome: 'validation_error'; message: string }
  | { outcome: 'database_error'; operation: string; error: LifecycleDatabaseErrorShape }
  | { outcome: 'invalid_rpc_response'; operation: string }

// Both 087 write RPCs signal auth/reviewer/validation/state failures via a
// plain RAISE EXCEPTION with a recognizable message (087's own convention,
// mirroring mapReviewRpcError in human-review-types.ts) -- this maps that
// text, in priority order, to the closed LifecycleActionFailure vocabulary.
// "expired" is NOT handled here: it is a normal {ok:false,reasonCode:
// 'REQUEST_EXPIRED'} JSONB return from the decision RPC (never an
// exception), parsed directly by lifecycle-review-actions.ts.
export function mapLifecycleActionRpcError(operation: string, error: unknown): LifecycleActionFailure {
  const shaped = toLifecycleDatabaseErrorShape(error)
  const message = shaped.message

  if (/permission denied/i.test(message)) return { outcome: 'not_a_reviewer' }
  if (/caller is not an active reviewer/.test(message)) return { outcome: 'not_a_reviewer' }
  if (/authentication required/.test(message)) return { outcome: 'unauthenticated' }
  if (/not found/.test(message)) return { outcome: 'not_found' }
  if (/already decided with different parameters/.test(message)) return { outcome: 'conflict' }
  if (/idempotency_key .* already used with different parameters/.test(message)) return { outcome: 'conflict' }
  if (/REVIEW_REQUEST_NOT_DECIDABLE/.test(message)) return { outcome: 'not_decidable' }
  if (/REVIEW_REQUEST_NOT_CANCELLABLE/.test(message)) return { outcome: 'not_cancellable' }
  if (
    /must be approved or rejected|unsupported review_policy_version|reviewer_rationale is required|coherent approval requires|ambiguous approval requires|corroborating approval .* requires|rejected requires a closed rejection reason_code|p_cancel_reason_code must be a closed cancel reason|p_cancel_rationale is required/.test(
      message,
    )
  ) {
    return { outcome: 'validation_error', message }
  }
  return { outcome: 'database_error', operation, error: shaped }
}
