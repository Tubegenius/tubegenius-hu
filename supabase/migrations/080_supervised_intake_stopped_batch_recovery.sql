-- ============================================================
-- 080: Supervised Intake -- Stopped-Batch Pending-Item Recovery
-- ============================================================
-- PURPOSE: claim_next_intake_item's two inline stop branches
-- (INTAKE_POLICY_DISABLED, DAILY_LIMIT_REACHED) transition a batch to
-- 'stopped' but never terminalize that batch's still-'pending' items --
-- unlike the dedicated stop_intake_batch RPC, which correctly closes them
-- to 'unprocessed_batch_closed'/'BATCH_STOPPED'. A pending item left this
-- way permanently blocks its evidence via the cross-batch dedup unique
-- index (supervised_intake_batch_items_evidence_config_active_unique),
-- with no existing RPC able to resolve it: stop_intake_batch/
-- cancel_intake_batch both require status IN ('batch_created','running'),
-- which an already-'stopped' batch never satisfies again; finalize_intake_batch
-- explicitly REJECTS batches with pending/claimed items
-- (ITEMS_STILL_IN_FLIGHT); reconcile_stale_intake_claims only targets
-- status='claimed' AND lease_expires_at < now(), never a never-claimed
-- 'pending' item.
--
-- This migration:
--   1. Adds an internal-only helper, _close_pending_items_for_stopped_batch,
--      that terminalizes a stopped batch's remaining pending items to the
--      ALREADY-EXISTING (never-yet-used) 'unprocessed_batch_closed' status
--      with the ALREADY-EXISTING 'item_closed_unprocessed' event_kind --
--      zero CHECK-constraint changes required (both values were already
--      part of 079's own closed vocabulary).
--   2. Upgrades claim_next_intake_item (exact-hash guarded) so both inline
--      stop branches call this helper instead of only updating the batch row.
--   3. Upgrades stop_intake_batch (exact-hash guarded) to call the SAME
--      helper instead of its own separate inline item-closure UPDATE --
--      parity between all three stop-entry-points by construction, not by
--      convention.
--   4. Adds abandon_unclaimed_intake_item: an audited, idempotent,
--      service_role-only recovery RPC for a batch that already reached
--      'stopped' with a still-'pending' item (the historical/pre-080 case,
--      and any other path that could theoretically produce the same
--      combination). Precondition scope is deliberately narrow -- see the
--      RPC's own header comment -- an item's own status='pending' is
--      airtight proof (via the pre-existing status_fields CHECK) that it
--      has no claim token, no attempt, no extraction run, no review
--      request; this migration never checks evidence-wide history, which
--      would risk false-blocking recovery of one item because of a
--      completely unrelated, already-resolved attempt on the same evidence.
--
-- cancel_intake_batch is DELIBERATELY NOT touched here: its own pending-
-- item closure (status IN ('batch_created','running') only, reason_code
-- 'BATCH_CANCELLED') is already correct and already tested; converting it
-- to the shared helper is unnecessary scope this migration does not take on.
--
-- No CASCADE, no overload, no CHECK-constraint change, no RLS change, no
-- grant change on any existing table. Idempotent re-apply: running this
-- file twice against an already-080'd database is a byte-identical no-op
-- (every branch below follows 079's own CREATE/VALIDATE-with-exact-hash
-- pattern).
-- ============================================================

BEGIN;

-- ============================================================
-- 0. DEPENDENCY PRECONDITION -- the exact 079 baseline this migration
-- upgrades FROM. Fail-closed if the local stack is not at exactly this
-- starting point (protects against applying 080 to a drifted or
-- out-of-order database).
-- ============================================================
DO $topology_gate$
DECLARE
  v_present_count INTEGER;
BEGIN
  SELECT count(*) INTO v_present_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN (
    'configure_supervised_intake_control', 'create_supervised_intake_batch', 'claim_next_intake_item',
    'begin_intake_attempt_call', 'complete_intake_item_success', 'fail_intake_item',
    'stop_intake_batch', 'cancel_intake_batch', 'reconcile_stale_intake_claims',
    'resolve_intake_attempt_reconciliation', 'authorize_intake_item_retry', 'finalize_intake_batch'
  );

  IF v_present_count <> 12 THEN
    RAISE EXCEPTION '080 fail-closed: expected all 12 of 079''s supervised-intake RPCs to be present before this migration runs (found %). Apply/repair 079 first.', v_present_count;
  END IF;

  RAISE NOTICE '080: 079 RPC topology precondition passed (12 of 12 present).';
END;
$topology_gate$;

-- ============================================================
-- 1. Internal helper: _close_pending_items_for_stopped_batch
-- ============================================================
-- NOT a public RPC. No PostgREST entry point, no operator CLI entry
-- point. SECURITY DEFINER is required because supervised_intake_batch_items
-- and supervised_intake_events both have RLS FORCED with only a
-- service_role SELECT grant (no INSERT/UPDATE grant to any role) --
-- exactly like every other write in this RPC family, which all run as the
-- function owner (postgres) via SECURITY DEFINER rather than via a direct
-- table grant to the calling role. REVOKE ALL is issued against PUBLIC,
-- anon, authenticated, AND service_role explicitly -- unlike every public
-- RPC in this file, service_role itself must NEVER be able to call this
-- helper directly; it exists to be called only from inside the other
-- SECURITY DEFINER RPCs below (which execute as the function owner, so
-- the owner's own implicit execute rights, never revoked here, are what
-- lets claim_next_intake_item/stop_intake_batch invoke it).
DO $migrate_helper$
DECLARE
  v_name_count INTEGER;
  v_oid OID;
  v_hash TEXT;
  v_expected_hash CONSTANT TEXT := '077348225fef2de59c00e7324b720e2b';
  v_expected_args CONSTANT TEXT := 'p_batch_id uuid, p_reason_code text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '_close_pending_items_for_stopped_batch';

  IF v_name_count = 0 THEN
    RAISE NOTICE '080: _close_pending_items_for_stopped_batch does not exist -- CREATE branch.';

    CREATE FUNCTION public._close_pending_items_for_stopped_batch(
      p_batch_id UUID,
      p_reason_code TEXT
    ) RETURNS INTEGER
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $fn$
    DECLARE
      v_closed_count INTEGER;
      v_item RECORD;
    BEGIN
      -- Same shape as stop_intake_batch's own former inline UPDATE --
      -- moved here verbatim so every caller gets byte-identical behavior.
      -- Only 'pending' items are ever touched; claimed/calling/
      -- reconciliation_required/succeeded/failed/skipped_*/already-closed
      -- items are structurally untouched by this WHERE clause.
      FOR v_item IN
        SELECT id FROM public.supervised_intake_batch_items
          WHERE batch_id = p_batch_id AND status = 'pending'
          FOR UPDATE
      LOOP
        UPDATE public.supervised_intake_batch_items
          SET status = 'unprocessed_batch_closed', reason_code = 'BATCH_STOPPED', updated_at = now()
          WHERE id = v_item.id;

        -- item_closed_unprocessed already existed in 079's own
        -- supervised_intake_events_kind_check CHECK constraint, unused by
        -- any RPC until now -- no CHECK-constraint change required.
        INSERT INTO public.supervised_intake_events (batch_id, item_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
          VALUES (p_batch_id, v_item.id, 'item_closed_unprocessed', 'pending', 'unprocessed_batch_closed', p_reason_code, 'service_role_system');
      END LOOP;

      GET DIAGNOSTICS v_closed_count = ROW_COUNT;
      RETURN coalesce(v_closed_count, 0);
    END;
    $fn$;

    REVOKE ALL ON FUNCTION public._close_pending_items_for_stopped_batch(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

    RAISE NOTICE '080: _close_pending_items_for_stopped_batch created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '080: _close_pending_items_for_stopped_batch already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = '_close_pending_items_for_stopped_batch';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'integer'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '080 drift: _close_pending_items_for_stopped_batch structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_hash FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_hash, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '080 drift: _close_pending_items_for_stopped_batch body hash does not match exactly (got %)', v_hash;
    END IF;

    IF EXISTS (
      SELECT 1 FROM aclexplode(coalesce(
        (SELECT proacl FROM pg_proc WHERE oid = v_oid),
        acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
      )) acl
      WHERE acl.privilege_type = 'EXECUTE'
        AND (acl.grantee = 0 OR acl.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')))
    ) THEN
      RAISE EXCEPTION '080 drift: _close_pending_items_for_stopped_batch must never grant EXECUTE to PUBLIC/anon/authenticated/service_role';
    END IF;

    RAISE NOTICE '080: _close_pending_items_for_stopped_batch already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '080 fail-closed: _close_pending_items_for_stopped_batch has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_helper$;

-- ============================================================
-- 2. claim_next_intake_item -- exact-hash upgrade
-- ============================================================
DO $migrate_claim$
DECLARE
  v_oid OID;
  v_prosrc TEXT;
  v_hash TEXT;
  v_expected_hash_079 CONSTANT TEXT := 'a4a83a122c57d1d976838093c95612be';
  v_expected_hash_080 CONSTANT TEXT := '21b4d6d58d259cc1235f74f1f2e5d38d';
  v_expected_args CONSTANT TEXT := 'p_batch_id uuid, p_idempotency_key text';
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'claim_next_intake_item';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '080 fail-closed: claim_next_intake_item does not exist -- 079 must be applied first.';
  END IF;

  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
  v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));

  IF v_hash = v_expected_hash_080 THEN
    RAISE NOTICE '080: claim_next_intake_item already at the 080 body hash -- no-op.';
  ELSIF v_hash <> v_expected_hash_079 THEN
    RAISE EXCEPTION '080 fail-closed: claim_next_intake_item body hash is neither the known 079 hash nor the 080 hash (got %) -- refusing to touch an unrecognized definition.', v_hash;
  ELSE
    RAISE NOTICE '080: claim_next_intake_item at the expected 079 hash -- upgrading to the 080 body.';

    CREATE OR REPLACE FUNCTION public.claim_next_intake_item(
      p_batch_id UUID,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_request_digest TEXT;
      v_ledger RECORD;
      v_control RECORD;
      v_batch RECORD;
      v_item RECORD;
      v_daily_count INTEGER;
      v_token TEXT;
      v_token_digest TEXT;
      v_lease_expires TIMESTAMPTZ;
      v_attempt_id UUID;
      v_next_attempt_number INTEGER;
      v_new_generation INTEGER;
      v_closed_count INTEGER;
    BEGIN
      v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"batch_id":%s}', to_json('willviral.semantic-topic.supervised-intake-claim:v1'::text)::text, to_json(p_batch_id::text)::text),
        'UTF8')), 'hex');

      SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
      IF FOUND THEN
        IF v_ledger.request_digest <> v_request_digest THEN
          RAISE EXCEPTION 'claim_next_intake_item: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
        END IF;
        RETURN v_ledger.replay_result || jsonb_build_object('claim_token_available', false);
      END IF;
      INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
        VALUES (p_idempotency_key, 'claim_item', v_request_digest);

      SELECT * INTO v_control FROM public.supervised_intake_control WHERE id = 1 FOR UPDATE;

      SELECT * INTO v_batch FROM public.supervised_intake_batches WHERE id = p_batch_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'claim_next_intake_item: BATCH_NOT_FOUND' USING ERRCODE = 'P0001';
      END IF;

      IF v_control.enabled IS NOT TRUE THEN
        UPDATE public.supervised_intake_batches SET status = 'stopped', reason_code = 'INTAKE_POLICY_DISABLED', started_at = coalesce(started_at, now()) WHERE id = p_batch_id AND status IN ('batch_created','running');
        INSERT INTO public.supervised_intake_events (batch_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
          VALUES (p_batch_id, 'batch_stopped', v_batch.status, 'stopped', 'INTAKE_POLICY_DISABLED', 'service_role_system');
        -- 080: terminalize any still-pending items on this batch in the
        -- SAME transaction, via the shared helper -- this is the fix.
        v_closed_count := public._close_pending_items_for_stopped_batch(p_batch_id, 'INTAKE_POLICY_DISABLED');
        UPDATE public.supervised_intake_idempotency_ledger SET replay_result = jsonb_build_object('ok', true, 'outcome', 'batch_stopped', 'reason_code', 'INTAKE_POLICY_DISABLED', 'closed_pending_items', v_closed_count), completed_at = now() WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('ok', true, 'outcome', 'batch_stopped', 'reason_code', 'INTAKE_POLICY_DISABLED', 'closed_pending_items', v_closed_count);
      END IF;

      IF v_batch.status NOT IN ('batch_created', 'running') THEN
        RAISE EXCEPTION 'claim_next_intake_item: BATCH_NOT_CLAIMABLE -- status=%', v_batch.status USING ERRCODE = 'P0001';
      END IF;

      SELECT count(*) INTO v_daily_count FROM public.supervised_intake_attempts
        WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      IF v_daily_count >= v_control.max_daily_claimed_items THEN
        UPDATE public.supervised_intake_batches SET status = 'stopped', reason_code = 'DAILY_LIMIT_REACHED', started_at = coalesce(started_at, now()) WHERE id = p_batch_id AND status IN ('batch_created','running');
        INSERT INTO public.supervised_intake_events (batch_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
          VALUES (p_batch_id, 'batch_stopped', v_batch.status, 'stopped', 'DAILY_LIMIT_REACHED', 'service_role_system');
        -- 080: terminalize any still-pending items on this batch in the
        -- SAME transaction, via the shared helper -- this is the fix.
        v_closed_count := public._close_pending_items_for_stopped_batch(p_batch_id, 'DAILY_LIMIT_REACHED');
        UPDATE public.supervised_intake_idempotency_ledger SET replay_result = jsonb_build_object('ok', true, 'outcome', 'batch_stopped', 'reason_code', 'DAILY_LIMIT_REACHED', 'closed_pending_items', v_closed_count), completed_at = now() WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('ok', true, 'outcome', 'batch_stopped', 'reason_code', 'DAILY_LIMIT_REACHED', 'closed_pending_items', v_closed_count);
      END IF;

      IF v_batch.status = 'batch_created' THEN
        UPDATE public.supervised_intake_batches SET status = 'running', started_at = now() WHERE id = p_batch_id;
      END IF;

      <<claim_loop>>
      LOOP
        SELECT * INTO v_item FROM public.supervised_intake_batch_items
          WHERE batch_id = p_batch_id AND status = 'pending'
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1;

        IF NOT FOUND THEN
          UPDATE public.supervised_intake_idempotency_ledger SET replay_result = jsonb_build_object('ok', true, 'outcome', 'no_more_items'), completed_at = now() WHERE idempotency_key = p_idempotency_key;
          RETURN jsonb_build_object('ok', true, 'outcome', 'no_more_items');
        END IF;

        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_item.signal_evidence_id::text, 40));

        IF EXISTS (
          SELECT 1 FROM public.topic_assignment_decisions d
          JOIN public.topic_extraction_runs t ON t.id = d.extraction_run_id
          WHERE t.signal_evidence_id = v_item.signal_evidence_id
        ) THEN
          UPDATE public.supervised_intake_batch_items
            SET status = 'skipped_already_assigned', reason_code = 'ALREADY_ASSIGNED',
                extraction_run_id = (SELECT d.extraction_run_id FROM public.topic_assignment_decisions d JOIN public.topic_extraction_runs t ON t.id = d.extraction_run_id WHERE t.signal_evidence_id = v_item.signal_evidence_id LIMIT 1),
                updated_at = now()
            WHERE id = v_item.id;
          INSERT INTO public.supervised_intake_events (batch_id, item_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
            VALUES (p_batch_id, v_item.id, 'item_skipped', 'pending', 'skipped_already_assigned', 'ALREADY_ASSIGNED', 'service_role_system');
          CONTINUE claim_loop;
        END IF;

        IF EXISTS (
          SELECT 1 FROM public.topic_extraction_runs t
          WHERE t.signal_evidence_id = v_item.signal_evidence_id
            AND t.status = 'completed'
        ) THEN
          UPDATE public.supervised_intake_batch_items
            SET status = 'skipped_already_extracted', reason_code = 'ALREADY_EXTRACTED',
                extraction_run_id = (SELECT id FROM public.topic_extraction_runs t2 WHERE t2.signal_evidence_id = v_item.signal_evidence_id AND t2.status = 'completed' ORDER BY t2.created_at LIMIT 1),
                updated_at = now()
            WHERE id = v_item.id;
          INSERT INTO public.supervised_intake_events (batch_id, item_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
            VALUES (p_batch_id, v_item.id, 'item_skipped', 'pending', 'skipped_already_extracted', 'ALREADY_EXTRACTED', 'service_role_system');
          CONTINUE claim_loop;
        END IF;

        v_token := encode(extensions.gen_random_bytes(32), 'hex');
        v_token_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8')), 'hex');
        v_lease_expires := now() + make_interval(secs => v_control.claim_lease_seconds);

        v_next_attempt_number := (SELECT coalesce(max(attempt_number), 0) + 1 FROM public.supervised_intake_attempts WHERE batch_item_id = v_item.id);
        v_new_generation := v_item.fencing_generation + 1;

        INSERT INTO public.supervised_intake_attempts (batch_item_id, attempt_number, fencing_generation, status, base_idempotency_key)
          VALUES (
            v_item.id, v_next_attempt_number, v_new_generation, 'prepared',
            format('supervised-intake:%s:%s', v_item.id::text, v_next_attempt_number)
          )
          RETURNING id INTO v_attempt_id;

        UPDATE public.supervised_intake_batch_items
          SET status = 'claimed', token_digest = v_token_digest, fencing_generation = v_new_generation,
              claimed_at = now(), lease_expires_at = v_lease_expires, current_attempt_id = v_attempt_id, updated_at = now()
          WHERE id = v_item.id;
        v_item.fencing_generation := v_new_generation;

        INSERT INTO public.supervised_intake_events (batch_id, item_id, event_kind, previous_status, resulting_status, actor_kind)
          VALUES (p_batch_id, v_item.id, 'item_claimed', 'pending', 'claimed', 'service_role_system');
        INSERT INTO public.supervised_intake_events (batch_id, item_id, attempt_id, event_kind, resulting_status, actor_kind)
          VALUES (p_batch_id, v_item.id, v_attempt_id, 'attempt_prepared', 'prepared', 'service_role_system');

        UPDATE public.supervised_intake_idempotency_ledger
          SET replay_result = jsonb_build_object(
                'ok', true, 'outcome', 'claimed', 'item_id', v_item.id, 'attempt_id', v_attempt_id,
                'signal_evidence_id', v_item.signal_evidence_id, 'fencing_generation', v_item.fencing_generation,
                'lease_expires_at', v_lease_expires
              ),
              entity_id = v_item.id, completed_at = now()
          WHERE idempotency_key = p_idempotency_key;

        RETURN jsonb_build_object(
          'ok', true, 'outcome', 'claimed', 'item_id', v_item.id, 'attempt_id', v_attempt_id,
          'signal_evidence_id', v_item.signal_evidence_id, 'claim_token', v_token, 'claim_token_available', true,
          'fencing_generation', v_item.fencing_generation, 'lease_expires_at', v_lease_expires
        );
      END LOOP;
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.claim_next_intake_item(UUID, TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.claim_next_intake_item(UUID, TEXT) TO service_role;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'claim_next_intake_item');
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash_080 THEN
      RAISE EXCEPTION '080 CRITICAL: claim_next_intake_item post-upgrade body hash (%) does not match the pinned 080 hash (%) -- the CREATE OR REPLACE body text and the pinned constant have drifted apart. Aborting before COMMIT.', v_hash, v_expected_hash_080;
    END IF;

    RAISE NOTICE '080: claim_next_intake_item upgraded to the 080 body.';
  END IF;
END;
$migrate_claim$;

-- ============================================================
-- 3. stop_intake_batch -- exact-hash upgrade (parity with claim_next_intake_item)
-- ============================================================
DO $migrate_stop$
DECLARE
  v_oid OID;
  v_prosrc TEXT;
  v_hash TEXT;
  v_expected_hash_079 CONSTANT TEXT := '4f2d25a22c3b85f926153c7453b6b771';
  v_expected_hash_080 CONSTANT TEXT := 'a23602bc8f37aff495632832522cf96d';
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'stop_intake_batch';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '080 fail-closed: stop_intake_batch does not exist -- 079 must be applied first.';
  END IF;

  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
  v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));

  IF v_hash = v_expected_hash_080 THEN
    RAISE NOTICE '080: stop_intake_batch already at the 080 body hash -- no-op.';
  ELSIF v_hash <> v_expected_hash_079 THEN
    RAISE EXCEPTION '080 fail-closed: stop_intake_batch body hash is neither the known 079 hash nor the 080 hash (got %) -- refusing to touch an unrecognized definition.', v_hash;
  ELSE
    RAISE NOTICE '080: stop_intake_batch at the expected 079 hash -- upgrading to the 080 body (shared helper, same closed_pending_items shape).';

    CREATE OR REPLACE FUNCTION public.stop_intake_batch(
      p_batch_id UUID,
      p_reason_code TEXT,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_request_digest TEXT;
      v_ledger RECORD;
      v_batch RECORD;
      v_closed_count INTEGER;
    BEGIN
      IF p_reason_code NOT IN (
        'AI_EXTRACTION_DISABLED', 'BUDGET_EXHAUSTED', 'AUTHORIZATION_OR_CONFIG_ERROR',
        'INTAKE_POLICY_DISABLED', 'DAILY_LIMIT_REACHED', 'PROVIDER_OUTCOME_UNCERTAIN'
      ) THEN
        RAISE EXCEPTION 'stop_intake_batch: INVALID_REASON_CODE -- %', p_reason_code USING ERRCODE = 'P0001';
      END IF;

      v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"batch_id":%s,"reason_code":%s}', to_json('willviral.semantic-topic.supervised-intake-stop:v1'::text)::text, to_json(p_batch_id::text)::text, to_json(p_reason_code)::text),
        'UTF8')), 'hex');

      SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
      IF FOUND THEN
        IF v_ledger.request_digest <> v_request_digest THEN
          RAISE EXCEPTION 'stop_intake_batch: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
        END IF;
        RETURN v_ledger.replay_result;
      END IF;
      INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
        VALUES (p_idempotency_key, 'stop_batch', v_request_digest);

      SELECT * INTO v_batch FROM public.supervised_intake_batches WHERE id = p_batch_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'stop_intake_batch: BATCH_NOT_FOUND' USING ERRCODE = 'P0001';
      END IF;
      IF v_batch.status NOT IN ('batch_created', 'running') THEN
        RAISE EXCEPTION 'stop_intake_batch: BATCH_NOT_STOPPABLE -- status=%', v_batch.status USING ERRCODE = 'P0001';
      END IF;

      UPDATE public.supervised_intake_batches
        SET status = CASE WHEN p_reason_code = 'PROVIDER_OUTCOME_UNCERTAIN' THEN 'reconciliation_pending' ELSE 'stopped' END,
            reason_code = p_reason_code, started_at = COALESCE(started_at, now())
        WHERE id = p_batch_id;

      INSERT INTO public.supervised_intake_events (batch_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
        VALUES (p_batch_id, 'batch_stopped', v_batch.status, CASE WHEN p_reason_code = 'PROVIDER_OUTCOME_UNCERTAIN' THEN 'reconciliation_pending' ELSE 'stopped' END, p_reason_code, 'service_role_system');

      -- 080: shared helper -- byte-identical item-closure behavior to
      -- claim_next_intake_item's two inline stop branches. Only actually
      -- closes items when the batch ends in 'stopped' (never for
      -- 'reconciliation_pending', which is a different, still-in-flight
      -- state where pending items legitimately remain pending).
      IF p_reason_code <> 'PROVIDER_OUTCOME_UNCERTAIN' THEN
        v_closed_count := public._close_pending_items_for_stopped_batch(p_batch_id, p_reason_code);
      ELSE
        v_closed_count := 0;
      END IF;

      UPDATE public.supervised_intake_idempotency_ledger
        SET replay_result = jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'closed_pending_items', v_closed_count),
            entity_id = p_batch_id, completed_at = now()
        WHERE idempotency_key = p_idempotency_key;

      RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'closed_pending_items', v_closed_count);
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.stop_intake_batch(UUID, TEXT, TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.stop_intake_batch(UUID, TEXT, TEXT) TO service_role;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'stop_intake_batch');
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash_080 THEN
      RAISE EXCEPTION '080 CRITICAL: stop_intake_batch post-upgrade body hash (%) does not match the pinned 080 hash (%). Aborting before COMMIT.', v_hash, v_expected_hash_080;
    END IF;

    RAISE NOTICE '080: stop_intake_batch upgraded to the 080 body.';
  END IF;
