// Real local Supabase proof for PFM-3B4. The search provider is fully mocked;
// no YouTube, Serper, Claude or other external provider request can occur.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import type { SignalAdminClient } from '@/lib/emerging-signal/collection-types'

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

const RUN_SUCCESS = '52000000-0000-4000-8000-000000000001'
const RUN_EMPTY = '52000000-0000-4000-8000-000000000002'
const RUN_UNKNOWN = '52000000-0000-4000-8000-000000000003'
const RUN_CONCURRENT = '52000000-0000-4000-8000-000000000004'
const RUN_REPEAT = '52000000-0000-4000-8000-000000000005'
const RUN_INVALID = '52000000-0000-4000-8000-000000000006'
const RUN_QUOTA = '52000000-0000-4000-8000-000000000007'
const RUN_IDS = [RUN_SUCCESS, RUN_EMPTY, RUN_UNKNOWN, RUN_CONCURRENT, RUN_REPEAT, RUN_INVALID, RUN_QUOTA]

interface RpcCall { name: string; args: Record<string, unknown> }

// Provider-budget RPCs have their own real-DB state-machine suite in
// emerging-signal-orchestration-db-integration.test.ts (including the exact
// 300-unit cap). They are isolated here so parallel Vitest files cannot race
// on that intentionally global daily quota row. Every table write performed
// by the discovery capture itself still uses the real local Supabase DB.
function isolatedWorkerClient(): { client: SignalAdminClient; rpcCalls: RpcCall[] } {
  const db = createClient(LOCAL_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const rpcCalls: RpcCall[] = []
  const client = {
    from: db.from.bind(db),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      if (name === 'reserve_provider_units') return { data: randomUUID(), error: null }
      if (name === 'bind_provider_reservation_to_batch' || name === 'mark_provider_attempt_started' || name === 'release_provider_units') {
        return { data: true, error: null }
      }
      if (name === 'commit_provider_units') return {
        data: {
          reservation_id: args.p_reservation_id,
          status: 'committed', duplicate: false, committed_units: args.p_actual_units,
        },
        error: null,
      }
      if (name === 'mark_provider_outcome_unknown') return {
        data: { reservation_id: args.p_reservation_id, status: 'committed_unknown', duplicate: false, committed_units: 100 },
        error: null,
      }
      return { data: null, error: { message: `Unexpected RPC: ${name}` } }
    }),
  } as unknown as SignalAdminClient
  return { client, rpcCalls }
}

function cleanFixtures() {
  const ids = RUN_IDS.map(id => `'${id}'`).join(',')
  psql(`
    delete from signal_observations where signal_run_id in (${ids});
    delete from signal_observation_schedule where signal_evidence_id in (
      select id from signal_evidence where external_ref like 'pfm3b4_%'
    );
    delete from signal_run_clusters where signal_run_id in (${ids});
    delete from signal_cluster_evidence where linked_in_run_id in (${ids}) or signal_evidence_id in (
      select id from signal_evidence where external_ref like 'pfm3b4_%'
    );
    delete from signal_evidence where discovered_in_run_id in (${ids});
    delete from signal_cluster_members where signal_cluster_id in (
      select id from signal_clusters where created_by_run_id in (${ids})
    );
    delete from signal_clusters where created_by_run_id in (${ids});
    delete from signal_sources where external_id like 'pfm3b4_%';
    delete from youtube_videos where video_id like 'pfm3b4_%';
    delete from signal_provider_budget_reservations where run_id in (${ids});
    delete from signal_collection_batches where run_phase_id in (
      select id from signal_run_phases where run_id in (${ids})
    );
    delete from signal_run_provider_usage where run_id in (${ids});
    delete from signal_run_phases where run_id in (${ids});
    delete from signal_seed_queue where seed_fingerprint like 'pfm3b4_%';
    delete from signal_runs where id in (${ids});
    delete from signal_provider_daily_budgets where not exists (
      select 1 from signal_provider_budget_reservations r where r.daily_budget_id=signal_provider_daily_budgets.id
    );
  `)
}

