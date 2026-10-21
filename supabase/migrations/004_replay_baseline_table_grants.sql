-- ============================================================
-- Migration 004: replay baseline table grants
--
-- A normal migration of the chain. Versions 004..010 were unused; 004 sorts after 003 and before 011.
-- Operations note, evidence and its limits: docs/operations/migration-004-replay-baseline-table-grants.md
--
-- Problem: tables created by 001..003 get their Data-API-role DML privileges only from the platform's legacy default privileges; 044 (157 keepers) and 090 (23 / 200
-- keepers) assert them, so a replay WITHOUT automatic DML grants is expected to fail at 044 (before 090). That expectation comes from reading the code of 044; a replay
-- that fails without 004 was not run.
--
-- Rule (fail-closed, all-or-nothing over the 14 affected tables): the COMPLETE table-level ACL of the 14 tables (every non-owner grantee, privilege and grant option)
-- must be exactly ONE of four known states, and the same state on all 14 tables:
--   EMPTY         no non-owner ACL entry at all (an all-revoked state; NOT what the real platform / CLI produces)  -> supply the baseline DML set, verify exactly
--   PLATFORM-NEW  the state that the real Supabase CLI 2.117.0 produced on PG 17 with auto_expose_new_tables=false (catalog saved 2026-10-21): anon, authenticated and
--                 service_role each hold EXACTLY the four non-DML privileges MAINTAIN, REFERENCES, TRIGGER, TRUNCATE (no DML), no other grantee, no grant option
--                 -> supply ONLY the baseline DML set below (no wide or anon DML grant), keep the four non-DML privileges as they are, verify exactly
--   LEGACY        anon/authenticated/service_role each hold ALL privileges (legacy auto-expose default; MAINTAIN only on PG >= 17), nothing else -> no change
--   FINAL         the already-migrated production/staging ACL (catalog-verified identical on both on 2026-10-20)                 -> no change
-- Anything else (a partial / mixed / unexpected state, a missing or extra privilege, anon DML, PUBLIC or any other grantee, a grant option) raises and stops:
-- no right is silently skipped. PLATFORM-NEW is recognised ONLY on PG >= 17 and only in that exact shape.
--
-- PLATFORM-NEW is NOT a safe resting state: the retained TRUNCATE and REFERENCES (and TRIGGER / MAINTAIN) privileges of anon / authenticated / service_role are NOT
-- protected by RLS (RLS does not restrict TRUNCATE or REFERENCES). The state is acceptable ONLY as the intermediate state of an isolated replay; migration 090 revokes
-- exactly these four privileges later in the chain, and the FINAL ACL (the 090 contract: 23 / 200 DML keepers, 81 column ACLs, 82 RLS tables, no anon/PUBLIC access)
-- must equal production exactly.
--
-- Re-run behaviour: this block is NOT idempotent on its own output. After it has supplied the baseline (EMPTY or PLATFORM-NEW) the ACL matches none of the four states
-- until 090 has run, so a second run before 044 raises (safe: nothing is widened); after the whole chain it sees FINAL and changes nothing.
--
-- Not touched: anon / PUBLIC DML, grant options, ALTER DEFAULT PRIVILEGES, functions, sequences, column ACLs, the 095 tables.
-- Evidence: only isolated, throw-away replays (see the operations note). The SQL has no runtime verification beyond those runs; the source test that pins its text is
-- NOT runtime evidence.
-- ============================================================
BEGIN;

