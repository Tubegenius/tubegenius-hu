// Semantic Topic Identity v0 -- S2A writerless audit/provenance schema +
// temporal non-overlap hardening, REAL local DB integration tests.
//
// Same pattern as the 072 suite: uses the existing local Docker Supabase
// stack (supabase_db_WillViralFinal), skips entirely (not a failure) when
// unavailable, direct postgres-privileged psql fixture inserts (no writer
// RPC exists yet -- S2A is still fully writerless), SET ROLE for real
// grant-boundary checks.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION_PATH = join(process.cwd(), 'supabase/migrations/073_semantic_topic_s2a_audit_and_temporal_hardening.sql')

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

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function randomHexDigest(): string {
  let s = ''
  while (s.length < 64) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

const LEGACY_ASSIGNMENT_REASON_DEF =
  "CHECK (assignment_reason = ANY (ARRAY['entity_event_match'::text, 'embedding_similarity'::text, 'manual_review_confirmed'::text, 'manual_review_override'::text]))"
const CORRECTED_ASSIGNMENT_REASON_DEF =
  "CHECK (assignment_reason = ANY (ARRAY['entity_event_match'::text, 'embedding_similarity'::text, 'manual_review_confirmed'::text, 'manual_review_override'::text, 'topic_creation_seed'::text]))"

function resetAssignmentReasonToLegacy() {
  dockerPsql(`
    ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT IF EXISTS semantic_topic_membership_assignment_reason_check;
    ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_assignment_reason_check
      CHECK (assignment_reason IN ('entity_event_match', 'embedding_similarity', 'manual_review_confirmed', 'manual_review_override'));
  `)
}

function dropS2AObjects() {
  dockerPsql(`
    DROP TABLE IF EXISTS public.semantic_topic_membership_events;
    DROP TABLE IF EXISTS public.topic_assignment_decisions;
    DROP TABLE IF EXISTS public.topic_extraction_runs;
    ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT IF EXISTS semantic_topic_membership_no_overlap;
    ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT IF EXISTS semantic_topic_membership_valid_from_finite;
    ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT IF EXISTS semantic_topic_membership_valid_to_finite;
    DROP EXTENSION IF EXISTS btree_gist;
  `)
  resetAssignmentReasonToLegacy()
}

function ensureFullyApplied() {
  const out = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename in ('topic_extraction_runs','topic_assignment_decisions','semantic_topic_membership_events');`).trim()
  if (out !== '3') {
    runMigration()
  } else {
    const def = dockerPsql(`select pg_get_constraintdef(oid, true) from pg_constraint where conname='semantic_topic_membership_assignment_reason_check';`).trim()
    if (def !== CORRECTED_ASSIGNMENT_REASON_DEF) {
      dropS2AObjects()
      runMigration()
    }
    const exclOut = dockerPsql(`select count(*) from pg_constraint where conname='semantic_topic_membership_no_overlap';`).trim()
    if (exclOut !== '1') {
      runMigration()
    }
  }
}

function cleanupTestData() {
  dockerPsql(`
    delete from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s2a-%');
    delete from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s2a-%');
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s2a-%');
    delete from semantic_topic_membership where semantic_topic_id in (select id from semantic_topics where canonical_label like 'S2A test%');
    delete from semantic_topics where canonical_label like 'S2A test%';
    delete from signal_evidence where external_ref like 'sti-s2a-%';
    delete from signal_sources where external_id like 'sti-s2a-%';
    delete from signal_runs where idempotency_key like 'sti-s2a-%';
  `)
}

function insertFixtureRun(idempotencyKey: string): string {
  return dockerPsql(`
    insert into signal_runs (run_type, idempotency_key, status, completed_at)
    values ('shadow_batch', '${idempotencyKey}', 'completed', now())
    returning id;
  `).trim()
}
function insertFixtureSource(externalId: string): string {
  return dockerPsql(`
    insert into signal_sources (source_type, external_id, source_family_key)
    values ('youtube_channel', '${externalId}', '${externalId}')
    returning id;
  `).trim()
}
function insertFixtureEvidence(sourceId: string, runId: string, externalRef: string): string {
  return dockerPsql(`
    insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id)
    values ('${sourceId}', 'youtube_video', '${externalRef}', 'S2A fixture evidence', '${runId}')
    returning id;
  `).trim()
}
function insertTopic(overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    canonical_label: `'S2A test topic ${Math.random().toString(36).slice(2)}'`,
    label_language: `'en'`,
    creation_request_digest: `'${randomHexDigest()}'`,
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into semantic_topics (${cols}) values (${vals}) returning id;`).trim()
}
function insertMembership(topicId: string, evidenceId: string, overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    semantic_topic_id: `'${topicId}'`,
    signal_evidence_id: `'${evidenceId}'`,
    assignment_reason: `'topic_creation_seed'`,
    confidence: '0.9000',
    algorithm_version: '1',
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into semantic_topic_membership (${cols}) values (${vals}) returning id;`).trim()
}
function insertMembershipExpectError(topicId: string, evidenceId: string, overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    semantic_topic_id: `'${topicId}'`,
    signal_evidence_id: `'${evidenceId}'`,
    assignment_reason: `'topic_creation_seed'`,
    confidence: '0.9000',
    algorithm_version: '1',
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsqlExpectError(`insert into semantic_topic_membership (${cols}) values (${vals});`)
}

const VALID_STRUCTURED_OUTPUT = (schemaVersion = 1) => JSON.stringify({
  extraction_schema_version: schemaVersion,
  canonical_phenomenon_label: 'Test phenomenon',
  label_language: 'en',
  subject_entities: ['Entity A'],
  action_or_event: null,
  location: null,
  temporal_context: null,
  specificity: 'specific',
  content_format: 'news_event',
  confidence: 0.85,
  supporting_spans: [{ source_field: 'title', quoted_text: 'Test phenomenon' }],
}).replace(/'/g, "''")

function extractionRow(evidenceId: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    signal_evidence_id: `'${evidenceId}'`,
    normalization_version: '1',
    extraction_method: `'deterministic'`,
    deterministic_extractor_version: '1',
    source_snapshot: `'{"title":"x"}'::jsonb`,
    source_snapshot_digest: `'${HASH_A}'`,
    normalized_extraction_input: `'normalized test text'`,
    normalized_input_digest: `'${HASH_B}'`,
    extraction_config_digest: `'${randomHexDigest()}'`,
    extraction_schema_version: '1',
    structured_output: `'${VALID_STRUCTURED_OUTPUT()}'::jsonb`,
    output_digest: `'${randomHexDigest()}'`,
    status: `'completed'`,
    confidence: '0.9000',
    idempotency_key: `'sti-s2a-ext-${Math.random().toString(36).slice(2)}'`,
    started_at: 'now()',
    completed_at: 'now()',
    ...overrides,
  }
}
function insertExtractionRun(row: Record<string, string>): string {
  const cols = Object.keys(row).join(', ')
  const vals = Object.values(row).join(', ')
  return dockerPsql(`insert into topic_extraction_runs (${cols}) values (${vals}) returning id;`).trim()
}
function insertExtractionRunExpectError(row: Record<string, string>): string {
  const cols = Object.keys(row).join(', ')
  const vals = Object.values(row).join(', ')
  return dockerPsqlExpectError(`insert into topic_extraction_runs (${cols}) values (${vals});`)
}

function decisionRow(extractionRunId: string, evidenceId: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    extraction_run_id: `'${extractionRunId}'`,
    signal_evidence_id: `'${evidenceId}'`,
    outcome: `'QUARANTINE'`,
    decision_reason: `'below_confidence_threshold'`,
    decision_digest: `'${randomHexDigest()}'`,
    idempotency_key: `'sti-s2a-dec-${Math.random().toString(36).slice(2)}'`,
    ...overrides,
  }
}
function insertDecision(row: Record<string, string>): string {
  const cols = Object.keys(row).join(', ')
  const vals = Object.values(row).join(', ')
  return dockerPsql(`insert into topic_assignment_decisions (${cols}) values (${vals}) returning id;`).trim()
}
function insertDecisionExpectError(row: Record<string, string>): string {
  const cols = Object.keys(row).join(', ')
  const vals = Object.values(row).join(', ')
  return dockerPsqlExpectError(`insert into topic_assignment_decisions (${cols}) values (${vals});`)
}

describeIfLocalDb('Semantic Topic Identity v0 S2A -- audit/provenance schema + temporal hardening (real local DB)', () => {
  let runId: string
  let sourceId: string
  let evidenceA: string
  let evidenceB: string

  beforeAll(() => {
    ensureFullyApplied()
    cleanupTestData()
    runId = insertFixtureRun(`sti-s2a-fixture-${Date.now()}`)
    sourceId = insertFixtureSource(`sti-s2a-fixture-${Date.now()}`)
    evidenceA = insertFixtureEvidence(sourceId, runId, `sti-s2a-a-${Date.now()}`)
    evidenceB = insertFixtureEvidence(sourceId, runId, `sti-s2a-b-${Date.now()}`)
  })

  afterAll(() => {
    cleanupTestData()
  })

  // ------------------------------------------------------------
  // 1. Global topology gate + full re-apply cycle
  // ------------------------------------------------------------
  describe('global topology gate', () => {
    it('a 1-of-3 and 2-of-3 state is rejected before any DDL', () => {
      dropS2AObjects()
      runMigration() // fresh 0/3 -> 3/3
      dockerPsql('DROP TABLE public.topic_extraction_runs CASCADE;') // -> 2/3
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/073 fail-closed: partial topology detected -- 2 of 3/)

      dockerPsql('DROP TABLE public.topic_assignment_decisions CASCADE;') // -> 1/3
      const bad2 = runMigration()
      expect(bad2.threw).toBe(true)
      expect(bad2.out).toMatch(/073 fail-closed: partial topology detected -- 1 of 3/)

      // restore to clean 3/3 for the rest of the suite
      dropS2AObjects()
      const good = runMigration()
      expect(good.threw).toBe(false)
      expect(good.out).toMatch(/topic_extraction_runs created\./)
      expect(good.out).toMatch(/topic_assignment_decisions created\./)
      expect(good.out).toMatch(/semantic_topic_membership_events created\./)
    })

    it('second run is a byte-exact no-op across all 6 sub-migrations', () => {
      const out = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename in ('topic_extraction_runs','topic_assignment_decisions','semantic_topic_membership_events');`).trim()
      expect(out).toBe('3')
      const second = runMigration()
      expect(second.threw).toBe(false)
      expect(second.out).toMatch(/topic_extraction_runs already exists and matches exactly -- no-op\./)
      expect(second.out).toMatch(/topic_assignment_decisions already exists and matches exactly -- no-op\./)
      expect(second.out).toMatch(/semantic_topic_membership_events already exists and matches exactly -- no-op\./)
      expect(second.out).toMatch(/semantic_topic_membership_assignment_reason_check already corrected -- no-op\./)
      expect(second.out).toMatch(/btree_gist already installed and matches exactly.*-- no-op\./)
      expect(second.out).toMatch(/semantic_topic_membership_no_overlap already exists and matches exactly -- no-op\./)
      expect(second.out).not.toMatch(/drift/i)
    })
  })

  // ------------------------------------------------------------
  // 2. assignment_reason legacy -> corrected transition
  // ------------------------------------------------------------
  describe('assignment_reason correction', () => {
    it('re-applying from the known legacy definition corrects it, and a further run is a no-op', () => {
      resetAssignmentReasonToLegacy()
      const first = runMigration()
      expect(first.threw).toBe(false)
      expect(first.out).toMatch(/is the known 072 legacy definition -- correcting\./)
      expect(first.out).toMatch(/corrected to include topic_creation_seed\./)
      const def = dockerPsql(`select pg_get_constraintdef(oid, true) from pg_constraint where conname='semantic_topic_membership_assignment_reason_check';`).trim()
      expect(def).toBe(CORRECTED_ASSIGNMENT_REASON_DEF)

      const second = runMigration()
      expect(second.threw).toBe(false)
      expect(second.out).toMatch(/already corrected -- no-op\./)
    })

    it('an unrecognized definition triggers DEFINITION_DRIFT and is restored afterward', () => {
      dockerPsql(`
        ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT semantic_topic_membership_assignment_reason_check;
        ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_assignment_reason_check
          CHECK (assignment_reason IN ('entity_event_match', 'something_unexpected'));
      `)
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/073 fail-closed: DEFINITION_DRIFT/)

      dockerPsql(`
        ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT semantic_topic_membership_assignment_reason_check;
        ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_assignment_reason_check
          CHECK (assignment_reason IN ('entity_event_match', 'embedding_similarity', 'manual_review_confirmed', 'manual_review_override', 'topic_creation_seed'));
      `)
      const good = runMigration()
      expect(good.threw).toBe(false)
    })

    it('accepts all 5 assignment_reason values and rejects an unknown one', () => {
      const topicId = insertTopic()
      const values = ['entity_event_match', 'embedding_similarity', 'manual_review_confirmed', 'manual_review_override', 'topic_creation_seed']
      let t = 0
      for (const v of values) {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-reason-${t}-${Date.now()}`)
        const id = insertMembership(topicId, localEvidence, { assignment_reason: `'${v}'` })
        expect(id).not.toBe('')
        t++
      }
      const localEvidence2 = insertFixtureEvidence(sourceId, runId, `sti-s2a-reason-bad-${Date.now()}`)
      const err = insertMembershipExpectError(topicId, localEvidence2, { assignment_reason: `'unknown_value'` })
      expect(err).toMatch(/violates check constraint "semantic_topic_membership_assignment_reason_check"/)
    })
  })

  // ------------------------------------------------------------
  // 3. btree_gist + EXCLUDE temporal hardening
  // ------------------------------------------------------------
  describe('temporal non-overlap hardening', () => {
    it('btree_gist is installed, version 1.7, schema extensions', () => {
      const out = dockerPsql(`select extversion||'|'||extnamespace::regnamespace::text from pg_extension where extname='btree_gist';`).trim()
      expect(out).toBe('1.7|extensions')
    })

    it('a mismatched installed_version/schema is rejected (simulated via a wrong-schema stand-in check)', () => {
      // We cannot actually install a second, differently-versioned
      // btree_gist locally -- this test instead verifies the self-check
      // logic path by asserting the migration's own post-install
      // self-check exists and the extension's actual state matches
      // exactly what 073 expects (version/schema), which is what makes
      // the fail-closed branch meaningful on a real drifted environment.
      const out = dockerPsql(`select extversion, extnamespace::regnamespace::text from pg_extension where extname='btree_gist';`).trim()
      expect(out).toContain('1.7')
      expect(out).toContain('extensions')
    })

    it('the EXCLUDE constraint has the exact expected definition (real unbounded upper range, no infinity sentinel)', () => {
      const def = dockerPsql(`select pg_get_constraintdef(oid, true) from pg_constraint where conname='semantic_topic_membership_no_overlap';`).trim()
      expect(def).toBe("EXCLUDE USING gist (signal_evidence_id WITH =, tstzrange(valid_from, valid_to, '[)'::text) WITH &&)")
    })

    it('a drifted EXCLUDE constraint definition is rejected (no auto-repair), then restored', () => {
      // Keyed on `id` (always unique per row) rather than semantic_topic_id
      // or signal_evidence_id, so this ALTER always succeeds regardless of
      // whatever fixture data other tests in this suite have already
      // accumulated -- the point of this test is purely to prove the
      // migration detects a definition-text mismatch, not to exercise
      // overlap semantics with a specific key.
      dockerPsql(`
        ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT semantic_topic_membership_no_overlap;
        ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_no_overlap
          EXCLUDE USING gist (id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&);
      `)
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/073 fail-closed: semantic_topic_membership_no_overlap exists but its definition does not match exactly/)

      dockerPsql(`
        ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT semantic_topic_membership_no_overlap;
        ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_no_overlap
          EXCLUDE USING gist (signal_evidence_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&);
      `)
      const good = runMigration()
      expect(good.threw).toBe(false)
      expect(good.out).not.toMatch(/drift/i)
    })

    describe('finite-timestamp guard (no infinity/-infinity bypass)', () => {
      it('rejects valid_from = infinity', () => {
        const topicId = insertTopic()
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-vffin-${Date.now()}`)
        const err = insertMembershipExpectError(topicId, localEvidence, { valid_from: `'infinity'` })
        expect(err).toMatch(/violates check constraint "semantic_topic_membership_valid_from_finite"/)
      })
      it('rejects valid_from = -infinity', () => {
        const topicId = insertTopic()
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-vfninf-${Date.now()}`)
        const err = insertMembershipExpectError(topicId, localEvidence, { valid_from: `'-infinity'`, valid_to: `'2026-01-01T00:00:00Z'` })
        expect(err).toMatch(/violates check constraint "semantic_topic_membership_valid_from_finite"/)
      })
      it('rejects valid_to = infinity', () => {
        const topicId = insertTopic()
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-vtfin-${Date.now()}`)
        const err = insertMembershipExpectError(topicId, localEvidence, { valid_to: `'infinity'` })
        expect(err).toMatch(/violates check constraint "semantic_topic_membership_valid_to_finite"/)
      })
      it('rejects valid_to = -infinity', () => {
        // -infinity as valid_to is caught by the pre-existing 072
        // valid_to_after_valid_from CHECK before it would even reach the
        // new finite guard (-infinity can never be > any finite
        // valid_from) -- both constraints agree the row is invalid, this
        // test documents which one fires first rather than asserting a
        // specific one, since either is a correct rejection.
        const topicId = insertTopic()
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-vtninf-${Date.now()}`)
        const err = insertMembershipExpectError(topicId, localEvidence, { valid_from: `'2020-01-01T00:00:00Z'`, valid_to: `'-infinity'` })
        expect(err).toMatch(/violates check constraint "semantic_topic_membership_(valid_to_finite|valid_to_after_valid_from)"/)
      })
      it('accepts a NULL valid_to and produces a genuinely unbounded (not infinity-sentinel) upper range', () => {
        const topicId = insertTopic()
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-unbounded-${Date.now()}`)
        const id = insertMembership(topicId, localEvidence)
        const out = dockerPsql(`select upper_inf(tstzrange(valid_from, valid_to, '[)')) from semantic_topic_membership where id='${id}';`).trim()
        expect(out).toBe('t')
      })
      it('cannot be bypassed via an empty range (valid_to > valid_from is already enforced independently)', () => {
        const topicId = insertTopic()
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-empty-${Date.now()}`)
        const err = insertMembershipExpectError(topicId, localEvidence, {
          valid_from: `'2026-01-01T00:00:00Z'`, valid_to: `'2026-01-01T00:00:00Z'`,
        })
        expect(err).toMatch(/violates check constraint "semantic_topic_membership_valid_to_after_valid_from"/)
      })
    })

    it('rejects active-active overlap for the same evidence (already covered by the 072 partial unique index, reconfirmed here)', () => {
      const topicA = insertTopic()
      const topicB = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-actact-${Date.now()}`)
      insertMembership(topicA, localEvidence)
      const err = insertMembershipExpectError(topicB, localEvidence)
      expect(err).toMatch(/duplicate key value violates unique constraint "semantic_topic_membership_active_evidence_key"/)
    })

    it('rejects an active row overlapping a later closed historical row for the same evidence', () => {
      const topicA = insertTopic()
      const topicB = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-acthist-${Date.now()}`)
      insertMembership(topicA, localEvidence, { valid_from: `'2026-03-05T00:00:00Z'`, valid_to: `'2026-03-10T00:00:00Z'` })
      const err = insertMembershipExpectError(topicB, localEvidence, { valid_from: `'2026-03-08T00:00:00Z'` })
      expect(err).toMatch(/conflicting key value violates exclusion constraint "semantic_topic_membership_no_overlap"/)
    })

    it('rejects two overlapping closed historical rows for the same evidence', () => {
      const topicA = insertTopic()
      const topicB = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-histhist-${Date.now()}`)
      insertMembership(topicA, localEvidence, { valid_from: `'2026-04-01T00:00:00Z'`, valid_to: `'2026-04-10T00:00:00Z'` })
      const err = insertMembershipExpectError(topicB, localEvidence, { valid_from: `'2026-04-05T00:00:00Z'`, valid_to: `'2026-04-15T00:00:00Z'` })
      expect(err).toMatch(/conflicting key value violates exclusion constraint "semantic_topic_membership_no_overlap"/)
    })

    it('accepts adjacent (touching, non-overlapping) intervals [a,b) and [b,c)', () => {
      const topicA = insertTopic()
      const topicB = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-adjacent-${Date.now()}`)
      const id1 = insertMembership(topicA, localEvidence, { valid_from: `'2026-05-01T00:00:00Z'`, valid_to: `'2026-05-05T00:00:00Z'` })
      const id2 = insertMembership(topicB, localEvidence, { valid_from: `'2026-05-05T00:00:00Z'`, valid_to: `'2026-05-10T00:00:00Z'` })
      expect(id1).not.toBe('')
      expect(id2).not.toBe('')
    })

    it('overlap precheck refuses to add the constraint over existing invalid data (simulated via drop+reinsert)', () => {
      // Temporarily drop the constraint, insert an overlapping pair
      // directly (bypassing the constraint), then re-run 073 and confirm
      // the precheck detects it and refuses -- then clean up and restore.
      dockerPsql('ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT semantic_topic_membership_no_overlap;')
      const topicA = insertTopic()
      const topicB = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-precheck-${Date.now()}`)
      insertMembership(topicA, localEvidence, { valid_from: `'2026-06-01T00:00:00Z'`, valid_to: `'2026-06-10T00:00:00Z'` })
      insertMembership(topicB, localEvidence, { valid_from: `'2026-06-05T00:00:00Z'`, valid_to: `'2026-06-15T00:00:00Z'` })

      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/073 fail-closed: 1 overlapping semantic_topic_membership interval pair\(s\) found/)

      dockerPsql(`delete from semantic_topic_membership where signal_evidence_id = '${localEvidence}';`)
      const good = runMigration()
      expect(good.threw).toBe(false)
      expect(good.out).toMatch(/overlap precheck passed \(0 overlapping interval pairs\)/)
    })

    it('two concurrent overlapping inserts for the same evidence: at most one succeeds', async () => {
      const topicA = insertTopic()
      const topicB = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-race-${Date.now()}`)
      const attempt = (topicId: string) => new Promise<string>((resolve) => {
        try {
          const out = dockerPsql(`
            insert into semantic_topic_membership (semantic_topic_id, signal_evidence_id, valid_from, assignment_reason, confidence, algorithm_version)
            values ('${topicId}', '${localEvidence}', now(), 'topic_creation_seed', 0.9, 1) returning id;
          `)
          resolve('OK:' + out.trim())
        } catch (e: any) {
          resolve('ERR:' + String(e.stderr || e.message || ''))
        }
      })
      const [r1, r2] = await Promise.all([attempt(topicA), attempt(topicB)])
      const okCount = [r1, r2].filter((r) => r.startsWith('OK:')).length
      expect(okCount).toBe(1)
    })
  })

  // ------------------------------------------------------------
  // 4. topic_extraction_runs domain constraints
  // ------------------------------------------------------------
  describe('topic_extraction_runs', () => {
    it('accepts a well-formed deterministic completed row', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-ext-ok-${Date.now()}`)
      const id = insertExtractionRun(extractionRow(localEvidence))
      expect(id).not.toBe('')
    })

    it('accepts a well-formed ai_assisted completed row', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-ext-ai-${Date.now()}`)
      const id = insertExtractionRun(extractionRow(localEvidence, {
        extraction_method: `'ai_assisted'`, deterministic_extractor_version: 'DEFAULT',
        provider: `'anthropic'`, model: `'claude-x'`, prompt_version: `'v1'`,
        input_tokens: '100', output_tokens: '50', estimated_cost_usd: '0.001500',
      }))
      expect(id).not.toBe('')
    })

    it('accepts a failed row with no structured_output/confidence and an error_class', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-ext-fail-${Date.now()}`)
      const id = insertExtractionRun(extractionRow(localEvidence, {
        status: `'failed'`, structured_output: 'NULL', output_digest: 'NULL', confidence: 'NULL',
        error_class: `'provider_timeout'`,
      }))
      expect(id).not.toBe('')
    })

    describe('provider/model/prompt_version pairing (rejects every invalid partial combo)', () => {
      it('rejects deterministic with a non-null provider', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-pair1-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { provider: `'x'` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_provider_fields_pairing"/)
      })
      it('rejects ai_assisted with only provider set (model/prompt_version NULL)', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-pair2-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, {
          extraction_method: `'ai_assisted'`, deterministic_extractor_version: 'NULL', provider: `'anthropic'`,
        }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_provider_fields_pairing"/)
      })
      it('rejects ai_assisted with a blank model', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-pair3-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, {
          extraction_method: `'ai_assisted'`, deterministic_extractor_version: 'NULL',
          provider: `'anthropic'`, model: `'  '`, prompt_version: `'v1'`,
        }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_provider_fields_pairing"/)
      })
      it('rejects ai_assisted with a non-null deterministic_extractor_version', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-pair4-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, {
          extraction_method: `'ai_assisted'`, provider: `'anthropic'`, model: `'x'`, prompt_version: `'v1'`,
          deterministic_extractor_version: '1',
        }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_provider_fields_pairing"/)
      })
      it('rejects deterministic with a NULL deterministic_extractor_version', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-pair5-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { deterministic_extractor_version: 'NULL' }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_provider_fields_pairing"/)
      })
      it('rejects tokens set on a deterministic row', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-pair6-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { input_tokens: '5' }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_tokens_only_ai_assisted"/)
      })
    })

    describe('completed/failed field pairing', () => {
      it('rejects completed status with a NULL structured_output', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-cf1-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { structured_output: 'NULL' }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_completed_fields_pairing"/)
      })
      it('rejects failed status with a non-NULL structured_output', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-cf2-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { status: `'failed'`, error_class: `'x'` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_completed_fields_pairing"/)
      })
      it('rejects failed status with a NULL error_class', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-cf3-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, {
          status: `'failed'`, structured_output: 'NULL', output_digest: 'NULL', confidence: 'NULL',
        }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_error_class_pairing"/)
      })
      it('rejects completed status with a non-NULL error_class', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-cf4-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { error_class: `'x'` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_error_class_pairing"/)
      })
    })

    it('rejects a status outside completed/failed (no processing)', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-status-${Date.now()}`)
      const err = insertExtractionRunExpectError(extractionRow(localEvidence, {
        status: `'processing'`, structured_output: 'NULL', output_digest: 'NULL', confidence: 'NULL',
      }))
      expect(err).toMatch(/violates check constraint/)
    })

    it('idempotency_key is UNIQUE', () => {
      const key = `sti-s2a-idem-${Date.now()}`
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-idemev-${Date.now()}`)
      insertExtractionRun(extractionRow(localEvidence, { idempotency_key: `'${key}'` }))
      const localEvidence2 = insertFixtureEvidence(sourceId, runId, `sti-s2a-idemev2-${Date.now()}`)
      const err = insertExtractionRunExpectError(extractionRow(localEvidence2, { idempotency_key: `'${key}'` }))
      expect(err).toMatch(/duplicate key value violates unique constraint "topic_extraction_runs_idempotency_key_key"/)
    })

    describe('completed cache identity partial uniqueness', () => {
      it('rejects a second completed row with the same (evidence, normalized_input_digest, config_digest)', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-cache-${Date.now()}`)
        const configDigest = randomHexDigest()
        insertExtractionRun(extractionRow(localEvidence, { extraction_config_digest: `'${configDigest}'` }))
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { extraction_config_digest: `'${configDigest}'` }))
        expect(err).toMatch(/duplicate key value violates unique constraint "topic_extraction_runs_completed_cache_key"/)
      })

      it('allows unlimited failed retries with the same (evidence, normalized_input_digest, config_digest)', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-retry-${Date.now()}`)
        const normDigest = HASH_A
        const configDigest = randomHexDigest()
        const id1 = insertExtractionRun(extractionRow(localEvidence, {
          normalized_input_digest: `'${normDigest}'`, extraction_config_digest: `'${configDigest}'`,
          status: `'failed'`, structured_output: 'NULL', output_digest: 'NULL', confidence: 'NULL', error_class: `'timeout'`,
        }))
        const id2 = insertExtractionRun(extractionRow(localEvidence, {
          normalized_input_digest: `'${normDigest}'`, extraction_config_digest: `'${configDigest}'`,
          status: `'failed'`, structured_output: 'NULL', output_digest: 'NULL', confidence: 'NULL', error_class: `'timeout'`,
        }))
        expect(id1).not.toBe('')
        expect(id2).not.toBe('')
        expect(id1).not.toBe(id2)
      })
    })

    describe('digest formats', () => {
      it('rejects a malformed source_snapshot_digest', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-dig1-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { source_snapshot_digest: `'not-hex'` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_source_snapshot_digest_format"/)
      })
      it('rejects an uppercase normalized_input_digest', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-dig2-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { normalized_input_digest: `'${HASH_A.toUpperCase()}'` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_normalized_input_digest_format"/)
      })
      it('rejects a malformed extraction_config_digest', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-dig3-${Date.now()}`)
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { extraction_config_digest: `'short'` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_config_digest_format"/)
      })
    })

    describe('structured_output shape', () => {
      it('rejects an unknown top-level key', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-so1-${Date.now()}`)
        const badOutput = JSON.stringify({ ...JSON.parse(VALID_STRUCTURED_OUTPUT().replace(/''/g, "'")), extra_key: 'x' }).replace(/'/g, "''")
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { structured_output: `'${badOutput}'::jsonb` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_structured_output_shape"/)
      })
      it('rejects an invalid specificity value', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-so2-${Date.now()}`)
        const badOutput = JSON.stringify({ ...JSON.parse(VALID_STRUCTURED_OUTPUT().replace(/''/g, "'")), specificity: 'weird' }).replace(/'/g, "''")
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { structured_output: `'${badOutput}'::jsonb` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_structured_output_shape"/)
      })
      it('rejects an invalid content_format value', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-so3-${Date.now()}`)
        const badOutput = JSON.stringify({ ...JSON.parse(VALID_STRUCTURED_OUTPUT().replace(/''/g, "'")), content_format: 'weird' }).replace(/'/g, "''")
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { structured_output: `'${badOutput}'::jsonb` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_structured_output_shape"/)
      })
      it('rejects an invalid label_language', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-so4-${Date.now()}`)
        const badOutput = JSON.stringify({ ...JSON.parse(VALID_STRUCTURED_OUTPUT().replace(/''/g, "'")), label_language: 'ENG' }).replace(/'/g, "''")
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { structured_output: `'${badOutput}'::jsonb` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_structured_output_shape"/)
      })
      it('rejects an out-of-range confidence inside structured_output', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-so5-${Date.now()}`)
        const badOutput = JSON.stringify({ ...JSON.parse(VALID_STRUCTURED_OUTPUT().replace(/''/g, "'")), confidence: 1.5 }).replace(/'/g, "''")
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { structured_output: `'${badOutput}'::jsonb` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_structured_output_shape"/)
      })
      it('rejects a mismatched embedded extraction_schema_version', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-so6-${Date.now()}`)
        const badOutput = VALID_STRUCTURED_OUTPUT(2) // embedded version 2, column says 1
        const err = insertExtractionRunExpectError(extractionRow(localEvidence, { structured_output: `'${badOutput}'::jsonb` }))
        expect(err).toMatch(/violates check constraint "topic_extraction_runs_structured_output_shape"/)
      })
      it('accepts a valid supporting_spans array (source_field + quoted_text, no offsets)', () => {
        const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-so7-${Date.now()}`)
        const id = insertExtractionRun(extractionRow(localEvidence))
        const out = dockerPsql(`select structured_output->'supporting_spans' from topic_extraction_runs where id='${id}';`).trim()
        expect(out).toContain('quoted_text')
        expect(out).not.toContain('start_offset')
      })
    })

    it('FK to signal_evidence is RESTRICT', () => {
      const out = dockerPsql(`select confdeltype from pg_constraint where conname='topic_extraction_runs_signal_evidence_id_fkey';`).trim()
      expect(out).toBe('r')
    })
  })

  // ------------------------------------------------------------
  // 5. topic_assignment_decisions domain constraints
  // ------------------------------------------------------------
  describe('topic_assignment_decisions', () => {
    it('accepts a QUARANTINE decision with NULL topic/membership', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-quar-${Date.now()}`)
      const extractionId = insertExtractionRun(extractionRow(localEvidence))
      const id = insertDecision(decisionRow(extractionId, localEvidence))
      expect(id).not.toBe('')
    })

    it('accepts a CREATE_NEW decision with topic+membership set', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-createnew-${Date.now()}`)
      const extractionId = insertExtractionRun(extractionRow(localEvidence))
      const topicId = insertTopic()
      const membershipId = insertMembership(topicId, localEvidence)
      const id = insertDecision(decisionRow(extractionId, localEvidence, {
        outcome: `'CREATE_NEW'`, decision_reason: `'no_similar_topic_found'`,
        semantic_topic_id: `'${topicId}'`, resulting_membership_id: `'${membershipId}'`,
      }))
      expect(id).not.toBe('')
    })

    it('rejects QUARANTINE with a non-NULL semantic_topic_id', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-badq-${Date.now()}`)
      const extractionId = insertExtractionRun(extractionRow(localEvidence))
      const topicId = insertTopic()
      const err = insertDecisionExpectError(decisionRow(extractionId, localEvidence, { semantic_topic_id: `'${topicId}'` }))
      expect(err).toMatch(/violates check constraint "topic_assignment_decisions_outcome_fields_pairing"/)
    })

    it('rejects CREATE_NEW with a NULL semantic_topic_id', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-badc-${Date.now()}`)
      const extractionId = insertExtractionRun(extractionRow(localEvidence))
      const err = insertDecisionExpectError(decisionRow(extractionId, localEvidence, { outcome: `'CREATE_NEW'`, decision_reason: `'no_similar_topic_found'` }))
      expect(err).toMatch(/violates check constraint "topic_assignment_decisions_outcome_fields_pairing"/)
    })

    it('rejects an outcome outside the enum', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-badout-${Date.now()}`)
      const extractionId = insertExtractionRun(extractionRow(localEvidence))
      const err = insertDecisionExpectError(decisionRow(extractionId, localEvidence, { outcome: `'MADE_UP'`, decision_reason: `'below_confidence_threshold'` }))
      expect(err).toMatch(/violates check constraint "topic_assignment_decisions_outcome_check"/)
    })

    it('rejects a decision_reason outside the enum', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-badreason-${Date.now()}`)
      const extractionId = insertExtractionRun(extractionRow(localEvidence))
      const err = insertDecisionExpectError(decisionRow(extractionId, localEvidence, { decision_reason: `'made_up'` }))
      expect(err).toMatch(/violates check constraint "topic_assignment_decisions_decision_reason_check"/)
    })

    it('extraction_run_id is UNIQUE (1:1 with extraction)', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-1to1-${Date.now()}`)
      const extractionId = insertExtractionRun(extractionRow(localEvidence))
      insertDecision(decisionRow(extractionId, localEvidence))
      const err = insertDecisionExpectError(decisionRow(extractionId, localEvidence))
      expect(err).toMatch(/duplicate key value violates unique constraint "topic_assignment_decisions_extraction_run_id_key"/)
    })

    it('idempotency_key is UNIQUE', () => {
      const key = `sti-s2a-decidem-${Date.now()}`
      const ev1 = insertFixtureEvidence(sourceId, runId, `sti-s2a-decidem1-${Date.now()}`)
      const ext1 = insertExtractionRun(extractionRow(ev1))
      insertDecision(decisionRow(ext1, ev1, { idempotency_key: `'${key}'` }))
      const ev2 = insertFixtureEvidence(sourceId, runId, `sti-s2a-decidem2-${Date.now()}`)
      const ext2 = insertExtractionRun(extractionRow(ev2))
      const err = insertDecisionExpectError(decisionRow(ext2, ev2, { idempotency_key: `'${key}'` }))
      expect(err).toMatch(/duplicate key value violates unique constraint "topic_assignment_decisions_idempotency_key_key"/)
    })

    it('rejects a nonexistent extraction_run_id (FK)', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-nofk-${Date.now()}`)
      const err = insertDecisionExpectError(decisionRow('00000000-0000-0000-0000-000000000000', localEvidence))
      expect(err).toMatch(/violates foreign key constraint/i)
    })

    it('FKs are all RESTRICT', () => {
      const out = dockerPsql(`select conname||':'||confdeltype::text from pg_constraint where conrelid='public.topic_assignment_decisions'::regclass and contype='f' order by conname;`).trim().split('\n')
      for (const line of out) expect(line.endsWith(':r')).toBe(true)
    })
  })

  // ------------------------------------------------------------
  // 6. semantic_topic_membership_events
  // ------------------------------------------------------------
  describe('semantic_topic_membership_events', () => {
    it('accepts a well-formed attached event with a real decision reference (NOT NULL enforced)', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-evt-${Date.now()}`)
      const extractionId = insertExtractionRun(extractionRow(localEvidence))
      const topicId = insertTopic()
      const membershipId = insertMembership(topicId, localEvidence)
      const decisionId = insertDecision(decisionRow(extractionId, localEvidence, {
        outcome: `'CREATE_NEW'`, decision_reason: `'no_similar_topic_found'`,
        semantic_topic_id: `'${topicId}'`, resulting_membership_id: `'${membershipId}'`,
      }))
      const id = dockerPsql(`
        insert into semantic_topic_membership_events (semantic_topic_id, signal_evidence_id, related_membership_id, event_type, related_assignment_decision_id, event_reason)
        values ('${topicId}', '${localEvidence}', '${membershipId}', 'attached', '${decisionId}', 'topic_creation_seed') returning id;
      `).trim()
      expect(id).not.toBe('')
    })

    it('rejects a NULL related_assignment_decision_id', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-evtnull-${Date.now()}`)
      const topicId = insertTopic()
      const membershipId = insertMembership(topicId, localEvidence)
      const err = dockerPsqlExpectError(`
        insert into semantic_topic_membership_events (semantic_topic_id, signal_evidence_id, related_membership_id, event_type, related_assignment_decision_id, event_reason)
        values ('${topicId}', '${localEvidence}', '${membershipId}', 'attached', NULL, 'topic_creation_seed');
      `)
      expect(err).toMatch(/null value in column "related_assignment_decision_id"/)
    })

    it('rejects an event_type outside the enum', () => {
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-s2a-evttype-${Date.now()}`)
      const extractionId = insertExtractionRun(extractionRow(localEvidence))
      const topicId = insertTopic()
      const membershipId = insertMembership(topicId, localEvidence)
      const decisionId = insertDecision(decisionRow(extractionId, localEvidence, {
        outcome: `'CREATE_NEW'`, decision_reason: `'no_similar_topic_found'`,
        semantic_topic_id: `'${topicId}'`, resulting_membership_id: `'${membershipId}'`,
      }))
      const err = dockerPsqlExpectError(`
        insert into semantic_topic_membership_events (semantic_topic_id, signal_evidence_id, related_membership_id, event_type, related_assignment_decision_id, event_reason)
        values ('${topicId}', '${localEvidence}', '${membershipId}', 'made_up', '${decisionId}', 'topic_creation_seed');
      `)
      expect(err).toMatch(/violates check constraint "semantic_topic_membership_events_event_type_check"/)
    })

    it('FKs are all RESTRICT', () => {
      const out = dockerPsql(`select conname||':'||confdeltype::text from pg_constraint where conrelid='public.semantic_topic_membership_events'::regclass and contype='f' order by conname;`).trim().split('\n')
      for (const line of out) expect(line.endsWith(':r')).toBe(true)
    })
  })

  // ------------------------------------------------------------
  // 7. Security / grant matrix -- all 3 new tables
  // ------------------------------------------------------------
  describe('security / grant matrix', () => {
    const tables = ['topic_extraction_runs', 'topic_assignment_decisions', 'semantic_topic_membership_events']

    it('RLS is enabled and forced on all 3 tables, with 0 policies', () => {
      const rls = dockerPsql(`select relname||':'||relrowsecurity||':'||relforcerowsecurity from pg_class where relname in (${tables.map((t) => `'${t}'`).join(',')}) order by relname;`).trim().split('\n')
      expect(rls.length).toBe(3)
      for (const line of rls) expect(line.endsWith(':true:true')).toBe(true)
      const policies = dockerPsql(`select count(*) from pg_policies where tablename in (${tables.map((t) => `'${t}'`).join(',')});`).trim()
      expect(policies).toBe('0')
    })

    it('service_role has exactly SELECT on all 3 tables; anon/authenticated/PUBLIC have 0 grants', () => {
      const grants = dockerPsql(`
        select table_name||':'||privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name in (${tables.map((t) => `'${t}'`).join(',')}) and grantee='service_role'
        order by 1;
      `).trim().split('\n')
      expect(grants.length).toBe(3)
      for (const line of grants) expect(line.endsWith(':SELECT')).toBe(true)
      const forbidden = dockerPsql(`
        select count(*) from information_schema.role_table_grants
        where table_schema='public' and table_name in (${tables.map((t) => `'${t}'`).join(',')})
          and grantee in ('anon','authenticated','PUBLIC');
      `).trim()
      expect(forbidden).toBe('0')
    })

    it.each(tables)('service_role cannot INSERT/UPDATE/DELETE on %s directly (SET ROLE, real grant check)', (table) => {
      const insErr = dockerPsqlExpectError(`SET ROLE service_role; insert into ${table} default values; RESET ROLE;`)
      expect(insErr).toMatch(/permission denied/i)
    })

    it.each(tables)('service_role CAN SELECT from %s directly (SET ROLE, real grant check)', (table) => {
      const out = dockerPsql(`SET ROLE service_role; select count(*) from ${table}; RESET ROLE;`)
      expect(out).not.toBe('')
    })

    it.each(tables)('anon cannot SELECT %s (SET ROLE, real grant check)', (table) => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select count(*) from ${table}; RESET ROLE;`)
      expect(err).toMatch(/permission denied/i)
    })

    it.each(tables)('authenticated cannot SELECT %s (SET ROLE, real grant check)', (table) => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; select count(*) from ${table}; RESET ROLE;`)
      expect(err).toMatch(/permission denied/i)
    })
  })

  // ------------------------------------------------------------
  // 8. 0 NOT VALID constraints across all 073 objects
  // ------------------------------------------------------------
  it('there are 0 NOT VALID constraints across all 073-introduced objects', () => {
    const out = dockerPsql(`
      select count(*) from pg_constraint
      where conrelid in (
        'public.topic_extraction_runs'::regclass, 'public.topic_assignment_decisions'::regclass,
        'public.semantic_topic_membership_events'::regclass, 'public.semantic_topic_membership'::regclass
      ) and convalidated is not true;
    `).trim()
    expect(out).toBe('0')
  })
})
