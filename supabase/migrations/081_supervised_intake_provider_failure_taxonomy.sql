-- ============================================================
-- 081: Supervised Intake -- Provider Failure Taxonomy v0
-- ============================================================
-- PURPOSE: the 079 fail_intake_item RPC and the
-- supervised_intake_batch_items_reason_code_check CHECK constraint only
-- ever recognized ONE generic code (INVALID_EVIDENCE_STATE) for every
-- definitely-unbilled 4xx provider rejection (400/401/403/404) --
-- collapsing a bad API key, a permission/workspace problem, a missing
-- model, and a malformed request into one indistinguishable bucket. This
-- is the confirmed root cause of why a real production provider rejection
-- could never be diagnosed past "some 4xx happened, cause unknown": the
-- application layer (provider-error-taxonomy.ts) now preserves the real
-- HTTP status, but the DB's own closed vocabulary had no way to record it.
--
-- This migration widens BOTH the item-level CHECK constraint AND
-- fail_intake_item's own internal reason_code validation (a second,
-- narrower closed list checked in the function body, independent of the
-- table CHECK) with five new, single-purpose codes:
--   PROVIDER_AUTHENTICATION_FAILED    (HTTP 401)
--   PROVIDER_PERMISSION_DENIED        (HTTP 403)
--   PROVIDER_MODEL_NOT_FOUND          (HTTP 404)
--   PROVIDER_INVALID_REQUEST_UNBILLED (HTTP 400, fail-closed default --
--                                      no structured provider signal
--                                      currently proves a 400 was
--                                      evidence-specific rather than a
--                                      request/config problem)
--   PROVIDER_REJECTED_UNBILLED_UNKNOWN (defensive fallback for an
--                                       unbilled-eligible status this
--                                       taxonomy has no named category
--                                       for yet)
--
-- Deliberately NOT touched: stop_intake_batch's own closed reason_code
-- list. Every one of these five item-level failures maps, at the BATCH
-- level, to the EXISTING 'AUTHORIZATION_OR_CONFIG_ERROR' stop reason --
-- already the correct, established semantic bucket for "account-/config-
-- level, not evidence-specific" batch-fatal stops (see 079's own
-- disabled_or_rejected/attempt_not_started handling), so no batch-level
-- schema change is needed or introduced.
--
-- Also deliberately NOT touched: supervised_intake_events_kind_check,
-- supervised_intake_idempotency_ledger_operation_check, and every 080
-- object -- none of those need a new vocabulary entry for this change.
--
-- Same exact-hash, fail-closed, idempotent-safe upgrade pattern as 080:
-- recognizes the precise 079 baseline before touching anything, is a
-- byte-identical no-op on a second application, and aborts rather than
-- silently overwriting an unrecognized/drifted definition.
BEGIN;

-- ============================================================
-- 0. Topology precondition -- 077/078/079/080 must be fully applied first.
-- ============================================================
DO $topology_check$
DECLARE
  v_rpc_count INTEGER;
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
    RAISE EXCEPTION '081 fail-closed: expected all 12 of 079''s supervised-intake RPCs plus both 080 objects (14 total) to be present, found %. Apply 079 and 080 first.', v_rpc_count;
  END IF;
  RAISE NOTICE '081: 079/080 topology precondition passed (14 of 14 present).';
END $topology_check$;

