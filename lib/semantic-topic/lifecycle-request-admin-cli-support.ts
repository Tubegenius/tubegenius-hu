// PFM Lifecycle Operator CLI v1 -- pure orchestration core for the
// operator-only CLI that prepares/creates a semantic-topic lifecycle
// review request.
//
// PURPOSE: create_semantic_topic_lifecycle_review_request (087) is, and
// remains, service_role-only -- deliberately never reachable from any
// authenticated reviewer session or app/api route (see
// tests/semantic-topic-lifecycle-review-087-db-integration.test.ts's own
// permission-boundary section). This module is the first, and only,
// operator-facing path to that RPC.
//
// This module is NOT a second implementation of 087's business rules --
// every actual decision (supported-transition check, mechanical
// source-diversity floor, actionable-uniqueness, idempotent replay) is
// made exclusively by create_semantic_topic_lifecycle_review_request
// itself, under its own row lock, at call time. The PREVIEW below mirrors
// a subset of that logic for operator-facing display only and is never
// treated as authoritative by this module's own apply path -- the one and
// only write RPC call always re-derives its own answer.
//
// SECURITY BOUNDARY: this module imports nothing from
// extraction-service.ts, provider-adapter.ts, supervised-intake-runner.ts,
// or any reviewer-decision module. It contains no INSERT/UPDATE/DELETE SQL
// of its own: the only database interactions are read-only SELECTs
// (semantic_topics, semantic_topic_lifecycle_review_requests), one
// read-only RPC call (compute_topic_evidence_vector, STABLE, already
// audited by 086/088), and exactly one write RPC call
// (create_semantic_topic_lifecycle_review_request) on the non-dry-run
// path.
import { createHash } from 'node:crypto'
import type { SemanticTopicAdminClient } from './human-review-types'

// The ONE narrowed `as any` boundary for every RPC call in this file (no
// generated Supabase Database types are version-controlled in this repo)
// -- both the read-only compute_topic_evidence_vector call and the write
// create_semantic_topic_lifecycle_review_request call go through this
// single function, never their own inline `.rpc(` call site.
async function call(client: any, fn: string, params: Record<string, unknown>): Promise<{ data: any; error: any }> {
  return client.rpc(fn, params)
}

// ===========================================================================
// Input validation -- every field is fully validated here BEFORE any DB
// call, matching this gate's explicit requirement.
// ===========================================================================
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// Deliberately narrow and human-typeable -- an operator-reference is a
// short, non-secret label (e.g. "ops-2026-09-15-techai-pilot"), never a
// UUID, never free text with arbitrary punctuation.
const OPERATOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/

export function isValidSemanticTopicId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
export function isValidOperatorReference(value: unknown): value is string {
  return typeof value === 'string' && OPERATOR_REFERENCE_PATTERN.test(value)
}

// The 4 v1-supported (target_status) values -- mirrors 087's own
// `p_target_status NOT IN (...)` RAISE EXCEPTION check exactly.
export const LIFECYCLE_REQUEST_TARGET_STATUSES = ['coherent', 'ambiguous', 'corroborating'] as const
export type LifecycleRequestTargetStatus = (typeof LIFECYCLE_REQUEST_TARGET_STATUSES)[number]
export function isValidTargetStatus(value: unknown): value is LifecycleRequestTargetStatus {
  return typeof value === 'string' && (LIFECYCLE_REQUEST_TARGET_STATUSES as readonly string[]).includes(value)
}

// ===========================================================================
// Deterministic, domain-separated idempotency key -- NEVER a free-form CLI
// flag. A given (operatorReference, semanticTopicId, targetStatus) triple
// always derives the SAME key (so a retried identical command replays
// cleanly); any change to any one of the three derives a DIFFERENT key (so
// a genuinely new logical request -- even for the same topic and target --
// requires a new --operator-reference, exactly as this gate specifies).
// The full key is never printed -- only an 8-40 char prefix via preview
// fields below.
// ===========================================================================
const IDEMPOTENCY_KEY_DOMAIN = 'lifecycle-review-request-admin:create:v1'

