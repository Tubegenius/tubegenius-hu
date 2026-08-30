-- ============================================================
-- 082: Supervised Intake -- Anthropic Workspace Config Error code
-- ============================================================
-- PURPOSE: the PFM Anthropic HTTP 400 investigation (Console Read-Only
-- Verification Gate, then the Identity-Linked Workspace Header Support
-- gate) confirmed the production Anthropic key is identity-linked
-- (Personal / "All workspaces") and therefore requires the
-- anthropic-workspace-id header on every Messages API call. The
-- application layer (anthropic-workspace-config.ts) now fails closed,
-- BEFORE any reservation or provider call, when ANTHROPIC_WORKSPACE_ID is
-- missing or fails the documented wrkspc_ format check -- but this is a
-- genuinely different failure class from every 081 provider-taxonomy code:
-- those all describe the PROVIDER rejecting a call that was actually sent;
-- this describes a LOCAL config check that runs before any HTTP request is
-- made at all. Reusing PROVIDER_INVALID_REQUEST_UNBILLED (or any other 081
-- code) here would misleadingly imply a provider round-trip occurred, so
-- this migration adds ONE new, single-purpose code instead:
--   ANTHROPIC_WORKSPACE_CONFIG_ERROR (local config check failed --
--                                     ANTHROPIC_WORKSPACE_ID missing or
--                                     malformed; zero HTTP calls made)
--
-- Same widening targets as 081: the item-level CHECK constraint AND
-- fail_intake_item's own internal reason_code validation. Deliberately NOT
-- touched, for the same reasoning 081 documented: stop_intake_batch's own
-- closed reason list (AUTHORIZATION_OR_CONFIG_ERROR already covers this at
-- the batch-stop level -- see supervised-intake-runner.ts's decideItemOutcome
-- 'configuration_error' case), supervised_intake_events_kind_check,
-- supervised_intake_idempotency_ledger_operation_check, and every 080
-- object.
--
-- fail_intake_item's body is guarded by CONTENT checks (LIKE) rather than
-- an exact md5(prosrc) hash, unlike 081's own guard against the 079
-- baseline: 081's post-upgrade hash was never captured as a fixed literal
-- anywhere this migration file can read it without a live round-trip
-- against an already-migrated database, so this migration instead verifies
-- the function body contains every 081 code (proving 081 was applied) and
-- does not yet contain the new 082 code (proving this migration has not
-- already run) before touching it -- still fail-closed: any OTHER
-- unrecognized body content is refused via the same style of exception 081
-- uses for its own hash mismatch.
BEGIN;

-- ============================================================
-- 0. Topology precondition -- 077/078/079/080/081 must be fully applied
-- first (identical RPC count to 081's own check -- 082 adds no new RPCs).
-- ============================================================
DO $topology_check$
DECLARE
  v_rpc_count INTEGER;
  v_prosrc TEXT;
BEGIN
  SELECT count(*) INTO v_rpc_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'authorize_intake_item_retry', 'begin_intake_attempt_call', 'cancel_intake_batch',
      'claim_next_intake_item', 'complete_intake_item_success', 'configure_supervised_intake_control',
      'create_supervised_intake_batch', 'fail_intake_item', 'finalize_intake_batch',
      'reconcile_stale_intake_claims', 'resolve_intake_attempt_reconciliation', 'stop_intake_batch',
      '_close_pending_items_for_stopped_batch', 'abandon_unclaimed_intake_item'
    );
  IF v_rpc_count <> 14 THEN
    RAISE EXCEPTION '082 fail-closed: expected all 14 supervised-intake RPCs (079/080) to be present, found %. Apply 079 and 080 first.', v_rpc_count;
  END IF;

  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE proname = 'fail_intake_item';
  IF v_prosrc IS NULL OR v_prosrc NOT LIKE '%PROVIDER_REJECTED_UNBILLED_UNKNOWN%' THEN
    RAISE EXCEPTION '082 fail-closed: fail_intake_item does not yet include the 081 provider-taxonomy codes -- apply 081 first.';
  END IF;
  RAISE NOTICE '082: 079/080/081 topology precondition passed.';
