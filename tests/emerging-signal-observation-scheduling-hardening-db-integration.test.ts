// Real local Supabase proof for the Observation Reliability & Adaptive
// Cadence Hardening round (066) — including the commit-gate RPC hardening
// pass (apply_signal_observation_batch bound to a claimed batch/lease/run).
// The provider is fully mocked where a provider is needed at all: no
// YouTube, Serper, Claude or other external request can occur in this file.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

vi.setConfig({ testTimeout: 30000 })

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function psql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -f -', {
    input: sql, encoding: 'utf8',
  })
}

let stackAvailable = false
try { psql('select 1;'); stackAvailable = true } catch { stackAvailable = false }
const describeIfLocalDb = stackAvailable ? describe : describe.skip

const RUN_SCHEDULED_A = '81000000-0000-4000-8000-000000000001'
const RUN_SCHEDULED_B = '81000000-0000-4000-8000-000000000002'
const RUN_INTERACTIVE = '81000000-0000-4000-8000-000000000003'

const SOURCE_A = '82000000-0000-4000-8000-000000000001'
const SOURCE_B = '82000000-0000-4000-8000-000000000002'

const EVIDENCE_A = '83000000-0000-4000-8000-000000000001'
const EVIDENCE_B_INTERACTIVE = '83000000-0000-4000-8000-000000000002'

const CLUSTER_RECONCILE = '85000000-0000-4000-8000-000000000001'

// All fixture-created runs are tagged with this idempotency-key prefix so
// cleanup and the fixed-id runs above can be deleted together without
// enumerating every randomUUID() run created by the guard/state-machine
// tests below.
const FIXTURE_TAG = 'pfm066'

function cleanFixtures() {
  psql(`
    delete from signal_observations where signal_run_id in (
      select id from signal_runs where idempotency_key like '${FIXTURE_TAG}%'
    );
    delete from signal_observation_schedule where signal_evidence_id in (
      select id from signal_evidence where external_ref like 'pfm066_%'
    );
    delete from signal_cluster_evidence where signal_evidence_id in (
      select id from signal_evidence where external_ref like 'pfm066_%'
    );
    delete from signal_clusters where id = '${CLUSTER_RECONCILE}';
    delete from signal_run_clusters where signal_run_id in (
      select id from signal_runs where idempotency_key like '${FIXTURE_TAG}%'
    );
    delete from signal_evidence where external_ref like 'pfm066_%';
    delete from signal_sources where external_id like 'pfm066_%';
    delete from youtube_videos where video_id like 'pfm066_%';
    delete from signal_provider_budget_reservations where run_id in (
      select id from signal_runs where idempotency_key like '${FIXTURE_TAG}%'
    );
    delete from signal_collection_batches where run_phase_id in (
      select id from signal_run_phases where run_id in (select id from signal_runs where idempotency_key like '${FIXTURE_TAG}%')
    );
    delete from signal_run_provider_usage where run_id in (
      select id from signal_runs where idempotency_key like '${FIXTURE_TAG}%'
    );
    delete from signal_run_phases where run_id in (
      select id from signal_runs where idempotency_key like '${FIXTURE_TAG}%'
    );
    delete from signal_runs where idempotency_key like '${FIXTURE_TAG}%';
  `)
}

function insertScheduledRun(runId: string) {
  psql(`insert into signal_runs(id,run_type,idempotency_key,status) values ('${runId}','scheduled_enrichment','${FIXTURE_TAG}:${runId}','started');`)
}

async function admin() {
  const { createAdminClient } = await import('@/lib/supabase-server')
  return createAdminClient()
}

async function reconcile() {
  const { reconcileMissingObservationSchedules } = await import('@/lib/emerging-signal/observation-schedule')
  return reconcileMissingObservationSchedules()
}

function scheduleRowFor(evidenceId: string) {
  return psql(`select cadence,active,consecutive_stagnant_checks,consecutive_miss_checks,last_view_count,last_like_count,last_comment_count from signal_observation_schedule where signal_evidence_id='${evidenceId}';`).trim()
}