export function deriveLifecycleRequestIdempotencyKey(operatorReference: string, semanticTopicId: string, targetStatus: string): string {
  const digest = createHash('sha256').update(`${IDEMPOTENCY_KEY_DOMAIN}:${operatorReference}:${semanticTopicId}:${targetStatus}`).digest('hex')
  return `lifecycle-review-request-admin:create:${digest.slice(0, 32)}`
}

// ===========================================================================
// Preview-only mirrors of two closed-form pieces of 087's own business
// logic. Both are advisory: create_semantic_topic_lifecycle_review_request
// always re-derives its own answer under its own row lock; a preview
// disagreeing with the real RPC's outcome is a display bug, never a
// security or correctness issue, since the apply path never trusts these
// functions' output for anything but what it prints.
// ===========================================================================

// Mirrors 087's `IF NOT ((corroborating->coherent/ambiguous) OR
// (ambiguous->corroborating/coherent))` check exactly (see the migration's
// own UNSUPPORTED_TRANSITION RAISE EXCEPTION).
const SUPPORTED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  corroborating: ['coherent', 'ambiguous'],
  ambiguous: ['corroborating', 'coherent'],
}
export function previewIsSupportedTransition(fromStatus: string, targetStatus: string): boolean {
  return (SUPPORTED_TRANSITIONS[fromStatus] ?? []).includes(targetStatus)
}

// Mirrors _semantic_topic_lifecycle_mechanical_check's exact 4-condition
// CASE expression (087, migration line ~561) field-for-field. That
// function is PRIVATE (REVOKE ALL FROM PUBLIC, anon, authenticated,
// service_role -- not even this operator CLI's service-role client can
// call it directly), so this is the only way to show an operator an
// expected result at all. Cross-verified against the real function's live
// output for representative vectors in
// tests/lifecycle-review-request-admin-db-integration.test.ts.
export interface MechanicalFloorVector {
  eligibleDistinctSourceIdentityCount: number
  evidenceIdentityComplete: boolean
  sourceIdentityKnown: boolean
  assignmentReasonBreakdownComplete: boolean
}
export function previewMechanicalFloorReasonCode(vector: MechanicalFloorVector): string | null {
  if (vector.eligibleDistinctSourceIdentityCount < 2) return 'INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES'
  if (vector.evidenceIdentityComplete !== true) return 'EVIDENCE_IDENTITY_INCOMPLETE'
  if (vector.sourceIdentityKnown !== true) return 'SOURCE_IDENTITY_UNKNOWN'
  if (vector.assignmentReasonBreakdownComplete !== true) return 'ASSIGNMENT_REASON_BREAKDOWN_INCOMPLETE'
  return null
}

// ===========================================================================
// Read-only preview -- the ONLY data this module reads before an apply
// decision. No reviewer identity, no raw evidence-vector identity fields
// (signal_source_id, external_ref, etc. are never selected at all -- only
// compute_topic_evidence_vector's own aggregate output, the same shape
// 088's read surface already exposes).
// ===========================================================================
export interface LifecycleRequestPreview {
  semanticTopicIdPrefix: string
  currentLifecycleStatus: string
  currentStatusVersion: number
  targetStatus: LifecycleRequestTargetStatus
  supportedTransition: boolean
  mechanicalFloorApplies: boolean
  mechanicalFloorExpectedReasonCode: string | null
  evidenceVectorSummary: {
    formulaVersion: string
    activeMembershipCount: number
    eligibleMembershipCount: number
    eligibleDistinctSourceIdentityCount: number
    unknownSourceCount: number
    assignmentReasonBreakdownComplete: boolean
    evidenceIdentityComplete: boolean
    sourceIdentityKnown: boolean
    inputIntegrityStatus: string
  }
  actionableRequestAlreadyExists: boolean
  idempotencyKeyPrefix: string
}

interface TopicRow {
  id: string
  lifecycle_status: string
  status_version: number
}

export type FetchLifecycleRequestPreviewResult = { ok: true; preview: LifecycleRequestPreview } | { ok: false; message: string }