function seedRun(runId: string, suffix: string) {
  psql(`
    insert into signal_runs(id,run_type,idempotency_key,status)
      values ('${runId}','scheduled_enrichment','pfm3b4:${suffix}','started');
    insert into signal_seed_queue(seed_fingerprint,seed_type,seed_text,category,region,language,next_due_at)
      values ('pfm3b4_${suffix}','curated_global','Emerging AI robotics ${suffix}','tech_ai','BOTH','en',clock_timestamp()-interval '1 day');
  `)
}

async function prepare(runId: string) {
  const phasesModule = await import('@/lib/emerging-signal/run-phases')
  const seedsModule = await import('@/lib/emerging-signal/seed-selection')
  const phases = await phasesModule.ensureRunPhases(runId)
  if (phases.outcome !== 'success') throw new Error(JSON.stringify(phases))
  const discovery = phases.phases.find(row => row.phase === 'discovery')!
  const claimed = await phasesModule.claimRunPhase({ phaseId: discovery.id, leaseOwner: `phase-${runId}`, leaseSeconds: 200 })
  if (claimed.outcome !== 'claimed') throw new Error(JSON.stringify(claimed))
  const prepared = await seedsModule.prepareDiscoveryBatches({ runPhaseId: discovery.id, limit: 3 })
  if (prepared.outcome !== 'success') throw new Error(JSON.stringify(prepared))
  const suffix = runId === RUN_SUCCESS ? 'success'
    : runId === RUN_EMPTY ? 'empty'
      : runId === RUN_UNKNOWN ? 'unknown'
        : runId === RUN_CONCURRENT ? 'concurrent'
          : runId === RUN_QUOTA ? 'quota'
            : 'invalid'
  const batch = prepared.batches.find(row => row.item_ids[0] === `pfm3b4_${suffix}`)
  if (!batch) throw new Error('Expected discovery batch was not prepared.')
  return batch
}

function videos(suffix: string) {
  return [
    {
      videoId: `pfm3b4_${suffix}_video_a`, title: `Robot breakthrough ${suffix}`,
      description: 'Fresh primary evidence', channelId: `pfm3b4_${suffix}_channel`,
      channelTitle: 'Premium Signal Lab', publishedAt: '2026-08-04T08:00:00.000Z',
    },
    {
      videoId: `pfm3b4_${suffix}_video_b`, title: `AI prototype ${suffix}`,
      channelId: `pfm3b4_${suffix}_channel`, channelTitle: 'Premium Signal Lab',
      publishedAt: '2026-08-04T09:00:00.000Z',
    },
  ]
}

