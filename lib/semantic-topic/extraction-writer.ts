// Semantic Topic Identity v0 -- S3A. Thin wrapper around the ALREADY
// INSTALLED (074) record_topic_extraction_run writer RPC, plus a read-only
// completed-cache lookup. This module never writes to topic_extraction_runs
// directly -- the 074 RPC remains the sole write path, exactly as its own
// contract requires (docs/architecture/semantic-topic-identity-v0-contract.md
// SS26). It does not touch record_topic_assignment_decision at all --
// calling that RPC is out of S3A's scope (see extraction-service.ts).
import { createAdminClient } from '@/lib/supabase-server'
import {
  AI_QUOTA_PRICE_INPUT_PER_MILLION_USD,
  AI_QUOTA_PRICE_OUTPUT_PER_MILLION_USD,
  SEMANTIC_TOPIC_EXTRACTION_METHOD,
  SEMANTIC_TOPIC_EXTRACTION_MODEL,
  SEMANTIC_TOPIC_EXTRACTION_PROVIDER,
  SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION,
  SEMANTIC_TOPIC_NORMALIZATION_VERSION,
  SEMANTIC_TOPIC_PROMPT_VERSION,
} from './extraction-config'
import type { TopicExtractionOutputV1 } from './structured-output-schema'
import type { SemanticTopicAdminClient } from './quota-types'

function admin(client?: SemanticTopicAdminClient): SemanticTopicAdminClient {
  return client ?? createAdminClient()
}

export interface CompletedExtractionCacheHit {
  extractionRunId: string
}

// Read-only pre-check -- service_role has SELECT on topic_extraction_runs
// (074 grant matrix). Used BEFORE spending a reservation, per the S3A gate's
// "előbb ellenőrizze a completed cache-t; csak cache-miss esetén rezerváljon".
export async function findCompletedExtractionRun(
  signalEvidenceId: string,
  normalizedInputDigest: string,
  extractionConfigDigest: string,
  client?: SemanticTopicAdminClient,
): Promise<CompletedExtractionCacheHit | null> {
  const { data, error } = await admin(client)
    .from('topic_extraction_runs')
    .select('id')
    .eq('signal_evidence_id', signalEvidenceId)
    .eq('normalized_input_digest', normalizedInputDigest)
    .eq('extraction_config_digest', extractionConfigDigest)
    .eq('status', 'completed')
    .maybeSingle()
  if (error) throw new Error(`findCompletedExtractionRun: ${error.message}`)
  return data ? { extractionRunId: data.id as string } : null
}

interface RecordExtractionRunRpcResponse {
  ok: boolean
  outcome: 'created' | 'replayed' | 'cache_hit'
  extraction_run_id: string
  status: 'completed' | 'failed'
  idempotency_key: string
}

export interface RecordCompletedExtractionRunInput {
  signalEvidenceId: string
  normalizedExtractionInput: string
  promptVersion: string
  structuredOutput: TopicExtractionOutputV1
  inputTokens: number
  outputTokens: number
  idempotencyKey: string
  startedAt: string
  completedAt: string
}

export interface RecordExtractionRunResult {
  extractionRunId: string
  outcome: 'created' | 'replayed' | 'cache_hit'
  status: 'completed' | 'failed'
}

function estimatedCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * AI_QUOTA_PRICE_INPUT_PER_MILLION_USD + outputTokens * AI_QUOTA_PRICE_OUTPUT_PER_MILLION_USD) / 1_000_000
}

export async function recordCompletedExtractionRun(
  input: RecordCompletedExtractionRunInput,
  client?: SemanticTopicAdminClient,
): Promise<RecordExtractionRunResult> {
  const { data, error } = await admin(client).rpc('record_topic_extraction_run', {
    p_signal_evidence_id: input.signalEvidenceId,
    p_normalization_version: SEMANTIC_TOPIC_NORMALIZATION_VERSION,
    p_extraction_method: SEMANTIC_TOPIC_EXTRACTION_METHOD,
    p_provider: SEMANTIC_TOPIC_EXTRACTION_PROVIDER,
    p_model: SEMANTIC_TOPIC_EXTRACTION_MODEL,
    p_prompt_version: input.promptVersion,
    p_deterministic_extractor_version: null,
    p_normalized_extraction_input: input.normalizedExtractionInput,
    p_extraction_schema_version: SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION,
    p_status: 'completed',
    p_structured_output: input.structuredOutput,
    p_input_tokens: input.inputTokens,
    p_output_tokens: input.outputTokens,
    p_estimated_cost_usd: estimatedCostUsd(input.inputTokens, input.outputTokens),
    p_error_class: null,
    p_idempotency_key: input.idempotencyKey,
    p_started_at: input.startedAt,
    p_completed_at: input.completedAt,
  })
  if (error) throw new Error(`recordCompletedExtractionRun: ${error.message}`)
  const row = data as RecordExtractionRunRpcResponse
  return { extractionRunId: row.extraction_run_id, outcome: row.outcome, status: row.status }
}

export interface RecordFailedExtractionRunInput {
  signalEvidenceId: string
  normalizedExtractionInput: string
  promptVersion: string
  errorClass: string
  idempotencyKey: string
  startedAt: string
  completedAt: string
}

export async function recordFailedExtractionRun(
  input: RecordFailedExtractionRunInput,
  client?: SemanticTopicAdminClient,
): Promise<RecordExtractionRunResult> {
  const { data, error } = await admin(client).rpc('record_topic_extraction_run', {
    p_signal_evidence_id: input.signalEvidenceId,
    p_normalization_version: SEMANTIC_TOPIC_NORMALIZATION_VERSION,
    p_extraction_method: SEMANTIC_TOPIC_EXTRACTION_METHOD,
    p_provider: SEMANTIC_TOPIC_EXTRACTION_PROVIDER,
    p_model: SEMANTIC_TOPIC_EXTRACTION_MODEL,
    p_prompt_version: input.promptVersion,
    p_deterministic_extractor_version: null,
    p_normalized_extraction_input: input.normalizedExtractionInput,
    p_extraction_schema_version: SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION,
    p_status: 'failed',
    p_structured_output: null,
    p_input_tokens: null,
    p_output_tokens: null,
    p_estimated_cost_usd: null,
    p_error_class: input.errorClass,
    p_idempotency_key: input.idempotencyKey,
    p_started_at: input.startedAt,
    p_completed_at: input.completedAt,
  })
  if (error) throw new Error(`recordFailedExtractionRun: ${error.message}`)
  const row = data as RecordExtractionRunRpcResponse
  return { extractionRunId: row.extraction_run_id, outcome: row.outcome, status: row.status }
}

// Re-exported so callers building the prompt_version they pass to both
// reserveAiProviderUnits and recordCompletedExtractionRun/recordFailedExtractionRun
// use the exact same pinned value -- see digest.ts header for why this
// consistency is load-bearing, not cosmetic.
export { SEMANTIC_TOPIC_PROMPT_VERSION }
