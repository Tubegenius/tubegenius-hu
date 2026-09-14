// PFM Lifecycle Operator CLI v1 -- pure orchestration core for the
// operator-only CLI that executes an already-approved semantic-topic
// lifecycle review request.
//
// PURPOSE: execute_approved_semantic_topic_lifecycle_transition (087) is,
// and remains, service_role-only -- deliberately never reachable from any
// authenticated reviewer session or app/api route. This module is the
// first, and only, operator-facing path to that RPC.
//
// This module is NOT a second implementation of 087's staleness/execution
// rules -- the RPC alone decides everything (fixed-priority staleness
// chain, replay-vs-fresh-execution, exactly-once transition persistence)
// under its own row lock at call time. The dry-run preview below is
// diagnostic/advisory only, exactly like 088's own isPotentiallyStale
// field, and is never treated as authoritative by this module's apply
// path.
//
// SECURITY BOUNDARY: this module imports nothing from extraction-service.ts,
// provider-adapter.ts, supervised-intake-runner.ts, or any reviewer-
// decision module. It contains no INSERT/UPDATE/DELETE SQL of its own: the
// only database interactions are two read-only SELECTs
// (semantic_topic_lifecycle_review_requests, semantic_topics) and exactly
// one write RPC call (execute_approved_semantic_topic_lifecycle_transition)
// on the non-dry-run path.
import { createHash } from 'node:crypto'
import type { SemanticTopicAdminClient } from './human-review-types'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function isValidReviewRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

// ===========================================================================
// Deterministic, domain-separated idempotency key -- derived from the
// review request's own id AND its stored decision_operation_digest (087's
// own record_semantic_topic_lifecycle_review_decision output), never a
// free-form CLI flag. A repeated operator attempt against the SAME
// approved decision always derives the SAME key (clean replay); the key
// can only change if the underlying decision itself changed, which 087's
// v1 model never allows once a request has moved past 'requested'. The
// full key is never printed -- only a short prefix.
// ===========================================================================
const IDEMPOTENCY_KEY_DOMAIN = 'execute-approved-lifecycle-transition:v1'

export function deriveLifecycleExecutionIdempotencyKey(reviewRequestId: string, decisionOperationDigest: string): string {
  const digest = createHash('sha256').update(`${IDEMPOTENCY_KEY_DOMAIN}:${reviewRequestId}:${decisionOperationDigest}`).digest('hex')
  return `execute-approved-lifecycle-transition:${digest.slice(0, 32)}`
}

// ===========================================================================
// Read-only preview -- diagnostic only (mirrors 088's own
// isPotentiallyStale contract: advisory, never authoritative; the RPC's own
// fixed-priority staleness chain is the sole binding decision-maker at
// execution time).
// ===========================================================================
export interface LifecycleExecutionPreview {
  reviewRequestIdPrefix: string
  requestStatus: string
  executable: boolean
  fromStatus: string
  targetStatus: string
  expectedStatusVersion: number
  liveLifecycleStatus: string
  liveStatusVersion: number
  advisoryStaleSignal: 'topic_state_changed' | 'topic_version_changed' | null
  expectedSideEffectCount: { transitionEvents: number; reviewEvents: number }
  idempotencyKeyPrefix: string | null
}

interface ReviewRequestRow {
  id: string
  status: string
  semantic_topic_id: string
  from_status: string
  target_status: string
  expected_status_version: number
  decision_operation_digest: string | null
}
interface TopicRow {
  lifecycle_status: string
  status_version: number
}

export type FetchLifecycleExecutionPreviewResult =
  | { ok: true; preview: LifecycleExecutionPreview; decisionOperationDigest: string | null }
  | { ok: false; message: string }

export async function fetchLifecycleExecutionPreview(
  client: SemanticTopicAdminClient,
  reviewRequestId: string,
): Promise<FetchLifecycleExecutionPreviewResult> {
  const { data, error } = await client
    .from('semantic_topic_lifecycle_review_requests')
    .select('id, status, semantic_topic_id, from_status, target_status, expected_status_version, decision_operation_digest')
    .eq('id', reviewRequestId)
    .maybeSingle()
  if (error) return { ok: false, message: error.message }
  if (!data) return { ok: false, message: 'review_request not found' }
  const row = data as ReviewRequestRow

  const { data: topicData, error: topicError } = await client
    .from('semantic_topics')
    .select('lifecycle_status, status_version')
    .eq('id', row.semantic_topic_id)
    .maybeSingle()
  if (topicError) return { ok: false, message: topicError.message }
  if (!topicData) return { ok: false, message: 'linked semantic_topic not found' }
  const topic = topicData as TopicRow

  let advisoryStaleSignal: LifecycleExecutionPreview['advisoryStaleSignal'] = null
  if (topic.lifecycle_status !== row.from_status) advisoryStaleSignal = 'topic_state_changed'
  else if (topic.status_version !== row.expected_status_version) advisoryStaleSignal = 'topic_version_changed'

  const idempotencyKeyPrefix = row.decision_operation_digest
    ? deriveLifecycleExecutionIdempotencyKey(reviewRequestId, row.decision_operation_digest).slice(0, 40)
    : null

  return {
    ok: true,
    decisionOperationDigest: row.decision_operation_digest,
    preview: {
      reviewRequestIdPrefix: reviewRequestId.slice(0, 8),
      requestStatus: row.status,
      executable: row.status === 'approved',
      fromStatus: row.from_status,
      targetStatus: row.target_status,
      expectedStatusVersion: row.expected_status_version,
      liveLifecycleStatus: topic.lifecycle_status,
      liveStatusVersion: topic.status_version,
      advisoryStaleSignal,
      expectedSideEffectCount: { transitionEvents: 1, reviewEvents: 1 },
      idempotencyKeyPrefix,
    },
  }
}

