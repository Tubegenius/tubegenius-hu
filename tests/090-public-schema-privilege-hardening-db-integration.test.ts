// PFM Public Schema Privilege Hardening v1 -- REAL local DB integration tests
// for migration 090 and scripts/public-schema-privilege-guard.sql.
//
// Every mutating scenario runs inside a transaction that is ROLLED BACK, so the
// shared local stack is never left in a drifted state. The committed state under
// test is the clean 001-090 stack (090 applied by `supabase start` / the CLI).
// Coverage: apply from a simulated pre-090 state, no-op reapply, negative extra
// privileges for all three API roles, keeper DML set equality, the 31 pg_trgm
// allowlist, the 77 application functions, RLS, the platform-default upper bound
// (tighter accepted, wider rejected), unknown-future-object fail-fast, the
// topology guard (clean + injected drift), auth triggers and PostgREST negatives.
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 120000 })

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const ROOT = path.resolve(__dirname, '..')
const MIGRATION = readFileSync(path.join(ROOT, 'supabase', 'migrations', '090_public_schema_privilege_hardening.sql'), 'utf8')
const GUARD = readFileSync(path.join(ROOT, 'scripts', 'public-schema-privilege-guard.sql'), 'utf8')

interface PsqlResult {
  status: number | null
  output: string
}

// Migration 091 (Starter Credit Contract v1) deliberately replaces the body of handle_new_user_credits(),
// which 090 pins byte-for-byte. Every rolled-back transaction in THIS file therefore first restores the
// recorded pre-091 function (the state 001-090 leave behind), so 090 keeps being tested exactly as
// rolled out; 091 has its own suite (tests/091-starter-credit-contract-*.test.ts).
const PRE_091_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION public.handle_new_user_credits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.user_credits (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$;`
// md5(replace(prosrc, CRLF, LF)) of the 091 function body; the live catalog may legitimately carry it.
const POST_091_HANDLE_NEW_USER_CREDITS_BODY_MD5 = 'a93e8c9b68b6f11fee1bff310d00cf83'

// Migration 092 (Opportunity Evidence Snapshot) legitimately adds 1 new public table
// (video_idea_opportunity_snapshots, RLS-protected, 2 triggers) and 5 new public
// functions. 090's OWN embedded closing self-check (baked into MIGRATION_BODY,
// which this file re-executes verbatim to test 090's real fail-closed behaviour)
// pins an exact, frozen 77-function/82-table inventory AS OF 090's own authoring
// time -- that pinned block lives inside the immutable migration file itself
// (090 is NOT modified here, per the explicit constraint), so MIGRATION_BODY can
// never be widened to know about 092's functions.
//
// This mirrors EXACTLY the existing PRE_091_FUNCTION_SQL pattern above (which
// restores 090's frozen function body before re-testing 090): every scenario in
// this file that re-executes MIGRATION_BODY first UNDOES 092's additions inside
// the SAME rolled-back transaction, so 090's own pre-check sees exactly the
// 090-era baseline it was written against -- then the whole transaction is rolled
// back, so 092's real, committed objects are never actually touched. This is not
// a loosened check: 090's fail-closed logic itself is exercised completely
// unmodified; only the transient, rolled-back precondition changes.
//
// The DROP list is exhaustive and itemized against 092's actual migration text
// (supabase/migrations/092_opportunity_evidence_snapshot.sql, section 7's own
// REVOKE list + section 1/2's CREATE TABLE/TRIGGER) -- nothing here is a dynamic
// "drop whatever exists" wildcard.
const PRE_092_UNDO_SQL = `
DROP TABLE IF EXISTS public.video_idea_opportunity_snapshots CASCADE;
DROP FUNCTION IF EXISTS public._upsert_opportunity_evidence_snapshot(uuid, uuid, smallint, timestamptz, timestamptz, text, text, text, integer, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text);
DROP FUNCTION IF EXISTS public.ensure_opportunity_evidence_snapshot(uuid, uuid, smallint, timestamptz, timestamptz, text, text, text, integer, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text);
DROP FUNCTION IF EXISTS public.save_opportunity_recommendation_to_memory(uuid, uuid, text, text, text, integer, smallint, timestamptz, timestamptz, text, text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text);
DROP FUNCTION IF EXISTS public.enforce_opportunity_evidence_snapshot_identity();
DROP FUNCTION IF EXISTS public.touch_opportunity_evidence_snapshot_updated_at();`

// Itemized, audited contract for 092's 5 new application functions -- same line
// shape as 090's own pin_app entries (see the 090 migration's $pin_app$ block),
// added HERE (the test file) rather than inside 090's migration, exactly as
// authorized. Every field below is either syntactically certain from 092's own
// source (name, argument list, secdef, revoke/grant list) or independently
// cross-checked against an ALREADY-090-PINNED, live-verified function of
// identical shape (089's get_semantic_topic_lifecycle_reviewer_capability():
// same `SET search_path = public, pg_temp` declaration style, same
// REVOKE-ALL-then-GRANT-one-role pattern) for the exact cfg=/acl= serialization
// Postgres produces -- see cfg=search_path=public, pg_temp and the
// owner-always-present-once-touched acl= shape in 090's own pinned line for
// that function. body= is a plain md5 of the exact function source text
// (verified by direct computation from the committed 092 migration file, not
// guessed). NOT independently confirmed against a live catalog this round (no
// DB access authorized) -- see the accompanying report for this residual gap.
const PIN_092_APP = [
  'enforce_opportunity_evidence_snapshot_identity()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=f1e92da529b7f9333eb880687d8ac9b3',
  'touch_opportunity_evidence_snapshot_updated_at()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=5bdc21b8fa8fb1231bdb021e09a5bc8e',
  '_upsert_opportunity_evidence_snapshot(p_video_idea_id uuid, p_user_id uuid, p_schema_version smallint, p_captured_at timestamp with time zone, p_expires_at timestamp with time zone, p_title text, p_description text, p_hook_suggestion text, p_opportunity_score integer, p_score_breakdown jsonb, p_confidence text, p_trend_source_type text, p_trend_source_label text, p_risk_flags jsonb, p_topic_intelligence jsonb, p_web_sources jsonb, p_evidence_videos jsonb, p_region text, p_platform text, p_niche text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=1efad79ad4f7e2f3d4d337e15ca8011c',
  'ensure_opportunity_evidence_snapshot(p_user_id uuid, p_video_idea_id uuid, p_schema_version smallint, p_captured_at timestamp with time zone, p_expires_at timestamp with time zone, p_title text, p_description text, p_hook_suggestion text, p_opportunity_score integer, p_score_breakdown jsonb, p_confidence text, p_trend_source_type text, p_trend_source_label text, p_risk_flags jsonb, p_topic_intelligence jsonb, p_web_sources jsonb, p_evidence_videos jsonb, p_region text, p_platform text, p_niche text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=5782fcf0c2a4ec71cbb9bd6f2b76d394',
  'save_opportunity_recommendation_to_memory(p_user_id uuid, p_video_idea_id uuid, p_topic text, p_search_keyword text, p_platform text, p_opportunity_score integer, p_schema_version smallint, p_captured_at timestamp with time zone, p_expires_at timestamp with time zone, p_title text, p_description text, p_hook_suggestion text, p_score_breakdown jsonb, p_confidence text, p_trend_source_type text, p_trend_source_label text, p_risk_flags jsonb, p_topic_intelligence jsonb, p_web_sources jsonb, p_evidence_videos jsonb, p_region text, p_niche text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=1626407ab670447fc40014c5ae1d2661',
]

function psql(sql: string, user = 'postgres'): PsqlResult {
  const wrapped = /^\s*BEGIN;/.test(sql) ? sql.replace('BEGIN;', `BEGIN;\n${PRE_091_FUNCTION_SQL}`) : sql
  const result = spawnSync(
    'docker',
    ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    { input: wrapped, encoding: 'utf-8' },
  )
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function psqlOk(sql: string, user = 'postgres'): string {
  const r = psql(sql, user)
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.output.slice(0, 1500)}`)
  return r.output
}

