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
//
// STRUCTURED ORCHESTRATION OUTCOME CLOSURE gate: the switch below branches
// exclusively on typed `result.outcome`/`result.reasonCode` fields parsed
// by human-review-service.ts's createReviewRequest() from
// create_topic_assignment_review_request's (078) own outcome_kind/
// reason_code JSONB contract -- no regex, no `message.includes`, no
// database-error-text pattern matching anywhere in this file. See
// docs/architecture/semantic-topic-identity-v0-contract.md SS35 for the
// full DB reason-code table and the exact SQL branch each one comes from.
import { createReviewRequest, type CreateReviewRequestIneligibleReasonCode } from './human-review-service'
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
  // else needs to happen here. reasonCode is the 078 RPC's own closed,
  // machine-readable ineligibility code (added during the Human-Review
  // Observability Closure gate -- previously only the free-text `message`
  // was carried through, which meant WHY an extraction was ineligible could
  // never be logged safely; reasonCode is a closed enum, safe to log
  // as-is, `message` is not and must never reach a log call).
  | { outcome: 'not_eligible'; reasonCode: CreateReviewRequestIneligibleReasonCode; message: string }
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

  // Structured Orchestration Outcome Closure gate: this switch branches
  // EXCLUSIVELY on typed fields (result.outcome, result.reasonCode) that
  // createReviewRequest() has already parsed from create_topic_assignment_review_request's
  // (078) own outcome_kind/reason_code JSONB contract -- never on
  // result.message text. See docs/architecture/semantic-topic-identity-v0-contract.md
  // SS35 for the full DB reason-code table and this mapping's rationale.
  switch (result.outcome) {
    case 'success':
      return result.outcomeKind === 'created'
        ? { outcome: 'created', reviewRequestId: result.reviewRequestId, generation: result.generation, expiresAt: result.expiresAt }
        : { outcome: 'replayed', reviewRequestId: result.reviewRequestId, generation: result.generation, expiresAt: result.expiresAt }

    case 'blocked':
      // Both reason codes in this bucket are exhaustively known and
      // enumerated by CreateReviewRequestBlockedReasonCode -- a switch here
      // (rather than an if/else) makes a future third value a compile-time
      // error in this file, not a silent fail-open.
      switch (result.reasonCode) {
        case 'ALREADY_ASSIGNED':
          return { outcome: 'already_assigned' }
        case 'LIVE_REVIEW_REQUEST_EXISTS':
          return { outcome: 'pending' }
      }
      break

    case 'ineligible':
      // Every value of CreateReviewRequestIneligibleReasonCode is a
      // genuine, explicit policy-ineligibility signal from the RPC's own
      // eligibility gate (never duplicated or second-guessed here) -- the
      // orchestration outcome stays the same regardless of which one fired,
      // but reasonCode is now threaded through so a caller (the runner's
      // own safe log summary, see summarizeHumanReviewForLog below) can
      // report WHICH one without needing the free-text message.
      return { outcome: 'not_eligible', reasonCode: result.reasonCode, message: result.message }

    case 'database_error':
      // A transient RPC/transport failure -- fail-closed. The completed
      // extraction stays untouched and safely retryable either way; this
      // deliberately never becomes a terminal QUARANTINE decision.
      return { outcome: 'retryable_failure', message: result.error.message }
    case 'invalid_rpc_response':
      // The RPC returned successfully but with a shape createReviewRequest()
      // does not recognize (missing fields, or an outcome_kind/reason_code
      // pair not in this codebase's closed vocabulary) -- also fail-closed.
      return { outcome: 'retryable_failure', message: `invalid_rpc_response: ${result.operation}` }
  }

  // Unreachable if CreateReviewRequestResult's own union stays exhaustive --
  // kept as an explicit fail-closed default (never a fail-open) in case a
  // future outcome/reasonCode value is added to that type without this
  // switch being updated to handle it.
  return { outcome: 'retryable_failure', message: `unrecognized createReviewRequest result: ${JSON.stringify(result)}` }
}

// ===========================================================================
// PFM Supervised Intake Human-Review Observability Closure gate.
//
// The Missing Human-Review Request Root-Cause Gate that preceded this one
// found that the runner never logged the human-review outcome at all --
// leaving no way to retroactively tell "the flag was off" apart from "the
// flag was on and the extraction was genuinely ineligible" without a fresh
// canary run. This is the fix: a SEPARATE, deliberately narrow presenter
// (never mixed into the orchestration logic above) that reduces a full
// HumanReviewOrchestrationResult down to the ONLY two things ever safe to
// put in a log line -- the closed `outcome` string, and (for `not_eligible`
// only) the closed `reasonCode` enum. Everything else on the real result
// (reviewRequestId, generation, expiresAt, and especially the free-text
// `message` field, which the 078 RPC deliberately does not sanitize -- it
// is meant for a human reading a direct RPC response, not for a shared
// runner log) is structurally unreachable through this function's return
// type, not just conventionally avoided.
export type SafeHumanReviewLogOutcome = HumanReviewOrchestrationResult['outcome'] | 'unrecognized_outcome'

export interface SafeHumanReviewLogSummary {
  outcome: SafeHumanReviewLogOutcome
  reasonCode?: CreateReviewRequestIneligibleReasonCode
}

// Deliberately a plain if/else chain ending in a real runtime fallback, NOT
// a switch with a `_exhaustive: never` throw (the pattern decideItemOutcome
// uses elsewhere in this codebase) -- this function's entire purpose is to
// sit safely right before a console.log call. A future outcome value this
// function doesn't yet recognize must degrade to one safe, generic label
// and keep the runner running, never throw and never pass an unknown shape
// through untouched.
export function summarizeHumanReviewForLog(result: HumanReviewOrchestrationResult): SafeHumanReviewLogSummary {
  if (result.outcome === 'not_eligible') {
    return { outcome: 'not_eligible', reasonCode: result.reasonCode }
  }
  if (
    result.outcome === 'disabled' ||
    result.outcome === 'created' ||
    result.outcome === 'replayed' ||
    result.outcome === 'pending' ||
    result.outcome === 'already_assigned' ||
    result.outcome === 'retryable_failure'
  ) {
    return { outcome: result.outcome }
  }
  return { outcome: 'unrecognized_outcome' }
}
