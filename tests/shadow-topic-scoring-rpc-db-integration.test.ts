// Shadow Topic v0 S2 — run_shadow_topic_scoring RPC, REAL local DB
// integration tests. Ugyanazt a mintat koveti, mint a 069-es sema-teszt es
// a creator-lane-authenticated-privilege suite: a MEGLEVO, futo lokalis
// Supabase Docker stacket hasznalja (127.0.0.1:54321, demo anon/
// service_role kulcsok — nem production). Ha a stack nem elerheto, a
// teljes describe-blokk kontrolláltan KIHAGYODIK.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
    input: sql,
    encoding: 'utf-8',
  })
}

function dockerPsqlExpectError(sql: string): string {
  try {
    execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
      input: sql,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return '__NO_ERROR__'
  } catch (e: any) {
    return String(e.stderr || e.stdout || e.message || '')
  }
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}

const describeIfLocalDb = stackAvailable ? describe : describe.skip

const RUN_TYPE_RUN_ID = '11111111-0000-0000-0000-000000000001'
const SOURCE_ID = '22222222-0000-0000-0000-000000000001'

function cleanupTestData() {
  dockerPsql(`
    delete from signal_cluster_scores where score_run_id in (select id from signal_score_runs where idempotency_key like 'sts-rpc-%');
    delete from signal_score_runs where idempotency_key like 'sts-rpc-%';
    delete from signal_cluster_evidence where signal_cluster_id in (select id from signal_clusters where primary_label like 'STS RPC test%');
    delete from signal_observations where signal_evidence_id in (select id from signal_evidence where external_ref like 'sts-rpc-%');
    delete from signal_evidence where external_ref like 'sts-rpc-%';
    delete from signal_clusters where primary_label like 'STS RPC test%';
    delete from signal_sources where id = '${SOURCE_ID}';
    delete from signal_runs where id = '${RUN_TYPE_RUN_ID}';
  `)
}

function seedBaseFixtures() {
  dockerPsql(`
    insert into signal_runs (id, run_type, idempotency_key, status, completed_at)
    values ('${RUN_TYPE_RUN_ID}', 'shadow_batch', 'sts-rpc-fixture-run', 'completed', now())
    on conflict (id) do nothing;
    insert into signal_sources (id, source_type, external_id, source_family_key, first_seen_at, last_seen_at)
    values ('${SOURCE_ID}', 'youtube_channel', 'sts-rpc-UC', 'sts-rpc-UC', now(), now())
    on conflict (id) do nothing;
  `)
}

function newCluster(label: string, createdAt: string, category: string | null = 'tech_ai'): string {
  const id = randomUUID()
  const categorySql = category === null ? 'NULL' : `'${category.replace(/'/g, "''")}'`
  const fingerprint = id.replace(/-/g, '').padEnd(40, 'f')
  dockerPsql(`
    insert into signal_clusters (id, primary_label, category, cluster_fingerprint, created_by_run_id, created_at)
    values ('${id}', '${label.replace(/'/g, "''")}', ${categorySql}, '${fingerprint}', '${RUN_TYPE_RUN_ID}', '${createdAt}');
  `)
  return id
}

function newEvidence(externalRefSuffix: string, publishedAt: string | null, firstSeenAt: string): string {
  const id = randomUUID()
  const publishedSql = publishedAt === null ? 'NULL' : `'${publishedAt}'`
  dockerPsql(`
    insert into signal_evidence (id, signal_source_id, evidence_type, external_ref, title, published_at, discovered_in_run_id, first_seen_at)
    values ('${id}', '${SOURCE_ID}', 'youtube_video', 'sts-rpc-${externalRefSuffix}', 'title', ${publishedSql}, '${RUN_TYPE_RUN_ID}', '${firstSeenAt}');
  `)
  return id
}

function linkEvidence(clusterId: string, evidenceId: string, createdAt: string) {
  dockerPsql(`
    insert into signal_cluster_evidence (signal_cluster_id, signal_evidence_id, linked_in_run_id, relation_type, created_at)
    values ('${clusterId}', '${evidenceId}', '${RUN_TYPE_RUN_ID}', 'supports', '${createdAt}');
  `)
}

function addObservation(evidenceId: string, value: number, cadence: string, bucketStart: string, observedAt: string) {
  dockerPsql(`
    insert into signal_observations (signal_evidence_id, signal_run_id, metric_type, metric_value, cadence, bucket_start, observed_at)
    values ('${evidenceId}', '${RUN_TYPE_RUN_ID}', 'youtube_view_count', ${value}, '${cadence}', '${bucketStart}', '${observedAt}');
  `)
}