END;
$migrate_stop$;

-- ============================================================
-- 4. supervised_intake_idempotency_ledger_operation_check -- CHECK-
-- constraint upgrade: 'abandon_unclaimed_item' is a genuinely NEW
-- operation name for the recovery RPC below, unlike
-- supervised_intake_events_kind_check's own 'item_closed_unprocessed'
-- (which 079 already included, unused, in its closed vocabulary) --
-- confirmed directly against the deployed constraint definition, not
-- assumed. Explicit, fail-closed, idempotent-safe widening: verifies the
-- exact 079 definition before touching it, and the exact 080 definition
-- after, so a second application is a byte-identical no-op and an
-- unrecognized/already-drifted definition aborts instead of silently
-- overwriting it.
-- ============================================================
DO $migrate_ledger_check$
DECLARE
  v_def TEXT;
  v_079_def CONSTANT TEXT := 'CHECK ((operation = ANY (ARRAY[''configure_control''::text, ''create_batch''::text, ''claim_item''::text, ''begin_attempt_call''::text, ''complete_item''::text, ''fail_item''::text, ''stop_batch''::text, ''cancel_batch''::text, ''reconcile_stale''::text, ''resolve_reconciliation''::text, ''authorize_retry''::text, ''finalize_batch''::text])))';
  v_080_def CONSTANT TEXT := 'CHECK ((operation = ANY (ARRAY[''configure_control''::text, ''create_batch''::text, ''claim_item''::text, ''begin_attempt_call''::text, ''complete_item''::text, ''fail_item''::text, ''stop_batch''::text, ''cancel_batch''::text, ''reconcile_stale''::text, ''resolve_reconciliation''::text, ''authorize_retry''::text, ''finalize_batch''::text, ''abandon_unclaimed_item''::text])))';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'supervised_intake_idempotency_ledger_operation_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '080 fail-closed: supervised_intake_idempotency_ledger_operation_check does not exist -- 079 must be applied first.';
  ELSIF v_def = v_080_def THEN
    RAISE NOTICE '080: supervised_intake_idempotency_ledger_operation_check already includes abandon_unclaimed_item -- no-op.';
  ELSIF v_def <> v_079_def THEN
    RAISE EXCEPTION '080 fail-closed: supervised_intake_idempotency_ledger_operation_check is neither the known 079 definition nor the 080 definition (got %) -- refusing to touch an unrecognized constraint.', v_def;
  ELSE
    ALTER TABLE public.supervised_intake_idempotency_ledger DROP CONSTRAINT supervised_intake_idempotency_ledger_operation_check;
    ALTER TABLE public.supervised_intake_idempotency_ledger ADD CONSTRAINT supervised_intake_idempotency_ledger_operation_check
      CHECK (operation IN (
        'configure_control', 'create_batch', 'claim_item', 'begin_attempt_call', 'complete_item', 'fail_item',
        'stop_batch', 'cancel_batch', 'reconcile_stale', 'resolve_reconciliation',
        'authorize_retry', 'finalize_batch', 'abandon_unclaimed_item'
      ));

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'supervised_intake_idempotency_ledger_operation_check';
    IF v_def <> v_080_def THEN
      RAISE EXCEPTION '080 CRITICAL: supervised_intake_idempotency_ledger_operation_check post-upgrade definition (%) does not match the pinned 080 definition. Aborting before COMMIT.', v_def;
    END IF;
    RAISE NOTICE '080: supervised_intake_idempotency_ledger_operation_check upgraded to include abandon_unclaimed_item.';
  END IF;