let stackAvailable = false
try {
  stackAvailable = psql('select 1;').status === 0
} catch {
  stackAvailable = false
}
const describeIfLocalDb = stackAvailable ? describe : describe.skip

// ---- 090 source pieces ---------------------------------------------------------------------------
const MIGRATION_BODY = (() => {
  const lines = MIGRATION.split('\n')
  const begin = lines.findIndex((l) => l === 'BEGIN;')
  const commit = lines.lastIndexOf('COMMIT;')
  if (begin < 0 || commit < 0) throw new Error('090 must contain BEGIN; and COMMIT;')
  return lines.slice(begin + 1, commit).join('\n')
})()

const GUARD_BODY = GUARD.split('\n').filter((l) => l !== 'BEGIN;' && l !== 'ROLLBACK;' && !l.startsWith('\\pset')).join('\n')

function pinned(tag: string): string[] {
  const match = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(MIGRATION)
  if (!match) throw new Error(`pinned block ${tag} not found`)
  return JSON.parse(match[1]) as string[]
}

function constant(name: string): string {
  const match = new RegExp(`${name} CONSTANT (?:int|text) := '?([^';]+)'?;`).exec(MIGRATION)
  if (!match) throw new Error(`constant ${name} not found`)
  return match[1]
}

const TABLES_37 = [
  'ai_usage_logs', 'competitor_alert_dismissals', 'competitor_performance_snapshots', 'creator_memory', 'credit_ledger',
  'in_flight_requests', 'opportunity_cache', 'paid_results', 'profiles', 'similar_video_searches', 'source_video_analysis',
  'stripe_webhook_events', 'topic_clusters', 'topic_feedback', 'tracked_competitor_videos', 'tracked_competitors',
  'tracked_trend_candidates', 'trend_alert_dismissals', 'trend_candidate_cache', 'trend_candidate_snapshots',
  'trend_candidates', 'trend_feed_daily_snapshots', 'usage_logs', 'user_credits', 'video_audits', 'video_idea_events',
  'video_idea_proof_signals', 'video_ideas', 'video_packages', 'viral_score_cache', 'viral_score_searches',
  'youtube_channel_snapshots', 'youtube_channels', 'youtube_search_cache', 'youtube_search_logs',
  'youtube_video_snapshots', 'youtube_videos',
]
const TABLES_39_EXTRA = ['credit_bucket_migration_backup_037', 'youtube_oauth_tokens']
const TABLES_39 = [...TABLES_37, ...TABLES_39_EXTRA]
const EXTRA_PRIVS = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const API_ROLES = ['anon', 'authenticated', 'service_role']

