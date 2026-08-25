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

vi.setConfig({ testTimeout: 30000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MIGRATION_077_PATH = join(process.cwd(), 'supabase/migrations/077_semantic_topic_human_review_schema_foundation.sql')
const MIGRATION_078_PATH = join(process.cwd(), 'supabase/migrations/078_semantic_topic_human_review_rpcs.sql')

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

const APPROVE_ARGS = (reqId: string, key: string, outcome: 'CREATE_NEW' | 'ATTACH_EXISTING', target: string | null) => `
  select record_topic_assignment_review_decision(
    '${reqId}'::uuid, '${key}', 'approved',
    '${MARKER} topic label', 'A definition.', 'A scope.', 'Inclusion criteria.', 'Exclusion criteria.',
    true, 'adequate', 'no_duplicate_found', '${outcome}', ${target ? `'${target}'::uuid` : 'NULL'},
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
    it('078 second run is a byte-exact no-op for all 8 RPCs', () => {
      const result = runMigration(MIGRATION_078_PATH)
      expect(result.threw).toBe(false)
      for (const name of NEW_RPC_NAMES) {
        expect(result.out).toMatch(new RegExp(`${name} already exists and matches exactly -- no-op\\.`))
      }
      expect(result.out).toMatch(/final self-check passed/)
      expect(result.out).not.toMatch(/drift/i)
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

    it('rejects confidence >= 0.8500 (automatic-path territory, not human review)', () => {
      const { extractionRunId } = createExtraction({ confidence: 0.9 })
      const err = dockerPsqlExpectError(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/requires confidence </)
    })

    it('rejects generic (non-specific) extractions', () => {
      const { extractionRunId } = createExtraction({ specificity: 'generic' })
      const err = dockerPsqlExpectError(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/specificity=specific/)
    })

    it('rejects extractions with zero supporting_spans', () => {
      const { extractionRunId } = createExtraction({ supporting_spans: [] })
      const err = dockerPsqlExpectError(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/at least one supporting_spans/)
    })

    it('identical idempotency_key + identical payload replays the same row', () => {
      const { extractionRunId } = createExtraction()
      const key = nextMarker()
      const first = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${key}');`).trim())
      const second = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${key}');`).trim())
      expect(first.outcome).toBe('created')
      expect(second.outcome).toBe('replayed')
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

    it('a second live (pending) request on the same run is rejected', () => {
      const { extractionRunId } = createExtraction()
      createReviewRequest(extractionRunId)
      const err = dockerPsqlExpectError(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/already has a live \(pending\/approved\) review request/)
    })

    it('a run with an existing topic_assignment_decisions row can never get a new request', () => {
      const { extractionRunId } = createExtraction()
      dockerPsql(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, '${nextMarker()}', NULL);`)
      const err = dockerPsqlExpectError(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/already has a topic_assignment_decisions row/)
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
      const err = dockerPsqlExpectError(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`)
      expect(err).toMatch(/already has a topic_assignment_decisions row/)
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
      dockerPsql(`select cancel_topic_assignment_review_request('${id}'::uuid, '${REVIEWER_A}');`)
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
      const first = JSON.parse(dockerPsql(`select cancel_topic_assignment_review_request('${id}'::uuid, '${REVIEWER_A}');`).trim())
      expect(first.outcome).toBe('cancelled')
      const second = JSON.parse(dockerPsql(`select cancel_topic_assignment_review_request('${id}'::uuid, '${REVIEWER_A}');`).trim())
      expect(second.outcome).toBe('replayed')
      const retry = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`).trim())
      expect(retry.generation).toBe(2)
    })

    it('an approved (non-pending) request cannot be cancelled', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const err = dockerPsqlExpectError(`select cancel_topic_assignment_review_request('${id}'::uuid, '${REVIEWER_A}');`)
      expect(err).toMatch(/REVIEW_REQUEST_NOT_CANCELLABLE/)
    })

    it('cancellation performs a logical status change only -- no physical DELETE', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(`select cancel_topic_assignment_review_request('${id}'::uuid, '${REVIEWER_A}');`)
      const row = dockerPsql(`select count(*) from topic_assignment_review_requests where id='${id}';`).trim()
      expect(row).toBe('1')
    })

    it('only service_role may call it', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const err = asReviewerExpectError(REVIEWER_A, `select cancel_topic_assignment_review_request('${id}'::uuid, '${REVIEWER_A}');`)
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
  // 11. Concurrency proofs -- real parallel connections
  // ------------------------------------------------------------
  describe('concurrency', () => {
    it('two concurrent create calls on the same run: exactly one created row survives', async () => {
      const { extractionRunId } = createExtraction()
      const results = await Promise.all([
        new Promise<string>((resolve) => resolve(dockerPsqlExpectError(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`))),
        new Promise<string>((resolve) => resolve(dockerPsqlExpectError(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}');`))),
      ])
      const successCount = results.filter((r) => r === '__NO_ERROR__').length
      expect(successCount).toBe(1)
      const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
      expect(rowCount).toBe('1')
    })

    it('two concurrent reviewer decisions on the same request: exactly one wins, the other sees a conflict', async () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      const results = await Promise.all([
        new Promise<string>((resolve) => resolve(asReviewerExpectError(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))),
        new Promise<string>((resolve) => resolve(asReviewerExpectError(REVIEWER_B, REJECT_ARGS(id, nextMarker(), 'insufficient_evidence')))),
      ])
      const successCount = results.filter((r) => r === '__NO_ERROR__').length
      expect(successCount).toBe(1)
      const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
      expect(['approved', 'rejected']).toContain(status)
    })

    it('two concurrent executors on the same approved request: exactly one topic/membership/decision survives', async () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      const results = await Promise.all([
        new Promise<string>((resolve) => resolve(dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`))),
        new Promise<string>((resolve) => resolve(dockerPsqlExpectError(`select execute_approved_topic_assignment_review('${id}'::uuid, '${nextMarker()}');`))),
      ])
      const successCount = results.filter((r) => r === '__NO_ERROR__').length
      expect(successCount).toBe(1)
      const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
      expect(decisionCount).toBe('1')
    })

    it('decision vs. expiry race: expiring after a decision already landed is a no-op (expire only ever touches pending rows)', () => {
      const { extractionRunId } = createExtraction()
      const { id } = createReviewRequest(extractionRunId)
      dockerPsql(asReviewer(REVIEWER_A, APPROVE_ARGS(id, nextMarker(), 'CREATE_NEW', null)))
      dockerPsql(`update topic_assignment_review_requests set expires_at = now() - interval '1 hour' where id='${id}';`)
      const out = JSON.parse(dockerPsql(`select expire_stale_topic_assignment_review_requests(100);`).trim())
      expect(out.expired_ids).not.toContain(id)
      const status = dockerPsql(`select status from topic_assignment_review_requests where id='${id}';`).trim()
      expect(status).toBe('approved')
    })
  })
})
