// Real local Supabase proof for PFM-3B3. The provider is fully mocked: no
// YouTube, Serper, Claude or other external request can occur in this file.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'

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

const RUN_SUCCESS = '41000000-0000-4000-8000-000000000001'
const RUN_UNKNOWN = '41000000-0000-4000-8000-000000000002'
const RUN_CONCURRENT = '41000000-0000-4000-8000-000000000003'

function cleanFixtures() {
  psql(`
    delete from signal_observations where signal_run_id in ('${RUN_SUCCESS}','${RUN_UNKNOWN}','${RUN_CONCURRENT}');
    delete from signal_observation_schedule where signal_evidence_id in (
      select id from signal_evidence where external_ref like 'pfm3b3_%'
    );
    delete from signal_provider_budget_reservations where run_id in ('${RUN_SUCCESS}','${RUN_UNKNOWN}','${RUN_CONCURRENT}');
    delete from signal_collection_batches where run_phase_id in (
      select id from signal_run_phases where run_id in ('${RUN_SUCCESS}','${RUN_UNKNOWN}','${RUN_CONCURRENT}')
    );
    delete from signal_run_provider_usage where run_id in ('${RUN_SUCCESS}','${RUN_UNKNOWN}','${RUN_CONCURRENT}');
    delete from signal_run_phases where run_id in ('${RUN_SUCCESS}','${RUN_UNKNOWN}','${RUN_CONCURRENT}');
    delete from signal_evidence where discovered_in_run_id in ('${RUN_SUCCESS}','${RUN_UNKNOWN}','${RUN_CONCURRENT}');
    delete from signal_sources where external_id like 'pfm3b3_%';
    delete from youtube_videos where video_id like 'pfm3b3_%';
    delete from signal_runs where id in ('${RUN_SUCCESS}','${RUN_UNKNOWN}','${RUN_CONCURRENT}');
    delete from signal_provider_daily_budgets where not exists (
      select 1 from signal_provider_budget_reservations r where r.daily_budget_id=signal_provider_daily_budgets.id
    );
  `)
}

function seedRun(runId: string, includeMissing: boolean) {
  const missingSql = includeMissing ? `
    insert into youtube_videos(video_id,title) values ('pfm3b3_missing','Missing video');
    insert into signal_sources(id,source_type,external_id,source_family_key) values
      ('42000000-0000-4000-8000-000000000003','youtube_channel','pfm3b3_channel_c','pfm3b3_channel_c');
    insert into signal_evidence(id,signal_source_id,evidence_type,external_ref,youtube_videos_ref,title,discovered_in_run_id) values
      ('43000000-0000-4000-8000-000000000003','42000000-0000-4000-8000-000000000003','youtube_video','pfm3b3_missing','pfm3b3_missing','Missing video','${runId}');
    insert into signal_observation_schedule(id,signal_evidence_id,cadence,next_due_at) values
      ('44000000-0000-4000-8000-000000000003','43000000-0000-4000-8000-000000000003','weekly',clock_timestamp()-interval '1 day');
  ` : ''
  psql(`
    insert into signal_runs(id,run_type,idempotency_key,status)
      values ('${runId}','scheduled_enrichment','pfm3b3:${runId}','started');
    insert into youtube_videos(video_id,title) values ('pfm3b3_shared','Shared video');
    insert into signal_sources(id,source_type,external_id,source_family_key) values
      ('42000000-0000-4000-8000-000000000001','youtube_channel','pfm3b3_channel_a','pfm3b3_channel_a'),
      ('42000000-0000-4000-8000-000000000002','youtube_channel','pfm3b3_channel_b','pfm3b3_channel_b');
    insert into signal_evidence(id,signal_source_id,evidence_type,external_ref,youtube_videos_ref,title,discovered_in_run_id) values
      ('43000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000001','youtube_video','pfm3b3_shared','pfm3b3_shared','Shared A','${runId}'),
      ('43000000-0000-4000-8000-000000000002','42000000-0000-4000-8000-000000000002','youtube_video','pfm3b3_shared','pfm3b3_shared','Shared B','${runId}');
    insert into signal_observation_schedule(id,signal_evidence_id,cadence,next_due_at) values
      ('44000000-0000-4000-8000-000000000001','43000000-0000-4000-8000-000000000001','daily',clock_timestamp()-interval '1 day'),
      ('44000000-0000-4000-8000-000000000002','43000000-0000-4000-8000-000000000002','early8h',clock_timestamp()-interval '1 day');
    ${missingSql}
  `)
}

async function prepare(runId: string) {
  const phasesModule = await import('@/lib/emerging-signal/run-phases')
  const scheduleModule = await import('@/lib/emerging-signal/observation-schedule')
  const phases = await phasesModule.ensureRunPhases(runId)
  if (phases.outcome !== 'success') throw new Error(JSON.stringify(phases))
  const observation = phases.phases.find(row => row.phase === 'observation')!
  const claimed = await phasesModule.claimRunPhase({ phaseId: observation.id, leaseOwner: `phase-${runId}`, leaseSeconds: 200 })
  if (claimed.outcome !== 'claimed') throw new Error(JSON.stringify(claimed))
  const prepared = await scheduleModule.prepareObservationBatches({ runPhaseId: observation.id })
  if (prepared.outcome !== 'success') throw new Error(JSON.stringify(prepared))
  return prepared
}