// The pre-090 state of production, staging and the clean 001-089 stack (audit 2026-09-19).
const PRE_090_STATE_SQL = [
  ...TABLES_37.map((t) => `GRANT ${EXTRA_PRIVS.join(', ')} ON TABLE public.${t} TO anon, authenticated;`),
  ...TABLES_39.map((t) => `GRANT ${EXTRA_PRIVS.join(', ')} ON TABLE public.${t} TO service_role;`),
].join('\n')

const EXTRA_COUNTS_SQL = `
SELECT 'EXTRA|' || r || '|' || p || '|' || (
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND has_table_privilege(r, c.oid, p))
FROM (VALUES ('anon'),('authenticated'),('service_role')) roles(r)
CROSS JOIN (VALUES ('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) privs(p);`

function parseExtraCounts(output: string, tag = 'EXTRA'): Record<string, number> {
  const map: Record<string, number> = {}
  for (const line of output.split('\n')) {
    const m = new RegExp(`^${tag}\\|(\\w+)\\|(\\w+)\\|(\\d+)$`).exec(line.trim())
    if (m) map[`${m[1]}:${m[2]}`] = Number(m[3])
  }
  return map
}

// One scalar digest over everything 090 must NOT change: keeper DML, column ACLs, RLS, all public functions.
const DIGEST_EXPR = `
SELECT md5(concat_ws('#',
  (SELECT coalesce(string_agg(t, chr(10) ORDER BY t), '') FROM (
     SELECT c.relname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || '|' || a.privilege_type AS t
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
       AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole,'authenticated'::regrole,'service_role'::regrole))) s),
  (SELECT coalesce(string_agg(t, chr(10) ORDER BY t), '') FROM (
     SELECT c.relname || '.' || at.attname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || '|' || a.privilege_type AS t
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute at ON at.attrelid = c.oid CROSS JOIN LATERAL aclexplode(at.attacl) a
     WHERE n.nspname = 'public' AND at.attacl IS NOT NULL AND NOT at.attisdropped) s),
  (SELECT string_agg(c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity, chr(10) ORDER BY c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')),
  (SELECT string_agg(p.oid::regprocedure::text || '|' || pg_get_userbyid(p.proowner) || '|' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ';'), '') || '|' ||
       coalesce(p.proacl::text, '<null>') || '|' || md5(replace(p.prosrc, chr(13) || chr(10), chr(10))), chr(10) ORDER BY p.oid::regprocedure::text)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
))`

function guardViolations(output: string): string[] {
  return output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('VIOLATION|'))
}
function guardCount(output: string): number {
  const m = /GUARD_RESULT\|violations=(\d+)/.exec(output)
  if (!m) throw new Error(`no GUARD_RESULT in output: ${output.slice(0, 500)}`)
  return Number(m[1])
}

function runBodyAfter(prefixSql: string, user = 'postgres', asRole?: string): PsqlResult {
  const setRole = asRole ? `SET LOCAL ROLE ${asRole};` : ''
  // PRE_092_UNDO_SQL first (see its own comment): every MIGRATION_BODY re-run in
  // this file must see the 090-era baseline, not today's post-092 catalog.
  return psql(`BEGIN;\n${PRE_092_UNDO_SQL}\n${prefixSql}\n${setRole}\n${MIGRATION_BODY}\nROLLBACK;`, user)
}

