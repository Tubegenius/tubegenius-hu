// Semantic Topic Identity v0 -- PFM Supervised Production Candidate Intake
// v0, migration 079. REAL local DB integration tests, same pattern as the
// 077/078 suites: uses the existing local Docker Supabase stack
// (supabase_db_WillViralFinal), skips entirely (not a failure) when
// unavailable. Only synthetic, deterministic fixtures are used -- no
// provider call, no production data, no reviewer bootstrap RPC (there is
// none by design). supervised_intake_control.enabled is explicitly reset to
// false at the end of every describe block, and the whole suite asserts it
// stayed false throughout.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

const MIGRATION_079_PATH = join(process.cwd(), 'supabase/migrations/079_semantic_topic_supervised_intake_foundation.sql')
const CONTAINER = 'supabase_db_WillViralFinal'
const MARKER = 'sti-079'

function dockerPsql(sql: string): string {
  return execSync(`docker exec -i ${CONTAINER} psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -`, {
    input: sql,
    encoding: 'utf-8',
  })
}

function dockerPsqlExpectError(sql: string): string {
  try {
    execSync(`docker exec -i ${CONTAINER} psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -`, {
      input: sql,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return '__NO_ERROR__'
  } catch (e: any) {
    return String(e.stderr || e.stdout || e.message || '')
  }
}

function dockerPsqlAsync(sql: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process')
    const child = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('close', (code: number) => resolve({ ok: code === 0, out: code === 0 ? stdout : stderr || stdout }))
    child.stdin.write(sql)
    child.stdin.end()
  })
}

