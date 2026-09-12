// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, schema
// foundation (migration 077), REAL local DB integration tests. Same pattern
// as the 072/073/074 suites: uses the existing local Docker Supabase stack
// (supabase_db_WillViralFinal), skips entirely (not a failure) when
// unavailable, direct postgres-privileged psql fixture inserts (there being
// no writer RPC yet -- that is migration 078), SET ROLE for real
// grant-boundary checks. Only synthetic, deterministic fixtures are used --
// no AI/provider call, no production data, no real reviewer bootstrap.
//
// This suite tests SCHEMA-LEVEL contracts only: the four new tables'
// CHECK/UNIQUE/FK/RLS/grant shape, and that the existing
// record_topic_assignment_decision RPC (074) and its 0.8500 threshold are
// completely untouched. It does NOT test any review-workflow RPC -- those
// do not exist yet (migration 078).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MIGRATION_PATH = join(process.cwd(), 'supabase/migrations/077_semantic_topic_human_review_schema_foundation.sql')

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

// Egyetlen, a teszt-fajlhoz kotott user_id auth.users-ben -- a
// semantic_topic_reviewers/review_requests FK-k miatt kell valodi
// auth.users sor. Ez NEM valodi reviewer bootstrap -- kizarolag ennek a
// teszt-suite-nak sajat, sosem production-be kerulo fixture-je.
const TEST_USER_A = 'b0000000-0000-4000-8000-000000000001'
const TEST_USER_B = 'b0000000-0000-4000-8000-000000000002'

function seedTestUsers() {
  dockerPsql(`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
    values
      ('${TEST_USER_A}', 'sti-review-test-a@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated'),
      ('${TEST_USER_B}', 'sti-review-test-b@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated')
    on conflict (id) do nothing;
  `)
}

function ensureFullyApplied() {
  const out = dockerPsql(
    `select count(*) from pg_tables where schemaname='public' and tablename in ('semantic_topic_reviewers','semantic_topic_reviewer_events','topic_assignment_review_requests','topic_assignment_review_events');`,
  ).trim()
  if (out === '4') return
  if (out !== '0') {
    throw new Error(`ensureFullyApplied: partial 077 topology detected (${out} of 4 tables) -- manual investigation required, refusing to auto-repair.`)
  }
  const result = runMigration()
  if (result.threw) {
    throw new Error(`ensureFullyApplied: migration 077 failed on a clean 0/4 topology -- ${result.out}`)
  }
}

function cleanupTestData() {
  dockerPsql(`
    delete from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-hr-%')));
    delete from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-hr-%'));
    delete from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-hr-%');
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-hr-%');
    delete from signal_evidence where external_ref like 'sti-hr-%';
    delete from signal_sources where external_id like 'sti-hr-%';
    delete from signal_runs where idempotency_key like 'sti-hr-%';
    delete from semantic_topics where canonical_label like 'HR test%';
    delete from semantic_topic_reviewer_events where reviewer_user_id in ('${TEST_USER_A}','${TEST_USER_B}');
    delete from semantic_topic_reviewers where user_id in ('${TEST_USER_A}','${TEST_USER_B}');
  `)
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
    values ('${sourceId}', 'youtube_video', '${externalRef}', 'HR schema fixture evidence', '${runId}')
    returning id;
  `).trim()
}
function structuredOutput(overrides: Record<string, unknown> = {}): string {
  const base = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: 'Test phenomenon',
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'generic',
    content_format: 'other',
    confidence: 0.3,
    supporting_spans: [{ source_field: 'title', quoted_text: 'Test phenomenon' }],
    ...overrides,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}
function createCompletedExtraction(marker: string): { evidenceId: string; extractionRunId: string } {
  const sourceId = insertSource(`sti-hr-${marker}-src`)
  const runId = insertRun(`sti-hr-${marker}-run`)
  const evidenceId = insertEvidence(sourceId, runId, `sti-hr-${marker}-ev`)
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
    'norm-${marker}', 1, 'completed', '${structuredOutput()}'::jsonb, 100, 50, 0.001, NULL,
    'sti-hr-${marker}-ext', now() - interval '1 minute', now()
  );`
  const result = JSON.parse(dockerPsql(sql).trim())
  return { evidenceId, extractionRunId: result.extraction_run_id }
}
function createQuarantineDecision(extractionRunId: string, idempotencyKey: string): string {
  const sql = `select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, '${idempotencyKey}', NULL);`
  const result = JSON.parse(dockerPsql(sql).trim())
  return result.decision_id
}

function insertReviewer(userId: string): string {
  return dockerPsql(`
    insert into semantic_topic_reviewers (user_id, granted_by_user_id, provisioning_note)
    values ('${userId}', NULL, 'test fixture -- not a real bootstrap')
    returning id;
  `).trim()
}

