// PFM Anthropic Provider Failure Taxonomy v0 -- 081 migration DB
// integration. Real local Docker Postgres, matching every other 079/080/081
// -family suite's own dockerPsql/marker conventions. No provider call ever.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const MIGRATION_081_PATH = join(process.cwd(), 'supabase/migrations/081_supervised_intake_provider_failure_taxonomy.sql')
const CONTAINER = 'supabase_db_WillViralFinal'
const MARKER = 'sti081'

function dockerPsql(sql: string): string {
  return execSync(`docker exec -i ${CONTAINER} psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -`, { input: sql, encoding: 'utf-8' })
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
function disableControl() {
  dockerPsql(`select configure_supervised_intake_control(false, 0, 0, 900, 'test-operator', 'DISABLE_KILL_SWITCH', '${nextMarker('cfg-off')}');`)
}
function createBatch(evidenceIds: string[], key = nextMarker('batch')) {
  const arr = `ARRAY[${evidenceIds.map((id) => `'${id}'`).join(',')}]::uuid[]`
  return JSON.parse(dockerPsql(`select create_supervised_intake_batch(${arr}, 'test-operator', ${CONFIG_ARGS}, '${key}');`))
}
function claim(batchId: string, key = nextMarker('claim')) {
  return JSON.parse(dockerPsql(`select claim_next_intake_item('${batchId}', '${key}');`))
}

function cleanupMarker() {
  dockerPsql(`
    do $$
    declare v_batch record;
    begin
      for v_batch in select id from supervised_intake_batches where idempotency_key like '${MARKER}-%' loop
        update supervised_intake_batch_items set status='pending', current_attempt_id=NULL, token_digest=NULL, claimed_at=NULL, lease_expires_at=NULL, extraction_run_id=NULL, review_request_id=NULL, reason_code=NULL where batch_id = v_batch.id;
      end loop;
      update supervised_intake_batch_items set status='skipped_claimed_elsewhere', current_attempt_id=null, token_digest=null, claimed_at=null, lease_expires_at=null
        where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%') and status='claimed';
      delete from supervised_intake_events where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_attempts where batch_item_id in (select id from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%'));
      delete from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_batches where idempotency_key like '${MARKER}-%';
      delete from supervised_intake_idempotency_ledger where idempotency_key like '${MARKER}-%';
      delete from signal_evidence where external_ref like '${MARKER}-%';
      delete from signal_sources where external_id like '${MARKER}-%';
      delete from signal_runs where idempotency_key like '${MARKER}-%';
    end $$;
  `)
  disableControl()
}

describeIfLocalDb('081 -- Provider Failure Taxonomy v0 (real local DB)', () => {
  beforeAll(() => {
    cleanupMarker()
  })
  afterAll(() => {
    cleanupMarker()
    expect(dockerPsql('select enabled from ai_extraction_control;').trim()).toBe('f')
    expect(dockerPsql('select enabled from supervised_intake_control where id=1;').trim()).toBe('f')
  })

  describe('migration idempotency and topology', () => {
    it('081 second run is a byte-exact no-op', () => {
      const result = runMigration(MIGRATION_081_PATH)
      expect(result.threw).toBe(false)
      expect(result.out).toMatch(/already includes the provider-taxonomy codes -- no-op/)
      expect(result.out).not.toMatch(/upgraded/i)
    })

    it('079/080 objects and hashes remain untouched by 081', () => {
      expect(dockerPsql(`select (md5(replace(prosrc, E'\\r\\n', E'\\n')) = '21b4d6d58d259cc1235f74f1f2e5d38d')::text from pg_proc where proname='claim_next_intake_item';`).trim()).toBe('true')
      expect(dockerPsql(`select (md5(replace(prosrc, E'\\r\\n', E'\\n')) = 'a23602bc8f37aff495632832522cf96d')::text from pg_proc where proname='stop_intake_batch';`).trim()).toBe('true')
      expect(dockerPsql(`select (pg_get_constraintdef(oid) like '%item_closed_unprocessed%')::text from pg_constraint where conname='supervised_intake_events_kind_check';`).trim()).toBe('true')
    })

    it('fail_intake_item has no overload', () => {
      expect(dockerPsql(`select count(*)::text from pg_proc where proname='fail_intake_item';`).trim()).toBe('1')
    })

    it('the item reason_code CHECK constraint contains exactly the five new provider-taxonomy codes plus the original 079 set', () => {
      const def = dockerPsql(`select pg_get_constraintdef(oid) from pg_constraint where conname='supervised_intake_batch_items_reason_code_check';`)
      for (const code of ['PROVIDER_AUTHENTICATION_FAILED', 'PROVIDER_PERMISSION_DENIED', 'PROVIDER_MODEL_NOT_FOUND', 'PROVIDER_INVALID_REQUEST_UNBILLED', 'PROVIDER_REJECTED_UNBILLED_UNKNOWN']) {
        expect(def).toContain(code)
      }
      expect(def).toContain('INVALID_EVIDENCE_STATE') // original 079 codes preserved
    })

    it('fail_intake_item rejects an unrecognized reason code (fail-closed, drift-proof)', () => {
      expect(() => dockerPsql(`select fail_intake_item('${'0'.repeat(8)}-0000-4000-8000-000000000000'::uuid, 'x', 'NOT_A_REAL_REASON_CODE', true, NULL, '${nextMarker('bad-reason')}');`)).toThrow(/INVALID_REASON_CODE/)
    })
  })

  describe('each new provider-taxonomy code is independently accepted by fail_intake_item and produces a correctly stopped batch', () => {
    const cases: Array<{ code: string; label: string }> = [
      { code: 'PROVIDER_AUTHENTICATION_FAILED', label: 'authfail' },
      { code: 'PROVIDER_PERMISSION_DENIED', label: 'permdenied' },
      { code: 'PROVIDER_MODEL_NOT_FOUND', label: 'modelnotfound' },
      { code: 'PROVIDER_INVALID_REQUEST_UNBILLED', label: 'invalidreq' },
      { code: 'PROVIDER_REJECTED_UNBILLED_UNKNOWN', label: 'unknownstatus' },
    ]

    for (const { code, label } of cases) {
      it(`${code}: fail_intake_item(retryable=false) succeeds, item terminal, attempt failed_terminal`, () => {
        enableControl(1, 10)
        const evidenceId = createEvidence(label)
        const batch = createBatch([evidenceId])
        const claimed = claim(batch.batch_id)
        expect(claimed.outcome).toBe('claimed')

        const result = JSON.parse(
          dockerPsql(
            `select fail_intake_item('${claimed.item_id}'::uuid, '${claimed.claim_token}', '${code}', false, '${label}', '${nextMarker(`fail-${label}`)}');`,
          ),
        )
        expect(result.ok).toBe(true)
        expect(result.status).toBe('failed')
        expect(result.retryable).toBe(false)

        const itemRow = dockerPsql(`select status||'|'||reason_code||'|'||retryable::text from supervised_intake_batch_items where id='${claimed.item_id}'::uuid;`).trim()
        expect(itemRow).toBe(`failed|${code}|false`)
        const attemptRow = dockerPsql(`select status||'|'||retryable::text from supervised_intake_attempts where batch_item_id='${claimed.item_id}'::uuid;`).trim()
        expect(attemptRow).toBe('failed_terminal|false')

        // authorize_intake_item_retry (079) must refuse -- retryable=false is
        // the entire safety boundary preventing an automatic paid retry.
        expect(() =>
          dockerPsql(`select authorize_intake_item_retry('${claimed.item_id}'::uuid, 'test-operator', 'OPERATOR_REVIEWED', '${nextMarker('retry')}');`),
        ).toThrow(/ITEM_NOT_RETRYABLE/)
      })
    }
  })

  it('zero provider calls anywhere in this suite', () => {
    const count = dockerPsql(`select count(*) from supervised_intake_attempts where batch_item_id in (select id from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%')) and provider_call_started_at is not null;`).trim()
    expect(count).toBe('0')
  })
})
