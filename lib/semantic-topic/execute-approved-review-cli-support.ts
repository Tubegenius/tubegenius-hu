// PFM Approved Human Review Executor v0 -- pure orchestration core for the
// operator-only CLI that executes an already-approved review request.
//
// PURPOSE: record_topic_assignment_review_decision() (078) already records
// a reviewer's approval, but deliberately never materializes the resulting
// semantic_topics/semantic_topic_membership/topic_assignment_decisions rows
// itself -- that happens only via executeApprovedReview()
// (human-review-service.ts), which calls the service_role-only
// execute_approved_topic_assignment_review RPC. That RPC is intentionally
// NEVER reachable from the reviewer UI or any app/api route (see
// tests/human-review-ui-security.test.ts) -- the first real execution path
// is this operator CLI, exactly like every other first-production-write
// gate in this rollout.
//
// This module is NOT a second implementation of the 078 execution rules --
// it reuses executeApprovedReview() completely unchanged, so an execution
// produced through this path is byte-for-byte the same RPC call, with the
// same atomic-transaction/digest-recomputation/reviewer-re-check guarantees,
// that any other future caller of executeApprovedReview() would get.
//
// SECURITY BOUNDARY: this module imports NOTHING from extraction-service.ts,
// provider-adapter.ts, or supervised-intake-runner.ts -- see
// tests/execute-approved-review-source-policy.test.ts for the static proof.
// It contains no INSERT/UPDATE/DELETE SQL of its own: the only database
// interactions are two read-only SELECTs (topic_assignment_review_requests,
// topic_extraction_runs) and one already-existing, already-audited RPC call.
import { executeApprovedReview } from './human-review-service'
import type { SemanticTopicAdminClient } from './human-review-types'

export const EXECUTOR_EXIT_CODE = {
  OK: 0,
  VALIDATION_OR_CONFIG_ERROR: 2,
  NOT_EXECUTABLE: 3,
  BLOCKED: 4,
  UNEXPECTED_ERROR: 5,
} as const
export type ExecutorExitCode = (typeof EXECUTOR_EXIT_CODE)[keyof typeof EXECUTOR_EXIT_CODE]

// Deterministic, derived from the review_request_id alone -- never an open
// CLI flag. Mirrors deriveHumanReviewIdempotencyKey()'s own pattern
// (human-review-extraction-hook.ts): the caller supplies WHICH request to
// execute, never a free-form retry token, so two invocations against the
// same request are always the same idempotency key, and a caller can never
// inject an unrelated/colliding key.
export function deriveExecutionIdempotencyKey(reviewRequestId: string): string {
  return `execute-approved-review:${reviewRequestId}`
}

// ===========================================================================
// Read-only approval preview -- the ONLY data this module ever reads.
// Reviewer identity (reviewer_user_id) and the full approval_digest are
// deliberately never included -- only an 8-char digest prefix and no
// reviewer UUID at all, matching Section E's explicit requirement.
// ===========================================================================
export interface ApprovedReviewPreview {
  reviewRequestIdPrefix: string
  status: string
  generation: number
  requestedAt: string
  decidedAt: string | null
  executedAt: string | null
  expiresAt: string
  canonicalTopicLabel: string | null
  topicDefinition: string | null
  scope: string | null
  inclusionCriteria: string | null
  exclusionCriteria: string | null
  reviewerRationale: string | null
  approvalDigestVersion: number | null
  approvalDigestPrefix: string | null
  extractionRunIdPrefix: string
  signalEvidenceIdPrefix: string
  confidenceRaw: string | null
  specificity: string | null
  contentFormat: string | null
  proposedOutcome: string | null
  expectedLifecycle: 'candidate_singleton'
  expectedSideEffectCount: { events: number; topics: number; memberships: number; membershipEvents: number; decisions: number }
}