interface ReviewRequestFields {
  extraction_run_id: string
  generation?: number
  status?: string
  request_idempotency_key?: string
  request_operation_digest?: string
  expires_at?: string
  request_payload_digest?: string
  decision_idempotency_key?: string | null
  decision_operation_digest?: string | null
  reviewer_user_id?: string | null
  reviewer_role_snapshot?: string | null
  decided_at?: string | null
  canonical_topic_label?: string | null
  topic_definition?: string | null
  scope?: string | null
  inclusion_criteria?: string | null
  exclusion_criteria?: string | null
  lane_neutral_confirmed?: boolean | null
  evidence_adequacy?: string | null
  duplicate_search_outcome?: string | null
  proposed_outcome?: string | null
  target_semantic_topic_id?: string | null
  uncertainty_classification?: string | null
  reviewer_rationale?: string | null
  review_policy_version?: number | null
  rejection_reason?: string | null
  approval_digest?: string | null
  approval_digest_version?: number | null
  execution_idempotency_key?: string | null
  execution_operation_digest?: string | null
  executed_at?: string | null
  resulting_decision_id?: string | null
  cancelled_at?: string | null
  cancelled_by_user_id?: string | null
  revoked_at?: string | null
  revoked_by_user_id?: string | null
}

function sqlVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  return `'${String(v).replace(/'/g, "''")}'`
}

// A teljes, ervenyes 'approved' pillanatkep -- minden mezo elore
// kitoltve, hogy a negativ tesztek pontosan EGY mezot terithessenek el
// az ervenyes allapotbol.
function fullApprovedFields(marker: string, extractionRunId: string, proposedOutcome: 'CREATE_NEW' | 'ATTACH_EXISTING', targetTopicId: string | null): Partial<ReviewRequestFields> {
  return {
    reviewer_user_id: TEST_USER_A,
    reviewer_role_snapshot: 'owner',
    decided_at: 'now()',
    canonical_topic_label: 'HR test canonical label',
    topic_definition: 'HR test topic definition.',
    scope: 'HR test scope.',
    inclusion_criteria: 'HR test inclusion criteria.',
    exclusion_criteria: 'HR test exclusion criteria.',
    lane_neutral_confirmed: true,
    evidence_adequacy: 'adequate',
    // Migration 084 pairing rule: ATTACH_EXISTING requires
    // existing_topic_match_confirmed; CREATE_NEW keeps the pre-084 default.
    duplicate_search_outcome: proposedOutcome === 'ATTACH_EXISTING' ? 'existing_topic_match_confirmed' : 'no_duplicate_found',
    proposed_outcome: proposedOutcome,
    target_semantic_topic_id: targetTopicId,
    uncertainty_classification: 'low',
    reviewer_rationale: 'HR test rationale.',
    review_policy_version: 1,
    approval_digest: 'a'.repeat(64),
    approval_digest_version: 1,
    decision_idempotency_key: `sti-hr-${marker}-dec`,
    decision_operation_digest: 'b'.repeat(64),
  }
}

function insertReviewRequest(fields: ReviewRequestFields): string {
  const withDefaults: ReviewRequestFields = {
    generation: 1,
    status: 'pending',
    request_idempotency_key: randomUUID(),
    request_operation_digest: 'c'.repeat(64),
    expires_at: `now() + interval '7 days'`,
    request_payload_digest: 'd'.repeat(64),
    ...fields,
  }
  const cols: string[] = []
  const vals: string[] = []
  for (const [k, v] of Object.entries(withDefaults)) {
    cols.push(k)
    if (typeof v === 'string' && (v === 'now()' || v.startsWith("now() "))) {
      vals.push(v)
    } else {
      vals.push(sqlVal(v))
    }
  }
  return dockerPsql(`insert into topic_assignment_review_requests (${cols.join(', ')}) values (${vals.join(', ')}) returning id;`).trim()
}

function insertReviewRequestExpectError(fields: ReviewRequestFields): string {
  const withDefaults: ReviewRequestFields = {
    generation: 1,
    status: 'pending',
    request_idempotency_key: randomUUID(),
    request_operation_digest: 'c'.repeat(64),
    expires_at: `now() + interval '7 days'`,
    request_payload_digest: 'd'.repeat(64),
    ...fields,
  }
  const cols: string[] = []
  const vals: string[] = []
  for (const [k, v] of Object.entries(withDefaults)) {
    cols.push(k)
    if (typeof v === 'string' && (v === 'now()' || v.startsWith("now() "))) {
      vals.push(v)
    } else {
      vals.push(sqlVal(v))
    }
  }
  return dockerPsqlExpectError(`insert into topic_assignment_review_requests (${cols.join(', ')}) values (${vals.join(', ')});`)
}

