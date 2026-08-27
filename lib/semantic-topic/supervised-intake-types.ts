// PFM Supervised Production Candidate Intake v0 -- shared types for the
// service-only, one-shot supervised intake runner.
//
// This module has NO side effects and NO dependency on node:fs/node:process
// -- it is pure type/validation logic, safely importable from a test file
// without a real filesystem or DB.
import { isUuid } from './quota-types'
import {
  SEMANTIC_TOPIC_EXTRACTION_MODEL,
  SEMANTIC_TOPIC_EXTRACTION_PROVIDER,
  SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION,
  SEMANTIC_TOPIC_EXTRACTION_USAGE_TYPE,
  SEMANTIC_TOPIC_NORMALIZATION_VERSION,
  SEMANTIC_TOPIC_PROMPT_VERSION,
} from './extraction-config'

// ===========================================================================
// Batch input file contract
// ===========================================================================

// The ONLY fields a supervised intake batch input file may contain. Every
// other field name is a fail-closed rejection at parse time -- see
// FORBIDDEN_INPUT_FIELDS below for the explicit, named deny-list this is
// cross-checked against (belt-and-suspenders: an allow-list already rejects
// anything not listed here, but naming the specific forbidden fields makes
// the intent undeniable in review and in a future diff).
const ALLOWED_INPUT_FIELDS = new Set([
  'idempotencyKey',
  'operatorReference',
  'signalEvidenceIds',
  'provider',
  'model',
  'normalizationVersion',
  'extractionSchemaVersion',
  'promptVersion',
  'deterministicExtractorVersion',
])

// Fields a batch input file must NEVER be allowed to carry, named explicitly
// per the runner's input-contract mandate -- confidence/specificity/
// structured output/review outcome/manual_review_confirmed/CREATE_NEW topic
// id/approval digest/any credential/any limit or flag override. Checked
// even though ALLOWED_INPUT_FIELDS above would already reject all of these
// as "unknown field" -- this list exists so the specific, named prohibition
// is visible in the source, not just an emergent property of an allow-list.
const FORBIDDEN_INPUT_FIELD_NAMES = [
  'confidence',
  'specificity',
  'structuredOutput',
  'structured_output',
  'reviewOutcome',
  'review_outcome',
  'manualReviewConfirmed',
  'manual_review_confirmed',
  'semanticTopicId',
  'semantic_topic_id',
  'approvalDigest',
  'approval_digest',
  'serviceRoleKey',
  'service_role_key',
  'providerApiKey',
  'provider_api_key',
  'apiKey',
  'api_key',
  'maxBatchItems',
  'max_batch_items',
  'maxDailyClaimedItems',
  'max_daily_claimed_items',
  'intakeLimitOverride',
  'aiExtractionControlOverride',
  'ai_extraction_control_override',
  'humanReviewFlagOverride',
  'human_review_flag_override',
]

export interface SupervisedIntakeBatchInput {
  idempotencyKey: string
  operatorReference: string
  signalEvidenceIds: string[]
  provider: string
  model: string
  normalizationVersion: number
  extractionSchemaVersion: number
  promptVersion: string
  deterministicExtractorVersion: null
}

export type BatchInputValidationResult =
  | { ok: true; value: SupervisedIntakeBatchInput }
  | { ok: false; errors: string[] }

// Conservative, generous-but-bounded ceilings -- the real, authoritative
// batch-size limit is always enforced server-side by create_supervised_intake_batch
// (via supervised_intake_control.max_batch_items); these exist only to
// reject a wildly malformed/oversized file before it is ever parsed as JSON
// or sent to the database at all.
export const MAX_BATCH_INPUT_FILE_BYTES = 262_144 // 256 KiB
export const MAX_BATCH_INPUT_EVIDENCE_IDS = 500

