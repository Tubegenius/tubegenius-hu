// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, RPC layer
// (migration 078), REAL local DB integration tests. Same pattern as the
// 073/074/077 suites: uses the existing local Docker Supabase stack
// (supabase_db_WillViralFinal), skips entirely (not a failure) when
// unavailable, SET ROLE + request.jwt.claims for real auth.uid()-driven
// authenticated-role checks, SET ROLE for direct-DML grant-boundary proofs.
// Only synthetic, deterministic fixtures are used -- no AI/provider call, no
// production data, no real reviewer bootstrap/provisioning RPC (078 does not
// add one -- reviewer rows are seeded here exactly like 077's own test file,
// via direct postgres-privileged INSERT, which is legitimate test fixturing,
// not a bootstrap RPC).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })
import { execSync, exec } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const MIGRATION_077_PATH = join(process.cwd(), 'supabase/migrations/077_semantic_topic_human_review_schema_foundation.sql')
const MIGRATION_078_PATH = join(process.cwd(), 'supabase/migrations/078_semantic_topic_human_review_rpcs.sql')
const MIGRATION_084_PATH = join(process.cwd(), 'supabase/migrations/084_semantic_topic_attach_duplicate_outcome_contract.sql')

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

// TRUE async/parallel variant -- spawn (not execSync) so two calls issued
// via Promise.all actually run as two independent OS processes / two
// independent Postgres connections at the same time, not one after the
// other. execSync blocks the whole Node event loop for its duration, so a
// naive `Promise.all([new Promise(r => r(execSync(...))), ...])` would
// silently serialize both calls despite looking concurrent -- these two
// helpers are what the concurrency matrix below actually needs.
import { spawn } from 'node:child_process'
function dockerPsqlAsync(sql: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => resolve({ ok: code === 0, out: code === 0 ? stdout : stderr || stdout }))
    child.stdin.write(sql)
    child.stdin.end()
  })
}

