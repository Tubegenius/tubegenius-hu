// Semantic Topic Identity v0 -- Anthropic Provider Failure Taxonomy v0.
//
// Closed, typed classification of every way callAnthropicForExtraction()
// (provider-adapter.ts) can fail, replacing the old single generic
// 'provider_rejected_unbilled' bucket that discarded the actual HTTP status.
// This is the ROOT CAUSE this module fixes: provider-adapter.ts's previous
// classifyProviderError() checked err.status internally (inside
// isDefinitelyUnbilledProviderError) but never threaded that status through
// to the caller -- extraction-service.ts, decideItemOutcome(), the DB
// reason_code, and the runner's own logs all only ever saw the string
// 'provider_rejected_unbilled', indistinguishable whether the real cause was
// a bad API key (401), a permission/model-access problem (403), a missing
// model (404), or a malformed request (400).
//
// Branches EXCLUSIVELY on Anthropic.APIError's own structured `status`
// field (a real HTTP status code the SDK parses itself) -- never on
// err.message text/regex, matching this codebase's existing "no free-text
// branching on security/business-relevant paths" convention (see
// human-review-extraction-hook.ts's own header for the established
// precedent).
import Anthropic from '@anthropic-ai/sdk'

// ===========================================================================
// Taxonomy
// ===========================================================================

// The nine categories the gate requires, at minimum. 'malformed_output_charged'
// is produced by extraction-service.ts itself (structured-output validation
// failure AFTER a successful, billed provider call) -- not by this module's
// own classifyProviderFailure(), which only ever sees the provider CALL
// itself succeed or throw. It is still part of the shared closed union so
// every caller can exhaustively switch over the whole failure space in one
// place.
export type ProviderFailureCategory =
  | 'authentication_failed' // HTTP 401
  | 'permission_denied' // HTTP 403
  | 'invalid_request_unbilled' // HTTP 400
  | 'model_or_endpoint_not_found' // HTTP 404
  | 'rate_limited' // HTTP 429
  | 'provider_server_error' // HTTP 5xx
  | 'network_or_transport_uncertain' // timeout, ECONNRESET, etc. -- true billing state unknown
  | 'malformed_output_charged' // billed call succeeded, output failed schema validation
  | 'provider_rejected_unbilled_unknown' // defensive fallback -- see below

export type ProviderFailureBilledStatus = 'unbilled' | 'billed' | 'uncertain'

// What the runner/decideItemOutcome should do with an item that failed this
// way -- never re-derived ad hoc at each call site, always read from here.
//   - 'never_automatic': retryable=false at the item level. A fresh attempt
//     would fail identically without a human/config change first.
//   - 'batch_stop_required': not evidence-specific -- every remaining item
//     in the batch would hit the identical failure, so the batch itself
//     must stop rather than keep burning through items one at a time.
//   - 'conservative_uncertain': the existing 075/079 billing-uncertainty
//     path (committed_unknown, reconciliation-eligible) -- unchanged.
export type ProviderFailureRetryPolicy = 'never_automatic' | 'batch_stop_required' | 'conservative_uncertain'

export interface ProviderFailureClassification {
  category: ProviderFailureCategory
  // A safe, display-only field: a bare HTTP status number, or null when the
  // failure never reached the HTTP layer at all (timeout/network). Never a
  // raw header, raw body, or raw provider error object.
  httpStatus: number | null
  billed: ProviderFailureBilledStatus
  retryPolicy: ProviderFailureRetryPolicy
}

const HTTP_STATUS_TO_CATEGORY: Readonly<Record<number, ProviderFailureCategory>> = {
  400: 'invalid_request_unbilled',
  401: 'authentication_failed',
  403: 'permission_denied',
  404: 'model_or_endpoint_not_found',
}

// The same closed set provider-adapter.ts's isDefinitelyUnbilledProviderError
// already uses -- re-declared here (not imported) so this module has zero
// dependency on provider-adapter.ts and can be unit-tested in complete
// isolation from the Anthropic client construction path.
const DEFINITELY_UNBILLED_STATUS_CODES = new Set([400, 401, 403, 404])

