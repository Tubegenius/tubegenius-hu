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
  // 1. Migration idempotency / drift
  // ------------------------------------------------------------
  describe('070 migration re-run behavior', () => {
    it('re-running 070 against an already-migrated DB is an exact no-op', () => {
      const migrationSql = readFileSync(join(process.cwd(), 'supabase/migrations/070_run_shadow_topic_scoring.sql'), 'utf8')
      const out = execSync(
        'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
        { input: migrationSql, encoding: 'utf8' },
      )
      expect(out).toMatch(/already exists and matches exactly -- no-op\./)
      expect(out).not.toMatch(/drift/)
    })

    it('drift-fail-fast: tampering the function body makes a 070 re-run fail closed, and CREATE OR REPLACE-ing it back restores a clean idempotent re-run', () => {
      dockerPsql(`
        CREATE OR REPLACE FUNCTION public.run_shadow_topic_scoring(p_evaluation_time timestamptz, p_input_cutoff timestamptz, p_idempotency_key text)
        RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $tamper$ BEGIN RETURN '{}'::jsonb; END; $tamper$;
      `)
      const migrationSql = readFileSync(join(process.cwd(), 'supabase/migrations/070_run_shadow_topic_scoring.sql'), 'utf8')
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

      // restore: re-apply the real migration body via a fresh reset-equivalent — drop and recreate from the file
      dockerPsql('DROP FUNCTION public.run_shadow_topic_scoring(timestamptz, timestamptz, text);')
      const out = execSync(
        'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
        { input: migrationSql, encoding: 'utf8' },
      )
      expect(out).toMatch(/run_shadow_topic_scoring created\./)
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
            '{"cluster_category_snapshot":%s,"cluster_id":%s,"cluster_status_snapshot":%s,"evaluation_time":%s,"evidence":[%s],"input_cutoff":%s,"observations":[%s],"schema_version":1}',
            to_json('tech_ai'::text)::text,
            to_json(signal_cluster_id::text)::text,
            to_json('active'::text)::text,
            to_json('${tsCanonical}'::text)::text,
            (select string_agg(format('{"cluster_link_created_at":%s,"eligibility":{"freshness":{"eligible":%s,"reason":%s},"velocity":{"eligible":%s,"reason":%s}},"evidence_id":%s,"evidence_type":%s,"first_seen_at":%s,"published_at":%s,"source_id":%s}',
              to_json('2026-01-01T01:00:00.000000Z'::text)::text, to_json(true)::text, 'null', to_json(true)::text, 'null',
              to_json('${e1}'::text)::text, to_json('youtube_video'::text)::text, to_json('2026-01-01T01:00:00.000000Z'::text)::text, to_json('2026-01-01T00:00:00.000000Z'::text)::text, to_json('${SOURCE_ID}'::text)::text
            ), ',')),
            to_json('${tsCanonical}'::text)::text,
            (select string_agg(format('{"bucket_start":%s,"cadence":"daily","evidence_id":%s,"metric_type":"youtube_view_count","observation_id":%s,"observed_at":%s,"selected_for_calculation":true}',
              to_json('2026-01-02T00:00:00.000000Z'::text)::text, to_json('${e1}'::text)::text, to_json(o.id::text)::text, to_json('2026-01-02T05:00:00.000000Z'::text)::text
            ), ',') from signal_observations o where o.signal_evidence_id='${e1}')
          ), 'UTF8'
        )), 'hex')) as matches
        from signal_cluster_scores where signal_cluster_id='${cluster}';
      `).trim()
      expect(out).toBe('t')
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
        values ('shadow_topic_v0','cluster_topic',1,'${'9'.repeat(64)}','{}'::jsonb,1,now(),now(),'completed',now(),'${key}-fake');
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
