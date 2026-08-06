-- ============================================================
-- Migration 065: validate signal collector function baseline (post-064)
--
-- Validation-ONLY migration. Zero DDL, zero DML, zero CREATE OR
-- REPLACE, zero GRANT/REVOKE. Confirms that the 7 signal-collector
-- provider-budget RPCs (055-061, 063) and the 8 collector tables +
-- signal_collection_control still have their exact expected
-- structural shape, ACL and (LF-normalized) function body — and
-- FAILS CLOSED (RAISE EXCEPTION, full ROLLBACK via BEGIN/COMMIT) on
-- any drift instead of silently accepting or repairing it.
--
-- CRLF vs LF: production deployed these 7 functions through a
-- workflow that introduced CRLF line endings into prosrc (the same
-- root cause previously found and fixed for 063, see the
-- "normalize 063 function body line endings" commit). This migration
-- treats CRLF as a cosmetically acceptable, non-semantic difference
-- and compares md5(replace(prosrc, E'\r\n', E'\n')) against the
-- canonical hash. A standalone CR byte that is NOT part of a CRLF
-- pair is explicitly detected and rejected — it is not a known,
-- previously-diagnosed formatting artifact and could hide a real
-- change.
--
-- reserve_provider_units: this migration requires the 064 CORRECTED
-- end-state specifically (discovery_search limit = 3, not the legacy
-- 300). If the exact legacy (pre-064) body is found, it fails with a
-- message pointing at 064 rather than a generic drift message.
--
-- signal_collection_control: only the fixed baseline ROW STRUCTURE
-- (exactly 1 row, id = 1) is validated here. The `enabled` value is
-- intentionally NEVER read or asserted by this migration — it is
-- runtime configuration, not schema, exactly as migration 062 already
-- established for its own idempotent re-validation.
-- ============================================================

BEGIN;

DO $validate_functions$
DECLARE
  v_row RECORD;
  v_oid oid;
  v_count integer;
  v_prosrc text;
  v_total_cr integer;
  v_crlf_pairs integer;
  v_hash text;
  v_legacy_reserve_hash constant text := '36ce8f65663df3b408f1d7a9db0cf252';
BEGIN
  FOR v_row IN
    SELECT * FROM (VALUES
      ('reserve_provider_units',
       'p_provider text, p_usage_scope text, p_usage_type text, p_run_id uuid, p_phase text, p_idempotency_key text, p_units integer, p_lease_seconds integer',
       'uuid', '3ad82ac63b81d925176192ddb7430ce3'),
      ('mark_provider_attempt_started',
       'p_reservation_id uuid', 'boolean', 'e10f65bb0801665a727b73fe2ae6e4f3'),
      ('commit_provider_units',
       'p_reservation_id uuid, p_actual_units integer', 'jsonb', '3af19fd58f0b9ace1cc2fdec938f0782'),
      ('mark_provider_outcome_unknown',
       'p_reservation_id uuid', 'jsonb', '2d8efc407c3b4682004db52c5423e974'),
      ('release_provider_units',
       'p_reservation_id uuid', 'boolean', 'da4ec39e3b20211e0a8f9c77e6bd7231'),
      ('expire_stale_provider_reservations',
       'p_provider text', 'integer', '49de87d163f5c31b216e357f675bbb08'),
      ('bind_provider_reservation_to_batch',
       'p_reservation_id uuid, p_batch_id uuid, p_lease_owner text', 'boolean', '1373cae28319ed700bab226b6a4f7744')
    ) AS t(proname, identity_args, return_type, expected_hash)
  LOOP
    SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_row.proname;

    IF v_count <> 1 THEN
      RAISE EXCEPTION '065 drift: % overload_count must be exactly 1, found %', v_row.proname, v_count;
    END IF;

    SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_row.proname;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid
        AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_row.identity_args
        AND pg_get_function_result(p.oid) = v_row.return_type
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '065 drift: % structural definition (args/return/language/volatility/strict/secdef/parallel/owner/search_path) does not match exactly', v_row.proname;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE'
           AND grantee.rolname NOT IN ('postgres', 'service_role')
       )
    THEN
      RAISE EXCEPTION '065 drift: % EXECUTE ACL is not exactly postgres + service_role', v_row.proname;
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;

    -- Standalone CR (not part of a CRLF pair) is never tolerated: count
    -- every CR byte, then count CR bytes consumed by CRLF pairs; any
    -- remainder is a lone CR.
    v_total_cr := length(v_prosrc) - length(replace(v_prosrc, E'\r', ''));
    v_crlf_pairs := (length(v_prosrc) - length(replace(v_prosrc, E'\r\n', ''))) / 2;
    IF v_total_cr <> v_crlf_pairs THEN
      RAISE EXCEPTION '065 drift: % contains a standalone CR byte that is not part of a CRLF pair (total_cr=%, crlf_pairs=%) — refusing to treat this as a tolerated formatting difference', v_row.proname, v_total_cr, v_crlf_pairs;
    END IF;

    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_row.expected_hash THEN
      IF v_row.proname = 'reserve_provider_units' AND v_hash = v_legacy_reserve_hash THEN
        RAISE EXCEPTION '065 drift: reserve_provider_units still has the LEGACY (pre-064) discovery_search=300 body. Migration 064 has not been applied, or did not reach its corrected end-state. Apply 064 before 065.';
      END IF;
      RAISE EXCEPTION '065 drift: % LF-normalized body hash does not match the expected baseline (found %, expected %)', v_row.proname, v_hash, v_row.expected_hash;
    END IF;

    RAISE NOTICE '065: % matches the expected baseline (structure, ACL, LF-normalized body) — no-op.', v_row.proname;
  END LOOP;
END;
$validate_functions$;