interface ReviewRequestRow {
  id: string
  status: string
  generation: number
  requested_at: string
  decided_at: string | null
  executed_at: string | null
  expires_at: string
  canonical_topic_label: string | null
  topic_definition: string | null
  scope: string | null
  inclusion_criteria: string | null
  exclusion_criteria: string | null
  reviewer_rationale: string | null
  approval_digest: string | null
  approval_digest_version: number | null
  proposed_outcome: string | null
  extraction_run_id: string
}

interface ExtractionRunRow {
  id: string
  signal_evidence_id: string
  structured_output: Record<string, unknown> | null
}

export type FetchApprovedReviewPreviewResult = { ok: true; preview: ApprovedReviewPreview } | { ok: false; message: string }

export async function fetchApprovedReviewPreview(
  client: SemanticTopicAdminClient,
  reviewRequestId: string,
): Promise<FetchApprovedReviewPreviewResult> {
  const { data, error } = await client
    .from('topic_assignment_review_requests')
    .select(
      'id, status, generation, requested_at, decided_at, executed_at, expires_at, canonical_topic_label, topic_definition, scope, inclusion_criteria, exclusion_criteria, reviewer_rationale, approval_digest, approval_digest_version, proposed_outcome, extraction_run_id',
    )
    .eq('id', reviewRequestId)
    .maybeSingle()
  // error.message is a raw Postgres/PostgREST message and MUST NOT be
  // returned verbatim to a console -- callers redact it via the shared
  // operator-cli-security module before ever printing it, exactly like the
  // recovery CLI's own preview fetcher.
  if (error) return { ok: false, message: error.message }
  if (!data) return { ok: false, message: 'review_request not found' }
  const row = data as ReviewRequestRow

  const { data: runData, error: runError } = await client
    .from('topic_extraction_runs')
    .select('id, signal_evidence_id, structured_output')
    .eq('id', row.extraction_run_id)
    .maybeSingle()
  if (runError) return { ok: false, message: runError.message }
  if (!runData) return { ok: false, message: 'linked extraction_run not found' }
  const run = runData as ExtractionRunRow
  const structured = run.structured_output

  return {
    ok: true,
    preview: {
      reviewRequestIdPrefix: row.id.slice(0, 8),
      status: row.status,
      generation: row.generation,
      requestedAt: row.requested_at,
      decidedAt: row.decided_at,
      executedAt: row.executed_at,
      expiresAt: row.expires_at,
      canonicalTopicLabel: row.canonical_topic_label,
      topicDefinition: row.topic_definition,
      scope: row.scope,
      inclusionCriteria: row.inclusion_criteria,
      exclusionCriteria: row.exclusion_criteria,
      reviewerRationale: row.reviewer_rationale,
      approvalDigestVersion: row.approval_digest_version,
      approvalDigestPrefix: row.approval_digest ? row.approval_digest.slice(0, 8) + '…' : null,
      extractionRunIdPrefix: run.id.slice(0, 8),
      signalEvidenceIdPrefix: run.signal_evidence_id.slice(0, 8),
      confidenceRaw: structured && structured.confidence != null ? String(structured.confidence) : null,
      specificity: structured && typeof structured.specificity === 'string' ? structured.specificity : null,
      contentFormat: structured && typeof structured.content_format === 'string' ? structured.content_format : null,
      proposedOutcome: row.proposed_outcome,
      // 077's own table default (never overridden by this executor or by
      // execute_approved_topic_assignment_review's CREATE_NEW branch, which
      // never sets lifecycle_status explicitly) -- documented here as an
      // explicit expectation, not merely assumed silently.
      expectedLifecycle: 'candidate_singleton',
      expectedSideEffectCount: {
        events: 1,
        topics: row.proposed_outcome === 'CREATE_NEW' ? 1 : 0,
        memberships: 1,
        membershipEvents: 1,
        decisions: 1,
      },
    },
  }
}

