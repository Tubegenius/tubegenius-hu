// PFM Post-Completion Review Handoff Recovery v0 -- pure orchestration core.
//
// PURPOSE: a completed topic_extraction_runs row is, by construction,
// content-eligible for human review the instant it is written (see
// extraction-service.ts step 8) -- but the live hook (human-review-extraction-hook.ts,
// called from INSIDE runShadowExtraction()) only fires at that exact moment,
// gated by isHumanReviewEnabled(). If the flag was false in THAT process at
// THAT instant (e.g. a local CLI invocation whose shell never exported it,
// even though the flag is true in production), no review request is ever
// created for that run, and nothing later "notices" the gap on its own --
// the run just sits there, completed and eligible, forever request-less.
// This module is the read-only-input, single-RPC-call recovery path for
// exactly that gap. It is NOT an extraction retry, NOT a provider caller,
// and NOT a second implementation of the 078 eligibility rules -- it reuses
// createReviewRequest() (human-review-service.ts) and
// deriveHumanReviewIdempotencyKey() (human-review-extraction-hook.ts)
// completely unchanged, so a request produced through this path is
// byte-for-byte indistinguishable, idempotency-key included, from one the
// live hook would have produced for the identical run.
//
// SECURITY BOUNDARY: this module imports NOTHING from extraction-service.ts,
// provider-adapter.ts, or supervised-intake-runner.ts -- see
// tests/post-completion-review-recovery-source-policy.test.ts for the
// static proof. It contains no INSERT/UPDATE/DELETE SQL of its own: the only
// database interactions are one read-only SELECT (topic_extraction_runs)
// and one already-existing, already-audited RPC call.
import { createReviewRequest } from './human-review-service'
import { deriveHumanReviewIdempotencyKey } from './human-review-extraction-hook'
import type { SemanticTopicAdminClient } from './human-review-types'
// Redaction and project-identity-guard logic now live in the shared
// operator-cli-security module (reused by execute-approved-review.ts too)
// -- re-exported here unchanged so this module's public API, and every
// existing import site (including the CLI script's own dynamic import),
// stays identical.
export { redactForDisplay, resolveProjectIdentity, projectGuardPasses, type ProjectIdentity } from './operator-cli-security'
import { redactForDisplay } from './operator-cli-security'

export const RECOVERY_EXIT_CODE = {
  OK: 0,
  VALIDATION_OR_CONFIG_ERROR: 2,
  INELIGIBLE: 3,
  BLOCKED: 4,
  UNEXPECTED_ERROR: 5,
} as const
export type RecoveryExitCode = (typeof RECOVERY_EXIT_CODE)[keyof typeof RECOVERY_EXIT_CODE]

// ===========================================================================
// Read-only extraction-run preview -- the ONLY data this module ever reads.
// Never returns supporting_spans/label/subject_entities content, only a
// count -- callers (the CLI's logger) must never be handed the raw
// structured_output object at all.
// ===========================================================================
export interface ExtractionRunPreview {
  extractionRunIdPrefix: string
  status: string
  confidenceRaw: string | null
  specificity: string | null
  contentFormat: string | null
  supportingSpansCount: number | null
  signalEvidenceIdPrefix: string
}

export type FetchExtractionRunPreviewResult =
  | { ok: true; preview: ExtractionRunPreview }
  | { ok: false; message: string }

export async function fetchExtractionRunPreview(
  client: SemanticTopicAdminClient,
  extractionRunId: string,
): Promise<FetchExtractionRunPreviewResult> {
  const { data, error } = await client
    .from('topic_extraction_runs')
    .select('id, status, signal_evidence_id, structured_output')
    .eq('id', extractionRunId)
    .maybeSingle()
  // error.message is a raw Postgres/PostgREST message and MUST NOT be
  // returned verbatim -- it could echo the queried id back (e.g. a cast
  // error). Routed through redactForDisplay() before ever leaving this
  // function, exactly like every other message on this module's boundary.
  if (error) return { ok: false, message: redactForDisplay(error.message) as string }
  if (!data) return { ok: false, message: 'extraction_run not found' }

  const row = data as { id: string; status: string; signal_evidence_id: string; structured_output: Record<string, unknown> | null }
  const structured = row.structured_output
  const supportingSpans = structured?.supporting_spans
  return {
    ok: true,
    preview: {
      extractionRunIdPrefix: row.id.slice(0, 8),
      status: row.status,
      confidenceRaw: structured && structured.confidence != null ? String(structured.confidence) : null,
      specificity: structured && typeof structured.specificity === 'string' ? structured.specificity : null,
      contentFormat: structured && typeof structured.content_format === 'string' ? structured.content_format : null,
      supportingSpansCount: Array.isArray(supportingSpans) ? supportingSpans.length : null,
      signalEvidenceIdPrefix: row.signal_evidence_id.slice(0, 8),
    },
  }
}