// ===========================================================================
// Main entry point -- exactly one write RPC call on the non-dry-run path,
// never more than one, regardless of the request's executability. The
// preview fetch above always runs immediately before it (see this file's
// header for why that makes the apply path's precondition read the
// freshest possible read before the RPC call, by construction).
// ===========================================================================
export const LIFECYCLE_EXECUTOR_EXIT_CODE = {
  OK: 0,
  VALIDATION_OR_CONFIG_ERROR: 2,
  NOT_EXECUTABLE: 3,
  STALE: 4,
  DATABASE_ERROR: 5,
} as const
export type LifecycleExecutorExitCode = (typeof LIFECYCLE_EXECUTOR_EXIT_CODE)[keyof typeof LIFECYCLE_EXECUTOR_EXIT_CODE]

export type LifecycleExecutionOutcome =
  | { kind: 'dry_run'; preview: LifecycleExecutionPreview }
  | { kind: 'executed'; reviewRequestIdPrefix: string; fromStatus: string; targetStatus: string }
  | { kind: 'replayed'; reviewRequestIdPrefix: string }
  | { kind: 'stale'; reviewRequestIdPrefix: string; staleReasonCode: string }
  | { kind: 'not_executable'; status?: string }
  | { kind: 'configuration_error'; message: string }
  | { kind: 'database_error' }

export interface RunExecuteApprovedLifecycleTransitionInput {
  reviewRequestId: string
  dryRun: boolean
}

// The ONE narrowed `as any` boundary for the write RPC.
async function call(client: any, fn: string, params: Record<string, unknown>): Promise<{ data: any; error: any }> {
  return client.rpc(fn, params)
}

export async function runExecuteApprovedLifecycleTransition(
  client: SemanticTopicAdminClient,
  input: RunExecuteApprovedLifecycleTransitionInput,
): Promise<LifecycleExecutionOutcome> {
  const previewResult = await fetchLifecycleExecutionPreview(client, input.reviewRequestId)
  if (!previewResult.ok) return { kind: 'configuration_error', message: previewResult.message }
  const { preview, decisionOperationDigest } = previewResult

  if (input.dryRun) return { kind: 'dry_run', preview }

  // Fast, explicit local check before ever calling the RPC. NEVER a
  // security boundary on its own -- the RPC re-validates status itself
  // under its own FOR UPDATE lock regardless of what this check finds
  // (mirrors execute-approved-review-cli-support.ts's own established
  // comment on this exact pattern). 'approved'/'stale'/'executed' are the
  // only statuses the RPC itself ever proceeds past its own
  // REVIEW_REQUEST_NOT_EXECUTABLE guard for (stale/executed both resolve
  // to a replay branch inside the RPC, never a fresh transition).
  if (preview.requestStatus !== 'approved' && preview.requestStatus !== 'stale' && preview.requestStatus !== 'executed') {
    return { kind: 'not_executable', status: preview.requestStatus }
  }
  if (!decisionOperationDigest) {
    return { kind: 'configuration_error', message: 'review_request has no recorded decision digest -- cannot derive a deterministic execution key' }
  }

  const idempotencyKey = deriveLifecycleExecutionIdempotencyKey(input.reviewRequestId, decisionOperationDigest)
  const { data, error } = await call(client, 'execute_approved_semantic_topic_lifecycle_transition', {
    p_review_request_id: input.reviewRequestId,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    const message = typeof error.message === 'string' ? error.message : String(error)
    if (/REVIEW_REQUEST_NOT_EXECUTABLE/.test(message)) return { kind: 'not_executable' }
    if (/review_request .* not found/.test(message)) return { kind: 'configuration_error', message: 'review_request not found at execution time' }
    if (/already used with a different execution attempt/.test(message)) {
      return { kind: 'configuration_error', message: 'idempotency key collision -- the request was re-decided since this preview' }
    }
    return { kind: 'database_error' }
  }
  const body = data as { ok?: boolean; outcomeKind?: string; reviewRequestId?: string; reasonCode?: string; staleReasonCode?: string } | null
  if (!body || typeof body.ok !== 'boolean') return { kind: 'database_error' }

  if (body.ok === false) {
    if (body.reasonCode === 'STALE_REVIEW_REQUEST' && typeof body.staleReasonCode === 'string' && body.staleReasonCode.length > 0) {
      return { kind: 'stale', reviewRequestIdPrefix: input.reviewRequestId.slice(0, 8), staleReasonCode: body.staleReasonCode }
    }
    return { kind: 'database_error' }
  }
  if (body.outcomeKind === 'replayed') return { kind: 'replayed', reviewRequestIdPrefix: input.reviewRequestId.slice(0, 8) }
  return { kind: 'executed', reviewRequestIdPrefix: input.reviewRequestId.slice(0, 8), fromStatus: preview.fromStatus, targetStatus: preview.targetStatus }
}

export function exitCodeForLifecycleExecutionOutcome(outcome: LifecycleExecutionOutcome): LifecycleExecutorExitCode {
  switch (outcome.kind) {
    case 'dry_run':
    case 'executed':
    case 'replayed':
      return LIFECYCLE_EXECUTOR_EXIT_CODE.OK
    case 'not_executable':
      return LIFECYCLE_EXECUTOR_EXIT_CODE.NOT_EXECUTABLE
    case 'stale':
      return LIFECYCLE_EXECUTOR_EXIT_CODE.STALE
    case 'configuration_error':
      return LIFECYCLE_EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    case 'database_error':
      return LIFECYCLE_EXECUTOR_EXIT_CODE.DATABASE_ERROR
  }
}
