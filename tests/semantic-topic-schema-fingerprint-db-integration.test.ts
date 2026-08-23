// Semantic Topic Identity v0 -- post-suite schema fingerprint.
//
// Purely read-only (pg_catalog/information_schema SELECT queries only, no
// DDL, no fixture rows, no cleanup needed) -- safe to run ANYWHERE in a
// test run, in any order, any number of times, without a `supabase db
// reset`. Its job is to prove the FULL 072->075 semantic-topic schema is
// still completely intact and undrifted at the moment it runs, independent
// of what other suites (which deliberately corrupt-then-restore parts of
// this same schema, e.g. semantic-topic-s2a-audit-temporal-db-integration.test.ts)
// already did in this same process. "the suite was green" is not the same
// claim as "the schema is still whole after the suite" -- this file proves
// the second one, explicitly, on demand.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30000 })

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
    input: sql,
    encoding: 'utf-8',
  })
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}
const describeIfLocalDb = stackAvailable ? describe : describe.skip

describeIfLocalDb('Semantic Topic Identity v0 -- post-suite schema fingerprint (read-only, no reset)', () => {
  it('072: both tables (semantic_topics, semantic_topic_membership) are present', () => {
    const out = dockerPsql(`
      select count(*) from pg_tables where schemaname='public'
        and tablename in ('semantic_topics', 'semantic_topic_membership');
    `).trim()
    expect(out).toBe('2')
  })

  it('073: all three tables are present (topic_extraction_runs, topic_assignment_decisions, semantic_topic_membership_events)', () => {
    const out = dockerPsql(`
      select count(*) from pg_tables where schemaname='public'
        and tablename in ('topic_extraction_runs', 'topic_assignment_decisions', 'semantic_topic_membership_events');
    `).trim()
    expect(out).toBe('3')
  })

  it('074: both writer RPCs are present with the exact expected body hash and ACL', () => {
    const rows = dockerPsql(`
      select p.proname || '|' || md5(replace(p.prosrc, E'\\r\\n', E'\\n')) || '|' ||
        (has_function_privilege('service_role', p.oid, 'EXECUTE'))::text || '|' ||
        (has_function_privilege('anon', p.oid, 'EXECUTE'))::text || '|' ||
        (has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('record_topic_extraction_run', 'record_topic_assignment_decision')
      order by p.proname;
    `).trim().split('\n')
    expect(rows).toHaveLength(2)
    const expected: Record<string, string> = {
      record_topic_assignment_decision: '759de5ab474c9a7aa105564ca95541cc',
      record_topic_extraction_run: 'f6ed6773724c95c2deccc2f7ca692e89',
    }
    for (const row of rows) {
      const [name, hash, svc, anon, auth] = row.split('|')
      expect(hash).toBe(expected[name])
      expect(svc).toBe('true')
      expect(anon).toBe('false')
      expect(auth).toBe('false')
    }
  })

  it('075: all three tables are present (ai_extraction_control, ai_provider_daily_budgets, ai_provider_budget_reservations)', () => {
    const out = dockerPsql(`
      select count(*) from pg_tables where schemaname='public'
        and tablename in ('ai_extraction_control', 'ai_provider_daily_budgets', 'ai_provider_budget_reservations');
    `).trim()
    expect(out).toBe('3')
  })

  it('075: ai_provider_budget_reservations.extraction_run_id FK to topic_extraction_runs is present and exactly RESTRICT', () => {
    const out = dockerPsql(`
      select pg_get_constraintdef(oid, true) from pg_constraint
      where conname = 'ai_provider_budget_reservations_extraction_run_id_fkey';
    `).trim()
    expect(out).toBe('FOREIGN KEY (extraction_run_id) REFERENCES topic_extraction_runs(id) ON DELETE RESTRICT')
  })

  it('075: all 7 AI-quota RPCs are present with the exact expected body hash and ACL', () => {
    const expected: Record<string, string> = {
      reserve_ai_provider_units: '7782026c482e5ba6fd4f7a5a01a3d8aa',
      mark_ai_provider_attempt_started: '27f8326eb24641a149e72ac9748e0e1d',
      commit_ai_provider_units: '1bfb1df62ceb15624583fedebd99f705',
      mark_ai_provider_outcome_unknown: '186d3f26bef951e79aff077f87e293ce',
      release_ai_provider_units: '22b2b563668e71248731a707e6d6f12a',
      finalize_ai_provider_reservation_outcome: 'f61c4c5791e578e4ed8f45816fc618b9',
      reconcile_stale_ai_provider_reservations: '4729a222a07039de3ea94a7141cc0775',
    }
    const rows = dockerPsql(`
      select p.proname || '|' || md5(replace(p.prosrc, E'\\r\\n', E'\\n')) || '|' ||
        (has_function_privilege('service_role', p.oid, 'EXECUTE'))::text || '|' ||
        (has_function_privilege('anon', p.oid, 'EXECUTE'))::text || '|' ||
        (has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in (${Object.keys(expected).map(n => `'${n}'`).join(',')})
      order by p.proname;
    `).trim().split('\n')
    expect(rows).toHaveLength(7)
    for (const row of rows) {
      const [name, hash, svc, anon, auth] = row.split('|')
      expect(hash, `${name} body hash`).toBe(expected[name])
      expect(svc, `${name} service_role EXECUTE`).toBe('true')
      expect(anon, `${name} anon EXECUTE (must be forbidden)`).toBe('false')
      expect(auth, `${name} authenticated EXECUTE (must be forbidden)`).toBe('false')
    }
  })

  it('0 NOT VALID constraints across every 072-075 semantic-topic object', () => {
    const out = dockerPsql(`
      select count(*) from pg_constraint
      where conrelid = ANY (ARRAY[
        'public.semantic_topics'::regclass, 'public.semantic_topic_membership'::regclass,
        'public.topic_extraction_runs'::regclass, 'public.topic_assignment_decisions'::regclass,
        'public.semantic_topic_membership_events'::regclass,
        'public.ai_extraction_control'::regclass, 'public.ai_provider_daily_budgets'::regclass,
        'public.ai_provider_budget_reservations'::regclass
      ])
      and convalidated = false;
    `).trim()
    expect(out).toBe('0')
  })

  it('RLS is enabled+forced with zero policies on all three 075 tables', () => {
    const out = dockerPsql(`
      select tablename, relrowsecurity, relforcerowsecurity,
        (select count(*) from pg_policies pol where pol.schemaname='public' and pol.tablename=cl.relname)
      from pg_tables t
      join pg_class cl on cl.relname = t.tablename
      join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
      where t.schemaname='public' and t.tablename in ('ai_extraction_control', 'ai_provider_daily_budgets', 'ai_provider_budget_reservations')
      order by t.tablename;
    `).trim().split('\n')
    expect(out).toHaveLength(3)
    for (const row of out) {
      const [, rls, forced, policyCount] = row.split('|')
      expect(rls).toBe('t')
      expect(forced).toBe('t')
      expect(policyCount).toBe('0')
    }
  })

  it('grant matrix: service_role SELECT-only on daily_budgets/reservations, SELECT+UPDATE on control; zero anon/authenticated/PUBLIC grants anywhere', () => {
    const controlGrants = dockerPsql(`
      select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
      where table_schema='public' and table_name='ai_extraction_control' and grantee='service_role';
    `).trim()
    expect(controlGrants).toBe('SELECT,UPDATE')

    for (const table of ['ai_provider_daily_budgets', 'ai_provider_budget_reservations']) {
      const grants = dockerPsql(`
        select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
        where table_schema='public' and table_name='${table}' and grantee='service_role';
      `).trim()
      expect(grants, table).toBe('SELECT')
    }

    const forbidden = dockerPsql(`
      select count(*) from information_schema.role_table_grants
      where table_schema='public'
        and table_name in ('ai_extraction_control', 'ai_provider_daily_budgets', 'ai_provider_budget_reservations')
        and grantee in ('anon', 'authenticated', 'PUBLIC');
    `).trim()
    expect(forbidden).toBe('0')
  })

  it('all expected indexes exist and are valid+ready on ai_provider_budget_reservations', () => {
    const out = dockerPsql(`
      select c.relname, ix.indisvalid, ix.indisready
      from pg_index ix join pg_class c on c.oid = ix.indexrelid
      where ix.indrelid = 'public.ai_provider_budget_reservations'::regclass
      order by c.relname;
    `).trim().split('\n')
    const names = out.map(r => r.split('|')[0])
    expect(names.sort()).toEqual([
      'ai_provider_budget_reservations_key',
      'ai_provider_budget_reservations_pkey',
      'idx_ai_provider_budget_reservations_evidence_digest',
      'idx_ai_provider_budget_reservations_stale_reserved',
    ])
    for (const row of out) {
      const [, valid, ready] = row.split('|')
      expect(valid).toBe('t')
      expect(ready).toBe('t')
    }
  })

  it('migration 075, re-run against the current live schema, is a byte-exact VALIDATE no-op (not merely "the suite passed")', () => {
    const migrationSql = readFileSync(join(process.cwd(), 'supabase/migrations/075_semantic_topic_s3a_ai_quota_foundation.sql'), 'utf8')
    let out: string
    let threw = false
    try {
      out = execSync(
        'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
        { input: migrationSql, encoding: 'utf8' },
      )
    } catch (e: any) {
      out = String(e.stdout || e.stderr || e.message || '')
      threw = true
    }
    expect(threw, `075 re-run unexpectedly failed:\n${out!}`).toBe(false)
    expect(out!).not.toMatch(/drift/i)
    expect(out!).toMatch(/ai_extraction_control already exists and matches exactly/)
    expect(out!).toMatch(/ai_provider_daily_budgets already exists and matches exactly/)
    expect(out!).toMatch(/ai_provider_budget_reservations already exists and matches exactly/)
    for (const name of [
      'reserve_ai_provider_units', 'mark_ai_provider_attempt_started', 'commit_ai_provider_units',
      'mark_ai_provider_outcome_unknown', 'release_ai_provider_units',
      'finalize_ai_provider_reservation_outcome', 'reconcile_stale_ai_provider_reservations',
    ]) {
      expect(out!).toMatch(new RegExp(`${name} already exists and matches exactly`))
    }
  })
})
