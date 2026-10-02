-- ============================================================
-- Migration 093: Video Package atomic charge+save RPC (additive, Video Package only)
-- ============================================================
-- 2026-10-01 incident follow-up: app/api/video-package/route.ts's
-- chargeFeature() -> savePaidResult() -> refundCreditsAfterPersistenceFailure()
-- sequence is THREE separate network round-trips, not one atomic unit -- if
-- the credit debit (spend_credits RPC) commits but the subsequent
-- paid_results write fails, the user can end up charged with no saved
-- result, and the automatic refund attempt can ITSELF fail with no durable
-- record beyond a console.error line.
--
-- This migration is PURELY ADDITIVE: it adds one new table
-- (paid_operations, an audit trail for successfully-committed atomic
-- operations only) and one new RPC
-- (spend_credits_and_save_paid_result). It does NOT modify spend_credits,
-- refund_credit_spend, user_credits, credit_ledger, ai_usage_logs, or
-- paid_results in any way -- every existing caller of the old
-- chargeFeature()/savePaidResult() pair (16 other paid routes) is
-- completely unaffected. Only app/api/video-package/route.ts is wired to
-- the new RPC, in this same change set.
--
-- SCOPE CONTRACT, READ BEFORE REUSING THIS PATTERN ELSEWHERE: this design
-- relies on a fact VERIFIED SPECIFICALLY for Video Package, not assumed
-- generally -- app/api/video-package/route.ts's existing pre-flight cache
-- check (by input_hash, status='completed') NEVER re-charges for an
-- identical input once a completed paid_results row exists for it; there is
-- no "regenerate" flag, no TTL-triggered re-charge. This is what makes it
-- SAFE to derive a stable per-(user,tool_type,input_hash) operation
-- identity deterministically (see v_namespace below) rather than requiring
-- a client-supplied idempotency key. Before applying the same RPC pattern
-- to any OTHER paid route, independently verify that route's OWN
-- cache-reopen semantics hold the same guarantee -- do not assume it.
--
-- Explicitly transactional, matching the 083-092 convention: the whole
-- migration body is one BEGIN/COMMIT block (see tail), so a failure at any
-- point (including the closing self-check) leaves NEITHER the table NOR the
-- function behind, rather than a partially-applied schema.
-- ============================================================

BEGIN;

-- ── paid_operations ─────────────────────────────────────────
-- Audit trail ONLY for operations that the new RPC actually committed.
-- A rolled-back/failed attempt leaves NO row here by construction (that is
-- the whole point of wrapping everything in one transaction) -- do NOT use
-- the absence of an expected row here as a failure signal; failures are
-- logged by the calling application code, OUTSIDE this table, after the
-- transaction has already rolled back (see lib/paid-results/atomic-charge-save.ts).

