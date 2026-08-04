import { describe, expect, it, vi } from 'vitest'
import type { SignalAdminClient } from '@/lib/emerging-signal/collection-types'
import {
  commitProviderUnits,
  expireStaleProviderReservations,
  markProviderAttemptStarted,
  markProviderOutcomeUnknown,
  releaseProviderUnits,
  reserveProviderUnits,
} from '@/lib/emerging-signal/provider-budget'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222'

function clientWithRpc(implementation: (...args: any[]) => any) {
  return { rpc: vi.fn(implementation) } as unknown as SignalAdminClient
}

describe('provider budget wrappers', () => {
  it('passes only the fixed server contract and never accepts quota_date/limit_units', async () => {
    const client = clientWithRpc(async () => ({ data: RESERVATION_ID, error: null }))
    const result = await reserveProviderUnits({
      provider: 'youtube', usageScope: 'background', usageType: 'discovery_search',
      runId: RUN_ID, phase: 'discovery', idempotencyKey: 'batch-1', units: 100,
    }, client)
    expect(result).toEqual({ outcome: 'reserved', reservationId: RESERVATION_ID })
    expect(client.rpc).toHaveBeenCalledWith('reserve_provider_units', {
      p_provider: 'youtube', p_usage_scope: 'background', p_usage_type: 'discovery_search',
      p_run_id: RUN_ID, p_phase: 'discovery', p_idempotency_key: 'batch-1',
      p_units: 100, p_lease_seconds: 120,
    })
    const args = (client.rpc as any).mock.calls[0][1]
    expect(args).not.toHaveProperty('p_quota_date')
    expect(args).not.toHaveProperty('p_limit_units')
  })

  it('rejects mismatched phases and non-canonical units before touching the DB', async () => {
    const client = clientWithRpc(async () => ({ data: null, error: null }))
    expect((await reserveProviderUnits({
      provider: 'youtube', usageScope: 'background', usageType: 'discovery_search',
      runId: RUN_ID, phase: 'observation', idempotencyKey: 'x', units: 100,
    }, client)).outcome).toBe('invalid_request')
    expect((await reserveProviderUnits({
      provider: 'youtube', usageScope: 'background', usageType: 'observation_stats',
      runId: RUN_ID, phase: 'observation', idempotencyKey: 'x', units: 2,
    }, client)).outcome).toBe('invalid_request')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('maps a null reservation to a fail-closed budget_exhausted result', async () => {
    const client = clientWithRpc(async () => ({ data: null, error: null }))
    const result = await reserveProviderUnits({
      provider: 'youtube', usageScope: 'background', usageType: 'observation_stats',
      runId: RUN_ID, phase: 'observation', idempotencyKey: 'x', units: 1,
    }, client)
    expect(result).toEqual({ outcome: 'budget_exhausted' })
  })

  it('maps transition errors and thrown transport failures without throwing', async () => {
    const transitionClient = clientWithRpc(async () => ({ data: null, error: { code: 'P0001', message: 'not reserved' } }))
    expect((await releaseProviderUnits(RESERVATION_ID, transitionClient)).outcome).toBe('invalid_transition')

    const throwingClient = clientWithRpc(async () => { throw new Error('offline') })
    const result = await markProviderAttemptStarted(RESERVATION_ID, throwingClient)
    expect(result.outcome).toBe('database_error')
  })

  it('validates settlement response shapes and preserves duplicate metadata', async () => {
    const committed = clientWithRpc(async () => ({
      data: { reservation_id: RESERVATION_ID, status: 'committed', committed_units: 1, duplicate: true },
      error: null,
    }))
    const result = await commitProviderUnits(RESERVATION_ID, 1, committed)
    expect(result).toEqual({
      outcome: 'success',
      settlement: { reservationId: RESERVATION_ID, status: 'committed', committedUnits: 1, duplicate: true },
    })

    const malformed = clientWithRpc(async () => ({ data: { status: 'committed' }, error: null }))
    expect((await commitProviderUnits(RESERVATION_ID, 1, malformed)).outcome).toBe('invalid_rpc_response')
  })

  it('covers started, unknown, release and stale-expiry RPC contracts', async () => {
    expect((await markProviderAttemptStarted(RESERVATION_ID, clientWithRpc(async () => ({ data: true, error: null })))).outcome).toBe('success')
    expect((await markProviderOutcomeUnknown(RESERVATION_ID, clientWithRpc(async () => ({
      data: { reservation_id: RESERVATION_ID, status: 'committed_unknown', duplicate: false }, error: null,
    })))).outcome).toBe('success')
    expect((await releaseProviderUnits(RESERVATION_ID, clientWithRpc(async () => ({ data: true, error: null })))).outcome).toBe('success')
    expect(await expireStaleProviderReservations('youtube', clientWithRpc(async () => ({ data: 3, error: null })))).toEqual({ outcome: 'success', expiredCount: 3 })
  })
})
