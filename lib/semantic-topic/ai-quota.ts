// Semantic Topic Identity v0 -- S3A. Server-side, fail-closed wrappers
// around the AI-provider quota RPCs from migration 075. This module never
// calls a provider itself -- it only reserves and settles quota units,
// mirroring lib/emerging-signal/provider-budget.ts's shape for the YouTube
// collector, but fully isolated from it (see quota-types.ts).
import { createAdminClient } from '@/lib/supabase-server'
import {
  isUuid,
  toAiQuotaDatabaseError,
  type AiQuotaOperationFailure,
  type SemanticTopicAdminClient,
} from './quota-types'
import {
  AI_QUOTA_MAX_OUTPUT_TOKENS,
  SEMANTIC_TOPIC_EXTRACTION_MODEL,
  SEMANTIC_TOPIC_EXTRACTION_PROVIDER,
  SEMANTIC_TOPIC_EXTRACTION_USAGE_TYPE,
  SEMANTIC_TOPIC_NORMALIZATION_VERSION,
  SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION,
  SEMANTIC_TOPIC_PROMPT_VERSION,
} from './extraction-config'

export interface ReserveAiProviderUnitsInput {
  signalEvidenceId: string
  normalizedExtractionInput: string
  estimatedInputTokens: number
  idempotencyKey: string
  /** Defaults to AI_QUOTA_MAX_OUTPUT_TOKENS -- override only for a test fixture. */
  estimatedMaxOutputTokens?: number
}

export type ReserveAiProviderUnitsResult =
  | { outcome: 'reserved'; reservationId: string }
  | { outcome: 'budget_exhausted' }
  | AiQuotaOperationFailure

export type AiQuotaBooleanResult =
  | { outcome: 'success'; duplicateSafe: true }
  | AiQuotaOperationFailure

export interface AiQuotaCommitSettlement {
  reservationId: string
  status: 'committed' | 'committed_unknown'
  duplicate: boolean
  actualMicroUsd?: number
  /**
   * Correction-gate item 2: true when the real (actual) cost exceeded the
   * pre-call reservation estimate. The real cost is ALWAYS persisted and
   * counted regardless -- this flag is purely informational, signaling that
   * ai_extraction_control.enabled was atomically flipped to false in the
   * same transaction and that no further reservation can succeed. Only ever
   * set on a 'committed' settlement (commit_ai_provider_units); always
   * false/undefined for 'committed_unknown'.
   */
  capBreach?: boolean
}

export type AiQuotaSettlementResult =
  | { outcome: 'success'; settlement: AiQuotaCommitSettlement }
  | AiQuotaOperationFailure

export interface AiQuotaFinalizeOutcome {
  reservationId: string
  applicationOutcome: 'completed' | 'failed'
  extractionRunId: string
  duplicate: boolean
}

export type AiQuotaFinalizeResult =
  | { outcome: 'success'; finalized: AiQuotaFinalizeOutcome }
  | AiQuotaOperationFailure

export interface AiQuotaReconcileSummary {
  released: number
  markedUnknown: number
  /** Committed reservations linked to a real, uniquely-matching extraction run's outcome (correction-gate item 2, branch A). */
  finalizedFromRun: number
  /** Committed reservations whose application crashed before any extraction run existed at all -- application_outcome='failed', extraction_run_id stays NULL (branch B). */
  finalizedMissing: number
  /** Committed reservations with more than one candidate matching extraction run -- left untouched, fail-closed, control disabled (branch C). */
  ambiguous: number
  skippedConcurrentRun: boolean
}

export type AiQuotaReconcileResult =
  | { outcome: 'success'; summary: AiQuotaReconcileSummary }
  | AiQuotaOperationFailure

function invalid(message: string): AiQuotaOperationFailure {
  return { outcome: 'invalid_request', message }
}

function rpcFailure(operation: string, error: unknown): AiQuotaOperationFailure {
  const normalized = toAiQuotaDatabaseError(error)
  if (normalized.code === 'P0001') {
    return { outcome: 'invalid_transition', message: normalized.message }
  }
  return { outcome: 'database_error', operation, error: normalized }
}

function admin(client?: SemanticTopicAdminClient): SemanticTopicAdminClient {
  return client ?? createAdminClient()
}

async function callRpc(
  operation: string,
  args: Record<string, unknown>,
  client?: SemanticTopicAdminClient,
): Promise<{ ok: true; data: unknown } | { ok: false; failure: AiQuotaOperationFailure }> {
  try {
    const { data, error } = await admin(client).rpc(operation, args)
    if (error) return { ok: false, failure: rpcFailure(operation, error) }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, failure: { outcome: 'database_error', operation, error: toAiQuotaDatabaseError(error) } }
  }
}

