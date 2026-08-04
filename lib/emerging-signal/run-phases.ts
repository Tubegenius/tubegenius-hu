// Lease-safe run phase orchestration for the Premium Emerging Signal collector.

import { createAdminClient } from '@/lib/supabase-server'
import {
  isUuid,
  toSignalDatabaseError,
  type OperationFailure,
  type SignalAdminClient,
  type SignalCollectionPhase,
} from './collection-types'

export type SignalRunPhaseStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'partially_completed'
  | 'retryable'
  | 'failed'
  | 'skipped'

export interface SignalRunPhaseRow {
  id: string
  run_id: string
  phase: SignalCollectionPhase
  status: SignalRunPhaseStatus
  attempt: number
  max_attempts: number
  lease_owner: string | null
  lease_acquired_at: string | null
  lease_expires_at: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export type EnsureRunPhasesResult =
  | { outcome: 'success'; phases: SignalRunPhaseRow[] }
  | OperationFailure

export type PhaseClaimResult =
  | { outcome: 'claimed'; phase: SignalRunPhaseRow }
  | { outcome: 'not_claimable'; reason: 'missing' | 'terminal' | 'lease_active' | 'attempts_exhausted' | 'race_lost' }
  | OperationFailure

export type PhaseTransitionResult =
  | { outcome: 'success'; phase: SignalRunPhaseRow }
  | { outcome: 'not_applied'; reason: 'missing' | 'race_lost' | 'attempts_exhausted' }
  | OperationFailure

export type CollectionControlResult =
  | { outcome: 'success'; enabled: boolean; updatedAt: string; updatedBy: string | null }
  | OperationFailure

const PHASE_COLUMNS =
  'id,run_id,phase,status,attempt,max_attempts,lease_owner,lease_acquired_at,lease_expires_at,started_at,completed_at,created_at'

function admin(client?: SignalAdminClient): SignalAdminClient {
  return client ?? createAdminClient()
}

function invalid(message: string): OperationFailure {
  return { outcome: 'invalid_request', message }
}

function databaseFailure(operation: string, error: unknown): OperationFailure {
  return { outcome: 'database_error', operation, error: toSignalDatabaseError(error) }
}

function validLeaseOwner(value: string): boolean {
  return value.trim().length > 0 && value.length <= 200
}

function validLeaseSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 900
}

function asPhaseRows(data: unknown): SignalRunPhaseRow[] | null {
  if (!Array.isArray(data)) return null
  const rows = data as SignalRunPhaseRow[]
  const phases: SignalCollectionPhase[] = ['observation', 'discovery']
  const statuses: SignalRunPhaseStatus[] = ['pending', 'in_progress', 'completed', 'partially_completed', 'retryable', 'failed', 'skipped']
  if (rows.some(row =>
    !row ||
    !isUuid(row.id) ||
    !isUuid(row.run_id) ||
    !phases.includes(row.phase) ||
    !statuses.includes(row.status) ||
    !Number.isInteger(row.attempt) ||
    !Number.isInteger(row.max_attempts) ||
    row.attempt < 0 ||
    row.max_attempts < 1 ||
    row.attempt > row.max_attempts ||
    (row.lease_owner !== null && typeof row.lease_owner !== 'string') ||
    (row.lease_acquired_at !== null && typeof row.lease_acquired_at !== 'string') ||
    (row.lease_expires_at !== null && typeof row.lease_expires_at !== 'string') ||
    (row.started_at !== null && typeof row.started_at !== 'string') ||
    (row.completed_at !== null && typeof row.completed_at !== 'string') ||
    typeof row.created_at !== 'string'
  )) return null
  return rows
}

