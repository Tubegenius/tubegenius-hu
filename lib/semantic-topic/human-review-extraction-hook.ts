// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, extraction
// pipeline integration point.
//
// This is a SEPARATE, sibling function to runShadowExtraction()
// (extraction-service.ts) -- it does NOT modify that function's internals,
// return shape, or error paths in any way. Flag=false byte-identical
// behavior is guaranteed structurally: this whole module short-circuits
// before touching anything (no RPC call, no extra read) the instant the flag
// reads false, so runShadowExtraction()'s own completed/failed/etc. outcomes
// are completely unaffected regardless of whether a caller invokes this hook
// afterward or not.
//
// Intended call site: AFTER runShadowExtraction() resolves to
// `{ outcome: 'completed', extractionRunId, structuredOutput, ... }` --  no
// such caller exists in this codebase yet (runShadowExtraction() itself has
// no live application-level caller either, per the existing header comment
// in extraction-service.ts; both are exercised today only by tests and
// felügyelt one-off pilot scripts). Wiring an actual live orchestrator is
// explicitly out of scope for this phase.
//
// The 0.8500 threshold, specificity check, and supporting-span requirement
// are NOT duplicated here as a second business decision -- this function
// always attempts create_topic_assignment_review_request when the flag is
// on, and lets the RPC's own eligibility gate be the single source of truth;
// an ineligible extraction (confidence >= 0.85, non-specific, no supporting
// spans, or a run that already has a decision) comes back as a plain,
// expected `not_eligible` result, not an error -- nothing else in this
// codebase automatically reacts to that today, so the "existing
// QUARANTINE/assignment flow" (manual, felügyelt pilots only, see
// docs/architecture/semantic-topic-identity-v0-contract.md SS23-28) is
// completely unchanged either way.
import { createReviewRequest } from './human-review-service'
import { isHumanReviewEnabled } from './human-review-flag'
import type { ReviewOperationFailure, SemanticTopicAdminClient } from './human-review-types'

export type MaybeRequestHumanReviewResult =
  | { outcome: 'flag_disabled' }
  | { outcome: 'created' | 'replayed'; reviewRequestId: string; generation: number; status: string; expiresAt: string }
  | { outcome: 'not_eligible'; message: string }
  | Exclude<ReviewOperationFailure, { outcome: 'not_eligible' }>

// Deterministic, namespaced per extraction_run_id -- a retry of the SAME
// extraction run (same idempotency scope the caller already retries
// runShadowExtraction under) always derives the SAME key here too, so a
// second call after a dropped connection replays instead of erroring, and
// this key can never collide with the extraction-run/quota-reservation
// digests' own namespaces (':quota', ':extraction-run') or the rejection
// path's ('review-reject:') -- all four are disjoint prefixes/suffixes by
// construction.
export function deriveHumanReviewIdempotencyKey(extractionRunId: string): string {
  return `human-review-request:${extractionRunId}`
}

export async function maybeRequestHumanReview(
  input: { extractionRunId: string; client?: SemanticTopicAdminClient },
): Promise<MaybeRequestHumanReviewResult> {
  if (!isHumanReviewEnabled()) {
    return { outcome: 'flag_disabled' }
  }

  const idempotencyKey = deriveHumanReviewIdempotencyKey(input.extractionRunId)
  const result = await createReviewRequest({ extractionRunId: input.extractionRunId, idempotencyKey }, input.client)

  if (result.outcome === 'success') {
    return { outcome: result.result, reviewRequestId: result.reviewRequestId, generation: result.generation, status: result.status, expiresAt: result.expiresAt }
  }
  return result
}