export async function reserveAiProviderUnits(
  input: ReserveAiProviderUnitsInput,
  client?: SemanticTopicAdminClient,
): Promise<ReserveAiProviderUnitsResult> {
  if (!isUuid(input.signalEvidenceId)) return invalid('signalEvidenceId must be a UUID.')
  if (!input.normalizedExtractionInput.trim()) return invalid('normalizedExtractionInput is required.')
  if (!Number.isInteger(input.estimatedInputTokens) || input.estimatedInputTokens <= 0) {
    return invalid('estimatedInputTokens must be a positive integer.')
  }
  if (!input.idempotencyKey.trim()) return invalid('idempotencyKey is required.')
  if (input.idempotencyKey.length > 512) return invalid('idempotencyKey is too long.')
  const estimatedMaxOutputTokens = input.estimatedMaxOutputTokens ?? AI_QUOTA_MAX_OUTPUT_TOKENS
  if (!Number.isInteger(estimatedMaxOutputTokens) || estimatedMaxOutputTokens <= 0) {
    return invalid('estimatedMaxOutputTokens must be a positive integer.')
  }

  const operation = 'reserve_ai_provider_units'
  const rpc = await callRpc(operation, {
    p_provider: SEMANTIC_TOPIC_EXTRACTION_PROVIDER,
    p_usage_type: SEMANTIC_TOPIC_EXTRACTION_USAGE_TYPE,
    p_model: SEMANTIC_TOPIC_EXTRACTION_MODEL,
    p_signal_evidence_id: input.signalEvidenceId,
    p_normalization_version: SEMANTIC_TOPIC_NORMALIZATION_VERSION,
    p_extraction_schema_version: SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION,
    p_prompt_version: SEMANTIC_TOPIC_PROMPT_VERSION,
    p_normalized_extraction_input: input.normalizedExtractionInput,
    p_estimated_input_tokens: input.estimatedInputTokens,
    p_estimated_max_output_tokens: estimatedMaxOutputTokens,
    p_idempotency_key: input.idempotencyKey.trim(),
  }, client)
  if (!rpc.ok) return rpc.failure
  const { data } = rpc
  if (data === null) return { outcome: 'budget_exhausted' }
  if (typeof data !== 'string' || !isUuid(data)) {
    return { outcome: 'invalid_rpc_response', operation }
  }
  return { outcome: 'reserved', reservationId: data }
}

export async function markAiProviderAttemptStarted(
  reservationId: string,
  client?: SemanticTopicAdminClient,
): Promise<AiQuotaBooleanResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  const operation = 'mark_ai_provider_attempt_started'
  const rpc = await callRpc(operation, { p_reservation_id: reservationId }, client)
  if (!rpc.ok) return rpc.failure
  const { data } = rpc
  if (data !== true) {
    return data === false
      ? { outcome: 'invalid_transition', message: 'Reservation was not found or is no longer reserved.' }
      : { outcome: 'invalid_rpc_response', operation }
  }
  return { outcome: 'success', duplicateSafe: true }
}

function parseSettlement(
  operation: string,
  data: unknown,
  expectedStatus: AiQuotaCommitSettlement['status'],
): AiQuotaSettlementResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { outcome: 'invalid_rpc_response', operation }
  }
  const row = data as Record<string, unknown>
  if (
    typeof row.reservation_id !== 'string' ||
    !isUuid(row.reservation_id) ||
    row.status !== expectedStatus ||
    typeof row.duplicate !== 'boolean'
  ) {
    return { outcome: 'invalid_rpc_response', operation }
  }
  return {
    outcome: 'success',
    settlement: {
      reservationId: row.reservation_id,
      status: expectedStatus,
      duplicate: row.duplicate,
      actualMicroUsd: typeof row.actual_micro_usd === 'number' ? row.actual_micro_usd : undefined,
      capBreach: typeof row.cap_breach === 'boolean' ? row.cap_breach : undefined,
    },
  }
}

export async function commitAiProviderUnits(
  reservationId: string,
  actualInputTokens: number,
  actualOutputTokens: number,
  client?: SemanticTopicAdminClient,
): Promise<AiQuotaSettlementResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  if (!Number.isInteger(actualInputTokens) || actualInputTokens < 0) return invalid('actualInputTokens must be a non-negative integer.')
  if (!Number.isInteger(actualOutputTokens) || actualOutputTokens < 0) return invalid('actualOutputTokens must be a non-negative integer.')
  const operation = 'commit_ai_provider_units'
  const rpc = await callRpc(operation, {
    p_reservation_id: reservationId,
    p_actual_input_tokens: actualInputTokens,
    p_actual_output_tokens: actualOutputTokens,
  }, client)
  if (!rpc.ok) return rpc.failure
  return parseSettlement(operation, rpc.data, 'committed')
}

