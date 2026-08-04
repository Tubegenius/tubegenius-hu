-- ============================================================
-- Migration 063: bind provider reservations to collection batches
--
-- PFM-3B2.1. The 060 schema introduced the one-way nullable FK
-- reservations.batch_id -> collection_batches.id, while the immutable 061
-- reserve RPC intentionally did not accept a batch argument. This migration
-- adds one narrowly scoped SECURITY DEFINER RPC that may fill that FK only
-- before the provider attempt starts and only for the active batch lease.
--
-- Missing function -> CREATE. Exact match -> no-op. Any drift -> exception.
-- No table grant, policy, RLS, data, existing RPC, or default-ACL change.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_name_count INTEGER;
  v_exact_oid OID;
BEGIN
  IF to_regclass('public.signal_provider_budget_reservations') IS NULL
     OR to_regclass('public.signal_collection_batches') IS NULL
     OR to_regclass('public.signal_run_phases') IS NULL THEN
    RAISE EXCEPTION '063 dependency missing: reservations, batches and run phases must already exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'signal_provider_budget_reservations'
      AND column_name = 'batch_id'
      AND data_type = 'uuid'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION '063 dependency drift: signal_provider_budget_reservations.batch_id is missing or incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.signal_provider_budget_reservations'::regclass
      AND c.conname = 'signal_provider_budget_reservations_batch_id_fkey'
      AND c.contype = 'f'
      AND c.confrelid = 'public.signal_collection_batches'::regclass
      AND c.confdeltype = 'n'
      AND c.convalidated IS TRUE
  ) THEN
    RAISE EXCEPTION '063 dependency drift: the reservation batch FK is missing or incompatible';
  END IF;

  SELECT count(*) INTO v_name_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'bind_provider_reservation_to_batch';

  v_exact_oid := to_regprocedure('public.bind_provider_reservation_to_batch(uuid, uuid, text)');

  IF v_name_count = 0 THEN
    CREATE FUNCTION public.bind_provider_reservation_to_batch(
      p_reservation_id UUID,
      p_batch_id UUID,
      p_lease_owner TEXT
    ) RETURNS BOOLEAN
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_reservation public.signal_provider_budget_reservations%ROWTYPE;
  v_batch public.signal_collection_batches%ROWTYPE;
  v_phase public.signal_run_phases%ROWTYPE;
  v_expected_key TEXT;
BEGIN
  IF p_reservation_id IS NULL OR p_batch_id IS NULL THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: reservation_id and batch_id are required' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(btrim(p_lease_owner), '') IS NULL THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: lease_owner is required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_reservation
  FROM public.signal_provider_budget_reservations
  WHERE id = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: reservation % not found', p_reservation_id USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_batch
  FROM public.signal_collection_batches
  WHERE id = p_batch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: batch % not found', p_batch_id USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_phase
  FROM public.signal_run_phases
  WHERE id = v_batch.run_phase_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: run phase not found' USING ERRCODE = 'P0001';
  END IF;

  IF v_reservation.run_id IS DISTINCT FROM v_phase.run_id
     OR v_reservation.phase IS DISTINCT FROM v_phase.phase
     OR v_batch.batch_type IS DISTINCT FROM v_phase.phase THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: run or phase mismatch' USING ERRCODE = 'P0001';
  END IF;

  v_expected_key := format('signal-batch:%s:attempt:%s', v_batch.id, v_batch.attempt);
  IF v_reservation.idempotency_key IS DISTINCT FROM v_expected_key THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: idempotency key does not match the batch attempt' USING ERRCODE = 'P0001';
  END IF;

  -- The reservation uniqueness key is scoped to a provider quota day. A
  -- batch attempt crossing the Pacific-time date boundary must still never
  -- acquire two reservations with the same canonical attempt key. The batch
  -- row lock above serializes this cross-day guard.
  IF EXISTS (
    SELECT 1
    FROM public.signal_provider_budget_reservations r
    WHERE r.batch_id = p_batch_id
      AND r.idempotency_key = v_expected_key
      AND r.id <> p_reservation_id
  ) THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: batch attempt already has another reservation' USING ERRCODE = 'P0001';
  END IF;

  IF v_reservation.batch_id = p_batch_id THEN
    RETURN true;
  END IF;
  IF v_reservation.batch_id IS NOT NULL THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: reservation is already bound to another batch' USING ERRCODE = 'P0001';
  END IF;
  IF v_reservation.status <> 'reserved' OR v_reservation.attempt_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: reservation is no longer bindable' USING ERRCODE = 'P0001';
  END IF;
  IF v_reservation.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: reservation lease expired' USING ERRCODE = 'P0001';
  END IF;
  IF v_batch.status <> 'in_progress'
     OR v_batch.lease_owner IS DISTINCT FROM btrim(p_lease_owner)
     OR v_batch.lease_expires_at IS NULL
     OR v_batch.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: caller does not own an active batch lease' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.signal_provider_budget_reservations
  SET batch_id = p_batch_id
  WHERE id = p_reservation_id AND batch_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bind_provider_reservation_to_batch: concurrent bind conflict' USING ERRCODE = 'P0001';
  END IF;

  RETURN true;
END;
$body$;

    REVOKE ALL ON FUNCTION public.bind_provider_reservation_to_batch(UUID, UUID, TEXT)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.bind_provider_reservation_to_batch(UUID, UUID, TEXT)
      TO service_role;

    RAISE NOTICE '063: bind_provider_reservation_to_batch created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid
        AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = 'p_reservation_id uuid, p_batch_id uuid, p_lease_owner text'
        AND pg_get_function_result(p.oid) = 'boolean'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND md5(replace(p.prosrc, E'\r\n', E'\n')) = '1373cae28319ed700bab226b6a4f7744'
    ) THEN
      RAISE EXCEPTION '063 drift: bind_provider_reservation_to_batch definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public'
        AND routine_name = 'bind_provider_reservation_to_batch'
        AND grantee = 'service_role'
        AND privilege_type = 'EXECUTE'
    ) OR EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public'
        AND routine_name = 'bind_provider_reservation_to_batch'
        AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '063 drift: bind_provider_reservation_to_batch EXECUTE ACL does not match exactly';
    END IF;

    RAISE NOTICE '063: bind_provider_reservation_to_batch already matches exactly - no-op.';
  ELSE
    RAISE EXCEPTION '063 drift: unexpected bind_provider_reservation_to_batch overload/signature';
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