function scheduleIdFor(evidenceId: string) {
  return psql(`select id from signal_observation_schedule where signal_evidence_id='${evidenceId}';`).trim()
}

function insertEvidence(evidenceId: string, sourceId: string, externalId: string, videoRef: string, runId: string) {
  psql(`
    insert into youtube_videos(video_id,title) values ('${videoRef}','Video ${videoRef}') on conflict (video_id) do nothing;
    insert into signal_sources(id,source_type,external_id,source_family_key) values ('${sourceId}','youtube_channel','${externalId}','${externalId}')
      on conflict (source_type,external_id) do nothing;
    insert into signal_evidence(id,signal_source_id,evidence_type,external_ref,youtube_videos_ref,title,discovered_in_run_id) values
      ('${evidenceId}','${sourceId}','youtube_video','${videoRef}','${videoRef}','Video ${videoRef}','${runId}');
  `)
}

// Full real path: creates a fresh scheduled_enrichment run, ensures/claims
// the observation phase, and prepares batches (which will pick up whichever
// evidence rows are currently due — so the callers below always set up the
// schedule row as active+due BEFORE calling this). Returns the prepared
// (NOT YET claimed) batch expected to contain exactly `videoIds`, and a
// leaseOwner string the caller decides how to use — either claim it
// directly (claimFreshBatch, for tests that call the RPC themselves) or
// hand it to processObservationBatch, which claims it on its own.
async function prepareFreshBatch(videoIds: string[], now: Date) {
  const runId = randomUUID()
  insertScheduledRun(runId)
  const { ensureRunPhases, claimRunPhase } = await import('@/lib/emerging-signal/run-phases')
  const { prepareObservationBatches } = await import('@/lib/emerging-signal/observation-schedule')

  const phases = await ensureRunPhases(runId)
  if (phases.outcome !== 'success') throw new Error(`ensureRunPhases: ${JSON.stringify(phases)}`)
  const observation = phases.phases.find(row => row.phase === 'observation')!
  const leaseOwner = `guard-test:${runId}`
  const claimedPhase = await claimRunPhase({ phaseId: observation.id, leaseOwner, leaseSeconds: 300, now })
  if (claimedPhase.outcome !== 'claimed') throw new Error(`claimRunPhase: ${JSON.stringify(claimedPhase)}`)
  const prepared = await prepareObservationBatches({ runPhaseId: observation.id, now })
  if (prepared.outcome !== 'success') throw new Error(`prepareObservationBatches: ${JSON.stringify(prepared)}`)
  const wanted = [...videoIds].sort()
  const batch = prepared.batches.find(row => JSON.stringify([...row.item_ids].sort()) === JSON.stringify(wanted))
  if (!batch) throw new Error(`expected batch with item_ids=${JSON.stringify(wanted)} not found among ${JSON.stringify(prepared.batches.map(b => b.item_ids))}`)
  return { runId, batchId: batch.id, leaseOwner }
}

// prepareFreshBatch + an explicit claim — for tests that call
// apply_signal_observation_batch directly (bypassing processObservationBatch,
// which would otherwise claim the batch itself).
async function claimFreshBatch(videoIds: string[], now: Date) {
  const { runId, batchId, leaseOwner } = await prepareFreshBatch(videoIds, now)
  const { claimCollectionBatch } = await import('@/lib/emerging-signal/batches')
  const claimedBatch = await claimCollectionBatch({ batchId, leaseOwner, leaseSeconds: 300, now })
  if (claimedBatch.outcome !== 'claimed') throw new Error(`claimCollectionBatch: ${JSON.stringify(claimedBatch)}`)
  return { runId, batchId, leaseOwner }
}