export async function getCollectionControlState(
  client?: SignalAdminClient,
): Promise<CollectionControlResult> {
  const operation = 'get_signal_collection_control'
  try {
    const { data, error } = await admin(client)
      .from('signal_collection_control')
      .select('enabled,updated_at,updated_by')
      .eq('id', 1)
      .maybeSingle()
    if (error) return databaseFailure(operation, error)
    if (
      !data ||
      typeof data.enabled !== 'boolean' ||
      typeof data.updated_at !== 'string' ||
      (data.updated_by !== null && typeof data.updated_by !== 'string')
    ) {
      return { outcome: 'invalid_rpc_response', operation }
    }
    return { outcome: 'success', enabled: data.enabled, updatedAt: data.updated_at, updatedBy: data.updated_by }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export async function ensureRunPhases(
  runId: string,
  client?: SignalAdminClient,
): Promise<EnsureRunPhasesResult> {
  if (!isUuid(runId)) return invalid('runId must be a UUID.')
  const operation = 'ensure_signal_run_phases'
  const db = admin(client)
  try {
    const { error: insertError } = await db.from('signal_run_phases').upsert(
      [
        { run_id: runId, phase: 'observation' },
        { run_id: runId, phase: 'discovery' },
      ],
      { onConflict: 'run_id,phase', ignoreDuplicates: true },
    )
    if (insertError) return databaseFailure(operation, insertError)

    const { data, error } = await db
      .from('signal_run_phases')
      .select(PHASE_COLUMNS)
      .eq('run_id', runId)
      .order('phase', { ascending: true })
    if (error) return databaseFailure(operation, error)
    const phases = asPhaseRows(data)
    if (!phases || phases.length !== 2 || phases[0].phase === phases[1].phase) {
      return { outcome: 'invalid_rpc_response', operation }
    }
    return { outcome: 'success', phases }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export async function getRunPhase(
  phaseId: string,
  client?: SignalAdminClient,
): Promise<{ outcome: 'success'; phase: SignalRunPhaseRow | null } | OperationFailure> {
  if (!isUuid(phaseId)) return invalid('phaseId must be a UUID.')
  const operation = 'get_signal_run_phase'
  try {
    const { data, error } = await admin(client)
      .from('signal_run_phases')
      .select(PHASE_COLUMNS)
      .eq('id', phaseId)
      .maybeSingle()
    if (error) return databaseFailure(operation, error)
    if (data === null) return { outcome: 'success', phase: null }
    const rows = asPhaseRows([data])
    return rows ? { outcome: 'success', phase: rows[0] } : { outcome: 'invalid_rpc_response', operation }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export async function claimRunPhase(
  input: { phaseId: string; leaseOwner: string; leaseSeconds?: number; now?: Date },
  client?: SignalAdminClient,
): Promise<PhaseClaimResult> {
  if (!isUuid(input.phaseId)) return invalid('phaseId must be a UUID.')
  if (!validLeaseOwner(input.leaseOwner)) return invalid('leaseOwner is required and must be at most 200 characters.')
  const leaseSeconds = input.leaseSeconds ?? 120
  if (!validLeaseSeconds(leaseSeconds)) return invalid('leaseSeconds must be an integer between 1 and 900.')
  const operation = 'claim_signal_run_phase'
  const db = admin(client)

  try {
    const currentResult = await getRunPhase(input.phaseId, db)
    if (currentResult.outcome !== 'success') return currentResult
    const current = currentResult.phase
    if (!current) return { outcome: 'not_claimable', reason: 'missing' }

    const now = input.now ?? new Date()
    const stale =
      current.status === 'in_progress' &&
      current.lease_expires_at !== null &&
      Date.parse(current.lease_expires_at) <= now.getTime()
    if (current.status === 'in_progress' && !stale) return { outcome: 'not_claimable', reason: 'lease_active' }
    if (!['pending', 'retryable', 'in_progress'].includes(current.status)) {
      return { outcome: 'not_claimable', reason: 'terminal' }
    }
    if (current.attempt >= current.max_attempts) return { outcome: 'not_claimable', reason: 'attempts_exhausted' }

    const acquiredAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString()
    let query = db
      .from('signal_run_phases')
      .update({
        status: 'in_progress',
        attempt: current.attempt + 1,
        lease_owner: input.leaseOwner.trim(),
        lease_acquired_at: acquiredAt,
        lease_expires_at: expiresAt,
        started_at: current.started_at ?? acquiredAt,
        completed_at: null,
      })
      .eq('id', current.id)
      .eq('status', current.status)
      .eq('attempt', current.attempt)

    if (stale && current.lease_expires_at) query = query.eq('lease_expires_at', current.lease_expires_at)
    const { data, error } = await query.select(PHASE_COLUMNS).maybeSingle()
    if (error) return databaseFailure(operation, error)
    if (!data) return { outcome: 'not_claimable', reason: 'race_lost' }
    const rows = asPhaseRows([data])
    return rows ? { outcome: 'claimed', phase: rows[0] } : { outcome: 'invalid_rpc_response', operation }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

async function transitionClaimedPhase(
  input: {
    phaseId: string
    leaseOwner: string
    status: Extract<SignalRunPhaseStatus, 'completed' | 'partially_completed' | 'failed' | 'skipped' | 'retryable'>
    now?: Date
  },
  client?: SignalAdminClient,
): Promise<PhaseTransitionResult> {
  if (!isUuid(input.phaseId)) return invalid('phaseId must be a UUID.')
  if (!validLeaseOwner(input.leaseOwner)) return invalid('leaseOwner is required and must be at most 200 characters.')
  const operation = `transition_signal_run_phase_${input.status}`
  const db = admin(client)
  try {
    if (input.status === 'retryable') {
      const currentResult = await getRunPhase(input.phaseId, db)
      if (currentResult.outcome !== 'success') return currentResult
      if (!currentResult.phase) return { outcome: 'not_applied', reason: 'missing' }
      if (currentResult.phase.attempt >= currentResult.phase.max_attempts) {
        return { outcome: 'not_applied', reason: 'attempts_exhausted' }
      }
    }

    const terminal = input.status !== 'retryable'
    const transitionAt = (input.now ?? new Date()).toISOString()
    const { data, error } = await db
      .from('signal_run_phases')
      .update({
        status: input.status,
        lease_owner: null,
        lease_acquired_at: null,
        lease_expires_at: null,
        completed_at: terminal ? transitionAt : null,
      })
      .eq('id', input.phaseId)
      .eq('status', 'in_progress')
      .eq('lease_owner', input.leaseOwner.trim())
      .gt('lease_expires_at', transitionAt)
      .select(PHASE_COLUMNS)
      .maybeSingle()
    if (error) return databaseFailure(operation, error)
    if (!data) return { outcome: 'not_applied', reason: 'race_lost' }
    const rows = asPhaseRows([data])
    return rows ? { outcome: 'success', phase: rows[0] } : { outcome: 'invalid_rpc_response', operation }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export function completeRunPhase(phaseId: string, leaseOwner: string, client?: SignalAdminClient) {
  return transitionClaimedPhase({ phaseId, leaseOwner, status: 'completed' }, client)
}

export function partiallyCompleteRunPhase(phaseId: string, leaseOwner: string, client?: SignalAdminClient) {
  return transitionClaimedPhase({ phaseId, leaseOwner, status: 'partially_completed' }, client)
}

export function failRunPhase(phaseId: string, leaseOwner: string, client?: SignalAdminClient) {
  return transitionClaimedPhase({ phaseId, leaseOwner, status: 'failed' }, client)
}

export function skipRunPhase(phaseId: string, leaseOwner: string, client?: SignalAdminClient) {
  return transitionClaimedPhase({ phaseId, leaseOwner, status: 'skipped' }, client)
}

export function retryRunPhase(phaseId: string, leaseOwner: string, client?: SignalAdminClient) {
  return transitionClaimedPhase({ phaseId, leaseOwner, status: 'retryable' }, client)
}