export async function markAiProviderOutcomeUnknown(
  reservationId: string,
  errorClass: string | null = null,
  client?: SemanticTopicAdminClient,
): Promise<AiQuotaSettlementResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  if (errorClass !== null && errorClass.length > 100) return invalid('errorClass must be at most 100 characters.')
  const operation = 'mark_ai_provider_outcome_unknown'
  const rpc = await callRpc(operation, { p_reservation_id: reservationId, p_error_class: errorClass }, client)
  if (!rpc.ok) return rpc.failure
  return parseSettlement(operation, rpc.data, 'committed_unknown')
}

export async function releaseAiProviderUnits(
  reservationId: string,
  client?: SemanticTopicAdminClient,
): Promise<AiQuotaBooleanResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  const operation = 'release_ai_provider_units'
  const rpc = await callRpc(operation, { p_reservation_id: reservationId }, client)
  if (!rpc.ok) return rpc.failure
  const { data } = rpc
  if (data !== true) {
    return data === false
      ? { outcome: 'invalid_transition', message: 'Reservation was not found.' }
      : { outcome: 'invalid_rpc_response', operation }
  }
  return { outcome: 'success', duplicateSafe: true }
}

// Correction-gate item 1: links a settled (committed) reservation to the
// 074 topic_extraction_runs row its provider call ultimately produced, so
// reserve_ai_provider_units' global attempt-count can exclude genuinely
// completed extractions (which are separately blocked by the completed-
// cache guard) while still counting every other committed/committed_unknown/
// still-open attempt. Only ever called once per reservation, after
// record_topic_extraction_run has already returned a real extraction_run_id.
export async function finalizeAiProviderReservationOutcome(
  reservationId: string,
  extractionRunId: string,
  applicationOutcome: 'completed' | 'failed',
  client?: SemanticTopicAdminClient,
): Promise<AiQuotaFinalizeResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  if (!isUuid(extractionRunId)) return invalid('extractionRunId must be a UUID.')
  const operation = 'finalize_ai_provider_reservation_outcome'
  const rpc = await callRpc(operation, {
    p_reservation_id: reservationId,
    p_extraction_run_id: extractionRunId,
    p_application_outcome: applicationOutcome,
  }, client)
  if (!rpc.ok) return rpc.failure
  const { data } = rpc
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { outcome: 'invalid_rpc_response', operation }
  const row = data as Record<string, unknown>
  if (
    typeof row.reservation_id !== 'string' || !isUuid(row.reservation_id) ||
    (row.application_outcome !== 'completed' && row.application_outcome !== 'failed') ||
    typeof row.extraction_run_id !== 'string' || !isUuid(row.extraction_run_id) ||
    typeof row.duplicate !== 'boolean'
  ) {
    return { outcome: 'invalid_rpc_response', operation }
  }
  return {
    outcome: 'success',
    finalized: {
      reservationId: row.reservation_id,
      applicationOutcome: row.application_outcome,
      extractionRunId: row.extraction_run_id,
      duplicate: row.duplicate,
    },
  }
}

// Correction-gate item 4: fail-closed reconciliation for reservations left
// open by a crashed/abandoned application process. Idempotent, concurrency-
// safe (single-flight try-lock + FOR UPDATE SKIP LOCKED inside the RPC).
// The extraction-service orchestrator calls this as its first step on every
// real invocation, so no reservation is ever silently left open across runs.
export async function reconcileStaleAiProviderReservations(
  unstartedStaleAfterSeconds?: number,
  startedStaleAfterSeconds?: number,
  committedUnfinalizedStaleAfterSeconds?: number,
  client?: SemanticTopicAdminClient,
): Promise<AiQuotaReconcileResult> {
  const operation = 'reconcile_stale_ai_provider_reservations'
  const args: Record<string, unknown> = {}
  if (unstartedStaleAfterSeconds !== undefined) args.p_unstarted_stale_after_seconds = unstartedStaleAfterSeconds
  if (startedStaleAfterSeconds !== undefined) args.p_started_stale_after_seconds = startedStaleAfterSeconds
  if (committedUnfinalizedStaleAfterSeconds !== undefined) args.p_committed_unfinalized_stale_after_seconds = committedUnfinalizedStaleAfterSeconds
  const rpc = await callRpc(operation, args, client)
  if (!rpc.ok) return rpc.failure
  const { data } = rpc
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { outcome: 'invalid_rpc_response', operation }
  const row = data as Record<string, unknown>
  if (
    typeof row.released !== 'number' || typeof row.marked_unknown !== 'number' ||
    typeof row.finalized_from_run !== 'number' || typeof row.finalized_missing !== 'number' ||
    typeof row.ambiguous !== 'number' || typeof row.skipped_concurrent_run !== 'boolean'
  ) {
    return { outcome: 'invalid_rpc_response', operation }
  }
  return {
    outcome: 'success',
    summary: {
      released: row.released,
      markedUnknown: row.marked_unknown,
      finalizedFromRun: row.finalized_from_run,
      finalizedMissing: row.finalized_missing,
      ambiguous: row.ambiguous,
      skippedConcurrentRun: row.skipped_concurrent_run,
    },
  }
}