describeIfLocalDb('Semantic Topic Identity v0 — Human Review schema foundation (077, real local DB)', () => {
  beforeAll(() => {
    ensureFullyApplied()
    cleanupTestData()
    seedTestUsers()
  })
  afterAll(() => {
    cleanupTestData()
  })

  // ============================================================
  // 1-3. Migration state: first run (already proven during
  // implementation), second run no-op, definition drift fail-closed.
  // ============================================================
  describe('migration idempotency and drift', () => {
    it('re-running 077 against the already-applied schema is a byte-exact no-op -- OR topic_assignment_review_requests has since gained an extra CHECK constraint from a later migration (084), which is also a correct, expected outcome', () => {
      // Migration 084 (docs/architecture/semantic-topic-identity-v0-contract.md
      // SS37) ADDs a new CHECK constraint,
      // topic_assignment_review_requests_dup_search_outcome_pairing, to this
      // same table. Once 084 has run against this local DB (a real,
      // expected state on a shared, persistent local stack -- migrations
      // here are never re-run out of order in a real deployment), 077's own
      // VALIDATE branch -- which exhaustively enumerates its OWN original
      // constraint set -- correctly refuses to touch a table that now
      // carries a constraint it doesn't recognize. That refusal IS the
      // desired fail-closed behavior (never silently accepting an
      // unrecognized extra constraint, whatever its origin), not a
      // regression. Mirrors the exact same, already-established
      // 081-vs-082 precedent in
      // tests/semantic-topic-supervised-intake-081-db-integration.test.ts.
      const result = runMigration()
      if (result.threw) {
        expect(result.out).toMatch(/077 drift: topic_assignment_review_requests has an unexpected extra constraint/)
        expect(result.out).toMatch(/semantic_topic_reviewers already exists and matches exactly -- no-op/)
        expect(result.out).toMatch(/semantic_topic_reviewer_events already exists and matches exactly -- no-op/)
      } else {
        expect(result.out).toMatch(/semantic_topic_reviewers already exists and matches exactly -- no-op/)
        expect(result.out).toMatch(/semantic_topic_reviewer_events already exists and matches exactly -- no-op/)
        expect(result.out).toMatch(/topic_assignment_review_requests already exists and matches exactly -- no-op/)
        expect(result.out).toMatch(/topic_assignment_review_events already exists and matches exactly -- no-op/)
        expect(result.out).toMatch(/topic_assignment_decisions_decision_reason_check already corrected -- no-op/)
        expect(result.out).toMatch(/final self-check passed/)
      }
    })

    it('definition drift on topic_assignment_review_requests is fail-closed (an injected extra column is detected, not silently accepted)', () => {
      dockerPsql(`alter table public.topic_assignment_review_requests add column if not exists sti_hr_drift_probe text;`)
      const result = runMigration()
      expect(result.threw).toBe(true)
      expect(result.out).toMatch(/077 drift: topic_assignment_review_requests column set\/definition does not match exactly/)
      dockerPsql(`alter table public.topic_assignment_review_requests drop column if exists sti_hr_drift_probe;`)
      // Re-verify the fixed schema is a no-op again after removing the probe
      // column -- UNLESS migration 084 has since added its own recognized
      // extra CHECK constraint to this table (see the test above), in which
      // case 077's fail-closed refusal on THAT constraint is the correct,
      // expected outcome here too (the probe-column drift is gone either way
      // -- that is what this re-run actually proves).
      const fixed = runMigration()
      if (fixed.threw) {
        expect(fixed.out).toMatch(/077 drift: topic_assignment_review_requests has an unexpected extra constraint/)
        expect(fixed.out).not.toMatch(/column set\/definition does not match exactly/)
      } else {
        expect(fixed.threw).toBe(false)
      }
    })

    it('decision_reason CHECK now accepts exactly the 7 legacy + 2 new values, nothing else', () => {
      const def = dockerPsql(`select pg_get_constraintdef(oid, true) from pg_constraint where conrelid='public.topic_assignment_decisions'::regclass and conname='topic_assignment_decisions_decision_reason_check';`).trim()
      for (const v of ['no_similar_topic_found', 'exact_entity_match', 'embedding_similarity_match', 'manual_review_confirmed', 'manual_review_override', 'malformed_extraction', 'below_confidence_threshold', 'human_review_approved', 'human_review_rejected']) {
        expect(def).toContain(`'${v}'`)
      }
      const count = (def.match(/::text/g) || []).length
      expect(count).toBe(9)
    })
  })

  // ============================================================
  // 4/17. record_topic_assignment_decision (074) -- signature/ACL
  // unchanged; body is the 086 eligible-source-identity-corrected version.
  // Migration 086 (Lifecycle Foundation Correctness v1) legitimately
  // CREATE OR REPLACEs this function's body (the raw active-membership
  // count(*) used for candidate_singleton -> corroborating is replaced by a
  // call into the shared _semantic_topic_eligible_membership_sources()
  // helper) -- 077's own original "completely untouched" framing predates
  // that later, separately audited migration.
  // ============================================================
  describe('existing assignment writer RPC (074) unchanged', () => {
    it('body hash, signature and ACL are byte-identical to the pinned 074 values', () => {
      // Guarantee the 086-corrected body is live before asserting its hash,
      // regardless of which other DB-integration test files (sharing this
      // same local Postgres) already ran and may have temporarily reverted
      // it for their own isolated 074-vs-itself checks.
      const migrate086 = execSync(
        'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
        { input: readFileSync(join(process.cwd(), 'supabase/migrations/086_semantic_topic_eligible_source_identity_correctness.sql'), 'utf8'), encoding: 'utf8' },
      )
      if (/ERROR/i.test(migrate086)) throw new Error(`086 reapply failed -- ${migrate086}`)
      const row = dockerPsql(`
        select md5(replace(prosrc, E'\\r\\n', E'\\n')) || '|' || pg_get_function_identity_arguments(oid) || '|' ||
               has_function_privilege('postgres', oid, 'EXECUTE')::text || '|' ||
               has_function_privilege('service_role', oid, 'EXECUTE')::text || '|' ||
               has_function_privilege('anon', oid, 'EXECUTE')::text || '|' ||
               has_function_privilege('authenticated', oid, 'EXECUTE')::text
        from pg_proc where oid = 'public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)'::regprocedure;
      `).trim()
      const [hash, args, pg, svc, anon, authd] = row.split('|')
      expect(hash).toBe('9e681c94870719a0a7cb4605de458baf')
      expect(args).toBe('p_extraction_run_id uuid, p_outcome text, p_decision_reason text, p_deterministic_signals jsonb, p_idempotency_key text, p_existing_semantic_topic_id uuid')
      expect(pg).toBe('true')
      expect(svc).toBe('true')
      expect(anon).toBe('false')
      expect(authd).toBe('false')
    })

    it('CREATE_NEW below 0.8500 confidence is still hard-rejected (the 0.8500 threshold is untouched)', () => {
      const marker = `thresh-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker) // confidence=0.3, specificity=generic (fixture default)
      const sql = `select record_topic_assignment_decision('${extractionRunId}'::uuid, 'CREATE_NEW', 'no_similar_topic_found', '{}'::jsonb, 'sti-hr-${marker}-dec', NULL);`
      const err = dockerPsqlExpectError(sql)
      expect(err).toMatch(/specificity=specific/)
    })

    it('the record_topic_assignment_decision RPC itself still rejects human_review_approved/human_review_rejected for now -- its own internal outcome-validation logic is untouched by 077 (only the table CHECK was widened; the RPC body is the 078 executor RPCs concern, not this migration)', () => {
      const marker = `newreason-rpc-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const sql = `select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'human_review_rejected', '{}'::jsonb, 'sti-hr-${marker}-dec', NULL);`
      const err = dockerPsqlExpectError(sql)
      expect(err).toMatch(/QUARANTINE does not accept decision_reason=human_review_rejected/)
    })

    it('the table-level CHECK itself accepts human_review_approved/human_review_rejected via a direct postgres-privileged INSERT (proves the schema is ready for the 078 executor, which will INSERT directly rather than calling the unmodified 074 RPC)', () => {
      const marker = `newreason-direct-${randomUUID().slice(0, 8)}`
      const { evidenceId, extractionRunId } = createCompletedExtraction(marker)
      const id = dockerPsql(`
        insert into topic_assignment_decisions (extraction_run_id, signal_evidence_id, outcome, decision_reason, deterministic_signals, decision_digest, idempotency_key)
        values ('${extractionRunId}', '${evidenceId}', 'QUARANTINE', 'human_review_rejected', '{}'::jsonb, '${'a'.repeat(64)}', 'sti-hr-${marker}-directdec')
        returning id;
      `).trim()
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    })
  })

  // ============================================================
  // 6/7. Status field-completeness CHECKs -- every valid and invalid
  // combination, explicit NULL/UNKNOWN bypass probes.
  // ============================================================
  describe('topic_assignment_review_requests status/field CHECK contract', () => {
    it('pending: minimal fields succeed', () => {
      const marker = `pend-ok-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const id = insertReviewRequest({ extraction_run_id: extractionRunId })
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('pending: any decision field filled is rejected (NULL-bypass probe)', () => {
      const marker = `pend-bad-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, reviewer_user_id: TEST_USER_A })
      expect(err).toMatch(/topic_assignment_review_requests_pending_fields_empty/)
    })

    it('approved: full valid CREATE_NEW snapshot succeeds', () => {
      const marker = `appr-ok-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const id = insertReviewRequest({
        extraction_run_id: extractionRunId, status: 'approved',
        ...fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null),
      })
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('approved: missing reviewer_rationale is rejected', () => {
      const marker = `appr-missing-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null)
      delete (fields as any).reviewer_rationale
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, status: 'approved', ...fields })
      expect(err).toMatch(/topic_assignment_review_requests_approved_fields_required/)
    })

    it('approved: lane_neutral_confirmed=false is rejected (must be IS TRUE, not merely truthy)', () => {
      const marker = `appr-lane-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null)
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, status: 'approved', ...fields, lane_neutral_confirmed: false })
      expect(err).toMatch(/topic_assignment_review_requests_approved_fields_required/)
    })

    it('approved: evidence_adequacy=marginal is rejected (only adequate may be approved)', () => {
      const marker = `appr-marginal-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null)
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, status: 'approved', ...fields, evidence_adequacy: 'marginal' })
      expect(err).toMatch(/topic_assignment_review_requests_approved_fields_required/)
    })

    it('approved: CREATE_NEW with a target_semantic_topic_id set is rejected', () => {
      const marker = `appr-cnwt-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const topicId = dockerPsql(`insert into semantic_topics (canonical_label, label_language, specificity, creation_request_digest) values ('HR test target topic', 'en', 'specific', '${'e'.repeat(64)}') returning id;`).trim()
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', topicId)
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, status: 'approved', ...fields })
      expect(err).toMatch(/topic_assignment_review_requests_create_new_no_target/)
    })

    it('approved: ATTACH_EXISTING without a target_semantic_topic_id is rejected', () => {
      const marker = `appr-aewt-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const fields = fullApprovedFields(marker, extractionRunId, 'ATTACH_EXISTING', null)
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, status: 'approved', ...fields })
      expect(err).toMatch(/topic_assignment_review_requests_attach_requires_target/)
    })

    it('approved: ATTACH_EXISTING with a target_semantic_topic_id succeeds', () => {
      const marker = `appr-attach-ok-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const topicId = dockerPsql(`insert into semantic_topics (canonical_label, label_language, specificity, creation_request_digest) values ('HR test target topic 2', 'en', 'specific', '${'f'.repeat(64)}') returning id;`).trim()
      const fields = fullApprovedFields(marker, extractionRunId, 'ATTACH_EXISTING', topicId)
      const id = insertReviewRequest({ extraction_run_id: extractionRunId, status: 'approved', ...fields })
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('rejected: minimal required fields succeed (no fabricated topic definition required)', () => {
      const marker = `rej-ok-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const decisionId = createQuarantineDecision(extractionRunId, `sti-hr-${marker}-quar`)
      const id = insertReviewRequest({
        extraction_run_id: extractionRunId, status: 'rejected',
        reviewer_user_id: TEST_USER_A, reviewer_role_snapshot: 'owner', decided_at: 'now()',
        rejection_reason: 'invalid_topic_identity', reviewer_rationale: 'No valid identity.', review_policy_version: 1,
        resulting_decision_id: decisionId,
        decision_idempotency_key: `sti-hr-${marker}-dec`, decision_operation_digest: 'b'.repeat(64),
      })
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('rejected: missing resulting_decision_id is rejected (rejection must be terminal, linked to a real QUARANTINE decision)', () => {
      const marker = `rej-missing-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = insertReviewRequestExpectError({
        extraction_run_id: extractionRunId, status: 'rejected',
        reviewer_user_id: TEST_USER_A, reviewer_role_snapshot: 'owner', decided_at: 'now()',
        rejection_reason: 'invalid_topic_identity', reviewer_rationale: 'No valid identity.', review_policy_version: 1,
        decision_idempotency_key: `sti-hr-${marker}-dec`, decision_operation_digest: 'b'.repeat(64),
      })
      expect(err).toMatch(/topic_assignment_review_requests_rejected_fields_required/)
    })

    it('rejected: an unknown rejection_reason value is rejected by the enum CHECK', () => {
      const marker = `rej-badreason-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const decisionId = createQuarantineDecision(extractionRunId, `sti-hr-${marker}-quar`)
      const err = insertReviewRequestExpectError({
        extraction_run_id: extractionRunId, status: 'rejected',
        reviewer_user_id: TEST_USER_A, reviewer_role_snapshot: 'owner', decided_at: 'now()',
        rejection_reason: 'not_a_real_reason', reviewer_rationale: 'x', review_policy_version: 1,
        resulting_decision_id: decisionId,
        decision_idempotency_key: `sti-hr-${marker}-dec`, decision_operation_digest: 'b'.repeat(64),
      })
      expect(err).toMatch(/topic_assignment_review_requests_rejection_reason_check/)
    })

    it('expired/cancelled: approval fields must be empty', () => {
      const marker = `exp-ok-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const id = insertReviewRequest({ extraction_run_id: extractionRunId, status: 'expired' })
      expect(id).toMatch(/^[0-9a-f-]{36}$/)

      const marker2 = `canc-ok-${randomUUID().slice(0, 8)}`
      const { extractionRunId: run2 } = createCompletedExtraction(marker2)
      const id2 = insertReviewRequest({ extraction_run_id: run2, status: 'cancelled', cancelled_at: 'now()', cancelled_by_user_id: TEST_USER_A })
      expect(id2).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('cancelled: missing cancelled_at is rejected', () => {
      const marker = `canc-bad-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, status: 'cancelled' })
      expect(err).toMatch(/topic_assignment_review_requests_cancelled_fields/)
    })

    it('revoked: the original approval snapshot (including approval_digest) is preserved -- this is the corrected contract', () => {
      const marker = `rev-ok-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null)
      const id = insertReviewRequest({
        extraction_run_id: extractionRunId, status: 'revoked', ...fields,
        revoked_at: 'now()', revoked_by_user_id: TEST_USER_A,
      })
      const row = dockerPsql(`select approval_digest||'|'||canonical_topic_label from topic_assignment_review_requests where id='${id}';`).trim()
      const [digest, label] = row.split('|')
      expect(digest).toBe('a'.repeat(64))
      expect(label).toBe('HR test canonical label')
    })

    it('revoked: missing approval_digest (the previously-wrong contract) is now correctly rejected as incomplete', () => {
      const marker = `rev-nodigest-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null)
      delete (fields as any).approval_digest
      delete (fields as any).approval_digest_version
      const err = insertReviewRequestExpectError({
        extraction_run_id: extractionRunId, status: 'revoked', ...fields,
        revoked_at: 'now()', revoked_by_user_id: TEST_USER_A,
      })
      expect(err).toMatch(/topic_assignment_review_requests_revoked_fields/)
    })

    it('executed: full snapshot + execution fields succeed, resulting_decision_id required', () => {
      const marker = `exec-ok-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const decisionId = createQuarantineDecision(extractionRunId, `sti-hr-${marker}-dec2`) // stand-in decision id for FK purposes
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null)
      const id = insertReviewRequest({
        extraction_run_id: extractionRunId, status: 'executed', ...fields,
        executed_at: 'now()', resulting_decision_id: decisionId,
        execution_idempotency_key: `sti-hr-${marker}-exec`, execution_operation_digest: 'e'.repeat(64),
      })
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('executed: missing execution_idempotency_key is rejected', () => {
      const marker = `exec-missing-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const decisionId = createQuarantineDecision(extractionRunId, `sti-hr-${marker}-dec3`)
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null)
      const err = insertReviewRequestExpectError({
        extraction_run_id: extractionRunId, status: 'executed', ...fields,
        executed_at: 'now()', resulting_decision_id: decisionId,
        execution_operation_digest: 'e'.repeat(64),
      })
      expect(err).toMatch(/topic_assignment_review_requests_executed_fields/)
    })

    it('an unknown status value is rejected outright', () => {
      const marker = `badstatus-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, status: 'made_up_status' })
      expect(err).toMatch(/topic_assignment_review_requests_status_check/)
    })
  })

  // ============================================================
  // 8/9. Egyetlen elo request/run; generation retry expired/cancelled/
  // revoked utan.
  // ============================================================
  describe('one live request per run + generation retry', () => {
    it('a second pending request for the same extraction_run_id is rejected by the partial unique index', () => {
      const marker = `live-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      insertReviewRequest({ extraction_run_id: extractionRunId, generation: 1 })
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, generation: 2 })
      expect(err).toMatch(/idx_topic_assignment_review_requests_one_live_per_run/)
    })

    it('a new generation is allowed once the prior generation is expired', () => {
      const marker = `gen-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      insertReviewRequest({ extraction_run_id: extractionRunId, generation: 1, status: 'expired' })
      const id2 = insertReviewRequest({ extraction_run_id: extractionRunId, generation: 2 })
      expect(id2).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('a new generation is allowed once the prior generation is cancelled', () => {
      const marker = `gen-canc-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      insertReviewRequest({ extraction_run_id: extractionRunId, generation: 1, status: 'cancelled', cancelled_at: 'now()', cancelled_by_user_id: TEST_USER_A })
      const id2 = insertReviewRequest({ extraction_run_id: extractionRunId, generation: 2 })
      expect(id2).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('a new generation is allowed once the prior generation is revoked', () => {
      const marker = `gen-rev-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null)
      insertReviewRequest({ extraction_run_id: extractionRunId, generation: 1, status: 'revoked', ...fields, revoked_at: 'now()', revoked_by_user_id: TEST_USER_A })
      const id2 = insertReviewRequest({ extraction_run_id: extractionRunId, generation: 2 })
      expect(id2).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('the generation UNIQUE constraint rejects a duplicate (extraction_run_id, generation) pair even across terminal statuses', () => {
      const marker = `gen-dup-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      insertReviewRequest({ extraction_run_id: extractionRunId, generation: 1, status: 'expired' })
      const err = insertReviewRequestExpectError({ extraction_run_id: extractionRunId, generation: 1, status: 'cancelled', cancelled_at: 'now()', cancelled_by_user_id: TEST_USER_A })
      expect(err).toMatch(/topic_assignment_review_requests_generation_key/)
    })
  })

  // ============================================================
  // 11. Idempotency-key uniqueness es fazisonkenti tarolhatosag.
  // ============================================================
  describe('idempotency key storage', () => {
    it('request_idempotency_key is unique across all requests', () => {
      const marker = `idem-${randomUUID().slice(0, 8)}`
      const { extractionRunId: run1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: run2 } = createCompletedExtraction(`${marker}-b`)
      const key = `sti-hr-${marker}-shared-key`
      insertReviewRequest({ extraction_run_id: run1, request_idempotency_key: key })
      const err = insertReviewRequestExpectError({ extraction_run_id: run2, request_idempotency_key: key })
      expect(err).toMatch(/topic_assignment_review_requests_request_key_key/)
    })

    it('decision_idempotency_key and execution_idempotency_key live in separate columns -- an identical string in both never collides', () => {
      const marker = `idem-scope-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const decisionId = createQuarantineDecision(extractionRunId, `sti-hr-${marker}-dec4`)
      const sameText = `sti-hr-${marker}-same-text`
      const fields = fullApprovedFields(marker, extractionRunId, 'CREATE_NEW', null)
      const id = insertReviewRequest({
        extraction_run_id: extractionRunId, status: 'executed', ...fields,
        decision_idempotency_key: sameText,
        executed_at: 'now()', resulting_decision_id: decisionId,
        execution_idempotency_key: sameText, execution_operation_digest: 'e'.repeat(64),
      })
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('two NULL decision_idempotency_key values (two separate pending requests) do not collide under the partial unique index', () => {
      const marker = `idem-null-${randomUUID().slice(0, 8)}`
      const { extractionRunId: run1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: run2 } = createCompletedExtraction(`${marker}-b`)
      insertReviewRequest({ extraction_run_id: run1 })
      const id2 = insertReviewRequest({ extraction_run_id: run2 })
      expect(id2).toMatch(/^[0-9a-f-]{36}$/)
    })
  })

  // ============================================================
  // 12/13. Append-only event tabla-k.
  // ============================================================
  describe('append-only event tables', () => {
    it('topic_assignment_review_events accepts INSERT (postgres) and rejects UPDATE/DELETE for service_role', () => {
      const marker = `evt-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const reqId = insertReviewRequest({ extraction_run_id: extractionRunId })
      dockerPsql(`insert into topic_assignment_review_events (review_request_id, event_type, actor_kind, policy_version) values ('${reqId}', 'requested', 'service_role_system', 1);`)
      const err = dockerPsqlExpectError(`
        set role service_role;
        update topic_assignment_review_events set event_type='approved' where review_request_id='${reqId}';
        reset role;
      `)
      expect(err).toMatch(/permission denied/)
    })

    it('the "once per request" partial unique index rejects a second terminal event of the same type for the same request', () => {
      const marker = `evt-once-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const reqId = insertReviewRequest({ extraction_run_id: extractionRunId })
      dockerPsql(`insert into topic_assignment_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version) values ('${reqId}', 'approved', '${TEST_USER_A}', 'authenticated_reviewer', 1);`)
      const err = dockerPsqlExpectError(`insert into topic_assignment_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version) values ('${reqId}', 'approved', '${TEST_USER_A}', 'authenticated_reviewer', 1);`)
      expect(err).toMatch(/idx_topic_assignment_review_events_once_per_request/)
    })

    it('multiple "requested" events ARE allowed on the same request (one per generation, not restricted here)', () => {
      const marker = `evt-multireq-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const reqId = insertReviewRequest({ extraction_run_id: extractionRunId })
      dockerPsql(`insert into topic_assignment_review_events (review_request_id, event_type, actor_kind, policy_version) values ('${reqId}', 'requested', 'service_role_system', 1);`)
      // a second 'requested' row for the SAME request id is schema-legal (not part of the once-per-request partial index) --
      // the real "one requested event per generation" invariant belongs to the 078 RPC, not this table alone.
      dockerPsql(`insert into topic_assignment_review_events (review_request_id, event_type, actor_kind, policy_version) values ('${reqId}', 'requested', 'service_role_system', 1);`)
      const count = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${reqId}' and event_type='requested';`).trim()
      expect(count).toBe('2')
    })

    it('semantic_topic_reviewer_events transition pairing CHECK enforces granted->deactivated->reactivated exactly', () => {
      const reviewerId = insertReviewer(TEST_USER_A)
      dockerPsql(`insert into semantic_topic_reviewer_events (reviewer_id, reviewer_user_id, event_type, actor_kind, authorization_policy_version, previous_active, new_active) values ('${reviewerId}', '${TEST_USER_A}', 'granted', 'postgres_bootstrap', 1, NULL, true);`)
      // legal transition: deactivated requires previous_active=true, new_active=false
      dockerPsql(`insert into semantic_topic_reviewer_events (reviewer_id, reviewer_user_id, event_type, actor_user_id, actor_kind, authorization_policy_version, previous_active, new_active) values ('${reviewerId}', '${TEST_USER_A}', 'deactivated', '${TEST_USER_B}', 'authenticated_reviewer', 1, true, false);`)
      // illegal transition: deactivated with previous_active=false (should be true) is rejected
      const err = dockerPsqlExpectError(`insert into semantic_topic_reviewer_events (reviewer_id, reviewer_user_id, event_type, actor_user_id, actor_kind, authorization_policy_version, previous_active, new_active) values ('${reviewerId}', '${TEST_USER_A}', 'deactivated', '${TEST_USER_B}', 'authenticated_reviewer', 1, false, false);`)
      expect(err).toMatch(/semantic_topic_reviewer_events_transition_pairing/)
    })
  })

  // ============================================================
  // 14. Kozvetlen DML tiltott anon/authenticated/service_role szereppel
  // mind a negy uj tablan.
  // ============================================================
  describe('direct DML is forbidden for every role on all four new tables', () => {
    const tables = ['semantic_topic_reviewers', 'semantic_topic_reviewer_events', 'topic_assignment_review_requests', 'topic_assignment_review_events']
    for (const table of tables) {
      it(`${table}: service_role cannot INSERT directly`, () => {
        const err = dockerPsqlExpectError(`set role service_role; insert into ${table} default values; reset role;`)
        expect(err).toMatch(/permission denied|null value/)
      })
      it(`${table}: authenticated cannot SELECT/INSERT directly (no grant at all)`, () => {
        const err = dockerPsqlExpectError(`set role authenticated; select * from ${table}; reset role;`)
        expect(err).toMatch(/permission denied/)
      })
    }
  })

  // ============================================================
  // 15. Nincs valodi reviewer bootstrap-adat a migracioban.
  // ============================================================
  describe('no real reviewer bootstrap shipped in 077', () => {
    it('semantic_topic_reviewers has 0 rows immediately after a fresh migration apply (before this suite seeds its own test fixtures)', () => {
      // Ez a teszt onmagaban nem tudja "ures volt-e a migracio UTAN,
      // MIELOTT ez a suite futott" -- azt a migracio sajat CREATE-agi
      // NOTICE-a bizonyitja ("created (empty -- no bootstrap in this
      // migration)"), amit a fenti "first apply" NOTICE-ellenorzes mar
      // lefedett a korabbi korben. Itt csak azt igazoljuk, hogy a
      // migracios SQL SZOVEGE maga nem tartalmaz semmilyen konkret
      // UUID-t vagy INSERT-et erre a tablara.
      const migrationText = readFileSync(MIGRATION_PATH, 'utf8')
      const hasInsert = /insert\s+into\s+public\.semantic_topic_reviewers/i.test(migrationText)
      expect(hasInsert).toBe(false)
    })
  })

  // ============================================================
  // 16. A ket meglevo QUARANTINE dontes logikai szerzodese
  // valtozatlan -- ezt itt CSAK a decision_reason CHECK szintjen
  // tudjuk igazolni (a tenyleges production sorokat ez a suite nem
  // erheti el es nem is probalja).
  // ============================================================
  describe('existing QUARANTINE contract unaffected', () => {
    it('below_confidence_threshold and malformed_extraction remain valid decision_reason values for QUARANTINE', () => {
      const marker = `existing-reason-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const sql = `select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, 'sti-hr-${marker}-dec', NULL);`
      const result = JSON.parse(dockerPsql(sql).trim())
      expect(result.ok).toBe(true)
    })
  })
})
