// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, application
// layer. Shared types for the reviewer-session wrapper (human-review-reviewer.ts)
// and the service-role wrapper (human-review-service.ts).
//
// Deliberately scoped to only what the app actually sends/receives -- this is
// NOT a mirror of the 077 schema. See
// docs/architecture/semantic-topic-identity-v0-contract.md SS31/SS32 for the
// full DB contract; the RPCs themselves (migration 078, unmodified by this
// module) remain the sole source of truth for every business rule below.
import type { createAdminClient } from '@/lib/supabase-server'
import type { SupabaseClient } from '@supabase/supabase-js'

export type SemanticTopicAdminClient = ReturnType<typeof createAdminClient>
// Any Supabase client bound to a single request's user session (RLS/auth.uid()
// applies) -- createServerSupabaseClient()'s return type, kept as the generic
// SupabaseClient interface here so this module never has to import
// next/headers (which createServerSupabaseClient() pulls in transitively).
export type SemanticTopicUserSessionClient = SupabaseClient

export type ReviewRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'revoked' | 'executed'
export type ProposedOutcome = 'CREATE_NEW' | 'ATTACH_EXISTING'
export type EvidenceAdequacy = 'adequate' | 'marginal'
export type DuplicateSearchOutcome = 'no_duplicate_found' | 'possible_duplicate_reviewed_and_distinct' | 'existing_topic_match_confirmed'

// Migration 084 fail-closed pairing rule (mirrors the DB CHECK
// topic_assignment_review_requests_dup_search_outcome_pairing and the
// record_topic_assignment_review_decision RPC's own application-level
// validation exactly -- see docs/architecture/semantic-topic-identity-v0-contract.md
// SS37). ATTACH_EXISTING means the reviewer FOUND a matching existing topic
// and is attaching to it -- 'no_duplicate_found' and
// 'possible_duplicate_reviewed_and_distinct' are both factually false for
// that case. CREATE_NEW must never claim 'existing_topic_match_confirmed'.
//
// Switched on DuplicateSearchOutcome (not ProposedOutcome) deliberately --
// a `never`-exhaustiveness check here means a future 4th
// duplicate_search_outcome value breaks the TypeScript build until this
// function is updated to say which proposedOutcome(s) it is valid for,
// instead of silently defaulting to "invalid everywhere" or "valid
// everywhere". This is the same never-exhaustiveness idiom already used by
// human-review-http-mapping.ts's status-mapping switch.
export function allowedProposedOutcomesForDuplicateSearchOutcome(outcome: DuplicateSearchOutcome): readonly ProposedOutcome[] {
  switch (outcome) {
    case 'no_duplicate_found':
    case 'possible_duplicate_reviewed_and_distinct':
      return ['CREATE_NEW']
    case 'existing_topic_match_confirmed':
      return ['ATTACH_EXISTING']
    default: {
      const exhaustiveCheck: never = outcome
      throw new Error(`Unhandled duplicate_search_outcome: ${exhaustiveCheck}`)
    }
  }
}

export function isDuplicateSearchOutcomeValidFor(proposedOutcome: ProposedOutcome, duplicateSearchOutcome: DuplicateSearchOutcome): boolean {
  return allowedProposedOutcomesForDuplicateSearchOutcome(duplicateSearchOutcome).includes(proposedOutcome)
}
export type UncertaintyClassification = 'low' | 'medium' | 'high'
export type RejectionReason =
  | 'insufficient_evidence'
  | 'invalid_topic_identity'
  | 'not_lane_neutral'
  | 'malformed_candidate'
  | 'duplicate_without_valid_target'
  | 'other_review_rejection'

export const REJECTION_REASONS: readonly RejectionReason[] = [
  'insufficient_evidence',
  'invalid_topic_identity',
  'not_lane_neutral',
  'malformed_candidate',
  'duplicate_without_valid_target',
  'other_review_rejection',
]

// Field-length ceilings mirrored from 077's own CHECK constraints
// (topic_assignment_review_requests_*_length) -- validated here BEFORE the
// RPC call purely so a caller gets a fast, clear 422 instead of a raw DB
// constraint-violation message; the RPC/table CHECK remains the actual
// enforcement point, this is not a second source of truth for the limit
// values themselves (they're pinned identically to 077's committed source).
export const REVIEW_FIELD_MAX_LENGTHS = {
  canonicalTopicLabel: 200,
  topicDefinition: 1000,
  scope: 1000,
  inclusionCriteria: 1000,
  exclusionCriteria: 1000,
  reviewerRationale: 1000,
} as const

export interface StructuredApprovalInput {
  outcome: 'approved'
  canonicalTopicLabel: string
  topicDefinition: string
  scope: string
  inclusionCriteria: string
  exclusionCriteria: string
  laneNeutralConfirmed: true
  evidenceAdequacy: 'adequate'
  duplicateSearchOutcome: DuplicateSearchOutcome
  proposedOutcome: ProposedOutcome
  targetSemanticTopicId: string | null
  uncertaintyClassification: UncertaintyClassification
  reviewerRationale: string
  reviewPolicyVersion: number
}

export interface StructuredRejectionInput {
  outcome: 'rejected'
  rejectionReason: RejectionReason
  reviewerRationale: string
  reviewPolicyVersion: number
}

export type StructuredDecisionInput = StructuredApprovalInput | StructuredRejectionInput

