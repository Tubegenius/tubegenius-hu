// Semantic Topic Identity v0 -- S3A. Runtime validator for the
// topic_extraction_output_v1 contract (docs/architecture/semantic-topic-identity-v0-contract.md
// SS15; enforced in the DB by the topic_extraction_runs_structured_output_shape
// CHECK in supabase/migrations/073_semantic_topic_s2a_audit_and_temporal_hardening.sql).
//
// This mirrors that CHECK exactly at the top level, PLUS a few app-level
// tightenings the DB CHECK cannot express (Postgres CHECK constraints can't
// validate array-element shape) -- subject_entities elements must be
// non-empty strings, action_or_event/location/temporal_context are length-
// bounded. Those tightenings are stricter than the DB, never looser, so a
// value accepted here is always also accepted by the 073 CHECK.
export interface TopicExtractionOutputV1 {
  extraction_schema_version: number
  canonical_phenomenon_label: string
  label_language: string
  subject_entities: string[]
  action_or_event: string | null
  location: string | null
  temporal_context: string | null
  specificity: 'specific' | 'generic' | 'unknown'
  content_format: 'news_event' | 'phenomenon' | 'product_launch' | 'person_focused' | 'list_ranking' | 'educational' | 'other'
  confidence: number
  supporting_spans: { source_field: string; quoted_text: string }[]
}

const LABEL_LANGUAGE_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/
const CONTENT_FORMATS = new Set([
  'news_event', 'phenomenon', 'product_launch', 'person_focused', 'list_ranking', 'educational', 'other',
])
const SPECIFICITIES = new Set(['specific', 'generic', 'unknown'])
const ALLOWED_KEYS = new Set([
  'extraction_schema_version', 'canonical_phenomenon_label', 'label_language', 'subject_entities',
  'action_or_event', 'location', 'temporal_context', 'specificity', 'content_format', 'confidence', 'supporting_spans',
])

export type StructuredOutputValidation =
  | { ok: true; value: TopicExtractionOutputV1 }
  | { ok: false; errors: string[] }

function optionalBoundedString(value: unknown, field: string, maxLength: number, errors: string[]): void {
  if (value === null) return
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string or null`)
    return
  }
  if (value.length > maxLength) errors.push(`${field} exceeds ${maxLength} characters`)
}

export function validateTopicExtractionOutputV1(raw: unknown, expectedSchemaVersion: number): StructuredOutputValidation {
  const errors: string[] = []

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['structured output is not a JSON object'] }
  }
  const obj = raw as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown top-level key: ${key}`)
  }

  if (typeof obj.extraction_schema_version !== 'number' || obj.extraction_schema_version !== expectedSchemaVersion) {
    errors.push(`extraction_schema_version must equal ${expectedSchemaVersion}`)
  }

  if (
    typeof obj.canonical_phenomenon_label !== 'string' ||
    !obj.canonical_phenomenon_label.trim() ||
    obj.canonical_phenomenon_label.length > 200
  ) {
    errors.push('canonical_phenomenon_label must be a non-blank string of at most 200 characters')
  }

  if (
    typeof obj.label_language !== 'string' ||
    obj.label_language.length > 15 ||
    !LABEL_LANGUAGE_RE.test(obj.label_language)
  ) {
    errors.push('label_language must match the v0 BCP-47 subset')
  }

  if (
    !Array.isArray(obj.subject_entities) ||
    obj.subject_entities.length > 20 ||
    obj.subject_entities.some(e => typeof e !== 'string' || !e.trim() || e.length > 200)
  ) {
    errors.push('subject_entities must be an array of at most 20 non-blank strings (each <= 200 chars)')
  }

  optionalBoundedString(obj.action_or_event, 'action_or_event', 500, errors)
  optionalBoundedString(obj.location, 'location', 500, errors)
  optionalBoundedString(obj.temporal_context, 'temporal_context', 500, errors)

  if (typeof obj.specificity !== 'string' || !SPECIFICITIES.has(obj.specificity)) {
    errors.push('specificity must be one of specific|generic|unknown')
  }

  if (typeof obj.content_format !== 'string' || !CONTENT_FORMATS.has(obj.content_format)) {
    errors.push('content_format must be one of the seven allowed values')
  }

  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) {
    errors.push('confidence must be a finite number in [0, 1]')
  }

  if (
    !Array.isArray(obj.supporting_spans) ||
    obj.supporting_spans.length > 10 ||
    obj.supporting_spans.some(span =>
      typeof span !== 'object' || span === null || Array.isArray(span) ||
      typeof (span as Record<string, unknown>).source_field !== 'string' ||
      typeof (span as Record<string, unknown>).quoted_text !== 'string'
    )
  ) {
    errors.push('supporting_spans must be an array of at most 10 {source_field, quoted_text} string pairs')
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: obj as unknown as TopicExtractionOutputV1 }
}