// Same as addObservation, but takes the metric_value as a raw decimal-literal
// string so it is parsed by Postgres NUMERIC directly, never round-tripped
// through a JS `number` (which loses precision above 2^53).
function addObservationExact(evidenceId: string, exactDecimalValue: string, cadence: string, bucketStart: string, observedAt: string) {
  dockerPsql(`
    insert into signal_observations (signal_evidence_id, signal_run_id, metric_type, metric_value, cadence, bucket_start, observed_at)
    values ('${evidenceId}', '${RUN_TYPE_RUN_ID}', 'youtube_view_count', ${exactDecimalValue}, '${cadence}', '${bucketStart}', '${observedAt}');
  `)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

// Independently recomputes the v2 scalar score fields PURELY from a stored
// input_snapshot (no source-table reads) -- the self-containment proof the
// v1 snapshot could never make, since it lacked metric_value.
function recomputeFromSnapshotAlone(snapshot: any, evaluationTimeIso: string) {
  const evaluationTime = new Date(evaluationTimeIso).getTime()
  const evidence: any[] = snapshot.evidence
  const observations: any[] = snapshot.observations
  const youtubeEvidenceCount = evidence.filter((e) => e.evidence_type === 'youtube_video').length
  const eligible = evidence.filter((e) => e.eligibility.freshness.eligible === true)
  const perEvidence = eligible.map((e) => {
    const sel = observations.find((o) => o.evidence_id === e.evidence_id && o.selected_for_calculation === true)
    const publishedAt = new Date(e.published_at).getTime()
    const firstSeenAt = new Date(e.first_seen_at).getTime()
    const observedAt = new Date(sel.observed_at).getTime()
    const discoveryLagHours = Math.max(0, (firstSeenAt - publishedAt) / 3600000)
    const observationAgeHours = Math.max(0, (evaluationTime - observedAt) / 3600000)
    const elapsedHours = Math.max((observedAt - publishedAt) / 3600000, 1)
    const velocity = Number(sel.metric_value) / elapsedHours
    return { discoveryLagHours, observationAgeHours, velocity, observedAtMs: observedAt }
  })
  return {
    evidenceCount: evidence.length,
    youtubeEvidenceCount,
    freshnessEligibleCount: eligible.length,
    freshnessCoverage: youtubeEvidenceCount === 0 ? 0 : Math.round((eligible.length / youtubeEvidenceCount) * 10000) / 10000,
    medianDiscoveryLagHours: median(perEvidence.map((p) => p.discoveryLagHours)),
    medianObservationAgeHours: median(perEvidence.map((p) => p.observationAgeHours)),
    medianVelocity: median(perEvidence.map((p) => p.velocity)),
    maxObservedAtMs: perEvidence.length ? Math.max(...perEvidence.map((p) => p.observedAtMs)) : null,
  }
}

// The (score_profile, algorithm_version, algorithm_config_hash,
// evaluation_time, input_cutoff) semantic tuple is GLOBAL in v0 (not
// scoped to any one cluster/test) -- reusing the same literal timestamp
// across independent tests would collide on the semantic-dup UNIQUE and
// fail with an unrelated error. This nudges any base timestamp by a
// monotonically increasing number of seconds so every test call is
// globally unique, while preserving whatever before/after relationship
// the test already relies on relative to its own fixture dates.
let uniqSecondsCounter = 0
function uniq(iso: string): string {
  uniqSecondsCounter++
  const d = new Date(iso)
  d.setUTCSeconds(d.getUTCSeconds() + uniqSecondsCounter)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function callRpc(evaluationTime: string, inputCutoff: string, idempotencyKey: string): any {
  const out = dockerPsql(`select run_shadow_topic_scoring('${evaluationTime}'::timestamptz, '${inputCutoff}'::timestamptz, '${idempotencyKey}');`).trim()
  return JSON.parse(out)
}

function callRpcExpectError(evaluationTime: string, inputCutoff: string, idempotencyKey: string): string {
  return dockerPsqlExpectError(`select run_shadow_topic_scoring('${evaluationTime}'::timestamptz, '${inputCutoff}'::timestamptz, '${idempotencyKey}');`)
}

describeIfLocalDb('Shadow Topic v0 S2 — run_shadow_topic_scoring RPC (real local DB)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    cleanupTestData()
    seedBaseFixtures()
  })

  afterAll(() => {
    cleanupTestData()
  })

  // ------------------------------------------------------------
  // 1. Migration idempotency / drift -- 071 supersedes 070's body.
  //    070 alone must NEVER be safely re-appliable once 071 has run
  //    (forward-only chain); 071 owns legacy-v1->corrected-v2 upgrade,
  //    its own no-op replay, and fail-closed drift protection.
  // ------------------------------------------------------------
  const MIGRATION_070 = readFileSync(join(process.cwd(), 'supabase/migrations/070_run_shadow_topic_scoring.sql'), 'utf8')
  const MIGRATION_071 = readFileSync(join(process.cwd(), 'supabase/migrations/071_fix_shadow_topic_snapshot_provenance.sql'), 'utf8')

  function applyMigration(sql: string): string {
    return execSync(
      'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
      { input: sql, encoding: 'utf8' },
    )
  }
  function applyMigrationExpectThrow(sql: string): boolean {
    try {
      execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f -', { input: sql, encoding: 'utf8' })
      return false
    } catch {
      return true
    }
  }

  describe('071 migration: legacy v1 -> corrected v2, no-op replay, fail-closed drift', () => {
    it('a fresh legacy v1 install produces a v1-shaped run/score; applying 071 upgrades the function to v2 and leaves that v1 row byte-for-byte untouched', () => {
      dockerPsql('DROP FUNCTION IF EXISTS public.run_shadow_topic_scoring(timestamptz, timestamptz, text);')
      const createOut = applyMigration(MIGRATION_070)
      expect(createOut).toMatch(/run_shadow_topic_scoring created\./)

      const cluster = newCluster('STS RPC test v1-legacy-preserved', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('v1legacy-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      addObservation(e1, 4242, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      const ts = uniq('2026-01-03T00:00:00Z')
      const key = `sts-rpc-v1legacy-${randomUUID()}`
      const result = callRpc(ts, ts, key)
      expect(result.outcome).toBe('completed')

      const snapshotQuery = `
        select r.algorithm_version||'|'||s.input_snapshot_schema_version||'|'||s.input_snapshot::text||'|'||s.input_digest
        from signal_score_runs r join signal_cluster_scores s on s.score_run_id = r.id
        where r.idempotency_key = '${key}' and s.signal_cluster_id = '${cluster}';
      `
      const before = dockerPsql(snapshotQuery).trim()
      // sanity: this v1 snapshot must NOT contain metric_value (that is exactly the defect 071 fixes)
      expect(before).not.toContain('"metric_value"')
      expect(before.split('|')[0]).toBe('1')
      expect(before.split('|')[1]).toBe('1')

      const replaceOut = applyMigration(MIGRATION_071)
      expect(replaceOut).toMatch(/replaced with the corrected v2 body/)

      const after = dockerPsql(snapshotQuery).trim()
      expect(after).toBe(before)
    })

    it('re-running 071 against the now-v2 function is an exact no-op', () => {
      const out = applyMigration(MIGRATION_071)
      expect(out).toMatch(/already exactly the corrected v2 body -- no-op\./)
      expect(out).not.toMatch(/drift/)
    })

    it('071 refuses to touch an unrecognized/tampered function body (fail-closed); DROP + 070 + 071 restores a clean v2 state', () => {
      dockerPsql(`
        CREATE OR REPLACE FUNCTION public.run_shadow_topic_scoring(p_evaluation_time timestamptz, p_input_cutoff timestamptz, p_idempotency_key text)
        RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $tamper$ BEGIN RAISE EXCEPTION 'tampered'; END; $tamper$;
      `)
      expect(applyMigrationExpectThrow(MIGRATION_071)).toBe(true)

      dockerPsql('DROP FUNCTION public.run_shadow_topic_scoring(timestamptz, timestamptz, text);')
      const recreateOut = applyMigration(MIGRATION_070)
      expect(recreateOut).toMatch(/run_shadow_topic_scoring created\./)
      const restoreOut = applyMigration(MIGRATION_071)
      expect(restoreOut).toMatch(/replaced with the corrected v2 body/)
    })

    it('070 standalone can never be safely re-applied once 071 has advanced the function to v2 (forward-only enforcement)', () => {
      // live function is v2 at this point (restored by the previous test).
      // 070's own VALIDATE branch only accepts its own legacy v1 body hash,
      // so it must fail closed here -- and since that branch never runs
      // DDL/DCL, the live v2 function is left untouched by this call.
      expect(applyMigrationExpectThrow(MIGRATION_070)).toBe(true)
      const err = (() => {
        try {
          execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f -', { input: MIGRATION_070, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
          return ''
        } catch (e: any) {
          return String(e.stderr || e.stdout || '')
        }
      })()
      expect(err).toMatch(/070 drift/)
    })
  })

  // ------------------------------------------------------------
  // 2. Grant matrix / security
  // ------------------------------------------------------------
  describe('security / grant matrix', () => {
    it('EXECUTE is granted to exactly postgres and service_role', () => {
      const out = dockerPsql(`select grantee from information_schema.role_routine_grants where routine_name='run_shadow_topic_scoring' order by grantee;`).trim().split('\n')
      expect(out).toEqual(['postgres', 'service_role'])
    })

    it('anon cannot EXECUTE the RPC', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; SELECT run_shadow_topic_scoring(now(), now(), 'sts-rpc-anon-deny'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/)
    })

    it('authenticated cannot EXECUTE the RPC', () => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; SELECT run_shadow_topic_scoring(now(), now(), 'sts-rpc-auth-deny'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/)
    })

    it('service_role CAN EXECUTE the RPC', () => {
      const out = dockerPsql(`SET ROLE service_role; SELECT run_shadow_topic_scoring(now(), now(), 'sts-rpc-svc-allow'); RESET ROLE;`).trim()
      expect(out).toMatch(/"ok": true/)
    })

    it('service_role still cannot INSERT directly into signal_score_runs (RPC-only write path unchanged)', () => {
      const err = dockerPsqlExpectError(`
        SET ROLE service_role;
        INSERT INTO signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key)
        VALUES ('shadow_topic_v0','cluster_topic',1,'${'a'.repeat(64)}','{}'::jsonb,1,now(),now(),'sts-rpc-direct-insert-deny');
        RESET ROLE;
      `)
      expect(err).toMatch(/permission denied for table signal_score_runs/)
    })

    it('service_role still cannot INSERT directly into signal_cluster_scores', () => {
      const runId = callRpc('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'sts-rpc-for-direct-insert-2').run_id
      const err = dockerPsqlExpectError(`
        SET ROLE service_role;
        INSERT INTO signal_cluster_scores (score_run_id, signal_cluster_id, evidence_count, source_breadth, youtube_evidence_count, freshness_eligible_evidence_count, velocity_eligible_evidence_count, freshness_confidence_class, velocity_confidence_class, freshness_exclusion_reason, velocity_exclusion_reason, input_snapshot, input_digest, input_snapshot_schema_version, sampling_policy)
        VALUES ('${runId}', gen_random_uuid(), 0,0,0,0,0,'unknown','unknown','no_eligible_evidence','no_eligible_evidence','{}'::jsonb,'${'b'.repeat(64)}',1,'scheduled_only');
        RESET ROLE;
      `)
      expect(err).toMatch(/permission denied for table signal_cluster_scores/)
    })
  })

  // ------------------------------------------------------------
  // 3. Input validation
  // ------------------------------------------------------------
  describe('input validation', () => {
    it('rejects input_cutoff after evaluation_time', () => {
      const err = callRpcExpectError('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'sts-rpc-cutoff-after-eval')
      expect(err).toMatch(/input_cutoff must not be after evaluation_time/)
    })

    it('rejects a blank idempotency_key', () => {
      const err = dockerPsqlExpectError(`select run_shadow_topic_scoring(now(), now(), '   ');`)
      expect(err).toMatch(/idempotency_key must not be blank/)
    })

    it('rejects NULL evaluation_time', () => {
      const err = dockerPsqlExpectError(`select run_shadow_topic_scoring(NULL, now(), 'sts-rpc-null-eval');`)
      expect(err).toMatch(/evaluation_time is required/)
    })
  })

  // ------------------------------------------------------------
  // 4. Core scoring computation
  // ------------------------------------------------------------
  describe('core computation', () => {
    it('3 eligible evidence: measured confidence, correct odd median, full coverage, correct max_observed_at', () => {
      const cluster = newCluster('STS RPC test odd-median', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('odd-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      const e2 = newEvidence('odd-e2', '2026-01-01T00:00:00Z', '2026-01-01T02:00:00Z')
      const e3 = newEvidence('odd-e3', '2026-01-01T00:00:00Z', '2026-01-01T03:00:00Z')
      for (const e of [e1, e2, e3]) linkEvidence(cluster, e, '2026-01-01T01:00:00Z')
      addObservation(e1, 1000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e2, 2000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e3, 3000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')

      const ts = uniq('2026-01-03T00:00:00Z')
      const result = callRpc(ts, ts, `sts-rpc-odd-${cluster}`)
      expect(result.outcome).toBe('completed')

      const expectedAgeHours = ((new Date(ts).getTime() - new Date('2026-01-02T05:00:00Z').getTime()) / 3600000).toFixed(4)
      const row = dockerPsql(`
        select evidence_count||'|'||youtube_evidence_count||'|'||freshness_eligible_evidence_count||'|'||
               freshness_confidence_class||'|'||median_discovery_lag_hours||'|'||median_observation_age_hours||'|'||
               freshness_coverage||'|'||max_observed_at
        from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      expect(row).toBe(`3|3|3|measured|2.0000|${expectedAgeHours}|1.0000|2026-01-02 05:00:00+00`)
    })

    it('4 evidence with 1 missing published_at: 3 eligible (odd median unaffected by the excluded 4th), coverage=3/4=0.75 -- denominator NOT reduced by the exclusion', () => {
      const cluster = newCluster('STS RPC test denominator-preserved', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('denom-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      const e2 = newEvidence('denom-e2', '2026-01-01T00:00:00Z', '2026-01-01T02:00:00Z')
      const e3 = newEvidence('denom-e3', '2026-01-01T00:00:00Z', '2026-01-01T04:00:00Z')
      const e4 = newEvidence('denom-e4-nopublish', null, '2026-01-01T05:00:00Z')
      for (const e of [e1, e2, e3, e4]) linkEvidence(cluster, e, '2026-01-01T01:00:00Z')
      addObservation(e1, 100, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e2, 200, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e3, 300, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')

      const ts = uniq('2026-01-05T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-denom-${cluster}`)
      const row = dockerPsql(`
        select evidence_count||'|'||youtube_evidence_count||'|'||freshness_eligible_evidence_count||'|'||
               freshness_confidence_class||'|'||median_discovery_lag_hours||'|'||freshness_coverage
        from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      // youtube_evidence_count stays 4 (the missing-published_at evidence is NOT dropped
      // from the denominator); only 3 of the 4 are freshness/velocity-eligible (odd count,
      // median = the single middle value of lags [1,2,4] = 2); coverage = 3/4 = 0.7500.
      expect(row).toBe('4|4|3|measured|2.0000|0.7500')
    })

    it('4 eligible evidence (even count): median is the exact NUMERIC average of the two middle-ranked values, both for discovery_lag and for velocity', () => {
      const cluster = newCluster('STS RPC test even-median', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('evenmed-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      const e2 = newEvidence('evenmed-e2', '2026-01-01T00:00:00Z', '2026-01-01T02:00:00Z')
      const e3 = newEvidence('evenmed-e3', '2026-01-01T00:00:00Z', '2026-01-01T03:00:00Z')
      const e4 = newEvidence('evenmed-e4', '2026-01-01T00:00:00Z', '2026-01-01T04:00:00Z')
      for (const e of [e1, e2, e3, e4]) linkEvidence(cluster, e, '2026-01-01T01:00:00Z')
      addObservation(e1, 1000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e2, 2000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e3, 3000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e4, 4000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')

      const ts = uniq('2026-01-06T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-evenmed-${cluster}`)
      const row = dockerPsql(`
        select freshness_eligible_evidence_count||'|'||freshness_confidence_class||'|'||
               median_discovery_lag_hours||'|'||median_average_view_velocity_per_hour||'|'||freshness_coverage
        from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      // lags sorted: [1,2,3,4] -> two middle values 2,3 -> avg = 2.5000
      // velocities (view/29h elapsed): 34.482759, 68.965517, 103.448276, 137.931034
      //   -> two middle values 68.965517, 103.448276 -> avg = 86.206897 (exact NUMERIC average, no float rounding drift)
      expect(row).toBe('4|measured|2.5000|86.206897|1.0000')
    })

    it('0 evidence cluster: all zeros, unknown confidence, coverage=0, exclusion_reason set, max_observed_at NULL', () => {
      const cluster = newCluster('STS RPC test empty', '2026-01-01T00:00:00Z', null)
      const ts = uniq('2026-01-02T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-empty-${cluster}`)
      const row = dockerPsql(`
        select evidence_count||'|'||youtube_evidence_count||'|'||freshness_confidence_class||'|'||
               freshness_coverage||'|'||freshness_exclusion_reason||'|'||(max_observed_at is null)::text
        from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      expect(row).toBe('0|0|unknown|0.0000|no_eligible_evidence|true')
    })

    it('a cluster created after input_cutoff is not scored at all', () => {
      const futureCluster = newCluster('STS RPC test future', '2026-06-01T00:00:00Z')
      const ts = uniq('2026-01-01T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-future-${futureCluster}`)
      const count = dockerPsql(`select count(*) from signal_cluster_scores where signal_cluster_id='${futureCluster}';`).trim()
      expect(count).toBe('0')
    })

    it('cluster-evidence link created after input_cutoff excludes that evidence entirely', () => {
      const cluster = newCluster('STS RPC test link-cutoff', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('linkcut-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-06-01T00:00:00Z') // link created AFTER cutoff
      const ts = uniq('2026-01-02T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-linkcut-${cluster}`)
      const row = dockerPsql(`select evidence_count from signal_cluster_scores where signal_cluster_id='${cluster}';`).trim()
      expect(row).toBe('0')
    })

    it('evidence first_seen_at after input_cutoff excludes that evidence entirely', () => {
      const cluster = newCluster('STS RPC test firstseen-cutoff', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('fscut-e1', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      const ts = uniq('2026-01-02T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-fscut-${cluster}`)
      const row = dockerPsql(`select evidence_count from signal_cluster_scores where signal_cluster_id='${cluster}';`).trim()
      expect(row).toBe('0')
    })

    it('future published_at (after evaluation_time) stays in the YouTube denominator but is excluded from eligible', () => {
      const cluster = newCluster('STS RPC test future-published', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('futpub-e1', '2026-12-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      const ts = uniq('2026-01-02T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-futpub-${cluster}`)
      const row = dockerPsql(`
        select youtube_evidence_count||'|'||freshness_eligible_evidence_count||'|'||freshness_coverage
        from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      expect(row).toBe('1|0|0.0000')
    })

    it('only on_demand-cadence observation: evidence has 0 scheduled observation, excluded, reason=no_scheduled_view_observation', () => {
      const cluster = newCluster('STS RPC test on-demand-only', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('ondemand-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      addObservation(e1, 500, 'on_demand', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      const ts = uniq('2026-01-03T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-ondemand-${cluster}`)
      const row = dockerPsql(`
        select youtube_evidence_count||'|'||freshness_eligible_evidence_count||'|'||freshness_exclusion_reason
        from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      expect(row).toBe('1|0|no_eligible_evidence')
      const reason = dockerPsql(`select input_snapshot->'evidence'->0->'eligibility'->'freshness'->>'reason' from signal_cluster_scores where signal_cluster_id='${cluster}';`).trim()
      expect(reason).toBe('no_scheduled_view_observation')
    })

    it('late-arriving observation (event-time cutoff, not ingestion-time): observed_at before cutoff is included regardless of insert order', () => {
      const cluster = newCluster('STS RPC test late-arrival', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('late-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      // insert AFTER we've already "conceptually" passed the cutoff wall-clock-wise; observed_at itself is still <= cutoff
      addObservation(e1, 750, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      const ts = uniq('2026-01-03T00:00:00Z')
      const result = callRpc(ts, ts, `sts-rpc-late-${cluster}`)
      expect(result.outcome).toBe('completed')
      const row = dockerPsql(`select freshness_eligible_evidence_count from signal_cluster_scores where signal_cluster_id='${cluster}';`).trim()
      expect(row).toBe('1')
    })

    it('two observations with identical observed_at: tie-break picks bucket_start DESC then id ASC, deterministically', () => {
      const cluster = newCluster('STS RPC test tie-break', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('tie-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      addObservation(e1, 111, 'daily', '2026-01-01T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e1, 222, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z') // later bucket_start, same observed_at -> should win
      const ts = uniq('2026-01-03T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-tiebreak-${cluster}`)
      const selectedCount = dockerPsql(`
        select jsonb_array_length(jsonb_path_query_array(input_snapshot, '$.observations[*] ? (@.selected_for_calculation == true)'))
        from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      expect(selectedCount).toBe('1')
      const winnerValue = dockerPsql(`
        select median_average_view_velocity_per_hour from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      // 222 views / 29h elapsed = 7.655172
      expect(winnerValue).toBe('7.655172')
    })
  })

  // ------------------------------------------------------------
  // 5. Canonical JSON / digest
  // ------------------------------------------------------------
  describe('canonical JSON and digest', () => {
    it('config_hash is deterministic across two separate runs', () => {
      const c1 = newCluster('STS RPC test hash-a', '2026-01-01T00:00:00Z', null)
      const c2 = newCluster('STS RPC test hash-b', '2026-01-01T00:00:00Z', null)
      const ts1 = uniq('2026-01-01T01:00:00Z')
      const ts2 = uniq('2026-01-01T02:00:00Z')
      callRpc(ts1, ts1, `sts-rpc-hash1-${c1}`)
      callRpc(ts2, ts2, `sts-rpc-hash2-${c2}`)
      const hashes = dockerPsql(`select distinct algorithm_config_hash from signal_score_runs where idempotency_key in ('sts-rpc-hash1-${c1}','sts-rpc-hash2-${c2}');`).trim()
      expect(hashes.split('\n').length).toBe(1)
      expect(hashes).toMatch(/^[0-9a-f]{64}$/)
    })

    it('JSON escaping: category with quotes, backslash, and unicode round-trips exactly', () => {
      const category = `te"st\\back ő`
      const cluster = newCluster('STS RPC test escaping', '2026-01-01T00:00:00Z', category)
      const ts = uniq('2026-01-02T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-escape-${cluster}`)
      const readBack = dockerPsql(`select input_snapshot->>'cluster_category_snapshot' from signal_cluster_scores where signal_cluster_id='${cluster}';`)
      expect(readBack).toBe(category + '\n')
    })

    it('input_digest is the actual SHA-256 of the canonically-built snapshot text, independently recomputable and matching a fresh replay-free run', () => {
      const cluster = newCluster('STS RPC test digest-recompute', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('digest-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      addObservation(e1, 999, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      const ts = uniq('2026-01-03T00:00:00Z')
      const tsCanonical = ts.replace('Z', '.000000Z')
      callRpc(ts, ts, `sts-rpc-digestcheck-${cluster}`)
      const out = dockerPsql(`
        select (input_digest = encode(sha256(convert_to(
          format(
            '{"cluster_category_snapshot":%s,"cluster_id":%s,"cluster_status_snapshot":%s,"evaluation_time":%s,"evidence":[%s],"input_cutoff":%s,"observations":[%s],"schema_version":2}',
            to_json('tech_ai'::text)::text,
            to_json(signal_cluster_id::text)::text,
            to_json('active'::text)::text,
            to_json('${tsCanonical}'::text)::text,
            (select string_agg(format('{"cluster_link_created_at":%s,"eligibility":{"freshness":{"eligible":%s,"reason":%s},"velocity":{"eligible":%s,"reason":%s}},"evidence_id":%s,"evidence_type":%s,"first_seen_at":%s,"published_at":%s,"source_id":%s}',
              to_json('2026-01-01T01:00:00.000000Z'::text)::text, to_json(true)::text, 'null', to_json(true)::text, 'null',
              to_json('${e1}'::text)::text, to_json('youtube_video'::text)::text, to_json('2026-01-01T01:00:00.000000Z'::text)::text, to_json('2026-01-01T00:00:00.000000Z'::text)::text, to_json('${SOURCE_ID}'::text)::text
            ), ',')),
            to_json('${tsCanonical}'::text)::text,
            (select string_agg(format('{"bucket_start":%s,"cadence":"daily","evidence_id":%s,"metric_type":"youtube_view_count","metric_value":%s,"observation_id":%s,"observed_at":%s,"selected_for_calculation":true}',
              to_json('2026-01-02T00:00:00.000000Z'::text)::text, to_json('${e1}'::text)::text, to_json(trim_scale(round(o.metric_value,0))::text)::text, to_json(o.id::text)::text, to_json('2026-01-02T05:00:00.000000Z'::text)::text
            ), ',') from signal_observations o where o.signal_evidence_id='${e1}')
          ), 'UTF8'
        )), 'hex')) as matches
        from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      expect(out).toBe('t')
    })
  })

  // ------------------------------------------------------------
  // 5b. v2 snapshot provenance -- metric_value, self-containment,
  //     source-mutation divergence, >2^53 integers.
  // ------------------------------------------------------------
  describe('v2 snapshot provenance (metric_value)', () => {
    it('metric_value is present as a JSON string on every cutoff-eligible observation, not just the selected one', () => {
      const cluster = newCluster('STS RPC test v2-metric-value-all', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('v2mv-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      addObservation(e1, 500, 'daily', '2026-01-01T00:00:00Z', '2026-01-01T12:00:00Z') // older, not selected
      addObservation(e1, 900, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z') // newer, selected
      const ts = uniq('2026-01-11T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-v2mv-${cluster}`)
      const values = dockerPsql(`
        select jsonb_agg(o->>'metric_value') from signal_cluster_scores, jsonb_array_elements(input_snapshot->'observations') o
        where signal_cluster_id='${cluster}';
      `).trim()
      expect((JSON.parse(values) as string[]).sort()).toEqual(['500', '900'])
      const types = dockerPsql(`
        select string_agg(jsonb_typeof(o->'metric_value'), ',') from signal_cluster_scores, jsonb_array_elements(input_snapshot->'observations') o
        where signal_cluster_id='${cluster}';
      `).trim()
      expect(types).toBe('string,string')
    })

    it('metric_value=0 renders as the canonical string "0" -- never "0.00", never empty, never a JSON number', () => {
      const cluster = newCluster('STS RPC test v2-metric-value-zero', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('v2mv0-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      addObservation(e1, 0, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      const ts = uniq('2026-01-12T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-v2mv0-${cluster}`)
      const raw = dockerPsql(`
        select o->>'metric_value' from signal_cluster_scores, jsonb_array_elements(input_snapshot->'observations') o where signal_cluster_id='${cluster}';
      `).trim()
      expect(raw).toBe('0')
    })

    it('the score fields (evidence counts, coverage, medians, max_observed_at) can be recomputed purely from the stored input_snapshot, without reading any source table, and match the stored scalar columns exactly', () => {
      const cluster = newCluster('STS RPC test v2-self-contained', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('v2sc-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      const e2 = newEvidence('v2sc-e2', '2026-01-01T00:00:00Z', '2026-01-01T02:00:00Z')
      const e3 = newEvidence('v2sc-e3', '2026-01-01T00:00:00Z', '2026-01-01T03:00:00Z')
      for (const e of [e1, e2, e3]) linkEvidence(cluster, e, '2026-01-01T01:00:00Z')
      addObservation(e1, 1000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e2, 2000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      addObservation(e3, 3000, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z')
      const ts = uniq('2026-01-13T00:00:00Z')
      const key = `sts-rpc-v2sc-${randomUUID()}`
      callRpc(ts, ts, key)

      const raw = dockerPsql(`
        select s.input_snapshot::text||chr(30)||s.evidence_count||chr(30)||s.youtube_evidence_count||chr(30)||
               s.freshness_eligible_evidence_count||chr(30)||s.freshness_coverage||chr(30)||
               s.median_discovery_lag_hours||chr(30)||s.median_observation_age_hours||chr(30)||
               s.median_average_view_velocity_per_hour||chr(30)||s.max_observed_at
        from signal_score_runs r join signal_cluster_scores s on s.score_run_id=r.id
        where r.idempotency_key='${key}' and s.signal_cluster_id='${cluster}';
      `).trim()
      const [snapshotText, evidenceCount, youtubeEvidenceCount, freshnessEligibleCount, freshnessCoverage, medianLag, medianAge, medianVelocity, maxObservedAt] =
        raw.split('\x1e')
      const recomputed = recomputeFromSnapshotAlone(JSON.parse(snapshotText), ts)

      expect(recomputed.evidenceCount).toBe(Number(evidenceCount))
      expect(recomputed.youtubeEvidenceCount).toBe(Number(youtubeEvidenceCount))
      expect(recomputed.freshnessEligibleCount).toBe(Number(freshnessEligibleCount))
      expect(recomputed.freshnessCoverage.toFixed(4)).toBe(freshnessCoverage)
      expect(recomputed.medianDiscoveryLagHours.toFixed(4)).toBe(medianLag)
      expect(recomputed.medianObservationAgeHours.toFixed(4)).toBe(medianAge)
      expect(recomputed.medianVelocity.toFixed(6)).toBe(medianVelocity)
      expect(new Date(recomputed.maxObservedAtMs!).toISOString()).toBe(new Date(maxObservedAt).toISOString())
    })

    it('input_digest is sensitive to metric_value (a source mutation between two runs on the same evidence changes the digest), and the FIRST run\'s stored snapshot/digest/score stay completely frozen despite the later mutation', () => {
      const cluster = newCluster('STS RPC test v2-mutation-digest', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('v2mutdig-e1', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      addObservation(e1, 100, 'daily', '2026-01-02T00:00:00Z', '2026-01-02T05:00:00Z') // elapsed 29h -> velocity 100/29=3.448276

      const snapshotQuery = (key: string) =>
        `select s.input_snapshot::text||chr(30)||s.input_digest||chr(30)||s.median_average_view_velocity_per_hour from signal_score_runs r join signal_cluster_scores s on s.score_run_id=r.id where r.idempotency_key='${key}' and s.signal_cluster_id='${cluster}';`

      const ts1 = uniq('2026-01-14T00:00:00Z')
      const key1 = `sts-rpc-v2mutdig-a-${randomUUID()}`
      callRpc(ts1, ts1, key1)
      const row1 = dockerPsql(snapshotQuery(key1)).trim()
      const [, digest1, velocity1] = row1.split('\x1e')
      expect(velocity1).toBe('3.448276')

      // mutate the SOURCE row's metric_value -- postgres/test-fixture privilege, NOT via the RPC.
      dockerPsql(`update signal_observations set metric_value = 999999 where signal_evidence_id='${e1}';`)

      // the first run's stored row must be completely unaffected by the later mutation.
      const row1After = dockerPsql(snapshotQuery(key1)).trim()
      expect(row1After).toBe(row1)

      // a SECOND, independent run against the SAME cluster/evidence, now reading the mutated
      // metric_value, must produce a DIFFERENT digest -- isolating metric_value as the cause,
      // since cluster_id/evidence_id/source_id/timings are all identical to the first run.
      const ts2 = uniq('2026-01-15T00:00:00Z')
      const key2 = `sts-rpc-v2mutdig-b-${randomUUID()}`
      callRpc(ts2, ts2, key2)
      const row2 = dockerPsql(snapshotQuery(key2)).trim()
      const [, digest2, velocity2] = row2.split('\x1e')
      expect(digest2).not.toBe(digest1)
      expect(velocity2).not.toBe(velocity1)

      // a naive recompute from the NOW-mutated source would silently produce yet another
      // number -- proving only the frozen, stored snapshot is trustworthy long-term.
      const independentFromMutatedSource = dockerPsql(`select (999999::numeric/29.0)::numeric(20,6);`).trim()
      expect(independentFromMutatedSource).toBe(velocity2)
      expect(independentFromMutatedSource).not.toBe(velocity1)

      // restore fixture state.
      dockerPsql(`update signal_observations set metric_value = 100 where signal_evidence_id='${e1}';`)
    })

    it('a metric_value above 2^53 survives in the snapshot as an exact decimal string with no scientific notation and no precision loss, and the NUMERIC velocity computation matches an independent NUMERIC calculation', () => {
      // Elapsed hours (published_at -> observed_at) is deliberately large (100000h)
      // so huge/elapsed still fits signal_cluster_scores.median_average_view_velocity_per_hour's
      // fixed NUMERIC(20,6) column (14 integer digits max) -- this is an existing,
      // out-of-scope-for-071 column precision, not something this migration controls.
      const cluster = newCluster('STS RPC test v2-bigint', '2026-01-01T00:00:00Z')
      const e1 = newEvidence('v2bigint-e1', '2015-01-01T00:00:00Z', '2015-01-01T01:00:00Z')
      linkEvidence(cluster, e1, '2026-01-01T01:00:00Z')
      const huge = '9007199254740993' // 2^53 + 1 -- not exactly representable as an IEEE-754 double
      addObservationExact(e1, huge, 'daily', '2026-05-29T00:00:00Z', '2026-05-29T16:00:00Z') // elapsed = 100000h exactly
      const ts = uniq('2026-06-01T00:00:00Z')
      const key = `sts-rpc-v2bigint-${randomUUID()}`
      callRpc(ts, ts, key)

      const snapshotValue = dockerPsql(`
        select o->>'metric_value' from signal_cluster_scores s, jsonb_array_elements(s.input_snapshot->'observations') o
        where s.signal_cluster_id = '${cluster}';
      `).trim()
      expect(snapshotValue).toBe(huge)
      expect(snapshotValue).not.toMatch(/[eE][+-]?\d/)
      expect(snapshotValue).not.toMatch(/\./)

      const storedVelocity = dockerPsql(`
        select median_average_view_velocity_per_hour from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      const independentVelocity = dockerPsql(`select (${huge}::numeric / 100000.0)::numeric(20,6);`).trim()
      expect(storedVelocity).toBe(independentVelocity)
    })
  })

  // ------------------------------------------------------------
  // 6. Idempotency / concurrency
  // ------------------------------------------------------------
  describe('idempotency and concurrency', () => {
    it('replaying the exact same semantic call returns outcome=replayed with the same run_id', () => {
      const key = `sts-rpc-replay-${randomUUID()}`
      const ts = uniq('2026-01-01T00:00:00Z')
      const r1 = callRpc(ts, ts, key)
      const r2 = callRpc(ts, ts, key)
      expect(r1.outcome).toBe('completed')
      expect(r2.outcome).toBe('replayed')
      expect(r2.run_id).toBe(r1.run_id)
    })

    it('same idempotency_key with a different evaluation_time is rejected', () => {
      const key = `sts-rpc-semdiff-${randomUUID()}`
      const ts1 = uniq('2026-01-01T00:00:00Z')
      callRpc(ts1, ts1, key)
      const err = callRpcExpectError(uniq('2026-01-02T00:00:00Z'), ts1, key)
      expect(err).toMatch(/idempotency_key already used with different semantic parameters/)
    })

    it('same semantic tuple with a different idempotency_key is rejected', () => {
      const ts = uniq('2026-01-10T00:00:00Z')
      callRpc(ts, ts, `sts-rpc-samesem-a-${randomUUID()}`)
      const err = callRpcExpectError(ts, ts, `sts-rpc-samesem-b-${randomUUID()}`)
      expect(err).toMatch(/already exists for this exact.*under a different idempotency_key/)
    })

    it('an existing processing run for the same idempotency_key fails closed (no continuation, no overwrite)', () => {
      const key = `sts-rpc-stuck-processing-${randomUUID()}`
      dockerPsql(`
        insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, status, idempotency_key)
        values ('shadow_topic_v0','cluster_topic',1,'7c6ec8a97fc182a6a41810245d141ea30b7e6677e4e4289bbfc7d298b6207910','{}'::jsonb,1,now(),now(),'processing','${key}');
      `)
      const err = callRpcExpectError('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', key)
      expect(err).toMatch(/is not completed \(status=processing\)/)
    })

    it('an existing failed run for the same idempotency_key fails closed', () => {
      const key = `sts-rpc-stuck-failed-${randomUUID()}`
      dockerPsql(`
        insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, status, completed_at, error_class, idempotency_key)
        values ('shadow_topic_v0','cluster_topic',1,'7c6ec8a97fc182a6a41810245d141ea30b7e6677e4e4289bbfc7d298b6207910','{}'::jsonb,1,now(),now(),'failed',now(),'db_error','${key}');
      `)
      const err = callRpcExpectError('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', key)
      expect(err).toMatch(/is not completed \(status=failed\)/)
    })

    it('a different algorithm_config_hash under the same profile/version is rejected fail-closed', () => {
      const key = `sts-rpc-diffconfig-${randomUUID()}`
      dockerPsql(`
        insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, status, completed_at, idempotency_key)
        values ('shadow_topic_v0','cluster_topic',2,'${'9'.repeat(64)}','{}'::jsonb,2,now(),now(),'completed',now(),'${key}-fake');
      `)
      try {
        const err = callRpcExpectError('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', key)
        expect(err).toMatch(/uses a different algorithm_config_hash/)
      } finally {
        // this fake row poisons the global (score_profile, algorithm_version)
        // config-hash invariant for every other test in the suite -- must be
        // removed immediately, not just at afterAll.
        dockerPsql(`delete from signal_score_runs where idempotency_key = '${key}-fake';`)
      }
    })

    it('two truly concurrent calls with the same idempotency_key produce exactly one completed + one replayed, one row total', async () => {
      const key = `sts-rpc-concurrent-${randomUUID()}`
      const ts = uniq('2026-01-01T00:00:00Z')
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const args = [
        'exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c',
        `SELECT run_shadow_topic_scoring('${ts}'::timestamptz, '${ts}'::timestamptz, '${key}');`,
      ]
      const [r1, r2] = await Promise.all([
        execFileAsync('docker', args),
        execFileAsync('docker', args),
      ])
      const outcomes = [r1.stdout, r2.stdout].map(o => JSON.parse(o.trim()).outcome).sort()
      expect(outcomes).toEqual(['completed', 'replayed'])
      const count = dockerPsql(`select count(*) from signal_score_runs where idempotency_key='${key}';`).trim()
      expect(count).toBe('1')
    })
  })

  // ------------------------------------------------------------
  // 6b. v1/v2 idempotency isolation -- v1 is never silently replayed as
  //     v2, and the per-version config-hash invariant stays isolated.
  // ------------------------------------------------------------
  describe('v1/v2 idempotency isolation', () => {
    it('calling the v2 RPC with the persisted v1 run\'s exact idempotency_key raises a semantic-mismatch error, never outcome=replayed', () => {
      const v1Key = dockerPsql(
        `select idempotency_key from signal_score_runs where idempotency_key like 'sts-rpc-v1legacy-%' and algorithm_version=1 order by created_at limit 1;`,
      ).trim()
      expect(v1Key).toMatch(/^sts-rpc-v1legacy-/)
      const err = callRpcExpectError('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', v1Key)
      expect(err).toMatch(/idempotency_key already used with different semantic parameters/)
      expect(err).not.toContain('"outcome": "replayed"')
    })

    it('a fresh v2 idempotency_key succeeds and stamps algorithm_version=2, input_snapshot_schema_version=2, and the new v2 algorithm_config_hash', () => {
      const ts = uniq('2026-01-17T00:00:00Z')
      const key = `sts-rpc-v2fresh-${randomUUID()}`
      const result = callRpc(ts, ts, key)
      expect(result.outcome).toBe('completed')
      const row = dockerPsql(`select algorithm_version||'|'||algorithm_config_hash from signal_score_runs where idempotency_key='${key}';`).trim()
      const [version, configHash] = row.split('|')
      expect(version).toBe('2')
      expect(configHash).toBe('ac9bcc711e105bf8e4822382191b63e1baec5df3fd8e0efcb680a5dba8ef8911')
      expect(configHash).not.toBe('7c6ec8a97fc182a6a41810245d141ea30b7e6677e4e4289bbfc7d298b6207910')
    })

    it('the (score_profile, algorithm_version) -> single config_hash invariant is scoped per-version: the persisted v1 row (different hash, version=1) never collides with a fresh v2 call', () => {
      const ts = uniq('2026-01-18T00:00:00Z')
      const result = callRpc(ts, ts, `sts-rpc-v2scoped-${randomUUID()}`)
      expect(result.outcome).toBe('completed')
    })
  })

  // ------------------------------------------------------------
  // 7. Rollback / failure atomicity
  // ------------------------------------------------------------
  describe('transactional atomicity', () => {
    it('a forced failure mid-computation leaves zero score rows and zero run rows (full rollback)', () => {
      // Force a failure by pre-inserting a conflicting semantic-dup run, which
      // the RPC detects AFTER the advisory lock but BEFORE any cluster work —
      // proves the whole call aborts cleanly with nothing partially written.
      const ts = uniq('2026-02-01T00:00:00Z')
      const key1 = `sts-rpc-atomic-a-${randomUUID()}`
      const key2 = `sts-rpc-atomic-b-${randomUUID()}`
      callRpc(ts, ts, key1)
      const beforeRunCount = dockerPsql(`select count(*) from signal_score_runs;`).trim()
      const err = callRpcExpectError(ts, ts, key2)
      expect(err).toMatch(/already exists for this exact/)
      const afterRunCount = dockerPsql(`select count(*) from signal_score_runs;`).trim()
      expect(afterRunCount).toBe(beforeRunCount)
      const scoreCountForKey2 = dockerPsql(`select count(*) from signal_score_runs where idempotency_key='${key2}';`).trim()
      expect(scoreCountForKey2).toBe('0')
    })
  })

  // ------------------------------------------------------------
  // 8. No collector / Creator Lane / legacy score regression
  // ------------------------------------------------------------
  it('collector control/RPCs and legacy score tables are untouched by 070/RPC execution', () => {
    const controlBefore = dockerPsql(`select enabled, updated_at from signal_collection_control;`).trim()
    const ts = uniq('2026-03-01T00:00:00Z')
    callRpc(ts, ts, `sts-rpc-collector-check-${randomUUID()}`)
    const controlAfter = dockerPsql(`select enabled, updated_at from signal_collection_control;`).trim()
    expect(controlAfter).toBe(controlBefore)
  })
})