const adminClient = createClient(LOCAL_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

describeIfLocalDb('090 hardening -- committed clean 001-090 state', () => {
  it('no API role holds TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on any public table (effective, incl. inherited)', () => {
    const counts = parseExtraCounts(psqlOk(EXTRA_COUNTS_SQL))
    for (const role of API_ROLES) for (const priv of EXTRA_PRIVS) expect(counts[`${role}:${priv}`], `${role}:${priv}`).toBe(0)
    expect(Object.keys(counts)).toHaveLength(12)
  })

  it('no ACL entry (explicit) grants the four privileges to anon/authenticated/service_role/PUBLIC on any public relation', () => {
    const out = psqlOk(`
      SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND a.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role'));`)
    expect(out.trim()).toBe('0')
  })

  it('the topology guard reports zero violations on the clean stack', () => {
    const out = psqlOk(GUARD)
    expect(guardViolations(out)).toEqual([])
    expect(guardCount(out)).toBe(0)
    // 090's own 82 tables + 092's 1 new (itemized, RLS-protected) table.
    expect(out).toMatch(/public_tables=83/)
    // 090's own 77 app + 31 pg_trgm functions + 092's 5 new (itemized) app functions.
    expect(out).toMatch(/public_functions=113/)
  })

  it('keeper DML sets equal the recorded sets exactly (anon/PUBLIC 0, authenticated, service_role)', () => {
    // 090's own frozen digest (c_dml_auth_digest/c_dml_service_digest, embedded
    // in the untouched 090 migration) is compared against the live set MINUS
    // 092's own itemized addition -- so 090's baseline is verified completely
    // unchanged, byte for byte, and 092's addition is checked separately below
    // as an exact, closed, named expectation (not folded into a re-derived
    // hash, which would need live-DB data this round doesn't have access to).
    const dml = (role: string) =>
      psqlOk(`
        SELECT count(*) || '|' || coalesce(md5(string_agg(t, E'\\n' ORDER BY t)), 'empty') FROM (
          SELECT c.relname || '|' || a.privilege_type AS t
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.grantee = '${role}'::regrole
            AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
            AND c.relname <> 'video_idea_opportunity_snapshots') s;`).trim()
    expect(dml('authenticated')).toBe(`${constant('c_dml_auth_count')}|${constant('c_dml_auth_digest')}`)
    expect(dml('service_role')).toBe(`${constant('c_dml_service_count')}|${constant('c_dml_service_digest')}`)
    const anonPublic = psqlOk(`
      SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND (a.grantee = 0 OR a.grantee = 'anon'::regrole)
        AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE');`)
    expect(anonPublic.trim()).toBe('0')

    // 092's own itemized addition (migration section 3: `GRANT SELECT ON
    // video_idea_opportunity_snapshots TO authenticated, service_role`) --
    // exactly this one row for each role, nothing else.
    const opp092Dml = (role: string) => psqlOk(`
      SELECT string_agg(c.relname || '|' || a.privilege_type, ',' ORDER BY a.privilege_type)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.grantee = '${role}'::regrole
        AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE') AND c.relname = 'video_idea_opportunity_snapshots';`).trim()
    expect(opp092Dml('authenticated')).toBe('video_idea_opportunity_snapshots|SELECT')
    expect(opp092Dml('service_role')).toBe('video_idea_opportunity_snapshots|SELECT')
  })

  it('RLS is enabled on all 82+1 public tables (090 unchanged + 092 itemized) and the 090 topology digest is unaffected', () => {
    // Same subtract-then-verify-separately shape as the DML digest test above,
    // and for the same reason (090's c_rls_digest is embedded, untouched, in
    // the migration file; recomputing a combined hash needs live baseline data
    // this round doesn't have access to).
    const out = psqlOk(`
      SELECT count(*) || '|' || md5(string_agg(c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity, E'\\n' ORDER BY c.relname))
             || '|' || count(*) FILTER (WHERE NOT c.relrowsecurity)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname <> 'video_idea_opportunity_snapshots';`).trim()
    expect(out).toBe(`${constant('c_rls_count')}|${constant('c_rls_digest')}|0`)

    // 092's own new table (migration section 3): RLS ENABLE + FORCE, both true.
    const opp092Rls = psqlOk(`
      SELECT c.relrowsecurity || ':' || c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'video_idea_opportunity_snapshots';`).trim()
    expect(opp092Rls).toBe('t:t')
  })

  it('the 31 pg_trgm functions match the allowlist exactly and are the only public functions callable by anon/PUBLIC', () => {
    const allow = pinned('pin_trgm')
    const live = psqlOk(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ||
        '|owner=' || pg_get_userbyid(p.proowner) || '|kind=' || p.prokind::text || '|secdef=' || p.prosecdef ||
        '|vol=' || p.provolatile::text || '|body=' || md5(replace(p.prosrc, E'\\r\\n', E'\\n'))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e' AND e.extname = 'pg_trgm');`)
      .split('\n').map((l) => l.trim()).filter(Boolean)
    expect(live).toHaveLength(31)
    expect([...live].sort()).toEqual([...allow].sort())
    const callable = psqlOk(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND (p.proacl IS NULL OR has_function_privilege('anon', p.oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'));`)
      .split('\n').map((l) => l.trim()).filter(Boolean)
    expect([...callable].sort()).toEqual(allow.map((l) => l.split('|')[0]).sort())
  })

  it('the 77+5 application functions (090 unchanged + 092 itemized) equal the recorded contract (signature, owner, security, search_path, ACL, body) with zero anon/PUBLIC EXECUTE', () => {
    const contract = [...pinned('pin_app'), ...PIN_092_APP]
    const live = psqlOk(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ||
        '|owner=' || pg_get_userbyid(p.proowner) || '|kind=' || p.prokind::text || '|secdef=' || p.prosecdef ||
        '|vol=' || p.provolatile::text || '|cfg=' || coalesce(array_to_string(p.proconfig, ';'), '') ||
        '|acl=' || coalesce((SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type, ',' ORDER BY (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END), a.privilege_type) FROM aclexplode(p.proacl) a), '<null>') ||
        '|body=' || md5(replace(p.prosrc, E'\\r\\n', E'\\n'))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e' AND e.extname = 'pg_trgm');`)
      .split('\n').map((l) => l.trim()).filter(Boolean)
    expect(live).toHaveLength(82)
    // The only function 091 changes is handle_new_user_credits(): identity/owner/security/search_path/ACL must
    // still match the 090 contract exactly; its body may be the recorded 090 body OR the 091 body.
    const swap091Body = (line: string) => (line.startsWith('handle_new_user_credits()|')
      ? line.replace(/\|body=[0-9a-f]{32}$/, '|body=<091-or-090>')
      : line)
    const liveHandle = live.find((l) => l.startsWith('handle_new_user_credits()|')) ?? ''
    const liveBody = /\|body=([0-9a-f]{32})$/.exec(liveHandle)?.[1]
    const contractBody = /\|body=([0-9a-f]{32})$/.exec(contract.find((l) => l.startsWith('handle_new_user_credits()|')) ?? '')?.[1]
    expect([liveBody]).toEqual([expect.stringMatching(new RegExp(`^(${contractBody}|${POST_091_HANDLE_NEW_USER_CREDITS_BODY_MD5})$`))])
    expect([...live].map(swap091Body).sort()).toEqual([...contract].map(swap091Body).sort())
    expect(contract.some((l) => /\|acl=[^|]*(PUBLIC:|anon:)/.test(l))).toBe(false)
  })
})

describeIfLocalDb('090 hardening -- apply and reapply', () => {
  it('applies from the simulated pre-090 state: extras 37/37/39 before, 0 after, everything else byte-identical', () => {
    // psql \gset captures the pre-state digest; the same digest is compared after the migration body.
    const digestStatement = `SELECT (${DIGEST_EXPR.trim().replace(/^SELECT /, '')}) AS d0 \\gset`
    const out = psqlOk(`
BEGIN;
${PRE_092_UNDO_SQL}
${digestStatement}
${PRE_090_STATE_SQL}
${EXTRA_COUNTS_SQL.replace(/'EXTRA\|'/, "'PRE|'")}
${MIGRATION_BODY}
${EXTRA_COUNTS_SQL.replace(/'EXTRA\|'/, "'POST|'")}
SELECT 'DIGEST_UNCHANGED|' || ((${DIGEST_EXPR.trim().replace(/^SELECT /, '')}) = :'d0');
ROLLBACK;`)
    const pre = parseExtraCounts(out, 'PRE')
    const post = parseExtraCounts(out, 'POST')
    for (const priv of EXTRA_PRIVS) {
      expect(pre[`anon:${priv}`]).toBe(37)
      expect(pre[`authenticated:${priv}`]).toBe(37)
      expect(pre[`service_role:${priv}`]).toBe(39)
      for (const role of API_ROLES) expect(post[`${role}:${priv}`], `${role}:${priv}`).toBe(0)
    }
    expect(out).toContain('DIGEST_UNCHANGED|t')
  })

  it('also revokes a PUBLIC-granted extra privilege and any other catalog-visible API-role grant on a NEW relation is not silently kept', () => {
    // PUBLIC + an extra privilege on an existing table: the catalog-driven REVOKE removes it.
    const out = psqlOk(`
BEGIN;
${PRE_092_UNDO_SQL}
GRANT TRUNCATE, REFERENCES ON TABLE public.creator_memory TO PUBLIC;
${MIGRATION_BODY}
SELECT 'PUBLIC_LEFT|' || count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid = 'public.creator_memory'::regclass AND a.grantee = 0;
ROLLBACK;`)
    expect(out).toContain('PUBLIC_LEFT|0')
  })

  // Now rolled back, not a real commit -- reuses the exact MIGRATION_BODY +
  // PRE_092_UNDO_SQL pattern already proven elsewhere in this file (e.g.
  // runBodyAfter()), rather than running the raw migration file's own
  // embedded BEGIN/COMMIT for real. This is a version-correct, narrower
  // reapply target than the old design: it reapplies MIGRATION_BODY directly
  // on top of the already-090-hardened (092-absent, via PRE_092_UNDO_SQL)
  // baseline, which is exactly the property "reapply is idempotent" is
  // about, without needing to touch the shared stack for real at all.
  it('reapply of MIGRATION_BODY on top of the 090-hardened baseline (rolled back) is a clean no-op', () => {
    const digestExpr = DIGEST_EXPR.trim().replace(/^SELECT /, '')
    const out = psqlOk(`
BEGIN;
${PRE_092_UNDO_SQL}
SELECT (${digestExpr}) AS d0 \\gset
${EXTRA_COUNTS_SQL.replace(/'EXTRA\|'/, "'PRE|'")}
${MIGRATION_BODY}
${EXTRA_COUNTS_SQL.replace(/'EXTRA\|'/, "'POST|'")}
SELECT 'DIGEST_UNCHANGED|' || ((${digestExpr}) = :'d0');
ROLLBACK;`)
    const pre = parseExtraCounts(out, 'PRE')
    const post = parseExtraCounts(out, 'POST')
    // Already-090-hardened baseline (after PRE_092_UNDO_SQL) has zero extras
    // before reapply; reapplying MIGRATION_BODY must not introduce any.
    expect(Object.values(pre).every((n) => n === 0)).toBe(true)
    expect(Object.values(post).every((n) => n === 0)).toBe(true)
    expect(out).toContain('DIGEST_UNCHANGED|t')
  })
})

describeIfLocalDb('090 hardening -- negative extra-privilege tests as each API role (rolled back)', () => {
  const REPRESENTATIVE = ['creator_memory', 'credit_ledger', 'stripe_webhook_events', 'user_credits', 'youtube_oauth_tokens', 'credit_bucket_migration_backup_037']

  for (const role of API_ROLES) {
    it(`${role}: real TRUNCATE is denied on representative billing/identity/token tables and the four privileges are 0 on every table`, () => {
      const out = psqlOk(`
BEGIN;
SET LOCAL ROLE ${role};
DO $t$
DECLARE t text; denied int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[${REPRESENTATIVE.map((x) => `'${x}'`).join(',')}] LOOP
    BEGIN
      EXECUTE format('TRUNCATE TABLE public.%I', t);
      RAISE EXCEPTION 'TRUNCATE_SUCCEEDED %', t;
    EXCEPTION WHEN insufficient_privilege THEN
      denied := denied + 1;
    END;
  END LOOP;
  RAISE NOTICE 'DENIED=%', denied;
END
$t$;
RESET ROLE;
${EXTRA_COUNTS_SQL}
ROLLBACK;`)
      expect(out).toContain(`DENIED=${REPRESENTATIVE.length}`)
      expect(out).not.toContain('TRUNCATE_SUCCEEDED')
      const counts = parseExtraCounts(out)
      for (const priv of EXTRA_PRIVS) expect(counts[`${role}:${priv}`], `${role}:${priv}`).toBe(0)
    })
  }

  it('authenticated and service_role keep their keeper reads; anon keeps nothing (SET LOCAL ROLE, rolled back)', () => {
    const out = psqlOk(`
BEGIN;
SET LOCAL ROLE authenticated;
SELECT 'AUTH_READ|' || count(*) FROM public.opportunity_cache;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $t$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = 'public' AND c.relkind IN ('r','p') AND has_table_privilege('service_role', c.oid, 'SELECT') LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.relname);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'SERVICE_READ_TABLES=%', n;
END
$t$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $t$
BEGIN
  BEGIN
    PERFORM 1 FROM public.opportunity_cache LIMIT 1;
    RAISE EXCEPTION 'ANON_READ_SUCCEEDED';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ANON_DENIED';
  END;
END
$t$;
ROLLBACK;`)
    expect(out).toMatch(/AUTH_READ\|\d+/)
    expect(out).toMatch(/SERVICE_READ_TABLES=(\d+)/)
    expect(Number(/SERVICE_READ_TABLES=(\d+)/.exec(out)![1])).toBeGreaterThanOrEqual(80)
    expect(out).toContain('ANON_DENIED')
    expect(out).not.toContain('ANON_READ_SUCCEEDED')
  })
})

describeIfLocalDb('090 hardening -- fail-fast on drift (rolled back)', () => {
  it('rejects an unknown future public function', () => {
    const r = runBodyAfter(`CREATE FUNCTION public.zz_090_unknown() RETURNS int LANGUAGE sql AS 'SELECT 1';`)
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('090 fail-closed (pre): application function contract drift')
  })

  it('rejects a widened grant on a pinned application function (anon EXECUTE)', () => {
    const r = runBodyAfter(`GRANT EXECUTE ON FUNCTION public.cleanup_expired_cache() TO anon;`)
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('application function contract drift')
  })

  it('rejects a changed search_path on a pinned application function', () => {
    const r = runBodyAfter(`ALTER FUNCTION public.update_updated_at() SET search_path = public;`)
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('application function contract drift')
  })

  it('rejects a new extension installed into schema public', () => {
    const r = runBodyAfter(`CREATE EXTENSION citext WITH SCHEMA public;`, 'supabase_admin', 'postgres')
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('090 fail-closed (pre)')
  })

  it('rejects a changed RLS enabled/forced topology', () => {
    const r = runBodyAfter(`ALTER TABLE public.signal_collection_control NO FORCE ROW LEVEL SECURITY;`)
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('RLS enabled/forced topology changed')
  })

  it('rejects a new public table (RLS topology set changes)', () => {
    const r = runBodyAfter(`CREATE TABLE public.zz_090_new_table (id int);`)
    expect(r.status).not.toBe(0)
    expect(r.output).toMatch(/RLS enabled\/forced topology changed|column-level ACL/)
  })

  it('rejects anon DML on a table and a changed authenticated keeper DML set', () => {
    const anon = runBodyAfter(`GRANT SELECT ON TABLE public.creator_memory TO anon;`)
    expect(anon.status).not.toBe(0)
    expect(anon.output).toContain('anon/PUBLIC table DML tuples expected 0')
    const auth = runBodyAfter(`REVOKE INSERT ON TABLE public.video_packages FROM authenticated;`)
    expect(auth.status).not.toBe(0)
    expect(auth.output).toContain('authenticated keeper DML set changed')
  })

  it('platform default ACL upper bound: a STRICTER platform default is accepted', () => {
    const r = psql(
      `BEGIN;
${PRE_092_UNDO_SQL}
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
SET LOCAL ROLE postgres;
${MIGRATION_BODY}
SELECT 'OK_TIGHTER';
ROLLBACK;`,
      'supabase_admin',
    )
    expect(r.status).toBe(0)
    expect(r.output).toContain('OK_TIGHTER')
  })

  const WIDER: Array<[string, string, string]> = [
    ['a new object type in the supabase_admin public default', 'supabase_admin', `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT USAGE ON TYPES TO anon;`],
    ['a new grantee in the supabase_admin public default', 'supabase_admin', `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT ON TABLES TO authenticator;`],
    ['an unknown owner with a public default', 'supabase_admin', `ALTER DEFAULT PRIVILEGES FOR ROLE authenticator IN SCHEMA public GRANT SELECT ON TABLES TO anon;`],
    ['a widened postgres-owner public default (046 owner-only bound)', 'postgres', `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO anon;`],
    ['a widened global default', 'supabase_admin', `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin GRANT EXECUTE ON FUNCTIONS TO anon;`],
  ]
  for (const [label, user, alter] of WIDER) {
    it(`platform default ACL upper bound: ${label} is rejected`, () => {
      const r = psql(`BEGIN;\n${PRE_092_UNDO_SQL}\n${alter}\nSET LOCAL ROLE postgres;\n${MIGRATION_BODY}\nSELECT 'MUST_NOT_REACH';\nROLLBACK;`, user)
      expect(r.status).not.toBe(0)
      expect(r.output).toContain('PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL')
      expect(r.output).toContain('EXCEEDS')
      expect(r.output).not.toContain('MUST_NOT_REACH')
    })
  }
})

describeIfLocalDb('090 hardening -- topology guard detects injected drift (rolled back)', () => {
  function guardWith(mutation: string, user = 'postgres'): string {
    const r = psql(`BEGIN;\n${mutation}\n${GUARD_BODY}\nROLLBACK;`, user)
    if (r.status !== 0) throw new Error(`guard scenario failed: ${r.output.slice(0, 800)}`)
    return r.output
  }

  const SCENARIOS: Array<[string, string, string, string]> = [
    ['anon SELECT on an existing table', `GRANT SELECT ON TABLE public.creator_memory TO anon;`, 'VIOLATION|table_anon_privilege|creator_memory|SELECT', 'postgres'],
    ['PUBLIC privilege on an existing table', `GRANT SELECT ON TABLE public.creator_memory TO PUBLIC;`, 'VIOLATION|table_public_privilege|creator_memory|SELECT', 'postgres'],
    ['TRUNCATE for authenticated', `GRANT TRUNCATE ON TABLE public.creator_memory TO authenticated;`, 'VIOLATION|table_extra_privilege|creator_memory|authenticated:TRUNCATE', 'postgres'],
    ['REFERENCES for service_role', `GRANT REFERENCES ON TABLE public.credit_ledger TO service_role;`, 'VIOLATION|table_extra_privilege|credit_ledger|service_role:REFERENCES', 'postgres'],
    ['a public table with RLS disabled (the 047 event trigger enables RLS on creation, so it is disabled explicitly)', `CREATE TABLE public.zz_guard_table (id int); ALTER TABLE public.zz_guard_table DISABLE ROW LEVEL SECURITY;`, 'VIOLATION|table_rls_disabled|zz_guard_table|', 'postgres'],
    ['a new sequence granted to anon', `CREATE SEQUENCE public.zz_guard_seq; GRANT USAGE ON SEQUENCE public.zz_guard_seq TO anon;`, 'VIOLATION|sequence_broad_privilege|zz_guard_seq|anon:USAGE', 'postgres'],
    ['a new function with PUBLIC EXECUTE', `CREATE FUNCTION public.zz_guard_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION public.zz_guard_fn() TO PUBLIC;`, 'VIOLATION|function_public_or_anon_execute|zz_guard_fn()', 'postgres'],
    ['a new function with anon EXECUTE', `CREATE FUNCTION public.zz_guard_fn2() RETURNS int LANGUAGE sql AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION public.zz_guard_fn2() TO anon;`, 'VIOLATION|function_public_or_anon_execute|zz_guard_fn2()', 'postgres'],
    ['an object created by supabase_admin (platform default ACL residual in action)', `CREATE TABLE public.zz_admin_table (id int);`, 'VIOLATION|table_anon_privilege|zz_admin_table|', 'supabase_admin'],
    ['a function created by supabase_admin (implicit platform EXECUTE grants)', `CREATE FUNCTION public.zz_admin_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';`, 'VIOLATION|function_public_or_anon_execute|zz_admin_fn()', 'supabase_admin'],
    ['a new extension in schema public', `CREATE EXTENSION citext WITH SCHEMA public;`, 'VIOLATION|extension_in_public|citext', 'supabase_admin'],
    ['a widened supabase_admin public default ACL', `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT USAGE ON TYPES TO anon;`, 'VIOLATION|default_acl_public_exceeds_bound|supabase_admin|T|anon|USAGE', 'supabase_admin'],
  ]
  for (const [label, mutation, expected, user] of SCENARIOS) {
    it(`fails on ${label}`, () => {
      const out = guardWith(mutation, user)
      expect(guardViolations(out).some((v) => v.startsWith(expected)), `expected ${expected} in:\n${out.slice(0, 1200)}`).toBe(true)
      expect(guardCount(out)).toBeGreaterThan(0)
    })
  }

  it('accepts a stricter platform default ACL (no violation)', () => {
    const out = guardWith(`ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon;`, 'supabase_admin')
    expect(guardCount(out)).toBe(0)
  })
})

describeIfLocalDb('090 hardening -- auth triggers, PostgREST negatives and keeper application paths', () => {
  const createdUsers: string[] = []

  afterAll(async () => {
    for (const id of createdUsers) await adminClient.auth.admin.deleteUser(id)
  })

  it('handle_new_user triggers are intact: a new auth user gets profile and user_credits rows', async () => {
    const email = `p090-${randomUUID()}@example.test`
    const { data, error } = await adminClient.auth.admin.createUser({ email, password: `Test-${randomUUID()}-!Aa1`, email_confirm: true })
    expect(error).toBeNull()
    const userId = data.user!.id
    createdUsers.push(userId)
    const out = psqlOk(`SELECT 'P|' || (SELECT count(*) FROM public.profiles WHERE user_id = '${userId}') || '|C|' || (SELECT count(*) FROM public.user_credits WHERE user_id = '${userId}');`)
    expect(out.trim()).toBe('P|1|C|1')
  })

  it('anon PostgREST cannot read or insert any public table (no 2xx)', async () => {
    const tables = psqlOk(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1;`)
      .split('\n').map((l) => l.trim()).filter(Boolean)
    expect(tables).toHaveLength(83) // 090's 82 + 092's video_idea_opportunity_snapshots
    const headers = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${LOCAL_ANON_KEY}` }
    for (const table of tables) {
      const get = await fetch(`${LOCAL_URL}/rest/v1/${table}?limit=1`, { headers })
      expect(get.status, `GET ${table}`).toBeGreaterThanOrEqual(400)
      const post = await fetch(`${LOCAL_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })
      expect(post.status, `POST ${table}`).toBeGreaterThanOrEqual(400)
    }
  })

  it('anon PostgREST cannot call any application RPC; the allowlisted pg_trgm show_limit() still works', async () => {
    const headers = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${LOCAL_ANON_KEY}`, 'Content-Type': 'application/json' }
    // 092's 2 trigger functions are not PostgREST-callable RPCs at all (they are
    // trigger-type, not normal SQL-callable functions) and are excluded here for
    // that reason, not to narrow coverage; its 3 real RPCs are itemized in.
    const opp092Rpcs = PIN_092_APP.filter((l) => !l.startsWith('enforce_opportunity_evidence_snapshot_identity(') && !l.startsWith('touch_opportunity_evidence_snapshot_updated_at('))
    const names = [...pinned('pin_app'), ...opp092Rpcs].map((l) => l.split('(')[0])
    expect(new Set(names).size).toBeGreaterThanOrEqual(70)
    for (const name of new Set(names)) {
      const res = await fetch(`${LOCAL_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: '{}' })
      expect(res.status, `rpc/${name}`).toBeGreaterThanOrEqual(400)
    }
    const capability = await fetch(`${LOCAL_URL}/rest/v1/rpc/get_semantic_topic_lifecycle_reviewer_capability`, { method: 'POST', headers, body: '{}' })
    expect([401, 403]).toContain(capability.status)
    const trgm = await fetch(`${LOCAL_URL}/rest/v1/rpc/show_limit`, { method: 'POST', headers, body: '{}' })
    expect(trgm.status).toBe(200)
  })

  it('an authenticated non-reviewer keeper RPC still works (capability = false) and service_role keeps DML on controls', async () => {
    const email = `p090-${randomUUID()}@example.test`
    const password = `Test-${randomUUID()}-!Aa1`
    const created = await adminClient.auth.admin.createUser({ email, password, email_confirm: true })
    expect(created.error).toBeNull()
    createdUsers.push(created.data.user!.id)
    const client = createClient(LOCAL_URL, LOCAL_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    const signIn = await client.auth.signInWithPassword({ email, password })
    expect(signIn.error).toBeNull()
    const capability = await client.rpc('get_semantic_topic_lifecycle_reviewer_capability')
    expect(capability.error).toBeNull()
    expect(capability.data).toBe(false)

    const controls = await adminClient.from('signal_collection_control').select('id, enabled')
    expect(controls.error).toBeNull()
    expect(controls.data).toEqual([{ id: 1, enabled: false }])
  })
})

describeIfLocalDb('090 hardening -- the shared stack is left clean', () => {
  it('after every rolled-back scenario the guard is still clean and the four privileges are still 0', () => {
    expect(guardCount(psqlOk(GUARD))).toBe(0)
    const counts = parseExtraCounts(psqlOk(EXTRA_COUNTS_SQL))
    expect(Object.values(counts).every((n) => n === 0)).toBe(true)
  })
})