describeIfLocalDb.sequential('PFM-3B4 discovery worker — real local DB, mocked search provider', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
  })
  beforeEach(() => cleanFixtures())
  afterAll(() => cleanFixtures())

  it('uses one search, captures evidence in bulk, and schedules later observations without fabricating metrics', async () => {
    seedRun(RUN_SUCCESS, 'success')
    const batch = await prepare(RUN_SUCCESS)
    const requests: unknown[] = []
    const { client, rpcCalls } = isolatedWorkerClient()
    const { processDiscoveryBatch } = await import('@/lib/emerging-signal/discovery-worker')
    const result = await processDiscoveryBatch({
      batchId: batch.id, runId: RUN_SUCCESS, leaseOwner: 'discovery-success',
      provider: { search: async request => { requests.push(request); return { outcome: 'success', videos: videos('success') } } },
    }, client)
    expect(result).toMatchObject({ outcome: 'completed', evidenceCount: 2, scheduledCount: 2 })
    expect(requests).toEqual([{ query: 'Emerging AI robotics success', region: 'BOTH', language: 'en', maxResults: 25 }])
    expect(psql(`select count(*) from signal_evidence where discovered_in_run_id='${RUN_SUCCESS}';`).trim()).toBe('2')
    expect(psql(`select count(*) from signal_cluster_evidence where linked_in_run_id='${RUN_SUCCESS}';`).trim()).toBe('2')
    expect(psql(`select count(*) from signal_observation_schedule where signal_evidence_id in (select id from signal_evidence where discovered_in_run_id='${RUN_SUCCESS}');`).trim()).toBe('2')
    expect(psql(`select count(*) from signal_observations where signal_run_id='${RUN_SUCCESS}';`).trim()).toBe('0')
    expect(rpcCalls.filter(call => call.name === 'reserve_provider_units')).toHaveLength(1)
    expect(rpcCalls.find(call => call.name === 'reserve_provider_units')?.args).toMatchObject({
      p_usage_type: 'discovery_search', p_units: 100,
    })
    expect(rpcCalls.filter(call => call.name === 'commit_provider_units')).toHaveLength(1)
    expect(psql(`select consecutive_failure_count||':'||(last_run_at is not null)::text from signal_seed_queue where seed_fingerprint='pfm3b4_success';`).trim()).toBe('0:true')

    // An idempotent retry in the same run must preserve that run's original
    // new-evidence count, while a later run must report the same rows as old.
    const { captureScheduledDiscovery } = await import('@/lib/emerging-signal/capture')
    const sameRunRetry = await captureScheduledDiscovery({
      runId: RUN_SUCCESS, seedFingerprint: 'pfm3b4_success',
      seedText: 'Emerging AI robotics success', category: 'tech_ai',
      videos: videos('success'),
    })
    expect(sameRunRetry.outcome).toBe('success')
    expect(psql(`select new_evidence_count from signal_run_clusters where signal_run_id='${RUN_SUCCESS}';`).trim()).toBe('2')

    psql(`insert into signal_runs(id,run_type,idempotency_key,status)
      values ('${RUN_REPEAT}','scheduled_enrichment','pfm3b4:repeat','started');`)
    const repeated = await captureScheduledDiscovery({
      runId: RUN_REPEAT, seedFingerprint: 'pfm3b4_success',
      seedText: 'Emerging AI robotics success', category: 'tech_ai',
      videos: videos('success'),
    })
    expect(repeated).toMatchObject({ outcome: 'success', evidenceCount: 2, scheduledCount: 2 })
    expect(psql(`select new_evidence_count from signal_run_clusters where signal_run_id='${RUN_REPEAT}';`).trim()).toBe('0')
  })

  it('completes an empty discovery honestly with zero evidence and zero observations', async () => {
    seedRun(RUN_EMPTY, 'empty')
    const batch = await prepare(RUN_EMPTY)
    const { client } = isolatedWorkerClient()
    const { processDiscoveryBatch } = await import('@/lib/emerging-signal/discovery-worker')
    const result = await processDiscoveryBatch({
      batchId: batch.id, runId: RUN_EMPTY, leaseOwner: 'discovery-empty',
      provider: { search: async () => ({ outcome: 'success', videos: [] }) },
    }, client)
    expect(result).toMatchObject({ outcome: 'completed', evidenceCount: 0, scheduledCount: 0 })
    expect(psql(`select new_evidence_count from signal_run_clusters where signal_run_id='${RUN_EMPTY}';`).trim()).toBe('0')
    expect(psql(`select count(*) from signal_evidence where discovered_in_run_id='${RUN_EMPTY}';`).trim()).toBe('0')
  })

  it('preserves ambiguous quota, then retries with a distinct reservation and completes', async () => {
    seedRun(RUN_UNKNOWN, 'unknown')
    const batch = await prepare(RUN_UNKNOWN)
    const { client, rpcCalls } = isolatedWorkerClient()
    const { processDiscoveryBatch } = await import('@/lib/emerging-signal/discovery-worker')
    const unknown = await processDiscoveryBatch({
      batchId: batch.id, runId: RUN_UNKNOWN, leaseOwner: 'discovery-unknown',
      provider: { search: async () => ({ outcome: 'outcome_unknown', errorClass: 'timeout' }) },
    }, client)
    expect(unknown).toMatchObject({ outcome: 'outcome_unknown', errorClass: 'timeout' })
    const recovered = await processDiscoveryBatch({
      batchId: batch.id, runId: RUN_UNKNOWN, leaseOwner: 'discovery-retry',
      provider: { search: async () => ({ outcome: 'success', videos: videos('unknown') }) },
    }, client)
    expect(recovered.outcome).toBe('completed')
    const reservations = rpcCalls.filter(call => call.name === 'reserve_provider_units')
    expect(reservations).toHaveLength(2)
    expect(new Set(reservations.map(call => call.args.p_idempotency_key)).size).toBe(2)
    expect(rpcCalls.filter(call => call.name === 'mark_provider_outcome_unknown')).toHaveLength(1)
    expect(rpcCalls.filter(call => call.name === 'commit_provider_units')).toHaveLength(1)
  })

  it('settles a malformed resolved response and moves the batch to a controlled retry', async () => {
    seedRun(RUN_INVALID, 'invalid')
    const batch = await prepare(RUN_INVALID)
    const { client, rpcCalls } = isolatedWorkerClient()
    const { processDiscoveryBatch } = await import('@/lib/emerging-signal/discovery-worker')
    const result = await processDiscoveryBatch({
      batchId: batch.id, runId: RUN_INVALID, leaseOwner: 'discovery-invalid',
      provider: { search: async () => null as never },
    }, client)
    expect(result).toMatchObject({ outcome: 'retryable', errorClass: 'invalid_provider_response' })
    expect(psql(`select status from signal_collection_batches where id='${batch.id}';`).trim()).toBe('retryable')
    expect(rpcCalls.filter(call => call.name === 'commit_provider_units')).toHaveLength(1)
    expect(rpcCalls.filter(call => call.name === 'mark_provider_outcome_unknown')).toHaveLength(0)
  })

  it('settles quota exhaustion once and terminally stops the batch without retrying the provider', async () => {
    seedRun(RUN_QUOTA, 'quota')
    const batch = await prepare(RUN_QUOTA)
    const { client, rpcCalls } = isolatedWorkerClient()
    const { processDiscoveryBatch } = await import('@/lib/emerging-signal/discovery-worker')
    let calls = 0
    const result = await processDiscoveryBatch({
      batchId: batch.id, runId: RUN_QUOTA, leaseOwner: 'discovery-quota',
      provider: { search: async () => { calls += 1; return { outcome: 'quota_exhausted' } } },
    }, client)
    expect(result.outcome).toBe('provider_quota_exhausted')
    expect(calls).toBe(1)
    expect(psql(`select status||':'||error_class from signal_collection_batches where id='${batch.id}';`).trim())
      .toBe('failed:provider_quota_exhausted')
    expect(rpcCalls.filter(call => call.name === 'commit_provider_units')).toHaveLength(1)
    expect(rpcCalls.filter(call => call.name === 'mark_provider_outcome_unknown')).toHaveLength(0)
  })

  it('allows only one provider call when two workers race for one seed batch', async () => {
    seedRun(RUN_CONCURRENT, 'concurrent')
    const batch = await prepare(RUN_CONCURRENT)
    const { client, rpcCalls } = isolatedWorkerClient()
    const { processDiscoveryBatch } = await import('@/lib/emerging-signal/discovery-worker')
    let calls = 0
    const provider = { search: async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 30))
      return { outcome: 'success' as const, videos: videos('concurrent') }
    } }
    const [first, second] = await Promise.all([
      processDiscoveryBatch({ batchId: batch.id, runId: RUN_CONCURRENT, leaseOwner: 'discovery-race-a', provider }, client),
      processDiscoveryBatch({ batchId: batch.id, runId: RUN_CONCURRENT, leaseOwner: 'discovery-race-b', provider }, client),
    ])
    expect([first, second].filter(result => result.outcome === 'completed')).toHaveLength(1)
    expect([first, second].filter(result => result.outcome === 'not_claimed')).toHaveLength(1)
    expect(calls).toBe(1)
    expect(rpcCalls.filter(call => call.name === 'reserve_provider_units')).toHaveLength(1)
  })
})