const OPERATOR_REFERENCE_PATTERN = /^[A-Za-z0-9._@-]{3,64}$/
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Fail-closed JSON parse: any parse error becomes a validation error, never
// a thrown exception the caller must separately catch.
export function parseSupervisedIntakeBatchInputJson(raw: string): BatchInputValidationResult {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BATCH_INPUT_FILE_BYTES) {
    return { ok: false, errors: [`Input file exceeds the ${MAX_BATCH_INPUT_FILE_BYTES}-byte bound.`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, errors: [`Input file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
  return validateSupervisedIntakeBatchInput(parsed)
}

// The single source of truth for what a batch input file may contain.
// Deliberately fails closed on: unknown fields, any explicitly forbidden
// field name (even if also unknown), a non-array/empty/duplicated/malformed
// evidence-id list, a config field that does not match the pinned
// extraction-config constants (see the comment below), and any wrong-typed
// field.
export function validateSupervisedIntakeBatchInput(input: unknown): BatchInputValidationResult {
  const errors: string[] = []
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['Batch input must be a single JSON object.'] }
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      errors.push(`Unknown field "${key}" is not permitted in a batch input file.`)
    }
  }
  for (const forbidden of FORBIDDEN_INPUT_FIELD_NAMES) {
    if (Object.prototype.hasOwnProperty.call(input, forbidden)) {
      errors.push(`Field "${forbidden}" is never permitted in a batch input file.`)
    }
  }

  const idempotencyKey = input.idempotencyKey
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    errors.push('idempotencyKey must be a non-empty string of at most 256 chars from [A-Za-z0-9._:-].')
  }

  const operatorReference = input.operatorReference
  if (typeof operatorReference !== 'string' || !OPERATOR_REFERENCE_PATTERN.test(operatorReference)) {
    errors.push('operatorReference must be a 3-64 char string from [A-Za-z0-9._@-].')
  }

  const evidenceIds = input.signalEvidenceIds
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
    errors.push('signalEvidenceIds must be a non-empty array of UUID strings.')
  } else if (evidenceIds.length > MAX_BATCH_INPUT_EVIDENCE_IDS) {
    errors.push(`signalEvidenceIds exceeds the ${MAX_BATCH_INPUT_EVIDENCE_IDS}-item file-level bound (the real limit is enforced by the DB policy).`)
  } else {
    const seen = new Set<string>()
    evidenceIds.forEach((id, index) => {
      if (typeof id !== 'string' || !isUuid(id)) {
        errors.push(`signalEvidenceIds[${index}] is not a valid UUID.`)
        return
      }
      const normalized = id.toLowerCase()
      if (seen.has(normalized)) {
        errors.push(`signalEvidenceIds[${index}] is a duplicate of an earlier entry in this same file.`)
        return
      }
      seen.add(normalized)
    })
  }

  // Canonical config check: runShadowExtraction() is NOT parameterizable --
  // it always uses the pinned constants from extraction-config.ts
  // internally. A batch's own extraction_config_digest is computed at
  // create_supervised_intake_batch time from THESE caller-supplied fields;
  // if they do not byte-match what runShadowExtraction() will actually use,
  // the item's stored digest would silently diverge from what
  // reserve_ai_provider_units/record_topic_extraction_run independently
  // compute during the real call, breaking cache-hit detection and
  // reconciliation lineage matching. Fail closed rather than silently
  // accepting a mismatched config.
  if (input.provider !== SEMANTIC_TOPIC_EXTRACTION_PROVIDER) {
    errors.push(`provider must be exactly "${SEMANTIC_TOPIC_EXTRACTION_PROVIDER}" (the pinned extraction-config value).`)
  }
  if (input.model !== SEMANTIC_TOPIC_EXTRACTION_MODEL) {
    errors.push(`model must be exactly "${SEMANTIC_TOPIC_EXTRACTION_MODEL}" (the pinned extraction-config value).`)
  }
  if (input.normalizationVersion !== SEMANTIC_TOPIC_NORMALIZATION_VERSION) {
    errors.push(`normalizationVersion must be exactly ${SEMANTIC_TOPIC_NORMALIZATION_VERSION} (the pinned extraction-config value).`)
  }
  if (input.extractionSchemaVersion !== SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION) {
    errors.push(`extractionSchemaVersion must be exactly ${SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION} (the pinned extraction-config value).`)
  }
  if (input.promptVersion !== SEMANTIC_TOPIC_PROMPT_VERSION) {
    errors.push(`promptVersion must be exactly "${SEMANTIC_TOPIC_PROMPT_VERSION}" (the pinned extraction-config value).`)
  }
  if (input.deterministicExtractorVersion !== null) {
    errors.push('deterministicExtractorVersion must be exactly null (S3A only ever produces ai_assisted extractions).')
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      idempotencyKey: idempotencyKey as string,
      operatorReference: operatorReference as string,
      signalEvidenceIds: evidenceIds as string[],
      provider: SEMANTIC_TOPIC_EXTRACTION_PROVIDER,
      model: SEMANTIC_TOPIC_EXTRACTION_MODEL,
      normalizationVersion: SEMANTIC_TOPIC_NORMALIZATION_VERSION,
      extractionSchemaVersion: SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION,
      promptVersion: SEMANTIC_TOPIC_PROMPT_VERSION,
      deterministicExtractorVersion: null,
    },
  }
}

// SEMANTIC_TOPIC_EXTRACTION_USAGE_TYPE is re-exported only so the runner
// module doesn't need a second import line for the one extra RPC field
// (p_usage_type) create_supervised_intake_batch needs that isn't part of
// the caller-facing input contract at all (it is not caller-configurable --
// there is only one usage type in this system).
export { SEMANTIC_TOPIC_EXTRACTION_USAGE_TYPE }

// ===========================================================================
// Local claim-state file contract (section 7) -- durable, atomic, redacted.
// ===========================================================================

// Schema version for the persisted file itself, so a future format change
// can be detected and rejected explicitly rather than silently misread.
export const CLAIM_STATE_FILE_VERSION = 1 as const

export interface ClaimStateFile {
  version: typeof CLAIM_STATE_FILE_VERSION
  batchId: string
  itemId: string
  attemptId: string
  signalEvidenceId: string
  /** SHA-256 hex digest of the plaintext claim token -- NEVER the plaintext itself. */
  claimTokenDigest: string
  /** The plaintext claim token -- present only in the in-memory/on-disk representation used to actually call begin/complete/fail; redacted before ever being logged. */
  claimToken: string
  fencingGeneration: number
  leaseExpiresAt: string
  claimedAt: string
}

export function isClaimStateFile(value: unknown): value is ClaimStateFile {
  if (!isPlainObject(value)) return false
  return (
    value.version === CLAIM_STATE_FILE_VERSION &&
    typeof value.batchId === 'string' &&
    typeof value.itemId === 'string' &&
    typeof value.attemptId === 'string' &&
    typeof value.signalEvidenceId === 'string' &&
    typeof value.claimTokenDigest === 'string' &&
    typeof value.claimToken === 'string' &&
    typeof value.fencingGeneration === 'number' &&
    typeof value.leaseExpiresAt === 'string' &&
    typeof value.claimedAt === 'string'
  )
}

// Redacted view safe to pass to a logger -- never includes claimToken or
// claimTokenDigest (the digest alone is still a correlatable secret-adjacent
// value not worth ever printing).
export function redactClaimState(state: ClaimStateFile): Record<string, unknown> {
  return {
    version: state.version,
    batchId: state.batchId,
    itemId: state.itemId,
    attemptId: state.attemptId,
    signalEvidenceId: state.signalEvidenceId,
    fencingGeneration: state.fencingGeneration,
    leaseExpiresAt: state.leaseExpiresAt,
    claimedAt: state.claimedAt,
  }
}

// ===========================================================================
// Exit codes (section 9) -- one documented, stable code per outcome class.
// ===========================================================================
export const EXIT_CODE = {
  COMPLETED: 0,
  VALIDATION_OR_CONFIG_ERROR: 2,
  BATCH_STOPPED: 3,
  RECONCILIATION_REQUIRED: 4,
  UNEXPECTED_INTERNAL_ERROR: 5,
} as const

export type RunnerExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE]
