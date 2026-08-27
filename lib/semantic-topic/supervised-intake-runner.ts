// PFM Supervised Production Candidate Intake v0 -- service-only, one-shot
// runner orchestration core.
//
// This module is the ONLY code path in this codebase that calls the seven
// state-mutating 079 RPCs (create_supervised_intake_batch,
// claim_next_intake_item, begin_intake_attempt_call,
// complete_intake_item_success, fail_intake_item, stop_intake_batch,
// finalize_intake_batch) as an orchestrated sequence. It never writes
// directly to any supervised_intake_* table, never calls
// configure_supervised_intake_control (control is an explicit, separate
// operator action, never something this runner turns on for itself), and
// never calls reconcile_stale_intake_claims / resolve_intake_attempt_reconciliation /
// authorize_intake_item_retry / cancel_intake_batch -- those are reserved
// for a separate, explicitly-audited operator action, never something a
// one-shot runner invocation may trigger on its own.
//
// Everything here is dependency-injected (client, the runShadowExtraction
// adapter, the claim-state store, the logger, the clock) so the whole
// orchestration can be unit-tested with zero real DB and zero real provider
// call -- see tests/supervised-intake-runner.test.ts. The CLI entry
// (scripts/supervised-intake-runner.ts) wires the REAL implementations of
// every one of these.
import { randomUUID, createHash } from 'node:crypto'
import type { EvidenceForExtraction } from './normalize'
import type { ShadowExtractionInput, ShadowExtractionResult } from './extraction-service'
import type { HumanReviewOrchestrationResult } from './human-review-extraction-hook'
import { computeExtractionConfigDigest } from './digest'
import type { SemanticTopicAdminClient } from './quota-types'
import {
  CLAIM_STATE_FILE_VERSION,
  EXIT_CODE,
  SEMANTIC_TOPIC_EXTRACTION_USAGE_TYPE,
  redactClaimState,
  type ClaimStateFile,
  type RunnerExitCode,
  type SupervisedIntakeBatchInput,
} from './supervised-intake-types'

// ===========================================================================
// Logger
// ===========================================================================

export interface RunnerLogEvent {
  level: 'info' | 'warn' | 'error'
  message: string
  fields?: Record<string, unknown>
}

export interface RunnerLogger {
  log(event: RunnerLogEvent): void
}

// Fields that must NEVER reach a log line, checked defensively at the
// logger boundary itself (belt-and-suspenders on top of every call site
// already being written to never pass these) -- see section 10's explicit
// deny-list.
const NEVER_LOGGED_FIELD_NAMES = new Set([
  'claimtoken', 'claim_token', 'servicerolekey', 'service_role_key',
  'authorization', 'apikey', 'api_key', 'idempotencykey', 'idempotency_key',
  'password', 'secret', 'token',
])

function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return fields
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = NEVER_LOGGED_FIELD_NAMES.has(key.toLowerCase()) ? '[redacted]' : value
  }
  return out
}

export function createConsoleLogger(): RunnerLogger {
  return {
    log(event) {
      const line = JSON.stringify({ ts: new Date().toISOString(), level: event.level, message: event.message, ...redactFields(event.fields) })
      if (event.level === 'error') console.error(line)
      else console.log(line)
    },
  }
}

// ===========================================================================
// Claim-state store (section 7) -- atomic temp-file-then-rename, redacted
// logging only, never committed (see .gitignore).
// ===========================================================================

export interface ClaimStateStore {
  read(): Promise<ClaimStateFile | null>
  write(state: ClaimStateFile): Promise<void>
  clear(): Promise<void>
}

