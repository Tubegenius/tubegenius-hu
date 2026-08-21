// Semantic Topic Identity v0 — S1 schema, REAL local DB integration tests.
//
// Ugyanazt a mintat koveti, mint a shadow-topic-score-schema-db-integration
// suite: a MEGLEVO, futo lokalis Supabase Docker stacket hasznalja
// (supabase_db_WillViralFinal — nem production). Ha a stack nem elerheto,
// a teljes describe-blokk kontrolláltan KIHAGYODIK.
//
// Ez a kor (S1) kizarolag semat hoz letre — nincs RPC, nincs app-kod iro
// (service_role csak SELECT-et kap mindket tablan). A fixture-sorokat ezert
// kozvetlenul, postgres-szuperfelhasznalokent szurjuk be, ugyanugy ahogy a
// shadow-topic suite is teszi.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION_PATH = join(process.cwd(), 'supabase/migrations/072_semantic_topic_identity_foundation.sql')

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
const HASH_C = 'c'.repeat(64)

function randomHexDigest(): string {
  let s = ''
  while (s.length < 64) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

function cleanupTestData() {
  dockerPsql(`
    delete from semantic_topic_membership where semantic_topic_id in (select id from semantic_topics where canonical_label like 'STI test%');
    delete from semantic_topics where canonical_label like 'STI test%';
    delete from signal_evidence where external_ref like 'sti-fixture-%';
    delete from signal_sources where external_id like 'sti-fixture-%';
    delete from signal_runs where idempotency_key like 'sti-fixture-%';
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
    values ('${sourceId}', 'youtube_video', '${externalRef}', 'STI fixture evidence', '${runId}')
    returning id;
  `).trim()
}

function insertTopic(overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    canonical_label: `'STI test topic ${Math.random().toString(36).slice(2)}'`,
    label_language: `'en'`,
    creation_request_digest: `'${randomHexDigest()}'`,
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into semantic_topics (${cols}) values (${vals}) returning id;`).trim()
}

function insertTopicExpectError(overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    canonical_label: `'STI test topic ${Math.random().toString(36).slice(2)}'`,
    label_language: `'en'`,
    creation_request_digest: `'${randomHexDigest()}'`,
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsqlExpectError(`insert into semantic_topics (${cols}) values (${vals});`)
}

function membershipRow(topicId: string, evidenceId: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    semantic_topic_id: `'${topicId}'`,
    signal_evidence_id: `'${evidenceId}'`,
    assignment_reason: `'entity_event_match'`,
    confidence: '0.9000',
    algorithm_version: '1',
    ...overrides,
  }
}

function insertMembership(row: Record<string, string>): string {
  const cols = Object.keys(row).join(', ')
  const vals = Object.values(row).join(', ')
  return dockerPsql(`insert into semantic_topic_membership (${cols}) values (${vals}) returning id;`).trim()
}

function insertMembershipExpectError(row: Record<string, string>): string {
  const cols = Object.keys(row).join(', ')
  const vals = Object.values(row).join(', ')
  return dockerPsqlExpectError(`insert into semantic_topic_membership (${cols}) values (${vals});`)
}

describeIfLocalDb('Semantic Topic Identity v0 S1 — semantic_topics / semantic_topic_membership schema (real local DB)', () => {
  let runId: string
  let sourceId: string
  let evidenceA: string
  let evidenceB: string

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
    cleanupTestData()
    runId = insertFixtureRun(`sti-fixture-${Date.now()}`)
    sourceId = insertFixtureSource(`sti-fixture-${Date.now()}`)
    evidenceA = insertFixtureEvidence(sourceId, runId, `sti-fixture-a-${Date.now()}`)
    evidenceB = insertFixtureEvidence(sourceId, runId, `sti-fixture-b-${Date.now()}`)
  })

  afterAll(() => {
    cleanupTestData()
  })

  // ------------------------------------------------------------
  // 1. Global topology gate — 1-of-2 fails closed before any CREATE;
  //    a full 0-of-2 -> 2-of-2 cycle proves the "fresh migration creates
  //    exactly 2 tables" and restores state for every later test.
  //    Runs first and is self-contained: it only touches the two new
  //    tables, never the fixture tables set up above.
  // ------------------------------------------------------------
  describe('global topology gate', () => {
    it('a 1-of-2 state (only semantic_topics present) is rejected before any DDL, leaving the surviving table untouched', () => {
      dockerPsql('DROP TABLE public.semantic_topic_membership;')
      const before = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename='semantic_topics';`).trim()
      expect(before).toBe('1')

      const { out, threw } = runMigration()
      expect(threw).toBe(true)
      expect(out).toMatch(/072 fail-closed: partial topology detected — exactly 1 of 2/)

      const stillThere = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename='semantic_topics';`).trim()
      expect(stillThere).toBe('1')
      const membershipStillGone = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename='semantic_topic_membership';`).trim()
      expect(membershipStillGone).toBe('0')
    })

    it('a fresh 0-of-2 state creates exactly 2 new, empty tables, and the migration is then a byte-exact no-op on re-run', () => {
      dockerPsql('DROP TABLE public.semantic_topics;')
      const zeroOfTwo = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename in ('semantic_topics','semantic_topic_membership');`).trim()
      expect(zeroOfTwo).toBe('0')

      const first = runMigration()
      expect(first.threw).toBe(false)
      expect(first.out).toMatch(/semantic_topics created\./)
      expect(first.out).toMatch(/semantic_topic_membership created\./)

      const twoOfTwo = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename in ('semantic_topics','semantic_topic_membership');`).trim()
      expect(twoOfTwo).toBe('2')
      const rowCounts = dockerPsql(`select (select count(*) from semantic_topics)||'|'||(select count(*) from semantic_topic_membership);`).trim()
      expect(rowCounts).toBe('0|0')

      const second = runMigration()
      expect(second.threw).toBe(false)
      expect(second.out).toMatch(/semantic_topics already exists and matches exactly — no-op\./)
      expect(second.out).toMatch(/semantic_topic_membership already exists and matches exactly — no-op\./)
      expect(second.out).not.toMatch(/drift/)
    })
  })

  // ------------------------------------------------------------
  // 2. Column / constraint / index / RLS / policy / grant drift —
  //    each mutated then reverted so the suite ends in a clean state.
  // ------------------------------------------------------------
  describe('drift fail-closed (column, constraint, index, RLS, policy, grant, owner)', () => {
    it('an unauthorized column addition makes a re-run fail closed; reverting restores a clean no-op', () => {
      dockerPsql('ALTER TABLE public.semantic_topics ADD COLUMN sti_drift_probe TEXT;')
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      dockerPsql('ALTER TABLE public.semantic_topics DROP COLUMN sti_drift_probe;')
      const good = runMigration()
      expect(good.threw).toBe(false)
      expect(good.out).toMatch(/semantic_topics already exists and matches exactly — no-op\./)
    })

    it('dropping a CHECK constraint makes a re-run fail closed; re-adding the identical constraint restores a clean no-op', () => {
      dockerPsql('ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT semantic_topic_membership_algorithm_version_positive;')
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/072 drift: semantic_topic_membership constraint set\/definition does not match exactly/)
      dockerPsql('ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_algorithm_version_positive CHECK (algorithm_version >= 1);')
      const good = runMigration()
      expect(good.threw).toBe(false)
      expect(good.out).toMatch(/semantic_topic_membership already exists and matches exactly — no-op\./)
    })

    it('dropping a non-PK index makes a re-run fail closed; recreating the identical index restores a clean no-op', () => {
      dockerPsql('DROP INDEX public.idx_semantic_topic_membership_temporal;')
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/072 drift: semantic_topic_membership index set\/definition does not match exactly/)
      dockerPsql('CREATE INDEX idx_semantic_topic_membership_temporal ON public.semantic_topic_membership (semantic_topic_id, valid_from, valid_to);')
      const good = runMigration()
      expect(good.threw).toBe(false)
    })

    it('disabling RLS makes a re-run fail closed; re-enabling+forcing restores a clean no-op', () => {
      dockerPsql('ALTER TABLE public.semantic_topics DISABLE ROW LEVEL SECURITY;')
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/072 drift: semantic_topics RLS is not exactly enabled\+forced/)
      dockerPsql('ALTER TABLE public.semantic_topics ENABLE ROW LEVEL SECURITY; ALTER TABLE public.semantic_topics FORCE ROW LEVEL SECURITY;')
      const good = runMigration()
      expect(good.threw).toBe(false)
    })

    it('an unexpected RLS policy makes a re-run fail closed; dropping it restores a clean no-op', () => {
      dockerPsql(`CREATE POLICY sti_drift_probe_policy ON public.semantic_topics FOR SELECT USING (true);`)
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/072 drift: semantic_topics has an unexpected policy/)
      dockerPsql('DROP POLICY sti_drift_probe_policy ON public.semantic_topics;')
      const good = runMigration()
      expect(good.threw).toBe(false)
    })

    it('an extra service_role grant makes a re-run fail closed; revoking it restores a clean no-op', () => {
      dockerPsql('GRANT INSERT ON public.semantic_topics TO service_role;')
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/072 drift: semantic_topics service_role grant set does not match exactly/)
      dockerPsql('REVOKE INSERT ON public.semantic_topics FROM service_role;')
      const good = runMigration()
      expect(good.threw).toBe(false)
    })

    it('a forbidden anon grant makes a re-run fail closed; revoking it restores a clean no-op', () => {
      dockerPsql('GRANT SELECT ON public.semantic_topic_membership TO anon;')
      const bad = runMigration()
      expect(bad.threw).toBe(true)
      expect(bad.out).toMatch(/072 drift: semantic_topic_membership has a forbidden anon\/authenticated\/PUBLIC grant/)
      dockerPsql('REVOKE SELECT ON public.semantic_topic_membership FROM anon;')
      const good = runMigration()
      expect(good.threw).toBe(false)
    })

    // Owner-drift is NOT exercised live here: `ALTER TABLE ... OWNER TO`
    // requires the executing role to be a member of the target role (or
    // superuser), and the target role must itself hold CREATE on schema
    // public. In this local stack `postgres` is not superuser (`supabase_
    // admin` is) and is not a member of any role that both it can assume
    // and that holds schema-public CREATE — every role `postgres` can
    // become a member of (anon/authenticated/service_role/authenticator/
    // ...) was deliberately stripped of schema-public CREATE by the 045-047
    // hardening baseline. Granting that back temporarily, even to restore
    // it after, would itself be a live mutation of the exact baseline this
    // migration is required to leave untouched — so it is intentionally
    // not attempted. The owner check itself (`072 drift: ... owner is not
    // postgres`) is the same code shape, in the same DO block, immediately
    // adjacent to the RLS/policy/grant checks that the other tests in this
    // describe block do exercise live — it is not a distinct, untested
    // mechanism, just one instance this environment cannot safely trigger.
  })

  // ------------------------------------------------------------
  // 3. Exact column matrix + 0 NOT VALID constraints
  // ------------------------------------------------------------
  it('semantic_topics has exactly the expected 9 columns', () => {
    const out = dockerPsql(`select column_name from information_schema.columns where table_schema='public' and table_name='semantic_topics' order by ordinal_position;`)
      .trim().split('\n')
    expect(out).toEqual([
      'id', 'lifecycle_status', 'canonical_label', 'label_language', 'specificity',
      'creation_request_digest', 'status_version', 'created_at', 'updated_at',
    ])
  })

  it('semantic_topic_membership has exactly the expected 9 columns', () => {
    const out = dockerPsql(`select column_name from information_schema.columns where table_schema='public' and table_name='semantic_topic_membership' order by ordinal_position;`)
      .trim().split('\n')
    expect(out).toEqual([
      'id', 'semantic_topic_id', 'signal_evidence_id', 'valid_from', 'valid_to',
      'assignment_reason', 'confidence', 'algorithm_version', 'created_at',
    ])
  })

  it('there are 0 NOT VALID constraints on either table', () => {
    const out = dockerPsql(`
      select count(*) from pg_constraint
      where conrelid in ('public.semantic_topics'::regclass, 'public.semantic_topic_membership'::regclass)
        and convalidated is not true;
    `).trim()
    expect(out).toBe('0')
  })

  // ------------------------------------------------------------
  // 4. semantic_topics domain / format constraints
  // ------------------------------------------------------------
  describe('semantic_topics domain constraints', () => {
    it('accepts all 8 documented lifecycle_status values', () => {
      const statuses = ['candidate_singleton', 'corroborating', 'coherent', 'ambiguous', 'split_required', 'merge_candidate', 'superseded', 'archived']
      for (const s of statuses) {
        const id = insertTopic({ lifecycle_status: `'${s}'` })
        expect(id).not.toBe('')
      }
    })

    it('rejects a lifecycle_status outside the enum', () => {
      const err = insertTopicExpectError({ lifecycle_status: `'deleted'` })
      expect(err).toMatch(/violates check constraint "semantic_topics_lifecycle_status_check"/)
    })

    it('lifecycle_status defaults to candidate_singleton when omitted', () => {
      const id = insertTopic()
      const out = dockerPsql(`select lifecycle_status from semantic_topics where id='${id}';`).trim()
      expect(out).toBe('candidate_singleton')
    })

    it('rejects a blank canonical_label (whitespace-only)', () => {
      const err = insertTopicExpectError({ canonical_label: `'   '` })
      expect(err).toMatch(/violates check constraint "semantic_topics_canonical_label_not_blank"/)
    })

    it('rejects an empty canonical_label', () => {
      const err = insertTopicExpectError({ canonical_label: `''` })
      expect(err).toMatch(/violates check constraint "semantic_topics_canonical_label_not_blank"/)
    })

    describe('label_language accept/reject matrix', () => {
      const accepted = ['en', 'hu', 'id', 'und', 'pt-BR', 'zh-Hans', 'zh-Hant-TW']
      for (const lang of accepted) {
        it(`accepts '${lang}'`, () => {
          const id = insertTopic({ label_language: `'${lang}'` })
          expect(id).not.toBe('')
        })
      }
      const rejected = ['', 'ENG', 'hu_HU', 'pt-br']
      for (const lang of rejected) {
        it(`rejects '${lang}'`, () => {
          const err = insertTopicExpectError({ label_language: `'${lang}'` })
          expect(err).toMatch(/violates check constraint "semantic_topics_label_language_(format|length)_check"/)
        })
      }
      it('rejects a label_language longer than 15 characters', () => {
        const err = insertTopicExpectError({ label_language: `'en-Latn-US-x-extra'` })
        expect(err).toMatch(/violates check constraint "semantic_topics_label_language_(format|length)_check"/)
      })
    })

    it('accepts all 3 documented specificity values', () => {
      for (const s of ['specific', 'generic', 'unknown']) {
        const id = insertTopic({ specificity: `'${s}'` })
        expect(id).not.toBe('')
      }
    })

    it('specificity defaults to unknown when omitted', () => {
      const id = insertTopic()
      expect(dockerPsql(`select specificity from semantic_topics where id='${id}';`).trim()).toBe('unknown')
    })

    it('rejects a specificity outside the enum', () => {
      const err = insertTopicExpectError({ specificity: `'vague'` })
      expect(err).toMatch(/violates check constraint "semantic_topics_specificity_check"/)
    })

    it('rejects a creation_request_digest that is not exactly 64 lowercase hex chars', () => {
      const err = insertTopicExpectError({ creation_request_digest: `'not-a-hash'` })
      expect(err).toMatch(/violates check constraint "semantic_topics_digest_format_check"/)
    })

    it('rejects a creation_request_digest with uppercase hex characters', () => {
      const err = insertTopicExpectError({ creation_request_digest: `'${HASH_A.toUpperCase()}'` })
      expect(err).toMatch(/violates check constraint "semantic_topics_digest_format_check"/)
    })

    it('creation_request_digest is UNIQUE', () => {
      insertTopic({ creation_request_digest: `'${HASH_B}'` })
      const err = insertTopicExpectError({ creation_request_digest: `'${HASH_B}'` })
      expect(err).toMatch(/duplicate key value violates unique constraint "semantic_topics_creation_request_digest_key"/)
    })

    it('status_version defaults to 1 and rejects 0', () => {
      const id = insertTopic()
      expect(dockerPsql(`select status_version from semantic_topics where id='${id}';`).trim()).toBe('1')
      const err = insertTopicExpectError({ status_version: '0' })
      expect(err).toMatch(/violates check constraint "semantic_topics_status_version_positive"/)
    })
  })

  // ------------------------------------------------------------
  // 5. semantic_topic_membership domain / format / FK constraints
  // ------------------------------------------------------------
  describe('semantic_topic_membership domain and FK constraints', () => {
    it('accepts all 4 documented assignment_reason values (as distinct closed rows, avoiding the active-uniqueness index)', () => {
      const topicId = insertTopic()
      const reasons = ['entity_event_match', 'embedding_similarity', 'manual_review_confirmed', 'manual_review_override']
      let t = 0
      for (const reason of reasons) {
        const id = insertMembership(membershipRow(topicId, evidenceA, {
          assignment_reason: `'${reason}'`,
          valid_from: `'2026-01-0${++t}T00:00:00Z'`,
          valid_to: `'2026-01-0${t}T01:00:00Z'`,
        }))
        expect(id).not.toBe('')
      }
    })

    it('rejects an assignment_reason outside the enum', () => {
      const topicId = insertTopic()
      const err = insertMembershipExpectError(membershipRow(topicId, evidenceA, { assignment_reason: `'guessed'` }))
      expect(err).toMatch(/violates check constraint "semantic_topic_membership_assignment_reason_check"/)
    })

    it('accepts confidence at both boundaries (0 and 1)', () => {
      const topicId = insertTopic()
      const localEvidence0 = insertFixtureEvidence(sourceId, runId, `sti-fixture-conf0-${Date.now()}`)
      const localEvidence1 = insertFixtureEvidence(sourceId, runId, `sti-fixture-conf1-${Date.now()}`)
      const id0 = insertMembership(membershipRow(topicId, localEvidence0, { confidence: '0' }))
      expect(id0).not.toBe('')
      const id1 = insertMembership(membershipRow(topicId, localEvidence1, { confidence: '1' }))
      expect(id1).not.toBe('')
    })

    it('rejects confidence below 0 or above 1', () => {
      const topicId = insertTopic()
      const errLow = insertMembershipExpectError(membershipRow(topicId, evidenceA, { confidence: '-0.0001' }))
      expect(errLow).toMatch(/violates check constraint "semantic_topic_membership_confidence_range_check"/)
      const errHigh = insertMembershipExpectError(membershipRow(topicId, evidenceA, { confidence: '1.0001' }))
      expect(errHigh).toMatch(/violates check constraint "semantic_topic_membership_confidence_range_check"/)
    })

    it('rejects algorithm_version below 1', () => {
      const topicId = insertTopic()
      const err = insertMembershipExpectError(membershipRow(topicId, evidenceA, { algorithm_version: '0' }))
      expect(err).toMatch(/violates check constraint "semantic_topic_membership_algorithm_version_positive"/)
    })

    it('rejects valid_to equal to valid_from, and valid_to before valid_from', () => {
      const topicId = insertTopic()
      const errEq = insertMembershipExpectError(membershipRow(topicId, evidenceA, {
        valid_from: `'2026-01-01T00:00:00Z'`, valid_to: `'2026-01-01T00:00:00Z'`,
      }))
      expect(errEq).toMatch(/violates check constraint "semantic_topic_membership_valid_to_after_valid_from"/)
      const errBefore = insertMembershipExpectError(membershipRow(topicId, evidenceA, {
        valid_from: `'2026-01-02T00:00:00Z'`, valid_to: `'2026-01-01T00:00:00Z'`,
      }))
      expect(errBefore).toMatch(/violates check constraint "semantic_topic_membership_valid_to_after_valid_from"/)
    })

    it('accepts a NULL valid_to (currently active membership)', () => {
      const topicId = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-fixture-nullvalidto-${Date.now()}`)
      const id = insertMembership(membershipRow(topicId, localEvidence))
      expect(dockerPsql(`select (valid_to is null) from semantic_topic_membership where id='${id}';`).trim()).toBe('t')
    })

    it('a nonexistent semantic_topic_id is rejected (FK)', () => {
      const err = insertMembershipExpectError(membershipRow('00000000-0000-0000-0000-000000000000', evidenceA))
      expect(err).toMatch(/violates foreign key constraint/i)
    })

    it('a nonexistent signal_evidence_id is rejected (FK)', () => {
      const topicId = insertTopic()
      const err = insertMembershipExpectError(membershipRow(topicId, '00000000-0000-0000-0000-000000000000'))
      expect(err).toMatch(/violates foreign key constraint/i)
    })

    it('a referenced semantic_topics row cannot be deleted while a membership row references it (RESTRICT)', () => {
      const topicId = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-fixture-restrict-topic-${Date.now()}`)
      insertMembership(membershipRow(topicId, localEvidence))
      const err = dockerPsqlExpectError(`delete from semantic_topics where id='${topicId}';`)
      expect(err).toMatch(/violates foreign key constraint/i)
    })

    it('a referenced signal_evidence row cannot be deleted while a membership row references it (RESTRICT)', () => {
      const topicId = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-fixture-restrict-${Date.now()}`)
      insertMembership(membershipRow(topicId, localEvidence))
      const err = dockerPsqlExpectError(`delete from signal_evidence where id='${localEvidence}';`)
      expect(err).toMatch(/violates foreign key constraint/i)
    })
  })

  // ------------------------------------------------------------
  // 6. Active-membership uniqueness + historical multiplicity +
  //    the explicit non-guarantee of temporal non-overlap
  // ------------------------------------------------------------
  describe('active-membership partial uniqueness (semantic_topic_membership_active_evidence_key)', () => {
    it('rejects a second concurrently-active (valid_to IS NULL) membership for the same evidence', () => {
      const topicA = insertTopic()
      const topicB = insertTopic()
      insertMembership(membershipRow(topicA, evidenceA))
      const err = insertMembershipExpectError(membershipRow(topicB, evidenceA))
      expect(err).toMatch(/duplicate key value violates unique constraint "semantic_topic_membership_active_evidence_key"/)
    })

    it('allows multiple closed (valid_to IS NOT NULL) historical memberships for the same evidence', () => {
      const topicA = insertTopic()
      const topicB = insertTopic()
      const id1 = insertMembership(membershipRow(topicA, evidenceB, { valid_from: `'2026-01-01T00:00:00Z'`, valid_to: `'2026-01-02T00:00:00Z'` }))
      const id2 = insertMembership(membershipRow(topicB, evidenceB, { valid_from: `'2026-01-02T00:00:00Z'`, valid_to: `'2026-01-03T00:00:00Z'` }))
      expect(id1).not.toBe('')
      expect(id2).not.toBe('')
      expect(id1).not.toBe(id2)
    })

    // S1 documented non-guarantee (TEMPORAL_NON_OVERLAP = DEFERRED_TO_S2,
    // see docs/architecture/semantic-topic-identity-v0-contract.md §8):
    // this deliberately proves the schema does NOT reject two closed rows
    // for the same evidence whose intervals overlap. This is not a bug in
    // this test — asserting rejection here would be a false PASS claim
    // about a guarantee S1 does not provide. A real EXCLUDE constraint
    // (requires btree_gist) is a future, separately-approved migration.
    it('does NOT reject overlapping closed historical intervals for the same evidence (documented S1 gap, not a guarantee)', () => {
      const topicA = insertTopic()
      const topicB = insertTopic()
      const localEvidence = insertFixtureEvidence(sourceId, runId, `sti-fixture-overlap-${Date.now()}`)
      const id1 = insertMembership(membershipRow(topicA, localEvidence, { valid_from: `'2026-02-01T00:00:00Z'`, valid_to: `'2026-02-10T00:00:00Z'` }))
      const id2 = insertMembership(membershipRow(topicB, localEvidence, { valid_from: `'2026-02-05T00:00:00Z'`, valid_to: `'2026-02-15T00:00:00Z'` }))
      expect(id1).not.toBe('')
      expect(id2).not.toBe('')
    })
  })

  // ------------------------------------------------------------
  // 7. Security / grant matrix — both tables, both directions, real SET ROLE
  // ------------------------------------------------------------
  describe('security / grant matrix', () => {
    it('RLS is enabled and forced on both tables, with 0 policies', () => {
      const rls = dockerPsql(`
        select relname||':'||relrowsecurity||':'||relforcerowsecurity from pg_class
        where relname in ('semantic_topics','semantic_topic_membership') order by relname;
      `).trim().split('\n')
      expect(rls).toEqual([
        'semantic_topic_membership:true:true',
        'semantic_topics:true:true',
      ])
      const policies = dockerPsql(`select count(*) from pg_policies where tablename in ('semantic_topics','semantic_topic_membership');`).trim()
      expect(policies).toBe('0')
    })

    it('service_role has exactly SELECT on both tables; anon/authenticated/PUBLIC have 0 grants', () => {
      const grants = dockerPsql(`
        select table_name||':'||privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name in ('semantic_topics','semantic_topic_membership') and grantee='service_role'
        order by 1;
      `).trim().split('\n')
      expect(grants).toEqual([
        'semantic_topic_membership:SELECT',
        'semantic_topics:SELECT',
      ])
      const forbidden = dockerPsql(`
        select count(*) from information_schema.role_table_grants
        where table_schema='public' and table_name in ('semantic_topics','semantic_topic_membership')
          and grantee in ('anon','authenticated','PUBLIC');
      `).trim()
      expect(forbidden).toBe('0')
    })

    it('service_role cannot INSERT/UPDATE/DELETE on semantic_topics directly (SET ROLE, real grant check)', () => {
      const insErr = dockerPsqlExpectError(`
        SET ROLE service_role;
        insert into semantic_topics (canonical_label, label_language, creation_request_digest) values ('x','en','${HASH_C}');
        RESET ROLE;
      `)
      expect(insErr).toMatch(/permission denied/i)

      const topicId = insertTopic()
      const updErr = dockerPsqlExpectError(`
        SET ROLE service_role;
        update semantic_topics set canonical_label='y' where id='${topicId}';
        RESET ROLE;
      `)
      expect(updErr).toMatch(/permission denied/i)

      const delErr = dockerPsqlExpectError(`
        SET ROLE service_role;
        delete from semantic_topics where id='${topicId}';
        RESET ROLE;
      `)
      expect(delErr).toMatch(/permission denied/i)
    })

    it('service_role cannot INSERT/UPDATE/DELETE on semantic_topic_membership directly (SET ROLE, real grant check)', () => {
      const topicId = insertTopic()
      const insErr = dockerPsqlExpectError(`
        SET ROLE service_role;
        insert into semantic_topic_membership (semantic_topic_id, signal_evidence_id, assignment_reason, confidence, algorithm_version) values ('${topicId}','${evidenceA}','entity_event_match',0.5,1);
        RESET ROLE;
      `)
      expect(insErr).toMatch(/permission denied/i)

      const membershipId = insertMembership(membershipRow(topicId, evidenceA, { valid_from: `'2020-01-01T00:00:00Z'`, valid_to: 'now()' }))
      const updErr = dockerPsqlExpectError(`
        SET ROLE service_role;
        update semantic_topic_membership set confidence=0.1 where id='${membershipId}';
        RESET ROLE;
      `)
      expect(updErr).toMatch(/permission denied/i)

      const delErr = dockerPsqlExpectError(`
        SET ROLE service_role;
        delete from semantic_topic_membership where id='${membershipId}';
        RESET ROLE;
      `)
      expect(delErr).toMatch(/permission denied/i)
    })

    it('service_role CAN SELECT from both tables directly (SET ROLE, real grant check)', () => {
      const out = dockerPsql(`
        SET ROLE service_role;
        select count(*) from semantic_topics;
        select count(*) from semantic_topic_membership;
        RESET ROLE;
      `)
      expect(out).not.toBe('')
    })

    it('anon cannot SELECT semantic_topics (SET ROLE, real grant check)', () => {
      const err = dockerPsqlExpectError(`
        SET ROLE anon;
        select count(*) from semantic_topics;
        RESET ROLE;
      `)
      expect(err).toMatch(/permission denied/i)
    })

    it('authenticated cannot SELECT semantic_topic_membership (SET ROLE, real grant check)', () => {
      const err = dockerPsqlExpectError(`
        SET ROLE authenticated;
        select count(*) from semantic_topic_membership;
        RESET ROLE;
      `)
      expect(err).toMatch(/permission denied/i)
    })
  })

  // ------------------------------------------------------------
  // 8. Legacy isolation — 072 touches nothing outside its own 2 tables
  // ------------------------------------------------------------
  describe('legacy isolation', () => {
    it('signal_clusters, signal_cluster_evidence, signal_score_runs, signal_cluster_scores, signal_collection_control, creator_memory, video_ideas all still exist untouched', () => {
      const out = dockerPsql(`
        select tablename from pg_tables where schemaname='public'
          and tablename in ('signal_clusters','signal_cluster_evidence','signal_score_runs','signal_cluster_scores','signal_collection_control','creator_memory','video_ideas')
        order by tablename;
      `).trim().split('\n')
      expect(out).toEqual([
        'creator_memory', 'signal_cluster_evidence', 'signal_cluster_scores',
        'signal_clusters', 'signal_collection_control', 'signal_score_runs', 'video_ideas',
      ])
    })

    it('signal_evidence column set is unchanged (post-054 shape, no ALTER by 072)', () => {
      const out = dockerPsql(`select column_name from information_schema.columns where table_schema='public' and table_name='signal_evidence' order by ordinal_position;`)
        .trim().split('\n')
      expect(out).toEqual([
        'id', 'signal_source_id', 'evidence_type', 'external_ref',
        'youtube_videos_ref', 'title', 'snippet', 'published_at', 'canonical_url',
        'is_syndication_copy_of', 'discovered_in_run_id', 'first_seen_at',
      ])
    })

    it('the 071 run_shadow_topic_scoring function body hash is unchanged', () => {
      const out = dockerPsql(`select md5(prosrc) from pg_proc where proname='run_shadow_topic_scoring';`).trim()
      expect(out).toBe('75e1ff9653b362191e62b213ea06237a')
    })

    it('no new sequence, function, or trigger exists on either new table', () => {
      const seq = dockerPsql(`select count(*) from information_schema.sequences where sequence_schema='public' and sequence_name like 'semantic_topic%';`).trim()
      expect(seq).toBe('0')
      const trig = dockerPsql(`
        select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
        where c.relname in ('semantic_topics','semantic_topic_membership') and not t.tgisinternal;
      `).trim()
      expect(trig).toBe('0')
    })
  })
})