DO $validate_tables$
DECLARE
  v_row RECORD;
  v_policy_count integer;
BEGIN
  FOR v_row IN
    SELECT * FROM (VALUES
      ('signal_seed_queue'),
      ('signal_run_phases'),
      ('signal_observation_schedule'),
      ('signal_provider_daily_budgets'),
      ('signal_provider_budget_reservations'),
      ('signal_collection_batches'),
      ('signal_run_provider_usage'),
      ('signal_collection_control')
    ) AS t(tablename)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_row.tablename AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '065 drift: % missing, or owner is not postgres', v_row.tablename;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = v_row.tablename
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '065 drift: % RLS is not exactly enabled+forced', v_row.tablename;
    END IF;

    SELECT count(*) INTO v_policy_count FROM pg_policies WHERE schemaname = 'public' AND tablename = v_row.tablename;
    IF v_policy_count <> 0 THEN
      RAISE EXCEPTION '065 drift: % has an unexpected policy (count=%)', v_row.tablename, v_policy_count;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants g
      WHERE g.table_schema = 'public' AND g.table_name = v_row.tablename AND g.grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '065 drift: % has a forbidden anon/authenticated/PUBLIC grant', v_row.tablename;
    END IF;

    RAISE NOTICE '065: % table shape (owner/RLS/policy/forbidden-grants) matches expected baseline.', v_row.tablename;
  END LOOP;

  -- service_role grant-mátrix — táblánként eltérő elvárt halmaz, ezért
  -- külön-külön, COALESCE-szel védve a NULL-t (hiányzó grant esetén az
  -- array_agg NULL-t adna, és a "<>" NULL-lal sosem TRUE — a COALESCE
  -- nélkül ez csendben átengedne egy hiányzó-grant driftet).
  IF coalesce((SELECT array_agg(DISTINCT privilege_type::text ORDER BY privilege_type::text) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='signal_seed_queue' AND grantee='service_role'), ARRAY[]::text[]) <> ARRAY['INSERT','SELECT','UPDATE'] THEN
    RAISE EXCEPTION '065 drift: signal_seed_queue service_role grants are not exactly INSERT+SELECT+UPDATE';
  END IF;
  IF coalesce((SELECT array_agg(DISTINCT privilege_type::text ORDER BY privilege_type::text) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='signal_run_phases' AND grantee='service_role'), ARRAY[]::text[]) <> ARRAY['INSERT','SELECT','UPDATE'] THEN
    RAISE EXCEPTION '065 drift: signal_run_phases service_role grants are not exactly INSERT+SELECT+UPDATE';
  END IF;
  IF coalesce((SELECT array_agg(DISTINCT privilege_type::text ORDER BY privilege_type::text) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='signal_observation_schedule' AND grantee='service_role'), ARRAY[]::text[]) <> ARRAY['INSERT','SELECT','UPDATE'] THEN
    RAISE EXCEPTION '065 drift: signal_observation_schedule service_role grants are not exactly INSERT+SELECT+UPDATE';
  END IF;
  IF coalesce((SELECT array_agg(DISTINCT privilege_type::text ORDER BY privilege_type::text) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='signal_provider_daily_budgets' AND grantee='service_role'), ARRAY[]::text[]) <> ARRAY['SELECT'] THEN
    RAISE EXCEPTION '065 drift: signal_provider_daily_budgets service_role grants are not exactly SELECT';
  END IF;
  IF coalesce((SELECT array_agg(DISTINCT privilege_type::text ORDER BY privilege_type::text) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='signal_provider_budget_reservations' AND grantee='service_role'), ARRAY[]::text[]) <> ARRAY['SELECT'] THEN
    RAISE EXCEPTION '065 drift: signal_provider_budget_reservations service_role grants are not exactly SELECT';
  END IF;
  IF coalesce((SELECT array_agg(DISTINCT privilege_type::text ORDER BY privilege_type::text) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='signal_collection_batches' AND grantee='service_role'), ARRAY[]::text[]) <> ARRAY['INSERT','SELECT','UPDATE'] THEN
    RAISE EXCEPTION '065 drift: signal_collection_batches service_role grants are not exactly INSERT+SELECT+UPDATE';
  END IF;
  IF coalesce((SELECT array_agg(DISTINCT privilege_type::text ORDER BY privilege_type::text) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='signal_run_provider_usage' AND grantee='service_role'), ARRAY[]::text[]) <> ARRAY['SELECT'] THEN
    RAISE EXCEPTION '065 drift: signal_run_provider_usage service_role grants are not exactly SELECT';
  END IF;
  IF coalesce((SELECT array_agg(DISTINCT privilege_type::text ORDER BY privilege_type::text) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='signal_collection_control' AND grantee='service_role'), ARRAY[]::text[]) <> ARRAY['SELECT','UPDATE'] THEN
    RAISE EXCEPTION '065 drift: signal_collection_control service_role grants are not exactly SELECT+UPDATE';
  END IF;

  -- signal_collection_control: kizárólag a SOR-SZERKEZET (pontosan 1
  -- sor, id=1). Az `enabled` értékét ez a migráció SOHA nem olvassa és
  -- SOHA nem érinti — futásidejű vezérlés, nem séma (ugyanaz az elv,
  -- mint a 062 saját idempotens validációjában).
  IF (SELECT count(*) FROM public.signal_collection_control) <> 1 THEN
    RAISE EXCEPTION '065 drift: signal_collection_control must contain exactly 1 row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.signal_collection_control WHERE id = 1) THEN
    RAISE EXCEPTION '065 drift: signal_collection_control row must have id = 1';
  END IF;

  RAISE NOTICE '065: signal_collection_control baseline row structure (exactly 1 row, id=1) confirmed — enabled value intentionally not read or asserted.';
END;
$validate_tables$;

COMMIT;
