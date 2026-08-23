// Semantic Topic Identity v0 -- S3A digest helpers.
//
// These MUST stay byte-identical to the equivalent server-side computation
// in supabase/migrations/074_semantic_topic_s2b_writer_rpcs.sql
// (record_topic_extraction_run) and 075_semantic_topic_s3a_ai_quota_foundation.sql
// (reserve_ai_provider_units) -- both RPCs recompute these digests
// server-side from raw inputs and never trust a caller-supplied digest, so
// this module exists only so the SERVICE layer can do a read-only
// completed-cache pre-check (SELECT against topic_extraction_runs) BEFORE
// spending a reservation, using the exact same key the RPCs will use. A
// dedicated integration test (tests/semantic-topic-s3a-ai-quota-db-integration.test.ts)
// proves this TypeScript computation and the Postgres computation produce
// the identical digest for the same inputs -- if that test ever fails after
// an edit here or in the migration, the cache/attempt-limit checks would
// silently stop matching rows and this module's whole purpose breaks.
import { createHash } from 'node:crypto'
import {
  SEMANTIC_TOPIC_EXTRACTION_METHOD,
} from './extraction-config'

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

// Mirrors Postgres to_json() for the three scalar kinds this module ever
// canonicalizes: JSON.stringify already produces spec-compliant JSON string
// escaping (quotes/backslashes/control chars/Unicode) for strings, and the
// plain decimal text Postgres emits for integers -- both are exercised
// against the real RPC output in the cross-digest integration test.
function jsonField(value: string | number | null): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

export function computeNormalizedInputDigest(normalizedExtractionInput: string): string {
  return sha256Hex(normalizedExtractionInput)
}

export interface ExtractionConfigDigestInput {
  normalizationVersion: number
  extractionSchemaVersion: number
  provider: string
  model: string
  promptVersion: string
}

// Byte-identical field order/format to both 074's own extraction_config_digest
// and 075's reserve_ai_provider_units -- extraction_method is pinned to
// 'ai_assisted' and deterministic_extractor_version to JSON null, exactly as
// both RPCs pin them for this layer's v0 scope.
export function computeExtractionConfigDigest(input: ExtractionConfigDigestInput): string {
  const text =
    '{"extraction_method":' + jsonField(SEMANTIC_TOPIC_EXTRACTION_METHOD) +
    ',"normalization_version":' + jsonField(input.normalizationVersion) +
    ',"extraction_schema_version":' + jsonField(input.extractionSchemaVersion) +
    ',"provider":' + jsonField(input.provider) +
    ',"model":' + jsonField(input.model) +
    ',"prompt_version":' + jsonField(input.promptVersion) +
    ',"deterministic_extractor_version":null}'
  return sha256Hex(text)
}
