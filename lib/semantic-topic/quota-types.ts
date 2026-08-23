// Semantic Topic Identity v0 -- S3A. Small, generic, self-contained
// utilities for the AI-provider quota layer. Deliberately NOT imported from
// lib/emerging-signal/collection-types.ts even though that module has
// near-identical helpers: the S3A design-closure gate requires this
// subsystem to be fully isolated from the signal_provider_* (YouTube
// collector) code path, so this is its own copy rather than a shared
// dependency -- a future change to the collector's types can never affect
// this module, and vice versa.
import type { createAdminClient } from '@/lib/supabase-server'

export type SemanticTopicAdminClient = ReturnType<typeof createAdminClient>

export interface AiQuotaDatabaseError {
  code?: string
  message: string
  details?: string
  hint?: string
}

export type AiQuotaOperationFailure =
  | { outcome: 'invalid_request'; message: string }
  | { outcome: 'invalid_transition'; message: string }
  | { outcome: 'database_error'; operation: string; error: AiQuotaDatabaseError }
  | { outcome: 'invalid_rpc_response'; operation: string }

export function toAiQuotaDatabaseError(error: unknown): AiQuotaDatabaseError {
  if (error && typeof error === 'object') {
    const source = error as Record<string, unknown>
    return {
      code: typeof source.code === 'string' ? source.code : undefined,
      message: typeof source.message === 'string' ? source.message : 'Unknown database error',
      details: typeof source.details === 'string' ? source.details : undefined,
      hint: typeof source.hint === 'string' ? source.hint : undefined,
    }
  }
  return { message: error instanceof Error ? error.message : String(error) }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