CREATE TABLE IF NOT EXISTS public.paid_operations (
  operation_id           UUID PRIMARY KEY,
  user_id                UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature                TEXT NOT NULL,
  tool_type              TEXT NOT NULL,
  input_hash             TEXT NOT NULL,
  credit_transaction_id  UUID NOT NULL REFERENCES public.credit_ledger(id),
  paid_result_id         UUID NOT NULL REFERENCES public.paid_results(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paid_operations_user_created
  ON public.paid_operations(user_id, created_at DESC);

ALTER TABLE public.paid_operations ENABLE ROW LEVEL SECURITY;
-- FORCE, matching the established convention for every table added since
-- migration 055 (signal_seed_queue onward) and 092's own new table -- RLS
-- applies even to the table owner (the owner is how the SECURITY DEFINER
-- RPC below writes to it; FORCE does not block that INSERT, it only means
-- no implicit owner bypass for any OTHER path that might ever touch this
-- table directly as the owner role).
ALTER TABLE public.paid_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY "paid_operations_select_own" ON public.paid_operations
  FOR SELECT USING (auth.uid() = user_id);

-- Explicit, narrowest grants -- per migration 090's own documented finding,
-- a BRAND NEW public-schema table silently inherits the platform
-- (supabase_admin-owned, not modifiable by this project's migrations) default
-- ACL, which is wide (SELECT/INSERT/UPDATE/DELETE and more, for anon,
-- authenticated AND service_role) -- exactly what 090 had to claw back for
-- every PRE-EXISTING table. Rather than wait for a future hardening pass,
-- this table narrows itself at creation time: nothing for anon, SELECT-only
-- for authenticated (required for the RLS-filtered select-own policy above
-- to apply at all -- RLS narrows WHICH rows, the GRANT is the gate for
-- whether the operation is allowed at all) and SELECT-only for service_role
-- (writes happen exclusively through the SECURITY DEFINER RPC below, which
-- runs as the function owner, not as service_role -- service_role itself
-- never needs direct INSERT/UPDATE/DELETE on this table).
REVOKE ALL ON public.paid_operations FROM PUBLIC;
REVOKE ALL ON public.paid_operations FROM anon;
REVOKE ALL ON public.paid_operations FROM authenticated;
REVOKE ALL ON public.paid_operations FROM service_role;
GRANT SELECT ON public.paid_operations TO authenticated;
GRANT SELECT ON public.paid_operations TO service_role;

-- ── spend_credits_and_save_paid_result ──────────────────────
-- ALL-OR-NOTHING: calls the EXISTING, unmodified spend_credits() RPC as a
-- plain nested function call -- NOT copied/duplicated -- so it executes
-- inside THIS function's own transaction. If anything later in this
-- function raises (including a plain, no-ON-CONFLICT paid_results INSERT
-- hitting the pre-existing idx_paid_results_user_tool_hash unique index on
-- a genuine concurrent-write collision), Postgres automatically rolls back
-- EVERYTHING this function did, the spend_credits debit included. There is
-- no manual BEGIN/COMMIT/ROLLBACK or EXCEPTION-swallowing here on purpose:
-- an unhandled exception IS the "abort the whole operation" mechanism.
--
-- NOTE on the caller's network-failure handling: this function's atomicity
-- guarantees that, SERVER-SIDE, either everything committed or nothing did.
-- It CANNOT by itself tell the calling application which of those two
-- happened if the RESPONSE to a successful commit is lost in transit (a
-- network/timeout failure after this function has already returned to
-- PostgREST) -- that distinction is made application-side, by inspecting
-- whether the failure carries a genuine Postgres error code (confirmed
-- rollback) or not (uncertain -- see lib/paid-results/atomic-charge-save.ts).
--
-- Exact sequence:
--   0. Feature/cost self-consistency guard (video_package only; the actual
--      amount passed to spend_credits must equal both the amount recorded
--      in paid_results.credit_cost AND this RPC's own hardcoded expected
--      price for that feature -- keep in sync with lib/credits.ts's
--      CREDIT_COSTS.video_package_long/video_package_shorts).
--   1. Deterministic operation_id derivation + pg_advisory_xact_lock --
--      serializes concurrent calls for the SAME (user,tool_type,input_hash)
--      without needing a pre-inserted "reservation" row (which would need
--      nullable FK columns -- avoided entirely by this approach).
--   2. Existing-result check BEFORE any debit, scoped to this exact
--      (user_id, tool_type, input_hash):
--        - status = 'completed'      -> return it, NO charge (this is the
--                                       "levonás előtt" requirement)
--        - exists, status <> 'completed' -> RAISE EXCEPTION, NO charge,
--                                       NO overwrite (old/foreign row --
--                                       never silently adopted)
--        - no row at all             -> proceed
--   3. spend_credits(...) -- the existing, unmodified RPC, nested call
--   4. ai_usage_logs charge-audit INSERT (same shape chargeFeature() writes
--      today, folded into this one transaction instead of a separate call)
--   5. paid_results INSERT -- plain INSERT, NO "ON CONFLICT" clause on
--      purpose: a genuine concurrent-write collision here must surface as
--      an uncaught unique_violation that aborts the WHOLE transaction
--      (including step 3's debit), never as a quiet no-op after charging.
--   6. paid_operations INSERT -- audit only, all FKs already known/NOT NULL
--      by this point, so no nullable-column workaround is needed.
CREATE OR REPLACE FUNCTION public.spend_credits_and_save_paid_result(
  p_user_id UUID,
  p_feature TEXT,
  p_cost NUMERIC,
  p_charge_metadata JSONB,
  p_tool_type TEXT,
  p_input_hash TEXT,
  p_normalized_input TEXT,
  p_original_input TEXT,
  p_region TEXT,
  p_language TEXT,
  p_platform TEXT,
  p_result_json JSONB,
  p_summary_json JSONB,
  p_credit_cost NUMERIC,
  p_fresh_until TIMESTAMPTZ,
  p_provider TEXT,
  p_model TEXT,
  p_prompt_template_id TEXT,
  p_prompt_version TEXT,
  p_estimated_cost NUMERIC,
  p_source_run_id TEXT DEFAULT NULL,
  p_linked_video_idea_id UUID DEFAULT NULL,
  p_main_category TEXT DEFAULT NULL,
  p_specific_focus TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  -- Fixed, arbitrary namespace UUID for THIS project's Video Package
  -- operation-id derivation (RFC 4122 ss4.3 -- any stable 128-bit value is a
  -- valid namespace, it does not need to itself be a "real" UUID from
  -- anywhere). MUST NEVER CHANGE once in use: changing it would just make
  -- existing paid_operations rows unreachable by future idempotency
  -- look-ups (an availability/traceability concern, NOT a correctness or
  -- data-loss risk, since the primary gate in step 2 keys on
  -- user_id+tool_type+input_hash directly, not on this derived id).
  v_namespace CONSTANT UUID := '7d9e9b1a-f3c4-4b8e-9a2d-6c1f0e5d8a3b';
  v_operation_id UUID;
  v_lock_key BIGINT;
  existing_result public.paid_results%ROWTYPE;
  v_ledger JSONB;
  v_ledger_id UUID;
  v_balance NUMERIC;
  paid_result_row public.paid_results%ROWTYPE;
BEGIN
  -- Step 0: feature/cost/tool_type self-consistency guard.
  IF p_cost <= 0 THEN RAISE EXCEPTION 'cost must be positive'; END IF;
  IF p_tool_type IS DISTINCT FROM 'video_package' THEN
    RAISE EXCEPTION 'spend_credits_and_save_paid_result is scoped to video_package only, got %', p_tool_type;
  END IF;
  IF p_feature NOT IN ('video_package_long', 'video_package_shorts') THEN
    RAISE EXCEPTION 'unsupported feature for spend_credits_and_save_paid_result: %', p_feature USING ERRCODE = 'P0004';
  END IF;
  IF p_cost IS DISTINCT FROM p_credit_cost THEN
    RAISE EXCEPTION 'cost/credit_cost mismatch: the amount actually charged (%) must equal the amount recorded in paid_results.credit_cost (%)', p_cost, p_credit_cost
      USING ERRCODE = 'P0004';
  END IF;
  IF (p_feature = 'video_package_long' AND p_cost IS DISTINCT FROM 6)
     OR (p_feature = 'video_package_shorts' AND p_cost IS DISTINCT FROM 2) THEN
    RAISE EXCEPTION 'cost % does not match the expected credit price for feature % (must mirror lib/credits.ts CREDIT_COSTS)', p_cost, p_feature
      USING ERRCODE = 'P0004';
  END IF;

  v_operation_id := uuid_generate_v5(v_namespace, p_user_id::text || ':' || p_tool_type || ':' || p_input_hash);
  v_lock_key := hashtext(v_operation_id::text);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Step 2: existing-result check, BEFORE any debit.
  SELECT * INTO existing_result FROM public.paid_results
    WHERE user_id = p_user_id AND tool_type = p_tool_type AND input_hash = p_input_hash;

  IF FOUND THEN
    IF existing_result.status = 'completed' THEN
      SELECT balance INTO v_balance FROM public.user_credits WHERE user_id = p_user_id;
      RETURN jsonb_build_object(
        'duplicate', true,
        'paid_result', to_jsonb(existing_result),
        'total_balance', v_balance,
        'operation_id', v_operation_id
      );
    ELSE
      RAISE EXCEPTION 'paid_results row already exists for user % tool % input_hash % with non-completed status %',
        p_user_id, p_tool_type, p_input_hash, existing_result.status
        USING ERRCODE = 'P0003';
    END IF;
  END IF;

  -- Step 3: existing, unmodified spend_credits() RPC, nested call --
  -- executes inside THIS transaction, not a separate one.
  v_ledger := public.spend_credits(p_user_id, p_cost, p_feature, 'op:' || v_operation_id::text, p_charge_metadata);
  v_ledger_id := (v_ledger->>'transaction_id')::uuid;

  -- Step 4: charge-audit row (same shape as chargeFeature()'s existing,
  -- separate ai_usage_logs insert, folded in here instead).
  INSERT INTO public.ai_usage_logs(user_id, feature_name, model, input_tokens, output_tokens, estimated_cost_usd, credits_charged, metadata)
  VALUES (
    p_user_id, p_feature, 'combined', 0, 0, 0, p_cost,
    COALESCE(p_charge_metadata, '{}'::jsonb) || jsonb_build_object('type', 'charge', 'credit_transaction_id', v_ledger_id, 'operation_id', v_operation_id)
  );

  -- Step 5: plain INSERT, no ON CONFLICT -- a genuine concurrent-write
  -- collision here raises unique_violation and aborts the whole
  -- transaction, debit included.
  INSERT INTO public.paid_results(
    user_id, tool_type, input_hash, normalized_input, original_input,
    main_category, specific_focus, region, language, platform,
    result_json, summary_json, credit_cost, status,
    fresh_until, source_run_id, linked_video_idea_id,
    provider, model, prompt_template_id, prompt_version, estimated_cost
  ) VALUES (
    p_user_id, p_tool_type, p_input_hash, p_normalized_input, p_original_input,
    p_main_category, p_specific_focus, p_region, p_language, p_platform,
    p_result_json, p_summary_json, p_credit_cost, 'completed',
    p_fresh_until, p_source_run_id, p_linked_video_idea_id,
    p_provider, p_model, p_prompt_template_id, p_prompt_version, p_estimated_cost
  ) RETURNING * INTO paid_result_row;

  -- Step 6: audit row -- all FKs known and NOT NULL at this point.
  INSERT INTO public.paid_operations(operation_id, user_id, feature, tool_type, input_hash, credit_transaction_id, paid_result_id)
  VALUES (v_operation_id, p_user_id, p_feature, p_tool_type, p_input_hash, v_ledger_id, paid_result_row.id);

  RETURN jsonb_build_object(
    'duplicate', false,
    'paid_result', to_jsonb(paid_result_row),
    'total_balance', (v_ledger->>'total_balance')::numeric,
    'credit_transaction_id', v_ledger_id,
    'operation_id', v_operation_id
  );
END;
$$;

-- Same hardening pattern as 040_restrict_credit_rpc_execution.sql for the
-- other credit-mutating RPCs: service_role only, nothing else.
REVOKE EXECUTE ON FUNCTION public.spend_credits_and_save_paid_result(
  UUID, TEXT, NUMERIC, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, TIMESTAMPTZ,
  TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.spend_credits_and_save_paid_result(
  UUID, TEXT, NUMERIC, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, TIMESTAMPTZ,
  TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT
) FROM anon;
REVOKE EXECUTE ON FUNCTION public.spend_credits_and_save_paid_result(
  UUID, TEXT, NUMERIC, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, TIMESTAMPTZ,
  TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.spend_credits_and_save_paid_result(
  UUID, TEXT, NUMERIC, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, TIMESTAMPTZ,
  TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT
) TO service_role;

-- ── Closing self-check (same spirit as 090/092's own validate blocks) ──
DO $$
DECLARE leak_count INT;
BEGIN
  -- Function EXECUTE: service_role only.
  SELECT count(*) INTO leak_count
  FROM information_schema.role_routine_grants
  WHERE routine_schema = 'public' AND routine_name = 'spend_credits_and_save_paid_result'
    AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF leak_count > 0 THEN
    RAISE EXCEPTION '093 validate failed: spend_credits_and_save_paid_result has % unexpected non-service_role grant(s)', leak_count;
  END IF;
  IF NOT has_function_privilege('service_role', 'public.spend_credits_and_save_paid_result(uuid,text,numeric,jsonb,text,text,text,text,text,text,text,jsonb,jsonb,numeric,timestamptz,text,text,text,text,numeric,text,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '093 validate failed: service_role missing EXECUTE on spend_credits_and_save_paid_result';
  END IF;

  -- paid_operations table grants: anon none, authenticated/service_role SELECT-only.
  IF has_table_privilege('anon', 'public.paid_operations', 'SELECT')
     OR has_table_privilege('anon', 'public.paid_operations', 'INSERT')
     OR has_table_privilege('anon', 'public.paid_operations', 'UPDATE')
     OR has_table_privilege('anon', 'public.paid_operations', 'DELETE') THEN
    RAISE EXCEPTION '093 validate failed: anon has an unexpected privilege on paid_operations';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.paid_operations', 'SELECT') THEN
    RAISE EXCEPTION '093 validate failed: authenticated is missing SELECT on paid_operations (required for the select-own RLS policy to ever apply)';
  END IF;
  IF has_table_privilege('authenticated', 'public.paid_operations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.paid_operations', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.paid_operations', 'DELETE') THEN
    RAISE EXCEPTION '093 validate failed: authenticated has an unexpected write privilege on paid_operations';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.paid_operations', 'SELECT') THEN
    RAISE EXCEPTION '093 validate failed: service_role is missing SELECT on paid_operations';
  END IF;
  IF has_table_privilege('service_role', 'public.paid_operations', 'INSERT')
     OR has_table_privilege('service_role', 'public.paid_operations', 'UPDATE')
     OR has_table_privilege('service_role', 'public.paid_operations', 'DELETE') THEN
    RAISE EXCEPTION '093 validate failed: service_role has an unexpected direct write privilege on paid_operations (writes must go through the SECURITY DEFINER RPC only)';
  END IF;

  -- RLS enabled AND forced on paid_operations.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'paid_operations' AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION '093 validate failed: paid_operations must have RLS enabled AND forced';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='paid_operations' AND policyname='paid_operations_select_own'
  ) THEN
    RAISE EXCEPTION '093 validate failed: paid_operations_select_own RLS policy missing';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