END $topology_check$;

-- ============================================================
-- 1. supervised_intake_batch_items_reason_code_check -- widen with the one
-- new local-config-error code.
-- ============================================================
DO $migrate_item_reason_check$
DECLARE
  v_def TEXT;
  v_081_def CONSTANT TEXT := 'CHECK (((reason_code IS NULL) OR (reason_code = ANY (ARRAY[''EVIDENCE_NOT_FOUND''::text, ''ALREADY_EXTRACTED''::text, ''ALREADY_ASSIGNED''::text, ''INVALID_STRUCTURED_OUTPUT''::text, ''NOT_SPECIFIC''::text, ''CONFIDENCE_NOT_REVIEW_ELIGIBLE''::text, ''NO_SUPPORTING_SPANS''::text, ''INVALID_EVIDENCE_STATE''::text, ''BATCH_STOPPED''::text, ''BATCH_CANCELLED''::text, ''CLAIMED_ELSEWHERE''::text, ''RECONCILED_NOT_CHARGED''::text, ''RECONCILED_CHARGED_FAILURE''::text, ''PROVIDER_AUTHENTICATION_FAILED''::text, ''PROVIDER_PERMISSION_DENIED''::text, ''PROVIDER_MODEL_NOT_FOUND''::text, ''PROVIDER_INVALID_REQUEST_UNBILLED''::text, ''PROVIDER_REJECTED_UNBILLED_UNKNOWN''::text]))))';
  v_082_def CONSTANT TEXT := 'CHECK (((reason_code IS NULL) OR (reason_code = ANY (ARRAY[''EVIDENCE_NOT_FOUND''::text, ''ALREADY_EXTRACTED''::text, ''ALREADY_ASSIGNED''::text, ''INVALID_STRUCTURED_OUTPUT''::text, ''NOT_SPECIFIC''::text, ''CONFIDENCE_NOT_REVIEW_ELIGIBLE''::text, ''NO_SUPPORTING_SPANS''::text, ''INVALID_EVIDENCE_STATE''::text, ''BATCH_STOPPED''::text, ''BATCH_CANCELLED''::text, ''CLAIMED_ELSEWHERE''::text, ''RECONCILED_NOT_CHARGED''::text, ''RECONCILED_CHARGED_FAILURE''::text, ''PROVIDER_AUTHENTICATION_FAILED''::text, ''PROVIDER_PERMISSION_DENIED''::text, ''PROVIDER_MODEL_NOT_FOUND''::text, ''PROVIDER_INVALID_REQUEST_UNBILLED''::text, ''PROVIDER_REJECTED_UNBILLED_UNKNOWN''::text, ''ANTHROPIC_WORKSPACE_CONFIG_ERROR''::text]))))';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'supervised_intake_batch_items_reason_code_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '082 fail-closed: supervised_intake_batch_items_reason_code_check does not exist -- 079 must be applied first.';
  ELSIF v_def = v_082_def THEN
    RAISE NOTICE '082: supervised_intake_batch_items_reason_code_check already includes ANTHROPIC_WORKSPACE_CONFIG_ERROR -- no-op.';
  ELSIF v_def <> v_081_def THEN
    RAISE EXCEPTION '082 fail-closed: supervised_intake_batch_items_reason_code_check is neither the known 081 definition nor the 082 definition (got %) -- refusing to touch an unrecognized constraint.', v_def;
  ELSE
    ALTER TABLE public.supervised_intake_batch_items DROP CONSTRAINT supervised_intake_batch_items_reason_code_check;
    ALTER TABLE public.supervised_intake_batch_items ADD CONSTRAINT supervised_intake_batch_items_reason_code_check
      CHECK (reason_code IS NULL OR reason_code IN (
        'EVIDENCE_NOT_FOUND', 'ALREADY_EXTRACTED', 'ALREADY_ASSIGNED', 'INVALID_STRUCTURED_OUTPUT',
        'NOT_SPECIFIC', 'CONFIDENCE_NOT_REVIEW_ELIGIBLE', 'NO_SUPPORTING_SPANS', 'INVALID_EVIDENCE_STATE',
        'BATCH_STOPPED', 'BATCH_CANCELLED', 'CLAIMED_ELSEWHERE',
        'RECONCILED_NOT_CHARGED', 'RECONCILED_CHARGED_FAILURE',
        'PROVIDER_AUTHENTICATION_FAILED', 'PROVIDER_PERMISSION_DENIED', 'PROVIDER_MODEL_NOT_FOUND',
        'PROVIDER_INVALID_REQUEST_UNBILLED', 'PROVIDER_REJECTED_UNBILLED_UNKNOWN',
        'ANTHROPIC_WORKSPACE_CONFIG_ERROR'
      ));

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'supervised_intake_batch_items_reason_code_check';
    IF v_def <> v_082_def THEN
      RAISE EXCEPTION '082 CRITICAL: supervised_intake_batch_items_reason_code_check post-upgrade definition (%) does not match the pinned 082 definition. Aborting before COMMIT.', v_def;
    END IF;
    RAISE NOTICE '082: supervised_intake_batch_items_reason_code_check upgraded with ANTHROPIC_WORKSPACE_CONFIG_ERROR.';
  END IF;