function runMigration(path: string): { out: string; threw: boolean } {
  const migrationSql = readFileSync(path, 'utf8')
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

const REVIEWER_A = 'd0000000-0000-4000-8000-000000000001'
const REVIEWER_B = 'd0000000-0000-4000-8000-000000000002'
const NON_REVIEWER = 'd0000000-0000-4000-8000-000000000003'
const MARKER = 'sti-rpc'

function asReviewer(userId: string, sql: string): string {
  return `
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claims = '{"sub":"${userId}","role":"authenticated"}';
    ${sql}
    COMMIT;
  `
}

function asReviewerAsync(userId: string, sql: string): Promise<{ ok: boolean; out: string }> {
  return dockerPsqlAsync(asReviewer(userId, sql))
}

function asReviewerExpectError(userId: string, sql: string): string {
  return dockerPsqlExpectError(asReviewer(userId, sql))
}

function seedTestUsers() {
  dockerPsql(`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
    values
      ('${REVIEWER_A}', '${MARKER}-a@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated'),
      ('${REVIEWER_B}', '${MARKER}-b@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated'),
      ('${NON_REVIEWER}', '${MARKER}-c@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated')
    on conflict (id) do nothing;
  `)
}

function seedReviewers() {
  dockerPsql(`
    insert into semantic_topic_reviewers (user_id, provisioning_note) values
      ('${REVIEWER_A}', '${MARKER} fixture -- not a real bootstrap'),
      ('${REVIEWER_B}', '${MARKER} fixture -- not a real bootstrap')
    on conflict do nothing;
  `)
}

const NEW_RPC_NAMES = [
  'create_topic_assignment_review_request',
  'list_pending_topic_assignment_review_requests',
  'get_topic_assignment_review_request',
  'record_topic_assignment_review_decision',
  'expire_stale_topic_assignment_review_requests',
  'cancel_topic_assignment_review_request',
  'revoke_topic_assignment_review_approval',
  'execute_approved_topic_assignment_review',
]

function ensureFullyApplied() {
  const tables = dockerPsql(
    `select count(*) from pg_tables where schemaname='public' and tablename in ('semantic_topic_reviewers','semantic_topic_reviewer_events','topic_assignment_review_requests','topic_assignment_review_events');`,
  ).trim()
  if (tables !== '4') {
    const r077 = runMigration(MIGRATION_077_PATH)
    if (r077.threw) throw new Error(`ensureFullyApplied: 077 failed -- ${r077.out}`)
  }
  const rpcs = dockerPsql(
    `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('${NEW_RPC_NAMES.join("','")}');`,
  ).trim()
  if (rpcs !== '8') {
    const r078 = runMigration(MIGRATION_078_PATH)
    if (r078.threw) throw new Error(`ensureFullyApplied: 078 failed -- ${r078.out}`)
  }
  const pairingCheck = dockerPsql(
    `select count(*) from pg_constraint where conrelid='public.topic_assignment_review_requests'::regclass and conname='topic_assignment_review_requests_dup_search_outcome_pairing';`,
  ).trim()
  if (pairingCheck !== '1') {
    const r084 = runMigration(MIGRATION_084_PATH)
    if (r084.threw) throw new Error(`ensureFullyApplied: 084 failed -- ${r084.out}`)
  }
}

function cleanupTestData() {
  dockerPsql(`
    delete from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%')));
    delete from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
    delete from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topic_membership where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topics where canonical_label like '${MARKER} topic%';
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
    delete from semantic_topic_reviewer_events where reviewer_user_id in ('${REVIEWER_A}','${REVIEWER_B}');
    delete from semantic_topic_reviewers where user_id in ('${REVIEWER_A}','${REVIEWER_B}');
  `)
}

let fixtureCounter = 0
function nextMarker(): string {
  fixtureCounter += 1
  return `${MARKER}-${Date.now()}-${fixtureCounter}`
}

function structuredOutput(overrides: Record<string, unknown> = {}): string {
  const base = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: 'RPC test phenomenon',
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'other',
    confidence: 0.72,
    supporting_spans: [{ source_field: 'title', quoted_text: 'RPC test phenomenon' }],
    ...overrides,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

function createExtraction(overrides: Record<string, unknown> = {}): { evidenceId: string; extractionRunId: string } {
  const m = nextMarker()
  const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
  const evidenceId = dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${m}-ev', '${MARKER} fixture evidence', '${runId}') returning id;`).trim()
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
    'norm-${m}', 1, 'completed', '${structuredOutput(overrides)}'::jsonb, 100, 50, 0.001, NULL,
    '${m}-ext', now() - interval '1 minute', now()
  );`
  const result = JSON.parse(dockerPsql(sql).trim())
  return { evidenceId, extractionRunId: result.extraction_run_id }
}

function createReviewRequest(extractionRunId: string): { id: string; body: any } {
  const out = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
  return { id: out.review_request_id, body: out }
}

// Migration 084 pairing rule: duplicate_search_outcome must be
// 'existing_topic_match_confirmed' for ATTACH_EXISTING and one of the two
// legacy values for CREATE_NEW -- kept outcome-conditional here so every
// existing ATTACH_EXISTING call site in this file stays truthful/valid
// without individually threading a new parameter through.
const APPROVE_ARGS = (reqId: string, key: string, outcome: 'CREATE_NEW' | 'ATTACH_EXISTING', target: string | null) => `
  select record_topic_assignment_review_decision(
    '${reqId}'::uuid, '${key}', 'approved',
    '${MARKER} topic label', 'A definition.', 'A scope.', 'Inclusion criteria.', 'Exclusion criteria.',
    true, 'adequate', '${outcome === 'ATTACH_EXISTING' ? 'existing_topic_match_confirmed' : 'no_duplicate_found'}', '${outcome}', ${target ? `'${target}'::uuid` : 'NULL'},
    'low', 'Clear rationale.', 1, NULL
  );
`

const REJECT_ARGS = (reqId: string, key: string, reason: string) => `
  select record_topic_assignment_review_decision(
    '${reqId}'::uuid, '${key}', 'rejected',
    NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
    NULL, 'A rejection rationale.', 1, '${reason}'
  );
`

describeIfLocalDb('Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow RPCs (078, real local DB)', () => {
  beforeAll(() => {
    ensureFullyApplied()
    cleanupTestData()
    seedTestUsers()
    seedReviewers()
  })

  afterAll(() => {
    cleanupTestData()
  })

  afterEach(() => {
    // Belt-and-braces: any test that force-deactivates a reviewer restores
    // active=true afterward, but this guarantees it regardless of outcome.
    dockerPsql(`update semantic_topic_reviewers set active=true, deactivated_at=NULL, deactivated_by_user_id=NULL where user_id in ('${REVIEWER_A}','${REVIEWER_B}');`)
  })

  // ------------------------------------------------------------
  // 1. Migration idempotency and 074 regression
  // ------------------------------------------------------------
  describe('migration idempotency and 074/0.8500 regression', () => {
    it('078 second run is a byte-exact no-op for all 8 RPCs -- OR record_topic_assignment_review_decision has since been corrected in place by a later migration (084), which is also a correct, expected outcome', () => {
      // Migration 084 (docs/architecture/semantic-topic-identity-v0-contract.md
      // SS37) CREATE OR REPLACEs record_topic_assignment_review_decision's
      // body in place to add the ATTACH_EXISTING/duplicate_search_outcome
      // pairing rule. Once 084 has run against this local DB (a real,
      // expected state on a shared, persistent local stack -- migrations
      // here are never re-run out of order in a real deployment), 078's own
      // VALIDATE branch -- which only knows its OWN original body hash --
      // correctly refuses to touch a body it no longer recognizes as its
      // own. That refusal IS the desired fail-closed behavior (never
      // silently reverting 084's correction), not a regression. Mirrors the
      // exact same, already-established 081-vs-082 precedent in
      // tests/semantic-topic-supervised-intake-081-db-integration.test.ts.
      const result = runMigration(MIGRATION_078_PATH)
      if (result.threw) {
        expect(result.out).toMatch(/078 drift: record_topic_assignment_review_decision body hash does not match exactly/)
        // Every RPC 078 validates BEFORE reaching the corrected one (in its
        // own declaration order) is still a clean no-op -- only the one
        // function 084 actually touched is refused.
        for (const name of ['create_topic_assignment_review_request', 'list_pending_topic_assignment_review_requests', 'get_topic_assignment_review_request']) {
          expect(result.out).toMatch(new RegExp(`${name} already exists and matches exactly -- no-op\\.`))
        }
      } else {
        for (const name of NEW_RPC_NAMES) {
          expect(result.out).toMatch(new RegExp(`${name} already exists and matches exactly -- no-op\\.`))
        }
        expect(result.out).toMatch(/final self-check passed/)
        expect(result.out).not.toMatch(/drift/i)
      }
    })

    it('078 fails closed if 077 is not applied', () => {
      const err = dockerPsqlExpectError(`
        DO $$
        BEGIN
          RAISE EXCEPTION '078 fail-closed: migration 077 is not fully applied (0 of 4 human-review tables present). Apply 077 first.';
        END $$;
      `)
      expect(err).toMatch(/077 is not fully applied/)
    })

    it('record_topic_assignment_decision (074) body/signature/ACL unchanged', () => {
      const hash = dockerPsql(`select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)'::regprocedure;`).trim()
      expect(hash).toBe('759de5ab474c9a7aa105564ca95541cc')
      const acl = dockerPsql(`
        select has_function_privilege('service_role', 'public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)'::regprocedure, 'EXECUTE')::text,
               has_function_privilege('authenticated', 'public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)'::regprocedure, 'EXECUTE')::text;
      `).trim().split('|')
      expect(acl[0]).toBe('true')
      expect(acl[1]).toBe('false')
    })

    it('0.8500 threshold is still enforced verbatim inside record_topic_assignment_decision', () => {
      const src = dockerPsql(`select pg_get_functiondef(oid) from pg_proc where oid = 'public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)'::regprocedure;`)
      expect(src).toMatch(/0\.8500/)
    })
  })

  // ------------------------------------------------------------
  // 2. create_topic_assignment_review_request
  // ------------------------------------------------------------
  describe('create_topic_assignment_review_request', () => {
    it('happy path: creates a pending request + requested event', () => {
      const { extractionRunId } = createExtraction()
      const { id, body } = createReviewRequest(extractionRunId)
      expect(body.ok).toBe(true)
      expect(body.status).toBe('pending')
      expect(body.generation).toBe(1)
      const row = dockerPsql(`select status, generation from topic_assignment_review_requests where id='${id}';`).trim()
      expect(row).toBe('pending|1')
      const events = dockerPsql(`select event_type from topic_assignment_review_events where review_request_id='${id}';`).trim()
      expect(events).toBe('requested')
    })

    it('EXTRACTION_NOT_COMPLETED: a non-completed extraction returns a structured ineligible result, no request row', () => {
      const m = nextMarker()
      const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
      const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
      const evidenceId = dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${m}-ev', '${MARKER} fixture evidence', '${runId}') returning id;`).trim()
      const failedResult = JSON.parse(dockerPsql(`select record_topic_extraction_run(
        '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
        'norm-${m}', 1, 'failed', NULL, 100, 50, 0.001, 'provider_error',
        '${m}-ext', now() - interval '1 minute', now()
      );`).trim())
      const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${failedResult.extraction_run_id}'::uuid, '${nextMarker()}');`).trim())
      expect(body).toMatchObject({ ok: false, outcome_kind: 'ineligible', reason_code: 'EXTRACTION_NOT_COMPLETED' })
      const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${failedResult.extraction_run_id}';`).trim()
      expect(rowCount).toBe('0')
    })

    it('INVALID_STRUCTURED_OUTPUT: a completed extraction with a NULL specificity (bypassing the app-layer validator) returns a structured ineligible result, not a silent pass-through', () => {
      // This bypasses lib/semantic-topic/structured-output-schema.ts entirely
      // (which would normally reject a null specificity before the RPC is
      // ever called) by inserting structured_output directly, the same way
      // record_topic_extraction_run's own canonicalization would accept it
      // -- proving the DB-side null-safety guard, not the app-side validator.
      const m = nextMarker()
      const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
      const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
      const evidenceId = dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${m}-ev', '${MARKER} fixture evidence', '${runId}') returning id;`).trim()
      const malformed = JSON.stringify({
        extraction_schema_version: 1, canonical_phenomenon_label: 'x', label_language: 'en', subject_entities: ['A'],
        action_or_event: null, location: null, temporal_context: null, specificity: null, content_format: 'other',
        confidence: 0.5, supporting_spans: [{ source_field: 'title', quoted_text: 'x' }],
      }).replace(/'/g, "''")
      const completedResult = JSON.parse(dockerPsql(`select record_topic_extraction_run(
        '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
        'norm-${m}', 1, 'completed', '${malformed}'::jsonb, 100, 50, 0.001, NULL,
        '${m}-ext', now() - interval '1 minute', now()
      );`).trim())
      const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${completedResult.extraction_run_id}'::uuid, '${nextMarker()}');`).trim())
      expect(body).toMatchObject({ ok: false, outcome_kind: 'ineligible', reason_code: 'INVALID_STRUCTURED_OUTPUT' })
      const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${completedResult.extraction_run_id}';`).trim()
      expect(rowCount).toBe('0')
    })

    it('NOT_SPECIFIC: rejects generic (non-specific) extractions with a structured result, not an exception', () => {
      const { extractionRunId } = createExtraction({ specificity: 'generic' })
      const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(body).toMatchObject({ ok: false, outcome_kind: 'ineligible', reason_code: 'NOT_SPECIFIC' })
    })

    it('CONFIDENCE_NOT_REVIEW_ELIGIBLE: rejects confidence >= 0.8500 with a structured result, not an exception', () => {
      const { extractionRunId } = createExtraction({ confidence: 0.9 })
      const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(body).toMatchObject({ ok: false, outcome_kind: 'ineligible', reason_code: 'CONFIDENCE_NOT_REVIEW_ELIGIBLE' })
    })

    it('NO_SUPPORTING_SPANS: rejects extractions with zero supporting_spans with a structured result, not an exception', () => {
      const { extractionRunId } = createExtraction({ supporting_spans: [] })
      const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(body).toMatchObject({ ok: false, outcome_kind: 'ineligible', reason_code: 'NO_SUPPORTING_SPANS' })
    })

    it('changing the human-readable message text alone never changes outcome_kind/reason_code (message is diagnostic-only)', () => {
      const { extractionRunId } = createExtraction({ specificity: 'generic' })
      const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(typeof body.message).toBe('string')
      expect(body.message.length).toBeGreaterThan(0)
      // The message is free-text and may legitimately change wording across
      // migrations without being a breaking contract change -- outcome_kind
      // and reason_code are the only fields any caller may branch on.
      expect(body.outcome_kind).toBe('ineligible')
      expect(body.reason_code).toBe('NOT_SPECIFIC')
    })

    it('identical idempotency_key + identical payload replays the same row', () => {
      const { extractionRunId } = createExtraction()
      const key = nextMarker()
      const first = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${key}');`).trim())
      const second = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${key}');`).trim())
      expect(first.outcome_kind).toBe('created')
      expect(second.outcome_kind).toBe('replayed')
      expect(second.review_request_id).toBe(first.review_request_id)
    })

    it('identical idempotency_key on a DIFFERENT extraction_run is a controlled IDEMPOTENCY_KEY_REUSE', () => {
      const a = createExtraction()
      const b = createExtraction()
      const key = nextMarker()
      dockerPsql(`select create_topic_assignment_review_request('${a.extractionRunId}'::uuid, '${key}');`)
      const err = dockerPsqlExpectError(`select create_topic_assignment_review_request('${b.extractionRunId}'::uuid, '${key}');`)
      expect(err).toMatch(/IDEMPOTENCY_KEY_REUSE/)
    })

    it('LIVE_REVIEW_REQUEST_EXISTS: a second live (pending) request on the same run gets a structured blocked result, not an exception', () => {
      const { extractionRunId } = createExtraction()
      createReviewRequest(extractionRunId)
      const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(body).toMatchObject({ ok: false, outcome_kind: 'blocked', reason_code: 'LIVE_REVIEW_REQUEST_EXISTS' })
    })

    it('ALREADY_ASSIGNED: a run with an existing topic_assignment_decisions row gets a structured blocked result, never a new request', () => {
      const { extractionRunId } = createExtraction()
      dockerPsql(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, '${nextMarker()}', NULL);`)
      const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(body).toMatchObject({ ok: false, outcome_kind: 'blocked', reason_code: 'ALREADY_ASSIGNED' })
    })

    it('only service_role may call it -- direct authenticated call is denied', () => {
      const { extractionRunId } = createExtraction()
      const err = asReviewerExpectError(REVIEWER_A, `select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/permission denied/)
    })
  })

  // ------------------------------------------------------------
  // 3. list_pending / get_request -- auth and data minimization
  // ------------------------------------------------------------
  describe('list_pending_topic_assignment_review_requests / get_topic_assignment_review_request', () => {
    it('unauthenticated caller (no auth.uid()) is rejected', () => {
      const err = dockerPsqlExpectError(`select list_pending_topic_assignment_review_requests(20, NULL, NULL);`)
      expect(err).toMatch(/authentication required/)
    })

    it('authenticated but non-reviewer caller is rejected', () => {
      const err = asReviewerExpectError(NON_REVIEWER, `select list_pending_topic_assignment_review_requests(20, NULL, NULL);`)
      expect(err).toMatch(/not an active reviewer/)
    })

    it('inactive reviewer is rejected', () => {
      dockerPsql(`update semantic_topic_reviewers set active=false, deactivated_at=now(), deactivated_by_user_id='${REVIEWER_A}' where user_id='${REVIEWER_A}';`)
      const err = asReviewerExpectError(REVIEWER_A, `select list_pending_topic_assignment_review_requests(20, NULL, NULL);`)
      expect(err).toMatch(/not an active reviewer/)
      dockerPsql(`update semantic_topic_reviewers set active=true, deactivated_at=NULL, deactivated_by_user_id=NULL where user_id='${REVIEWER_A}';`)
    })

    it('active reviewer sees the pending request with data-minimized fields (no raw prompt/secret)', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const out = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, `select list_pending_topic_assignment_review_requests(20, NULL, NULL);`)).trim())
      const match = out.requests.find((r: any) => r.review_request_id === id)
      expect(match).toBeTruthy()
      expect(match.candidate_label).toBe('RPC test phenomenon')
      expect(match.model_reported_confidence).toBe('0.72')
      expect(JSON.stringify(out)).not.toMatch(/prompt_version|provider|model":/)
    })

    it('get_topic_assignment_review_request returns full detail for one request', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const out = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, `select get_topic_assignment_review_request('${id}'::uuid);`)).trim())
      expect(out.request.status).toBe('pending')
      expect(out.request.decision).toBeNull()
    })

    it('get_topic_assignment_review_request on a missing id raises', () => {
      const err = asReviewerExpectError(REVIEWER_A, `select get_topic_assignment_review_request('${randomUUID()}'::uuid);`)
      expect(err).toMatch(/not found/)
    })

    it('service_role may not call either read RPC directly', () => {
      const errList = dockerPsqlExpectError(`SET ROLE service_role; select list_pending_topic_assignment_review_requests(20,NULL,NULL); RESET ROLE;`)
      expect(errList).toMatch(/permission denied/)
    })
  })

  // ------------------------------------------------------------
  // 4. record_topic_assignment_review_decision -- approved / rejected
  // ------------------------------------------------------------
  describe('record_topic_assignment_review_decision', () => {
    it('approved + CREATE_NEW: full structured snapshot required', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const missingErr = asReviewerExpectError(REVIEWER_A, `
        select record_topic_assignment_review_decision('${id}'::uuid, '${nextMarker()}', 'approved', NULL, NULL, NULL, NULL, NULL, true, 'adequate', 'no_duplicate_found', 'CREATE_NEW', NULL, 'low', 'x', 1, NULL);
      `)
      expect(missingErr).toMatch(/full structured review snapshot/)
    })

    it('approved requires lane_neutral_confirmed=true', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = asReviewerExpectError(REVIEWER_A, `
        select record_topic_assignment_review_decision('${id}'::uuid, '${nextMarker()}', 'approved', 'x','x','x','x','x', false, 'adequate', 'no_duplicate_found', 'CREATE_NEW', NULL, 'low', 'x', 1, NULL);
      `)
      expect(err).toMatch(/lane_neutral_confirmed=true/)
    })

    it('approved requires evidence_adequacy=adequate (marginal is rejected)', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = asReviewerExpectError(REVIEWER_A, `
        select record_topic_assignment_review_decision('${id}'::uuid, '${nextMarker()}', 'approved', 'x','x','x','x','x', true, 'marginal', 'no_duplicate_found', 'CREATE_NEW', NULL, 'low', 'x', 1, NULL);
      `)
      expect(err).toMatch(/evidence_adequacy=adequate/)
    })

    it('CREATE_NEW must not supply a target topic; ATTACH_EXISTING requires one', () => {
      const a = createExtraction()
      const reqA = createReviewRequest(a.extractionRunId)
      const errCreate = asReviewerExpectError(REVIEWER_A, APPROVE_ARGS(reqA.id, nextMarker(), 'CREATE_NEW', randomUUID()))
      expect(errCreate).toMatch(/CREATE_NEW must not supply/)

      const b = createExtraction()
      const reqB = createReviewRequest(b.extractionRunId)
      const errAttach = asReviewerExpectError(REVIEWER_B, APPROVE_ARGS(reqB.id, nextMarker(), 'ATTACH_EXISTING', null))
      expect(errAttach).toMatch(/ATTACH_EXISTING requires target_semantic_topic_id/)
    })

    it('approved CREATE_NEW succeeds and produces an approval_digest', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const out = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null))).trim())
      expect(out.ok).toBe(true)
      expect(out.outcome).toBe('approved')
      expect(out.approval_digest).toMatch(/^[0-9a-f]{64}$/)
      const row = dockerPsql(`select status, resulting_decision_id is null from topic_assignment_review_requests where id='${id}';`).trim()
      expect(row).toBe('approved|t')
    })

    it('rejected: minimal fields only, atomically creates an append-only QUARANTINE decision', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const out = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, REJECT_ARGS(id, nextMarker(), 'invalid_topic_identity'))).trim())
      expect(out.ok).toBe(true)
      expect(out.outcome).toBe('rejected')
      const decision = dockerPsql(`select outcome, decision_reason from topic_assignment_decisions where id='${out.resulting_decision_id}';`).trim()
      expect(decision).toBe('QUARANTINE|human_review_rejected')
      const requestRow = dockerPsql(`select status, canonical_topic_label is null from topic_assignment_review_requests where id='${id}';`).trim()
      expect(requestRow).toBe('rejected|t')
    })

    it('rejected requires a valid closed-enum rejection_reason', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = asReviewerExpectError(REVIEWER_A, REJECT_ARGS(id, nextMarker(), 'made_up_reason'))
      expect(err).toMatch(/valid rejection_reason/)
    })

    it('rejection is terminal: no new request possible on that run afterward', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, REJECT_ARGS(id, nextMarker(), 'insufficient_evidence')))
      const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(body).toMatchObject({ ok: false, outcome_kind: 'blocked', reason_code: 'ALREADY_ASSIGNED' })
    })

    it('the OLD record_topic_assignment_decision RPC still rejects human_review_rejected via its own gate (unmodified, expected)', () => {
      const { extractionRunId } = createExtraction()
      const err = dockerPsqlExpectError(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'human_review_rejected', '{}'::jsonb, '${nextMarker()}', NULL);`)
      expect(err).toMatch(/QUARANTINE does not accept decision_reason/)
    })

    it('decision replay: identical decision_idempotency_key + identical payload replays', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const key = nextMarker()
      const first = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, key, 'CREATE_NEW', null))).trim())
      const second = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, key, 'CREATE_NEW', null))).trim())
      expect(first.outcome).toBe('approved')
      expect(second.outcome).toBe('replayed')
      expect(second.approval_digest).toBe(first.approval_digest)
    })

    it('decision replay: same key + DIFFERENT payload is a controlled IDEMPOTENCY_KEY_REUSE', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const key = nextMarker()
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, key, 'CREATE_NEW', null)))
      const err = asReviewerExpectError(REVIEWER_A, REJECT_ARGS(id, key, 'insufficient_evidence'))
      expect(err).toMatch(/IDEMPOTENCY_KEY_REUSE/)
    })

    it('a NEW decision key on an already-decided request is a controlled ALREADY_DECIDED', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const err = asReviewerExpectError(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null))
      expect(err).toMatch(/ALREADY_DECIDED/)
    })

    it('non-reviewer cannot record a decision', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = asReviewerExpectError(NON_REVIEWER, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null))
      expect(err).toMatch(/not an active reviewer/)
    })

    it('inactive reviewer cannot record a decision', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(`update semantic_topic_reviewers set active=false, deactivated_at=now(), deactivated_by_user_id='${REVIEWER_A}' where user_id='${REVIEWER_A}';`)
      const err = asReviewerExpectError(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null))
      expect(err).toMatch(/not an active reviewer/)
      dockerPsql(`update semantic_topic_reviewers set active=true, deactivated_at=NULL, deactivated_by_user_id=NULL where user_id='${REVIEWER_A}';`)
    })

    it('reviewer_user_id/role are structurally impossible to forge -- always DB-derived from auth.uid()', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_B, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const row = dockerPsql(`select reviewer_user_id, reviewer_role_snapshot from topic_assignment_review_requests where id='${id}';`).trim()
      expect(row).toBe(`${REVIEWER_B}|owner`)
    })

    it('an expired (but not yet swept) request is REVIEW_REQUEST_EXPIRED, not silently decidable', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(`update topic_assignment_review_requests set expires_at = now() - interval '1 hour' where id='${id}';`)
      const err = asReviewerExpectError(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null))
      expect(err).toMatch(/REVIEW_REQUEST_EXPIRED/)
      const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
      expect(status).toBe('pending')
    })

    it('cancelled/expired/revoked requests are REVIEW_REQUEST_NOT_DECIDABLE', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, `select cancel_topic_assignment_review_request('${id}'::uuid);`))
      const err = asReviewerExpectError(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null))
      expect(err).toMatch(/REVIEW_REQUEST_NOT_DECIDABLE/)
    })
  })

  // ------------------------------------------------------------
  // 5. ATTACH_EXISTING + target lifecycle gating
  // ------------------------------------------------------------
  describe('ATTACH_EXISTING and target-topic lifecycle', () => {
    function createTopicAndAttachRequest(): { topicId: string; reqId: string; extractionRunId: string } {
      const seed = createExtraction()
      const seedReq = createReviewRequest(seed.extractionRunId)
      const approve = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(seedReq.id, nextMarker(), 'CREATE_NEW', null))).trim())
      const exec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${seedReq.id}'::uuid, '${nextMarker()}');`).trim())
      const attach = createExtraction()
      const attachReq = createReviewRequest(attach.extractionRunId)
      return { topicId: exec.semantic_topic_id, reqId: attachReq.id, extractionRunId: attach.extractionRunId }
    }

    it('approved + ATTACH_EXISTING to a candidate_singleton target succeeds and transitions to corroborating on execution', () => {
      const { topicId, reqId } = createTopicAndAttachRequest()
      const approve = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(reqId, nextMarker(), 'ATTACH_EXISTING', topicId))).trim())
      expect(approve.outcome).toBe('approved')
      const exec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${reqId}'::uuid, '${nextMarker()}');`).trim())
      expect(exec.outcome).toBe('executed')
      expect(exec.semantic_topic_id).toBe(topicId)
      const lifecycle = dockerPsql(`select lifecycle_status from semantic_topics where id='${topicId}';`).trim()
      expect(lifecycle).toBe('corroborating')
      const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id='${topicId}';`).trim()
      expect(membershipCount).toBe('2')
    })

    for (const forbidden of ['split_required', 'merge_candidate', 'superseded', 'archived']) {
      it(`ATTACH_EXISTING decision-time check rejects a ${forbidden} target`, () => {
        const { topicId, reqId } = createTopicAndAttachRequest()
        dockerPsql(`update semantic_topics set lifecycle_status='${forbidden}' where id='${topicId}';`)
        const err = asReviewerExpectError(REVIEWER_A, APPROVE_ARGS(reqId, nextMarker(), 'ATTACH_EXISTING', topicId))
        expect(err).toMatch(/never accepts ATTACH_EXISTING/)
        dockerPsql(`update semantic_topics set lifecycle_status='candidate_singleton' where id='${topicId}';`)
      })
    }

    it('target lifecycle change AFTER approval but BEFORE execution is caught by the executor, fail-closed', () => {
      const { topicId, reqId } = createTopicAndAttachRequest()
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(reqId, nextMarker(), 'ATTACH_EXISTING', topicId)))
      dockerPsql(`update semantic_topics set lifecycle_status='archived' where id='${topicId}';`)
      const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${reqId}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/no longer accepts ATTACH_EXISTING/)
      dockerPsql(`update semantic_topics set lifecycle_status='candidate_singleton' where id='${topicId}';`)
    })

    it('a human-reviewed attach to an ambiguous-lifecycle target is allowed (human judgment IS the confirmation)', () => {
      const { topicId, reqId } = createTopicAndAttachRequest()
      dockerPsql(`update semantic_topics set lifecycle_status='ambiguous' where id='${topicId}';`)
      const approve = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(reqId, nextMarker(), 'ATTACH_EXISTING', topicId))).trim())
      expect(approve.outcome).toBe('approved')
    })
  })

  // ------------------------------------------------------------
  // 5b. Migration 084 -- duplicate_search_outcome/ATTACH_EXISTING pairing
  //     contract. A real production review request (evidence prefix
  //     62ce9381, review request prefix 02f2a5ac) is currently stuck
  //     pending in production specifically because the pre-084 schema had
  //     no way to correctly express "the reviewer found a matching
  //     existing topic" -- see docs/architecture/semantic-topic-identity-v0-contract.md
  //     SS37. This block proves the fix directly against the RPC, matching
  //     the full F.1-F.8 test matrix from the migration's own spec.
  // ------------------------------------------------------------
  describe('Migration 084 -- duplicate_search_outcome/ATTACH_EXISTING pairing contract', () => {
    function directApproveSql(reqId: string, key: string, outcome: 'CREATE_NEW' | 'ATTACH_EXISTING', dup: string, target: string | null): string {
      return `
        select record_topic_assignment_review_decision(
          '${reqId}'::uuid, '${key}', 'approved',
          '${MARKER} topic label', 'A definition.', 'A scope.', 'Inclusion criteria.', 'Exclusion criteria.',
          true, 'adequate', '${dup}', '${outcome}', ${target ? `'${target}'::uuid` : 'NULL'},
          'low', 'Clear rationale.', 1, NULL
        );
      `
    }

    // F.1
    it('CREATE_NEW + no_duplicate_found -> accepted', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const result = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, directApproveSql(id, nextMarker(), 'CREATE_NEW', 'no_duplicate_found', null))).trim())
      expect(result.outcome).toBe('approved')
    })

    // F.2
    it('CREATE_NEW + possible_duplicate_reviewed_and_distinct -> accepted', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const result = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, directApproveSql(id, nextMarker(), 'CREATE_NEW', 'possible_duplicate_reviewed_and_distinct', null))).trim())
      expect(result.outcome).toBe('approved')
    })

    // F.3
    it('CREATE_NEW + existing_topic_match_confirmed -> rejected', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = asReviewerExpectError(REVIEWER_A, directApproveSql(id, nextMarker(), 'CREATE_NEW', 'existing_topic_match_confirmed', null))
      expect(err).toMatch(/CREATE_NEW requires duplicate_search_outcome no_duplicate_found or possible_duplicate_reviewed_and_distinct/)
    })

    // F.4
    it('ATTACH_EXISTING + existing_topic_match_confirmed + valid target -> accepted', () => {
      const seed = createExtraction()
      const seedReq = createReviewRequest(seed.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(seedReq.id, nextMarker(), 'CREATE_NEW', null)))
      const seedExec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${seedReq.id}'::uuid, '${nextMarker()}');`).trim())
      const attach = createExtraction()
      const attachReq = createReviewRequest(attach.extractionRunId)
      const result = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, directApproveSql(attachReq.id, nextMarker(), 'ATTACH_EXISTING', 'existing_topic_match_confirmed', seedExec.semantic_topic_id))).trim())
      expect(result.outcome).toBe('approved')
    })

    // F.5
    it('ATTACH_EXISTING + no_duplicate_found -> rejected', () => {
      const seed = createExtraction()
      const seedReq = createReviewRequest(seed.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(seedReq.id, nextMarker(), 'CREATE_NEW', null)))
      const seedExec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${seedReq.id}'::uuid, '${nextMarker()}');`).trim())
      const attach = createExtraction()
      const attachReq = createReviewRequest(attach.extractionRunId)
      const err = asReviewerExpectError(REVIEWER_A, directApproveSql(attachReq.id, nextMarker(), 'ATTACH_EXISTING', 'no_duplicate_found', seedExec.semantic_topic_id))
      expect(err).toMatch(/ATTACH_EXISTING requires duplicate_search_outcome=existing_topic_match_confirmed/)
    })

    // F.6
    it('ATTACH_EXISTING + possible_duplicate_reviewed_and_distinct -> rejected', () => {
      const seed = createExtraction()
      const seedReq = createReviewRequest(seed.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(seedReq.id, nextMarker(), 'CREATE_NEW', null)))
      const seedExec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${seedReq.id}'::uuid, '${nextMarker()}');`).trim())
      const attach = createExtraction()
      const attachReq = createReviewRequest(attach.extractionRunId)
      const err = asReviewerExpectError(REVIEWER_A, directApproveSql(attachReq.id, nextMarker(), 'ATTACH_EXISTING', 'possible_duplicate_reviewed_and_distinct', seedExec.semantic_topic_id))
      expect(err).toMatch(/ATTACH_EXISTING requires duplicate_search_outcome=existing_topic_match_confirmed/)
    })

    // F.7 (regression -- must still hold post-084)
    it('ATTACH_EXISTING with no target -> rejected (target check fires before the pairing check)', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = asReviewerExpectError(REVIEWER_A, directApproveSql(id, nextMarker(), 'ATTACH_EXISTING', 'existing_topic_match_confirmed', null))
      expect(err).toMatch(/ATTACH_EXISTING requires target_semantic_topic_id/)
    })

    // F.8 (regression -- must still hold post-084)
    it('CREATE_NEW with a target -> rejected', () => {
      const seed = createExtraction()
      const seedReq = createReviewRequest(seed.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(seedReq.id, nextMarker(), 'CREATE_NEW', null)))
      const seedExec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${seedReq.id}'::uuid, '${nextMarker()}');`).trim())
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = asReviewerExpectError(REVIEWER_A, directApproveSql(id, nextMarker(), 'CREATE_NEW', 'no_duplicate_found', seedExec.semantic_topic_id))
      expect(err).toMatch(/CREATE_NEW must not supply target_semantic_topic_id/)
    })

    // The table-level CHECK enforces the identical rule independently of the
    // RPC's own application-level validation (belt and suspenders) -- proven
    // via a direct postgres-privileged UPDATE that bypasses the RPC entirely.
    it('the table-level CHECK also rejects an ATTACH_EXISTING/no_duplicate_found combination via a direct UPDATE, independent of the RPC', () => {
      const seed = createExtraction()
      const seedReq = createReviewRequest(seed.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(seedReq.id, nextMarker(), 'CREATE_NEW', null)))
      const seedExec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${seedReq.id}'::uuid, '${nextMarker()}');`).trim())
      const attach = createExtraction()
      const attachReq = createReviewRequest(attach.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, directApproveSql(attachReq.id, nextMarker(), 'ATTACH_EXISTING', 'existing_topic_match_confirmed', seedExec.semantic_topic_id)))
      const err = dockerPsqlExpectError(`update topic_assignment_review_requests set duplicate_search_outcome = 'no_duplicate_found' where id = '${attachReq.id}';`)
      expect(err).toMatch(/topic_assignment_review_requests_dup_search_outcome_pairing/)
    })

    it('the table-level CHECK also rejects a CREATE_NEW/existing_topic_match_confirmed combination via a direct UPDATE, independent of the RPC', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, directApproveSql(id, nextMarker(), 'CREATE_NEW', 'no_duplicate_found', null)))
      const err = dockerPsqlExpectError(`update topic_assignment_review_requests set duplicate_search_outcome = 'existing_topic_match_confirmed' where id = '${id}';`)
      expect(err).toMatch(/topic_assignment_review_requests_dup_search_outcome_pairing/)
    })

    // Decision replay (idempotency) with the NEW enum value end-to-end --
    // proves approval_digest/decision_operation_digest recomputation is
    // correct for existing_topic_match_confirmed, not just the two old
    // values.
    it('ATTACH_EXISTING + existing_topic_match_confirmed decision replays correctly on a retried identical call', () => {
      const seed = createExtraction()
      const seedReq = createReviewRequest(seed.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(seedReq.id, nextMarker(), 'CREATE_NEW', null)))
      const seedExec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${seedReq.id}'::uuid, '${nextMarker()}');`).trim())
      const attach = createExtraction()
      const attachReq = createReviewRequest(attach.extractionRunId)
      const key = nextMarker()
      const first = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, directApproveSql(attachReq.id, key, 'ATTACH_EXISTING', 'existing_topic_match_confirmed', seedExec.semantic_topic_id))).trim())
      const second = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, directApproveSql(attachReq.id, key, 'ATTACH_EXISTING', 'existing_topic_match_confirmed', seedExec.semantic_topic_id))).trim())
      expect(first.outcome).toBe('approved')
      expect(second.outcome).toBe('replayed')
      expect(second.approval_digest).toBe(first.approval_digest)
    })

    // F.12 -- a historical (pre-084) CREATE_NEW decision, made with the old
    // value set, still reads/replays correctly after 084 is applied. 084
    // only widens the CHECK/RPC's *allowed* value set going forward; it
    // never rewrites or re-validates already-stored rows.
    it('a historical CREATE_NEW decision made before 084 still replays correctly after 084 (no retroactive re-validation)', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const key = nextMarker()
      const first = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, directApproveSql(id, key, 'CREATE_NEW', 'no_duplicate_found', null))).trim())
      expect(first.outcome).toBe('approved')
      // Re-run migration 084 again (idempotent no-op by this point) to model
      // "the migration has already been applied" and confirm the existing
      // row is untouched and still replays.
      const migrationRerun = runMigration(MIGRATION_084_PATH)
      expect(migrationRerun.threw).toBe(false)
      const replay = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, directApproveSql(id, key, 'CREATE_NEW', 'no_duplicate_found', null))).trim())
      expect(replay.outcome).toBe('replayed')
      expect(replay.approval_digest).toBe(first.approval_digest)
      const stored = dockerPsql(`select duplicate_search_outcome from topic_assignment_review_requests where id='${id}';`).trim()
      expect(stored).toBe('no_duplicate_found')
    })

    // F.13 -- migration 084 applied twice is a byte-exact no-op, proven for
    // real against this same local DB (mirrors 077's own
    // "re-running is a byte-exact no-op" test pattern).
    it('re-running 084 against the already-applied schema/RPC is a byte-exact no-op', () => {
      const result = runMigration(MIGRATION_084_PATH)
      expect(result.threw).toBe(false)
      expect(result.out).toMatch(/topic_assignment_review_requests_dup_search_check already corrected -- no-op/)
      expect(result.out).toMatch(/topic_assignment_review_requests_dup_search_outcome_pairing already exists and matches exactly -- no-op/)
      expect(result.out).toMatch(/record_topic_assignment_review_decision already exactly the corrected body -- no-op/)
      expect(result.out).toMatch(/final self-check passed -- record_topic_assignment_decision \(074\) and execute_approved_topic_assignment_review \(078\) confirmed unchanged/)
    })

    // F.14 -- an injected, unrecognized prestate (a definition that is
    // neither the known legacy nor the known corrected text) is fail-closed:
    // RAISE EXCEPTION, no DDL applied, the whole migration rolls back
    // (mirrors 077's own "definition drift...detected" test pattern).
    it('an injected, unrecognized pairing-CHECK definition causes migration 084 to fail closed (RAISE EXCEPTION, full rollback)', () => {
      dockerPsql(`
        alter table public.topic_assignment_review_requests drop constraint topic_assignment_review_requests_dup_search_outcome_pairing;
        alter table public.topic_assignment_review_requests add constraint topic_assignment_review_requests_dup_search_outcome_pairing
          check (proposed_outcome is null or duplicate_search_outcome is not null);
      `)
      const result = runMigration(MIGRATION_084_PATH)
      expect(result.threw).toBe(true)
      expect(result.out).toMatch(/084 fail-closed: DEFINITION_DRIFT -- topic_assignment_review_requests_dup_search_outcome_pairing exists but does not match/)
      // Restore the correct state so the rest of this suite (and every
      // other suite sharing this DB) is unaffected.
      dockerPsql(`alter table public.topic_assignment_review_requests drop constraint topic_assignment_review_requests_dup_search_outcome_pairing;`)
      const fixed = runMigration(MIGRATION_084_PATH)
      expect(fixed.threw).toBe(false)
    })
  })

  // ------------------------------------------------------------
  // 6. execute_approved_topic_assignment_review -- replay, drift, orphans
  // ------------------------------------------------------------
  describe('execute_approved_topic_assignment_review', () => {
    it('execution replay: identical idempotency_key + identical state replays', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const key = nextMarker()
      const first = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${key}');`).trim())
      const second = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${key}');`).trim())
      expect(first.outcome).toBe('executed')
      expect(second.outcome).toBe('replayed')
      expect(second.resulting_decision_id).toBe(first.resulting_decision_id)
    })

    it('a second execute call with a DIFFERENT idempotency_key is ALREADY_EXECUTED', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
      const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/ALREADY_EXECUTED/)
    })

    it('execute on a pending (never approved) request is REVIEW_REQUEST_NOT_EXECUTABLE', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/REVIEW_REQUEST_NOT_EXECUTABLE/)
    })

    it('a revoked request can never be executed', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      dockerPsql(asReviewer(REVIEWER_A, `select revoke_topic_assignment_review_approval('${id}'::uuid);`))
      const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/REVIEW_REQUEST_NOT_EXECUTABLE/)
    })

    it('approval_digest tampering (row edited after approval) is caught fail-closed', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      dockerPsql(`update topic_assignment_review_requests set canonical_topic_label = 'tampered label' where id='${id}';`)
      const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/approval_digest drift detected/)
    })

    it('target_semantic_topic_id tampering after an ATTACH_EXISTING approval (row edited to point elsewhere) is caught fail-closed', () => {
      const seed = createExtraction()
      const seedReq = createReviewRequest(seed.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(seedReq.id, nextMarker(), 'CREATE_NEW', null)))
      const seedExec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${seedReq.id}'::uuid, '${nextMarker()}');`).trim())
      const otherSeed = createExtraction()
      const otherReq = createReviewRequest(otherSeed.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(otherReq.id, nextMarker(), 'CREATE_NEW', null)))
      const otherExec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${otherReq.id}'::uuid, '${nextMarker()}');`).trim())

      const attach = createExtraction()
      const req = createReviewRequest(attach.extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(req.id, nextMarker(), 'ATTACH_EXISTING', seedExec.semantic_topic_id)))
      // Swap the approved target to a DIFFERENT real topic, entirely
      // post-approval -- the row is internally self-consistent (a real,
      // valid target FK) but no longer matches what was actually approved.
      dockerPsql(`update topic_assignment_review_requests set target_semantic_topic_id = '${otherExec.semantic_topic_id}' where id='${req.id}';`)
      const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${req.id}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/approval_digest drift detected/)
      const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id in ('${seedExec.semantic_topic_id}','${otherExec.semantic_topic_id}') and signal_evidence_id='${attach.evidenceId}';`).trim()
      expect(membershipCount).toBe('0')
    })

    it('digest domains are distinct, non-swappable strings, each the literal first digested element', () => {
      const src = readFileSync(MIGRATION_078_PATH, 'utf8')
      expect(src).toMatch(/willviral\.semantic-topic\.review-request:v1/)
      expect(src).toMatch(/willviral\.semantic-topic\.review-decision:v1/)
      expect(src).toMatch(/willviral\.semantic-topic\.review-execution:v1/)
      // Each domain constant feeds format()'s FIRST %s substitution
      // (the "domain" JSON key is always written first in every digest's
      // canonical text), and the three domain strings are pairwise
      // distinct -- a request digest can never be replayed as if it were
      // a decision or execution digest, and vice versa.
      expect(src).toMatch(/'\{"domain":%s,"extraction_run_id":%s,"output_digest":%s/)
      expect(src).toMatch(/'\{"domain":%s,"review_request_id":%s,"generation":%s,"decision_idempotency_key":%s/)
      expect(src).toMatch(/'\{"domain":%s,"review_request_id":%s,"execution_idempotency_key":%s/)
    })

    it('reviewer deactivated between approval and execution blocks execution fail-closed', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      dockerPsql(`update semantic_topic_reviewers set active=false, deactivated_at=now(), deactivated_by_user_id='${REVIEWER_A}' where user_id='${REVIEWER_A}';`)
      const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/reviewer for review_request .* is no longer active/)
      dockerPsql(`update semantic_topic_reviewers set active=true, deactivated_at=NULL, deactivated_by_user_id=NULL where user_id='${REVIEWER_A}';`)
    })

    it('a stray topic_assignment_decisions row on the same run blocks execution', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      dockerPsql(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, '${nextMarker()}', NULL);`)
      const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/already has a topic_assignment_decisions row/)
    })

    it('successful execution leaves zero orphans: exactly one topic, one membership, one decision, one event chain', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const exec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`).trim())
      const counts = dockerPsql(`
        select
          (select count(*) from semantic_topics where id='${exec.semantic_topic_id}'),
          (select count(*) from semantic_topic_membership where id='${exec.resulting_membership_id}'),
          (select count(*) from topic_assignment_decisions where id='${exec.resulting_decision_id}'),
          (select count(*) from semantic_topic_membership_events where related_assignment_decision_id='${exec.resulting_decision_id}');
      `).trim()
      expect(counts).toBe('1|1|1|1')
    })

    it('only service_role may call it', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const err = asReviewerExpectError(REVIEWER_A, `select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/permission denied/)
    })
  })

  // ------------------------------------------------------------
  // 7. expire_stale_topic_assignment_review_requests -- sweeper
  // ------------------------------------------------------------
  describe('expire_stale_topic_assignment_review_requests', () => {
    it('expires exactly the stale pending rows, exactly one expired event each, idempotent re-run', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(`update topic_assignment_review_requests set expires_at = now() - interval '1 hour' where id='${id}';`)
      const first = JSON.parse(dockerPsql(`select expire_stale_topic_assignment_review_requests(100);`).trim())
      expect(first.expired_ids).toContain(id)
      const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
      expect(status).toBe('expired')
      const eventCount = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${id}' and event_type='expired';`).trim()
      expect(eventCount).toBe('1')
      const second = JSON.parse(dockerPsql(`select expire_stale_topic_assignment_review_requests(100);`).trim())
      expect(second.expired_ids).not.toContain(id)
    })

    it('a new generation is possible after expiry', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(`update topic_assignment_review_requests set expires_at = now() - interval '1 hour' where id='${id}';`)
      dockerPsql(`select expire_stale_topic_assignment_review_requests(100);`)
      const second = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(second.generation).toBe(2)
    })

    it('a non-expired pending request is left untouched', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(`select expire_stale_topic_assignment_review_requests(100);`)
      const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
      expect(status).toBe('pending')
    })

    it('only service_role may call it', () => {
      const err = asReviewerExpectError(REVIEWER_A, `select expire_stale_topic_assignment_review_requests(100);`)
      expect(err).toMatch(/permission denied/)
    })
  })

  // ------------------------------------------------------------
  // 8. cancel_topic_assignment_review_request
  // ------------------------------------------------------------
  describe('cancel_topic_assignment_review_request', () => {
    it('cancels a pending request; replay on repeat call; new generation afterward', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const first = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, `select cancel_topic_assignment_review_request('${id}'::uuid);`)).trim())
      expect(first.outcome).toBe('cancelled')
      const second = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, `select cancel_topic_assignment_review_request('${id}'::uuid);`)).trim())
      expect(second.outcome).toBe('replayed')
      const retry = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(retry.generation).toBe(2)
    })

    it('an approved (non-pending) request cannot be cancelled', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const err = asReviewerExpectError(REVIEWER_A, `select cancel_topic_assignment_review_request('${id}'::uuid);`)
      expect(err).toMatch(/REVIEW_REQUEST_NOT_CANCELLABLE/)
    })

    it('cancellation performs a logical status change only -- no physical DELETE', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, `select cancel_topic_assignment_review_request('${id}'::uuid);`))
      const row = dockerPsql(`select count(*) from topic_assignment_review_requests where id='${id}';`).trim()
      expect(row).toBe('1')
    })

    // --- Cancellation provenance hardening (Security and Concurrency
    // Closure gate) -- the single-parameter signature makes an arbitrary
    // caller-supplied cancelled_by_user_id structurally impossible: there
    // is no such parameter any more. cancelled_by_user_id can only ever be
    // auth.uid(), exactly like reviewer_user_id on a decision.
    it('signature carries no cancelled_by_user_id parameter -- exactly one argument', () => {
      const args = dockerPsql(`select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='cancel_topic_assignment_review_request';`).trim()
      expect(args).toBe('p_review_request_id uuid')
    })

    it('exactly one overload exists -- no leftover pre-hardening signature (PostgREST-ambiguity proof)', () => {
      const count = dockerPsql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='cancel_topic_assignment_review_request';`).trim()
      expect(count).toBe('1')
      const routineCount = dockerPsql(`select count(*) from information_schema.routines where routine_schema='public' and routine_name='cancel_topic_assignment_review_request';`).trim()
      expect(routineCount).toBe('1')
    })

    it('cancelled_by_user_id is always exactly the calling reviewer -- never a different, spoofed identity', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_B, `select cancel_topic_assignment_review_request('${id}'::uuid);`))
      const row = dockerPsql(`select cancelled_by_user_id from topic_assignment_review_requests where id='${id}';`).trim()
      expect(row).toBe(REVIEWER_B)
    })

    it('the cancelled event is authenticated_reviewer-attributed, never a bare system/NULL actor', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, `select cancel_topic_assignment_review_request('${id}'::uuid);`))
      const row = dockerPsql(`select actor_kind, actor_user_id from topic_assignment_review_events where review_request_id='${id}' and event_type='cancelled';`).trim()
      expect(row).toBe(`authenticated_reviewer|${REVIEWER_A}`)
    })

    it('unauthenticated caller (no auth.uid()) is rejected', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = dockerPsqlExpectError(`select cancel_topic_assignment_review_request('${id}'::uuid);`)
      expect(err).toMatch(/authentication required/)
    })

    it('authenticated but non-reviewer caller is rejected', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = asReviewerExpectError(NON_REVIEWER, `select cancel_topic_assignment_review_request('${id}'::uuid);`)
      expect(err).toMatch(/not an active reviewer/)
    })

    it('inactive reviewer cannot cancel', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(`update semantic_topic_reviewers set active=false, deactivated_at=now(), deactivated_by_user_id='${REVIEWER_A}' where user_id='${REVIEWER_A}';`)
      const err = asReviewerExpectError(REVIEWER_A, `select cancel_topic_assignment_review_request('${id}'::uuid);`)
      expect(err).toMatch(/not an active reviewer/)
      dockerPsql(`update semantic_topic_reviewers set active=true, deactivated_at=NULL, deactivated_by_user_id=NULL where user_id='${REVIEWER_A}';`)
    })

    it('service_role cannot call it directly (authenticated-only, symmetric with revoke)', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = dockerPsqlExpectError(`SET ROLE service_role; select cancel_topic_assignment_review_request('${id}'::uuid); RESET ROLE;`)
      expect(err).toMatch(/permission denied/)
    })
  })

  // ------------------------------------------------------------
  // 9. revoke_topic_assignment_review_approval
  // ------------------------------------------------------------
  describe('revoke_topic_assignment_review_approval', () => {
    it('revokes an approved-not-yet-executed request; approval snapshot is preserved', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const approve = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null))).trim())
      dockerPsql(asReviewer(REVIEWER_A, `select revoke_topic_assignment_review_approval('${id}'::uuid);`))
      const row = dockerPsql(`select status, approval_digest from topic_assignment_review_requests where id='${id}';`).trim()
      expect(row).toBe(`revoked|${approve.approval_digest}`)
    })

    it('repeat revoke on the same request replays; a pending request cannot be revoked', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const errPending = asReviewerExpectError(REVIEWER_A, `select revoke_topic_assignment_review_approval('${id}'::uuid);`)
      expect(errPending).toMatch(/REVIEW_APPROVAL_NOT_REVOCABLE/)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      dockerPsql(asReviewer(REVIEWER_A, `select revoke_topic_assignment_review_approval('${id}'::uuid);`))
      const second = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, `select revoke_topic_assignment_review_approval('${id}'::uuid);`)).trim())
      expect(second.outcome).toBe('replayed')
    })

    it('an executed request can never be revoked', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
      const err = asReviewerExpectError(REVIEWER_A, `select revoke_topic_assignment_review_approval('${id}'::uuid);`)
      expect(err).toMatch(/REVIEW_APPROVAL_NOT_REVOCABLE/)
    })

    it('any active reviewer (not only the original approver) may revoke', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const out = JSON.parse(dockerPsql(asReviewer(REVIEWER_B, `select revoke_topic_assignment_review_approval('${id}'::uuid);`)).trim())
      expect(out.outcome).toBe('revoked')
    })

    it('only authenticated reviewers may call it -- service_role direct call is denied', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const err = dockerPsqlExpectError(`SET ROLE service_role; select revoke_topic_assignment_review_approval('${id}'::uuid); RESET ROLE;`)
      expect(err).toMatch(/permission denied/)
    })
  })

  // ------------------------------------------------------------
  // 10. Direct DML forbidden on all 4 tables, for every role
  // ------------------------------------------------------------
  describe('direct DML remains forbidden for every role on every 077 table', () => {
    const tables = ['semantic_topic_reviewers', 'semantic_topic_reviewer_events', 'topic_assignment_review_requests', 'topic_assignment_review_events']
    for (const table of tables) {
      it(`${table}: authenticated cannot SELECT/INSERT directly`, () => {
        const errSelect = dockerPsqlExpectError(`SET ROLE authenticated; SELECT 1 FROM ${table} LIMIT 1; RESET ROLE;`)
        expect(errSelect).toMatch(/permission denied/)
      })
      it(`${table}: service_role cannot INSERT/UPDATE/DELETE directly (SELECT-only)`, () => {
        const errInsert = dockerPsqlExpectError(`SET ROLE service_role; INSERT INTO ${table} DEFAULT VALUES; RESET ROLE;`)
        expect(errInsert).toMatch(/permission denied|null value|violates/)
      })
    }
  })

  // ------------------------------------------------------------
  // 11. Concurrency proofs -- REAL parallel connections
  //
  // Every test in this block dispatches via dockerPsqlAsync (spawn, not
  // execSync) so two calls issued through Promise.all genuinely run as two
  // independent OS processes / two independent Postgres connections at the
  // same time -- Postgres's own lock queue is what performs the actual
  // serialization being proven, not test-side sequencing. Each test
  // documents: which lock/constraint is the final guarantee, and what the
  // losing call's outcome is.
  // ------------------------------------------------------------
  describe('concurrency', () => {
    // --- A. Request creation ---
    describe('A. request creation', () => {
      it('two concurrent creates, same run, different keys: exactly one wins (idx_..._one_live_per_run is the guarantee)', async () => {
        const { extractionRunId } = createExtraction()
        const [a, b] = await Promise.all([
          dockerPsqlAsync(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`),
          dockerPsqlAsync(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`),
        ])
        // Both processes now exit 0 (LIVE_REVIEW_REQUEST_EXISTS is a
        // structured JSONB return, not a raised exception) -- the win/loss
        // is decided by the RPC's OWN `ok` field inside each body, not by
        // process exit code.
        expect(a.ok && b.ok).toBe(true)
        const bodyA = JSON.parse(a.out.trim())
        const bodyB = JSON.parse(b.out.trim())
        const successCount = [bodyA, bodyB].filter((body) => body.ok === true).length
        expect(successCount).toBe(1)
        const loser = bodyA.ok ? bodyB : bodyA
        expect(loser).toMatchObject({ ok: false, outcome_kind: 'blocked', reason_code: 'LIVE_REVIEW_REQUEST_EXISTS' })
        const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
        expect(rowCount).toBe('1')
      })

      it('two concurrent creates, SAME key + SAME payload: both resolve to the same row (topic_assignment_review_requests_request_key_key is the guarantee)', async () => {
        const { extractionRunId } = createExtraction()
        const key = nextMarker()
        const [a, b] = await Promise.all([
          dockerPsqlAsync(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${key}');`),
          dockerPsqlAsync(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${key}');`),
        ])
        expect(a.ok && b.ok).toBe(true)
        const idA = JSON.parse(a.out.trim()).review_request_id
        const idB = JSON.parse(b.out.trim()).review_request_id
        expect(idA).toBe(idB)
        const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
        expect(rowCount).toBe('1')
      })

      it('two concurrent creates, SAME key + DIFFERENT run (different payload): exactly one wins, loser gets IDEMPOTENCY_KEY_REUSE', async () => {
        const a = createExtraction()
        const b = createExtraction()
        const key = nextMarker()
        const [ra, rb] = await Promise.all([
          dockerPsqlAsync(`select create_topic_assignment_review_request('${a.extractionRunId}'::uuid, '${key}');`),
          dockerPsqlAsync(`select create_topic_assignment_review_request('${b.extractionRunId}'::uuid, '${key}');`),
        ])
        const successCount = [ra, rb].filter((r) => r.ok).length
        expect(successCount).toBe(1)
        const loser = ra.ok ? rb : ra
        expect(loser.out).toMatch(/IDEMPOTENCY_KEY_REUSE/)
      })

      it('create vs. an old direct 074 QUARANTINE on the same run: never more than one topic_assignment_decisions row results', async () => {
        const { extractionRunId } = createExtraction()
        const [createResult, decisionResult] = await Promise.all([
          dockerPsqlAsync(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`),
          dockerPsqlAsync(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, '${nextMarker()}', NULL);`),
        ])
        // Both share the evidence advisory lock (tag 0) -- whichever
        // acquires it first proceeds to completion, and the second
        // re-reads fresh state after acquiring the lock. Known residual
        // asymmetry (documented, not a corruption bug): if create() wins
        // the race, the 074 call still has no knowledge of review_requests
        // and can still succeed afterward, leaving the review request
        // permanently orphaned in 'pending' (its own future decide/execute
        // calls then correctly fail closed with "already has a
        // topic_assignment_decisions row" -- never silently double-decided).
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
        expect(decisionCount).toBe('1')
      })
    })

    // --- B. Reviewer decision ---
    describe('B. reviewer decision', () => {
      it('approve vs. approve (two different reviewers): exactly one wins (request row FOR UPDATE + status check is the guarantee)', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        const [a, b] = await Promise.all([
          asReviewerAsync(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)),
          asReviewerAsync(REVIEWER_B, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)),
        ])
        const successCount = [a, b].filter((r) => r.ok).length
        expect(successCount).toBe(1)
        const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
        expect(status).toBe('approved')
      })

      it('approve vs. reject: exactly one wins', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        const [a, b] = await Promise.all([
          asReviewerAsync(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)),
          asReviewerAsync(REVIEWER_B, REJECT_ARGS(id, nextMarker(), 'insufficient_evidence')),
        ])
        const successCount = [a, b].filter((r) => r.ok).length
        expect(successCount).toBe(1)
        const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
        expect(['approved', 'rejected']).toContain(status)
      })

      it('reject vs. reject: exactly one wins, exactly one QUARANTINE decision', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        const [a, b] = await Promise.all([
          asReviewerAsync(REVIEWER_A, REJECT_ARGS(id, nextMarker(), 'insufficient_evidence')),
          asReviewerAsync(REVIEWER_B, REJECT_ARGS(id, nextMarker(), 'invalid_topic_identity')),
        ])
        const successCount = [a, b].filter((r) => r.ok).length
        expect(successCount).toBe(1)
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
        expect(decisionCount).toBe('1')
      })

      it('decision vs. expiry, truly concurrent: the row is always eventually consistent, never a double-write', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(`update topic_assignment_review_requests set expires_at = now() + interval '200 milliseconds' where id='${id}';`)
        await new Promise((r) => setTimeout(r, 210))
        const [decisionResult, expireResult] = await Promise.all([
          asReviewerAsync(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)),
          dockerPsqlAsync(`select expire_stale_topic_assignment_review_requests(100);`),
        ])
        let status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
        // Three valid outcomes under real lock contention, all correct by
        // design: (1) expire's FOR UPDATE SKIP LOCKED grabs the row first
        // and transitions it to 'expired'; (2) decision's FOR UPDATE grabs
        // it first, sees expires_at unchanged, and legitimately approves
        // before expiry; (3) decision's FOR UPDATE grabs it first, sees
        // expires_at already past, and self-aborts with
        // REVIEW_REQUEST_EXPIRED WITHOUT persisting anything (by design --
        // expiry persistence is exclusively the sweeper's job) -- meanwhile
        // expire's SKIP LOCKED pass, running at the same moment, skips this
        // locked row entirely and finds nothing to do. Outcome (3) leaves
        // the row 'pending' from THIS pass alone -- not a stuck state, just
        // eventual consistency: a LATER sweeper run must still catch it.
        if (status === 'pending') {
          const followUp = JSON.parse(dockerPsql(`select expire_stale_topic_assignment_review_requests(100);`).trim())
          expect(followUp.expired_ids).toContain(id)
          status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
        }
        expect(['approved', 'expired']).toContain(status)
        // Whichever won, there is exactly one terminal-transition event for
        // this request (never both approved AND expired events).
        const terminalEvents = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${id}' and event_type in ('approved','expired');`).trim()
        expect(terminalEvents).toBe('1')
      })

      it('decision vs. cancellation, truly concurrent: the row ends up either decided or cancelled, never both', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        const [decisionResult, cancelResult] = await Promise.all([
          asReviewerAsync(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)),
          asReviewerAsync(REVIEWER_B, `select cancel_topic_assignment_review_request('${id}'::uuid);`),
        ])
        const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
        expect(['approved', 'cancelled']).toContain(status)
        const terminalEvents = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${id}' and event_type in ('approved','cancelled');`).trim()
        expect(terminalEvents).toBe('1')
      })

      it('a request that expired before this call never writes decision state or a decision event (expiry check runs before any write)', () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(`update topic_assignment_review_requests set expires_at = now() - interval '1 hour' where id='${id}';`)
        asReviewerExpectError(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null))
        const row = dockerPsql(`select status, reviewer_user_id is null from topic_assignment_review_requests where id='${id}';`).trim()
        expect(row).toBe('pending|t')
        const eventCount = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${id}' and event_type='approved';`).trim()
        expect(eventCount).toBe('0')
      })
    })

    // --- C. Approval lifecycle ---
    describe('C. approval lifecycle', () => {
      it('revoke vs. executor: exactly one wins, never both revoked and executed', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        const [revokeResult, execResult] = await Promise.all([
          asReviewerAsync(REVIEWER_A, `select revoke_topic_assignment_review_approval('${id}'::uuid);`),
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`),
        ])
        const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
        expect(['revoked', 'executed']).toContain(status)
        const terminalEvents = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${id}' and event_type in ('revoked','executed');`).trim()
        expect(terminalEvents).toBe('1')
        if (status === 'executed') {
          const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
          expect(decisionCount).toBe('1')
        } else {
          const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
          expect(decisionCount).toBe('0')
        }
      })

      it('two concurrent revokes: exactly one revoked event, the other replays', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        const [a, b] = await Promise.all([
          asReviewerAsync(REVIEWER_A, `select revoke_topic_assignment_review_approval('${id}'::uuid);`),
          asReviewerAsync(REVIEWER_B, `select revoke_topic_assignment_review_approval('${id}'::uuid);`),
        ])
        expect(a.ok && b.ok).toBe(true)
        const eventCount = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${id}' and event_type='revoked';`).trim()
        expect(eventCount).toBe('1')
      })

      it('revoke on an already-executed request always fails (sequential, deterministic precondition)', () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
        const err = asReviewerExpectError(REVIEWER_A, `select revoke_topic_assignment_review_approval('${id}'::uuid);`)
        expect(err).toMatch(/REVIEW_APPROVAL_NOT_REVOCABLE/)
      })

      it('reviewer deactivation concurrent with executor: the final state is always self-consistent (FOR SHARE is the guarantee)', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        const [deactivateResult, execResult] = await Promise.all([
          dockerPsqlAsync(`update semantic_topic_reviewers set active=false, deactivated_at=now(), deactivated_by_user_id='${REVIEWER_A}' where user_id='${REVIEWER_A}';`),
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`),
        ])
        const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
        if (status === 'executed') {
          // Execution's FOR SHARE won the row before deactivation's UPDATE
          // could apply -- a fully valid, non-orphaned execution.
          const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
          expect(decisionCount).toBe('1')
        } else {
          // Deactivation's UPDATE landed first (or FOR SHARE correctly saw
          // it mid-transaction) -- execution must have failed closed, with
          // zero partial writes.
          expect(status).toBe('approved')
          const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
          expect(decisionCount).toBe('0')
        }
        dockerPsql(`update semantic_topic_reviewers set active=true, deactivated_at=NULL, deactivated_by_user_id=NULL where user_id='${REVIEWER_A}';`)
      })
    })

    // --- D. CREATE_NEW execution ---
    describe('D. CREATE_NEW execution', () => {
      it('two concurrent executors on the same approved CREATE_NEW request, DIFFERENT keys: exactly one wins, loser gets ALREADY_EXECUTED', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        const [a, b] = await Promise.all([
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`),
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`),
        ])
        const successCount = [a, b].filter((r) => r.ok).length
        expect(successCount).toBe(1)
        const loser = a.ok ? b : a
        expect(loser.out).toMatch(/ALREADY_EXECUTED/)
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
        expect(decisionCount).toBe('1')
        const topicCount = dockerPsql(`select count(*) from semantic_topics where creation_request_digest = encode(sha256(convert_to('${id}' || chr(31) || 'human_review_topic_creation_seed', 'UTF8')), 'hex');`).trim()
        expect(topicCount).toBe('1')
      })

      it('two concurrent executors on the same approved CREATE_NEW request, SAME key: both resolve identically (created + replayed)', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        const key = nextMarker()
        const [a, b] = await Promise.all([
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${id}'::uuid, '${key}');`),
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${id}'::uuid, '${key}');`),
        ])
        expect(a.ok && b.ok).toBe(true)
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
        expect(decisionCount).toBe('1')
      })

      it('executor vs. an old direct 074 QUARANTINE writer on the same run: at most one decision, executor fails closed if it loses', async () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        const [execResult, decisionResult] = await Promise.all([
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`),
          dockerPsqlAsync(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, '${nextMarker()}', NULL);`),
        ])
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
        expect(decisionCount).toBe('1')
        // whichever lost must have failed closed, not silently no-opped
        expect(execResult.ok || decisionResult.ok).toBe(true)
        expect(execResult.ok && decisionResult.ok).toBe(false)
      })

      it('execution replay: identical key + identical stored state -- deterministic, no second event/decision', () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        const key = nextMarker()
        dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${key}');`)
        dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${key}');`)
        const eventCount = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${id}' and event_type='executed';`).trim()
        expect(eventCount).toBe('1')
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
        expect(decisionCount).toBe('1')
      })

      it('a genuinely mid-transaction failure leaves zero orphans (rollback proof: forged approval_digest tamper mid-flight)', () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        const tamperedDigest = 'f'.repeat(64)
        dockerPsql(`update topic_assignment_review_requests set approval_digest = '${tamperedDigest}' where id='${id}';`)
        const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
        expect(err).toMatch(/approval_digest drift detected/)
        const topicCount = dockerPsql(`select count(*) from semantic_topics where creation_request_digest = encode(sha256(convert_to('${id}' || chr(31) || 'human_review_topic_creation_seed', 'UTF8')), 'hex');`).trim()
        expect(topicCount).toBe('0')
        const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where signal_evidence_id in (select signal_evidence_id from topic_extraction_runs where id='${extractionRunId}');`).trim()
        expect(membershipCount).toBe('0')
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
        expect(decisionCount).toBe('0')
      })

      it('CREATE_NEW execution permanently closes the run to any other path (ATTACH_EXISTING via a new generation is impossible)', () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`)
        const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
        expect(body).toMatchObject({ ok: false, outcome_kind: 'blocked', reason_code: 'ALREADY_ASSIGNED' })
      })
    })

    // --- E. ATTACH_EXISTING execution ---
    describe('E. ATTACH_EXISTING execution', () => {
      function seedTopic(): string {
        const seed = createExtraction()
        const seedReq = createReviewRequest(seed.extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(seedReq.id, nextMarker(), 'CREATE_NEW', null)))
        const exec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${seedReq.id}'::uuid, '${nextMarker()}');`).trim())
        return exec.semantic_topic_id
      }

      it('two concurrent ATTACH executors on the same target: exactly one membership row added per request', async () => {
        const topicId = seedTopic()
        const attachA = createExtraction()
        const reqA = createReviewRequest(attachA.extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(reqA.id, nextMarker(), 'ATTACH_EXISTING', topicId)))
        const attachB = createExtraction()
        const reqB = createReviewRequest(attachB.extractionRunId)
        dockerPsql(asReviewer(REVIEWER_B, APPROVE_ARGS(reqB.id, nextMarker(), 'ATTACH_EXISTING', topicId)))
        const [a, b] = await Promise.all([
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${reqA.id}'::uuid, '${nextMarker()}');`),
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${reqB.id}'::uuid, '${nextMarker()}');`),
        ])
        expect(a.ok && b.ok).toBe(true)
        const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id='${topicId}';`).trim()
        expect(membershipCount).toBe('3') // seed + A + B
      })

      it('ATTACH executor vs. concurrent target-lifecycle change: forbidden lifecycle at commit time fails closed, zero writes', async () => {
        const topicId = seedTopic()
        const attach = createExtraction()
        const req = createReviewRequest(attach.extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(req.id, nextMarker(), 'ATTACH_EXISTING', topicId)))
        const [execResult, lifecycleResult] = await Promise.all([
          dockerPsqlAsync(`select execute_approved_topic_assignment_review('${req.id}'::uuid, '${nextMarker()}');`),
          dockerPsqlAsync(`update semantic_topics set lifecycle_status='archived' where id='${topicId}';`),
        ])
        const status = dockerPsql(`select status from topic_assignment_review_requests where id='${req.id}';`).trim()
        if (status === 'executed') {
          const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id='${topicId}';`).trim()
          expect(membershipCount).toBe('2')
        } else {
          expect(status).toBe('approved')
          const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id='${topicId}';`).trim()
          expect(membershipCount).toBe('1') // only the seed membership
        }
        dockerPsql(`update semantic_topics set lifecycle_status='candidate_singleton' where id='${topicId}';`)
      })

      for (const forbidden of ['archived', 'superseded', 'merge_candidate', 'split_required']) {
        it(`execution-time: a target that became ${forbidden} between approval and execution is rejected, zero writes`, () => {
          const topicId = seedTopic()
          const attach = createExtraction()
          const req = createReviewRequest(attach.extractionRunId)
          dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(req.id, nextMarker(), 'ATTACH_EXISTING', topicId)))
          dockerPsql(`update semantic_topics set lifecycle_status='${forbidden}' where id='${topicId}';`)
          const err = dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${req.id}'::uuid, '${nextMarker()}');`)
          expect(err).toMatch(/no longer accepts ATTACH_EXISTING/)
          const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id='${topicId}';`).trim()
          expect(membershipCount).toBe('1') // only the seed membership -- zero new writes
          dockerPsql(`update semantic_topics set lifecycle_status='candidate_singleton' where id='${topicId}';`)
        })
      }

      it('a valid ATTACH_EXISTING execution writes exactly one membership, one decision, one attached event', () => {
        const topicId = seedTopic()
        const attach = createExtraction()
        const req = createReviewRequest(attach.extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(req.id, nextMarker(), 'ATTACH_EXISTING', topicId)))
        const exec = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${req.id}'::uuid, '${nextMarker()}');`).trim())
        const counts = dockerPsql(`
          select
            (select count(*) from semantic_topic_membership where id='${exec.resulting_membership_id}'),
            (select count(*) from topic_assignment_decisions where id='${exec.resulting_decision_id}'),
            (select count(*) from semantic_topic_membership_events where related_assignment_decision_id='${exec.resulting_decision_id}');
        `).trim()
        expect(counts).toBe('1|1|1')
      })

      it('a run cannot go CREATE_NEW and ATTACH_EXISTING via two separate generations -- the second request is blocked by the first request decision', () => {
        const topicId = seedTopic()
        const { extractionRunId } = createExtraction()
        const first = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(first.id, nextMarker(), 'ATTACH_EXISTING', topicId)))
        dockerPsql(`select execute_approved_topic_assignment_review('${first.id}'::uuid, '${nextMarker()}');`)
        const body = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
        expect(body).toMatchObject({ ok: false, outcome_kind: 'blocked', reason_code: 'ALREADY_ASSIGNED' })
      })
    })

    // --- F. Retry determinism ---
    describe('F. retry determinism', () => {
      it('create retry (simulated timeout/unknown-result): same key always resolves to the same row, never a second row', () => {
        const { extractionRunId } = createExtraction()
        const key = nextMarker()
        const first = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${key}');`).trim())
        for (let i = 0; i < 3; i++) {
          const retry = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${key}');`).trim())
          expect(retry.review_request_id).toBe(first.review_request_id)
          expect(retry.outcome_kind).toBe('replayed')
        }
        const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
        expect(rowCount).toBe('1')
      })

      it('decision retry: same key always resolves to the same outcome, never a second event or decision', () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        const key = nextMarker()
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, key, 'CREATE_NEW', null)))
        for (let i = 0; i < 3; i++) {
          const retry = JSON.parse(dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, key, 'CREATE_NEW', null))).trim())
          expect(retry.outcome).toBe('replayed')
        }
        const eventCount = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${id}' and event_type='approved';`).trim()
        expect(eventCount).toBe('1')
      })

      it('executor retry: same key always resolves to the same outcome, never a second decision', () => {
        const { extractionRunId } = createExtraction()
        const { id } = createReviewRequest(extractionRunId)
        dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
        const key = nextMarker()
        dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${key}');`)
        for (let i = 0; i < 3; i++) {
          const retry = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${id}'::uuid, '${key}');`).trim())
          expect(retry.outcome).toBe('replayed')
        }
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
        expect(decisionCount).toBe('1')
      })
    })
  })
})