function resultItem(evidenceId: string, videoId: string, found: boolean, metrics?: { view: number; like?: number; comment?: number }) {
  return {
    schedule_id: scheduleIdFor(evidenceId), evidence_id: evidenceId, video_id: videoId, found,
    view_count: found ? metrics!.view : null,
    like_count: found ? (metrics?.like ?? null) : null,
    comment_count: found ? (metrics?.comment ?? null) : null,
  }
}

async function callApply(args: Record<string, unknown>) {
  const db = await admin()
  return db.rpc('apply_signal_observation_batch', args)
}

describeIfLocalDb.sequential('PFM Observation Reliability & Adaptive Cadence Hardening (066)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
  })
  beforeEach(() => cleanFixtures())
  afterAll(() => cleanFixtures())

  it('a scheduled_enrichment YouTube evidence insert atomically creates exactly one schedule row', () => {
    insertScheduledRun(RUN_SCHEDULED_A)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', RUN_SCHEDULED_A)
    expect(psql(`select count(*) from signal_observation_schedule where signal_evidence_id='${EVIDENCE_A}';`).trim()).toBe('1')
    expect(scheduleRowFor(EVIDENCE_A)).toBe('daily|t|0|0|||')
  })

  it('an interactive opportunity_side_effect YouTube evidence insert never gets an automatic schedule row', () => {
    psql(`insert into signal_runs(id,run_type,idempotency_key,status) values ('${RUN_INTERACTIVE}','opportunity_side_effect','${FIXTURE_TAG}:${RUN_INTERACTIVE}','started');`)
    insertEvidence(EVIDENCE_B_INTERACTIVE, SOURCE_B, 'pfm066_channel_b', 'pfm066_video_b', RUN_INTERACTIVE)
    expect(psql(`select count(*) from signal_observation_schedule where signal_evidence_id='${EVIDENCE_B_INTERACTIVE}';`).trim()).toBe('0')
  })

  it('reconciliation backfills a schedule for evidence the scheduled lane re-finds later, is idempotent, and does not duplicate under concurrency', async () => {
    psql(`insert into signal_runs(id,run_type,idempotency_key,status) values ('${RUN_INTERACTIVE}','opportunity_side_effect','${FIXTURE_TAG}:${RUN_INTERACTIVE}','started');`)
    insertEvidence(EVIDENCE_B_INTERACTIVE, SOURCE_B, 'pfm066_channel_b', 'pfm066_video_b', RUN_INTERACTIVE)
    expect(psql(`select count(*) from signal_observation_schedule where signal_evidence_id='${EVIDENCE_B_INTERACTIVE}';`).trim()).toBe('0')

    insertScheduledRun(RUN_SCHEDULED_B)
    psql(`
      insert into signal_clusters(id,primary_label,category,cluster_fingerprint,fingerprint_version,created_by_run_id) values
        ('${CLUSTER_RECONCILE}','pfm066 reconcile cluster','default','pfm066-reconcile-fingerprint-32chars-min',1,'${RUN_SCHEDULED_B}');
      insert into signal_cluster_evidence(signal_cluster_id,signal_evidence_id,linked_in_run_id,relation_type) values
        ('${CLUSTER_RECONCILE}','${EVIDENCE_B_INTERACTIVE}','${RUN_SCHEDULED_B}','supports');
    `)

    const first = await reconcile()
    expect(first).toMatchObject({ outcome: 'success', insertedCount: 1 })
    expect(psql(`select cadence,active from signal_observation_schedule where signal_evidence_id='${EVIDENCE_B_INTERACTIVE}';`).trim()).toBe('daily|t')

    const second = await reconcile()
    expect(second).toMatchObject({ outcome: 'success', insertedCount: 0 })
    expect(psql(`select count(*) from signal_observation_schedule where signal_evidence_id='${EVIDENCE_B_INTERACTIVE}';`).trim()).toBe('1')

    psql(`delete from signal_observation_schedule where signal_evidence_id='${EVIDENCE_B_INTERACTIVE}';`)
    const [a, b] = await Promise.all([reconcile(), reconcile()])
    const totalInserted = (a as { insertedCount: number }).insertedCount + (b as { insertedCount: number }).insertedCount
    expect(totalInserted).toBe(1)
    expect(psql(`select count(*) from signal_observation_schedule where signal_evidence_id='${EVIDENCE_B_INTERACTIVE}';`).trim()).toBe('1')
  })

  it('walks the full adaptive cadence state machine, claiming with real lease time but a controlled business observed_at, with weekly steps genuinely 7 days apart', async () => {
    const runId0 = randomUUID()
    insertScheduledRun(runId0)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', runId0)
    // Force the seed row due far in the past (relative to BOTH real time and our
    // simulated business clock below) so the very first claim picks it up immediately.
    psql(`update signal_observation_schedule set next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)

    // The claimed batch's lease_expires_at is computed from the `now` handed to
    // claimFreshBatch and is checked against REAL wall-clock time by the pre-
    // existing 063 batch-claim RPCs — so claiming always uses REAL `new Date()`.
    // The cadence state machine itself only cares about the RPC's OWN
    // `p_observed_at` business parameter, which we advance independently (via
    // the schedule's own computed next_due_at) without waiting real days/weeks.
    async function observe(viewCount: number | null) {
      const dueAt = psql(`select next_due_at from signal_observation_schedule where signal_evidence_id='${EVIDENCE_A}';`).trim()
      const businessObservedAt = new Date(dueAt)
      const { runId, batchId, leaseOwner } = await claimFreshBatch(['pfm066_video_a'], new Date())
      const found = viewCount !== null
      const res = await callApply({
        p_run_id: runId, p_batch_id: batchId, p_lease_owner: leaseOwner, p_observed_at: businessObservedAt.toISOString(),
        p_results: [resultItem(EVIDENCE_A, 'pfm066_video_a', found, found ? { view: viewCount!, like: 10, comment: 5 } : undefined)],
      })
      expect(res.error).toBeNull()
      return scheduleRowFor(EVIDENCE_A)
    }

    // 1) First observation — no previous measurement, so NOT stagnant regardless of value.
    expect(await observe(100)).toBe('daily|t|0|0|100|10|5')
    const afterFirst = new Date(psql(`select next_due_at from signal_observation_schedule where signal_evidence_id='${EVIDENCE_A}';`).trim())
    // 2)+3) Two more identical-view observations — stagnant count climbs but stays daily (<3).
    expect(await observe(100)).toBe('daily|t|1|0|100|10|5')
    expect(await observe(100)).toBe('daily|t|2|0|100|10|5')
    // 4) Third consecutive proven-stagnant observation -> promotes to weekly, counter resets.
    expect(await observe(100)).toBe('weekly|t|0|0|100|10|5')
    // Confirm the promotion genuinely moved next_due_at 7 SIMULATED days out, not 1 — measured
    // against the previous step's own next_due_at, not real wall-clock time.
    const afterPromotion = new Date(psql(`select next_due_at from signal_observation_schedule where signal_evidence_id='${EVIDENCE_A}';`).trim())
    const daysAhead = (afterPromotion.getTime() - afterFirst.getTime()) / 86_400_000
    expect(daysAhead).toBeGreaterThan(6)

    // 5)-7) Three more stagnant checks while weekly (each a genuine 7-simulated-day jump) — stays weekly.
    for (let i = 0; i < 3; i++) await observe(100)
    expect(scheduleRowFor(EVIDENCE_A)).toBe('weekly|t|3|0|100|10|5')

    // 8) Fourth consecutive stagnant check while weekly -> deactivates, counter pinned at 4.
    expect(await observe(100)).toBe('weekly|f|4|0|100|10|5')

    // Reactivate directly (066's RPC refuses to touch an inactive row — see the
    // dedicated guard test below) to exercise the "real change while weekly -> daily" path.
    // last_observed_at must move back too, or the RPC's own stale-observed_at guard
    // (tested separately below) would correctly refuse this earlier next_due_at.
    psql(`update signal_observation_schedule set active=true, cadence='weekly', consecutive_stagnant_checks=2, next_due_at='2020-01-01T00:00:00Z', last_observed_at='2019-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    expect(await observe(999)).toBe('daily|t|0|0|999|10|5')

    // Miss handling: first miss -> still active; second consecutive miss -> deactivates.
    expect(await observe(null)).toBe('daily|t|0|1|999|10|5')
    expect(await observe(null)).toBe('daily|f|0|2|999|10|5')

    // A later successful, genuinely-changed find resets the miss counter to 0 and reactivates.
    psql(`update signal_observation_schedule set active=true, next_due_at='2020-01-01T00:00:00Z', last_observed_at='2019-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    expect(await observe(1000)).toBe('daily|t|0|0|1000|10|5')
  })

  it('provider timeout/quota/failure outcomes never call the RPC and leave cadence/counters byte-identical', async () => {
    const runId = randomUUID()
    insertScheduledRun(runId)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', runId)
    psql(`update signal_observation_schedule set next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    const before = scheduleRowFor(EVIDENCE_A)

    const { ensureRunPhases, claimRunPhase } = await import('@/lib/emerging-signal/run-phases')
    const { prepareObservationBatches } = await import('@/lib/emerging-signal/observation-schedule')
    const { processObservationBatch } = await import('@/lib/emerging-signal/observation-worker')
    const phases = await ensureRunPhases(runId)
    if (phases.outcome !== 'success') throw new Error(JSON.stringify(phases))
    const observation = phases.phases.find(row => row.phase === 'observation')!
    const claimed = await claimRunPhase({ phaseId: observation.id, leaseOwner: 'hardening-error-path', leaseSeconds: 200 })
    if (claimed.outcome !== 'claimed') throw new Error(JSON.stringify(claimed))
    const prepared = await prepareObservationBatches({ runPhaseId: observation.id })
    if (prepared.outcome !== 'success') throw new Error(JSON.stringify(prepared))

    const timedOut = await processObservationBatch({
      batchId: prepared.batches[0].id, runId, leaseOwner: 'hardening-error-path',
      provider: { fetchVideoStats: async () => ({ outcome: 'outcome_unknown', errorClass: 'timeout' }) },
    })
    expect(timedOut.outcome).toBe('outcome_unknown')
    expect(scheduleRowFor(EVIDENCE_A)).toBe(before)
  })

  it('rolls back the entire batch when one item in a multi-item payload is invalid — no partial commit', async () => {
    const runId = randomUUID()
    insertScheduledRun(runId)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', runId)
    const evidenceOk2 = randomUUID()
    insertEvidence(evidenceOk2, SOURCE_B, 'pfm066_channel_a2', 'pfm066_video_a2', runId)
    psql(`update signal_observation_schedule set next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id in ('${EVIDENCE_A}','${evidenceOk2}');`)
    const before = scheduleRowFor(EVIDENCE_A)
    const now = new Date()
    const { runId: batchRunId, batchId, leaseOwner } = await claimFreshBatch(['pfm066_video_a', 'pfm066_video_a2'], now)

    const res = await callApply({
      p_run_id: batchRunId, p_batch_id: batchId, p_lease_owner: leaseOwner, p_observed_at: now.toISOString(),
      p_results: [
        resultItem(EVIDENCE_A, 'pfm066_video_a', true, { view: 42 }),
        { schedule_id: '00000000-0000-4000-8000-000000000000', evidence_id: '00000000-0000-4000-8000-000000000000', video_id: 'pfm066_video_a2', found: true, view_count: 1, like_count: null, comment_count: null },
      ],
    })
    expect(res.error).not.toBeNull()
    expect(scheduleRowFor(EVIDENCE_A)).toBe(before)
    expect(psql(`select count(*) from signal_observations where signal_evidence_id='${EVIDENCE_A}';`).trim()).toBe('0')
  })

  it('rejects every corrupted call variant with a full rollback, and leaves the schedule row untouched each time', async () => {
    const runId = randomUUID()
    insertScheduledRun(runId)
    const otherRunId = randomUUID()
    insertScheduledRun(otherRunId)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', runId)
    const now = new Date()

    async function freshValidCall() {
      psql(`update signal_observation_schedule set next_due_at='2020-01-01T00:00:00Z', active=true, last_observed_at=null where signal_evidence_id='${EVIDENCE_A}';`)
      const { runId: batchRunId, batchId, leaseOwner } = await claimFreshBatch(['pfm066_video_a'], now)
      return {
        p_run_id: batchRunId, p_batch_id: batchId, p_lease_owner: leaseOwner, p_observed_at: now.toISOString(),
        p_results: [resultItem(EVIDENCE_A, 'pfm066_video_a', true, { view: 500, like: 1, comment: 1 })],
      }
    }

    const scenarios: Array<[string, (args: Record<string, unknown>) => Record<string, unknown>]> = [
      ['nonexistent batch_id', args => ({ ...args, p_batch_id: '00000000-0000-4000-8000-000000000000' })],
      ['batch belongs to a different run', args => ({ ...args, p_run_id: otherRunId })],
      ['wrong lease_owner', args => ({ ...args, p_lease_owner: 'someone-else' })],
      ['payload video_id does not match batch item_ids', args => ({
        ...args,
        p_results: [{ ...(args.p_results as Record<string, unknown>[])[0], video_id: 'pfm066_video_wrong' }],
      })],
      ['video_id does not match the evidence row', args => {
        const item = (args.p_results as Record<string, unknown>[])[0]
        return { ...args, p_results: [{ ...item, video_id: 'pfm066_totally_different_video' }] }
      }],
      ['fractional view_count', args => ({
        ...args,
        p_results: [{ ...(args.p_results as Record<string, unknown>[])[0], view_count: 1.5 }],
      })],
      ['negative view_count', args => ({
        ...args,
        p_results: [{ ...(args.p_results as Record<string, unknown>[])[0], view_count: -5 }],
      })],
      ['view_count beyond the JS safe-integer bound', args => ({
        ...args,
        p_results: [{ ...(args.p_results as Record<string, unknown>[])[0], view_count: 9007199254740992 }],
      })],
      ['found=false carrying metric values', args => ({
        ...args,
        p_results: [{ ...(args.p_results as Record<string, unknown>[])[0], found: false, view_count: null, like_count: 3, comment_count: null }],
      })],
    ]

    for (const [label, corrupt] of scenarios) {
      const valid = await freshValidCall()
      const before = scheduleRowFor(EVIDENCE_A)
      const res = await callApply(corrupt(valid))
      expect(res.error, `expected an error for scenario: ${label}`).not.toBeNull()
      expect(scheduleRowFor(EVIDENCE_A), `schedule row changed for scenario: ${label}`).toBe(before)
    }
  })

  it('rejects an expired lease with a full rollback', async () => {
    const runId = randomUUID()
    insertScheduledRun(runId)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', runId)
    psql(`update signal_observation_schedule set next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    const now = new Date()
    const { runId: batchRunId, batchId, leaseOwner } = await claimFreshBatch(['pfm066_video_a'], now)
    psql(`update signal_collection_batches set lease_expires_at = now() - interval '1 minute' where id='${batchId}';`)
    const before = scheduleRowFor(EVIDENCE_A)

    const res = await callApply({
      p_run_id: batchRunId, p_batch_id: batchId, p_lease_owner: leaseOwner, p_observed_at: now.toISOString(),
      p_results: [resultItem(EVIDENCE_A, 'pfm066_video_a', true, { view: 10 })],
    })
    expect(res.error).not.toBeNull()
    expect(scheduleRowFor(EVIDENCE_A)).toBe(before)
  })

  it('rejects an inactive schedule and a not-yet-due schedule, refusing to reactivate or pre-empt via direct RPC call', async () => {
    const runId = randomUUID()
    insertScheduledRun(runId)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', runId)
    const now = new Date()

    // Inactive schedule — claim the batch FIRST while active+due (otherwise
    // prepareObservationBatches would never offer it at all), THEN flip
    // active=false directly via SQL right before calling the RPC, so this
    // isolates the RPC's OWN guard from the app-level eligibility filter.
    psql(`update signal_observation_schedule set active=true, next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    let claim = await claimFreshBatch(['pfm066_video_a'], now)
    psql(`update signal_observation_schedule set active=false where signal_evidence_id='${EVIDENCE_A}';`)
    let res = await callApply({
      p_run_id: claim.runId, p_batch_id: claim.batchId, p_lease_owner: claim.leaseOwner, p_observed_at: now.toISOString(),
      p_results: [resultItem(EVIDENCE_A, 'pfm066_video_a', true, { view: 10 })],
    })
    expect(res.error).not.toBeNull()
    expect(psql(`select active from signal_observation_schedule where signal_evidence_id='${EVIDENCE_A}';`).trim()).toBe('f')

    // Not yet due — same pattern: claim while active+due, then push
    // next_due_at into the future right before calling the RPC directly.
    psql(`update signal_observation_schedule set active=true, next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    claim = await claimFreshBatch(['pfm066_video_a'], now)
    psql(`update signal_observation_schedule set next_due_at=now() + interval '1 day' where signal_evidence_id='${EVIDENCE_A}';`)
    const before = scheduleRowFor(EVIDENCE_A)
    res = await callApply({
      p_run_id: claim.runId, p_batch_id: claim.batchId, p_lease_owner: claim.leaseOwner, p_observed_at: now.toISOString(),
      p_results: [resultItem(EVIDENCE_A, 'pfm066_video_a', true, { view: 10 })],
    })
    expect(res.error).not.toBeNull()
    expect(scheduleRowFor(EVIDENCE_A)).toBe(before)
  })

  it('rejects an observed_at older than the schedule\'s last_observed_at', async () => {
    const runId = randomUUID()
    insertScheduledRun(runId)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', runId)
    psql(`update signal_observation_schedule set next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    const now = new Date()
    // Simulate a later successful measurement already on record.
    psql(`update signal_observation_schedule set last_observed_at = now() + interval '1 day', last_view_count=1, next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    const before = scheduleRowFor(EVIDENCE_A)
    const claim = await claimFreshBatch(['pfm066_video_a'], now)

    const res = await callApply({
      p_run_id: claim.runId, p_batch_id: claim.batchId, p_lease_owner: claim.leaseOwner, p_observed_at: now.toISOString(),
      p_results: [resultItem(EVIDENCE_A, 'pfm066_video_a', true, { view: 999 })],
    })
    expect(res.error).not.toBeNull()
    expect(scheduleRowFor(EVIDENCE_A)).toBe(before)
  })

  it('rejects a second application of the exact same successful call (replay), and allows exactly one winner under real concurrency', async () => {
    // Replay: after a successful apply, next_due_at moves to the future, so an
    // identical repeat with the SAME p_observed_at must now fail closed.
    let runId = randomUUID()
    insertScheduledRun(runId)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', runId)
    psql(`update signal_observation_schedule set next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    let now = new Date()
    let claim = await claimFreshBatch(['pfm066_video_a'], now)
    const args = {
      p_run_id: claim.runId, p_batch_id: claim.batchId, p_lease_owner: claim.leaseOwner, p_observed_at: now.toISOString(),
      p_results: [resultItem(EVIDENCE_A, 'pfm066_video_a', true, { view: 100 })],
    }
    const firstCall = await callApply(args)
    expect(firstCall.error).toBeNull()
    const afterFirst = scheduleRowFor(EVIDENCE_A)
    const replay = await callApply(args)
    expect(replay.error).not.toBeNull()
    expect(scheduleRowFor(EVIDENCE_A)).toBe(afterFirst)

    // Concurrency: two callers race for the SAME claimed batch/lease/payload —
    // exactly one may commit, the other must fail closed.
    cleanFixtures()
    runId = randomUUID()
    insertScheduledRun(runId)
    insertEvidence(EVIDENCE_A, SOURCE_A, 'pfm066_channel_a', 'pfm066_video_a', runId)
    psql(`update signal_observation_schedule set next_due_at='2020-01-01T00:00:00Z' where signal_evidence_id='${EVIDENCE_A}';`)
    now = new Date()
    claim = await claimFreshBatch(['pfm066_video_a'], now)
    const raceArgs = {
      p_run_id: claim.runId, p_batch_id: claim.batchId, p_lease_owner: claim.leaseOwner, p_observed_at: now.toISOString(),
      p_results: [resultItem(EVIDENCE_A, 'pfm066_video_a', true, { view: 200 })],
    }
    const [a, b] = await Promise.all([callApply(raceArgs), callApply(raceArgs)])
    const succeeded = [a, b].filter(r => r.error === null)
    const failed = [a, b].filter(r => r.error !== null)
    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(psql(`select count(*) from signal_observations where signal_evidence_id='${EVIDENCE_A}' and metric_type='youtube_view_count';`).trim()).toBe('1')
  })

  it('drift-fail-fast: tampering with the reconcile RPC body makes a 066 re-run fail closed, and dropping+recreating restores a clean idempotent re-run', () => {
    const tamperSql = `
      CREATE OR REPLACE FUNCTION public.reconcile_missing_signal_observation_schedules()
      RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
      AS $body$ BEGIN RETURN 0; END; $body$;
    `
    psql(tamperSql)
    const migrationSql = readFileSync(join(process.cwd(), 'supabase/migrations/066_harden_signal_observation_scheduling.sql'), 'utf8')
    let threw = false
    try {
      execSync(
        'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f -',
        { input: migrationSql, encoding: 'utf8' },
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    psql('DROP FUNCTION public.reconcile_missing_signal_observation_schedules();')
    execSync(
      'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f -',
      { input: migrationSql, encoding: 'utf8' },
    )
    expect(psql(`select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where proname='reconcile_missing_signal_observation_schedules';`).trim())
      .toBe('c8f0784b89b785423622f49d9a3bc6e1')
  })

  it('trg_schedule_new_scheduled_youtube_evidence ACL is postgres-only, and it still fires correctly through the real service_role insert path', async () => {
    expect(psql(`select grantee||':'||privilege_type from information_schema.role_routine_grants where routine_name='trg_schedule_new_scheduled_youtube_evidence' order by grantee;`).trim())
      .toBe('postgres:EXECUTE')

    // Exercise the real service_role admin-client insert path (not raw psql-as-postgres) —
    // this is exactly how capture.ts's captureScheduledDiscovery writes evidence in production.
    const runId = randomUUID()
    insertScheduledRun(runId)
    const db = await admin()
    const { error: videoError } = await db.from('youtube_videos').insert({ video_id: 'pfm066_video_a', title: 'Video pfm066_video_a' })
    expect(videoError).toBeNull()
    const { error } = await db.from('signal_sources').insert({
      id: SOURCE_A, source_type: 'youtube_channel', external_id: 'pfm066_channel_a', source_family_key: 'pfm066_channel_a',
    })
    expect(error).toBeNull()
    const { error: evidenceError } = await db.from('signal_evidence').insert({
      id: EVIDENCE_A, signal_source_id: SOURCE_A, evidence_type: 'youtube_video',
      external_ref: 'pfm066_video_a', youtube_videos_ref: 'pfm066_video_a', title: 'Video pfm066_video_a',
      discovered_in_run_id: runId,
    })
    expect(evidenceError).toBeNull()
    expect(psql(`select count(*) from signal_observation_schedule where signal_evidence_id='${EVIDENCE_A}';`).trim()).toBe('1')
  })
})
