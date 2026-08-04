// Deterministic, lease-safe work batches for the Premium Emerging Signal collector.

import { createHash } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase-server'
import {
  isUuid,
  toSignalDatabaseError,
  type OperationFailure,
  type SignalAdminClient,
  type SignalCollectionPhase,
  type SignalProvider,
} from './collection-types'

export type SignalBatchType = 'observation' | 'discovery'
export type SignalBatchStatus = 'pending' | 'in_progress' | 'completed' | 'retryable' | 'failed' | 'outcome_unknown'
export type SignalProviderOperation = 'youtube.videos.list' | 'youtube.search.list'

export interface SignalCollectionBatchRow {
  id: string
  run_phase_id: string
  batch_type: SignalBatchType
  deterministic_batch_key: string
  payload_hash: string
  item_ids: string[]
  algorithm_version: number
  status: SignalBatchStatus
  attempt: number
  max_attempts: number
  lease_owner: string | null
  lease_acquired_at: string | null
  lease_expires_at: string | null
  item_count: number
  completed_item_count: number
  error_class: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface BatchIdentityInput {
  phase: SignalCollectionPhase
  bucket: string
  provider: SignalProvider
  operation: SignalProviderOperation
  itemIds: string[]
  algorithmVersion?: number
}

export interface BatchIdentity {
  canonicalItemIds: string[]
  payloadHash: string
  deterministicBatchKey: string
  algorithmVersion: number
}

export type BuildBatchIdentityResult =
  | { outcome: 'success'; identity: BatchIdentity }
  | Extract<OperationFailure, { outcome: 'invalid_request' }>

export type EnsureBatchResult =
  | { outcome: 'success'; batch: SignalCollectionBatchRow }
  | OperationFailure

export type BatchClaimResult =
  | { outcome: 'claimed'; batch: SignalCollectionBatchRow }
  | { outcome: 'not_claimable'; reason: 'missing' | 'terminal' | 'lease_active' | 'attempts_exhausted' | 'race_lost' }
  | OperationFailure

export type BatchTransitionResult =
  | { outcome: 'success'; batch: SignalCollectionBatchRow }
  | { outcome: 'not_applied'; reason: 'missing' | 'race_lost' | 'attempts_exhausted' }
  | OperationFailure

const BATCH_COLUMNS =
  'id,run_phase_id,batch_type,deterministic_batch_key,payload_hash,item_ids,algorithm_version,status,attempt,max_attempts,lease_owner,lease_acquired_at,lease_expires_at,item_count,completed_item_count,error_class,created_at,started_at,completed_at'

function admin(client?: SignalAdminClient): SignalAdminClient {
  return client ?? createAdminClient()
}

function invalid(message: string): Extract<OperationFailure, { outcome: 'invalid_request' }> {
  return { outcome: 'invalid_request', message }
}

function databaseFailure(operation: string, error: unknown): OperationFailure {
  return { outcome: 'database_error', operation, error: toSignalDatabaseError(error) }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function expectedOperation(phase: SignalCollectionPhase): SignalProviderOperation {
  return phase === 'observation' ? 'youtube.videos.list' : 'youtube.search.list'
}

function validateItemIds(phase: SignalCollectionPhase, itemIds: string[]): string | null {
  if (!Array.isArray(itemIds)) return 'itemIds must be an array.'
  if (itemIds.some(id => typeof id !== 'string' || !id.trim())) return 'Every item ID must be a non-empty string.'
  const uniqueCount = new Set(itemIds.map(id => id.trim())).size
  if (uniqueCount !== itemIds.length) return 'itemIds must not contain duplicates.'
  if (phase === 'discovery' && itemIds.length !== 1) return 'A discovery batch must contain exactly one seed.'
  if (phase === 'observation' && (itemIds.length < 1 || itemIds.length > 50)) {
    return 'An observation batch must contain between 1 and 50 video IDs.'
  }
  return null
}

function asBatchRows(data: unknown): SignalCollectionBatchRow[] | null {
  if (!Array.isArray(data)) return null
  const rows = data as SignalCollectionBatchRow[]
  const batchTypes: SignalBatchType[] = ['observation', 'discovery']
  const statuses: SignalBatchStatus[] = ['pending', 'in_progress', 'completed', 'retryable', 'failed', 'outcome_unknown']
  if (
    rows.some(
      row =>
        !row ||
        !isUuid(row.id) ||
        !isUuid(row.run_phase_id) ||
        !batchTypes.includes(row.batch_type) ||
        !statuses.includes(row.status) ||
        typeof row.deterministic_batch_key !== 'string' ||
        !row.deterministic_batch_key ||
        typeof row.payload_hash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.payload_hash) ||
        !Array.isArray(row.item_ids) ||
        row.item_ids.some(item => typeof item !== 'string') ||
        !Number.isInteger(row.algorithm_version) ||
        row.algorithm_version < 1 ||
        !Number.isInteger(row.attempt) ||
        !Number.isInteger(row.max_attempts) ||
        row.attempt < 0 ||
        row.max_attempts < 1 ||
        row.attempt > row.max_attempts ||
        !Number.isInteger(row.item_count) ||
        !Number.isInteger(row.completed_item_count) ||
        row.item_count !== row.item_ids.length ||
        row.completed_item_count < 0 ||
        row.completed_item_count > row.item_count ||
        (row.lease_owner !== null && typeof row.lease_owner !== 'string') ||
        (row.lease_acquired_at !== null && typeof row.lease_acquired_at !== 'string') ||
        (row.lease_expires_at !== null && typeof row.lease_expires_at !== 'string') ||
        (row.error_class !== null && typeof row.error_class !== 'string') ||
        typeof row.created_at !== 'string' ||
        (row.started_at !== null && typeof row.started_at !== 'string') ||
        (row.completed_at !== null && typeof row.completed_at !== 'string'),
    )
  ) return null
  return rows
}

export function buildBatchIdentity(input: BatchIdentityInput): BuildBatchIdentityResult {
  if (input.provider !== 'youtube') return invalid('Only the youtube provider is supported.')
  if (!input.bucket.trim() || input.bucket.length > 200) return invalid('bucket is required and must be at most 200 characters.')
  if (input.operation !== expectedOperation(input.phase)) return invalid('operation and phase do not match.')
  const itemError = validateItemIds(input.phase, input.itemIds)
  if (itemError) return invalid(itemError)
  const algorithmVersion = input.algorithmVersion ?? 1
  if (!Number.isInteger(algorithmVersion) || algorithmVersion < 1) return invalid('algorithmVersion must be a positive integer.')

  const canonicalItemIds = input.itemIds.map(id => id.trim()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const canonicalPayload = JSON.stringify(canonicalItemIds)
  const payloadHash = sha256(canonicalPayload)
  const keyMaterial = JSON.stringify({
    algorithmVersion,
    phase: input.phase,
    bucket: input.bucket.trim(),
    provider: input.provider,
    operation: input.operation,
    payloadHash,
  })

  return {
    outcome: 'success',
    identity: {
      canonicalItemIds,
      payloadHash,
      deterministicBatchKey: `signal-batch:v${algorithmVersion}:${sha256(keyMaterial)}`,
      algorithmVersion,
    },
  }
}

export function buildProviderReservationIdempotencyKey(batchId: string, attempt: number): string | null {
  if (!isUuid(batchId) || !Number.isInteger(attempt) || attempt < 1) return null
  return `signal-batch:${batchId}:attempt:${attempt}`
}

export async function ensureCollectionBatch(
  input: BatchIdentityInput & { runPhaseId: string; maxAttempts?: number },
  client?: SignalAdminClient,
): Promise<EnsureBatchResult> {
  if (!isUuid(input.runPhaseId)) return invalid('runPhaseId must be a UUID.')
  const maxAttempts = input.maxAttempts ?? 2
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    return invalid('maxAttempts must be an integer between 1 and 10.')
  }
  const identityResult = buildBatchIdentity(input)
  if (identityResult.outcome !== 'success') return identityResult
  const { identity } = identityResult
  const operation = 'ensure_signal_collection_batch'
  const db = admin(client)

  try {
    const { error: insertError } = await db.from('signal_collection_batches').upsert(
      {
        run_phase_id: input.runPhaseId,
        batch_type: input.phase,
        deterministic_batch_key: identity.deterministicBatchKey,
        payload_hash: identity.payloadHash,
        item_ids: identity.canonicalItemIds,
        algorithm_version: identity.algorithmVersion,
        item_count: identity.canonicalItemIds.length,
        max_attempts: maxAttempts,
      },
      { onConflict: 'run_phase_id,deterministic_batch_key', ignoreDuplicates: true },
    )
    if (insertError) return databaseFailure(operation, insertError)

    const { data, error } = await db
      .from('signal_collection_batches')
      .select(BATCH_COLUMNS)
      .eq('run_phase_id', input.runPhaseId)
      .eq('deterministic_batch_key', identity.deterministicBatchKey)
      .maybeSingle()
    if (error) return databaseFailure(operation, error)
    const rows = asBatchRows(data ? [data] : data)
    if (!rows || rows.length !== 1) return { outcome: 'invalid_rpc_response', operation }
    const batch = rows[0]
    if (
      batch.payload_hash !== identity.payloadHash ||
      batch.batch_type !== input.phase ||
      batch.algorithm_version !== identity.algorithmVersion ||
      batch.item_count !== identity.canonicalItemIds.length ||
      JSON.stringify(batch.item_ids) !== JSON.stringify(identity.canonicalItemIds)
    ) {
      return { outcome: 'invalid_rpc_response', operation }
    }
    return { outcome: 'success', batch }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export async function getCollectionBatch(
  batchId: string,
  client?: SignalAdminClient,
): Promise<{ outcome: 'success'; batch: SignalCollectionBatchRow | null } | OperationFailure> {
  if (!isUuid(batchId)) return invalid('batchId must be a UUID.')
  const operation = 'get_signal_collection_batch'
  try {
    const { data, error } = await admin(client)
      .from('signal_collection_batches')
      .select(BATCH_COLUMNS)
      .eq('id', batchId)
      .maybeSingle()
    if (error) return databaseFailure(operation, error)
    if (data === null) return { outcome: 'success', batch: null }
    const rows = asBatchRows([data])
    return rows ? { outcome: 'success', batch: rows[0] } : { outcome: 'invalid_rpc_response', operation }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export async function claimCollectionBatch(
  input: { batchId: string; leaseOwner: string; leaseSeconds?: number; now?: Date },
  client?: SignalAdminClient,
): Promise<BatchClaimResult> {
  if (!isUuid(input.batchId)) return invalid('batchId must be a UUID.')
  if (!input.leaseOwner.trim() || input.leaseOwner.length > 200) return invalid('leaseOwner is required and must be at most 200 characters.')
  const leaseSeconds = input.leaseSeconds ?? 120
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) {
    return invalid('leaseSeconds must be an integer between 1 and 900.')
  }
  const operation = 'claim_signal_collection_batch'
  const db = admin(client)
  try {
    const currentResult = await getCollectionBatch(input.batchId, db)
    if (currentResult.outcome !== 'success') return currentResult
    const current = currentResult.batch
    if (!current) return { outcome: 'not_claimable', reason: 'missing' }
    const now = input.now ?? new Date()
    const stale = current.status === 'in_progress' && current.lease_expires_at !== null && Date.parse(current.lease_expires_at) <= now.getTime()
    if (current.status === 'in_progress' && !stale) return { outcome: 'not_claimable', reason: 'lease_active' }
    if (!['pending', 'retryable', 'in_progress'].includes(current.status)) return { outcome: 'not_claimable', reason: 'terminal' }
    if (current.attempt >= current.max_attempts) return { outcome: 'not_claimable', reason: 'attempts_exhausted' }

    const acquiredAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString()
    let query = db
      .from('signal_collection_batches')
      .update({
        status: 'in_progress',
        attempt: current.attempt + 1,
        lease_owner: input.leaseOwner.trim(),
        lease_acquired_at: acquiredAt,
        lease_expires_at: expiresAt,
        started_at: current.started_at ?? acquiredAt,
        completed_at: null,
        error_class: null,
      })
      .eq('id', current.id)
      .eq('status', current.status)
      .eq('attempt', current.attempt)
    if (stale && current.lease_expires_at) query = query.eq('lease_expires_at', current.lease_expires_at)
    const { data, error } = await query.select(BATCH_COLUMNS).maybeSingle()
    if (error) return databaseFailure(operation, error)
    if (!data) return { outcome: 'not_claimable', reason: 'race_lost' }
    const rows = asBatchRows([data])
    return rows ? { outcome: 'claimed', batch: rows[0] } : { outcome: 'invalid_rpc_response', operation }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

async function transitionClaimedBatch(
  input: {
    batchId: string
    leaseOwner: string
    status: Extract<SignalBatchStatus, 'completed' | 'retryable' | 'failed' | 'outcome_unknown'>
    completedItemCount?: number
    errorClass?: string
    now?: Date
  },
  client?: SignalAdminClient,
): Promise<BatchTransitionResult> {
  if (!isUuid(input.batchId)) return invalid('batchId must be a UUID.')
  if (!input.leaseOwner.trim() || input.leaseOwner.length > 200) return invalid('leaseOwner is required and must be at most 200 characters.')
  if (input.status === 'failed' && (!input.errorClass?.trim() || input.errorClass.length > 200)) {
    return invalid('A failed batch requires an errorClass of at most 200 characters.')
  }
  if (input.status !== 'failed' && input.errorClass !== undefined) return invalid('errorClass is only valid for failed batches.')
  const operation = `transition_signal_collection_batch_${input.status}`
  const db = admin(client)
  try {
    const currentResult = await getCollectionBatch(input.batchId, db)
    if (currentResult.outcome !== 'success') return currentResult
    const current = currentResult.batch
    if (!current) return { outcome: 'not_applied', reason: 'missing' }
    if (input.status === 'retryable' && current.attempt >= current.max_attempts) {
      return { outcome: 'not_applied', reason: 'attempts_exhausted' }
    }
    const completedItemCount = input.status === 'completed'
      ? current.item_count
      : input.completedItemCount ?? current.completed_item_count
    if (!Number.isInteger(completedItemCount) || completedItemCount < 0 || completedItemCount > current.item_count) {
      return invalid('completedItemCount is out of range.')
    }
    const terminal = input.status !== 'retryable'
    const transitionAt = (input.now ?? new Date()).toISOString()
    const { data, error } = await db
      .from('signal_collection_batches')
      .update({
        status: input.status,
        completed_item_count: completedItemCount,
        error_class: input.status === 'failed' ? input.errorClass!.trim() : null,
        lease_owner: null,
        lease_acquired_at: null,
        lease_expires_at: null,
        completed_at: terminal ? transitionAt : null,
      })
      .eq('id', input.batchId)
      .eq('status', 'in_progress')
      .eq('lease_owner', input.leaseOwner.trim())
      .gt('lease_expires_at', transitionAt)
      .select(BATCH_COLUMNS)
      .maybeSingle()
    if (error) return databaseFailure(operation, error)
    if (!data) return { outcome: 'not_applied', reason: 'race_lost' }
    const rows = asBatchRows([data])
    return rows ? { outcome: 'success', batch: rows[0] } : { outcome: 'invalid_rpc_response', operation }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export function completeCollectionBatch(batchId: string, leaseOwner: string, client?: SignalAdminClient) {
  return transitionClaimedBatch({ batchId, leaseOwner, status: 'completed' }, client)
}

export function retryCollectionBatch(batchId: string, leaseOwner: string, completedItemCount = 0, client?: SignalAdminClient) {
  return transitionClaimedBatch({ batchId, leaseOwner, status: 'retryable', completedItemCount }, client)
}

export function failCollectionBatch(
  batchId: string,
  leaseOwner: string,
  errorClass: string,
  completedItemCount = 0,
  client?: SignalAdminClient,
) {
  return transitionClaimedBatch({ batchId, leaseOwner, status: 'failed', errorClass, completedItemCount }, client)
}

export function markCollectionBatchOutcomeUnknown(
  batchId: string,
  leaseOwner: string,
  completedItemCount = 0,
  client?: SignalAdminClient,
) {
  return transitionClaimedBatch({ batchId, leaseOwner, status: 'outcome_unknown', completedItemCount }, client)
}

export async function listBatchReservations(
  batchId: string,
  client?: SignalAdminClient,
): Promise<{ outcome: 'success'; reservations: unknown[] } | OperationFailure> {
  if (!isUuid(batchId)) return invalid('batchId must be a UUID.')
  const operation = 'list_signal_batch_reservations'
  try {
    const { data, error } = await admin(client)
      .from('signal_provider_budget_reservations')
      .select('id,daily_budget_id,run_id,batch_id,phase,idempotency_key,requested_units,committed_units,status,attempt_started_at,lease_expires_at,created_at,committed_at,released_at')
      // The immutable 061 reserve RPC has no batch_id argument. PFM-3B2
      // creates the reservation first; the 063 bind RPC then fills the
      // one-way FK before the provider attempt starts.
      .eq('batch_id', batchId)
      .order('created_at', { ascending: true })
    if (error) return databaseFailure(operation, error)
    if (!Array.isArray(data)) return { outcome: 'invalid_rpc_response', operation }
    return { outcome: 'success', reservations: data }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}