DO $baseline_004$
DECLARE
  c_tables CONSTANT text[] := ARRAY[
    'ai_usage_logs','creator_memory','opportunity_cache','profiles','source_video_analysis','topic_feedback','trend_candidate_cache',
    'usage_logs','user_credits','video_audits','video_packages','viral_score_cache','youtube_search_cache','youtube_search_logs'];
  -- the baseline DML set: ONE source for the grants AND for the exact post-condition ([table, role, privileges]; 25 pairs, 64 privileges)
  c_base CONSTANT jsonb := $base$[
    ["ai_usage_logs","authenticated","SELECT,INSERT"],
    ["ai_usage_logs","service_role","SELECT,INSERT"],
    ["creator_memory","authenticated","SELECT,INSERT,UPDATE,DELETE"],
    ["creator_memory","service_role","SELECT,INSERT,UPDATE,DELETE"],
    ["opportunity_cache","authenticated","SELECT"],
    ["opportunity_cache","service_role","SELECT,INSERT,UPDATE"],
    ["profiles","authenticated","SELECT,UPDATE"],
    ["profiles","service_role","SELECT,UPDATE"],
    ["source_video_analysis","authenticated","SELECT,INSERT"],
    ["source_video_analysis","service_role","SELECT,INSERT"],
    ["topic_feedback","authenticated","SELECT,INSERT"],
    ["topic_feedback","service_role","SELECT,INSERT"],
    ["trend_candidate_cache","service_role","SELECT,INSERT,UPDATE,DELETE"],
    ["usage_logs","authenticated","SELECT,INSERT"],
    ["usage_logs","service_role","SELECT,INSERT"],
    ["user_credits","authenticated","SELECT,UPDATE"],
    ["video_audits","service_role","SELECT,INSERT,UPDATE,DELETE"],
    ["video_packages","authenticated","SELECT,INSERT,DELETE"],
    ["video_packages","service_role","SELECT,INSERT,DELETE"],
    ["viral_score_cache","authenticated","SELECT"],
    ["viral_score_cache","service_role","SELECT,INSERT,UPDATE"],
    ["youtube_search_cache","authenticated","SELECT"],
    ["youtube_search_cache","service_role","SELECT,INSERT,UPDATE"],
    ["youtube_search_logs","authenticated","SELECT,INSERT,UPDATE,DELETE"],
    ["youtube_search_logs","service_role","SELECT,INSERT,UPDATE,DELETE"]
  ]$base$::jsonb;
  -- the already-migrated production / staging table-level ACL of the same tables (catalog-verified identical on 2026-10-20)
  c_final CONSTANT jsonb := $final$[
    ["ai_usage_logs","authenticated","INSERT,SELECT"],
    ["ai_usage_logs","service_role","INSERT,SELECT"],
    ["creator_memory","authenticated","SELECT"],
    ["creator_memory","service_role","DELETE,SELECT"],
    ["opportunity_cache","authenticated","SELECT"],
    ["opportunity_cache","service_role","INSERT,SELECT,UPDATE"],
    ["profiles","authenticated","SELECT,UPDATE"],
    ["profiles","service_role","SELECT,UPDATE"],
    ["source_video_analysis","authenticated","INSERT,SELECT"],
    ["source_video_analysis","service_role","INSERT,SELECT"],
    ["topic_feedback","authenticated","INSERT,SELECT"],
    ["topic_feedback","service_role","INSERT,SELECT"],
    ["trend_candidate_cache","service_role","DELETE,INSERT,SELECT,UPDATE"],
    ["usage_logs","authenticated","INSERT,SELECT"],
    ["usage_logs","service_role","INSERT,SELECT"],
    ["user_credits","authenticated","SELECT,UPDATE"],
    ["user_credits","service_role","INSERT,SELECT,UPDATE"],
    ["video_audits","service_role","DELETE,INSERT,SELECT,UPDATE"],
    ["video_packages","authenticated","DELETE,INSERT,SELECT"],
    ["video_packages","service_role","DELETE,INSERT,SELECT,UPDATE"],
    ["viral_score_cache","authenticated","SELECT"],
    ["viral_score_cache","service_role","INSERT,SELECT,UPDATE"],
    ["youtube_search_cache","authenticated","SELECT"],
    ["youtube_search_cache","service_role","INSERT,SELECT,UPDATE"],
    ["youtube_search_logs","authenticated","DELETE,INSERT,SELECT,UPDATE"],
    ["youtube_search_logs","service_role","DELETE,INSERT,SELECT,UPDATE"]
  ]$final$::jsonb;
  v_pg17 boolean := current_setting('server_version_num')::int >= 170000;
  v_legacy_privs text[] := ARRAY['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']
                           || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
  v_platform_privs CONSTANT text[] := ARRAY['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE'];
  v_found int;
  v_states text;
  v_distinct int;
  v_offenders text;
  v_state text;
  r record;