export async function fetchLifecycleRequestPreview(
  client: SemanticTopicAdminClient,
  input: { semanticTopicId: string; targetStatus: LifecycleRequestTargetStatus; operatorReference: string },
): Promise<FetchLifecycleRequestPreviewResult> {
  const { data: topicData, error: topicError } = await client
    .from('semantic_topics')
    .select('id, lifecycle_status, status_version')
    .eq('id', input.semanticTopicId)
    .maybeSingle()
  if (topicError) return { ok: false, message: topicError.message }
  if (!topicData) return { ok: false, message: 'semantic_topic not found' }
  const topic = topicData as TopicRow

  const { data: vectorData, error: vectorError } = await call(client, 'compute_topic_evidence_vector', { p_semantic_topic_id: input.semanticTopicId })
  if (vectorError) return { ok: false, message: vectorError.message }
  const vector = vectorData as Record<string, unknown> | null
  if (!vector || vector.ok !== true) return { ok: false, message: 'compute_topic_evidence_vector did not return ok=true for this topic' }

  const { count, error: actionableError } = await client
    .from('semantic_topic_lifecycle_review_requests')
    .select('id', { count: 'exact', head: true })
    .eq('semantic_topic_id', input.semanticTopicId)
    .in('status', ['requested', 'approved'])
  if (actionableError) return { ok: false, message: actionableError.message }

  const mechanicalFloorApplies = input.targetStatus === 'coherent' || input.targetStatus === 'corroborating'
  const mechVector: MechanicalFloorVector = {
    eligibleDistinctSourceIdentityCount: Number(vector.eligibleDistinctSourceIdentityCount ?? 0),
    evidenceIdentityComplete: vector.evidenceIdentityComplete === true,
    sourceIdentityKnown: vector.sourceIdentityKnown === true,
    assignmentReasonBreakdownComplete: vector.assignmentReasonBreakdownComplete === true,
  }

  return {
    ok: true,
    preview: {
      semanticTopicIdPrefix: input.semanticTopicId.slice(0, 8),
      currentLifecycleStatus: topic.lifecycle_status,
      currentStatusVersion: topic.status_version,
      targetStatus: input.targetStatus,
      supportedTransition: previewIsSupportedTransition(topic.lifecycle_status, input.targetStatus),
      mechanicalFloorApplies,
      mechanicalFloorExpectedReasonCode: mechanicalFloorApplies ? previewMechanicalFloorReasonCode(mechVector) : null,
      evidenceVectorSummary: {
        formulaVersion: String(vector.formulaVersion ?? ''),
        activeMembershipCount: Number(vector.activeMembershipCount ?? 0),
        eligibleMembershipCount: Number(vector.eligibleMembershipCount ?? 0),
        eligibleDistinctSourceIdentityCount: mechVector.eligibleDistinctSourceIdentityCount,
        unknownSourceCount: Number(vector.unknownSourceCount ?? 0),
        assignmentReasonBreakdownComplete: mechVector.assignmentReasonBreakdownComplete,
        evidenceIdentityComplete: mechVector.evidenceIdentityComplete,
        sourceIdentityKnown: mechVector.sourceIdentityKnown,
        inputIntegrityStatus: String(vector.inputIntegrityStatus ?? ''),
      },
      actionableRequestAlreadyExists: (count ?? 0) > 0,
      idempotencyKeyPrefix: deriveLifecycleRequestIdempotencyKey(input.operatorReference, input.semanticTopicId, input.targetStatus).slice(0, 40),
    },
  }
}

// ===========================================================================
// Main entry point -- exactly one write RPC call on the non-dry-run path,
// never more than one, regardless of the request's eventual outcome. The
// preview fetch above always runs immediately before it (both dry-run and
// apply paths share this one fetch), so the apply path's precondition read
// is, by construction, the freshest possible read before the RPC call --
// there is no separate, earlier preview call whose result could go stale
// while an operator types a YES confirmation elsewhere (the CLI wrapper
// only calls this function AFTER that confirmation resolves).
// ===========================================================================
export const LIFECYCLE_REQUEST_ADMIN_EXIT_CODE = {
  OK: 0,
  VALIDATION_OR_CONFIG_ERROR: 2,
  BUSINESS_REJECTED: 3,
  DATABASE_ERROR: 4,
} as const
export type LifecycleRequestAdminExitCode = (typeof LIFECYCLE_REQUEST_ADMIN_EXIT_CODE)[keyof typeof LIFECYCLE_REQUEST_ADMIN_EXIT_CODE]

