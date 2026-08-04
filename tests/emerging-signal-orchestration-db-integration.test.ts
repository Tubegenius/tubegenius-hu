// Real local Supabase integration and concurrency proof for PFM-3B2.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'

vi.setConfig({ testTimeout: 30000 })

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -f -', {
    input: sql,
    encoding: 'utf8',
  })
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}

const describeIfLocalDb = stackAvailable ? describe : describe.skip

const RUNS = {
  phases: '31000000-0000-4000-8000-000000000001',
  stale: '31000000-0000-4000-8000-000000000002',
  batches: '31000000-0000-4000-8000-000000000003',
  replay: '31000000-0000-4000-8000-000000000004',
  budgetA: '31000000-0000-4000-8000-000000000005',
  budgetB: '31000000-0000-4000-8000-000000000006',
  budgetC: '31000000-0000-4000-8000-000000000007',
  budgetD: '31000000-0000-4000-8000-000000000008',
} as const

function cleanFixtures() {
  dockerPsql(`
    delete from signal_run_provider_usage where run_id in (select id from signal_runs where idempotency_key like 'pfm3b2:%');
    delete from signal_provider_budget_reservations where run_id in (select id from signal_runs where idempotency_key like 'pfm3b2:%');
    delete from signal_collection_batches where run_phase_id in (
      select id from signal_run_phases where run_id in (select id from signal_runs where idempotency_key like 'pfm3b2:%')
    );
    delete from signal_run_phases where run_id in (select id from signal_runs where idempotency_key like 'pfm3b2:%');
    delete from signal_runs where idempotency_key like 'pfm3b2:%';
    delete from signal_provider_daily_budgets where not exists (
      select 1 from signal_provider_budget_reservations r where r.daily_budget_id = signal_provider_daily_budgets.id
    );
  `)
}

function insertRun(id: string, key: string) {
  dockerPsql(`
    insert into signal_runs (id, run_type, idempotency_key, status)
    values ('${id}', 'scheduled_enrichment', 'pfm3b2:${key}', 'started');
  `)
}