// ===========================================================================
// Main entry point -- exactly one RPC call on the non-dry-run path, never
// more than one, regardless of the run's eligibility outcome.
// ===========================================================================
export type RecoveryOutcome =
  | { kind: 'dry_run'; preview: ExtractionRunPreview; idempotencyKeyPreview: string }
  | { kind: 'created'; reviewRequestIdPrefix: string; generation: number; status: string; expiresAt: string }
  | { kind: 'replayed'; reviewRequestIdPrefix: string; generation: number; status: string; expiresAt: string }
  | { kind: 'ineligible'; reasonCode: string }
  | { kind: 'blocked'; reasonCode: string }
  | { kind: 'configuration_error'; message: string }
  | { kind: 'database_error'; operation: string }

export interface RunPostCompletionReviewRecoveryInput {
  extractionRunId: string
  dryRun: boolean
}

export async function runPostCompletionReviewRecovery(
  client: SemanticTopicAdminClient,
  input: RunPostCompletionReviewRecoveryInput,
): Promise<RecoveryOutcome> {
  const previewResult = await fetchExtractionRunPreview(client, input.extractionRunId)
  if (!previewResult.ok) return { kind: 'configuration_error', message: previewResult.message }
  const { preview } = previewResult

  if (preview.status !== 'completed') {
    // preview.status is a closed, small DB enum value (never caller input,
    // never free text) -- safe to include verbatim; it can never itself
    // contain a UUID or secret.
    return { kind: 'configuration_error', message: `extraction_run is not completed (status=${preview.status})` }
  }

  // Byte-identical to what the live hook would derive for this exact run --
  // imported unchanged from human-review-extraction-hook.ts, never
  // reimplemented here.
  const idempotencyKey = deriveHumanReviewIdempotencyKey(input.extractionRunId)

  if (input.dryRun) {
    return { kind: 'dry_run', preview, idempotencyKeyPreview: idempotencyKey.slice(0, 24) + '…' }
  }

  // The one, and only, RPC call this module ever makes.
  const result = await createReviewRequest({ extractionRunId: input.extractionRunId, idempotencyKey }, client)

  switch (result.outcome) {
    case 'success':
      return {
        kind: result.outcomeKind,
        reviewRequestIdPrefix: result.reviewRequestId.slice(0, 8),
        generation: result.generation,
        status: result.status,
        expiresAt: result.expiresAt,
      }
    case 'blocked':
      return { kind: 'blocked', reasonCode: result.reasonCode }
    case 'ineligible':
      return { kind: 'ineligible', reasonCode: result.reasonCode }
    case 'database_error':
      return { kind: 'database_error', operation: result.operation }
    case 'invalid_rpc_response':
      return { kind: 'database_error', operation: result.operation }
  }
}

export function exitCodeForOutcome(outcome: RecoveryOutcome): RecoveryExitCode {
  switch (outcome.kind) {
    case 'dry_run':
    case 'created':
    case 'replayed':
      return RECOVERY_EXIT_CODE.OK
    case 'ineligible':
      return RECOVERY_EXIT_CODE.INELIGIBLE
    case 'blocked':
      return RECOVERY_EXIT_CODE.BLOCKED
    case 'configuration_error':
      return RECOVERY_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    case 'database_error':
      return RECOVERY_EXIT_CODE.UNEXPECTED_ERROR
  }
}