describeIfLocalDb.sequential('PFM-3B3 observation worker — real local DB, mocked provider', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
  })
  beforeEach(() => cleanFixtures())
  afterAll(() => cleanFixtures())

  it('deduplicates provider IDs, persists every evidence observation, and handles a partial miss', async () => {
    seedRun(RUN_SUCCESS, true)
    const prepared = await prepare(RUN_SUCCESS)
    expect(prepared.batches).toHaveLength(1)
    expect(prepared.batches[0].item_ids).toEqual(['pfm3b3_missing', 'pfm3b3_shared'])
    const calls: string[][] = []
    const { processObservationBatch } = await import('@/lib/emerging-signal/observation-worker')
    const result = await processObservationBatch({
      batchId: prepared.batches[0].id,
      runId: RUN_SUCCESS,
      leaseOwner: 'observation-worker-success',
      provider: { fetchVideoStats: async ids => {
        calls.push([...ids])
        return { outcome: 'success', videos: [
          { videoId: 'pfm3b3_shared', viewCount: 1000, likeCount: 80, commentCount: 12 },
        ] }
      } },
    })
    expect(result).toMatchObject({ outcome: 'completed', observedVideoCount: 1, missingVideoCount: 1, observationCount: 6 })
    expect(calls).toEqual([['pfm3b3_missing', 'pfm3b3_shared']])
    expect(psql(`select count(*) from signal_observations where signal_run_id='${RUN_SUCCESS}';`).trim()).toBe('6')
    expect(psql(`select count(*) from signal_observations where signal_evidence_id in
      ('43000000-0000-4000-8000-000000000001','43000000-0000-4000-8000-000000000002');`).trim()).toBe('6')
    expect(psql(`select consecutive_miss_checks from signal_observation_schedule where id='44000000-0000-4000-8000-000000000003';`).trim()).toBe('1')
    expect(psql(`select count(*) from signal_provider_budget_reservations where run_id='${RUN_SUCCESS}' and status='committed' and batch_id is not null;`).trim()).toBe('1')
  })

  it('marks an ambiguous timeout unknown, then retries with a new reservation and completes', async () => {
    seedRun(RUN_UNKNOWN, false)
    const prepared = await prepare(RUN_UNKNOWN)
    const batchId = prepared.batches[0].id
    const { processObservationBatch } = await import('@/lib/emerging-signal/observation-worker')
    const unknown = await processObservationBatch({
      batchId, runId: RUN_UNKNOWN, leaseOwner: 'observation-worker-unknown',
      provider: { fetchVideoStats: async () => ({ outcome: 'outcome_unknown', errorClass: 'timeout' }) },
    })
    expect(unknown).toMatchObject({ outcome: 'outcome_unknown', errorClass: 'timeout' })
    expect(psql(`select status from signal_collection_batches where id='${batchId}';`).trim()).toBe('outcome_unknown')
    expect(psql(`select status from signal_provider_budget_reservations where run_id='${RUN_UNKNOWN}';`).trim()).toBe('committed_unknown')

    const recovered = await processObservationBatch({
      batchId, runId: RUN_UNKNOWN, leaseOwner: 'observation-worker-retry',
      provider: { fetchVideoStats: async () => ({ outcome: 'success', videos: [
        { videoId: 'pfm3b3_shared', viewCount: 2000, likeCount: 100, commentCount: 20 },
      ] }) },
    })
    expect(recovered.outcome).toBe('completed')
    expect(psql(`select attempt from signal_collection_batches where id='${batchId}';`).trim()).toBe('2')
    expect(psql(`select string_agg(status,',' order by created_at) from signal_provider_budget_reservations where run_id='${RUN_UNKNOWN}';`).trim())
      .toBe('committed_unknown,committed')
    expect(psql(`select count(distinct idempotency_key) from signal_provider_budget_reservations where run_id='${RUN_UNKNOWN}';`).trim()).toBe('2')
  })

  it('allows only one provider attempt when two workers race for the same batch', async () => {
    seedRun(RUN_CONCURRENT, false)
    const prepared = await prepare(RUN_CONCURRENT)
    const batchId = prepared.batches[0].id
    const { processObservationBatch } = await import('@/lib/emerging-signal/observation-worker')
    let providerCalls = 0
    const provider = { fetchVideoStats: async () => {
      providerCalls += 1
      await new Promise(resolve => setTimeout(resolve, 30))
      return { outcome: 'success' as const, videos: [
        { videoId: 'pfm3b3_shared', viewCount: 3000, likeCount: 150, commentCount: 30 },
      ] }
    } }
    const [first, second] = await Promise.all([
      processObservationBatch({ batchId, runId: RUN_CONCURRENT, leaseOwner: 'race-worker-a', provider }),
      processObservationBatch({ batchId, runId: RUN_CONCURRENT, leaseOwner: 'race-worker-b', provider }),
    ])
    expect([first, second].filter(result => result.outcome === 'completed')).toHaveLength(1)
    expect([first, second].filter(result => result.outcome === 'not_claimed')).toHaveLength(1)
    expect(providerCalls).toBe(1)
    expect(psql(`select count(*) from signal_provider_budget_reservations where run_id='${RUN_CONCURRENT}';`).trim()).toBe('1')
  })
})
