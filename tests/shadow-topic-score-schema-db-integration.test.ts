// Shadow Topic v0 — S1 score schema, REAL local DB integration tests.
//
// Ugyanazt a mintat koveti, mint a meglevo emerging-signal-*/creator-lane-*
// -db-integration suite-ok: a MEGLEVO, futo lokalis Supabase Docker stacket
// hasznalja (127.0.0.1:54321, demo anon/service_role kulcsok — nem
// production). Ha a stack nem elerheto, a teljes describe-blokk
// kontrolláltan KIHAGYODIK, hogy a "teljes vitest" futas Docker nelkuli
// kornyezetben is zold maradjon.
//
// Ez a kor (S1) kizarolag semat hoz letre — nincs RPC, nincs app-kod iro.
// A fixture-sorokat ezert kozvetlenul, postgres-szuperfelhasznalokent
// szurjuk be (dockerPsql), ugyanugy ahogy a creator-lane suite-ok is
// kozvetlenul szurjak be az auth.users/profiles fixture-oket — ez NEM a
// grant-matrixot teszteli (azt kulon, SET ROLE-lal tesszuk), csak a
// CHECK-szerzodest es a generalt oszlopok aritmetikajat.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
    input: sql,
    encoding: 'utf-8',
  })
}

// Egyes esetekben a HIBAT varjuk (CHECK-utkozes, permission denied) — ez a
// helper elnyeli a dobott hibat es a stderr/stdout szoveget adja vissza,
// hogy a teszt tudjon ellenorizni ellene, a creator-lane-authenticated-
// privilege suite dockerPsqlExpectError mintajat kovetve.
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

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function cleanupTestData() {
  dockerPsql(`
    delete from signal_cluster_scores where score_run_id in (select id from signal_score_runs where idempotency_key like 'sts-test-%');
    delete from signal_score_runs where idempotency_key like 'sts-test-%';
    delete from signal_clusters where primary_label like 'STS test cluster%';
    delete from signal_runs where idempotency_key like 'sts-fixture-%';
  `)
}

// Egy uj, valid signal_runs sor (a signal_clusters.created_by_run_id FK
// celjahoz) — nem signal_score_runs, egy MASIK, mar letezo tabla (049).
function insertFixtureCollectorRun(idempotencyKey: string): string {
  return dockerPsql(`
    insert into signal_runs (run_type, idempotency_key, status, completed_at)
    values ('shadow_batch', '${idempotencyKey}', 'completed', now())
    returning id;
  `).trim()
}

function insertFixtureCluster(label: string, runId: string): string {
  return dockerPsql(`
    insert into signal_clusters (primary_label, cluster_fingerprint, created_by_run_id)
    values ('${label}', '${'f'.repeat(32)}-${label}', '${runId}')
    returning id;
  `).trim()
}