// ===========================================================================
// Main entry point -- exactly one RPC call on the non-dry-run path, never
// more than one, regardless of the request's executability.
// ===========================================================================
export type ExecutorOutcome =
  | { kind: 'dry_run'; preview: ApprovedReviewPreview }
  | {
      kind: 'executed'
      reviewRequestIdPrefix: string
      proposedOutcome: string
      semanticTopicIdPrefix: string | null
      membershipIdPrefix: string | null
      decisionIdPrefix: string | null
    }
  | { kind: 'replayed'; reviewRequestIdPrefix: string; resultingDecisionIdPrefix: string | null }
  | { kind: 'not_executable'; status?: string }
  | { kind: 'blocked'; reasonCode: string }
  | { kind: 'configuration_error'; message: string }
  | { kind: 'database_error'; operation: string }

export interface RunExecuteApprovedReviewInput {
  reviewRequestId: string
  dryRun: boolean
}

// Business-rule tags that execute_approved_topic_assignment_review's own
// RAISE EXCEPTION messages carry, which mapReviewRpcError() (this RPC's
// underlying error mapper) does NOT recognize and therefore falls through
// to a generic database_error for (see human-review-types.ts's own comment
// documenting that fallback). Classified here into a more actionable
// `blocked` outcome with a stable reasonCode, because these are anticipated,
// fully-understood business conditions read directly from the RPC's own
// source (078) -- not guesses. Anything that does NOT match one of these
// exact, documented patterns stays `database_error`: fail-closed, never
// inventing a more specific outcome than the message actually proves.
//
// Deliberately NOT included: the RPC's "target semantic_topic % not found"
// message. mapReviewRpcError()'s OWN generic `/not found/` pattern matches
// that text first (its priority order runs before this module ever sees
// the raw message), classifying it as ReviewOperationFailure's `not_found`
// variant -- which carries no message field at all. This module's
// `not_found` branch below handles that case honestly instead of
// pretending to a precision it cannot actually have from that lossy input.
const BLOCKED_REASON_PATTERNS: readonly [RegExp, string][] = [
  [/request_payload_digest drift detected/, 'REQUEST_PAYLOAD_DIGEST_DRIFT'],
  [/approval_digest drift detected/, 'APPROVAL_DIGEST_DRIFT'],
  [/unsupported review_policy_version\/approval_digest_version/, 'UNSUPPORTED_POLICY_VERSION'],
  [/reviewer for review_request .* is no longer active/, 'REVIEWER_NO_LONGER_ACTIVE'],
  [/extraction_run .* already has a topic_assignment_decisions row/, 'EXTRACTION_RUN_ALREADY_DECIDED'],
  [/extraction_run .* is no longer completed/, 'EXTRACTION_RUN_NOT_COMPLETED'],
  [/target topic lifecycle_status=.* no longer accepts ATTACH_EXISTING/, 'TARGET_TOPIC_LIFECYCLE_BLOCKS_ATTACH'],
]

function classifyDatabaseErrorMessage(message: string): { kind: 'blocked'; reasonCode: string } | { kind: 'database_error' } {
  for (const [pattern, reasonCode] of BLOCKED_REASON_PATTERNS) {
    if (pattern.test(message)) return { kind: 'blocked', reasonCode }
  }
  return { kind: 'database_error' }
}

