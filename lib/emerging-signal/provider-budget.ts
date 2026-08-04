// Server-side, fail-closed wrappers around the provider budget RPCs from 061.
// This module never calls a provider. It only reserves and settles quota units.

import { createAdminClient } from '@/lib/supabase-server'
import {
  isUuid,
  toSignalDatabaseError,
  type OperationFailure,
  type SignalAdminClient,
  type SignalCollectionPhase,
  type SignalProvider,
  type SignalUsageScope,
  type SignalUsageType,
} from './collection-types'

const REQUIRED_UNITS: Record<SignalUsageType, number> = {
  discovery_search: 100,
  observation_stats: 1,
}

export interface ReserveProviderUnitsInput {
  provider: SignalProvider
  usageScope: SignalUsageScope
  usageType: SignalUsageType
  runId: string
  phase: SignalCollectionPhase
  idempotencyKey: string
  units: number
  leaseSeconds?: number
}

export type ReserveProviderUnitsResult =
  | { outcome: 'reserved'; reservationId: string }
  | { outcome: 'budget_exhausted' }
  | OperationFailure

export type BooleanRpcResult =
  | { outcome: 'success'; duplicateSafe: true }
  | OperationFailure

export interface ProviderSettlement {
  reservationId: string
  status: 'committed' | 'committed_unknown'
  duplicate: boolean
  committedUnits?: number
}

export type ProviderSettlementResult =
  | { outcome: 'success'; settlement: ProviderSettlement }
  | OperationFailure

export type ExpireReservationsResult =
  | { outcome: 'success'; expiredCount: number }
  | OperationFailure

function invalid(message: string): OperationFailure {
  return { outcome: 'invalid_request', message }
}

function rpcFailure(operation: string, error: unknown): OperationFailure {
  const normalized = toSignalDatabaseError(error)
  if (normalized.code === 'P0001') {
    return { outcome: 'invalid_transition', message: normalized.message }
  }
  return { outcome: 'database_error', operation, error: normalized }
}

function admin(client?: SignalAdminClient): SignalAdminClient {
  return client ?? createAdminClient()
}

async function callRpc(
  operation: string,
  args: Record<string, unknown>,
  client?: SignalAdminClient,
): Promise<{ ok: true; data: unknown } | { ok: false; failure: OperationFailure }> {
  try {
    const { data, error } = await admin(client).rpc(operation, args)
    if (error) return { ok: false, failure: rpcFailure(operation, error) }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, failure: { outcome: 'database_error', operation, error: toSignalDatabaseError(error) } }
  }
}

export function requiredProviderUnits(usageType: SignalUsageType): number {
  return REQUIRED_UNITS[usageType]
}

export async function reserveProviderUnits(
  input: ReserveProviderUnitsInput,
  client?: SignalAdminClient,
): Promise<ReserveProviderUnitsResult> {
  if (input.provider !== 'youtube') return invalid('Only the youtube provider is supported.')
  if (input.usageScope !== 'background') return invalid('Only the background usage scope is supported.')
  if (!isUuid(input.runId)) return invalid('runId must be a UUID.')
  if (!input.idempotencyKey.trim()) return invalid('idempotencyKey is required.')
  if (input.idempotencyKey.length > 512) return invalid('idempotencyKey is too long.')
  if (input.units !== REQUIRED_UNITS[input.usageType]) {
    return invalid(`${input.usageType} must reserve exactly ${REQUIRED_UNITS[input.usageType]} unit(s).`)
  }
  if (
    (input.usageType === 'discovery_search' && input.phase !== 'discovery') ||
    (input.usageType === 'observation_stats' && input.phase !== 'observation')
  ) {
    return invalid('usageType and phase do not match.')
  }

  const leaseSeconds = input.leaseSeconds ?? 120
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) {
    return invalid('leaseSeconds must be an integer between 1 and 900.')
  }

  const operation = 'reserve_provider_units'
  const rpc = await callRpc(operation, {
    p_provider: input.provider,
    p_usage_scope: input.usageScope,
    p_usage_type: input.usageType,
    p_run_id: input.runId,
    p_phase: input.phase,
    p_idempotency_key: input.idempotencyKey.trim(),
    p_units: input.units,
    p_lease_seconds: leaseSeconds,
  }, client)
  if (!rpc.ok) return rpc.failure
  const { data } = rpc
  if (data === null) return { outcome: 'budget_exhausted' }
  if (typeof data !== 'string' || !isUuid(data)) {
    return { outcome: 'invalid_rpc_response', operation }
  }

  return { outcome: 'reserved', reservationId: data }
}