function classifyRetryPolicy(category: ProviderFailureCategory): ProviderFailureRetryPolicy {
  switch (category) {
    case 'authentication_failed':
    case 'permission_denied':
    case 'model_or_endpoint_not_found':
    case 'invalid_request_unbilled':
    case 'provider_rejected_unbilled_unknown':
      // Section C: 400/401/403/404 are never automatically retryable, and
      // (per the same section) are account-/config-level rather than
      // evidence-specific by default -- 400 stays in this same fail-closed
      // bucket unless a future, concrete structured provider signal proves
      // it was evidence-specific; no such signal exists in the SDK error
      // shape today, so there is deliberately no evidence-specific carve-out
      // here to avoid inventing one that isn't real.
      return 'batch_stop_required'
    case 'malformed_output_charged':
      // Unchanged from the existing malformed_output policy: item-local,
      // batch continues, but never automatically retryable either (a billed
      // failure -- see extraction-service.ts's own charged-failure comment).
      return 'never_automatic'
    case 'rate_limited':
    case 'provider_server_error':
    case 'network_or_transport_uncertain':
      // Section C: preserve the existing 075/079 billing-uncertainty and
      // reconciliation guarantees unchanged -- these stay conservatively
      // uncertain, never a batch-stop, never item-terminal here.
      return 'conservative_uncertain'
  }
}

function classifyBilledStatus(category: ProviderFailureCategory): ProviderFailureBilledStatus {
  switch (category) {
    case 'authentication_failed':
    case 'permission_denied':
    case 'invalid_request_unbilled':
    case 'model_or_endpoint_not_found':
    case 'provider_rejected_unbilled_unknown':
      return 'unbilled'
    case 'malformed_output_charged':
      return 'billed'
    case 'rate_limited':
    case 'provider_server_error':
    case 'network_or_transport_uncertain':
      return 'uncertain'
  }
}

// The ONLY function that inspects a raw thrown error's shape. Everything
// downstream (extraction-service.ts, decideItemOutcome, the runner's logs,
// the DB reason_code) consumes just this return value -- never the
// original `err` again. Never logs or returns err.message/err.error/
// err.headers/anything provider-supplied beyond the bare numeric status.
export function classifyProviderFailure(err: unknown): ProviderFailureClassification {
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    if (err.status === 429) {
      return { category: 'rate_limited', httpStatus: 429, billed: classifyBilledStatus('rate_limited'), retryPolicy: classifyRetryPolicy('rate_limited') }
    }
    if (err.status >= 500 && err.status < 600) {
      return { category: 'provider_server_error', httpStatus: err.status, billed: classifyBilledStatus('provider_server_error'), retryPolicy: classifyRetryPolicy('provider_server_error') }
    }
    if (DEFINITELY_UNBILLED_STATUS_CODES.has(err.status)) {
      const category = HTTP_STATUS_TO_CATEGORY[err.status]
      return { category, httpStatus: err.status, billed: classifyBilledStatus(category), retryPolicy: classifyRetryPolicy(category) }
    }
    // A structured APIError with a status outside every known bucket above
    // (some future/unlisted 4xx) -- fail closed as unbilled-unknown rather
    // than silently falling through to the network/timeout bucket, since we
    // DO have a real HTTP status here, just not one this taxonomy has a
    // named category for yet.
    return {
      category: 'provider_rejected_unbilled_unknown',
      httpStatus: err.status,
      billed: classifyBilledStatus('provider_rejected_unbilled_unknown'),
      retryPolicy: classifyRetryPolicy('provider_rejected_unbilled_unknown'),
    }
  }

  // No structured HTTP status at all -- timeout, ECONNRESET/ECONNREFUSED/
  // ENOTFOUND/EAI_AGAIN, SDK-level AbortError, or any other transport-layer
  // failure. True billing state is never knowable from this shape alone, so
  // this always stays in the conservative-uncertain bucket, matching
  // 075/079's existing reconciliation guarantees.
  return {
    category: 'network_or_transport_uncertain',
    httpStatus: null,
    billed: classifyBilledStatus('network_or_transport_uncertain'),
    retryPolicy: classifyRetryPolicy('network_or_transport_uncertain'),
  }
}

// For extraction-service.ts's OWN malformed-output branch (a successful,
// billed provider call whose output then failed schema validation) -- not
// derived from a thrown error at all, so it is a plain constant rather than
// something classifyProviderFailure() could ever produce itself.
export const MALFORMED_OUTPUT_CHARGED_CLASSIFICATION: ProviderFailureClassification = {
  category: 'malformed_output_charged',
  httpStatus: null,
  billed: 'billed',
  retryPolicy: 'never_automatic',
}

// For extraction-service.ts's structural-commit-RPC-failure fallback (the
// settlement commit itself errors after a real, already-happened provider
// call -- not a provider failure at all, but the true billing state is
// unknown either way) -- same conservative bucket as network_or_transport_
// uncertain, kept as its own named constant so the call site never needs to
// hand-construct a classification literal inline.
export const COMMIT_FAILED_CLASSIFICATION: ProviderFailureClassification = {
  category: 'network_or_transport_uncertain',
  httpStatus: null,
  billed: 'uncertain',
  retryPolicy: 'conservative_uncertain',
}