END $migrate_item_reason_check$;

-- ============================================================
-- 2. fail_intake_item -- content-guarded upgrade (see this file's own
-- header for why a content check, not an exact hash, gates entry here).
-- Body otherwise byte-identical to 081.
-- ============================================================
DO $migrate_fail_intake_item$
DECLARE
  v_prosrc TEXT;
BEGIN
  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE proname = 'fail_intake_item';

  IF v_prosrc LIKE '%ANTHROPIC_WORKSPACE_CONFIG_ERROR%' THEN
    RAISE NOTICE '082: fail_intake_item already includes ANTHROPIC_WORKSPACE_CONFIG_ERROR -- no-op.';
  ELSIF v_prosrc LIKE '%PROVIDER_REJECTED_UNBILLED_UNKNOWN%' THEN
    RAISE NOTICE '082: fail_intake_item at the expected 081 body -- upgrading reason_code validation to include ANTHROPIC_WORKSPACE_CONFIG_ERROR.';

    CREATE OR REPLACE FUNCTION public.fail_intake_item(
      p_item_id UUID,
      p_claim_token TEXT,
      p_reason_code TEXT,
      p_retryable BOOLEAN,
      p_diagnostic_code TEXT,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_request_digest TEXT;
      v_ledger RECORD;
      v_item RECORD;
      v_attempt RECORD;
      v_supplied_digest TEXT;
    BEGIN
      IF p_reason_code NOT IN (
        'EVIDENCE_NOT_FOUND', 'ALREADY_EXTRACTED', 'ALREADY_ASSIGNED', 'INVALID_STRUCTURED_OUTPUT',
        'NOT_SPECIFIC', 'CONFIDENCE_NOT_REVIEW_ELIGIBLE', 'NO_SUPPORTING_SPANS', 'INVALID_EVIDENCE_STATE',
        'PROVIDER_AUTHENTICATION_FAILED', 'PROVIDER_PERMISSION_DENIED', 'PROVIDER_MODEL_NOT_FOUND',
        'PROVIDER_INVALID_REQUEST_UNBILLED', 'PROVIDER_REJECTED_UNBILLED_UNKNOWN',
        'ANTHROPIC_WORKSPACE_CONFIG_ERROR'
      ) THEN
        RAISE EXCEPTION 'fail_intake_item: INVALID_REASON_CODE -- %', p_reason_code USING ERRCODE = 'P0001';
      END IF;
      IF p_diagnostic_code IS NOT NULL AND (length(p_diagnostic_code) > 64 OR p_diagnostic_code !~ '^[A-Za-z0-9_.:-]*$') THEN
        RAISE EXCEPTION 'fail_intake_item: INVALID_DIAGNOSTIC_CODE' USING ERRCODE = 'P0001';
      END IF;

      v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"item_id":%s,"reason_code":%s,"retryable":%s,"diagnostic_code":%s}',
          to_json('willviral.semantic-topic.supervised-intake-fail:v1'::text)::text, to_json(p_item_id::text)::text,
          to_json(p_reason_code)::text, to_json(p_retryable)::text, coalesce(to_json(p_diagnostic_code)::text, 'null')),
        'UTF8')), 'hex');

      SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
      IF FOUND THEN
        IF v_ledger.request_digest <> v_request_digest THEN
          RAISE EXCEPTION 'fail_intake_item: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
        END IF;
        RETURN v_ledger.replay_result;
      END IF;
      INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
        VALUES (p_idempotency_key, 'fail_item', v_request_digest);

      SELECT * INTO v_item FROM public.supervised_intake_batch_items WHERE id = p_item_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'fail_intake_item: ITEM_NOT_FOUND' USING ERRCODE = 'P0001';
      END IF;

      v_supplied_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token, 'UTF8')), 'hex');
      IF v_item.status <> 'claimed' OR v_item.token_digest IS DISTINCT FROM v_supplied_digest THEN
        RAISE EXCEPTION 'fail_intake_item: CLAIM_TOKEN_MISMATCH' USING ERRCODE = 'P0001';
      END IF;
      IF v_item.lease_expires_at <= now() THEN
        RAISE EXCEPTION 'fail_intake_item: STALE_CLAIM_ALREADY_RECONCILED' USING ERRCODE = 'P0001';
      END IF;

      SELECT * INTO v_attempt FROM public.supervised_intake_attempts WHERE id = v_item.current_attempt_id FOR UPDATE;

      UPDATE public.supervised_intake_attempts
        SET status = CASE WHEN p_retryable THEN 'failed_retryable' ELSE 'failed_terminal' END,
            reason_code = p_reason_code, retryable = p_retryable, diagnostic_code = p_diagnostic_code, finished_at = now()
        WHERE id = v_attempt.id;

      UPDATE public.supervised_intake_batch_items
        SET status = 'failed', reason_code = p_reason_code, retryable = p_retryable, updated_at = now()
        WHERE id = v_item.id;

      INSERT INTO public.supervised_intake_events (batch_id, item_id, attempt_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
        VALUES (v_item.batch_id, v_item.id, v_attempt.id, 'attempt_failed', v_attempt.status, CASE WHEN p_retryable THEN 'failed_retryable' ELSE 'failed_terminal' END, p_reason_code, 'service_role_system');
      INSERT INTO public.supervised_intake_events (batch_id, item_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
        VALUES (v_item.batch_id, v_item.id, 'item_failed', 'claimed', 'failed', p_reason_code, 'service_role_system');

      UPDATE public.supervised_intake_idempotency_ledger
        SET replay_result = jsonb_build_object('ok', true, 'item_id', v_item.id, 'status', 'failed', 'retryable', p_retryable),
            entity_id = v_item.id, completed_at = now()
        WHERE idempotency_key = p_idempotency_key;

      RETURN jsonb_build_object('ok', true, 'item_id', v_item.id, 'status', 'failed', 'retryable', p_retryable);
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.fail_intake_item(UUID, TEXT, TEXT, BOOLEAN, TEXT, TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.fail_intake_item(UUID, TEXT, TEXT, BOOLEAN, TEXT, TEXT) TO service_role;

    RAISE NOTICE '082: fail_intake_item upgraded.';
  ELSE
    RAISE EXCEPTION '082 fail-closed: fail_intake_item body is neither the known 081 baseline nor an already-upgraded 082 body -- refusing to touch an unrecognized definition.';
  END IF;

  IF (SELECT count(*) FROM pg_proc WHERE proname = 'fail_intake_item') <> 1 THEN
    RAISE EXCEPTION '082 fail-closed: fail_intake_item has an unexpected overload count.';
  END IF;
END $migrate_fail_intake_item$;

NOTIFY pgrst, 'reload schema';
COMMIT;