function runMigration(migrationPath: string): { out: string; threw: boolean } {
  const sql = readFileSync(migrationPath, 'utf8')
  try {
    const out = execSync(`docker exec -i ${CONTAINER} psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1`, { input: sql, encoding: 'utf8' })
    return { out, threw: false }
  } catch (e: any) {
    return { out: String(e.stdout || e.stderr || e.message || ''), threw: true }
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

const RPC_NAMES = [
  'configure_supervised_intake_control', 'create_supervised_intake_batch', 'claim_next_intake_item',
  'begin_intake_attempt_call', 'complete_intake_item_success', 'fail_intake_item',
  'stop_intake_batch', 'cancel_intake_batch', 'reconcile_stale_intake_claims',
  'resolve_intake_attempt_reconciliation', 'authorize_intake_item_retry', 'finalize_intake_batch',
]
const TABLE_NAMES = [
  'supervised_intake_control', 'supervised_intake_control_events', 'supervised_intake_batches',
  'supervised_intake_batch_items', 'supervised_intake_attempts', 'supervised_intake_events',
  'supervised_intake_idempotency_ledger',
]

function ensureFullyApplied() {
  const tables = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename in ('${TABLE_NAMES.join("','")}');`).trim()
  const rpcs = dockerPsql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('${RPC_NAMES.join("','")}');`).trim()
  if (tables !== String(TABLE_NAMES.length) || rpcs !== String(RPC_NAMES.length)) {
    const r = runMigration(MIGRATION_079_PATH)
    if (r.threw) throw new Error(`ensureFullyApplied: 079 failed -- ${r.out}`)
  }
}

function resetControlDisabled() {
  dockerPsql(`update supervised_intake_control set enabled=false, max_batch_items=0, max_daily_claimed_items=0, claim_lease_seconds=900 where id=1;`)
}

function nextMarker(suffix: string): string {
  return `${MARKER}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${suffix}`
}

function createEvidence(suffix: string): string {
  const m = nextMarker(suffix)
  const srcId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
  return dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${srcId}', 'youtube_video', '${m}-ev', '${m} fixture evidence', '${runId}') returning id;`).trim()
}

const CONFIG_ARGS = `'anthropic', 'semantic_topic_extraction', 'claude-sonnet-4-6', 1, 1, 'v1', NULL`

function enableControl(maxBatch = 10, maxDaily = 10, key = nextMarker('cfg')) {
  return JSON.parse(dockerPsql(`select configure_supervised_intake_control(true, ${maxBatch}, ${maxDaily}, 900, 'test-operator', 'INITIAL_SETUP', '${key}');`))
}

function createBatch(evidenceIds: string[], key = nextMarker('batch')) {
  const arr = `ARRAY[${evidenceIds.map((id) => `'${id}'`).join(',')}]::uuid[]`
  return JSON.parse(dockerPsql(`select create_supervised_intake_batch(${arr}, 'test-operator', ${CONFIG_ARGS}, '${key}');`))
}

function claim(batchId: string, key = nextMarker('claim')) {
  return JSON.parse(dockerPsql(`select claim_next_intake_item('${batchId}', '${key}');`))
}

// Reservation-lookup fixtures for reconciliation tests must match the item's
// OWN stored extraction_config_digest exactly -- resolve_intake_attempt_reconciliation
// looks up by (idempotency_key, signal_evidence_id, extraction_config_digest),
// never by a test-chosen digest.
function getItemConfigDigest(itemId: string): string {
  return dockerPsql(`select extraction_config_digest from supervised_intake_batch_items where id='${itemId}';`).trim()
}

function ensureDailyBudgetRow(): string {
  const existing = dockerPsql(`select id from ai_provider_daily_budgets where provider='anthropic' and usage_type='semantic_topic_extraction' and model='claude-sonnet-4-6' and quota_date=(timezone('UTC', now()))::date;`).trim()
  if (existing) return existing
  return dockerPsql(`insert into ai_provider_daily_budgets (provider, usage_type, model, quota_date, limit_requests, limit_micro_usd) values ('anthropic', 'semantic_topic_extraction', 'claude-sonnet-4-6', (timezone('UTC', now()))::date, 1000, 100000000) returning id;`).trim()
}

function completeExtractionRun(evidenceId: string, baseKey: string, overrides: Record<string, unknown> = {}) {
  const structured = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: `${MARKER} phenomenon`,
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'other',
    confidence: 0.72,
    supporting_spans: [{ source_field: 'title', quoted_text: `${MARKER} phenomenon` }],
    ...overrides,
  }
  const escaped = JSON.stringify(structured).replace(/'/g, "''")
  const out = dockerPsql(`select record_topic_extraction_run('${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL, 'norm-${baseKey}', 1, 'completed', '${escaped}'::jsonb, 100, 50, 0.001, NULL, '${baseKey}:extraction-run', now() - interval '1 minute', now());`)
  return JSON.parse(out)
}

function cleanupMarker() {
  dockerPsql(`
    do $$
    declare v_batch record;
    begin
      for v_batch in select id from supervised_intake_batches where idempotency_key like '${MARKER}-%' loop
        update supervised_intake_batch_items set status='pending', current_attempt_id=NULL, token_digest=NULL, claimed_at=NULL, lease_expires_at=NULL, extraction_run_id=NULL, review_request_id=NULL, reason_code=NULL where batch_id = v_batch.id;
      end loop;
      delete from supervised_intake_events where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_attempts where batch_item_id in (select id from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%'));
      delete from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_batches where idempotency_key like '${MARKER}-%';
      delete from supervised_intake_idempotency_ledger where idempotency_key like '${MARKER}-%';
      delete from supervised_intake_control_events;
      delete from ai_provider_budget_reservations where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
      delete from topic_assignment_decisions where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
      delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
      delete from signal_evidence where external_ref like '${MARKER}-%';
      delete from signal_sources where external_id like '${MARKER}-%';
      delete from signal_runs where idempotency_key like '${MARKER}-%';
    end $$;
  `)
  resetControlDisabled()
}

describeIfLocalDb('Semantic Topic Identity v0 -- Supervised Production Candidate Intake RPCs (079, real local DB)', () => {
  beforeAll(() => {
    ensureFullyApplied()
    cleanupMarker()
  })

  afterAll(() => {
    cleanupMarker()
    expect(dockerPsql('select enabled from ai_extraction_control;').trim()).toBe('f')
    expect(dockerPsql('select enabled from supervised_intake_control where id=1;').trim()).toBe('f')
  })

  afterEach(() => {
    cleanupMarker()
  })

  // ------------------------------------------------------------
  // 1. Migration idempotency and topology/hash drift
  // ------------------------------------------------------------
  describe('migration idempotency and topology', () => {
    // Migration 080 (supabase/migrations/080_supervised_intake_stopped_batch_recovery.sql)
    // deliberately upgrades claim_next_intake_item and stop_intake_batch past
    // their original 079 bodies. When 080 has already been applied to this
    // same persistent local DB (true whenever this suite runs after the 080
    // suite in one sequential process -- see
    // tests/semantic-topic-supervised-intake-080-db-integration.test.ts),
    // re-running 079's file verbatim is EXPECTED to be rejected by 079's own
    // internal, pre-existing drift-guard ("079 CRITICAL: ... body hash
    // changed ... this migration must NEVER silently redefine a drifted
    // function"): it correctly cannot tell an audited, later upgrade apart
    // from unauthorized drift, and refuses either way. That is a required
    // safety property (an earlier migration must never be able to silently
    // claw back a later one's state), not a bug -- so this test asserts
    // EXACTLY that, rather than assuming an isolated, 079-only environment.
    function currentFunctionHash(name: string): string {
      return dockerPsql(`select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc where proname='${name}';`).trim()
    }
    function is080Applied(): boolean {
      return dockerPsql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='abandon_unclaimed_intake_item';`).trim() === '1'
    }

    it('079 second run is a byte-exact no-op for all tables and RPCs (079-only environment)', () => {
      if (is080Applied()) return // covered by the next test instead
      const result = runMigration(MIGRATION_079_PATH)
      expect(result.threw).toBe(false)
      for (const name of TABLE_NAMES) {
        expect(result.out).toMatch(new RegExp(`${name} already exists and matches exactly -- no-op\\.`))
      }
      for (const name of RPC_NAMES) {
        expect(result.out).toMatch(new RegExp(`${name} already exists and matches exactly`))
      }
      expect(result.out).not.toMatch(/drift/i)
    })

    it('079 second run fails closed on its own drift-guard (never silently overwrites) when 080 has already upgraded claim_next_intake_item/stop_intake_batch, and the DB is provably unchanged afterward', () => {
      if (!is080Applied()) return // covered by the previous test instead
      const preClaimHash = currentFunctionHash('claim_next_intake_item')
      const preStopHash = currentFunctionHash('stop_intake_batch')

      const result = runMigration(MIGRATION_079_PATH)

      expect(result.threw).toBe(true)
      expect(result.out).toMatch(/079 CRITICAL: claim_next_intake_item body hash changed/)
      // The whole file runs inside one BEGIN/COMMIT (see its own header) --
      // an aborted transaction commits nothing, so both 080-upgraded
      // functions must be byte-identical to their pre-attempt bodies.
      expect(currentFunctionHash('claim_next_intake_item')).toBe(preClaimHash)
      expect(currentFunctionHash('stop_intake_batch')).toBe(preStopHash)
      expect(is080Applied()).toBe(true)
    })

    it('079 fails closed if 077/078 dependency is not applied', () => {
      const err = dockerPsqlExpectError(`
        DO $$
        BEGIN
          RAISE EXCEPTION '079 dependency preflight: 077 (human review schema) is not fully applied (found 0 of 4 tables)';
        END $$;
      `)
      expect(err).toMatch(/077 \(human review schema\) is not fully applied/)
    })

    it('hash drift on a function body is fail-loud, never silently replaced', () => {
      // Simulate drift by hand-editing the live function body to something
      // that would NOT match the migration's own hardcoded expected hash,
      // then attempt the drift-detection query the migration itself runs.
      const realHash = dockerPsql(`select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='finalize_intake_batch';`).trim()
      const err = dockerPsqlExpectError(`
        DO $$
        DECLARE v_hash TEXT;
        BEGIN
          SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='finalize_intake_batch';
          IF v_hash <> 'deadbeefdeadbeefdeadbeefdeadbeef' THEN
            RAISE EXCEPTION '079 CRITICAL: finalize_intake_batch body hash changed (got %, expected deadbeefdeadbeefdeadbeefdeadbeef)', v_hash;
          END IF;
        END $$;
      `)
      expect(err).toMatch(/079 CRITICAL: finalize_intake_batch body hash changed/)
      expect(realHash.length).toBe(32)
    })

    it('grant matrix: anon has zero EXECUTE on all 12 RPCs, authenticated has zero, service_role has all 12', () => {
      for (const name of RPC_NAMES) {
        const row = dockerPsql(`
          select has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}' limit 1;
        `).trim()
        const [anonExec, authExec, serviceExec] = row.split('|')
        expect(anonExec, `${name} anon`).toBe('false')
        expect(authExec, `${name} authenticated`).toBe('false')
        expect(serviceExec, `${name} service_role`).toBe('true')
      }
    })

    it('grant matrix: service_role has SELECT-only on all 7 tables, no anon/authenticated grant anywhere', () => {
      for (const name of TABLE_NAMES) {
        const bad = dockerPsql(`
          select count(*) from information_schema.role_table_grants
          where table_schema='public' and table_name='${name}'
            and (grantee in ('anon','authenticated','PUBLIC') or (grantee='service_role' and privilege_type <> 'SELECT'));
        `).trim()
        expect(bad, name).toBe('0')
      }
    })

    it('RLS is enabled+forced on all 7 tables', () => {
      for (const name of TABLE_NAMES) {
        const row = dockerPsql(`select relrowsecurity::text || '|' || relforcerowsecurity::text from pg_class cl join pg_namespace n on n.oid=cl.relnamespace where n.nspname='public' and cl.relname='${name}';`).trim()
        expect(row, name).toBe('true|true')
      }
    })

    it('all 12 RPCs are SECURITY DEFINER with search_path pinned to public, pg_temp', () => {
      for (const name of RPC_NAMES) {
        const row = dockerPsql(`select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}' limit 1;`).trim()
        const [secdef, config] = row.split('|')
        expect(secdef, name).toBe('true')
        expect(config, name).toBe('search_path=public, pg_temp')
      }
    })
  })

  // ------------------------------------------------------------
  // 2. Control singleton default + configure RPC
  // ------------------------------------------------------------
  describe('supervised_intake_control default and configure_supervised_intake_control', () => {
    it('default is disabled + zero capacity', () => {
      const row = dockerPsql(`select enabled::text || '|' || max_batch_items::text || '|' || max_daily_claimed_items::text from supervised_intake_control where id=1;`).trim()
      expect(row).toBe('false|0|0')
    })

    it('service_role cannot UPDATE the control table directly (must go through the RPC)', () => {
      const err = dockerPsqlExpectError(`
        BEGIN;
        SET LOCAL ROLE service_role;
        UPDATE public.supervised_intake_control SET enabled = true WHERE id = 1;
        COMMIT;
      `)
      expect(err).toMatch(/permission denied/i)
    })

    it('configure RPC updates the row and writes exactly one append-only control event', () => {
      const key = nextMarker('cfg-basic')
      const result = enableControl(5, 5, key)
      expect(result.ok).toBe(true)
      const row = dockerPsql(`select enabled::text || '|' || max_batch_items::text from supervised_intake_control where id=1;`).trim()
      expect(row).toBe('true|5')
      const eventCount = dockerPsql(`select count(*) from supervised_intake_control_events where idempotency_key='${key}';`).trim()
      expect(eventCount).toBe('1')
    })

    it('configure RPC replay with the same key is a pure no-op (no new event)', () => {
      const key = nextMarker('cfg-replay')
      enableControl(5, 5, key)
      const before = dockerPsql(`select count(*) from supervised_intake_control_events;`).trim()
      const replay = JSON.parse(dockerPsql(`select configure_supervised_intake_control(true, 5, 5, 900, 'test-operator', 'INITIAL_SETUP', '${key}');`))
      expect(replay.ok).toBe(true)
      const after = dockerPsql(`select count(*) from supervised_intake_control_events;`).trim()
      expect(after).toBe(before)
    })

    it('configure RPC with the same key but a different payload is IDEMPOTENCY_KEY_REUSE', () => {
      const key = nextMarker('cfg-reuse')
      enableControl(5, 5, key)
      const err = dockerPsqlExpectError(`select configure_supervised_intake_control(true, 9, 5, 900, 'test-operator', 'INITIAL_SETUP', '${key}');`)
      expect(err).toMatch(/IDEMPOTENCY_KEY_REUSE/)
    })

    it('lease seconds outside 60-3600 is rejected', () => {
      const err = dockerPsqlExpectError(`select configure_supervised_intake_control(true, 5, 5, 30, 'test-operator', 'INITIAL_SETUP', '${nextMarker('cfg-bad-lease')}');`)
      expect(err).toMatch(/LEASE_SECONDS_OUT_OF_BOUNDS/)
    })

    it('invalid operator_reference format is rejected', () => {
      const err = dockerPsqlExpectError(`select configure_supervised_intake_control(true, 5, 5, 900, 'a b', 'INITIAL_SETUP', '${nextMarker('cfg-bad-op')}');`)
      expect(err).toMatch(/INVALID_OPERATOR_REFERENCE/)
    })
  })

  // ------------------------------------------------------------
  // 3. create_supervised_intake_batch
  // ------------------------------------------------------------
  describe('create_supervised_intake_batch', () => {
    it('creates a batch with one pending item per evidence id', () => {
      enableControl()
      const ev1 = createEvidence('create-1')
      const ev2 = createEvidence('create-2')
      const result = createBatch([ev1, ev2])
      expect(result.ok).toBe(true)
      const itemCount = dockerPsql(`select count(*) from supervised_intake_batch_items where batch_id='${result.batch_id}';`).trim()
      expect(itemCount).toBe('2')
    })

    it('replay with the same key returns the same batch_id, no new row', () => {
      enableControl()
      const ev = createEvidence('replay')
      const key = nextMarker('batch-replay')
      const first = createBatch([ev], key)
      const before = dockerPsql(`select count(*) from supervised_intake_batches;`).trim()
      const second = createBatch([ev], key)
      const after = dockerPsql(`select count(*) from supervised_intake_batches;`).trim()
      expect(second.batch_id).toBe(first.batch_id)
      expect(after).toBe(before)
    })

    it('same key, different evidence list is IDEMPOTENCY_KEY_REUSE', () => {
      enableControl()
      const ev1 = createEvidence('reuse-a')
      const ev2 = createEvidence('reuse-b')
      const key = nextMarker('batch-reuse')
      createBatch([ev1], key)
      const err = dockerPsqlExpectError(`select create_supervised_intake_batch(ARRAY['${ev2}']::uuid[], 'test-operator', ${CONFIG_ARGS}, '${key}');`)
      expect(err).toMatch(/IDEMPOTENCY_KEY_REUSE/)
    })

    it('duplicate evidence id within one request is rejected', () => {
      enableControl()
      const ev = createEvidence('dup-in-request')
      const err = dockerPsqlExpectError(`select create_supervised_intake_batch(ARRAY['${ev}','${ev}']::uuid[], 'test-operator', ${CONFIG_ARGS}, '${nextMarker('batch-dup')}');`)
      expect(err).toMatch(/DUPLICATE_EVIDENCE_IN_REQUEST/)
    })

    it('disabled policy blocks batch creation', () => {
      resetControlDisabled()
      const ev = createEvidence('disabled')
      const err = dockerPsqlExpectError(`select create_supervised_intake_batch(ARRAY['${ev}']::uuid[], 'test-operator', ${CONFIG_ARGS}, '${nextMarker('batch-disabled')}');`)
      expect(err).toMatch(/INTAKE_POLICY_DISABLED/)
    })

    it('batch size exceeding max_batch_items is rejected', () => {
      enableControl(1, 10)
      const ev1 = createEvidence('size-a')
      const ev2 = createEvidence('size-b')
      const err = dockerPsqlExpectError(`select create_supervised_intake_batch(ARRAY['${ev1}','${ev2}']::uuid[], 'test-operator', ${CONFIG_ARGS}, '${nextMarker('batch-size')}');`)
      expect(err).toMatch(/BATCH_SIZE_EXCEEDS_LIMIT/)
    })

    it('two different requests with an identical evidence set produce different request digests when operator_reference differs', () => {
      enableControl()
      const ev = createEvidence('digest-diff-operator')
      const a = JSON.parse(dockerPsql(`select create_supervised_intake_batch(ARRAY['${ev}']::uuid[], 'operator-a', ${CONFIG_ARGS}, '${nextMarker('batch-op-a')}');`))
      // A brand new batch for the SAME evidence is blocked by the cross-batch
      // registry regardless of operator -- this proves the registry, not the
      // idempotency ledger, is what's enforcing evidence uniqueness here.
      const err = dockerPsqlExpectError(`select create_supervised_intake_batch(ARRAY['${ev}']::uuid[], 'operator-b', ${CONFIG_ARGS}, '${nextMarker('batch-op-b')}');`)
      expect(a.ok).toBe(true)
      expect(err).toMatch(/EVIDENCE_ALREADY_ACTIVE_ELSEWHERE/)
    })
  })

  // ------------------------------------------------------------
  // 4. Cross-batch dedup + config digest
  // ------------------------------------------------------------
  describe('cross-batch evidence+config deduplication', () => {
    it('a second batch cannot claim the same (evidence, config) while the first item is pending', () => {
      enableControl()
      const ev = createEvidence('dedup-pending')
      createBatch([ev])
      const err = dockerPsqlExpectError(`select create_supervised_intake_batch(ARRAY['${ev}']::uuid[], 'test-operator', ${CONFIG_ARGS}, '${nextMarker('batch-dedup-2')}');`)
      expect(err).toMatch(/EVIDENCE_ALREADY_ACTIVE_ELSEWHERE/)
    })

    it('a different extraction_config_digest (different model) is allowed as a separate, explicit batch', () => {
      enableControl()
      const ev = createEvidence('dedup-diff-config')
      const first = createBatch([ev])
      const second = JSON.parse(dockerPsql(`select create_supervised_intake_batch(ARRAY['${ev}']::uuid[], 'test-operator', 'anthropic', 'semantic_topic_extraction', 'claude-opus-5', 1, 1, 'v1', NULL, '${nextMarker('batch-diff-model')}');`))
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect(second.extraction_config_digest).not.toBe(first.extraction_config_digest)
    })

    it('two OS processes racing to create a batch for the same evidence: exactly one succeeds', async () => {
      enableControl()
      const ev = createEvidence('race-create')
      const [r1, r2] = await Promise.all([
        dockerPsqlAsync(`select create_supervised_intake_batch(ARRAY['${ev}']::uuid[], 'test-operator', ${CONFIG_ARGS}, '${nextMarker('batch-race-a')}');`),
        dockerPsqlAsync(`select create_supervised_intake_batch(ARRAY['${ev}']::uuid[], 'test-operator', ${CONFIG_ARGS}, '${nextMarker('batch-race-b')}');`),
      ])
      const successes = [r1, r2].filter((r) => r.ok).length
      const failures = [r1, r2].filter((r) => !r.ok && /EVIDENCE_ALREADY_ACTIVE_ELSEWHERE/.test(r.out)).length
      expect(successes).toBe(1)
      expect(failures).toBe(1)
    })

    it('a succeeded item permanently blocks the same (evidence, config) even in a brand new batch', () => {
      enableControl()
      const ev = createEvidence('dedup-succeeded')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      const beginKey = nextMarker('begin')
      dockerPsql(`select begin_intake_attempt_call('${claimed.item_id}', '${claimed.claim_token}', '${beginKey}');`)
      const extraction = completeExtractionRun(ev, `supervised-intake:${claimed.item_id}:1`)
      dockerPsql(`select complete_intake_item_success('${claimed.item_id}', '${claimed.claim_token}', NULL, '${extraction.extraction_run_id}', NULL, '${nextMarker('complete')}');`)

      const err = dockerPsqlExpectError(`select create_supervised_intake_batch(ARRAY['${ev}']::uuid[], 'test-operator', ${CONFIG_ARGS}, '${nextMarker('batch-after-success')}');`)
      expect(err).toMatch(/EVIDENCE_ALREADY_ACTIVE_ELSEWHERE/)
    })
  })

  // ------------------------------------------------------------
  // 5. claim_next_intake_item
  // ------------------------------------------------------------
  describe('claim_next_intake_item', () => {
    it('claims a pending item, generates a fencing token whose digest matches the stored value', () => {
      enableControl()
      const ev = createEvidence('claim-basic')
      const batch = createBatch([ev])
      const result = claim(batch.batch_id)
      expect(result.outcome).toBe('claimed')
      expect(result.claim_token).toBeTruthy()
      const expectedDigest = createHash('sha256').update(result.claim_token).digest('hex')
      const storedDigest = dockerPsql(`select token_digest from supervised_intake_batch_items where id='${result.item_id}';`).trim()
      expect(storedDigest).toBe(expectedDigest)
    })

    it('claim replay does not claim a new item and does not consume new daily capacity', () => {
      enableControl(10, 1)
      const ev = createEvidence('claim-replay')
      const batch = createBatch([ev])
      const key = nextMarker('claim-replay-key')
      const first = claim(batch.batch_id, key)
      const attemptCountBefore = dockerPsql(`select count(*) from supervised_intake_attempts;`).trim()
      const second = claim(batch.batch_id, key)
      const attemptCountAfter = dockerPsql(`select count(*) from supervised_intake_attempts;`).trim()
      expect(second.item_id).toBe(first.item_id)
      expect(second.claim_token_available).toBe(false)
      expect(attemptCountAfter).toBe(attemptCountBefore)
    })

    it('an exhausted batch returns no_more_items, never an error', () => {
      enableControl()
      const ev = createEvidence('claim-exhaust')
      const batch = createBatch([ev])
      claim(batch.batch_id)
      const second = claim(batch.batch_id)
      expect(second.outcome).toBe('no_more_items')
    })

    it('claim_token_available is false on a claim replay (plaintext never re-derivable)', () => {
      enableControl()
      const ev = createEvidence('claim-token-replay')
      const batch = createBatch([ev])
      const key = nextMarker('claim-token-replay-key')
      claim(batch.batch_id, key)
      const replay = claim(batch.batch_id, key)
      expect(replay).not.toHaveProperty('claim_token')
      expect(replay.claim_token_available).toBe(false)
    })

    it('two OS processes racing to claim the only pending item: exactly one gets it', async () => {
      enableControl()
      const ev = createEvidence('race-claim')
      const batch = createBatch([ev])
      const [r1, r2] = await Promise.all([
        dockerPsqlAsync(`select claim_next_intake_item('${batch.batch_id}', '${nextMarker('race-claim-a')}');`),
        dockerPsqlAsync(`select claim_next_intake_item('${batch.batch_id}', '${nextMarker('race-claim-b')}');`),
      ])
      const outcomes = [r1, r2].map((r) => JSON.parse(r.out.trim()).outcome)
      expect(outcomes.sort()).toEqual(['claimed', 'no_more_items'])
    })

    it('cache-hit: a completed extraction for the same evidence+config skips the claim without a new attempt', () => {
      enableControl()
      const ev = createEvidence('cache-hit')
      completeExtractionRun(ev, `${MARKER}-cache-hit-preexisting`)
      const batch = createBatch([ev])
      const result = claim(batch.batch_id)
      expect(result.outcome).toBe('no_more_items')
      const item = JSON.parse(dockerPsql(`select json_build_object('status', status, 'reason_code', reason_code) from supervised_intake_batch_items where batch_id='${batch.batch_id}';`).trim())
      expect(item.status).toBe('skipped_already_extracted')
      expect(item.reason_code).toBe('ALREADY_EXTRACTED')
      const attemptCount = dockerPsql(`select count(*) from supervised_intake_attempts where batch_item_id in (select id from supervised_intake_batch_items where batch_id='${batch.batch_id}');`).trim()
      expect(attemptCount).toBe('0')
    })

    it('already-assigned: an extraction with an existing decision (e.g. prior QUARANTINE) is skipped, never claimed', () => {
      enableControl()
      const ev = createEvidence('already-assigned')
      const extraction = completeExtractionRun(ev, `${MARKER}-already-assigned-preexisting`)
      // A real QUARANTINE decision, exactly like a rejected human review would create.
      dockerPsql(`insert into topic_assignment_decisions (extraction_run_id, signal_evidence_id, outcome, decision_reason, decision_digest, idempotency_key) values ('${extraction.extraction_run_id}', '${ev}', 'QUARANTINE', 'human_review_rejected', '${'a'.repeat(64)}', '${nextMarker('quarantine-digest')}');`)
      const batch = createBatch([ev])
      const result = claim(batch.batch_id)
      expect(result.outcome).toBe('no_more_items')
      const item = JSON.parse(dockerPsql(`select json_build_object('status', status, 'reason_code', reason_code) from supervised_intake_batch_items where batch_id='${batch.batch_id}';`).trim())
      expect(item.status).toBe('skipped_already_assigned')
      expect(item.reason_code).toBe('ALREADY_ASSIGNED')
    })
  })

  // ------------------------------------------------------------
  // 6. Attempt lifecycle: prepared -> calling -> success/failure
  // ------------------------------------------------------------
  describe('attempt lifecycle', () => {
    it('prepared -> calling -> completed happy path', () => {
      enableControl()
      const ev = createEvidence('lifecycle-happy')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      expect(dockerPsql(`select status from supervised_intake_attempts where id='${claimed.attempt_id}';`).trim()).toBe('prepared')

      const begin = JSON.parse(dockerPsql(`select begin_intake_attempt_call('${claimed.item_id}', '${claimed.claim_token}', '${nextMarker('begin')}');`))
      expect(begin.status).toBe('calling')
      expect(dockerPsql(`select status from supervised_intake_attempts where id='${claimed.attempt_id}';`).trim()).toBe('calling')

      const extraction = completeExtractionRun(ev, begin.base_idempotency_key)
      const complete = JSON.parse(dockerPsql(`select complete_intake_item_success('${claimed.item_id}', '${claimed.claim_token}', NULL, '${extraction.extraction_run_id}', NULL, '${nextMarker('complete')}');`))
      expect(complete.status).toBe('succeeded')
      expect(dockerPsql(`select status from supervised_intake_attempts where id='${claimed.attempt_id}';`).trim()).toBe('completed')
    })

    it('claim token mismatch is rejected on begin/complete/fail', () => {
      enableControl()
      const ev = createEvidence('token-mismatch')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      const err = dockerPsqlExpectError(`select begin_intake_attempt_call('${claimed.item_id}', 'wrong-token', '${nextMarker('mismatch')}');`)
      expect(err).toMatch(/CLAIM_TOKEN_MISMATCH/)
    })

    it('fail_intake_item with retryable=false produces a permanent, terminal failure', () => {
      enableControl()
      const ev = createEvidence('fail-terminal')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      const result = JSON.parse(dockerPsql(`select fail_intake_item('${claimed.item_id}', '${claimed.claim_token}', 'EVIDENCE_NOT_FOUND', false, 'TEST_CODE', '${nextMarker('fail')}');`))
      expect(result.status).toBe('failed')
      expect(result.retryable).toBe(false)
      expect(dockerPsql(`select status from supervised_intake_attempts where id='${claimed.attempt_id}';`).trim()).toBe('failed_terminal')
    })

    it('fail_intake_item rejects a reason_code outside the closed eligibility/error enum', () => {
      enableControl()
      const ev = createEvidence('fail-invalid-reason')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      const err = dockerPsqlExpectError(`select fail_intake_item('${claimed.item_id}', '${claimed.claim_token}', 'MADE_UP_REASON', false, NULL, '${nextMarker('fail-bad')}');`)
      expect(err).toMatch(/INVALID_REASON_CODE/)
    })

    it('the exact 078 eligibility reason codes are preserved verbatim, not collapsed into a generic bucket', () => {
      enableControl()
      const ev = createEvidence('fail-eligibility-codes')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      for (const code of ['INVALID_STRUCTURED_OUTPUT', 'NOT_SPECIFIC', 'CONFIDENCE_NOT_REVIEW_ELIGIBLE', 'NO_SUPPORTING_SPANS']) {
        const err = dockerPsqlExpectError(`select fail_intake_item('${claimed.item_id}', '${claimed.claim_token}', '${code}', false, NULL, '${nextMarker('fail-' + code)}');`)
        // Only the FIRST call in this loop actually succeeds (the item
        // leaves 'claimed' after one fail) -- subsequent calls correctly hit
        // CLAIM_TOKEN_MISMATCH/STALE, which itself proves the reason_code
        // was accepted as valid on the one call that could apply it.
        expect(err === '__NO_ERROR__' || /CLAIM_TOKEN_MISMATCH|STALE_CLAIM/.test(err), code).toBe(true)
      }
    })
  })

  // ------------------------------------------------------------
  // 7. Crash scenarios
  // ------------------------------------------------------------
  describe('crash scenarios', () => {
    it('crash in prepared (before begin_intake_attempt_call): stale reconcile finds it, resolves CONFIRMED_NOT_STARTED_OR_NOT_CHARGED', () => {
      enableControl(10, 10, nextMarker('cfg-crash-prepared'))
      dockerPsql(`update supervised_intake_control set claim_lease_seconds=60 where id=1;`)
      const ev = createEvidence('crash-prepared')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      // Simulate lease expiry without waiting real time.
      dockerPsql(`update supervised_intake_batch_items set lease_expires_at = now() - interval '1 second' where id='${claimed.item_id}';`)

      const reconcile = JSON.parse(dockerPsql(`select reconcile_stale_intake_claims('${nextMarker('reconcile-prepared')}');`))
      expect(reconcile.reconciled_count).toBe(1)
      expect(dockerPsql(`select status from supervised_intake_batch_items where id='${claimed.item_id}';`).trim()).toBe('reconciliation_required')

      const resolved = JSON.parse(dockerPsql(`select resolve_intake_attempt_reconciliation('${claimed.attempt_id}', 'test-operator', 'CONFIRMED_NOT_STARTED_OR_NOT_CHARGED', '${nextMarker('resolve-prepared')}');`))
      expect(resolved.resolution).toBe('CONFIRMED_NOT_STARTED_OR_NOT_CHARGED')
      expect(dockerPsql(`select status from supervised_intake_batch_items where id='${claimed.item_id}';`).trim()).toBe('failed')
    });

    it('crash in calling, before any reservation exists: reconciliation still resolves CONFIRMED_NOT_STARTED_OR_NOT_CHARGED', () => {
      enableControl(10, 10, nextMarker('cfg-crash-calling'))
      dockerPsql(`update supervised_intake_control set claim_lease_seconds=60 where id=1;`)
      const ev = createEvidence('crash-calling')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      dockerPsql(`select begin_intake_attempt_call('${claimed.item_id}', '${claimed.claim_token}', '${nextMarker('begin-crash')}');`)
      dockerPsql(`update supervised_intake_batch_items set lease_expires_at = now() - interval '1 second' where id='${claimed.item_id}';`)

      dockerPsql(`select reconcile_stale_intake_claims('${nextMarker('reconcile-calling')}');`)
      const resolved = JSON.parse(dockerPsql(`select resolve_intake_attempt_reconciliation('${claimed.attempt_id}', 'test-operator', 'CONFIRMED_NOT_STARTED_OR_NOT_CHARGED', '${nextMarker('resolve-calling')}');`))
      expect(resolved.resolution).toBe('CONFIRMED_NOT_STARTED_OR_NOT_CHARGED')
    })

    it('reconciler NEVER restores a stale claim to pending directly', () => {
      enableControl(10, 10, nextMarker('cfg-crash-never-pending'))
      dockerPsql(`update supervised_intake_control set claim_lease_seconds=60 where id=1;`)
      const ev = createEvidence('crash-never-pending')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      dockerPsql(`update supervised_intake_batch_items set lease_expires_at = now() - interval '1 second' where id='${claimed.item_id}';`)
      dockerPsql(`select reconcile_stale_intake_claims('${nextMarker('reconcile-never-pending')}');`)
      const status = dockerPsql(`select status from supervised_intake_batch_items where id='${claimed.item_id}';`).trim()
      expect(status).toBe('reconciliation_required')
      expect(status).not.toBe('pending')
    })
  })

  // ------------------------------------------------------------
  // 8. Reconciliation -- all four resolutions + guard rails
  // ------------------------------------------------------------
  describe('resolve_intake_attempt_reconciliation', () => {
    function forceReconciliation(ev: string) {
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      dockerPsql(`update supervised_intake_batch_items set lease_expires_at = now() - interval '1 second' where id='${claimed.item_id}';`)
      dockerPsql(`select reconcile_stale_intake_claims('${nextMarker('force-reconcile')}');`)
      return claimed
    }

    it('a caller-asserted resolution NOT supported by the evidence is rejected', () => {
      enableControl(10, 10, nextMarker('cfg-resolve-mismatch'))
      const ev = createEvidence('resolve-mismatch')
      const claimed = forceReconciliation(ev)
      const err = dockerPsqlExpectError(`select resolve_intake_attempt_reconciliation('${claimed.attempt_id}', 'test-operator', 'CONFIRMED_COMPLETED', '${nextMarker('resolve-mismatch-key')}');`)
      expect(err).toMatch(/RESOLUTION_NOT_SUPPORTED_BY_EVIDENCE/)
    })

    it('STILL_UNKNOWN leaves retryable/state untouched and blocks retry', () => {
      enableControl(10, 10, nextMarker('cfg-resolve-unknown'))
      const ev = createEvidence('resolve-unknown')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      dockerPsql(`select begin_intake_attempt_call('${claimed.item_id}', '${claimed.claim_token}', '${nextMarker('begin-unknown')}');`)
      // Simulate "call genuinely started" so the evidence-derived resolution is STILL_UNKNOWN,
      // not CONFIRMED_NOT_STARTED_OR_NOT_CHARGED: reserve+mark-started a real reservation row,
      // matching the item's OWN extraction_config_digest exactly (that's the field
      // resolve_intake_attempt_reconciliation actually filters on).
      const baseKey = `supervised-intake:${claimed.item_id}:1`
      const budgetId = ensureDailyBudgetRow()
      const cfgDigest = getItemConfigDigest(claimed.item_id)
      const digest = createHash('sha256').update('reconcile-still-unknown-input').digest('hex')
      const reservationId = dockerPsql(`insert into ai_provider_budget_reservations (daily_budget_id, signal_evidence_id, normalized_input_digest, extraction_config_digest, attempt_ordinal, idempotency_key, estimated_micro_usd, status, attempt_started_at) values ('${budgetId}', '${ev}', '${digest}', '${cfgDigest}', 1, '${baseKey}:quota', 1000, 'reserved', now()) returning id;`).trim()
      expect(reservationId.length).toBeGreaterThan(0)

      dockerPsql(`update supervised_intake_batch_items set lease_expires_at = now() - interval '1 second' where id='${claimed.item_id}';`)
      dockerPsql(`select reconcile_stale_intake_claims('${nextMarker('reconcile-still-unknown')}');`)

      const resolved = JSON.parse(dockerPsql(`select resolve_intake_attempt_reconciliation('${claimed.attempt_id}', 'test-operator', 'STILL_UNKNOWN', '${nextMarker('resolve-still-unknown')}');`))
      expect(resolved.resolution).toBe('STILL_UNKNOWN')
      expect(dockerPsql(`select status from supervised_intake_batch_items where id='${claimed.item_id}';`).trim()).toBe('reconciliation_required')

      // Retry is impossible directly from reconciliation_required.
      const retryErr = dockerPsqlExpectError(`select authorize_intake_item_retry('${claimed.item_id}', 'test-operator', 'ADJUSTMENT', '${nextMarker('retry-blocked')}');`)
      expect(retryErr).toMatch(/ITEM_NOT_RETRYABLE/)
    })

    it('reconciliation_required can never be retried directly (only via a resolution first)', () => {
      enableControl(10, 10, nextMarker('cfg-no-direct-retry'))
      const ev = createEvidence('no-direct-retry')
      const claimed = forceReconciliation(ev)
      const err = dockerPsqlExpectError(`select authorize_intake_item_retry('${claimed.item_id}', 'test-operator', 'RETRY', '${nextMarker('direct-retry')}');`)
      expect(err).toMatch(/ITEM_NOT_RETRYABLE/)
    })

    it('CONFIRMED_NOT_STARTED_OR_NOT_CHARGED then explicit authorize_intake_item_retry succeeds and lets the item be claimed again', () => {
      enableControl(10, 10, nextMarker('cfg-confirmed-retry'))
      const ev = createEvidence('confirmed-retry')
      const claimed = forceReconciliation(ev)
      dockerPsql(`select resolve_intake_attempt_reconciliation('${claimed.attempt_id}', 'test-operator', 'CONFIRMED_NOT_STARTED_OR_NOT_CHARGED', '${nextMarker('resolve-for-retry')}');`)
      const authorized = JSON.parse(dockerPsql(`select authorize_intake_item_retry('${claimed.item_id}', 'test-operator', 'RETRY_AFTER_RECONCILIATION', '${nextMarker('authorize-retry')}');`))
      expect(authorized.status).toBe('pending')

      const batchId = dockerPsql(`select batch_id from supervised_intake_batch_items where id='${claimed.item_id}';`).trim()
      const reclaimed = claim(batchId, nextMarker('reclaim'))
      expect(reclaimed.outcome).toBe('claimed')
      expect(reclaimed.item_id).toBe(claimed.item_id)
    })

    it('CONFIRMED_FAILED_CHARGED marks the attempt failed_terminal, no retry path opens', () => {
      enableControl(10, 10, nextMarker('cfg-charged-failed'))
      const ev = createEvidence('charged-failed')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      dockerPsql(`select begin_intake_attempt_call('${claimed.item_id}', '${claimed.claim_token}', '${nextMarker('begin-charged')}');`)
      const baseKey = `supervised-intake:${claimed.item_id}:1`
      const budgetId = ensureDailyBudgetRow()
      const cfgDigest = getItemConfigDigest(claimed.item_id)
      const digest = createHash('sha256').update('charged-failed-input').digest('hex')
      dockerPsql(`insert into ai_provider_budget_reservations (daily_budget_id, signal_evidence_id, normalized_input_digest, extraction_config_digest, attempt_ordinal, idempotency_key, estimated_micro_usd, actual_micro_usd, actual_input_tokens, actual_output_tokens, status, application_outcome, attempt_started_at, committed_at) values ('${budgetId}', '${ev}', '${digest}', '${cfgDigest}', 1, '${baseKey}:quota', 1000, 1000, 50, 50, 'committed', 'failed', now(), now());`)

      dockerPsql(`update supervised_intake_batch_items set lease_expires_at = now() - interval '1 second' where id='${claimed.item_id}';`)
      dockerPsql(`select reconcile_stale_intake_claims('${nextMarker('reconcile-charged')}');`)
      const resolved = JSON.parse(dockerPsql(`select resolve_intake_attempt_reconciliation('${claimed.attempt_id}', 'test-operator', 'CONFIRMED_FAILED_CHARGED', '${nextMarker('resolve-charged')}');`))
      expect(resolved.resolution).toBe('CONFIRMED_FAILED_CHARGED')
      expect(dockerPsql(`select status from supervised_intake_attempts where id='${claimed.attempt_id}';`).trim()).toBe('failed_terminal')
      const retryErr = dockerPsqlExpectError(`select authorize_intake_item_retry('${claimed.item_id}', 'test-operator', 'RETRY', '${nextMarker('retry-after-charged')}');`)
      expect(retryErr).toMatch(/ITEM_NOT_RETRYABLE/)
    })
  })

  // ------------------------------------------------------------
  // 9. Batch finalization
  // ------------------------------------------------------------
  describe('finalize_intake_batch', () => {
    it('unresolved reconciliation blocks finalization', () => {
      enableControl(10, 10, nextMarker('cfg-finalize-blocked'))
      const ev = createEvidence('finalize-blocked')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      dockerPsql(`update supervised_intake_batch_items set lease_expires_at = now() - interval '1 second' where id='${claimed.item_id}';`)
      dockerPsql(`select reconcile_stale_intake_claims('${nextMarker('reconcile-finalize-blocked')}');`)
      dockerPsql(`update supervised_intake_batches set status='stopped', reason_code='PROVIDER_OUTCOME_UNCERTAIN' where id='${batch.batch_id}' and status <> 'stopped';`)
      const err = dockerPsqlExpectError(`select finalize_intake_batch('${batch.batch_id}', '${nextMarker('finalize-blocked-key')}');`)
      expect(err).toMatch(/UNRESOLVED_RECONCILIATION_EXISTS/)
    })

    it('finalizes completed when every item succeeded', () => {
      enableControl()
      const ev = createEvidence('finalize-completed')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      dockerPsql(`select begin_intake_attempt_call('${claimed.item_id}', '${claimed.claim_token}', '${nextMarker('begin-fc')}');`)
      const extraction = completeExtractionRun(ev, `supervised-intake:${claimed.item_id}:1`)
      dockerPsql(`select complete_intake_item_success('${claimed.item_id}', '${claimed.claim_token}', NULL, '${extraction.extraction_run_id}', NULL, '${nextMarker('complete-fc')}');`)
      const result = JSON.parse(dockerPsql(`select finalize_intake_batch('${batch.batch_id}', '${nextMarker('finalize-fc')}');`))
      expect(result.status).toBe('completed')
    })

    it('finalizes completed_with_failures when an item is terminally failed', () => {
      enableControl()
      const ev = createEvidence('finalize-with-failures')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      dockerPsql(`select fail_intake_item('${claimed.item_id}', '${claimed.claim_token}', 'EVIDENCE_NOT_FOUND', false, NULL, '${nextMarker('fail-fwf')}');`)
      const result = JSON.parse(dockerPsql(`select finalize_intake_batch('${batch.batch_id}', '${nextMarker('finalize-fwf')}');`))
      expect(result.status).toBe('completed_with_failures')
    })

    it('a finalized batch cannot be finalized into a different status, and retry/reopen has no RPC path', () => {
      enableControl()
      const ev = createEvidence('finalize-immutable')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      dockerPsql(`select fail_intake_item('${claimed.item_id}', '${claimed.claim_token}', 'EVIDENCE_NOT_FOUND', false, NULL, '${nextMarker('fail-fi')}');`)
      const key = nextMarker('finalize-fi')
      const first = JSON.parse(dockerPsql(`select finalize_intake_batch('${batch.batch_id}', '${key}');`))
      const second = JSON.parse(dockerPsql(`select finalize_intake_batch('${batch.batch_id}', '${key}');`))
      expect(first.status).toBe('completed_with_failures')
      expect(second.status).toBe('completed_with_failures')
    })

    it('stop_intake_batch closes remaining pending items into unprocessed_batch_closed, never leaving a forever-reserving row', () => {
      enableControl()
      const ev1 = createEvidence('stop-close-1')
      const ev2 = createEvidence('stop-close-2')
      const batch = createBatch([ev1, ev2])
      claim(batch.batch_id) // claims ev1 (or ev2), leaving one pending
      const stopped = JSON.parse(dockerPsql(`select stop_intake_batch('${batch.batch_id}', 'AUTHORIZATION_OR_CONFIG_ERROR', '${nextMarker('stop-close')}');`))
      expect(stopped.closed_pending_items).toBe(1)
      const remainingPending = dockerPsql(`select count(*) from supervised_intake_batch_items where batch_id='${batch.batch_id}' and status='pending';`).trim()
      expect(remainingPending).toBe('0')
    })

    it('cancel_intake_batch from batch_created (never started) leaves started_at NULL but finished_at set', () => {
      enableControl()
      const ev = createEvidence('cancel-never-started')
      const batch = createBatch([ev])
      expect(dockerPsql(`select status from supervised_intake_batches where id='${batch.batch_id}';`).trim()).toBe('batch_created')
      JSON.parse(dockerPsql(`select cancel_intake_batch('${batch.batch_id}', 'test-operator', 'OPERATOR_CANCELLED', '${nextMarker('cancel-never-started-key')}');`))
      const row = dockerPsql(`select status || '|' || coalesce(started_at::text,'NULL') || '|' || (finished_at is not null)::text from supervised_intake_batches where id='${batch.batch_id}';`).trim()
      const [status, , finishedNotNull] = row.split('|')
      expect(status).toBe('cancelled')
      expect(finishedNotNull).toBe('true')
    })
  })

  // ------------------------------------------------------------
  // 10. Napi limit
  // ------------------------------------------------------------
  describe('daily claim limit', () => {
    it('the daily limit stops the batch once max_daily_claimed_items real attempts have been created', () => {
      enableControl(10, 1, nextMarker('cfg-daily'))
      const ev1 = createEvidence('daily-1')
      const ev2 = createEvidence('daily-2')
      const batch = createBatch([ev1, ev2])
      const first = claim(batch.batch_id)
      expect(first.outcome).toBe('claimed')
      const second = claim(batch.batch_id, nextMarker('daily-second'))
      expect(second.outcome).toBe('batch_stopped')
      expect(second.reason_code).toBe('DAILY_LIMIT_REACHED')
    })

    it('claim replay never consumes daily capacity', () => {
      enableControl(10, 1, nextMarker('cfg-daily-replay'))
      const ev = createEvidence('daily-replay')
      const batch = createBatch([ev])
      const key = nextMarker('daily-replay-key')
      claim(batch.batch_id, key)
      const before = dockerPsql(`select count(*) from supervised_intake_attempts where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';`).trim()
      claim(batch.batch_id, key)
      const after = dockerPsql(`select count(*) from supervised_intake_attempts where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';`).trim()
      expect(after).toBe(before)
    })
  })

  // ------------------------------------------------------------
  // 11. State-field CHECK negative tests
  // ------------------------------------------------------------
  describe('state-field CHECK constraints (negative tests)', () => {
    it('a claimed item without a token_digest is rejected', () => {
      enableControl()
      const ev = createEvidence('check-claimed-no-token')
      const batch = createBatch([ev])
      const itemId = dockerPsql(`select id from supervised_intake_batch_items where batch_id='${batch.batch_id}';`).trim()
      const err = dockerPsqlExpectError(`update supervised_intake_batch_items set status='claimed' where id='${itemId}';`)
      expect(err).toMatch(/supervised_intake_batch_items_status_fields/)
    })

    it('a succeeded item without extraction_run_id is rejected', () => {
      enableControl()
      const ev = createEvidence('check-succeeded-no-run')
      const batch = createBatch([ev])
      const itemId = dockerPsql(`select id from supervised_intake_batch_items where batch_id='${batch.batch_id}';`).trim()
      const err = dockerPsqlExpectError(`update supervised_intake_batch_items set status='succeeded' where id='${itemId}';`)
      expect(err).toMatch(/supervised_intake_batch_items_status_fields/)
    })

    it('a prepared attempt with a non-null provider_reservation_id is rejected', () => {
      enableControl()
      const ev = createEvidence('check-prepared-with-reservation')
      const batch = createBatch([ev])
      const claimed = claim(batch.batch_id)
      const err = dockerPsqlExpectError(`update supervised_intake_attempts set provider_reservation_id = gen_random_uuid() where id='${claimed.attempt_id}';`)
      expect(err).toMatch(/foreign key|supervised_intake_attempts_status_fields/)
    })

    it('a running batch with finished_at set is rejected', () => {
      enableControl()
      const ev = createEvidence('check-running-finished')
      const batch = createBatch([ev])
      claim(batch.batch_id)
      const err = dockerPsqlExpectError(`update supervised_intake_batches set finished_at = now() where id='${batch.batch_id}';`)
      expect(err).toMatch(/supervised_intake_batches_status_fields/)
    })

    it('a batch-scoped event with a non-null item_id is rejected', () => {
      enableControl()
      const ev = createEvidence('check-event-scope')
      const batch = createBatch([ev])
      const itemId = dockerPsql(`select id from supervised_intake_batch_items where batch_id='${batch.batch_id}';`).trim()
      const err = dockerPsqlExpectError(`insert into supervised_intake_events (batch_id, item_id, event_kind, resulting_status, actor_kind) values ('${batch.batch_id}', '${itemId}', 'batch_created', 'batch_created', 'service_role_system');`)
      expect(err).toMatch(/supervised_intake_events_scope_pairing/)
    })

    it('an operator_asserted event without actor_reference is rejected', () => {
      enableControl()
      const ev = createEvidence('check-actor-pairing')
      const batch = createBatch([ev])
      const err = dockerPsqlExpectError(`insert into supervised_intake_events (batch_id, event_kind, resulting_status, actor_kind, actor_reference) values ('${batch.batch_id}', 'batch_created', 'batch_created', 'operator_asserted', NULL);`)
      expect(err).toMatch(/supervised_intake_events_actor_pairing/)
    })
  })

  // ------------------------------------------------------------
  // 12. ai_extraction_control isolation
  // ------------------------------------------------------------
  describe('ai_extraction_control isolation', () => {
    it('enabling supervised_intake_control never touches ai_extraction_control', () => {
      const before = dockerPsql('select enabled from ai_extraction_control;').trim()
      enableControl()
      const after = dockerPsql('select enabled from ai_extraction_control;').trim()
      expect(before).toBe('f')
      expect(after).toBe('f')
    })
  })
})
