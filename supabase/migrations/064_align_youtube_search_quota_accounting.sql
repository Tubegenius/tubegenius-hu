-- ============================================================
-- Migration 064: align YouTube search quota accounting
--
-- Google changed the YouTube Data API quota model documented on
-- 2026-06-01: search.list is metered in a dedicated Search Queries
-- bucket, where one external request consumes one call/unit and the
-- default daily project limit is 100 calls. The collector pilot still
-- intentionally permits at most 3 discovery calls per Pacific day.
--
-- Official references (review context only; never fetched at runtime):
-- https://developers.google.com/youtube/v3/determine_quota_cost
-- https://developers.google.com/youtube/v3/docs/search/list
--
-- Fail-closed contract:
--   A) exact legacy function + zero legacy discovery ledger rows
--      -> replace only the fixed discovery limit 300 with 3;
--   B) exact corrected function -> validation-only no-op;
--   C) anything else -> exception, no partial change.
--
-- The function signature, ACL, owner, volatility, SECURITY DEFINER and
-- pinned search_path remain unchanged. No table/grant/policy changes.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_name_count integer;
  v_oid oid;
  v_body_md5 text;
  v_definition text;
  v_old_fragment constant text := 'WHEN ''discovery_search'' THEN 300';
  v_new_fragment constant text := 'WHEN ''discovery_search'' THEN 3';
  v_legacy_md5 constant text := '36ce8f65663df3b408f1d7a9db0cf252';
  v_corrected_md5 constant text := '3ad82ac63b81d925176192ddb7430ce3';
BEGIN
  SELECT count(*), to_regprocedure(
    'public.reserve_provider_units(text, text, text, uuid, text, text, integer, integer)'
  )
  INTO v_name_count, v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reserve_provider_units';

  IF v_name_count <> 1 OR v_oid IS NULL THEN
    RAISE EXCEPTION '064 drift: reserve_provider_units must exist with exactly one expected overload (name_count=%, oid=%)',
      v_name_count, v_oid;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_oid
      AND n.nspname = 'public'
      AND pg_get_function_identity_arguments(p.oid) =
        'p_provider text, p_usage_scope text, p_usage_type text, p_run_id uuid, p_phase text, p_idempotency_key text, p_units integer, p_lease_seconds integer'
      AND pg_get_function_result(p.oid) = 'uuid'
      AND l.lanname = 'plpgsql'
      AND p.provolatile = 'v'
      AND p.prosecdef IS TRUE
      AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
  ) THEN
    RAISE EXCEPTION '064 drift: reserve_provider_units structural definition does not match exactly';
  END IF;

  IF NOT has_function_privilege(
    'postgres', v_oid, 'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role', v_oid, 'EXECUTE'
  ) OR has_function_privilege(
    'anon', v_oid, 'EXECUTE'
  ) OR has_function_privilege(
    'authenticated', v_oid, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(
      (SELECT proacl FROM pg_proc WHERE oid = v_oid),
      acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
    )) acl
    JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE acl.privilege_type = 'EXECUTE'
      AND grantee.rolname NOT IN ('postgres', 'service_role')
  ) THEN
    RAISE EXCEPTION '064 drift: reserve_provider_units EXECUTE ACL is not exactly postgres + service_role';
  END IF;

  SELECT md5(replace(p.prosrc, E'\r\n', E'\n'))
  INTO v_body_md5
  FROM pg_proc p
  WHERE p.oid = v_oid;

  IF v_body_md5 = v_corrected_md5 THEN
    RAISE NOTICE '064: YouTube search quota accounting already uses 1 call/unit with a daily pilot limit of 3 — no-op.';
  ELSIF v_body_md5 = v_legacy_md5 THEN
    -- A mixed-unit historical ledger cannot be converted safely without a
    -- separate data-reconciliation decision. Production is expected to be
    -- empty while the collector kill switch is disabled, so fail closed if
    -- any legacy discovery accounting already exists.
    IF EXISTS (
      SELECT 1 FROM public.signal_provider_daily_budgets
      WHERE provider = 'youtube' AND usage_scope = 'background' AND usage_type = 'discovery_search'
    ) OR EXISTS (
      SELECT 1 FROM public.signal_run_provider_usage
      WHERE provider = 'youtube' AND usage_type = 'discovery_search'
    ) OR EXISTS (
      SELECT 1
      FROM public.signal_provider_budget_reservations r
      JOIN public.signal_provider_daily_budgets b ON b.id = r.daily_budget_id
      WHERE b.provider = 'youtube' AND b.usage_scope = 'background' AND b.usage_type = 'discovery_search'
    ) THEN
      RAISE EXCEPTION '064 precondition failed: legacy discovery quota ledger rows exist; refusing an implicit unit conversion';
    END IF;

    SELECT pg_get_functiondef(v_oid) INTO v_definition;
    IF v_definition IS NULL
       OR length(v_definition) - length(replace(v_definition, v_old_fragment, '')) <> length(v_old_fragment) THEN
      RAISE EXCEPTION '064 drift: expected exactly one legacy discovery limit fragment';
    END IF;

    EXECUTE replace(v_definition, v_old_fragment, v_new_fragment);
    RAISE NOTICE '064: corrected YouTube search quota accounting to 1 call/unit with a daily pilot limit of 3.';
  ELSE
    RAISE EXCEPTION '064 drift: reserve_provider_units body hash is neither the exact legacy nor corrected definition (md5=%)',
      v_body_md5;
  END IF;

  v_oid := to_regprocedure(
    'public.reserve_provider_units(text, text, text, uuid, text, text, integer, integer)'
  );
  IF v_oid IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_oid
      AND n.nspname = 'public'
      AND pg_get_function_identity_arguments(p.oid) =
        'p_provider text, p_usage_scope text, p_usage_type text, p_run_id uuid, p_phase text, p_idempotency_key text, p_units integer, p_lease_seconds integer'
      AND pg_get_function_result(p.oid) = 'uuid'
      AND l.lanname = 'plpgsql'
      AND p.provolatile = 'v'
      AND p.prosecdef IS TRUE
      AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
      AND md5(replace(p.prosrc, E'\r\n', E'\n')) = v_corrected_md5
  ) THEN
    RAISE EXCEPTION '064 validation failed: corrected reserve_provider_units definition does not match exactly';
  END IF;

  IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '064 validation failed: reserve_provider_units effective EXECUTE matrix changed';
  END IF;
END;
$migrate$;

COMMIT;