export async function markProviderAttemptStarted(
  reservationId: string,
  client?: SignalAdminClient,
): Promise<BooleanRpcResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  const operation = 'mark_provider_attempt_started'
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

export async function bindProviderReservationToBatch(
  reservationId: string,
  batchId: string,
  leaseOwner: string,
  client?: SignalAdminClient,
): Promise<BooleanRpcResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  if (!isUuid(batchId)) return invalid('batchId must be a UUID.')
  if (!leaseOwner.trim() || leaseOwner.length > 200) {
    return invalid('leaseOwner is required and must be at most 200 characters.')
  }
  const operation = 'bind_provider_reservation_to_batch'
  const rpc = await callRpc(operation, {
    p_reservation_id: reservationId,
    p_batch_id: batchId,
    p_lease_owner: leaseOwner.trim(),
  }, client)
  if (!rpc.ok) return rpc.failure
  if (rpc.data !== true) return { outcome: 'invalid_rpc_response', operation }
  return { outcome: 'success', duplicateSafe: true }
}

function parseSettlement(
  operation: string,
  data: unknown,
  expectedStatus: ProviderSettlement['status'],
): ProviderSettlementResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { outcome: 'invalid_rpc_response', operation }
  }
  const row = data as Record<string, unknown>
  if (
    typeof row.reservation_id !== 'string' ||
    !isUuid(row.reservation_id) ||
    row.status !== expectedStatus ||
    typeof row.duplicate !== 'boolean' ||
    (row.committed_units !== undefined &&
      (!Number.isInteger(row.committed_units) || Number(row.committed_units) < 1))
  ) {
    return { outcome: 'invalid_rpc_response', operation }
  }
  return {
    outcome: 'success',
    settlement: {
      reservationId: row.reservation_id,
      status: expectedStatus,
      duplicate: row.duplicate,
      committedUnits: typeof row.committed_units === 'number' ? row.committed_units : undefined,
    },
  }
}

export async function commitProviderUnits(
  reservationId: string,
  actualUnits: number,
  client?: SignalAdminClient,
): Promise<ProviderSettlementResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  if (!Number.isInteger(actualUnits) || actualUnits < 1) return invalid('actualUnits must be a positive integer.')
  const operation = 'commit_provider_units'
  const rpc = await callRpc(operation, {
    p_reservation_id: reservationId,
    p_actual_units: actualUnits,
  }, client)
  if (!rpc.ok) return rpc.failure
  return parseSettlement(operation, rpc.data, 'committed')
}

export async function markProviderOutcomeUnknown(
  reservationId: string,
  client?: SignalAdminClient,
): Promise<ProviderSettlementResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  const operation = 'mark_provider_outcome_unknown'
  const rpc = await callRpc(operation, { p_reservation_id: reservationId }, client)
  if (!rpc.ok) return rpc.failure
  return parseSettlement(operation, rpc.data, 'committed_unknown')
}

export async function releaseProviderUnits(
  reservationId: string,
  client?: SignalAdminClient,
): Promise<BooleanRpcResult> {
  if (!isUuid(reservationId)) return invalid('reservationId must be a UUID.')
  const operation = 'release_provider_units'
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

export async function expireStaleProviderReservations(
  provider: SignalProvider | null = 'youtube',
  client?: SignalAdminClient,
): Promise<ExpireReservationsResult> {
  if (provider !== null && provider !== 'youtube') return invalid('Only the youtube provider is supported.')
  const operation = 'expire_stale_provider_reservations'
  const rpc = await callRpc(operation, { p_provider: provider }, client)
  if (!rpc.ok) return rpc.failure
  const { data } = rpc
  if (!Number.isInteger(data) || Number(data) < 0) return { outcome: 'invalid_rpc_response', operation }
  return { outcome: 'success', expiredCount: Number(data) }
}