// Real, file-backed implementation. Kept dependency-free (only node:fs and
// node:path) so it never needs a new package. Uses write-to-temp then
// atomic rename (fs.rename is atomic on the same filesystem on both POSIX
// and Windows/NTFS) so a crash mid-write can never leave a half-written,
// corrupt state file behind -- either the old file is untouched or the new
// one is fully in place.
export async function createFileClaimStateStore(filePath: string): Promise<ClaimStateStore> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const tmpPath = `${filePath}.tmp-${process.pid}`

  return {
    async read() {
      try {
        const raw = await fs.readFile(filePath, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (
          parsed && typeof parsed === 'object' &&
          (parsed as Record<string, unknown>).version === CLAIM_STATE_FILE_VERSION
        ) {
          return parsed as ClaimStateFile
        }
        return null
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    async write(state) {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const serialized = JSON.stringify(state, null, 2)
      await fs.writeFile(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(tmpPath, filePath)
      try {
        await fs.chmod(filePath, 0o600)
      } catch {
        // Best-effort on platforms (e.g. Windows/NTFS via some drivers)
        // where chmod cannot narrow permissions further -- never fatal.
      }
    },
    async clear() {
      try {
        await fs.unlink(filePath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    },
  }
}

// ===========================================================================
// RPC wrappers -- typed, minimal, matching the ai-quota.ts convention
// (discriminated ok/error result, never a raw throw for an expected
// business-rule rejection).
// ===========================================================================

export interface RpcFailure {
  ok: false
  operation: string
  message: string
}

async function callRpc<T = unknown>(
  client: SemanticTopicAdminClient,
  operation: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: T } | RpcFailure> {
  try {
    const { data, error } = await client.rpc(operation, args)
    if (error) return { ok: false, operation, message: error.message }
    return { ok: true, data: data as T }
  } catch (err) {
    return { ok: false, operation, message: err instanceof Error ? err.message : String(err) }
  }
}

interface CreateBatchResponse { ok: true; batch_id: string; status: string; extraction_config_digest: string }
interface ClaimResponseClaimed {
  ok: true; outcome: 'claimed'; item_id: string; attempt_id: string; signal_evidence_id: string
  claim_token: string; claim_token_available: true; fencing_generation: number; lease_expires_at: string
}
interface ClaimResponseNoMoreItems { ok: true; outcome: 'no_more_items' }
interface ClaimResponseBatchStopped { ok: true; outcome: 'batch_stopped'; reason_code: string }
type ClaimResponse = ClaimResponseClaimed | ClaimResponseNoMoreItems | ClaimResponseBatchStopped
interface BeginAttemptResponse { ok: true; attempt_id: string; base_idempotency_key: string; status: 'calling' }
interface CompleteItemResponse { ok: true; item_id: string; status: 'succeeded' }
interface FailItemResponse { ok: true; item_id: string; status: 'failed'; retryable: boolean }
interface StopBatchResponse { ok: true; batch_id: string; closed_pending_items: number }
interface FinalizeBatchResponse { ok: true; batch_id: string; status: string }

export async function createSupervisedIntakeBatch(
  client: SemanticTopicAdminClient,
  input: SupervisedIntakeBatchInput,
): Promise<{ ok: true; batchId: string; status: string; extractionConfigDigest: string } | RpcFailure> {
  const result = await callRpc<CreateBatchResponse>(client, 'create_supervised_intake_batch', {
    p_evidence_ids: input.signalEvidenceIds,
    p_operator_reference: input.operatorReference,
    p_provider: input.provider,
    p_usage_type: SEMANTIC_TOPIC_EXTRACTION_USAGE_TYPE,
    p_model: input.model,
    p_normalization_version: input.normalizationVersion,
    p_extraction_schema_version: input.extractionSchemaVersion,
    p_prompt_version: input.promptVersion,
    p_deterministic_extractor_version: input.deterministicExtractorVersion,
    p_idempotency_key: input.idempotencyKey,
  })
  if (!result.ok) return result
  return { ok: true, batchId: result.data.batch_id, status: result.data.status, extractionConfigDigest: result.data.extraction_config_digest }
}

export async function claimNextIntakeItem(
  client: SemanticTopicAdminClient,
  batchId: string,
  idempotencyKey: string,
): Promise<{ ok: true; data: ClaimResponse } | RpcFailure> {
  const result = await callRpc<ClaimResponse>(client, 'claim_next_intake_item', {
    p_batch_id: batchId,
    p_idempotency_key: idempotencyKey,
  })
  if (!result.ok) return result
  return { ok: true, data: result.data }
}

export async function beginIntakeAttemptCall(
  client: SemanticTopicAdminClient,
  itemId: string,
  claimToken: string,
  idempotencyKey: string,
): Promise<{ ok: true; attemptId: string; baseIdempotencyKey: string } | RpcFailure> {
  const result = await callRpc<BeginAttemptResponse>(client, 'begin_intake_attempt_call', {
    p_item_id: itemId,
    p_claim_token: claimToken,
    p_idempotency_key: idempotencyKey,
  })
  if (!result.ok) return result
  return { ok: true, attemptId: result.data.attempt_id, baseIdempotencyKey: result.data.base_idempotency_key }
}

export async function completeIntakeItemSuccess(
  client: SemanticTopicAdminClient,
  args: { itemId: string; claimToken: string; providerReservationId: string | null; extractionRunId: string; reviewRequestId: string | null; idempotencyKey: string },
): Promise<{ ok: true } | RpcFailure> {
  const result = await callRpc<CompleteItemResponse>(client, 'complete_intake_item_success', {
    p_item_id: args.itemId,
    p_claim_token: args.claimToken,
    p_provider_reservation_id: args.providerReservationId,
    p_extraction_run_id: args.extractionRunId,
    p_review_request_id: args.reviewRequestId,
    p_idempotency_key: args.idempotencyKey,
  })
  if (!result.ok) return result
  return { ok: true }
}

export async function failIntakeItem(
  client: SemanticTopicAdminClient,
  args: { itemId: string; claimToken: string; reasonCode: string; retryable: boolean; diagnosticCode: string | null; idempotencyKey: string },
): Promise<{ ok: true; retryable: boolean } | RpcFailure> {
  const result = await callRpc<FailItemResponse>(client, 'fail_intake_item', {
    p_item_id: args.itemId,
    p_claim_token: args.claimToken,
    p_reason_code: args.reasonCode,
    p_retryable: args.retryable,
    p_diagnostic_code: args.diagnosticCode,
    p_idempotency_key: args.idempotencyKey,
  })
  if (!result.ok) return result
  return { ok: true, retryable: result.data.retryable }
}

export async function stopIntakeBatch(
  client: SemanticTopicAdminClient,
  batchId: string,
  reasonCode: string,
  idempotencyKey: string,
): Promise<{ ok: true; closedPendingItems: number } | RpcFailure> {
  const result = await callRpc<StopBatchResponse>(client, 'stop_intake_batch', {
    p_batch_id: batchId,
    p_reason_code: reasonCode,
    p_idempotency_key: idempotencyKey,
  })
  if (!result.ok) return result
  return { ok: true, closedPendingItems: result.data.closed_pending_items }
}

export async function finalizeIntakeBatch(
  client: SemanticTopicAdminClient,
  batchId: string,
  idempotencyKey: string,
): Promise<{ ok: true; status: string } | RpcFailure> {
  const result = await callRpc<FinalizeBatchResponse>(client, 'finalize_intake_batch', {
    p_batch_id: batchId,
    p_idempotency_key: idempotencyKey,
  })
  if (!result.ok) return result
  return { ok: true, status: result.data.status }
}

// ===========================================================================
// Evidence fetch -- the ONLY direct table read this runner performs against
// application tables outside the 079 surface, and it is a plain SELECT
// (service_role already has full SELECT on signal_evidence from earlier
// migrations; nothing here needs a new grant).
// ===========================================================================

export async function fetchEvidenceForExtraction(
  client: SemanticTopicAdminClient,
  signalEvidenceId: string,
): Promise<{ ok: true; evidence: EvidenceForExtraction } | { ok: false; message: string }> {
  const { data, error } = await client
    .from('signal_evidence')
    .select('title, snippet, canonical_url, published_at')
    .eq('id', signalEvidenceId)
    .maybeSingle()
  if (error) return { ok: false, message: error.message }
  if (!data) return { ok: false, message: `signal_evidence ${signalEvidenceId} not found` }
  const row = data as { title: string; snippet: string | null; canonical_url: string | null; published_at: string | null }
  return {
    ok: true,
    evidence: { title: row.title, snippet: row.snippet, canonicalUrl: row.canonical_url, publishedAt: row.published_at },
  }
}

// ===========================================================================
// Structured extraction-outcome mapping (section 6) -- one exhaustive
// TypeScript switch over ShadowExtractionResult['outcome'], never a regex
// or message.includes() for business/security branching. A future outcome
// variant added to ShadowExtractionResult without updating this switch is a
// COMPILE ERROR (see the `never` assertion in the default branch), not a
// silent fail-open.
//
// Charged-failure retry policy: authorize_intake_item_retry (079) has no
// concept of "was this attempt actually billed" -- it only ever checks the
// item's stored (status='failed', retryable=true) pair, which THIS function
// is the sole author of. That makes `retryable` here the entire safety
// boundary for whether a later, separately-authorized operator action could
// ever trigger a fresh paid provider call for this item:
//   - not-yet-started / never-billed attempts (input_too_large,
//     provider_rejected_unbilled, budget_exhausted, disabled_or_rejected,
//     attempt_not_started) -> may be retryable=true; no confirmed spend.
//   - a charged/potentially-charged failed attempt (malformed_output --
//     extraction-service.ts commits real, non-zero token usage before
//     validating output shape) -> always retryable=false. A future paid
//     retry needs its own explicit financial/operator authorization and a
//     cost-aware RPC contract that does not exist in v0 -- never something
//     this runner grants on its own.
//   - uncertain (committed_unknown) -> never resolved by fail_intake_item
//     at all (see the 'uncertain' case below) -- reconciliation_required,
//     never retryable through this path either.
// ===========================================================================

export type ItemOutcomeDecision =
  | { kind: 'succeed'; providerReservationId: string | null; extractionRunId: string; reviewRequestId: string | null }
  | { kind: 'fail_item_continue'; reasonCode: string; retryable: boolean; diagnosticCode: string }
  | { kind: 'fail_item_and_stop_batch'; reasonCode: string; retryable: boolean; diagnosticCode: string; stopReasonCode: string }
  | { kind: 'stop_batch_only'; stopReasonCode: string }

const DIAGNOSTIC_CODE_MAX_LENGTH = 64

// Bounds and sanitizes a diagnostic code to the 079 CHECK's exact charset
// (^[A-Za-z0-9_.:-]*$) and length -- defensive even though every current
// input to this function is already a known-safe closed value.
function sanitizeDiagnosticCode(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, '_')
  return cleaned.slice(0, DIAGNOSTIC_CODE_MAX_LENGTH)
}

function reviewRequestIdFrom(humanReview: HumanReviewOrchestrationResult): string | null {
  if (humanReview.outcome === 'created' || humanReview.outcome === 'replayed') {
    return humanReview.reviewRequestId
  }
  return null
}

export function decideItemOutcome(result: ShadowExtractionResult): ItemOutcomeDecision {
  switch (result.outcome) {
    case 'completed':
      return {
        kind: 'succeed',
        providerReservationId: result.reservationId,
        extractionRunId: result.extractionRunId,
        reviewRequestId: reviewRequestIdFrom(result.humanReview),
      }

    case 'cache_hit':
      return {
        kind: 'succeed',
        providerReservationId: null,
        extractionRunId: result.extractionRunId,
        reviewRequestId: reviewRequestIdFrom(result.humanReview),
      }

    case 'input_too_large':
      // Deterministic property of this evidence item under this config --
      // retrying the identical evidence+config would always reproduce the
      // same rejection, so never retryable. Item-local, batch continues.
      return { kind: 'fail_item_continue', reasonCode: 'INVALID_EVIDENCE_STATE', retryable: false, diagnosticCode: 'input_too_large' }

    case 'failed':
      // failed's errorClass is, in practice, always exactly one of these
      // two values (see extraction-service.ts: the ONLY two paths that
      // return 'failed' are the definitely-unbilled provider rejection and
      // the malformed/unparseable-output validation failure) -- a third,
      // future value is handled by the fail-closed default below, batch-
      // fatal rather than silently treated as item-local.
      if (result.errorClass === 'malformed_output') {
        // A real, CHARGED attempt (extraction-service.ts commits the
        // provider's actual, non-zero token usage before validating its
        // output shape) whose output then failed strict validation --
        // item-local, batch continues, but retryable=false: charged-failure
        // retry policy (see this function's header) requires any billed or
        // potentially-billed failed attempt to default to non-retryable,
        // because authorize_intake_item_retry (079) has no cost-awareness
        // of its own -- it only ever checks this stored retryable flag, so
        // this flag IS the entire safety boundary. A future, separately
        // and explicitly authorized paid retry is deliberately out of
        // scope for v0; this item stays terminal (failed_terminal) until
        // then. INVALID_STRUCTURED_OUTPUT mirrors 078's own reuse of this
        // exact code for the identical underlying condition.
        return { kind: 'fail_item_continue', reasonCode: 'INVALID_STRUCTURED_OUTPUT', retryable: false, diagnosticCode: 'malformed_output' }
      }
      if (result.errorClass === 'provider_rejected_unbilled') {
        // A confirmed pre-generation provider rejection (4xx) -- real,
        // charged (zero-cost) attempt, item-local, batch continues; a
        // fresh attempt later may succeed once whatever the provider
        // objected to is addressed.
        return { kind: 'fail_item_continue', reasonCode: 'INVALID_EVIDENCE_STATE', retryable: true, diagnosticCode: 'provider_rejected_unbilled' }
      }
      // Unknown future errorClass: fail closed, treat as batch-fatal rather
      // than risk silently continuing under an unrecognized failure mode.
      return {
        kind: 'fail_item_and_stop_batch',
        reasonCode: 'INVALID_EVIDENCE_STATE',
        retryable: false,
        diagnosticCode: sanitizeDiagnosticCode(`unrecognized_error_class_${result.errorClass}`),
        stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR',
      }

    case 'disabled_or_rejected':
      // Reservation-layer rejection BEFORE any provider call -- reasonCode
      // is one of the closed ExtractionRejectionReasonCode values (never
      // parsed from free text, see extraction-service.ts). Treated as
      // batch-fatal: this class of rejection (control disabled, malformed
      // RPC args, a genuine DB error) is far more likely to affect every
      // remaining item in the batch identically than to be evidence-
      // specific. The kill switch gets its own stop_reason_code
      // (AI_EXTRACTION_DISABLED, already a valid 079 stop_intake_batch
      // reason -- see migration 079's stop_intake_batch reason_code CHECK)
      // instead of the generic AUTHORIZATION_OR_CONFIG_ERROR every other
      // reasonCode still maps to, purely by switching on the closed
      // reasonCode discriminant -- never by inspecting `message`.
      return {
        kind: 'fail_item_and_stop_batch',
        reasonCode: 'INVALID_EVIDENCE_STATE',
        retryable: true,
        diagnosticCode: sanitizeDiagnosticCode(`disabled_or_rejected_${result.reasonCode}`),
        stopReasonCode: result.reasonCode === 'ai_extraction_disabled' ? 'AI_EXTRACTION_DISABLED' : 'AUTHORIZATION_OR_CONFIG_ERROR',
      }

    case 'budget_exhausted':
      return {
        kind: 'fail_item_and_stop_batch',
        reasonCode: 'INVALID_EVIDENCE_STATE',
        retryable: true,
        diagnosticCode: 'budget_exhausted',
        stopReasonCode: 'BUDGET_EXHAUSTED',
      }

    case 'attempt_not_started':
      return {
        kind: 'fail_item_and_stop_batch',
        reasonCode: 'INVALID_EVIDENCE_STATE',
        retryable: true,
        diagnosticCode: sanitizeDiagnosticCode(`attempt_not_started_${result.reasonCode}`),
        stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR',
      }

    case 'uncertain':
      // The provider call's true outcome is genuinely unknown -- never
      // fail_intake_item here (that would be a caller ASSERTION about an
      // outcome nobody actually confirmed). The attempt stays 'calling'
      // until its lease expires and a separate, explicit reconciliation
      // pass resolves it. This runner only stops the batch; it never
      // itself calls reconcile_stale_intake_claims or
      // resolve_intake_attempt_reconciliation.
      return { kind: 'stop_batch_only', stopReasonCode: 'PROVIDER_OUTCOME_UNCERTAIN' }

    default: {
      // Exhaustiveness guard: if ShadowExtractionResult ever gains a new
      // outcome variant without this switch being updated, this line fails
      // to compile (result would not be `never`) -- never a silent runtime
      // fail-open to an unhandled case.
      const _exhaustive: never = result
      throw new Error(`decideItemOutcome: unhandled ShadowExtractionResult outcome: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

// ===========================================================================
// Orchestration deps + main entry points
// ===========================================================================

export interface SupervisedIntakeRunnerDeps {
  client: SemanticTopicAdminClient
  runShadowExtraction: (input: ShadowExtractionInput) => Promise<ShadowExtractionResult>
  claimStateStore: ClaimStateStore
  logger: RunnerLogger
}

export interface RunSupervisedIntakeResult {
  exitCode: RunnerExitCode
  summary: string
}

// ---------------------------------------------------------------------------
// Dry-run (section 4): validation + digest preview + env/DB/policy read-only
// checks. Never creates a batch, never claims, never calls the provider,
// never writes anything.
// ---------------------------------------------------------------------------

const REQUIRED_ENV_VARS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const

export interface DryRunReport {
  ok: boolean
  evidenceCount: number
  extractionConfigDigest: string
  extractionConfigDigestPreview: string
  requestDigestPreview: string
  envVarsPresent: Record<string, boolean>
  dbReachable: boolean
  policy: { enabled: boolean; maxBatchItems: number; maxDailyClaimedItems: number } | null
  aiExtractionControlEnabled: boolean | null
  errors: string[]
}

function shortDigest(digest: string): string {
  return digest.slice(0, 12) + '…'
}

export async function runDryRun(
  deps: Pick<SupervisedIntakeRunnerDeps, 'client' | 'logger'>,
  input: SupervisedIntakeBatchInput,
): Promise<{ result: RunSupervisedIntakeResult; report: DryRunReport }> {
  const errors: string[] = []

  const extractionConfigDigest = computeExtractionConfigDigest({
    normalizationVersion: input.normalizationVersion,
    extractionSchemaVersion: input.extractionSchemaVersion,
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion,
  })
  // A local, runner-side preview digest over the batch shape itself
  // (idempotency key + operator + sorted evidence ids) -- deliberately NOT
  // claimed to be byte-identical to create_supervised_intake_batch's own
  // internal request_digest (a private, server-side idempotency-ledger
  // value this runner has no need to reproduce exactly); it exists purely
  // so an operator can visually confirm two runs of the same file produce
  // the same preview before either one ever touches the DB.
  const sortedIds = [...input.signalEvidenceIds].sort()
  const requestDigestPreview = sha256HexLocal(
    JSON.stringify({ idempotencyKey: input.idempotencyKey, operatorReference: input.operatorReference, evidenceIds: sortedIds }),
  )

  const envVarsPresent: Record<string, boolean> = {}
  for (const name of REQUIRED_ENV_VARS) {
    envVarsPresent[name] = typeof process.env[name] === 'string' && process.env[name]!.length > 0
  }
  for (const [name, present] of Object.entries(envVarsPresent)) {
    if (!present) errors.push(`Required environment variable ${name} is not set.`)
  }

  let dbReachable = false
  let policy: DryRunReport['policy'] = null
  let aiExtractionControlEnabled: boolean | null = null
  try {
    const { data: policyRow, error: policyError } = await deps.client
      .from('supervised_intake_control')
      .select('enabled, max_batch_items, max_daily_claimed_items')
      .eq('id', 1)
      .maybeSingle()
    if (policyError) {
      errors.push(`Could not read supervised_intake_control: ${policyError.message}`)
    } else if (policyRow) {
      dbReachable = true
      const row = policyRow as { enabled: boolean; max_batch_items: number; max_daily_claimed_items: number }
      policy = { enabled: row.enabled, maxBatchItems: row.max_batch_items, maxDailyClaimedItems: row.max_daily_claimed_items }
    }
    const { data: controlRow, error: controlError } = await deps.client
      .from('ai_extraction_control')
      .select('enabled')
      .eq('id', 1)
      .maybeSingle()
    if (controlError) {
      errors.push(`Could not read ai_extraction_control: ${controlError.message}`)
    } else if (controlRow) {
      dbReachable = true
      aiExtractionControlEnabled = (controlRow as { enabled: boolean }).enabled
    }
  } catch (err) {
    errors.push(`DB connectivity check failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (policy && !policy.enabled) errors.push('supervised_intake_control.enabled is false -- a real run would be stopped immediately by claim_next_intake_item.')
  if (aiExtractionControlEnabled === false) errors.push('ai_extraction_control.enabled is false -- a real run would reject every reservation.')

  const report: DryRunReport = {
    ok: errors.length === 0,
    evidenceCount: input.signalEvidenceIds.length,
    extractionConfigDigest,
    extractionConfigDigestPreview: shortDigest(extractionConfigDigest),
    requestDigestPreview: shortDigest(requestDigestPreview),
    envVarsPresent,
    dbReachable,
    policy,
    aiExtractionControlEnabled,
    errors,
  }

  deps.logger.log({
    level: report.ok ? 'info' : 'warn',
    message: 'dry-run report',
    fields: {
      ok: report.ok,
      evidenceCount: report.evidenceCount,
      extractionConfigDigestPreview: report.extractionConfigDigestPreview,
      requestDigestPreview: report.requestDigestPreview,
      envVarsPresent: report.envVarsPresent,
      dbReachable: report.dbReachable,
      policy: report.policy,
      aiExtractionControlEnabled: report.aiExtractionControlEnabled,
      errors: report.errors,
    },
  })

  return {
    result: {
      exitCode: report.ok ? EXIT_CODE.COMPLETED : EXIT_CODE.VALIDATION_OR_CONFIG_ERROR,
      summary: report.ok ? 'dry-run passed: batch is ready for a real run' : `dry-run found ${errors.length} problem(s)`,
    },
    report,
  }
}

function sha256HexLocal(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Real run (section 5) -- the canonical orchestration sequence.
// ---------------------------------------------------------------------------

interface ProcessItemOutcome {
  stopBatch: boolean
  stopReasonCode?: string
}

async function processClaimedItem(
  deps: SupervisedIntakeRunnerDeps,
  state: ClaimStateFile,
  log: RunnerLogger,
): Promise<ProcessItemOutcome> {
  const correlationId = randomUUID()
  log.log({ level: 'info', message: 'beginning intake attempt call', fields: { ...redactClaimState(state), correlationId } })

  const begin = await beginIntakeAttemptCall(deps.client, state.itemId, state.claimToken, `${state.itemId}:begin`)
  if (!begin.ok) {
    log.log({ level: 'error', message: 'begin_intake_attempt_call failed', fields: { operation: begin.operation, error: begin.message, correlationId } })
    return { stopBatch: true, stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR' }
  }

  const evidence = await fetchEvidenceForExtraction(deps.client, state.signalEvidenceId)
  if (!evidence.ok) {
    log.log({ level: 'error', message: 'evidence fetch failed', fields: { signalEvidenceId: state.signalEvidenceId, error: evidence.message, correlationId } })
    const fail = await failIntakeItem(deps.client, {
      itemId: state.itemId, claimToken: state.claimToken, reasonCode: 'EVIDENCE_NOT_FOUND',
      retryable: false, diagnosticCode: sanitizeDiagnosticCode('evidence_fetch_failed'), idempotencyKey: `${state.itemId}:fail`,
    })
    if (!fail.ok) log.log({ level: 'error', message: 'fail_intake_item failed after evidence fetch error', fields: { operation: fail.operation, error: fail.message, correlationId } })
    await deps.claimStateStore.clear()
    return { stopBatch: true, stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR' }
  }

  log.log({ level: 'info', message: 'calling runShadowExtraction', fields: { itemId: state.itemId, attemptId: state.attemptId, correlationId } })
  const extraction = await deps.runShadowExtraction({
    signalEvidenceId: state.signalEvidenceId,
    evidence: evidence.evidence,
    idempotencyKey: begin.baseIdempotencyKey,
    client: deps.client,
  })

  const decision = decideItemOutcome(extraction)
  log.log({
    level: 'info',
    message: 'extraction outcome decided',
    fields: { itemId: state.itemId, extractionOutcome: extraction.outcome, decisionKind: decision.kind, correlationId },
  })

  if (decision.kind === 'stop_batch_only') {
    // 'calling' is left exactly as-is: this attempt's true provider
    // outcome is unknown, so it is never resolved by this runner. Local
    // claim state is intentionally PRESERVED (not cleared) so a later,
    // separate reconciliation pass -- or a forensic read of this file --
    // still has the item/attempt/batch identifiers available.
    return { stopBatch: true, stopReasonCode: decision.stopReasonCode }
  }

  if (decision.kind === 'succeed') {
    const complete = await completeIntakeItemSuccess(deps.client, {
      itemId: state.itemId, claimToken: state.claimToken,
      providerReservationId: decision.providerReservationId, extractionRunId: decision.extractionRunId,
      reviewRequestId: decision.reviewRequestId, idempotencyKey: `${state.itemId}:complete`,
    })
    if (!complete.ok) {
      log.log({ level: 'error', message: 'complete_intake_item_success failed', fields: { operation: complete.operation, error: complete.message, correlationId } })
      return { stopBatch: true, stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR' }
    }
    await deps.claimStateStore.clear()
    return { stopBatch: false }
  }

  // fail_item_continue or fail_item_and_stop_batch -- both resolve the item.
  const fail = await failIntakeItem(deps.client, {
    itemId: state.itemId, claimToken: state.claimToken, reasonCode: decision.reasonCode,
    retryable: decision.retryable, diagnosticCode: decision.diagnosticCode, idempotencyKey: `${state.itemId}:fail`,
  })
  if (!fail.ok) {
    log.log({ level: 'error', message: 'fail_intake_item failed', fields: { operation: fail.operation, error: fail.message, correlationId } })
    return { stopBatch: true, stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR' }
  }
  await deps.claimStateStore.clear()

  if (decision.kind === 'fail_item_and_stop_batch') {
    return { stopBatch: true, stopReasonCode: decision.stopReasonCode }
  }
  return { stopBatch: false }
}

// Restart-resume decision for a claim-state file found on disk at startup
// (section 7). Always re-reads the CURRENT DB status -- the local file is
// never trusted blindly, since a separate reconciliation pass may already
// have resolved this attempt since the file was written.
export type ResumeDecision =
  | { kind: 'resumable_prepared' }
  | { kind: 'blocked_calling' }
  | { kind: 'blocked_needs_reconciliation' }
  | { kind: 'stale_resolved' }
  | { kind: 'not_found' }

export async function resolveResumeState(
  client: SemanticTopicAdminClient,
  state: ClaimStateFile,
): Promise<ResumeDecision> {
  const { data: attemptRow, error: attemptError } = await client
    .from('supervised_intake_attempts')
    .select('status')
    .eq('id', state.attemptId)
    .maybeSingle()
  if (attemptError) throw new Error(`resolveResumeState: could not read supervised_intake_attempts: ${attemptError.message}`)
  if (!attemptRow) return { kind: 'not_found' }

  const status = (attemptRow as { status: string }).status
  switch (status) {
    case 'prepared':
      return { kind: 'resumable_prepared' }
    case 'calling':
      return { kind: 'blocked_calling' }
    case 'reconciliation_required':
      return { kind: 'blocked_needs_reconciliation' }
    case 'completed':
    case 'failed_retryable':
    case 'failed_terminal':
      return { kind: 'stale_resolved' }
    default:
      return { kind: 'blocked_needs_reconciliation' }
  }
}

export async function runSupervisedIntake(
  deps: SupervisedIntakeRunnerDeps,
  input: SupervisedIntakeBatchInput,
  abortSignal?: AbortSignal,
): Promise<RunSupervisedIntakeResult> {
  const log = deps.logger

  // --- Restart-resume check (section 7) -----------------------------------
  const existingState = await deps.claimStateStore.read()
  let batchId: string | null = null
  if (existingState) {
    const resume = await resolveResumeState(deps.client, existingState)
    log.log({ level: 'info', message: 'found existing local claim state on startup', fields: { ...redactClaimState(existingState), resumeDecision: resume.kind } })

    if (resume.kind === 'blocked_calling') {
      log.log({ level: 'error', message: 'attempt is in calling state -- true provider outcome unknown, this runner will never re-call the provider for it. Requires reconciliation via reconcile_stale_intake_claims (after lease expiry) and resolve_intake_attempt_reconciliation, both separate operator actions.', fields: redactClaimState(existingState) })
      return { exitCode: EXIT_CODE.RECONCILIATION_REQUIRED, summary: `attempt ${existingState.attemptId} requires reconciliation before this runner can proceed` }
    }
    if (resume.kind === 'blocked_needs_reconciliation' || resume.kind === 'not_found') {
      log.log({ level: 'error', message: 'existing local claim state cannot be safely resumed', fields: { ...redactClaimState(existingState), resumeDecision: resume.kind } })
      return { exitCode: EXIT_CODE.RECONCILIATION_REQUIRED, summary: `local claim state for attempt ${existingState.attemptId} cannot be resumed (${resume.kind})` }
    }
    if (resume.kind === 'stale_resolved') {
      log.log({ level: 'info', message: 'existing local claim state was already resolved server-side -- clearing stale local file', fields: redactClaimState(existingState) })
      await deps.claimStateStore.clear()
    }
    if (resume.kind === 'resumable_prepared') {
      log.log({ level: 'info', message: 'resuming a claimed item at the begin-call step (never re-claims, never re-calls the provider for a prior attempt)', fields: redactClaimState(existingState) })
      batchId = existingState.batchId
      const outcome = await processClaimedItem(deps, existingState, log)
      if (outcome.stopBatch) {
        const stop = await stopIntakeBatch(deps.client, batchId, outcome.stopReasonCode ?? 'AUTHORIZATION_OR_CONFIG_ERROR', `${input.idempotencyKey}:stop:${outcome.stopReasonCode}`)
        if (!stop.ok) log.log({ level: 'error', message: 'stop_intake_batch failed', fields: { operation: stop.operation, error: stop.message } })
        return { exitCode: outcome.stopReasonCode === 'PROVIDER_OUTCOME_UNCERTAIN' ? EXIT_CODE.RECONCILIATION_REQUIRED : EXIT_CODE.BATCH_STOPPED, summary: `batch ${batchId} stopped: ${outcome.stopReasonCode}` }
      }
    }
  }

  // --- 1. create_supervised_intake_batch -----------------------------------
  if (batchId === null) {
    const created = await createSupervisedIntakeBatch(deps.client, input)
    if (!created.ok) {
      log.log({ level: 'error', message: 'create_supervised_intake_batch failed', fields: { operation: created.operation, error: created.message } })
      return { exitCode: EXIT_CODE.VALIDATION_OR_CONFIG_ERROR, summary: `create_supervised_intake_batch failed: ${created.message}` }
    }
    batchId = created.batchId
    log.log({ level: 'info', message: 'batch created', fields: { batchId, status: created.status, extractionConfigDigestPreview: shortDigest(created.extractionConfigDigest) } })
  }

  // --- 2-10. claim -> persist -> begin -> extract -> resolve loop ----------
  while (true) {
    if (abortSignal?.aborted) {
      log.log({ level: 'warn', message: 'shutdown signal received -- not claiming a new item', fields: { batchId } })
      return { exitCode: EXIT_CODE.BATCH_STOPPED, summary: `batch ${batchId} left running (no new item claimed) due to shutdown signal` }
    }

    const claim = await claimNextIntakeItem(deps.client, batchId, `${batchId}:claim:${randomUUID()}`)
    if (!claim.ok) {
      log.log({ level: 'error', message: 'claim_next_intake_item failed', fields: { operation: claim.operation, error: claim.message, batchId } })
      return { exitCode: EXIT_CODE.UNEXPECTED_INTERNAL_ERROR, summary: `claim_next_intake_item failed: ${claim.message}` }
    }

    if (claim.data.outcome === 'batch_stopped') {
      log.log({ level: 'warn', message: 'batch was stopped by the policy itself', fields: { batchId, reasonCode: claim.data.reason_code } })
      return { exitCode: EXIT_CODE.BATCH_STOPPED, summary: `batch ${batchId} stopped by policy: ${claim.data.reason_code}` }
    }

    if (claim.data.outcome === 'no_more_items') {
      const finalized = await finalizeIntakeBatch(deps.client, batchId, `${input.idempotencyKey}:finalize`)
      if (!finalized.ok) {
        log.log({ level: 'error', message: 'finalize_intake_batch failed', fields: { operation: finalized.operation, error: finalized.message, batchId } })
        return { exitCode: EXIT_CODE.UNEXPECTED_INTERNAL_ERROR, summary: `finalize_intake_batch failed: ${finalized.message}` }
      }
      log.log({ level: 'info', message: 'batch finalized', fields: { batchId, status: finalized.status } })
      return { exitCode: EXIT_CODE.COMPLETED, summary: `batch ${batchId} finalized: ${finalized.status}` }
    }

    // outcome === 'claimed'
    const state: ClaimStateFile = {
      version: CLAIM_STATE_FILE_VERSION,
      batchId,
      itemId: claim.data.item_id,
      attemptId: claim.data.attempt_id,
      signalEvidenceId: claim.data.signal_evidence_id,
      claimToken: claim.data.claim_token,
      claimTokenDigest: sha256HexLocal(claim.data.claim_token),
      fencingGeneration: claim.data.fencing_generation,
      leaseExpiresAt: claim.data.lease_expires_at,
      claimedAt: new Date().toISOString(),
    }

    try {
      await deps.claimStateStore.write(state)
    } catch (err) {
      log.log({ level: 'error', message: 'failed to persist claim state -- aborting before begin_intake_attempt_call/provider call', fields: { ...redactClaimState(state), error: err instanceof Error ? err.message : String(err) } })
      return { exitCode: EXIT_CODE.UNEXPECTED_INTERNAL_ERROR, summary: 'failed to persist local claim state; stopping before any provider call' }
    }

    const outcome = await processClaimedItem(deps, state, log)
    if (outcome.stopBatch) {
      const stop = await stopIntakeBatch(deps.client, batchId, outcome.stopReasonCode ?? 'AUTHORIZATION_OR_CONFIG_ERROR', `${input.idempotencyKey}:stop:${outcome.stopReasonCode}`)
      if (!stop.ok) log.log({ level: 'error', message: 'stop_intake_batch failed', fields: { operation: stop.operation, error: stop.message, batchId } })
      return {
        exitCode: outcome.stopReasonCode === 'PROVIDER_OUTCOME_UNCERTAIN' ? EXIT_CODE.RECONCILIATION_REQUIRED : EXIT_CODE.BATCH_STOPPED,
        summary: `batch ${batchId} stopped: ${outcome.stopReasonCode}`,
      }
    }
  }
}
