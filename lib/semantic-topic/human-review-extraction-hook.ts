// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, extraction
// pipeline integration point.
//
// LIVE ORCHESTRATION, corrected during the Application Integration Closure
// gate: a full repository audit (never touching .env.local, never assuming
// anything from a prior report) confirmed that `runShadowExtraction()`
// (extraction-service.ts) has NO application-level caller anywhere in this
// codebase -- not in any cron route, API route, or worker. The collector
// subsystem (lib/emerging-signal/*) and the semantic-topic extraction
// subsystem (lib/semantic-topic/*) are two completely disconnected islands;
// neither imports the other, and no orchestrator (live, commented-out, or
// stubbed) connects collector -> extraction -> assignment anywhere. This
// means `runShadowExtraction()` ITSELF is the only thing in this codebase
// that represents "extraction completion" -- there is no separate,
// external orchestration layer to hook into instead. Given that, this hook
// is now called from INSIDE `runShadowExtraction()`'s own `completed`
// branch (see extraction-service.ts), not left as an unwired sibling
// function -- the moment ANY caller (test, future pilot script, or a real
// future orchestrator) reaches a completed extraction, this hook runs.
// Flag=false byte-identical behavior is still guaranteed: this function
// short-circuits before touching anything (no RPC call, no extra read) the
// instant the flag reads false, so runShadowExtraction()'s own existing
// fields (reservationId, extractionRunId, structuredOutput, capBreach) are
// completely unaffected -- only one NEW field (`humanReview`) is added to
// the completed result, never a change to an existing one.
//
// The 0.8500 threshold, specificity check, and supporting-span requirement
// are NOT duplicated here as a second business decision -- this function
// always attempts create_topic_assignment_review_request when the flag is
// on, and lets the RPC's own eligibility gate be the single source of
// truth. There is still no automated "existing QUARANTINE/assignment flow"
// anywhere in this codebase to hand off to (confirmed by the same audit --
// record_topic_assignment_decision has no application-level caller either,
// only felügyelt pilot scripts use it manually) -- so a `not_eligible`
// result simply means this hook does nothing further, exactly matching
// today's actual (lack of) automatic behavior.
import { createReviewRequest } from './human-review-service'
import { isHumanReviewEnabled } from './human-review-flag'
import type { SemanticTopicAdminClient } from './human-review-types'

// Closed, typed orchestration outcome -- deliberately NOT free-text
// branching. The caller (runShadowExtraction()) and any future caller must
// switch on `outcome` exhaustively; TypeScript enforces this via the
// discriminated union.
export type HumanReviewOrchestrationResult =
  // Flag is off (the default) -- no RPC call was made at all.
  | { outcome: 'disabled' }
  // A fresh pending review request was just created on this run.
  | { outcome: 'created'; reviewRequestId: string; generation: number; expiresAt: string }
  // Idempotent replay of an identical prior create call on this exact run.
  | { outcome: 'replayed'; reviewRequestId: string; generation: number; expiresAt: string }
  // A live (pending/approved) review request already exists on this run --
  // never create a second one; the existing one is authoritative.
  | { outcome: 'pending' }
  // This extraction is not eligible for human review at all (confidence >=
  // 0.85, non-specific, or no supporting spans) -- the caller may continue
  // whatever it would otherwise do for an ineligible extraction; nothing
  // else needs to happen here.
  | { outcome: 'not_eligible'; message: string }
  // This run already has a terminal topic_assignment_decisions row (from
  // any source -- an executed review, or a direct 074 QUARANTINE call) --
  // idempotent no-op, never attempt a second request or decision.
  | { outcome: 'already_assigned' }
  // A transient RPC/DB failure -- fail-closed, NOT a terminal QUARANTINE.
  // The completed extraction itself is untouched and safely retryable; the
  // caller should surface this as retryable, never silently swallow it or
  // treat it as "not eligible".
  | { outcome: 'retryable_failure'; message: string }

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
): Promise<HumanReviewOrchestrationResult> {
  if (!isHumanReviewEnabled()) {
    return { outcome: 'disabled' }
  }

  const idempotencyKey = deriveHumanReviewIdempotencyKey(input.extractionRunId)
  const result = await createReviewRequest({ extractionRunId: input.extractionRunId, idempotencyKey }, input.client)

  if (result.outcome === 'success') {
    return result.result === 'created'
      ? { outcome: 'created', reviewRequestId: result.reviewRequestId, generation: result.generation, expiresAt: result.expiresAt }
      : { outcome: 'replayed', reviewRequestId: result.reviewRequestId, generation: result.generation, expiresAt: result.expiresAt }
  }

  if (result.outcome === 'not_eligible') {
    // Re-classify the RPC's single generic "not eligible" bucket into the
    // three semantically distinct cases this orchestration contract needs
    // (C/D from the closure gate's spec) -- never invent a new RPC-side
    // reason value, this is purely a client-side re-read of the SAME
    // message text create_topic_assignment_review_request already produces
    // (see the 078 migration source for the exact three patterns matched).
    if (/already has a topic_assignment_decisions row/.test(result.message)) {
      return { outcome: 'already_assigned' }
    }
    if (/already has a live \(pending\/approved\)/.test(result.message)) {
      return { outcome: 'pending' }
    }
    // Genuinely ineligible: confidence too high, non-specific, or no
    // supporting spans -- the RPC's eligibility gate is the sole source of
    // truth, never duplicated here.
    return { outcome: 'not_eligible', message: result.message }
  }

  // Every other failure shape (database_error, invalid_rpc_response,
  // unauthenticated, validation_error) is a transient/unexpected condition
  // from this call site's perspective -- service_role calls never
  // legitimately hit unauthenticated/validation_error here, so treating
  // them as retryable (rather than inventing a more specific bucket) is the
  // correct fail-closed default: the completed extraction stays untouched
  // and safely retryable either way.
  const message = 'message' in result ? result.message : `outcome=${result.outcome}`
  return { outcome: 'retryable_failure', message }
}