export type LifecycleRequestCreationOutcome =
  | { kind: 'dry_run'; preview: LifecycleRequestPreview }
  | { kind: 'created'; reviewRequestIdPrefix: string; status: string; generation: number }
  | { kind: 'replayed'; reviewRequestIdPrefix: string; status: string; generation: number }
  | { kind: 'unsupported_transition' }
  | { kind: 'request_already_actionable' }
  | { kind: 'evidence_floor_not_met'; reasonCode: string }
  | { kind: 'configuration_error'; message: string }
  | { kind: 'database_error' }

export interface RunCreateLifecycleReviewRequestInput {
  semanticTopicId: string
  targetStatus: LifecycleRequestTargetStatus
  operatorReference: string
  dryRun: boolean
}

export async function runCreateLifecycleReviewRequest(
  client: SemanticTopicAdminClient,
  input: RunCreateLifecycleReviewRequestInput,
): Promise<LifecycleRequestCreationOutcome> {
  const previewResult = await fetchLifecycleRequestPreview(client, input)
  if (!previewResult.ok) return { kind: 'configuration_error', message: previewResult.message }
  const { preview } = previewResult

  if (input.dryRun) return { kind: 'dry_run', preview }

  const idempotencyKey = deriveLifecycleRequestIdempotencyKey(input.operatorReference, input.semanticTopicId, input.targetStatus)
  const { data, error } = await call(client, 'create_semantic_topic_lifecycle_review_request', {
    p_semantic_topic_id: input.semanticTopicId,
    p_target_status: input.targetStatus,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    const message = typeof error.message === 'string' ? error.message : String(error)
    if (/UNSUPPORTED_TRANSITION/.test(message)) return { kind: 'unsupported_transition' }
    if (/semantic_topic .* not found/.test(message)) return { kind: 'configuration_error', message: 'semantic_topic not found at apply time' }
    if (/idempotency_key .* already used with different parameters/.test(message)) {
      return { kind: 'configuration_error', message: 'idempotency key collision -- inputs changed since the last attempt under this operator-reference' }
    }
    return { kind: 'database_error' }
  }
  const body = data as { ok?: boolean; outcomeKind?: string; reviewRequestId?: string; status?: string; generation?: number; reasonCode?: string } | null
  if (!body || typeof body.ok !== 'boolean') return { kind: 'database_error' }

  if (body.ok === false) {
    if (body.reasonCode === 'REQUEST_ALREADY_ACTIONABLE_FOR_TOPIC') return { kind: 'request_already_actionable' }
    if (typeof body.reasonCode === 'string' && body.reasonCode.length > 0) return { kind: 'evidence_floor_not_met', reasonCode: body.reasonCode }
    return { kind: 'database_error' }
  }
  if (!body.reviewRequestId || !body.status || typeof body.generation !== 'number') return { kind: 'database_error' }
  const reviewRequestIdPrefix = body.reviewRequestId.slice(0, 8)
  if (body.outcomeKind === 'replayed') return { kind: 'replayed', reviewRequestIdPrefix, status: body.status, generation: body.generation }
  return { kind: 'created', reviewRequestIdPrefix, status: body.status, generation: body.generation }
}

export function exitCodeForLifecycleRequestCreationOutcome(outcome: LifecycleRequestCreationOutcome): LifecycleRequestAdminExitCode {
  switch (outcome.kind) {
    case 'dry_run':
    case 'created':
    case 'replayed':
      return LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.OK
    case 'unsupported_transition':
    case 'request_already_actionable':
    case 'evidence_floor_not_met':
      return LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.BUSINESS_REJECTED
    case 'configuration_error':
      return LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    case 'database_error':
      return LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.DATABASE_ERROR
  }
}
