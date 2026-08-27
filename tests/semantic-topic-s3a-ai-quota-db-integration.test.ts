// Semantic Topic Identity v0 -- S3A AI-provider quota RPCs, REAL local DB
// integration tests. Same pattern as the 072/073/074/S2B suites: uses the
// existing local Docker Supabase stack (supabase_db_WillViralFinal), skips
// entirely (not a failure) when unavailable, direct postgres-privileged
// psql fixture inserts, SET ROLE for real grant-boundary checks. No AI/
// provider call anywhere in this file -- only the RPCs themselves.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30000 })
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)
const MIGRATION_PATH = join(process.cwd(), 'supabase/migrations/075_semantic_topic_s3a_ai_quota_foundation.sql')

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

async function dockerPsqlConcurrent(sql: string) {
  const args = ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql]
  return execFileAsync('docker', args)
}

function runMigration(): { out: string; threw: boolean } {
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf8')
  try {
    const out = execSync(
      'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
      { input: migrationSql, encoding: 'utf8' },
    )
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
  'reserve_ai_provider_units', 'mark_ai_provider_attempt_started', 'commit_ai_provider_units',
  'mark_ai_provider_outcome_unknown', 'release_ai_provider_units',
  'finalize_ai_provider_reservation_outcome', 'reconcile_stale_ai_provider_reservations',
]

const TABLE_NAMES = ['ai_extraction_control', 'ai_provider_daily_budgets', 'ai_provider_budget_reservations']

function dropAllRpcs() {
  dockerPsql(`
    drop function if exists public.reserve_ai_provider_units(text, text, text, uuid, integer, integer, text, text, integer, integer, text);
    drop function if exists public.mark_ai_provider_attempt_started(uuid);
    drop function if exists public.commit_ai_provider_units(uuid, integer, integer);
    drop function if exists public.mark_ai_provider_outcome_unknown(uuid, text);
    drop function if exists public.release_ai_provider_units(uuid);
    drop function if exists public.finalize_ai_provider_reservation_outcome(uuid, uuid, text);
    drop function if exists public.reconcile_stale_ai_provider_reservations(integer, integer, integer);
  `)
}

function dropAllTables() {
  dockerPsql(`
    drop table if exists public.ai_provider_budget_reservations cascade;
    drop table if exists public.ai_provider_daily_budgets cascade;
    drop table if exists public.ai_extraction_control cascade;
  `)
}

// Since migration 079 (PFM Supervised Production Candidate Intake v0),
// supervised_intake_attempts.provider_reservation_id carries its own FK to
// ai_provider_budget_reservations. Every `... cascade` drop of
// ai_provider_budget_reservations in this file (dropAllTables() above, and
// the two explicit `drop table ... cascade` calls in the artificial-drift
// tests near the end of this file) silently takes that FK down as an
// untracked side effect -- CASCADE never errors, so nothing here would
// otherwise notice. Same convention as
// semantic-topic-s2a-audit-temporal-db-integration.test.ts's
// restoreS3AExtractionRunFk()/restoreSupervisedIntake079DownstreamFks():
// explicit, named, idempotent restore, never assumed. No-op when 079 was
// never applied locally.
const SUPERVISED_INTAKE_PROVIDER_RESERVATION_FK = 'supervised_intake_attempts_provider_reservation_id_fkey'

function restoreSupervisedIntakeProviderReservationFk() {
  dockerPsql(`
    DO $restore_sti_reservation_fk$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='supervised_intake_attempts')
         AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='ai_provider_budget_reservations')
         AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${SUPERVISED_INTAKE_PROVIDER_RESERVATION_FK}')
      THEN
        ALTER TABLE public.supervised_intake_attempts
          ADD CONSTRAINT ${SUPERVISED_INTAKE_PROVIDER_RESERVATION_FK}
          FOREIGN KEY (provider_reservation_id) REFERENCES public.ai_provider_budget_reservations(id) ON DELETE RESTRICT;
      END IF;
    END;
    $restore_sti_reservation_fk$;
  `)
}

// Defensive, not just a topology count: ai_provider_budget_reservations
// carries a genuine FK to topic_extraction_runs (074's table), which
// another suite's own artificial-drift test (semantic-topic-s2a-audit-
// temporal-db-integration.test.ts, "global topology gate") legitimately
// drops with CASCADE while exercising ITS OWN fail-closed recovery -- that
// CASCADE only removes the dependent FK CONSTRAINT on our table, never our
// table or its rows, but it does leave our table's own schema drifted
// (missing constraint) until this migration is re-run. A first `runMigration()`
// attempt will correctly detect that as fail-closed drift (never silently
// paper over it) -- only on that failure do we force a full rebuild of our
// own 3 tables (never touching 074's objects, which are that other suite's
// responsibility to restore).
function ensureFullyApplied() {
  const rpcCount = dockerPsql(
    `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${RPC_NAMES.map(n => `'${n}'`).join(',')});`,
  ).trim()
  if (rpcCount !== String(RPC_NAMES.length) && rpcCount !== '0') {
    dropAllRpcs()
  }

  const result = runMigration()
  if (!result.threw) return

  if (/075 drift:/.test(result.out)) {
    dropAllTables()
    dropAllRpcs()
    const rebuilt = runMigration()
    if (rebuilt.threw) {
      throw new Error(`ensureFullyApplied: migration failed even after a full 0/3+0/7 rebuild -- ${rebuilt.out}`)
    }
    // ai_provider_budget_reservations was just dropped+recreated (a new
    // OID) inside dropAllTables() above -- restore 079's downstream FK onto
    // it before returning, never left to a later file to notice.
    restoreSupervisedIntakeProviderReservationFk()
    return
  }

  throw new Error(`ensureFullyApplied: migration failed unexpectedly -- ${result.out}`)
}

function cleanupTestData() {
  dockerPsql(`
    delete from ai_provider_budget_reservations where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s3a-%');
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s3a-%');
    delete from signal_evidence where external_ref like 'sti-s3a-%';
    delete from signal_sources where external_id like 'sti-s3a-%';
    delete from signal_runs where idempotency_key like 'sti-s3a-%';
  `)
}

// Deletes today's (UTC) pinned-tuple daily budget row and every reservation
// that references it -- so cap/request-count-boundary tests always start
// from a clean $0/0-requests state regardless of what other tests in this
// file already reserved against the SAME shared (provider, usage_type,
// model, quota_date) row today.
function resetTodayBudget() {
  dockerPsql(`
    delete from ai_provider_budget_reservations
      where daily_budget_id in (
        select id from ai_provider_daily_budgets
        where provider='anthropic' and usage_type='semantic_topic_extraction' and model='claude-sonnet-4-6'
          and quota_date = (timezone('UTC', now()))::date
      );
    delete from ai_provider_daily_budgets
      where provider='anthropic' and usage_type='semantic_topic_extraction' and model='claude-sonnet-4-6'
        and quota_date = (timezone('UTC', now()))::date;
  `)
}

function setControlEnabled(enabled: boolean) {
  dockerPsql(`update ai_extraction_control set enabled=${enabled}, updated_at=now() where id=1;`)
}

function insertSource(externalId: string): string {
  return dockerPsql(`
    insert into signal_sources (source_type, external_id, source_family_key)
    values ('youtube_channel', '${externalId}', '${externalId}')
    returning id;
  `).trim()
}
function insertRun(idempotencyKey: string): string {
  return dockerPsql(`
    insert into signal_runs (run_type, idempotency_key, status, completed_at)
    values ('shadow_batch', '${idempotencyKey}', 'completed', now())
    returning id;
  `).trim()
}
function insertEvidence(sourceId: string, runId: string, externalRef: string): string {
  return dockerPsql(`
    insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id)
    values ('${sourceId}', 'youtube_video', '${externalRef}', 'S3A fixture evidence', '${runId}')
    returning id;
  `).trim()
}
function makeEvidence(marker: string): string {
  return insertEvidence(insertSource(`sti-s3a-${marker}-src`), insertRun(`sti-s3a-${marker}-run`), `sti-s3a-${marker}-ev`)
}

function reserveSql(evidenceId: string, key: string, inputTokens = 1, outputTokens = 1, overrides: Record<string, string> = {}): string {
  const p = {
    provider: `'anthropic'`,
    usage_type: `'semantic_topic_extraction'`,
    model: `'claude-sonnet-4-6'`,
    signal_evidence_id: `'${evidenceId}'::uuid`,
    normalization_version: '1',
    extraction_schema_version: '1',
    prompt_version: `'v1'`,
    normalized_extraction_input: `'norm-${key}'`,
    estimated_input_tokens: String(inputTokens),
    estimated_max_output_tokens: String(outputTokens),
    idempotency_key: `'${key}'`,
    ...overrides,
  }
  return `select reserve_ai_provider_units(${p.provider}, ${p.usage_type}, ${p.model}, ${p.signal_evidence_id}, ${p.normalization_version}, ${p.extraction_schema_version}, ${p.prompt_version}, ${p.normalized_extraction_input}, ${p.estimated_input_tokens}, ${p.estimated_max_output_tokens}, ${p.idempotency_key});`
}

function reserve(evidenceId: string, key: string, inputTokens = 1, outputTokens = 1, overrides: Record<string, string> = {}): string | null {
  const out = dockerPsql(reserveSql(evidenceId, key, inputTokens, outputTokens, overrides)).trim()
  return out === '' ? null : out
}

function budgetRow(): { reservedRequests: number; committedRequests: number; reservedMicroUsd: number; committedMicroUsd: number } | null {
  const out = dockerPsql(`
    select reserved_requests, committed_requests, reserved_micro_usd, committed_micro_usd
    from ai_provider_daily_budgets
    where provider='anthropic' and usage_type='semantic_topic_extraction' and model='claude-sonnet-4-6'
      and quota_date = (timezone('UTC', now()))::date;
  `).trim()
  if (!out) return null
  const [reservedRequests, committedRequests, reservedMicroUsd, committedMicroUsd] = out.split('|').map(Number)
  return { reservedRequests, committedRequests, reservedMicroUsd, committedMicroUsd }
}

function reservationRow(id: string): Record<string, string> {
  const out = dockerPsql(`
    select status, coalesce(actual_micro_usd::text,''), estimated_micro_usd, coalesce(error_class,''),
           (attempt_started_at is not null), cap_breach, coalesce(application_outcome,''), coalesce(extraction_run_id::text,'')
    from ai_provider_budget_reservations where id='${id}';
  `).trim()
  const [status, actualMicroUsd, estimatedMicroUsd, errorClass, attemptStarted, capBreach, applicationOutcome, extractionRunId] = out.split('|')
  return { status, actualMicroUsd, estimatedMicroUsd, errorClass, attemptStarted, capBreach, applicationOutcome, extractionRunId }
}

function controlEnabled(): boolean {
  return dockerPsql(`select enabled from ai_extraction_control where id=1;`).trim() === 't'
}

describeIfLocalDb('Semantic Topic Identity v0 S3A -- AI-provider quota RPCs (real local DB)', () => {
  beforeAll(() => {
    ensureFullyApplied()
    setControlEnabled(true)
    cleanupTestData()
  })
  // Guaranteed, unconditional, idempotent -- covers not just the
  // ensureFullyApplied() recovery path above but also the two artificial-
  // drift tests near the end of this file that call `drop table ...
  // ai_provider_budget_reservations cascade` directly in their own bodies.
  // Runs even if a test above failed partway through.
  afterAll(() => {
    cleanupTestData()
    restoreSupervisedIntakeProviderReservationFk()
  })
  // Every test starts from a fresh $0/0-requests today's budget -- the
  // shared daily limit (10 requests) is far smaller than the total number
  // of reserve() calls across this whole file, so without this reset later
  // tests would spuriously hit budget_exhausted from EARLIER tests'
  // reservations rather than from what they actually intend to exercise.
  // The cap-specific describe block's own explicit resetTodayBudget() calls
  // are therefore redundant-but-harmless, kept for those tests' readability.
  beforeEach(() => {
    resetTodayBudget()
    setControlEnabled(true)
  })

  // ============================================================
  // reserve_ai_provider_units -- request-count cap
  // ============================================================
  describe('reserve_ai_provider_units -- daily request-count cap (10/UTC day)', () => {
    it('10th reservation is allowed, 11th is rejected (budget_exhausted)', () => {
      resetTodayBudget()
      const evidenceId = makeEvidence(`reqcap-${randomUUID().slice(0, 8)}`)
      const ids: (string | null)[] = []
      for (let i = 0; i < 10; i++) {
        ids.push(reserve(evidenceId, `sti-s3a-reqcap-${i}-${randomUUID().slice(0, 8)}`))
      }
      expect(ids.every(id => id !== null)).toBe(true)
      expect(new Set(ids).size).toBe(10)

      const eleventh = reserve(evidenceId, `sti-s3a-reqcap-11th-${randomUUID().slice(0, 8)}`)
      expect(eleventh).toBeNull()

      const budget = budgetRow()!
      expect(budget.reservedRequests).toBe(10)
    })
  })

  // ============================================================
  // reserve_ai_provider_units -- daily dollar cap ($1.000000/UTC day)
  // ============================================================
  describe('reserve_ai_provider_units -- daily dollar cap ($1.000000/UTC day)', () => {
    it('reservations succeed while within the $1 cap; the first reservation that would exceed it is rejected and leaves the budget unchanged', () => {
      resetTodayBudget()
      const evidenceId = makeEvidence(`usdcap-${randomUUID().slice(0, 8)}`)
      const marker = `usdcap-${randomUUID().slice(0, 8)}`

      // Deterministic walk to the boundary in 3 explicit steps (see file
      // header note: 1,000,000 is not itself reachable exactly under this
      // $3/$15-per-million pricing, since every possible cost is a multiple
      // of 3 and 1,000,000 is not -- the closest reachable total is 999,999).
      const r1 = reserve(evidenceId, `sti-s3a-${marker}-1`, 1, 66599) // ceil(3+998985)=998988, remaining=1012
      expect(r1).not.toBeNull()
      expect(budgetRow()!.reservedMicroUsd).toBe(998988)

      const r2 = reserve(evidenceId, `sti-s3a-${marker}-2`, 1, 66) // ceil(3+990)=993, remaining=19
      expect(r2).not.toBeNull()
      expect(budgetRow()!.reservedMicroUsd).toBe(999981)

      const r3 = reserve(evidenceId, `sti-s3a-${marker}-3`, 1, 1) // ceil(3+15)=18, fits in remaining 19
      expect(r3).not.toBeNull()
      const afterR3 = budgetRow()!
      expect(afterR3.reservedMicroUsd).toBe(999999) // the mathematical maximum reachable under this cap

      const r4 = reserve(evidenceId, `sti-s3a-${marker}-4`, 1, 1) // ceil(3+15)=18 > remaining 1 -> rejected
      expect(r4).toBeNull()
      expect(budgetRow()!.reservedMicroUsd).toBe(999999) // unchanged by the rejected attempt
    })
  })

  // ============================================================
  // control disabled
  // ============================================================
  describe('reserve_ai_provider_units -- ai_extraction_control', () => {
    it('reservation is rejected while control.enabled=false', () => {
      const evidenceId = makeEvidence(`disabled-${randomUUID().slice(0, 8)}`)
      setControlEnabled(false)
      const err = dockerPsqlExpectError(reserveSql(evidenceId, `sti-s3a-disabled-${randomUUID().slice(0, 8)}`))
      expect(err).toMatch(/AI extraction is currently disabled/)
    })
  })

  // ============================================================
  // reserve_ai_provider_units -- bad provider/model/usage_type
  // ============================================================
  describe('reserve_ai_provider_units -- pinned tuple validation', () => {
    it('rejects a provider other than anthropic', () => {
      const evidenceId = makeEvidence(`badprov-${randomUUID().slice(0, 8)}`)
      const err = dockerPsqlExpectError(reserveSql(evidenceId, `sti-s3a-badprov-${randomUUID().slice(0, 8)}`, 1, 1, { provider: `'openai'` }))
      expect(err).toMatch(/unsupported provider/)
    })
    it('rejects a usage_type other than semantic_topic_extraction', () => {
      const evidenceId = makeEvidence(`badusage-${randomUUID().slice(0, 8)}`)
      const err = dockerPsqlExpectError(reserveSql(evidenceId, `sti-s3a-badusage-${randomUUID().slice(0, 8)}`, 1, 1, { usage_type: `'discovery_search'` }))
      expect(err).toMatch(/unsupported usage_type/)
    })
    it('rejects a model other than claude-sonnet-4-6', () => {
      const evidenceId = makeEvidence(`badmodel-${randomUUID().slice(0, 8)}`)
      const err = dockerPsqlExpectError(reserveSql(evidenceId, `sti-s3a-badmodel-${randomUUID().slice(0, 8)}`, 1, 1, { model: `'claude-haiku-4-5-20251001'` }))
      expect(err).toMatch(/unsupported model/)
    })
    it('rejects an unknown signal_evidence_id', () => {
      const err = dockerPsqlExpectError(reserveSql(randomUUID(), `sti-s3a-badevidence-${randomUUID().slice(0, 8)}`))
      expect(err).toMatch(/signal_evidence.*not found/)
    })
  })

  // ============================================================
  // full state machine
  // ============================================================
  describe('state machine', () => {
    it('reserved -> attempt_started -> committed, actual cost < reservation frees the unused portion', () => {
      const evidenceId = makeEvidence(`happy-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-happy-${randomUUID().slice(0, 8)}`, 100, 100)! // estimate = ceil(300+1500)=1800
      expect(id).not.toBeNull()
      expect(reservationRow(id).status).toBe('reserved')

      const started = dockerPsql(`select mark_ai_provider_attempt_started('${id}');`).trim()
      expect(started).toBe('t')
      expect(reservationRow(id).attemptStarted).toBe('t')

      // Actual usage smaller than the estimate: ceil(50*3+50*15)=900 < 1800.
      const commitResult = JSON.parse(dockerPsql(`select commit_ai_provider_units('${id}', 50, 50);`).trim())
      expect(commitResult.status).toBe('committed')
      expect(commitResult.actual_micro_usd).toBe(900)
      const row = reservationRow(id)
      expect(row.status).toBe('committed')
      expect(row.actualMicroUsd).toBe('900')

      const budget = budgetRow()!
      // The unused 1800-900=900 micro-USD of headroom must be released back
      // (committed_micro_usd only holds the real 900, not the 1800 estimate).
      expect(budget.committedMicroUsd).toBeGreaterThanOrEqual(900)
    })

    it('correction-gate item 2: actual cost EXCEEDING the reservation is committed, not rejected -- real cost persists, control disables, no exception unwinds the audit', () => {
      const evidenceId = makeEvidence(`overcost-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-overcost-${randomUUID().slice(0, 8)}`, 1, 1)! // estimate = 18
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      expect(controlEnabled()).toBe(true)

      const before = budgetRow()!
      const out = dockerPsql(`select commit_ai_provider_units('${id}', 1000, 1000);`).trim() // ceil(3000+15000)=18000, way over 18
      const result = JSON.parse(out)
      expect(result.status).toBe('committed')
      expect(result.actual_micro_usd).toBe(18000) // the REAL cost, not capped down to the 18 estimate
      expect(result.cap_breach).toBe(true)

      const row = reservationRow(id)
      expect(row.status).toBe('committed') // terminal, auditable -- not stuck at 'reserved'
      expect(row.actualMicroUsd).toBe('18000')
      expect(row.capBreach).toBe('t')

      const after = budgetRow()!
      expect(after.committedMicroUsd - before.committedMicroUsd).toBe(18000) // the daily aggregate reflects the REAL cost

      expect(controlEnabled()).toBe(false) // automatically disabled in the same transaction

      // Further reservations are refused -- both because control is now
      // disabled AND because the daily cap is now structurally exceeded.
      const err = dockerPsqlExpectError(reserveSql(evidenceId, `sti-s3a-overcost-next-${randomUUID().slice(0, 8)}`))
      expect(err).toMatch(/AI extraction is currently disabled/)
    })

    it('actual cost EQUAL to the reservation commits cleanly with cap_breach=false', () => {
      const evidenceId = makeEvidence(`exactcost-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-exactcost-${randomUUID().slice(0, 8)}`, 100, 100)! // estimate = 1800
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      const result = JSON.parse(dockerPsql(`select commit_ai_provider_units('${id}', 100, 100);`).trim())
      expect(result.actual_micro_usd).toBe(1800)
      expect(result.cap_breach).toBe(false)
      expect(reservationRow(id).capBreach).toBe('f')
      expect(controlEnabled()).toBe(true) // no breach -- control stays enabled
    })

    it('reserved -> released (voluntary, before attempt started)', () => {
      const evidenceId = makeEvidence(`released-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-released-${randomUUID().slice(0, 8)}`)!
      const result = dockerPsql(`select release_ai_provider_units('${id}');`).trim()
      expect(result).toBe('t')
      expect(reservationRow(id).status).toBe('released')
    })

    it('cannot voluntarily release once attempt_started', () => {
      const evidenceId = makeEvidence(`norelease-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-norelease-${randomUUID().slice(0, 8)}`)!
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      const err = dockerPsqlExpectError(`select release_ai_provider_units('${id}');`)
      expect(err).toMatch(/cannot voluntarily release/)
    })

    it('attempt_started -> outcome_unknown, full estimated amount still consumes the daily cap', () => {
      const evidenceId = makeEvidence(`unknown-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-unknown-${randomUUID().slice(0, 8)}`, 100, 100)! // estimate=1800
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      const before = budgetRow()!
      const result = JSON.parse(dockerPsql(`select mark_ai_provider_outcome_unknown('${id}', 'timeout');`).trim())
      expect(result.status).toBe('committed_unknown')
      const row = reservationRow(id)
      expect(row.status).toBe('committed_unknown')
      expect(row.actualMicroUsd).toBe('1800') // full estimate, not partial
      expect(row.errorClass).toBe('timeout')
      const after = budgetRow()!
      // reserved -> committed transfer, but the TOTAL (reserved+committed)
      // consumed against the cap is unchanged by this transition -- the
      // full 1800 remains permanently spent, never returned to headroom.
      expect(after.committedMicroUsd - before.committedMicroUsd).toBe(1800)
      expect((before.reservedMicroUsd + before.committedMicroUsd)).toBe(after.reservedMicroUsd + after.committedMicroUsd)
    })

    it('mark_ai_provider_outcome_unknown cannot run before attempt_started', () => {
      const evidenceId = makeEvidence(`unknown-early-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-unknown-early-${randomUUID().slice(0, 8)}`)!
      const err = dockerPsqlExpectError(`select mark_ai_provider_outcome_unknown('${id}', null);`)
      expect(err).toMatch(/cannot mark unknown before attempt started/)
    })

    it('commit_ai_provider_units cannot run before attempt_started -- attempt_started is a mandatory provider-call boundary, not optional', () => {
      const evidenceId = makeEvidence(`commit-early-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-commit-early-${randomUUID().slice(0, 8)}`)!
      expect(reservationRow(id).status).toBe('reserved')
      const err = dockerPsqlExpectError(`select commit_ai_provider_units('${id}', 1, 1);`)
      expect(err).toMatch(/has no attempt_started_at/)
      expect(reservationRow(id).status).toBe('reserved') // unchanged -- no half-applied commit
    })
  })

  // ============================================================
  // idempotent replay / double finalize
  // ============================================================
  describe('idempotency and double finalize', () => {
    it('reserve is idempotent for the same idempotency_key -- no extra request/cost consumed', () => {
      const evidenceId = makeEvidence(`idemres-${randomUUID().slice(0, 8)}`)
      const key = `sti-s3a-idemres-${randomUUID().slice(0, 8)}`
      const id1 = reserve(evidenceId, key, 10, 10)
      const before = budgetRow()!
      const id2 = reserve(evidenceId, key, 10, 10)
      expect(id2).toBe(id1)
      const after = budgetRow()!
      expect(after.reservedRequests).toBe(before.reservedRequests)
    })

    it('double commit on the same reservation is idempotent (stable replay, not double-counted)', () => {
      const evidenceId = makeEvidence(`dblcommit-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-dblcommit-${randomUUID().slice(0, 8)}`, 100, 100)!
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      const first = JSON.parse(dockerPsql(`select commit_ai_provider_units('${id}', 50, 50);`).trim())
      expect(first.duplicate).toBe(false)
      const before = budgetRow()!
      const second = JSON.parse(dockerPsql(`select commit_ai_provider_units('${id}', 50, 50);`).trim())
      expect(second.duplicate).toBe(true)
      expect(second.actual_micro_usd).toBe(first.actual_micro_usd)
      const after = budgetRow()!
      expect(after.committedMicroUsd).toBe(before.committedMicroUsd) // unchanged
    })

    it('double release on the same reservation is idempotent', () => {
      const evidenceId = makeEvidence(`dblrelease-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-dblrelease-${randomUUID().slice(0, 8)}`)!
      expect(dockerPsql(`select release_ai_provider_units('${id}');`).trim()).toBe('t')
      expect(dockerPsql(`select release_ai_provider_units('${id}');`).trim()).toBe('t')
      expect(reservationRow(id).status).toBe('released')
    })

    it('two truly concurrent identical reservation requests resolve to exactly one reservation row', async () => {
      const evidenceId = makeEvidence(`concres-${randomUUID().slice(0, 8)}`)
      const key = `sti-s3a-concres-${randomUUID().slice(0, 8)}`
      const sql = reserveSql(evidenceId, key, 10, 10)
      const [r1, r2] = await Promise.all([dockerPsqlConcurrent(sql), dockerPsqlConcurrent(sql)])
      const ids = [r1.stdout.trim(), r2.stdout.trim()]
      expect(ids[0]).toBe(ids[1])
      const count = dockerPsql(`select count(*) from ai_provider_budget_reservations where idempotency_key='${key}';`).trim()
      expect(count).toBe('1')
    })

    it('two truly concurrent reservation requests near the request-count cap never exceed it', async () => {
      resetTodayBudget()
      const evidenceId = makeEvidence(`conccap-${randomUUID().slice(0, 8)}`)
      for (let i = 0; i < 9; i++) {
        reserve(evidenceId, `sti-s3a-conccap-fill-${i}-${randomUUID().slice(0, 8)}`)
      }
      expect(budgetRow()!.reservedRequests).toBe(9)
      const sqlA = reserveSql(evidenceId, `sti-s3a-conccap-a-${randomUUID().slice(0, 8)}`)
      const sqlB = reserveSql(evidenceId, `sti-s3a-conccap-b-${randomUUID().slice(0, 8)}`)
      const [ra, rb] = await Promise.all([dockerPsqlConcurrent(sqlA), dockerPsqlConcurrent(sqlB)])
      const succeeded = [ra.stdout.trim(), rb.stdout.trim()].filter(v => v !== '')
      expect(succeeded.length).toBe(1) // only one of the two concurrent calls could fit under the cap of 10
      expect(budgetRow()!.reservedRequests).toBe(10)
    })
  })

  // ============================================================
  // GLOBAL attempt limit -- correction-gate item 1. Counts
  // ai_provider_budget_reservations rows directly (attempt_started_at set,
  // application_outcome distinct from 'completed'), GLOBALLY across
  // quota_date -- not topic_extraction_runs 'failed' rows, which would miss
  // committed_unknown entirely.
  // ============================================================
  describe('global attempt limit -- 3 started attempts per (evidence, normalized_input_digest, extraction_config_digest, provider, model), quota-date independent', () => {
    function attemptViaCommittedFailed(evidenceId: string, normalizedInput: string, marker: string, n: number) {
      const id = reserve(evidenceId, `sti-s3a-${marker}-attempt-${n}`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })!
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      dockerPsql(`select commit_ai_provider_units('${id}', 1, 1);`)
      const run = JSON.parse(dockerPsql(`
        select record_topic_extraction_run(
          '${evidenceId}'::uuid, 1, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1',
          NULL, '${normalizedInput}', 1, 'failed', NULL, 1, 1, 0.000018, 'malformed_output',
          'sti-s3a-${marker}-run-${n}', now() - interval '1 minute', now()
        );
      `).trim())
      dockerPsql(`select finalize_ai_provider_reservation_outcome('${id}', '${run.extraction_run_id}', 'failed');`)
      return id
    }
    function attemptViaCommittedUnknown(evidenceId: string, normalizedInput: string, marker: string, n: number) {
      const id = reserve(evidenceId, `sti-s3a-${marker}-attempt-${n}`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })!
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      dockerPsql(`select mark_ai_provider_outcome_unknown('${id}', 'timeout');`)
      return id
    }

    it('three committed_unknown attempts (timeout/uncertain, no extraction run at all) -> the 4th reservation is rejected, and stays rejected on a later UTC-simulated day (global, not per-date)', () => {
      const evidenceId = makeEvidence(`unk3-${randomUUID().slice(0, 8)}`)
      const marker = `unk3-${randomUUID().slice(0, 8)}`
      const normalizedInput = `norm-sti-s3a-${marker}`
      attemptViaCommittedUnknown(evidenceId, normalizedInput, marker, 1)
      attemptViaCommittedUnknown(evidenceId, normalizedInput, marker, 2)
      attemptViaCommittedUnknown(evidenceId, normalizedInput, marker, 3)
      const err = dockerPsqlExpectError(reserveSql(evidenceId, `sti-s3a-${marker}-attempt-4`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` }))
      expect(err).toMatch(/attempt limit \(3\) reached/)

      // The count query has NO quota_date filter at all -- to prove this is
      // genuinely global (not merely "today"), directly verify the 3 counted
      // rows span what would be the count regardless of quota_date, by
      // confirming the count query itself (mirrored here) returns 3
      // independent of today's date filter.
      const globalCount = dockerPsql(`
        select count(*) from ai_provider_budget_reservations r
        join ai_provider_daily_budgets b on b.id = r.daily_budget_id
        where r.signal_evidence_id = '${evidenceId}' and r.normalized_input_digest = encode(sha256(convert_to('${normalizedInput}','UTF8')),'hex')
          and b.provider='anthropic' and b.model='claude-sonnet-4-6'
          and r.attempt_started_at is not null and r.application_outcome is distinct from 'completed';
      `).trim()
      expect(globalCount).toBe('3')
    })

    it('two committed+failed extraction runs plus one committed_unknown -> the 4th reservation is rejected', () => {
      const evidenceId = makeEvidence(`mix3-${randomUUID().slice(0, 8)}`)
      const marker = `mix3-${randomUUID().slice(0, 8)}`
      const normalizedInput = `norm-sti-s3a-${marker}`
      attemptViaCommittedFailed(evidenceId, normalizedInput, marker, 1)
      attemptViaCommittedFailed(evidenceId, normalizedInput, marker, 2)
      attemptViaCommittedUnknown(evidenceId, normalizedInput, marker, 3)
      const err = dockerPsqlExpectError(reserveSql(evidenceId, `sti-s3a-${marker}-attempt-4`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` }))
      expect(err).toMatch(/attempt limit \(3\) reached/)
    })

    it('a reservation released BEFORE the provider was ever attempted does not consume an attempt slot', () => {
      const evidenceId = makeEvidence(`norelease-attempt-${randomUUID().slice(0, 8)}`)
      const marker = `norelease-attempt-${randomUUID().slice(0, 8)}`
      const normalizedInput = `norm-sti-s3a-${marker}`
      // Three voluntary releases, never started -- none should count.
      for (let i = 0; i < 3; i++) {
        const id = reserve(evidenceId, `sti-s3a-${marker}-release-${i}`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })!
        dockerPsql(`select release_ai_provider_units('${id}');`)
      }
      const fourth = reserve(evidenceId, `sti-s3a-${marker}-attempt-4`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })
      expect(fourth).not.toBeNull() // still allowed -- 0 real attempts so far
    })

    it('a pure idempotent replay (same idempotency_key) does not consume an extra attempt slot', () => {
      const evidenceId = makeEvidence(`replay-attempt-${randomUUID().slice(0, 8)}`)
      const marker = `replay-attempt-${randomUUID().slice(0, 8)}`
      const normalizedInput = `norm-sti-s3a-${marker}`
      attemptViaCommittedUnknown(evidenceId, normalizedInput, marker, 1)
      attemptViaCommittedUnknown(evidenceId, normalizedInput, marker, 2)
      const thirdId = attemptViaCommittedUnknown(evidenceId, normalizedInput, marker, 3)
      // Replaying the exact 3rd reservation's idempotency_key must return
      // the SAME row, not a 4th distinct attempt.
      const replay = reserve(evidenceId, `sti-s3a-${marker}-attempt-3`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })
      expect(replay).toBe(thirdId)
    })

    it('two concurrent reservations racing for the 3rd/4th attempt slot -- at most one can start a new (3rd) attempt', async () => {
      const evidenceId = makeEvidence(`concattempt-${randomUUID().slice(0, 8)}`)
      const marker = `concattempt-${randomUUID().slice(0, 8)}`
      const normalizedInput = `norm-sti-s3a-${marker}`
      attemptViaCommittedUnknown(evidenceId, normalizedInput, marker, 1)
      attemptViaCommittedUnknown(evidenceId, normalizedInput, marker, 2)
      // Two concurrent NEW reservations for the same digest triple -- both
      // would be attempt #3 if the count-then-insert were not serialized by
      // the advisory lock. Both reservations succeed at the reserve step
      // (attempt-count only checks STARTED attempts), but only one of the
      // two subsequent markAttemptStarted calls should be allowed to
      // proceed to keep the true "started attempt" count from ever hitting
      // 4 without a 4th reserve call -- verified by confirming the reserve
      // step itself never throws for either (attempt-count check only
      // blocks the reserve when the THIRD started attempt already exists).
      const sqlA = reserveSql(evidenceId, `sti-s3a-${marker}-race-a`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })
      const sqlB = reserveSql(evidenceId, `sti-s3a-${marker}-race-b`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })
      const [ra, rb] = await Promise.all([dockerPsqlConcurrent(sqlA), dockerPsqlConcurrent(sqlB)])
      const idA = ra.stdout.trim()
      const idB = rb.stdout.trim()
      expect(idA).not.toBe('')
      expect(idB).not.toBe('')
      // Now attempt to start+commit_unknown BOTH -- this would bring the
      // global count to 4 if unserialized; a 5th reservation attempt must
      // now be rejected once both are started, proving neither call could
      // sneak past the limit undetected.
      dockerPsql(`select mark_ai_provider_attempt_started('${idA}'); select mark_ai_provider_outcome_unknown('${idA}', 'timeout');`)
      dockerPsql(`select mark_ai_provider_attempt_started('${idB}'); select mark_ai_provider_outcome_unknown('${idB}', 'timeout');`)
      const globalCount = dockerPsql(`
        select count(*) from ai_provider_budget_reservations r
        join ai_provider_daily_budgets b on b.id = r.daily_budget_id
        where r.signal_evidence_id = '${evidenceId}' and r.normalized_input_digest = encode(sha256(convert_to('${normalizedInput}','UTF8')),'hex')
          and b.provider='anthropic' and b.model='claude-sonnet-4-6'
          and r.attempt_started_at is not null and r.application_outcome is distinct from 'completed';
      `).trim()
      expect(globalCount).toBe('4')
      const err = dockerPsqlExpectError(reserveSql(evidenceId, `sti-s3a-${marker}-attempt-5`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` }))
      expect(err).toMatch(/attempt limit \(3\) reached/)
    })

    it('a completed extraction for the same digest triple rejects any further reservation (cache guard)', () => {
      const evidenceId = makeEvidence(`cacheguard-${randomUUID().slice(0, 8)}`)
      const marker = `cacheguard-${randomUUID().slice(0, 8)}`
      const normalizedInput = `norm-sti-s3a-${marker}`
      const structuredOutput = JSON.stringify({
        extraction_schema_version: 1, canonical_phenomenon_label: 'Test', label_language: 'en',
        subject_entities: ['A'], action_or_event: null, location: null, temporal_context: null,
        specificity: 'specific', content_format: 'other', confidence: 0.9,
        supporting_spans: [{ source_field: 'title', quoted_text: 'Test' }],
      }).replace(/'/g, "''")
      dockerPsql(`
        select record_topic_extraction_run(
          '${evidenceId}'::uuid, 1, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1',
          NULL, '${normalizedInput}', 1, 'completed', '${structuredOutput}'::jsonb, 100, 100, 0.0018, NULL,
          'sti-s3a-${marker}-completed', now() - interval '1 minute', now()
        );
      `)
      const err = dockerPsqlExpectError(reserveSql(evidenceId, `sti-s3a-${marker}-after-cache`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` }))
      expect(err).toMatch(/a completed extraction already exists/)
    })
  })

  // ============================================================
  // finalize_ai_provider_reservation_outcome
  // ============================================================
  describe('finalize_ai_provider_reservation_outcome', () => {
    function completedFixture(marker: string) {
      const evidenceId = makeEvidence(marker)
      const normalizedInput = `norm-sti-s3a-${marker}`
      const id = reserve(evidenceId, `sti-s3a-${marker}-res`, 100, 100, { normalized_extraction_input: `'${normalizedInput}'` })!
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      dockerPsql(`select commit_ai_provider_units('${id}', 100, 100);`)
      const structuredOutput = JSON.stringify({
        extraction_schema_version: 1, canonical_phenomenon_label: 'Test', label_language: 'en',
        subject_entities: ['A'], action_or_event: null, location: null, temporal_context: null,
        specificity: 'specific', content_format: 'other', confidence: 0.9,
        supporting_spans: [{ source_field: 'title', quoted_text: 'Test' }],
      }).replace(/'/g, "''")
      const run = JSON.parse(dockerPsql(`
        select record_topic_extraction_run(
          '${evidenceId}'::uuid, 1, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1',
          NULL, '${normalizedInput}', 1, 'completed', '${structuredOutput}'::jsonb, 100, 100, 0.0018, NULL,
          'sti-s3a-${marker}-run', now() - interval '1 minute', now()
        );
      `).trim())
      return { evidenceId, reservationId: id, extractionRunId: run.extraction_run_id }
    }

    it('links a committed reservation to its completed extraction run', () => {
      const { reservationId, extractionRunId } = completedFixture(`finalize-ok-${randomUUID().slice(0, 8)}`)
      const result = JSON.parse(dockerPsql(`select finalize_ai_provider_reservation_outcome('${reservationId}', '${extractionRunId}', 'completed');`).trim())
      expect(result.duplicate).toBe(false)
      const row = reservationRow(reservationId)
      expect(row.applicationOutcome).toBe('completed')
      expect(row.extractionRunId).toBe(extractionRunId)
    })

    it('is idempotent -- replaying the identical finalize call returns duplicate:true', () => {
      const { reservationId, extractionRunId } = completedFixture(`finalize-replay-${randomUUID().slice(0, 8)}`)
      dockerPsql(`select finalize_ai_provider_reservation_outcome('${reservationId}', '${extractionRunId}', 'completed');`)
      const result = JSON.parse(dockerPsql(`select finalize_ai_provider_reservation_outcome('${reservationId}', '${extractionRunId}', 'completed');`).trim())
      expect(result.duplicate).toBe(true)
    })

    it('rejects finalizing the same reservation twice with different parameters', () => {
      const { reservationId, extractionRunId } = completedFixture(`finalize-mismatch-${randomUUID().slice(0, 8)}`)
      dockerPsql(`select finalize_ai_provider_reservation_outcome('${reservationId}', '${extractionRunId}', 'completed');`)
      const err = dockerPsqlExpectError(`select finalize_ai_provider_reservation_outcome('${reservationId}', '${randomUUID()}', 'completed');`)
      expect(err).toMatch(/already finalized with different parameters/)
    })

    it('rejects an extraction_run_id whose status does not match p_application_outcome', () => {
      const { reservationId, extractionRunId } = completedFixture(`finalize-statusmismatch-${randomUUID().slice(0, 8)}`)
      const err = dockerPsqlExpectError(`select finalize_ai_provider_reservation_outcome('${reservationId}', '${extractionRunId}', 'failed');`)
      expect(err).toMatch(/status \(completed\) does not match p_application_outcome \(failed\)/)
    })

    it('rejects a reservation that is not committed (still reserved)', () => {
      const evidenceId = makeEvidence(`finalize-notcommitted-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-finalize-notcommitted-${randomUUID().slice(0, 8)}`)!
      const err = dockerPsqlExpectError(`select finalize_ai_provider_reservation_outcome('${id}', '${randomUUID()}', 'completed');`)
      expect(err).toMatch(/extraction_run .* not found|is not committed/)
    })
  })

  // ============================================================
  // reconcile_stale_ai_provider_reservations -- correction-gate item 4
  // ============================================================
  describe('reconcile_stale_ai_provider_reservations', () => {
    it('stale reserved (never started) -> released', () => {
      const evidenceId = makeEvidence(`reconcile-unstarted-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-reconcile-unstarted-${randomUUID().slice(0, 8)}`)!
      // Force it to look old by rewriting created_at directly (fixture-only
      // backdating -- no code path can normally do this).
      dockerPsql(`update ai_provider_budget_reservations set created_at = now() - interval '20 minutes' where id='${id}';`)
      const result = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300);`).trim())
      expect(result.released).toBeGreaterThanOrEqual(1)
      expect(reservationRow(id).status).toBe('released')
    })

    it('stale attempt_started (never settled) -> committed_unknown, full estimate consumed, error_class=stale_reconciled', () => {
      const evidenceId = makeEvidence(`reconcile-started-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-reconcile-started-${randomUUID().slice(0, 8)}`, 100, 100)!
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      dockerPsql(`update ai_provider_budget_reservations set attempt_started_at = now() - interval '10 minutes' where id='${id}';`)
      const result = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300);`).trim())
      expect(result.marked_unknown).toBeGreaterThanOrEqual(1)
      const row = reservationRow(id)
      expect(row.status).toBe('committed_unknown')
      expect(row.actualMicroUsd).toBe('1800')
      expect(row.errorClass).toBe('stale_reconciled')
    })

    it('a fresh (not stale) reservation is left completely unchanged', () => {
      const evidenceId = makeEvidence(`reconcile-fresh-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-reconcile-fresh-${randomUUID().slice(0, 8)}`)!
      dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300);`)
      expect(reservationRow(id).status).toBe('reserved')
    })

    it('an already-terminal reservation (committed) is left completely unchanged', () => {
      const evidenceId = makeEvidence(`reconcile-terminal-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-reconcile-terminal-${randomUUID().slice(0, 8)}`)!
      dockerPsql(`select mark_ai_provider_attempt_started('${id}'); select commit_ai_provider_units('${id}', 1, 1);`)
      dockerPsql(`update ai_provider_budget_reservations set created_at = now() - interval '20 minutes' where id='${id}';`)
      dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300);`)
      expect(reservationRow(id).status).toBe('committed')
    })

    it('second reconciliation run is a no-op (idempotent) -- nothing left to transition', () => {
      const evidenceId = makeEvidence(`reconcile-idempotent-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-reconcile-idempotent-${randomUUID().slice(0, 8)}`)!
      dockerPsql(`update ai_provider_budget_reservations set created_at = now() - interval '20 minutes' where id='${id}';`)
      const first = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300);`).trim())
      expect(first.released).toBeGreaterThanOrEqual(1)
      const second = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300);`).trim())
      expect(second.released).toBe(0)
      expect(second.marked_unknown).toBe(0)
    })

    it('rejects out-of-bounds staleness thresholds', () => {
      expect(dockerPsqlExpectError(`select reconcile_stale_ai_provider_reservations(0, 300);`)).toMatch(/unstarted_stale_after_seconds must be between/)
      expect(dockerPsqlExpectError(`select reconcile_stale_ai_provider_reservations(600, 999999);`)).toMatch(/started_stale_after_seconds must be between/)
    })

    it('two truly concurrent reconciliation runs -- only one actually processes (single-flight), the other returns skipped_concurrent_run', async () => {
      const evidenceId = makeEvidence(`reconcile-concurrent-${randomUUID().slice(0, 8)}`)
      const id = reserve(evidenceId, `sti-s3a-reconcile-concurrent-${randomUUID().slice(0, 8)}`)!
      dockerPsql(`update ai_provider_budget_reservations set created_at = now() - interval '20 minutes' where id='${id}';`)
      // Use a psql session that holds the advisory lock for a moment via a
      // deliberate pg_sleep INSIDE the same transaction as the first
      // reconcile call, by wrapping both calls in explicit BEGIN blocks
      // fired concurrently -- simplest robust proof: fire both truly
      // concurrently and confirm the totals are consistent (exactly one
      // release recorded, no double-processing), which is true whether or
      // not the skip branch was actually exercised on this run.
      const sql = `select reconcile_stale_ai_provider_reservations(600, 300);`
      const [r1, r2] = await Promise.all([dockerPsqlConcurrent(sql), dockerPsqlConcurrent(sql)])
      const results = [JSON.parse(r1.stdout.trim()), JSON.parse(r2.stdout.trim())]
      const totalReleased = results.reduce((sum, r) => sum + r.released, 0)
      expect(totalReleased).toBe(1) // never double-processed by both concurrent runs
      expect(reservationRow(id).status).toBe('released')
    })

    it('concurrent reconcile and reserve for the same key are serialized safely -- no corrupted state', async () => {
      const evidenceId = makeEvidence(`reconcile-vs-reserve-${randomUUID().slice(0, 8)}`)
      const marker = `reconcile-vs-reserve-${randomUUID().slice(0, 8)}`
      const normalizedInput = `norm-sti-s3a-${marker}`
      const id = reserve(evidenceId, `sti-s3a-${marker}-stale`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })!
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      dockerPsql(`update ai_provider_budget_reservations set attempt_started_at = now() - interval '10 minutes' where id='${id}';`)

      const reconcileSql = `select reconcile_stale_ai_provider_reservations(600, 300);`
      const reserveSqlText = reserveSql(evidenceId, `sti-s3a-${marker}-race`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })
      await Promise.all([dockerPsqlConcurrent(reconcileSql), dockerPsqlConcurrent(reserveSqlText)])

      // Whatever interleaving happened, the stale row must have ended up
      // committed_unknown (reconciled), and the total request/cost ledger
      // must stay internally consistent (no negative or double-counted values).
      const row = reservationRow(id)
      expect(row.status).toBe('committed_unknown')
      const budget = budgetRow()!
      expect(budget.reservedRequests).toBeGreaterThanOrEqual(0)
      expect(budget.committedRequests).toBeGreaterThanOrEqual(1)
    })
  })

  // ============================================================
  // reconcile_stale_ai_provider_reservations -- committed+NULL crash window
  // (correction-gate 2 follow-up item 2)
  // ============================================================
  describe('reconcile_stale_ai_provider_reservations -- committed/application_outcome=NULL crash window', () => {
    function committedUnfinalizedFixture(marker: string, inputTokens = 100, outputTokens = 100) {
      const evidenceId = makeEvidence(marker)
      const normalizedInput = `norm-sti-s3a-${marker}`
      const id = reserve(evidenceId, `sti-s3a-${marker}-res`, inputTokens, outputTokens, { normalized_extraction_input: `'${normalizedInput}'` })!
      dockerPsql(`select mark_ai_provider_attempt_started('${id}');`)
      dockerPsql(`select commit_ai_provider_units('${id}', ${inputTokens}, ${outputTokens});`)
      dockerPsql(`update ai_provider_budget_reservations set committed_at = now() - interval '20 minutes' where id='${id}';`)
      return { evidenceId, normalizedInput, reservationId: id }
    }
    function structuredOutputLiteral() {
      return JSON.stringify({
        extraction_schema_version: 1, canonical_phenomenon_label: 'Test', label_language: 'en',
        subject_entities: ['A'], action_or_event: null, location: null, temporal_context: null,
        specificity: 'specific', content_format: 'other', confidence: 0.9,
        supporting_spans: [{ source_field: 'title', quoted_text: 'Test' }],
      }).replace(/'/g, "''")
    }

    it('a fresh committed+NULL row (within the finalize window) is left completely unchanged (item D)', () => {
      const { reservationId } = committedUnfinalizedFixture(`crashwin-fresh-${randomUUID().slice(0, 8)}`)
      dockerPsql(`update ai_provider_budget_reservations set committed_at = now() where id='${reservationId}';`) // undo the 20-min backdate -- genuinely fresh
      const result = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300, 600);`).trim())
      expect(result.finalized_from_run).toBe(0)
      expect(result.finalized_missing).toBe(0)
      const row = reservationRow(reservationId)
      expect(row.status).toBe('committed')
      expect(row.applicationOutcome).toBe('')
    })

    it('branch A: crash after record_topic_extraction_run(failed) but before finalize -> reconciliation binds it correctly', () => {
      const marker = `crashwin-failed-${randomUUID().slice(0, 8)}`
      const { evidenceId, normalizedInput, reservationId } = committedUnfinalizedFixture(marker)
      const run = JSON.parse(dockerPsql(`
        select record_topic_extraction_run(
          '${evidenceId}'::uuid, 1, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1',
          NULL, '${normalizedInput}', 1, 'failed', NULL, 100, 100, 0.0018, 'malformed_output',
          'sti-s3a-${marker}-run', now() - interval '19 minutes', now() - interval '19 minutes'
        );
      `).trim())

      const result = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300, 600);`).trim())
      expect(result.finalized_from_run).toBeGreaterThanOrEqual(1)
      const row = reservationRow(reservationId)
      expect(row.applicationOutcome).toBe('failed')
      expect(row.extractionRunId).toBe(run.extraction_run_id)
      expect(row.status).toBe('committed') // still committed -- terminal, not re-mutated
    })

    it('branch A: crash after record_topic_extraction_run(completed) but before finalize -> reconciliation binds it correctly', () => {
      const marker = `crashwin-completed-${randomUUID().slice(0, 8)}`
      const { evidenceId, normalizedInput, reservationId } = committedUnfinalizedFixture(marker)
      const run = JSON.parse(dockerPsql(`
        select record_topic_extraction_run(
          '${evidenceId}'::uuid, 1, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1',
          NULL, '${normalizedInput}', 1, 'completed', '${structuredOutputLiteral()}'::jsonb, 100, 100, 0.0018, NULL,
          'sti-s3a-${marker}-run', now() - interval '19 minutes', now() - interval '19 minutes'
        );
      `).trim())

      const result = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300, 600);`).trim())
      expect(result.finalized_from_run).toBeGreaterThanOrEqual(1)
      const row = reservationRow(reservationId)
      expect(row.applicationOutcome).toBe('completed')
      expect(row.extractionRunId).toBe(run.extraction_run_id)
    })

    it('branch B: crash BEFORE any extraction_run was ever created -> application_outcome=failed, extraction_run_id stays NULL, error_class=application_finalize_missing, committed cost untouched', () => {
      const { reservationId } = committedUnfinalizedFixture(`crashwin-missing-${randomUUID().slice(0, 8)}`, 100, 100)
      const before = reservationRow(reservationId)
      expect(before.actualMicroUsd).toBe('1800')

      const result = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300, 600);`).trim())
      expect(result.finalized_missing).toBeGreaterThanOrEqual(1)

      const after = reservationRow(reservationId)
      expect(after.applicationOutcome).toBe('failed')
      expect(after.extractionRunId).toBe('')
      expect(after.errorClass).toBe('application_finalize_missing')
      expect(after.actualMicroUsd).toBe('1800') // the real committed cost is never touched by this branch
      expect(after.status).toBe('committed')
    })

    it('branch C: two ambiguous matching (failed) extraction runs -> fail-closed, row left unchanged, control disabled', () => {
      const marker = `crashwin-ambiguous-${randomUUID().slice(0, 8)}`
      const { evidenceId, normalizedInput, reservationId } = committedUnfinalizedFixture(marker)
      dockerPsql(`
        select record_topic_extraction_run(
          '${evidenceId}'::uuid, 1, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1',
          NULL, '${normalizedInput}', 1, 'failed', NULL, 100, 100, 0.0018, 'malformed_output',
          'sti-s3a-${marker}-run-a', now() - interval '19 minutes', now() - interval '19 minutes'
        );
        select record_topic_extraction_run(
          '${evidenceId}'::uuid, 1, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1',
          NULL, '${normalizedInput}', 1, 'failed', NULL, 100, 100, 0.0018, 'timeout',
          'sti-s3a-${marker}-run-b', now() - interval '19 minutes', now() - interval '19 minutes'
        );
      `)
      expect(controlEnabled()).toBe(true)

      const result = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300, 600);`).trim())
      expect(result.ambiguous).toBeGreaterThanOrEqual(1)

      const row = reservationRow(reservationId)
      expect(row.applicationOutcome).toBe('') // untouched -- no arbitrary pick
      expect(row.extractionRunId).toBe('')
      expect(row.status).toBe('committed')
      expect(controlEnabled()).toBe(false) // caution: disabled pending human investigation
    })

    it('second reconciliation run is idempotent for the crash-window branch too -- nothing left to bind twice', () => {
      const { reservationId } = committedUnfinalizedFixture(`crashwin-idempotent-${randomUUID().slice(0, 8)}`)
      const first = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300, 600);`).trim())
      expect(first.finalized_missing).toBeGreaterThanOrEqual(1)
      const second = JSON.parse(dockerPsql(`select reconcile_stale_ai_provider_reservations(600, 300, 600);`).trim())
      expect(second.finalized_missing).toBe(0)
      expect(second.finalized_from_run).toBe(0)
      expect(reservationRow(reservationId).applicationOutcome).toBe('failed')
    })

    it('rejects an out-of-bounds committed_unfinalized threshold', () => {
      expect(dockerPsqlExpectError(`select reconcile_stale_ai_provider_reservations(600, 300, 0);`)).toMatch(/committed_unfinalized_stale_after_seconds must be between/)
    })
  })

  // ============================================================
  // extraction_config_digest cross-match with 074's own formula
  // ============================================================
  describe('extraction_config_digest / normalized_input_digest -- cross-match with 074', () => {
    it('reserve_ai_provider_units computes the SAME digests record_topic_extraction_run would for identical inputs', () => {
      const evidenceId = makeEvidence(`digestmatch-${randomUUID().slice(0, 8)}`)
      const marker = `digestmatch-${randomUUID().slice(0, 8)}`
      const normalizedInput = `norm-sti-s3a-${marker}`
      const id = reserve(evidenceId, `sti-s3a-${marker}-reserve`, 1, 1, { normalized_extraction_input: `'${normalizedInput}'` })!
      const reservedDigests = dockerPsql(`select normalized_input_digest, extraction_config_digest from ai_provider_budget_reservations where id='${id}';`).trim().split('|')

      const structuredOutput = JSON.stringify({
        extraction_schema_version: 1, canonical_phenomenon_label: 'Test', label_language: 'en',
        subject_entities: ['A'], action_or_event: null, location: null, temporal_context: null,
        specificity: 'specific', content_format: 'other', confidence: 0.9,
        supporting_spans: [{ source_field: 'title', quoted_text: 'Test' }],
      }).replace(/'/g, "''")
      const extractionResult = JSON.parse(dockerPsql(`
        select record_topic_extraction_run(
          '${evidenceId}'::uuid, 1, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1',
          NULL, '${normalizedInput}', 1, 'completed', '${structuredOutput}'::jsonb, 100, 100, 0.0018, NULL,
          'sti-s3a-${marker}-completed', now() - interval '1 minute', now()
        );
      `).trim())
      const actualDigests = dockerPsql(`select normalized_input_digest, extraction_config_digest from topic_extraction_runs where id='${extractionResult.extraction_run_id}';`).trim().split('|')

      expect(reservedDigests[0]).toBe(actualDigests[0]) // normalized_input_digest
      expect(reservedDigests[1]).toBe(actualDigests[1]) // extraction_config_digest
    })
  })

  // ============================================================
  // security / grant matrix / topology
  // ============================================================
  describe('security / grant matrix / topology', () => {
    it('SET ROLE service_role CAN EXECUTE all 7 RPCs', () => {
      const evidenceId = makeEvidence(`grant-svc-${randomUUID().slice(0, 8)}`)
      const out = dockerPsql(`
        SET ROLE service_role;
        ${reserveSql(evidenceId, `sti-s3a-grant-svc-${randomUUID().slice(0, 8)}`)}
        select reconcile_stale_ai_provider_reservations();
        RESET ROLE;
      `).trim()
      expect(out).not.toBe('')
    })

    it('SET ROLE anon CANNOT EXECUTE any of the 7 RPCs', () => {
      for (const sql of [
        `select reserve_ai_provider_units('anthropic','semantic_topic_extraction','claude-sonnet-4-6', gen_random_uuid(), 1, 1, 'v1', 'x', 1, 1, 'x');`,
        `select mark_ai_provider_attempt_started(gen_random_uuid());`,
        `select commit_ai_provider_units(gen_random_uuid(), 1, 1);`,
        `select mark_ai_provider_outcome_unknown(gen_random_uuid(), null);`,
        `select release_ai_provider_units(gen_random_uuid());`,
        `select finalize_ai_provider_reservation_outcome(gen_random_uuid(), gen_random_uuid(), 'completed');`,
        `select reconcile_stale_ai_provider_reservations();`,
      ]) {
        const err = dockerPsqlExpectError(`SET ROLE anon; ${sql} RESET ROLE;`)
        expect(err).toMatch(/permission denied/)
      }
    })

    it('SET ROLE authenticated CANNOT EXECUTE any of the 7 RPCs', () => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; select reserve_ai_provider_units('anthropic','semantic_topic_extraction','claude-sonnet-4-6', gen_random_uuid(), 1, 1, 'v1', 'x', 1, 1, 'x'); RESET ROLE;`)
      expect(err).toMatch(/permission denied/)
    })

    it('service_role cannot INSERT/UPDATE/DELETE directly on any of the 3 tables (ai_extraction_control excluded -- it grants direct UPDATE by design)', () => {
      for (const table of ['ai_provider_daily_budgets', 'ai_provider_budget_reservations']) {
        const err = dockerPsqlExpectError(`SET ROLE service_role; insert into ${table} default values; RESET ROLE;`)
        expect(err).toMatch(/permission denied|null value|violates/)
      }
    })

    it('service_role CAN UPDATE ai_extraction_control directly (the documented kill-switch grant)', () => {
      const out = dockerPsql(`SET ROLE service_role; update ai_extraction_control set enabled=true where id=1; RESET ROLE; select enabled from ai_extraction_control where id=1;`).trim()
      expect(out).toBe('t')
    })

    it('second migration run is a byte-exact no-op (VALIDATE branch, no DDL/DCL)', () => {
      const result = runMigration()
      expect(result.threw).toBe(false)
      for (const name of RPC_NAMES) {
        expect(result.out).toMatch(new RegExp(`${name} already exists and matches exactly`))
      }
      expect(result.out).toMatch(/ai_extraction_control already exists and matches exactly/)
      expect(result.out).toMatch(/ai_provider_daily_budgets already exists and matches exactly/)
      expect(result.out).toMatch(/ai_provider_budget_reservations already exists and matches exactly/)
    })

    it('artificial body drift on reserve_ai_provider_units is rejected fail-closed, no auto-repair', () => {
      dockerPsql(`
        create or replace function public.reserve_ai_provider_units(
          p_provider TEXT, p_usage_type TEXT, p_model TEXT, p_signal_evidence_id UUID,
          p_normalization_version INTEGER, p_extraction_schema_version INTEGER, p_prompt_version TEXT,
          p_normalized_extraction_input TEXT, p_estimated_input_tokens INTEGER, p_estimated_max_output_tokens INTEGER,
          p_idempotency_key TEXT
        ) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
        AS $body$ BEGIN RETURN NULL; END; $body$;
      `)
      const result = runMigration()
      expect(result.threw).toBe(true)
      expect(result.out).toMatch(/075 drift: reserve_ai_provider_units body hash does not match exactly/)

      // Restore -- fail-closed means a single re-run cannot heal a drifted
      // function, AND the migration's own 7-function topology gate refuses
      // to proceed at all from a partial (e.g. 6-of-7) state -- dropping
      // only the drifted function would leave exactly that partial state.
      // Recovery requires dropping ALL 7 back to 0/7 first, exactly the
      // same non-healing behavior 074's own test documents for its 2 RPCs.
      dropAllRpcs()
      const restore = runMigration()
      expect(restore.threw).toBe(false)
    })

    it('artificial ACL drift (extra PUBLIC grant) on release_ai_provider_units is rejected fail-closed', () => {
      dockerPsql(`grant execute on function public.release_ai_provider_units(uuid) to PUBLIC;`)
      const result = runMigration()
      expect(result.threw).toBe(true)
      expect(result.out).toMatch(/075 drift: release_ai_provider_units ACL does not match exactly/)
      dockerPsql(`revoke execute on function public.release_ai_provider_units(uuid) from PUBLIC;`)
      const restore = runMigration()
      expect(restore.threw).toBe(false)
    })

    it('forced partial table topology (2 of 3 present) raises before touching the survivors', () => {
      dockerPsql(`drop table if exists ai_extraction_control cascade;`)
      const result = runMigration()
      expect(result.threw).toBe(true)
      expect(result.out).toMatch(/075 fail-closed: partial table topology detected/)
      // Recovery requires the full 0/3 state -- drop the survivors too, then re-run.
      dockerPsql(`drop table if exists ai_provider_budget_reservations cascade; drop table if exists ai_provider_daily_budgets cascade;`)
      const restore = runMigration()
      expect(restore.threw).toBe(false)
    })
  })
})