describeIfLocalDb.sequential('PFM-3B2 orchestration — real local DB integration', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
  })

  beforeEach(() => cleanFixtures())
  afterAll(() => cleanFixtures())

  it('reads the fail-closed kill switch and creates exactly two idempotent phase rows', async () => {
    insertRun(RUNS.phases, 'phases')
    const { ensureRunPhases, getCollectionControlState } = await import('@/lib/emerging-signal/run-phases')
    expect(await getCollectionControlState()).toMatchObject({ outcome: 'success', enabled: false })
    const first = await ensureRunPhases(RUNS.phases)
    const second = await ensureRunPhases(RUNS.phases)
    expect(first.outcome).toBe('success')
    expect(second.outcome).toBe('success')
    expect(dockerPsql(`select count(*) from signal_run_phases where run_id='${RUNS.phases}';`).trim()).toBe('2')
  })

  it('allows exactly one concurrent phase claimant and rejects the losing transition', async () => {
    insertRun(RUNS.phases, 'phase-race')
    const { ensureRunPhases, claimRunPhase, completeRunPhase } = await import('@/lib/emerging-signal/run-phases')
    const ensured = await ensureRunPhases(RUNS.phases)
    if (ensured.outcome !== 'success') throw new Error(JSON.stringify(ensured))
    const phase = ensured.phases.find(row => row.phase === 'discovery')!
    const [a, b] = await Promise.all([
      claimRunPhase({ phaseId: phase.id, leaseOwner: 'worker-a' }),
      claimRunPhase({ phaseId: phase.id, leaseOwner: 'worker-b' }),
    ])
    const claimed = [a, b].filter(result => result.outcome === 'claimed')
    expect(claimed).toHaveLength(1)
    const winner = claimed[0].outcome === 'claimed' ? claimed[0].phase.lease_owner! : ''
    expect((await completeRunPhase(phase.id, winner)).outcome).toBe('success')
    expect((await completeRunPhase(phase.id, winner === 'worker-a' ? 'worker-b' : 'worker-a')).outcome).toBe('not_applied')
  })

  it('reclaims an expired phase lease exactly once and increments the attempt', async () => {
    insertRun(RUNS.stale, 'stale-phase')
    const { ensureRunPhases, claimRunPhase, completeRunPhase } = await import('@/lib/emerging-signal/run-phases')
    const ensured = await ensureRunPhases(RUNS.stale)
    if (ensured.outcome !== 'success') throw new Error(JSON.stringify(ensured))
    const phase = ensured.phases.find(row => row.phase === 'observation')!
    const past = new Date(Date.now() - 10 * 60_000)
    expect((await claimRunPhase({ phaseId: phase.id, leaseOwner: 'expired-worker', leaseSeconds: 1, now: past })).outcome).toBe('claimed')
    expect((await completeRunPhase(phase.id, 'expired-worker')).outcome).toBe('not_applied')
    const reclaimed = await claimRunPhase({ phaseId: phase.id, leaseOwner: 'recovery-worker' })
    expect(reclaimed.outcome).toBe('claimed')
    if (reclaimed.outcome === 'claimed') expect(reclaimed.phase.attempt).toBe(2)
  })

  it('deduplicates batch creation and permits one concurrent batch claimant', async () => {
    insertRun(RUNS.batches, 'batch-race')
    const { ensureRunPhases } = await import('@/lib/emerging-signal/run-phases')
    const {
      ensureCollectionBatch, claimCollectionBatch, completeCollectionBatch,
      buildProviderReservationIdempotencyKey, listBatchReservations,
    } = await import('@/lib/emerging-signal/batches')
    const budget = await import('@/lib/emerging-signal/provider-budget')
    const phases = await ensureRunPhases(RUNS.batches)
    if (phases.outcome !== 'success') throw new Error(JSON.stringify(phases))
    const observation = phases.phases.find(row => row.phase === 'observation')!
    const input = {
      runPhaseId: observation.id,
      phase: 'observation' as const,
      bucket: '2026-08-04T00:00:00Z',
      provider: 'youtube' as const,
      operation: 'youtube.videos.list' as const,
      itemIds: ['video-c', 'video-a', 'video-b'],
    }
    const [first, second] = await Promise.all([ensureCollectionBatch(input), ensureCollectionBatch(input)])
    expect(first.outcome).toBe('success')
    expect(second.outcome).toBe('success')
    if (first.outcome !== 'success' || second.outcome !== 'success') return
    expect(first.batch.id).toBe(second.batch.id)
    expect(first.batch.item_ids).toEqual(['video-a', 'video-b', 'video-c'])
    const [a, b] = await Promise.all([
      claimCollectionBatch({ batchId: first.batch.id, leaseOwner: 'batch-worker-a' }),
      claimCollectionBatch({ batchId: first.batch.id, leaseOwner: 'batch-worker-b' }),
    ])
    const claimed = [a, b].filter(result => result.outcome === 'claimed')
    expect(claimed).toHaveLength(1)
    const winner = claimed[0].outcome === 'claimed' ? claimed[0].batch.lease_owner! : ''
    const reservationKey = buildProviderReservationIdempotencyKey(first.batch.id, 1)!
    const reservation = await budget.reserveProviderUnits({
      provider: 'youtube', usageScope: 'background', usageType: 'observation_stats',
      runId: RUNS.batches, phase: 'observation', idempotencyKey: reservationKey, units: 1,
    })
    expect(reservation.outcome).toBe('reserved')
    const history = await listBatchReservations(first.batch.id)
    expect(history.outcome).toBe('success')
    if (history.outcome === 'success') expect(history.reservations).toHaveLength(1)
    if (reservation.outcome === 'reserved') {
      expect((await budget.markProviderAttemptStarted(reservation.reservationId)).outcome).toBe('success')
      expect((await budget.commitProviderUnits(reservation.reservationId, 1)).outcome).toBe('success')
    }
    const completed = await completeCollectionBatch(first.batch.id, winner)
    expect(completed.outcome).toBe('success')
    if (completed.outcome === 'success') expect(completed.batch.completed_item_count).toBe(3)
  })

  it('deduplicates concurrent reservations and enforces the 300-unit discovery ceiling', async () => {
    insertRun(RUNS.replay, 'budget-replay')
    insertRun(RUNS.budgetA, 'budget-a')
    insertRun(RUNS.budgetB, 'budget-b')
    insertRun(RUNS.budgetC, 'budget-c')
    insertRun(RUNS.budgetD, 'budget-d')
    const { reserveProviderUnits } = await import('@/lib/emerging-signal/provider-budget')
    const reserve = (runId: string, key: string) => reserveProviderUnits({
      provider: 'youtube', usageScope: 'background', usageType: 'discovery_search',
      runId, phase: 'discovery', idempotencyKey: key, units: 100,
    })
    const [replayA, replayB] = await Promise.all([
      reserve(RUNS.replay, 'pfm3b2-replay'),
      reserve(RUNS.replay, 'pfm3b2-replay'),
    ])
    expect(replayA.outcome).toBe('reserved')
    expect(replayB.outcome).toBe('reserved')
    if (replayA.outcome === 'reserved' && replayB.outcome === 'reserved') expect(replayA.reservationId).toBe(replayB.reservationId)
    expect(dockerPsql(`select reserved_units from signal_provider_daily_budgets where usage_type='discovery_search';`).trim()).toBe('100')

    const results = await Promise.all([
      reserve(RUNS.budgetA, 'pfm3b2-a'),
      reserve(RUNS.budgetB, 'pfm3b2-b'),
      reserve(RUNS.budgetC, 'pfm3b2-c'),
    ])
    expect(results.filter(result => result.outcome === 'reserved')).toHaveLength(2)
    expect(results.filter(result => result.outcome === 'budget_exhausted')).toHaveLength(1)
    expect(dockerPsql(`select reserved_units + committed_units from signal_provider_daily_budgets where usage_type='discovery_search';`).trim()).toBe('300')
  })

  it('settles success/unknown/release states and keeps ledger invariants exact', async () => {
    insertRun(RUNS.budgetA, 'settle-a')
    insertRun(RUNS.budgetB, 'settle-b')
    insertRun(RUNS.budgetC, 'settle-c')
    const budget = await import('@/lib/emerging-signal/provider-budget')
    const reserveObservation = (runId: string, key: string) => budget.reserveProviderUnits({
      provider: 'youtube', usageScope: 'background', usageType: 'observation_stats',
      runId, phase: 'observation', idempotencyKey: key, units: 1,
    })
    const success = await reserveObservation(RUNS.budgetA, 'pfm3b2-success')
    const unknown = await reserveObservation(RUNS.budgetB, 'pfm3b2-unknown')
    const released = await reserveObservation(RUNS.budgetC, 'pfm3b2-release')
    if (success.outcome !== 'reserved' || unknown.outcome !== 'reserved' || released.outcome !== 'reserved') throw new Error('reservation failed')
    expect((await budget.markProviderAttemptStarted(success.reservationId)).outcome).toBe('success')
    expect((await budget.commitProviderUnits(success.reservationId, 1)).outcome).toBe('success')
    expect((await budget.markProviderAttemptStarted(unknown.reservationId)).outcome).toBe('success')
    expect((await budget.markProviderOutcomeUnknown(unknown.reservationId)).outcome).toBe('success')
    expect((await budget.releaseProviderUnits(released.reservationId)).outcome).toBe('success')
    expect(dockerPsql(`
      select count(*) from signal_provider_daily_budgets
      where reserved_units < 0 or committed_units < 0 or reserved_units + committed_units > limit_units;
    `).trim()).toBe('0')
    expect(dockerPsql(`
      select count(*) from signal_run_provider_usage
      where successful_attempts + unknown_outcome_attempts + failed_attempts <> attempts;
    `).trim()).toBe('0')
  })
})