function insertScoreRun(overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    score_profile: `'shadow_topic_v0'`,
    layer: `'cluster_topic'`,
    algorithm_version: '1',
    algorithm_config_hash: `'${HASH_A}'`,
    algorithm_config_snapshot: `'{"k":1}'::jsonb`,
    algorithm_config_schema_version: '1',
    evaluation_time: 'now()',
    input_cutoff: 'now()',
    status: `'processing'`,
    idempotency_key: `'sts-test-${Math.random().toString(36).slice(2)}'`,
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into signal_score_runs (${cols}) values (${vals}) returning id;`).trim()
}

type ClusterScoreOverrides = Record<string, string>

function zeroEligibleRow(scoreRunId: string, clusterId: string, overrides: ClusterScoreOverrides = {}): Record<string, string> {
  return {
    score_run_id: `'${scoreRunId}'`,
    signal_cluster_id: `'${clusterId}'`,
    evidence_count: '0',
    source_breadth: '0',
    youtube_evidence_count: '0',
    freshness_eligible_evidence_count: '0',
    velocity_eligible_evidence_count: '0',
    freshness_confidence_class: `'unknown'`,
    velocity_confidence_class: `'unknown'`,
    freshness_exclusion_reason: `'no_eligible_evidence'`,
    velocity_exclusion_reason: `'no_eligible_evidence'`,
    input_snapshot: `'{}'::jsonb`,
    input_digest: `'${HASH_B}'`,
    input_snapshot_schema_version: '1',
    sampling_policy: `'scheduled_only'`,
    ...overrides,
  }
}

function measuredRow(scoreRunId: string, clusterId: string, overrides: ClusterScoreOverrides = {}): Record<string, string> {
  return {
    score_run_id: `'${scoreRunId}'`,
    signal_cluster_id: `'${clusterId}'`,
    evidence_count: '5',
    source_breadth: '3',
    youtube_evidence_count: '5',
    freshness_eligible_evidence_count: '3',
    velocity_eligible_evidence_count: '3',
    median_discovery_lag_hours: '1.5000',
    median_observation_age_hours: '2.2500',
    median_average_view_velocity_per_hour: '100.500000',
    freshness_confidence_class: `'measured'`,
    velocity_confidence_class: `'measured'`,
    freshness_exclusion_reason: 'NULL',
    velocity_exclusion_reason: 'NULL',
    max_observed_at: 'now()',
    input_snapshot: `'{"a":1}'::jsonb`,
    input_digest: `'${HASH_B}'`,
    input_snapshot_schema_version: '1',
    sampling_policy: `'scheduled_only'`,
    ...overrides,
  }
}

function insertClusterScore(row: Record<string, string>): string {
  const cols = Object.keys(row).join(', ')
  const vals = Object.values(row).join(', ')
  return dockerPsql(`insert into signal_cluster_scores (${cols}) values (${vals}) returning id;`).trim()
}

function insertClusterScoreExpectError(row: Record<string, string>): string {
  const cols = Object.keys(row).join(', ')
  const vals = Object.values(row).join(', ')
  return dockerPsqlExpectError(`insert into signal_cluster_scores (${cols}) values (${vals});`)
}

describeIfLocalDb('Shadow Topic v0 S1 — signal_score_runs / signal_cluster_scores schema (real local DB)', () => {
  let runIdForClusters: string
  let clusterA: string
  let clusterB: string

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    cleanupTestData()
    runIdForClusters = insertFixtureCollectorRun(`sts-fixture-${Date.now()}`)
    clusterA = insertFixtureCluster(`STS test cluster A ${Date.now()}`, runIdForClusters)
    clusterB = insertFixtureCluster(`STS test cluster B ${Date.now()}`, runIdForClusters)
  })

  afterAll(() => {
    cleanupTestData()
  })

  // ------------------------------------------------------------
  // 1. Migration idempotency / drift — re-run the real 069 file
  // ------------------------------------------------------------
  describe('069 migration re-run behavior', () => {
    it('re-running 069 against an already-migrated DB is an exact no-op (no DDL/DCL, no error)', () => {
      const migrationSql = readFileSync(join(process.cwd(), 'supabase/migrations/069_shadow_topic_score_schema.sql'), 'utf8')
      // NOTICE messages are on stderr — redirect into stdout (2>&1) so the
      // "already exists and matches exactly" text is visible to execSync's
      // captured output.
      const out = execSync(
        'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
        { input: migrationSql, encoding: 'utf8' },
      )
      expect(out).toMatch(/signal_score_runs already exists and matches exactly — no-op\./)
      expect(out).toMatch(/signal_cluster_scores already exists and matches exactly — no-op\./)
      expect(out).not.toMatch(/drift/)
    })

    it('drift-fail-fast: an unauthorized column addition makes a 069 re-run fail closed, and reverting restores a clean idempotent re-run', () => {
      dockerPsql('ALTER TABLE public.signal_cluster_scores ADD COLUMN sts_drift_probe TEXT;')
      const migrationSql = readFileSync(join(process.cwd(), 'supabase/migrations/069_shadow_topic_score_schema.sql'), 'utf8')
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

      dockerPsql('ALTER TABLE public.signal_cluster_scores DROP COLUMN sts_drift_probe;')
      const out = execSync(
        'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
        { input: migrationSql, encoding: 'utf8' },
      )
      expect(out).toMatch(/signal_cluster_scores already exists and matches exactly — no-op\./)
    })
  })

  // ------------------------------------------------------------
  // 2. Exact column matrix
  // ------------------------------------------------------------
  it('signal_score_runs has exactly the expected 15 columns', () => {
    const out = dockerPsql(`select column_name from information_schema.columns where table_schema='public' and table_name='signal_score_runs' order by ordinal_position;`)
      .trim().split('\n')
    expect(out).toEqual([
      'id', 'score_profile', 'layer', 'algorithm_version', 'algorithm_config_hash',
      'algorithm_config_snapshot', 'algorithm_config_schema_version', 'evaluation_time',
      'input_cutoff', 'status', 'error_class', 'idempotency_key', 'started_at', 'completed_at', 'created_at',
    ])
  })

  it('signal_cluster_scores has exactly the expected 24 columns', () => {
    const out = dockerPsql(`select column_name from information_schema.columns where table_schema='public' and table_name='signal_cluster_scores' order by ordinal_position;`)
      .trim().split('\n')
    expect(out).toEqual([
      'id', 'score_run_id', 'signal_cluster_id', 'evidence_count', 'source_breadth', 'youtube_evidence_count',
      'median_discovery_lag_hours', 'median_observation_age_hours', 'median_average_view_velocity_per_hour',
      'freshness_eligible_evidence_count', 'velocity_eligible_evidence_count', 'freshness_coverage', 'velocity_coverage',
      'freshness_confidence_class', 'velocity_confidence_class', 'freshness_exclusion_reason', 'velocity_exclusion_reason',
      'ranking_eligible', 'input_snapshot', 'input_digest', 'input_snapshot_schema_version',
      'max_observed_at', 'sampling_policy', 'created_at',
    ])
  })

  // ------------------------------------------------------------
  // 3. PK / FK / UNIQUE presence + ON DELETE RESTRICT
  // ------------------------------------------------------------
  it('signal_cluster_scores FKs reference signal_score_runs and signal_clusters with ON DELETE RESTRICT', () => {
    const out = dockerPsql(`
      select conname||':'||confdeltype::text from pg_constraint
      where conrelid='public.signal_cluster_scores'::regclass and contype='f' order by conname;
    `).trim().split('\n')
    expect(out).toEqual([
      'signal_cluster_scores_score_run_id_fkey:r',
      'signal_cluster_scores_signal_cluster_id_fkey:r',
    ])
  })

  it('a referenced signal_score_runs row cannot be deleted while a signal_cluster_scores row references it (RESTRICT)', () => {
    const runId = insertScoreRun()
    insertClusterScore(zeroEligibleRow(runId, clusterA))
    const err = dockerPsqlExpectError(`delete from signal_score_runs where id='${runId}';`)
    expect(err).toMatch(/violates foreign key constraint/i)
  })

  it('idempotency_key is UNIQUE on signal_score_runs', () => {
    const key = `sts-test-uniq-${Date.now()}`
    insertScoreRun({ idempotency_key: `'${key}'` })
    const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,now(),now(),'${key}');`)
    expect(err).toMatch(/duplicate key value violates unique constraint "ssr_idempotency_key_key"/)
  })

  it('(score_profile, algorithm_version, algorithm_config_hash, evaluation_time, input_cutoff) is UNIQUE (semantic dup)', () => {
    const evalTime = '2026-08-21T00:00:00Z'
    insertScoreRun({ evaluation_time: `'${evalTime}'`, input_cutoff: `'${evalTime}'` })
    const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,'${evalTime}','${evalTime}','sts-test-${Date.now()}-b');`)
    expect(err).toMatch(/duplicate key value violates unique constraint "ssr_semantic_dup_key"/)
  })

  it('(score_run_id, signal_cluster_id) is UNIQUE on signal_cluster_scores', () => {
    const runId = insertScoreRun()
    insertClusterScore(zeroEligibleRow(runId, clusterA))
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA))
    expect(err).toMatch(/duplicate key value violates unique constraint "scs_run_cluster_key"/)
  })

  // ------------------------------------------------------------
  // 4. Generated coverage columns — real Postgres NUMERIC arithmetic
  // ------------------------------------------------------------
  describe('freshness_coverage / velocity_coverage generated columns', () => {
    it('0 youtube_evidence_count -> coverage=0 (division-by-zero guard, not NULL/error)', () => {
      const runId = insertScoreRun()
      const id = insertClusterScore(zeroEligibleRow(runId, clusterA))
      const out = dockerPsql(`select freshness_coverage||'|'||velocity_coverage from signal_cluster_scores where id='${id}';`).trim()
      expect(out).toBe('0.0000|0.0000')
    })

    it('coverage boundary cases: 1/7 and 3/5 round to 4 decimals correctly', () => {
      const runId = insertScoreRun()
      const id1 = insertClusterScore(measuredRow(runId, clusterA, {
        evidence_count: '9', youtube_evidence_count: '7',
        freshness_eligible_evidence_count: '1', velocity_eligible_evidence_count: '1',
        freshness_confidence_class: `'proxy'`, velocity_confidence_class: `'proxy'`,
        source_breadth: '2',
      }))
      const out1 = dockerPsql(`select freshness_coverage||'|'||velocity_coverage from signal_cluster_scores where id='${id1}';`).trim()
      // 1/7 = 0.142857... -> ROUND(.,4) = 0.1429
      expect(out1).toBe('0.1429|0.1429')

      const id2 = insertClusterScore(measuredRow(runId, clusterB, {
        evidence_count: '5', youtube_evidence_count: '5',
        freshness_eligible_evidence_count: '3', velocity_eligible_evidence_count: '3',
        source_breadth: '3',
      }))
      const out2 = dockerPsql(`select freshness_coverage||'|'||velocity_coverage from signal_cluster_scores where id='${id2}';`).trim()
      // 3/5 = 0.6 -> 0.6000
      expect(out2).toBe('0.6000|0.6000')
    })

    it('full coverage: eligible_count == youtube_evidence_count -> 1.0000', () => {
      const runId = insertScoreRun()
      const id = insertClusterScore(measuredRow(runId, clusterA, {
        evidence_count: '3', youtube_evidence_count: '3',
        freshness_eligible_evidence_count: '3', velocity_eligible_evidence_count: '3',
        source_breadth: '2',
      }))
      const out = dockerPsql(`select freshness_coverage||'|'||velocity_coverage from signal_cluster_scores where id='${id}';`).trim()
      expect(out).toBe('1.0000|1.0000')
    })

    it('coverage columns cannot be written directly (they are GENERATED ALWAYS)', () => {
      const runId = insertScoreRun()
      const row = zeroEligibleRow(runId, clusterA, { freshness_coverage: '0.5' })
      const err = insertClusterScoreExpectError(row)
      expect(err).toMatch(/cannot insert (a )?non-DEFAULT value into column "freshness_coverage"/i)
    })
  })

  // ------------------------------------------------------------
  // 5. source_breadth <= evidence_count, eligible <= youtube_evidence_count
  // ------------------------------------------------------------
  it('rejects source_breadth > evidence_count', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { evidence_count: '2', source_breadth: '3' }))
    expect(err).toMatch(/violates check constraint "scs_source_breadth_le_evidence"/)
  })

  it('rejects youtube_evidence_count > evidence_count', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { evidence_count: '2', youtube_evidence_count: '3' }))
    expect(err).toMatch(/violates check constraint "scs_youtube_count_le_evidence"/)
  })

  it('rejects freshness_eligible_evidence_count > youtube_evidence_count', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(measuredRow(runId, clusterA, {
      evidence_count: '3', youtube_evidence_count: '2',
      freshness_eligible_evidence_count: '3', freshness_confidence_class: `'measured'`,
      velocity_eligible_evidence_count: '2', velocity_confidence_class: `'proxy'`,
      source_breadth: '2',
    }))
    expect(err).toMatch(/violates check constraint "scs_freshness_eligible_le_youtube"/)
  })

  it('rejects velocity_eligible_evidence_count > youtube_evidence_count', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(measuredRow(runId, clusterA, {
      evidence_count: '3', youtube_evidence_count: '2',
      freshness_eligible_evidence_count: '2', freshness_confidence_class: `'proxy'`,
      velocity_eligible_evidence_count: '3', velocity_confidence_class: `'measured'`,
      source_breadth: '2',
    }))
    expect(err).toMatch(/violates check constraint "scs_velocity_eligible_le_youtube"/)
  })

  // ------------------------------------------------------------
  // 6. Confidence NULL-pairing + proxy/measured thresholds (both buckets)
  // ------------------------------------------------------------
  describe('freshness/velocity confidence class thresholds and NULL-pairing', () => {
    it('0 eligible -> unknown, raw NULL, exclusion_reason set (both buckets) — accepted', () => {
      const runId = insertScoreRun()
      const id = insertClusterScore(zeroEligibleRow(runId, clusterA))
      const out = dockerPsql(`
        select freshness_confidence_class||'|'||velocity_confidence_class||'|'||
               coalesce(median_discovery_lag_hours::text,'NULL')||'|'||
               coalesce(median_average_view_velocity_per_hour::text,'NULL')||'|'||
               (max_observed_at is null)::text
        from signal_cluster_scores where id='${id}';
      `).trim()
      expect(out).toBe('unknown|unknown|NULL|NULL|true')
    })

    it('1-2 eligible -> proxy — accepted', () => {
      const runId = insertScoreRun()
      const id = insertClusterScore(measuredRow(runId, clusterA, {
        evidence_count: '2', youtube_evidence_count: '2',
        freshness_eligible_evidence_count: '2', velocity_eligible_evidence_count: '1',
        freshness_confidence_class: `'proxy'`, velocity_confidence_class: `'proxy'`,
        source_breadth: '1',
      }))
      const out = dockerPsql(`select freshness_confidence_class||'|'||velocity_confidence_class from signal_cluster_scores where id='${id}';`).trim()
      expect(out).toBe('proxy|proxy')
    })

    it('exactly 3 eligible -> measured (threshold boundary) — accepted', () => {
      const runId = insertScoreRun()
      const id = insertClusterScore(measuredRow(runId, clusterA, { source_breadth: '2' }))
      const out = dockerPsql(`select freshness_confidence_class||'|'||velocity_confidence_class from signal_cluster_scores where id='${id}';`).trim()
      expect(out).toBe('measured|measured')
    })

    it('rejects mismatched confidence class for eligible count (2 eligible claiming measured)', () => {
      const runId = insertScoreRun()
      const err = insertClusterScoreExpectError(measuredRow(runId, clusterA, {
        evidence_count: '2', youtube_evidence_count: '2',
        freshness_eligible_evidence_count: '2', velocity_eligible_evidence_count: '2',
        source_breadth: '1',
        // freshness_confidence_class left as 'measured' from measuredRow default -> illegal for count=2
      }))
      expect(err).toMatch(/violates check constraint "scs_freshness_confidence_threshold"/)
    })

    it('rejects 0 eligible with a non-NULL raw value (freshness null-pairing)', () => {
      const runId = insertScoreRun()
      const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, {
        median_discovery_lag_hours: '1.0',
      }))
      expect(err).toMatch(/violates check constraint "scs_freshness_null_pairing"/)
    })

    it('rejects >0 eligible with a NULL raw value (velocity null-pairing)', () => {
      const runId = insertScoreRun()
      const err = insertClusterScoreExpectError(measuredRow(runId, clusterA, {
        median_average_view_velocity_per_hour: 'NULL', source_breadth: '2',
      }))
      expect(err).toMatch(/violates check constraint "scs_velocity_null_pairing"/)
    })

    it('rejects freshness_confidence_class outside the allowed enum', () => {
      const runId = insertScoreRun()
      const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { freshness_confidence_class: `'high'` }))
      expect(err).toMatch(/violates check constraint "scs_freshness_confidence_class_check"/)
    })

    it('rejects an exclusion_reason value outside the controlled enum', () => {
      const runId = insertScoreRun()
      const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { freshness_exclusion_reason: `'made_up_reason'` }))
      expect(err).toMatch(/violates check constraint "scs_freshness_exclusion_reason_check"/)
    })
  })

  // ------------------------------------------------------------
  // 7. ranking_eligible=false hard boundary
  // ------------------------------------------------------------
  it('rejects ranking_eligible=true (v0 hard boundary)', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { ranking_eligible: 'true' }))
    expect(err).toMatch(/violates check constraint "scs_ranking_eligible_false_in_v0"/)
  })

  it('ranking_eligible defaults to false when omitted', () => {
    const runId = insertScoreRun()
    const id = insertClusterScore(zeroEligibleRow(runId, clusterA))
    expect(dockerPsql(`select ranking_eligible from signal_cluster_scores where id='${id}';`).trim()).toBe('f')
  })

  // ------------------------------------------------------------
  // 8. Negative value rejection
  // ------------------------------------------------------------
  it('rejects a negative evidence_count', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { evidence_count: '-1' }))
    expect(err).toMatch(/violates check constraint "scs_evidence_count_nonneg"/)
  })

  it('rejects a negative source_breadth', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { source_breadth: '-1', evidence_count: '0' }))
    expect(err).toMatch(/violates check constraint "scs_source_breadth_nonneg"/)
  })

  it('rejects a negative median_discovery_lag_hours', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(measuredRow(runId, clusterA, { median_discovery_lag_hours: '-1.0', source_breadth: '2' }))
    expect(err).toMatch(/violates check constraint "scs_discovery_lag_nonneg"/)
  })

  it('rejects a negative median_average_view_velocity_per_hour', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(measuredRow(runId, clusterA, { median_average_view_velocity_per_hour: '-5.0', source_breadth: '2' }))
    expect(err).toMatch(/violates check constraint "scs_velocity_nonneg"/)
  })

  it('rejects a negative algorithm_version on signal_score_runs', () => {
    const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key) values ('shadow_topic_v0','cluster_topic',0,'${HASH_A}','{}'::jsonb,1,now(),now(),'sts-test-neg-${Date.now()}');`)
    expect(err).toMatch(/violates check constraint "ssr_algorithm_version_positive"/)
  })

  // ------------------------------------------------------------
  // 9. max_observed_at pairing
  // ------------------------------------------------------------
  it('rejects max_observed_at NOT NULL when both eligible counts are 0', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { max_observed_at: 'now()' }))
    expect(err).toMatch(/violates check constraint "scs_max_observed_at_pairing"/)
  })

  it('rejects max_observed_at NULL when an eligible count is > 0', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(measuredRow(runId, clusterA, { max_observed_at: 'NULL', source_breadth: '2' }))
    expect(err).toMatch(/violates check constraint "scs_max_observed_at_pairing"/)
  })

  // ------------------------------------------------------------
  // 10. JSON object CHECK + digest format
  // ------------------------------------------------------------
  it('rejects input_snapshot that is a JSON array instead of an object', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { input_snapshot: `'[]'::jsonb` }))
    expect(err).toMatch(/violates check constraint "scs_snapshot_is_object"/)
  })

  it('rejects input_snapshot that is a JSON scalar instead of an object', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { input_snapshot: `'"hello"'::jsonb` }))
    expect(err).toMatch(/violates check constraint "scs_snapshot_is_object"/)
  })

  it('rejects algorithm_config_snapshot that is not a JSON object', () => {
    const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','[1,2]'::jsonb,1,now(),now(),'sts-test-cfgarr-${Date.now()}');`)
    expect(err).toMatch(/violates check constraint "ssr_config_snapshot_is_object"/)
  })

  it('rejects an input_digest that is not exactly 64 lowercase hex chars', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { input_digest: `'not-a-hash'` }))
    expect(err).toMatch(/violates check constraint "scs_digest_format"/)
  })

  it('rejects an input_digest with uppercase hex characters', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { input_digest: `'${'A'.repeat(64)}'` }))
    expect(err).toMatch(/violates check constraint "scs_digest_format"/)
  })

  it('rejects an algorithm_config_hash that is not exactly 64 lowercase hex chars', () => {
    const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'too-short','{}'::jsonb,1,now(),now(),'sts-test-hashfmt-${Date.now()}');`)
    expect(err).toMatch(/violates check constraint "ssr_config_hash_format"/)
  })

  // ------------------------------------------------------------
  // 11. score_profile / layer / sampling_policy fixed enums
  // ------------------------------------------------------------
  it('rejects a score_profile other than shadow_topic_v0', () => {
    const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key) values ('other_profile','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,now(),now(),'sts-test-profile-${Date.now()}');`)
    expect(err).toMatch(/violates check constraint "ssr_score_profile_check"/)
  })

  it('rejects a layer other than cluster_topic', () => {
    const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key) values ('shadow_topic_v0','entity_topic',1,'${HASH_A}','{}'::jsonb,1,now(),now(),'sts-test-layer-${Date.now()}');`)
    expect(err).toMatch(/violates check constraint "ssr_layer_check"/)
  })

  it('rejects a sampling_policy other than scheduled_only', () => {
    const runId = insertScoreRun()
    const err = insertClusterScoreExpectError(zeroEligibleRow(runId, clusterA, { sampling_policy: `'on_demand'` }))
    expect(err).toMatch(/violates check constraint "scs_sampling_policy_check"/)
  })

  it('rejects input_cutoff after evaluation_time', () => {
    const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,'2026-01-01','2026-01-02','sts-test-cutoff-${Date.now()}');`)
    expect(err).toMatch(/violates check constraint "ssr_cutoff_not_after_eval"/)
  })

  // ------------------------------------------------------------
  // 12. Run-status pairing (processing/completed/failed)
  // ------------------------------------------------------------
  describe('signal_score_runs status/completed_at/error_class pairing', () => {
    it('processing with completed_at set is rejected', () => {
      const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, status, completed_at, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,now(),now(),'processing',now(),'sts-test-p1-${Date.now()}');`)
      expect(err).toMatch(/violates check constraint "ssr_completed_at_pairing"/)
    })

    it('completed without completed_at is rejected', () => {
      const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, status, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,now(),now(),'completed','sts-test-p2-${Date.now()}');`)
      expect(err).toMatch(/violates check constraint "ssr_completed_at_pairing"/)
    })

    it('failed without error_class is rejected', () => {
      const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, status, completed_at, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,now(),now(),'failed',now(),'sts-test-p3-${Date.now()}');`)
      expect(err).toMatch(/violates check constraint "ssr_error_class_pairing"/)
    })

    it('processing with error_class set is rejected', () => {
      const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, status, error_class, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,now(),now(),'processing','db_error','sts-test-p4-${Date.now()}');`)
      expect(err).toMatch(/violates check constraint "ssr_error_class_pairing"/)
    })

    it('a valid failed run (completed_at + error_class both set) is accepted', () => {
      const id = insertScoreRun({ status: `'failed'`, completed_at: 'now()', error_class: `'db_error'` })
      expect(id).not.toBe('')
    })

    it('completed_at before started_at is rejected', () => {
      const err = dockerPsqlExpectError(`insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, status, started_at, completed_at, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,now(),now(),'completed','2026-01-02','2026-01-01','sts-test-p5-${Date.now()}');`)
      expect(err).toMatch(/violates check constraint "ssr_completed_after_started"/)
    })
  })

  // ------------------------------------------------------------
  // 13. RLS + policy + NOT VALID
  // ------------------------------------------------------------
  it('RLS is enabled and forced on both tables', () => {
    const out = dockerPsql(`
      select relname||':'||relrowsecurity||':'||relforcerowsecurity from pg_class
      where relname in ('signal_score_runs','signal_cluster_scores') order by relname;
    `).trim().split('\n')
    expect(out).toEqual([
      'signal_cluster_scores:true:true',
      'signal_score_runs:true:true',
    ])
  })

  it('there are 0 RLS policies on either table', () => {
    const out = dockerPsql(`select count(*) from pg_policies where tablename in ('signal_score_runs','signal_cluster_scores');`).trim()
    expect(out).toBe('0')
  })

  it('there are 0 NOT VALID constraints on either table', () => {
    const out = dockerPsql(`
      select count(*) from pg_constraint
      where conrelid in ('public.signal_score_runs'::regclass, 'public.signal_cluster_scores'::regclass)
        and convalidated is not true;
    `).trim()
    expect(out).toBe('0')
  })

  // ------------------------------------------------------------
  // 14. Grant matrix — exact, both directions
  // ------------------------------------------------------------
  describe('grant matrix', () => {
    it('service_role has exactly SELECT on signal_score_runs and signal_cluster_scores', () => {
      const out = dockerPsql(`
        select table_name||':'||privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name in ('signal_score_runs','signal_cluster_scores') and grantee='service_role'
        order by 1;
      `).trim().split('\n')
      expect(out).toEqual([
        'signal_cluster_scores:SELECT',
        'signal_score_runs:SELECT',
      ])
    })

    it('anon/authenticated/PUBLIC have 0 grants on either table', () => {
      const out = dockerPsql(`
        select count(*) from information_schema.role_table_grants
        where table_schema='public' and table_name in ('signal_score_runs','signal_cluster_scores')
          and grantee in ('anon','authenticated','PUBLIC');
      `).trim()
      expect(out).toBe('0')
    })

    it('service_role cannot INSERT into signal_score_runs directly (SET ROLE, real grant check)', () => {
      const err = dockerPsqlExpectError(`
        SET ROLE service_role;
        insert into signal_score_runs (score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot, algorithm_config_schema_version, evaluation_time, input_cutoff, idempotency_key) values ('shadow_topic_v0','cluster_topic',1,'${HASH_A}','{}'::jsonb,1,now(),now(),'sts-test-svcins-${Date.now()}');
        RESET ROLE;
      `)
      expect(err).toMatch(/permission denied/i)
    })

    it('service_role cannot UPDATE signal_score_runs directly (SET ROLE, real grant check)', () => {
      const runId = insertScoreRun()
      const err = dockerPsqlExpectError(`
        SET ROLE service_role;
        update signal_score_runs set status='completed', completed_at=now() where id='${runId}';
        RESET ROLE;
      `)
      expect(err).toMatch(/permission denied/i)
    })

    it('service_role cannot DELETE from signal_cluster_scores directly (SET ROLE, real grant check)', () => {
      const runId = insertScoreRun()
      const id = insertClusterScore(zeroEligibleRow(runId, clusterA))
      const err = dockerPsqlExpectError(`
        SET ROLE service_role;
        delete from signal_cluster_scores where id='${id}';
        RESET ROLE;
      `)
      expect(err).toMatch(/permission denied/i)
    })

    it('service_role CAN SELECT from both tables directly (SET ROLE, real grant check)', () => {
      const out = dockerPsql(`
        SET ROLE service_role;
        select count(*) from signal_score_runs;
        select count(*) from signal_cluster_scores;
        RESET ROLE;
      `)
      expect(out).not.toBe('')
    })

    it('anon cannot SELECT signal_score_runs (SET ROLE, real grant check)', () => {
      const err = dockerPsqlExpectError(`
        SET ROLE anon;
        select count(*) from signal_score_runs;
        RESET ROLE;
      `)
      expect(err).toMatch(/permission denied/i)
    })

    it('authenticated cannot SELECT signal_cluster_scores (SET ROLE, real grant check)', () => {
      const err = dockerPsqlExpectError(`
        SET ROLE authenticated;
        select count(*) from signal_cluster_scores;
        RESET ROLE;
      `)
      expect(err).toMatch(/permission denied/i)
    })
  })
})