export async function runExecuteApprovedReview(
  client: SemanticTopicAdminClient,
  input: RunExecuteApprovedReviewInput,
): Promise<ExecutorOutcome> {
  const previewResult = await fetchApprovedReviewPreview(client, input.reviewRequestId)
  if (!previewResult.ok) return { kind: 'configuration_error', message: previewResult.message }
  const { preview } = previewResult

  if (input.dryRun) {
    return { kind: 'dry_run', preview }
  }

  // Fast, explicit local check before ever calling the RPC. This is purely
  // a clarity/latency optimization -- NEVER a security boundary on its own,
  // since the RPC re-validates status itself under its own FOR UPDATE lock
  // regardless of what this check finds (a concurrent change in the window
  // between this check and the RPC call is exactly what that lock exists
  // to catch).
  if (preview.status !== 'approved' && preview.status !== 'executed') {
    return { kind: 'not_executable', status: preview.status }
  }

  // The one, and only, RPC call this module ever makes.
  const idempotencyKey = deriveExecutionIdempotencyKey(input.reviewRequestId)
  const result = await executeApprovedReview({ reviewRequestId: input.reviewRequestId, idempotencyKey }, client)

  if (result.outcome === 'success') {
    if (result.result === 'executed') {
      return {
        kind: 'executed',
        reviewRequestIdPrefix: result.reviewRequestId.slice(0, 8),
        proposedOutcome: result.proposedOutcome ?? 'unknown',
        semanticTopicIdPrefix: result.semanticTopicId ? result.semanticTopicId.slice(0, 8) : null,
        membershipIdPrefix: result.resultingMembershipId ? result.resultingMembershipId.slice(0, 8) : null,
        decisionIdPrefix: result.resultingDecisionId ? result.resultingDecisionId.slice(0, 8) : null,
      }
    }
    return {
      kind: 'replayed',
      reviewRequestIdPrefix: result.reviewRequestId.slice(0, 8),
      resultingDecisionIdPrefix: result.resultingDecisionId ? result.resultingDecisionId.slice(0, 8) : null,
    }
  }

  switch (result.outcome) {
    case 'not_found':
      // Ambiguous by construction -- see BLOCKED_REASON_PATTERNS's header
      // comment. Could mean the review_request itself vanished (a TOCTOU
      // race against this module's own preceding preview read, which
      // already confirmed it existed -- astronomically unlikely given no
      // DELETE grant exists for any non-postgres role) or, far more
      // plausibly, that an ATTACH_EXISTING request's target semantic_topic
      // was deleted between approval and execution. Reported honestly as a
      // configuration/input-shaped problem rather than claiming a
      // precision this input does not support.
      return { kind: 'configuration_error', message: 'review_request or its ATTACH_EXISTING target not found at execution time' }
    case 'not_executable':
      return { kind: 'not_executable', status: result.status }
    case 'already_executed':
      return { kind: 'blocked', reasonCode: 'ALREADY_EXECUTED_DIFFERENT_KEY' }
    case 'idempotency_key_reuse':
      return { kind: 'blocked', reasonCode: 'IDEMPOTENCY_KEY_REUSE' }
    case 'database_error': {
      const classified = classifyDatabaseErrorMessage(result.error.message)
      if (classified.kind === 'blocked') return { kind: 'blocked', reasonCode: classified.reasonCode }
      return { kind: 'database_error', operation: result.operation }
    }
    case 'invalid_rpc_response':
      return { kind: 'database_error', operation: result.operation }
    // Every other ReviewOperationFailure variant (unauthenticated,
    // not_a_reviewer, expired, already_decided, not_cancellable,
    // not_revocable, validation_error, not_eligible) is structurally
    // unreachable through executeApprovedReview() -- that wrapper only ever
    // calls execute_approved_topic_assignment_review, whose own RAISE
    // EXCEPTION vocabulary (078) never produces the message patterns those
    // outcomes are keyed on. Fail-closed rather than silently narrowing:
    // an outcome this switch does not know maps to the same generic,
    // conservative database_error as a truly unexpected error would.
    default:
      return { kind: 'database_error', operation: 'execute_approved_topic_assignment_review' }
  }
}

export function exitCodeForExecutorOutcome(outcome: ExecutorOutcome): ExecutorExitCode {
  switch (outcome.kind) {
    case 'dry_run':
    case 'executed':
    case 'replayed':
      return EXECUTOR_EXIT_CODE.OK
    case 'not_executable':
      return EXECUTOR_EXIT_CODE.NOT_EXECUTABLE
    case 'blocked':
      return EXECUTOR_EXIT_CODE.BLOCKED
    case 'configuration_error':
      return EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    case 'database_error':
      return EXECUTOR_EXIT_CODE.UNEXPECTED_ERROR
  }
}