END;
$migrate_ledger_check$;

-- ============================================================
-- 5. abandon_unclaimed_intake_item -- new recovery RPC
-- ============================================================
-- Precondition scope is DELIBERATELY narrow: item.status = 'pending' is
-- airtight proof (via 079's own supervised_intake_batch_items_status_fields
-- CHECK) that this SPECIFIC item has no claim token, no current_attempt_id,
-- no extraction_run_id, no review_request_id. This migration never queries
-- ai_provider_budget_reservations/topic_extraction_runs/
-- topic_assignment_decisions by evidence_id -- an unrelated, already-
-- resolved historical attempt on the SAME evidence (from a different,
-- earlier batch) must never false-block recovery of THIS item. A
-- historically-failed-but-retry-authorized item that is CURRENTLY pending
-- again is exactly as recoverable as one that was always pending --
-- status='pending' NOW is what matters, not what happened before.
DO $migrate_abandon$
DECLARE
  v_name_count INTEGER;
  v_oid OID;
  v_prosrc TEXT;
  v_hash TEXT;
  v_expected_hash CONSTANT TEXT := '7af8d9a71cd31805842f1e00da42b925';
  v_expected_args CONSTANT TEXT := 'p_batch_id uuid, p_item_id uuid, p_operator_reference text, p_idempotency_key text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'abandon_unclaimed_intake_item';

  IF v_name_count = 0 THEN
    RAISE NOTICE '080: abandon_unclaimed_intake_item does not exist -- CREATE branch.';

    CREATE FUNCTION public.abandon_unclaimed_intake_item(
      p_batch_id UUID,
      p_item_id UUID,
      p_operator_reference TEXT,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_request_digest TEXT;
      v_ledger RECORD;
      v_batch RECORD;
      v_item RECORD;
      v_closed_count INTEGER;
    BEGIN
      IF p_operator_reference !~ '^[A-Za-z0-9._@-]{3,64}$' THEN
        RAISE EXCEPTION 'abandon_unclaimed_intake_item: INVALID_OPERATOR_REFERENCE' USING ERRCODE = 'P0001';
      END IF;

      v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"batch_id":%s,"item_id":%s,"operator_reference":%s}',
          to_json('willviral.semantic-topic.supervised-intake-abandon:v1'::text)::text,
          to_json(p_batch_id::text)::text, to_json(p_item_id::text)::text, to_json(p_operator_reference)::text),
        'UTF8')), 'hex');

      SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
      IF FOUND THEN
        IF v_ledger.request_digest <> v_request_digest THEN
          RAISE EXCEPTION 'abandon_unclaimed_intake_item: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
        END IF;
        RETURN v_ledger.replay_result;
      END IF;
      INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
        VALUES (p_idempotency_key, 'abandon_unclaimed_item', v_request_digest);

      SELECT * INTO v_batch FROM public.supervised_intake_batches WHERE id = p_batch_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'abandon_unclaimed_intake_item: BATCH_NOT_FOUND' USING ERRCODE = 'P0001';
      END IF;
      IF v_batch.status <> 'stopped' THEN
        RAISE EXCEPTION 'abandon_unclaimed_intake_item: BATCH_NOT_STOPPED -- status=%', v_batch.status USING ERRCODE = 'P0001';
      END IF;

      SELECT * INTO v_item FROM public.supervised_intake_batch_items WHERE id = p_item_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'abandon_unclaimed_intake_item: ITEM_NOT_FOUND' USING ERRCODE = 'P0001';
      END IF;
      IF v_item.batch_id <> p_batch_id THEN
        RAISE EXCEPTION 'abandon_unclaimed_intake_item: ITEM_NOT_IN_BATCH' USING ERRCODE = 'P0001';
      END IF;
      IF v_item.status <> 'pending' THEN
        RAISE EXCEPTION 'abandon_unclaimed_intake_item: ITEM_NOT_PENDING -- status=%', v_item.status USING ERRCODE = 'P0001';
      END IF;
      -- Redundant with the status='pending' check above (the status_fields
      -- CHECK already guarantees these are NULL whenever status='pending'),
      -- kept as an explicit, self-documenting defense-in-depth assertion
      -- rather than relying solely on a constraint defined elsewhere.
      IF v_item.token_digest IS NOT NULL OR v_item.current_attempt_id IS NOT NULL THEN
        RAISE EXCEPTION 'abandon_unclaimed_intake_item: ITEM_HAS_ACTIVE_CLAIM' USING ERRCODE = 'P0001';
      END IF;

      UPDATE public.supervised_intake_batch_items
        SET status = 'unprocessed_batch_closed', reason_code = 'BATCH_STOPPED', updated_at = now()
        WHERE id = p_item_id;

      INSERT INTO public.supervised_intake_events (batch_id, item_id, event_kind, previous_status, resulting_status, reason_code, actor_kind, actor_reference)
        VALUES (p_batch_id, p_item_id, 'item_closed_unprocessed', 'pending', 'unprocessed_batch_closed', 'BATCH_STOPPED', 'operator_asserted', p_operator_reference);
      v_closed_count := 1;

      UPDATE public.supervised_intake_idempotency_ledger
        SET replay_result = jsonb_build_object('ok', true, 'outcome', 'recovered', 'batch_id', p_batch_id, 'item_id', p_item_id, 'closed_pending_items', v_closed_count),
            entity_id = p_item_id, completed_at = now()
        WHERE idempotency_key = p_idempotency_key;

      RETURN jsonb_build_object('ok', true, 'outcome', 'recovered', 'batch_id', p_batch_id, 'item_id', p_item_id, 'closed_pending_items', v_closed_count);
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.abandon_unclaimed_intake_item(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.abandon_unclaimed_intake_item(UUID, UUID, TEXT, TEXT) TO service_role;

    RAISE NOTICE '080: abandon_unclaimed_intake_item created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '080: abandon_unclaimed_intake_item already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'abandon_unclaimed_intake_item';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '080 drift: abandon_unclaimed_intake_item structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '080 drift: abandon_unclaimed_intake_item body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'service_role')
       )
    THEN
      RAISE EXCEPTION '080 drift: abandon_unclaimed_intake_item ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '080: abandon_unclaimed_intake_item already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '080 fail-closed: abandon_unclaimed_intake_item has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_abandon$;

NOTIFY pgrst, 'reload schema';

COMMIT;