BEGIN
  SELECT count(*) INTO v_found FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND c.relname = ANY(c_tables);
  IF v_found <> cardinality(c_tables) THEN
    RAISE EXCEPTION '004 baseline fail-closed: expected % baseline tables in public, found %', cardinality(c_tables), v_found;
  END IF;

  -- per-table state: the whole non-owner ACL string of the table against the four known states
  WITH actual AS (
    SELECT c.relname::text AS t,
           coalesce(string_agg(g.nm || '|' || g.priv || '|' || g.gr, ',' ORDER BY g.nm COLLATE "C", g.priv COLLATE "C"), '') AS s
    FROM pg_class c
    LEFT JOIN LATERAL (
      SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END AS nm, x.privilege_type AS priv, x.is_grantable::text AS gr
      FROM aclexplode(c.relacl) x WHERE x.grantee <> c.relowner) g ON true
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND c.relname = ANY(c_tables)
    GROUP BY c.relname),
  legacy AS (
    SELECT t, string_agg(ro.r || '|' || p || '|false', ',' ORDER BY ro.r COLLATE "C", p COLLATE "C") AS s
    FROM unnest(c_tables) t CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) ro(r) CROSS JOIN unnest(v_legacy_privs) p
    GROUP BY t),
  platform_new AS (
    SELECT t, CASE WHEN v_pg17 THEN string_agg(ro.r || '|' || p || '|false', ',' ORDER BY ro.r COLLATE "C", p COLLATE "C") END AS s
    FROM unnest(c_tables) t CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) ro(r) CROSS JOIN unnest(v_platform_privs) p
    GROUP BY t),
  final_acl AS (
    SELECT e ->> 0 AS t, string_agg((e ->> 1) || '|' || p || '|false', ',' ORDER BY (e ->> 1) COLLATE "C", p COLLATE "C") AS s
    FROM jsonb_array_elements(c_final) e CROSS JOIN LATERAL unnest(string_to_array(e ->> 2, ',')) p
    GROUP BY e ->> 0),
  st AS (
    SELECT a.t,
           CASE WHEN a.s = '' THEN 'EMPTY'
                WHEN a.s = l.s THEN 'LEGACY'
                WHEN a.s = fa.s THEN 'FINAL'
                WHEN a.s = pn.s THEN 'PLATFORM-NEW'
                ELSE 'OTHER' END AS state,
           a.s AS actual_acl
    FROM actual a JOIN legacy l USING (t) JOIN final_acl fa USING (t) JOIN platform_new pn USING (t))
  SELECT string_agg(t || '=' || state, ', ' ORDER BY t COLLATE "C"), count(DISTINCT state), min(state),
         string_agg(t || ' [' || actual_acl || ']', E'\n' ORDER BY t COLLATE "C") FILTER (WHERE state = 'OTHER')
    INTO v_states, v_distinct, v_state, v_offenders
    FROM st;
  IF v_distinct <> 1 OR v_state = 'OTHER' THEN
    RAISE EXCEPTION '004 baseline fail-closed: the ACL of the baseline tables is partial, mixed or unexpected (stop, no right was changed). States: %. Unexpected ACLs: %', v_states, coalesce(v_offenders, '(none; mixed known states)');
  END IF;

  IF v_state IN ('LEGACY', 'FINAL') THEN
    RAISE NOTICE '004 baseline: all % tables are in the expected % state: nothing to supply', cardinality(c_tables), v_state;
    RETURN;
  END IF;

  -- EMPTY or PLATFORM-NEW: supply exactly the baseline DML set (the 044-time keepers on these tables plus profiles), nothing else
  FOR r IN SELECT e ->> 0 AS tbl, e ->> 1 AS grantee, e ->> 2 AS privs FROM jsonb_array_elements(c_base) e
  LOOP
    EXECUTE format('GRANT %s ON TABLE public.%I TO %I', r.privs, r.tbl, r.grantee);
  END LOOP;

  -- exact post-condition per table: the baseline DML tuples, plus (PLATFORM-NEW only) the four retained non-DML privileges of the three roles -- no more, no less,
  -- no anon DML, no PUBLIC / other grantee, no grant option; 044 / 090 stay the exact-set checks of the later state
  WITH actual AS (
    SELECT c.relname::text AS t,
           coalesce(string_agg(g.nm || '|' || g.priv || '|' || g.gr, ',' ORDER BY g.nm COLLATE "C", g.priv COLLATE "C"), '') AS s
    FROM pg_class c
    LEFT JOIN LATERAL (
      SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END AS nm, x.privilege_type AS priv, x.is_grantable::text AS gr
      FROM aclexplode(c.relacl) x WHERE x.grantee <> c.relowner) g ON true
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND c.relname = ANY(c_tables)
    GROUP BY c.relname),
  expected AS (
    SELECT u.t, string_agg(u.r || '|' || u.p || '|false', ',' ORDER BY u.r COLLATE "C", u.p COLLATE "C") AS s
    FROM (
      SELECT e ->> 0 AS t, e ->> 1 AS r, p
      FROM jsonb_array_elements(c_base) e CROSS JOIN LATERAL unnest(string_to_array(e ->> 2, ',')) p
      UNION
      SELECT t, ro.r, p
      FROM unnest(c_tables) t CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) ro(r) CROSS JOIN unnest(v_platform_privs) p
      WHERE v_state = 'PLATFORM-NEW') u
    GROUP BY u.t)
  SELECT string_agg(a.t, ', ' ORDER BY a.t COLLATE "C") INTO v_offenders
    FROM actual a LEFT JOIN expected x USING (t)
    WHERE a.s IS DISTINCT FROM x.s;
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION '004 baseline fail-closed: post-grant ACL of % is not exactly the expected set for the % state', v_offenders, v_state;
  END IF;
  RAISE NOTICE '004 baseline: % state, baseline DML supplied (25 role/table pairs, 64 privileges), post-condition exact', v_state;
END
$baseline_004$;

COMMIT;
