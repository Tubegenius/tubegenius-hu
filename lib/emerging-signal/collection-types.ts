// WillViral Premium Emerging Signal collection orchestration types.

import type { createAdminClient } from '@/lib/supabase-server'

export type SignalAdminClient = ReturnType<typeof createAdminClient>

export type SignalCollectionPhase = 'observation' | 'discovery'
export type SignalProvider = 'youtube'
export type SignalUsageScope = 'background'
export type SignalUsageType = 'discovery_search' | 'observation_stats'

export interface SignalDatabaseError {
  code?: string
  message: string
  details?: string
  hint?: string
}

export type OperationFailure =
  | { outcome: 'invalid_request'; message: string }
  | { outcome: 'invalid_transition'; message: string }
  | { outcome: 'database_error'; operation: string; error: SignalDatabaseError }
  | { outcome: 'invalid_rpc_response'; operation: string }

export function toSignalDatabaseError(error: unknown): SignalDatabaseError {
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