export interface ReviewRequestSummary {
  reviewRequestId: string
  generation: number
  requestedAt: string
  expiresAt: string
  extractionRunId: string
  evidence: {
    evidenceId: string
    title: string | null
    externalRef: string | null
    publishedAt: string | null
    canonicalUrl: string | null
  }
  source: { sourceType: string; sourceFamilyKey: string }
  candidateLabel: string | null
  specificity: string | null
  contentFormat: string | null
  modelReportedConfidence: string | null
  supportingSpans: unknown
}

export interface ReviewRequestDetail extends Omit<ReviewRequestSummary, 'requestedAt'> {
  status: ReviewRequestStatus
  requestedAt: string
  labelLanguage: string | null
  subjectEntities: unknown
  actionOrEvent: string | null
  location: string | null
  temporalContext: string | null
  decision: {
    decidedAt: string
    canonicalTopicLabel: string | null
    topicDefinition: string | null
    scope: string | null
    inclusionCriteria: string | null
    exclusionCriteria: string | null
    laneNeutralConfirmed: boolean | null
    evidenceAdequacy: string | null
    duplicateSearchOutcome: string | null
    proposedOutcome: string | null
    targetSemanticTopicId: string | null
    uncertaintyClassification: string | null
    reviewerRationale: string | null
    rejectionReason: string | null
  } | null
}

export interface DatabaseErrorShape {
  code?: string
  message: string
  details?: string
  hint?: string
}

// A stable, closed vocabulary of outcomes every wrapper function normalizes
// to -- callers (API routes) map THIS, never a raw Postgres/PostgREST error,
// onto an HTTP status. RAISE EXCEPTION message text from the 078 RPCs is
// pattern-matched (never blindly forwarded) to produce these.
export type ReviewOperationFailure =
  | { outcome: 'unauthenticated' }
  | { outcome: 'not_a_reviewer' }
  | { outcome: 'not_found' }
  | { outcome: 'expired' }
  | { outcome: 'not_decidable'; status?: ReviewRequestStatus }
  | { outcome: 'already_decided' }
  | { outcome: 'already_executed' }
  | { outcome: 'not_cancellable'; status?: ReviewRequestStatus }
  | { outcome: 'not_revocable'; status?: ReviewRequestStatus }
  | { outcome: 'idempotency_key_reuse' }
  | { outcome: 'not_executable'; status?: ReviewRequestStatus }
  | { outcome: 'validation_error'; message: string }
  | { outcome: 'not_eligible'; message: string }
  | { outcome: 'database_error'; operation: string; error: DatabaseErrorShape }
  | { outcome: 'invalid_rpc_response'; operation: string }

export function toDatabaseErrorShape(error: unknown): DatabaseErrorShape {
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

// Every 078 RPC signals its own controlled, non-corrupting conflict states
// via a plain RAISE EXCEPTION with a recognizable UPPER_SNAKE_CASE tag in
// the message text (this codebase's established convention -- no custom
// Postgres error codes exist anywhere in this schema, see 074/077/078's own
// source). This maps that text, in priority order, to the closed
// ReviewOperationFailure vocabulary above. Falls through to a generic
// database_error for anything unrecognized -- never guesses at a more
// specific outcome than the message actually proves.
//
// NOT used by createReviewRequest() (human-review-service.ts) -- since the
// Structured Orchestration Outcome Closure gate, that one RPC's controlled
// non-success branches return a typed outcome_kind/reason_code JSONB
// payload instead of raising, and are parsed directly, never through this
// message-pattern-matching fallback. This function still serves every OTHER
// 078 RPC wrapper in this module family (decision/cancel/revoke/execute/
// expire), which are unchanged by that gate.
export function mapReviewRpcError(operation: string, error: unknown): ReviewOperationFailure {
  const shaped = toDatabaseErrorShape(error)
  const message = shaped.message

  if (/permission denied/i.test(message)) return { outcome: 'not_a_reviewer' }
  if (/caller is not an active reviewer/.test(message)) return { outcome: 'not_a_reviewer' }
  if (/authentication required/.test(message)) return { outcome: 'unauthenticated' }
  if (/not found/.test(message)) return { outcome: 'not_found' }
  if (/REVIEW_REQUEST_EXPIRED/.test(message)) return { outcome: 'expired' }
  if (/ALREADY_DECIDED/.test(message)) return { outcome: 'already_decided' }
  if (/ALREADY_EXECUTED/.test(message)) return { outcome: 'already_executed' }
  if (/IDEMPOTENCY_KEY_REUSE/.test(message)) return { outcome: 'idempotency_key_reuse' }
  if (/REVIEW_REQUEST_NOT_CANCELLABLE/.test(message)) return { outcome: 'not_cancellable' }
  if (/REVIEW_APPROVAL_NOT_REVOCABLE/.test(message)) return { outcome: 'not_revocable' }
  if (/REVIEW_REQUEST_NOT_DECIDABLE/.test(message)) return { outcome: 'not_decidable' }
  if (/REVIEW_REQUEST_NOT_EXECUTABLE/.test(message)) return { outcome: 'not_executable' }
  if (/requires the full structured review snapshot|requires lane_neutral_confirmed|requires evidence_adequacy|requires proposed_outcome|must not supply target_semantic_topic_id|requires target_semantic_topic_id|requires a valid rejection_reason|requires reviewer_rationale/.test(message)) {
    return { outcome: 'validation_error', message }
  }
  return { outcome: 'database_error', operation, error: shaped }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