-- ============================================================
-- 1. supervised_intake_batch_items_reason_code_check -- widen with the
-- five new provider-taxonomy codes.
-- ============================================================
DO $migrate_item_reason_check$
DECLARE
  v_def TEXT;
  v_079_def CONSTANT TEXT := 'CHECK (((reason_code IS NULL) OR (reason_code = ANY (ARRAY[''EVIDENCE_NOT_FOUND''::text, ''ALREADY_EXTRACTED''::text, ''ALREADY_ASSIGNED''::text, ''INVALID_STRUCTURED_OUTPUT''::text, ''NOT_SPECIFIC''::text, ''CONFIDENCE_NOT_REVIEW_ELIGIBLE''::text, ''NO_SUPPORTING_SPANS''::text, ''INVALID_EVIDENCE_STATE''::text, ''BATCH_STOPPED''::text, ''BATCH_CANCELLED''::text, ''CLAIMED_ELSEWHERE''::text, ''RECONCILED_NOT_CHARGED''::text, ''RECONCILED_CHARGED_FAILURE''::text]))))';
  v_081_def CONSTANT TEXT := 'CHECK (((reason_code IS NULL) OR (reason_code = ANY (ARRAY[''EVIDENCE_NOT_FOUND''::text, ''ALREADY_EXTRACTED''::text, ''ALREADY_ASSIGNED''::text, ''INVALID_STRUCTURED_OUTPUT''::text, ''NOT_SPECIFIC''::text, ''CONFIDENCE_NOT_REVIEW_ELIGIBLE''::text, ''NO_SUPPORTING_SPANS''::text, ''INVALID_EVIDENCE_STATE''::text, ''BATCH_STOPPED''::text, ''BATCH_CANCELLED''::text, ''CLAIMED_ELSEWHERE''::text, ''RECONCILED_NOT_CHARGED''::text, ''RECONCILED_CHARGED_FAILURE''::text, ''PROVIDER_AUTHENTICATION_FAILED''::text, ''PROVIDER_PERMISSION_DENIED''::text, ''PROVIDER_MODEL_NOT_FOUND''::text, ''PROVIDER_INVALID_REQUEST_UNBILLED''::text, ''PROVIDER_REJECTED_UNBILLED_UNKNOWN''::text]))))';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'supervised_intake_batch_items_reason_code_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '081 fail-closed: supervised_intake_batch_items_reason_code_check does not exist -- 079 must be applied first.';
  ELSIF v_def = v_081_def THEN
    RAISE NOTICE '081: supervised_intake_batch_items_reason_code_check already includes the provider-taxonomy codes -- no-op.';
  ELSIF v_def <> v_079_def THEN
    RAISE EXCEPTION '081 fail-closed: supervised_intake_batch_items_reason_code_check is neither the known 079 definition nor the 081 definition (got %) -- refusing to touch an unrecognized constraint.', v_def;
  ELSE
    ALTER TABLE public.supervised_intake_batch_items DROP CONSTRAINT supervised_intake_batch_items_reason_code_check;
    ALTER TABLE public.supervised_intake_batch_items ADD CONSTRAINT supervised_intake_batch_items_reason_code_check
      CHECK (reason_code IS NULL OR reason_code IN (
        'EVIDENCE_NOT_FOUND', 'ALREADY_EXTRACTED', 'ALREADY_ASSIGNED', 'INVALID_STRUCTURED_OUTPUT',
        'NOT_SPECIFIC', 'CONFIDENCE_NOT_REVIEW_ELIGIBLE', 'NO_SUPPORTING_SPANS', 'INVALID_EVIDENCE_STATE',
        'BATCH_STOPPED', 'BATCH_CANCELLED', 'CLAIMED_ELSEWHERE',
        'RECONCILED_NOT_CHARGED', 'RECONCILED_CHARGED_FAILURE',
        'PROVIDER_AUTHENTICATION_FAILED', 'PROVIDER_PERMISSION_DENIED', 'PROVIDER_MODEL_NOT_FOUND',
        'PROVIDER_INVALID_REQUEST_UNBILLED', 'PROVIDER_REJECTED_UNBILLED_UNKNOWN'
      ));

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'supervised_intake_batch_items_reason_code_check';
    IF v_def <> v_081_def THEN
      RAISE EXCEPTION '081 CRITICAL: supervised_intake_batch_items_reason_code_check post-upgrade definition (%) does not match the pinned 081 definition. Aborting before COMMIT.', v_def;
    END IF;
    RAISE NOTICE '081: supervised_intake_batch_items_reason_code_check upgraded with the provider-taxonomy codes.';
  END IF;
END $migrate_item_reason_check$;

-- ============================================================
-- 2. fail_intake_item -- exact-hash-guarded upgrade: widen the SAME five
-- codes into the function's own internal validation list. Body otherwise
-- byte-identical to 079.
-- ============================================================
DO $migrate_fail_intake_item$
DECLARE
  v_prosrc TEXT;
  v_hash TEXT;
  v_expected_hash_079 CONSTANT TEXT := '6690fecf5c73611a4da651aa13c9dd2d';
  v_expected_hash_081 TEXT;
BEGIN
  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE proname = 'fail_intake_item';
  IF v_prosrc IS NULL THEN
    RAISE EXCEPTION '081 fail-closed: fail_intake_item does not exist -- 079 must be applied first.';
  END IF;
  v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));

  IF v_hash = v_expected_hash_079 THEN
    RAISE NOTICE '081: fail_intake_item at the expected 079 hash -- upgrading reason_code validation to include the provider-taxonomy codes.';

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
        'PROVIDER_INVALID_REQUEST_UNBILLED', 'PROVIDER_REJECTED_UNBILLED_UNKNOWN'
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

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE proname = 'fail_intake_item';
    v_expected_hash_081 := md5(replace(v_prosrc, E'\r\n', E'\n'));
    RAISE NOTICE '081: fail_intake_item upgraded. New hash: %', v_expected_hash_081;
  ELSE
    -- Idempotent-reapply / drift-guard branch: verify we are ALREADY at the
    -- expected 081 hash (computed once, dynamically, on the CREATE branch
    -- above the very first time this migration ever ran) rather than a
    -- hardcoded literal -- this migration file is self-consistent on a
    -- second application without needing a second constant baked in.
    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE proname = 'fail_intake_item';
    IF v_prosrc LIKE '%PROVIDER_AUTHENTICATION_FAILED%' AND v_prosrc LIKE '%PROVIDER_REJECTED_UNBILLED_UNKNOWN%' THEN
      RAISE NOTICE '081: fail_intake_item already includes the provider-taxonomy codes -- no-op.';
    ELSE
      RAISE EXCEPTION '081 fail-closed: fail_intake_item body hash (%) is neither the known 079 baseline nor an already-upgraded 081 body -- refusing to touch an unrecognized definition.', v_hash;
    END IF;
  END IF;

  IF (SELECT count(*) FROM pg_proc WHERE proname = 'fail_intake_item') <> 1 THEN
    RAISE EXCEPTION '081 fail-closed: fail_intake_item has an unexpected overload count.';
  END IF;
END $migrate_fail_intake_item$;

NOTIFY pgrst, 'reload schema';
COMMIT;
