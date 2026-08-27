-- Semantic Topic Identity v0 -- PFM Supervised Production Candidate Intake v0.
--
-- SCOPE: a service-only, DB-authoritative batch/attempt state machine for a
-- future, manually-invoked, one-shot intake runner (the runner itself is
-- NOT part of this migration -- see docs/architecture/semantic-topic-identity-v0-contract.md
-- SS36+ for the full design-gate history). This migration adds ONLY new
-- objects; it never touches 075/077/078's existing tables/RPCs/grants.
--
-- SECURITY MODEL (explicit, not overstated): every mutating RPC here is
-- SECURITY DEFINER, SET search_path = public, pg_temp, EXECUTE granted
-- EXCLUSIVELY to service_role, REVOKEd from anon/authenticated. The DB
-- authenticates ONLY that the caller holds the service_role JWT -- an
-- `operator_reference` string is an AUDITED, SELF-ASSERTED claim, never a
-- cryptographically verified human identity. Real per-operator
-- authentication is explicitly out of scope for v0 (documented future
-- work), and this migration deliberately does not claim otherwise anywhere
-- in its comments or error messages.
--
-- KILL SWITCHES, kept deliberately separate:
--   ai_extraction_control.enabled (075)      -- gates every AI provider call
--   supervised_intake_control.enabled (HERE) -- gates the intake batch/claim
--                                                layer itself, a narrower,
--                                                earlier gate than the above
-- Neither table is touched by the other; this migration never sets
-- ai_extraction_control.enabled, and supervised_intake_control starts
-- disabled with zero capacity (enabled=false, max_batch_items=0,
-- max_daily_claimed_items=0) exactly like ai_extraction_control started at
-- id=1, enabled=false in 075.
--
-- NEW OBJECTS:
--   Tables (7): supervised_intake_control, supervised_intake_control_events,
--     supervised_intake_batches, supervised_intake_batch_items,
--     supervised_intake_attempts, supervised_intake_events,
--     supervised_intake_idempotency_ledger.
--   RPCs (12): configure_supervised_intake_control, create_supervised_intake_batch,
--     claim_next_intake_item, begin_intake_attempt_call, complete_intake_item_success,
--     fail_intake_item, stop_intake_batch, cancel_intake_batch,
--     reconcile_stale_intake_claims, resolve_intake_attempt_reconciliation,
--     authorize_intake_item_retry, finalize_intake_batch.
--
-- GLOBAL LOCK ORDER (every RPC that needs more than one lock acquires them
-- in EXACTLY this order, never reversed -- this is what makes concurrent
-- claims/updates deadlock-free by construction):
--   0. supervised_intake_idempotency_ledger row (replay short-circuit)
--   1. supervised_intake_control row (id=1)            FOR UPDATE
--   2. supervised_intake_batches row / advisory lock
--   3. signal_evidence advisory lock (claim only)
--   4. supervised_intake_batch_items row                FOR UPDATE
--   5. supervised_intake_attempts row                    FOR UPDATE
--
-- Idempotent, additive, self-validating reapply: CREATE-branch if an object
-- is missing, VALIDATE-branch (topology/hash comparison, no DDL/DCL) if
-- present -- exactly the 077/078 pattern. RPC bodies are validated by
-- comparing md5(pg_get_functiondef(oid)) against a hardcoded expected hash;
-- any drift is a hard RAISE EXCEPTION, never a silent CREATE OR REPLACE.

BEGIN;

DO $$
DECLARE
  v_075_tables INTEGER;
  v_077_tables INTEGER;
  v_078_rpcs INTEGER;
BEGIN
  SELECT count(*) INTO v_075_tables FROM pg_tables WHERE schemaname = 'public'
    AND tablename IN ('ai_extraction_control', 'ai_provider_daily_budgets', 'ai_provider_budget_reservations');
  IF v_075_tables <> 3 THEN
    RAISE EXCEPTION '079 dependency preflight: 075 (ai quota foundation) is not fully applied (found % of 3 tables)', v_075_tables;
  END IF;

  SELECT count(*) INTO v_077_tables FROM pg_tables WHERE schemaname = 'public'
    AND tablename IN ('semantic_topic_reviewers', 'semantic_topic_reviewer_events', 'topic_assignment_review_requests', 'topic_assignment_review_events');
  IF v_077_tables <> 4 THEN
    RAISE EXCEPTION '079 dependency preflight: 077 (human review schema) is not fully applied (found % of 4 tables)', v_077_tables;
  END IF;

  SELECT count(*) INTO v_078_rpcs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_topic_assignment_review_request';
  IF v_078_rpcs = 0 THEN
    RAISE EXCEPTION '079 dependency preflight: 078 (human review RPCs) is not applied';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_extraction_runs') THEN
    RAISE EXCEPTION '079 dependency preflight: topic_extraction_runs (074) is not applied';
  END IF;

  RAISE NOTICE '079: dependency preflight passed (075/077/078/074 fully applied).';
END $$;

-- pgcrypto capability preflight -- introspected, never assumed. gen_random_bytes
-- lives in whichever schema pgcrypto was installed into on THIS stack (here:
-- "extensions", NOT public and NOT pg_catalog) -- this migration resolves
-- the schema dynamically and fails loud if the capability is absent, rather
-- than hardcoding a schema qualification that could silently break on a
-- differently-configured target.
DO $$
DECLARE
  v_pgcrypto_schema TEXT;
BEGIN
  SELECT n.nspname INTO v_pgcrypto_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto';
  IF v_pgcrypto_schema IS NULL THEN
    RAISE EXCEPTION '079 preflight: pgcrypto extension is not installed on this database';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'gen_random_bytes' AND n.nspname = v_pgcrypto_schema
  ) THEN
    RAISE EXCEPTION '079 preflight: gen_random_bytes() not found in pgcrypto schema %', v_pgcrypto_schema;
  END IF;
  RAISE NOTICE '079: pgcrypto capability confirmed (schema=%). gen_random_bytes will be called as %.gen_random_bytes(...).', v_pgcrypto_schema, v_pgcrypto_schema;
END $$;

-- ===========================================================================
-- 1. supervised_intake_control -- singleton policy, mirrors ai_extraction_control's
--    own pattern from 075 exactly (single row, id=1, service_role SELECT-only
--    at the table level -- UPDATE happens exclusively through
--    configure_supervised_intake_control() below).
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'supervised_intake_control') THEN
    RAISE NOTICE '079: supervised_intake_control does not exist -- CREATE branch.';

    CREATE TABLE public.supervised_intake_control (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      max_batch_items INTEGER NOT NULL DEFAULT 0,
      max_daily_claimed_items INTEGER NOT NULL DEFAULT 0,
      claim_lease_seconds INTEGER NOT NULL DEFAULT 900,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT supervised_intake_control_single_row CHECK (id = 1),
      CONSTRAINT supervised_intake_control_max_batch_items_nonneg CHECK (max_batch_items >= 0),
      CONSTRAINT supervised_intake_control_max_daily_nonneg CHECK (max_daily_claimed_items >= 0),
      CONSTRAINT supervised_intake_control_lease_bounds CHECK (claim_lease_seconds BETWEEN 60 AND 3600)
    );
    INSERT INTO public.supervised_intake_control (id, enabled, max_batch_items, max_daily_claimed_items, claim_lease_seconds)
      VALUES (1, false, 0, 0, 900);

    ALTER TABLE public.supervised_intake_control ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.supervised_intake_control FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.supervised_intake_control TO service_role;

    RAISE NOTICE '079: supervised_intake_control created (id=1, enabled=false, max_batch_items=0, max_daily_claimed_items=0).';
  ELSE
    RAISE NOTICE '079: supervised_intake_control already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (SELECT 1 FROM public.supervised_intake_control WHERE id = 1) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_control is missing its single required row (id=1)';
    END IF;
    IF (SELECT count(*) FROM public.supervised_intake_control) <> 1 THEN
      RAISE EXCEPTION '079 drift: supervised_intake_control has more than one row';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'supervised_intake_control'
        AND cl.relrowsecurity = true AND cl.relforcerowsecurity = true
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_control RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'supervised_intake_control'
        AND grantee = 'service_role' AND privilege_type <> 'SELECT'
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_control service_role grant is not exactly SELECT';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'supervised_intake_control'
        AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_control has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '079: supervised_intake_control already exists and matches exactly -- no-op.';
  END IF;
END $$;

-- ===========================================================================
-- 2. supervised_intake_control_events -- separate append-only table (NOT
--    the unified batch/item/attempt events table below), because a control
--    change has no batch_id at all -- forcing it into a batch_id-NOT-NULL
--    table would be a structural lie.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'supervised_intake_control_events') THEN
    RAISE NOTICE '079: supervised_intake_control_events does not exist -- CREATE branch.';

    CREATE TABLE public.supervised_intake_control_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_kind TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      operator_reference TEXT NOT NULL,
      previous_config_digest TEXT NOT NULL,
      new_config_digest TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT supervised_intake_control_events_kind_check CHECK (event_kind = 'control_updated'),
      CONSTRAINT supervised_intake_control_events_reason_check CHECK (reason_code IN (
        'INITIAL_SETUP', 'ENABLE_FOR_CANARY', 'DISABLE_KILL_SWITCH', 'LIMIT_ADJUSTMENT', 'LEASE_ADJUSTMENT'
      )),
      CONSTRAINT supervised_intake_control_events_operator_ref_format CHECK (operator_reference ~ '^[A-Za-z0-9._@-]{3,64}$'),
      CONSTRAINT supervised_intake_control_events_prev_digest_format CHECK (previous_config_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT supervised_intake_control_events_new_digest_format CHECK (new_config_digest ~ '^[0-9a-f]{64}$')
    );

    ALTER TABLE public.supervised_intake_control_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.supervised_intake_control_events FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.supervised_intake_control_events TO service_role;

    RAISE NOTICE '079: supervised_intake_control_events created.';
  ELSE
    RAISE NOTICE '079: supervised_intake_control_events already exists -- VALIDATE branch (no DDL/DCL will run).';
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'supervised_intake_control_events'
        AND cl.relrowsecurity = true AND cl.relforcerowsecurity = true
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_control_events RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'supervised_intake_control_events'
        AND (grantee IN ('anon', 'authenticated', 'PUBLIC') OR (grantee = 'service_role' AND privilege_type <> 'SELECT'))
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_control_events grant set is not exactly service_role SELECT-only';
    END IF;
    RAISE NOTICE '079: supervised_intake_control_events already exists and matches exactly -- no-op.';
  END IF;
END $$;

-- ===========================================================================
-- 3. supervised_intake_batches
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'supervised_intake_batches') THEN
    RAISE NOTICE '079: supervised_intake_batches does not exist -- CREATE branch.';

    CREATE TABLE public.supervised_intake_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status TEXT NOT NULL DEFAULT 'batch_created',
      requested_evidence_count INTEGER NOT NULL,
      operator_reference TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      extraction_config_digest TEXT NOT NULL,
      reason_code TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT supervised_intake_batches_status_check CHECK (status IN (
        'batch_created', 'running', 'stopped', 'reconciliation_pending', 'completed', 'completed_with_failures', 'cancelled'
      )),
      CONSTRAINT supervised_intake_batches_count_positive CHECK (requested_evidence_count > 0),
      CONSTRAINT supervised_intake_batches_operator_ref_format CHECK (operator_reference ~ '^[A-Za-z0-9._@-]{3,64}$'),
      CONSTRAINT supervised_intake_batches_idempotency_key_unique UNIQUE (idempotency_key),
      CONSTRAINT supervised_intake_batches_request_digest_format CHECK (request_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT supervised_intake_batches_config_digest_format CHECK (extraction_config_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT supervised_intake_batches_status_fields CHECK (
        status = 'batch_created' AND started_at IS NULL AND finished_at IS NULL OR
        status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL OR
        status IN ('stopped', 'reconciliation_pending') AND started_at IS NOT NULL AND finished_at IS NULL OR
        status = 'cancelled' AND finished_at IS NOT NULL OR
        status IN ('completed', 'completed_with_failures') AND started_at IS NOT NULL AND finished_at IS NOT NULL
      )
    );

    ALTER TABLE public.supervised_intake_batches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.supervised_intake_batches FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.supervised_intake_batches TO service_role;

    RAISE NOTICE '079: supervised_intake_batches created.';
  ELSE
    RAISE NOTICE '079: supervised_intake_batches already exists -- VALIDATE branch (no DDL/DCL will run).';
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'supervised_intake_batches'
        AND cl.relrowsecurity = true AND cl.relforcerowsecurity = true
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_batches RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'supervised_intake_batches'
        AND (grantee IN ('anon', 'authenticated', 'PUBLIC') OR (grantee = 'service_role' AND privilege_type <> 'SELECT'))
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_batches grant set is not exactly service_role SELECT-only';
    END IF;
    RAISE NOTICE '079: supervised_intake_batches already exists and matches exactly -- no-op.';
  END IF;
END $$;

-- ===========================================================================
-- 4. supervised_intake_batch_items
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'supervised_intake_batch_items') THEN
    RAISE NOTICE '079: supervised_intake_batch_items does not exist -- CREATE branch.';

    CREATE TABLE public.supervised_intake_batch_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID NOT NULL REFERENCES public.supervised_intake_batches(id) ON DELETE RESTRICT,
      signal_evidence_id UUID NOT NULL REFERENCES public.signal_evidence(id) ON DELETE RESTRICT,
      extraction_config_digest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      token_digest TEXT,
      fencing_generation INTEGER NOT NULL DEFAULT 0,
      retryable BOOLEAN,
      claimed_at TIMESTAMPTZ,
      lease_expires_at TIMESTAMPTZ,
      current_attempt_id UUID,
      extraction_run_id UUID REFERENCES public.topic_extraction_runs(id) ON DELETE RESTRICT,
      review_request_id UUID REFERENCES public.topic_assignment_review_requests(id) ON DELETE RESTRICT,
      reason_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT supervised_intake_batch_items_config_digest_format CHECK (extraction_config_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT supervised_intake_batch_items_status_check CHECK (status IN (
        'pending', 'claimed', 'succeeded', 'failed',
        'skipped_already_extracted', 'skipped_already_assigned', 'skipped_claimed_elsewhere',
        'reconciliation_required', 'unprocessed_batch_closed'
      )),
      CONSTRAINT supervised_intake_batch_items_reason_code_check CHECK (reason_code IS NULL OR reason_code IN (
        'EVIDENCE_NOT_FOUND', 'ALREADY_EXTRACTED', 'ALREADY_ASSIGNED', 'INVALID_STRUCTURED_OUTPUT',
        'NOT_SPECIFIC', 'CONFIDENCE_NOT_REVIEW_ELIGIBLE', 'NO_SUPPORTING_SPANS', 'INVALID_EVIDENCE_STATE',
        'BATCH_STOPPED', 'BATCH_CANCELLED', 'CLAIMED_ELSEWHERE',
        'RECONCILED_NOT_CHARGED', 'RECONCILED_CHARGED_FAILURE'
      )),
      CONSTRAINT supervised_intake_batch_items_once_per_batch UNIQUE (batch_id, signal_evidence_id),
      CONSTRAINT supervised_intake_batch_items_status_fields CHECK (
        status = 'pending' AND token_digest IS NULL AND current_attempt_id IS NULL
          AND extraction_run_id IS NULL AND review_request_id IS NULL OR
        status = 'claimed' AND token_digest IS NOT NULL AND claimed_at IS NOT NULL
          AND lease_expires_at IS NOT NULL AND current_attempt_id IS NOT NULL OR
        status = 'succeeded' AND extraction_run_id IS NOT NULL OR
        status = 'skipped_already_extracted' AND extraction_run_id IS NOT NULL OR
        status = 'skipped_already_assigned' AND extraction_run_id IS NOT NULL OR
        status = 'skipped_claimed_elsewhere' OR
        status = 'failed' AND reason_code IS NOT NULL OR
        status = 'reconciliation_required' AND current_attempt_id IS NOT NULL OR
        status = 'unprocessed_batch_closed' AND reason_code IN ('BATCH_STOPPED', 'BATCH_CANCELLED')
      )
    );

    -- Cross-batch, race-proof dedup: at most one row across the WHOLE table
    -- may be in a non-terminal-safe state for a given (evidence, config).
    -- 'failed' only blocks while retryable IS TRUE (a failed_terminal
    -- resolution frees the slot for a brand-new, explicitly audited batch --
    -- never automatically, only via a fresh create_supervised_intake_batch call).
    CREATE UNIQUE INDEX supervised_intake_batch_items_evidence_config_active_unique
      ON public.supervised_intake_batch_items (signal_evidence_id, extraction_config_digest)
      WHERE status IN ('pending', 'claimed', 'succeeded', 'reconciliation_required')
         OR (status = 'failed' AND retryable IS TRUE);

    ALTER TABLE public.supervised_intake_batch_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.supervised_intake_batch_items FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.supervised_intake_batch_items TO service_role;

    RAISE NOTICE '079: supervised_intake_batch_items created.';
  ELSE
    RAISE NOTICE '079: supervised_intake_batch_items already exists -- VALIDATE branch (no DDL/DCL will run).';
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'supervised_intake_batch_items'
        AND indexname = 'supervised_intake_batch_items_evidence_config_active_unique'
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_batch_items is missing its cross-batch dedup unique index';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'supervised_intake_batch_items'
        AND cl.relrowsecurity = true AND cl.relforcerowsecurity = true
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_batch_items RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'supervised_intake_batch_items'
        AND (grantee IN ('anon', 'authenticated', 'PUBLIC') OR (grantee = 'service_role' AND privilege_type <> 'SELECT'))
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_batch_items grant set is not exactly service_role SELECT-only';
    END IF;
    RAISE NOTICE '079: supervised_intake_batch_items already exists and matches exactly -- no-op.';
  END IF;
END $$;

-- ===========================================================================
-- 5. supervised_intake_attempts -- one immutable-identity row per real
--    provider attempt, never overwritten by a later retry.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'supervised_intake_attempts') THEN
    RAISE NOTICE '079: supervised_intake_attempts does not exist -- CREATE branch.';

    CREATE TABLE public.supervised_intake_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_item_id UUID NOT NULL REFERENCES public.supervised_intake_batch_items(id) ON DELETE RESTRICT,
      attempt_number INTEGER NOT NULL,
      fencing_generation INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'prepared',
      base_idempotency_key TEXT NOT NULL,
      provider_reservation_id UUID REFERENCES public.ai_provider_budget_reservations(id) ON DELETE RESTRICT,
      extraction_run_id UUID REFERENCES public.topic_extraction_runs(id) ON DELETE RESTRICT,
      reason_code TEXT,
      retryable BOOLEAN,
      diagnostic_code TEXT,
      correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      provider_call_started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT supervised_intake_attempts_number_positive CHECK (attempt_number >= 1),
      CONSTRAINT supervised_intake_attempts_once_per_item UNIQUE (batch_item_id, attempt_number),
      CONSTRAINT supervised_intake_attempts_base_key_unique UNIQUE (base_idempotency_key),
      CONSTRAINT supervised_intake_attempts_status_check CHECK (status IN (
        'prepared', 'calling', 'completed', 'failed_retryable', 'failed_terminal', 'reconciliation_required'
      )),
      CONSTRAINT supervised_intake_attempts_diagnostic_code_format CHECK (
        diagnostic_code IS NULL OR (length(diagnostic_code) <= 64 AND diagnostic_code ~ '^[A-Za-z0-9_.:-]*$')
      ),
      CONSTRAINT supervised_intake_attempts_status_fields CHECK (
        status = 'prepared' AND provider_reservation_id IS NULL AND extraction_run_id IS NULL
          AND provider_call_started_at IS NULL AND finished_at IS NULL OR
        status = 'calling' AND provider_call_started_at IS NOT NULL AND finished_at IS NULL OR
        status = 'completed' AND extraction_run_id IS NOT NULL AND finished_at IS NOT NULL OR
        status = 'failed_retryable' AND retryable IS TRUE AND finished_at IS NOT NULL OR
        status = 'failed_terminal' AND retryable IS FALSE AND finished_at IS NOT NULL OR
        status = 'reconciliation_required' AND finished_at IS NULL
      )
    );

    ALTER TABLE public.supervised_intake_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.supervised_intake_attempts FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.supervised_intake_attempts TO service_role;

    -- Deferred, circular FK: batch_items.current_attempt_id -> attempts.id
    -- can only be added now that this table exists.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'supervised_intake_batch_items_current_attempt_fkey'
    ) THEN
      ALTER TABLE public.supervised_intake_batch_items
        ADD CONSTRAINT supervised_intake_batch_items_current_attempt_fkey
        FOREIGN KEY (current_attempt_id) REFERENCES public.supervised_intake_attempts(id) ON DELETE RESTRICT;
    END IF;

    RAISE NOTICE '079: supervised_intake_attempts created.';
  ELSE
    RAISE NOTICE '079: supervised_intake_attempts already exists -- VALIDATE branch (no DDL/DCL will run).';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'supervised_intake_attempts_base_key_unique'
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_attempts is missing its base_idempotency_key unique constraint';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
      WHERE cl.relname = 'supervised_intake_attempts' AND c.contype = 'f'
        AND c.confrelid = 'public.ai_provider_budget_reservations'::regclass
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_attempts.provider_reservation_id is missing its FK to ai_provider_budget_reservations';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'supervised_intake_attempts'
        AND cl.relrowsecurity = true AND cl.relforcerowsecurity = true
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_attempts RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'supervised_intake_attempts'
        AND (grantee IN ('anon', 'authenticated', 'PUBLIC') OR (grantee = 'service_role' AND privilege_type <> 'SELECT'))
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_attempts grant set is not exactly service_role SELECT-only';
    END IF;
    RAISE NOTICE '079: supervised_intake_attempts already exists and matches exactly -- no-op.';
  END IF;
END $$;

-- ===========================================================================
-- 6. supervised_intake_events -- unified, append-only batch/item/attempt
--    event log (scope-checked: never both item_id-null and event_kind
--    'item_%'/'attempt_%').
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'supervised_intake_events') THEN
    RAISE NOTICE '079: supervised_intake_events does not exist -- CREATE branch.';

    CREATE TABLE public.supervised_intake_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID NOT NULL REFERENCES public.supervised_intake_batches(id) ON DELETE RESTRICT,
      item_id UUID REFERENCES public.supervised_intake_batch_items(id) ON DELETE RESTRICT,
      attempt_id UUID REFERENCES public.supervised_intake_attempts(id) ON DELETE RESTRICT,
      event_kind TEXT NOT NULL,
      previous_status TEXT,
      resulting_status TEXT NOT NULL,
      reason_code TEXT,
      actor_kind TEXT NOT NULL,
      actor_reference TEXT,
      request_digest TEXT,
      extraction_run_id UUID REFERENCES public.topic_extraction_runs(id) ON DELETE RESTRICT,
      review_request_id UUID REFERENCES public.topic_assignment_review_requests(id) ON DELETE RESTRICT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT supervised_intake_events_kind_check CHECK (event_kind IN (
        'batch_created', 'batch_replayed', 'batch_stopped', 'batch_cancelled', 'batch_finalized',
        'item_claimed', 'item_succeeded', 'item_failed', 'item_skipped',
        'item_stale_reconciliation_required', 'item_retry_authorized', 'item_closed_unprocessed',
        'attempt_prepared', 'attempt_calling', 'attempt_completed', 'attempt_failed', 'attempt_reconciliation_resolved'
      )),
      CONSTRAINT supervised_intake_events_actor_kind_check CHECK (actor_kind IN ('service_role_system', 'operator_asserted')),
      CONSTRAINT supervised_intake_events_actor_pairing CHECK (
        actor_kind = 'service_role_system' AND actor_reference IS NULL OR
        actor_kind = 'operator_asserted' AND actor_reference IS NOT NULL
      ),
      CONSTRAINT supervised_intake_events_scope_pairing CHECK (
        (event_kind LIKE 'batch\_%' AND item_id IS NULL AND attempt_id IS NULL) OR
        (event_kind LIKE 'item\_%' AND item_id IS NOT NULL) OR
        (event_kind LIKE 'attempt\_%' AND attempt_id IS NOT NULL AND item_id IS NOT NULL)
      )
    );

    ALTER TABLE public.supervised_intake_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.supervised_intake_events FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.supervised_intake_events TO service_role;

    RAISE NOTICE '079: supervised_intake_events created.';
  ELSE
    RAISE NOTICE '079: supervised_intake_events already exists -- VALIDATE branch (no DDL/DCL will run).';
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'supervised_intake_events'
        AND cl.relrowsecurity = true AND cl.relforcerowsecurity = true
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_events RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'supervised_intake_events'
        AND (grantee IN ('anon', 'authenticated', 'PUBLIC') OR (grantee = 'service_role' AND privilege_type <> 'SELECT'))
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_events grant set is not exactly service_role SELECT-only';
    END IF;
    RAISE NOTICE '079: supervised_intake_events already exists and matches exactly -- no-op.';
  END IF;
END $$;

-- ===========================================================================
-- 7. supervised_intake_idempotency_ledger -- one row per real (non-replay)
--    invocation of any of the 12 mutating RPCs below.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'supervised_intake_idempotency_ledger') THEN
    RAISE NOTICE '079: supervised_intake_idempotency_ledger does not exist -- CREATE branch.';

    CREATE TABLE public.supervised_intake_idempotency_ledger (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      entity_id UUID,
      replay_result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      CONSTRAINT supervised_intake_idempotency_ledger_operation_check CHECK (operation IN (
        'configure_control', 'create_batch', 'claim_item', 'begin_attempt_call', 'complete_item', 'fail_item',
        'stop_batch', 'cancel_batch', 'reconcile_stale', 'resolve_reconciliation',
        'authorize_retry', 'finalize_batch'
      )),
      CONSTRAINT supervised_intake_idempotency_ledger_digest_format CHECK (request_digest ~ '^[0-9a-f]{64}$')
    );

    ALTER TABLE public.supervised_intake_idempotency_ledger ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.supervised_intake_idempotency_ledger FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.supervised_intake_idempotency_ledger TO service_role;

    RAISE NOTICE '079: supervised_intake_idempotency_ledger created.';
  ELSE
    RAISE NOTICE '079: supervised_intake_idempotency_ledger already exists -- VALIDATE branch (no DDL/DCL will run).';
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'supervised_intake_idempotency_ledger'
        AND cl.relrowsecurity = true AND cl.relforcerowsecurity = true
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_idempotency_ledger RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'supervised_intake_idempotency_ledger'
        AND (grantee IN ('anon', 'authenticated', 'PUBLIC') OR (grantee = 'service_role' AND privilege_type <> 'SELECT'))
    ) THEN
      RAISE EXCEPTION '079 drift: supervised_intake_idempotency_ledger grant set is not exactly service_role SELECT-only';
    END IF;
    RAISE NOTICE '079: supervised_intake_idempotency_ledger already exists and matches exactly -- no-op.';
  END IF;
END $$;

-- ===========================================================================
-- RPC 1/12: configure_supervised_intake_control
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'configure_supervised_intake_control';
  IF v_hash IS NOT NULL AND v_hash <> 'a76c11f595af783ea3cfe5ffc9bbbce9' THEN
    RAISE EXCEPTION '079 CRITICAL: configure_supervised_intake_control body hash changed (got %, expected a76c11f595af783ea3cfe5ffc9bbbce9) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: configure_supervised_intake_control does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: configure_supervised_intake_control already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.configure_supervised_intake_control(
  p_enabled BOOLEAN,
  p_max_batch_items INTEGER,
  p_max_daily_claimed_items INTEGER,
  p_claim_lease_seconds INTEGER,
  p_operator_reference TEXT,
  p_reason_code TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $rpc$
DECLARE
  v_request_digest TEXT;
  v_ledger RECORD;
  v_previous RECORD;
  v_previous_digest TEXT;
  v_new_digest TEXT;
BEGIN
  IF p_operator_reference !~ '^[A-Za-z0-9._@-]{3,64}$' THEN
    RAISE EXCEPTION 'configure_supervised_intake_control: INVALID_OPERATOR_REFERENCE' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason_code NOT IN ('INITIAL_SETUP','ENABLE_FOR_CANARY','DISABLE_KILL_SWITCH','LIMIT_ADJUSTMENT','LEASE_ADJUSTMENT') THEN
    RAISE EXCEPTION 'configure_supervised_intake_control: INVALID_REASON_CODE' USING ERRCODE = 'P0001';
  END IF;
  IF p_claim_lease_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'configure_supervised_intake_control: LEASE_SECONDS_OUT_OF_BOUNDS' USING ERRCODE = 'P0001';
  END IF;
  IF p_max_batch_items < 0 OR p_max_daily_claimed_items < 0 THEN
    RAISE EXCEPTION 'configure_supervised_intake_control: NEGATIVE_LIMIT' USING ERRCODE = 'P0001';
  END IF;

  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"enabled":%s,"max_batch_items":%s,"max_daily_claimed_items":%s,"claim_lease_seconds":%s,"operator_reference":%s,"reason_code":%s}',
      to_json('willviral.semantic-topic.supervised-intake-control:v1'::text)::text, to_json(p_enabled)::text, to_json(p_max_batch_items)::text,
      to_json(p_max_daily_claimed_items)::text, to_json(p_claim_lease_seconds)::text, to_json(p_operator_reference)::text, to_json(p_reason_code)::text
    ), 'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'configure_supervised_intake_control: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;
  INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'configure_control', v_request_digest);

  SELECT * INTO v_previous FROM public.supervised_intake_control WHERE id = 1 FOR UPDATE;

  v_previous_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"enabled":%s,"max_batch_items":%s,"max_daily_claimed_items":%s,"claim_lease_seconds":%s}',
      to_json(v_previous.enabled)::text, to_json(v_previous.max_batch_items)::text,
      to_json(v_previous.max_daily_claimed_items)::text, to_json(v_previous.claim_lease_seconds)::text
    ), 'UTF8')), 'hex');
  v_new_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"enabled":%s,"max_batch_items":%s,"max_daily_claimed_items":%s,"claim_lease_seconds":%s}',
      to_json(p_enabled)::text, to_json(p_max_batch_items)::text,
      to_json(p_max_daily_claimed_items)::text, to_json(p_claim_lease_seconds)::text
    ), 'UTF8')), 'hex');

  UPDATE public.supervised_intake_control
    SET enabled = p_enabled, max_batch_items = p_max_batch_items,
        max_daily_claimed_items = p_max_daily_claimed_items, claim_lease_seconds = p_claim_lease_seconds,
        updated_at = now()
    WHERE id = 1;

  INSERT INTO public.supervised_intake_control_events (
    event_kind, reason_code, operator_reference, previous_config_digest, new_config_digest, idempotency_key
  ) VALUES ('control_updated', p_reason_code, p_operator_reference, v_previous_digest, v_new_digest, p_idempotency_key);

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'previous_config_digest', v_previous_digest, 'new_config_digest', v_new_digest),
        completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'previous_config_digest', v_previous_digest, 'new_config_digest', v_new_digest);
END;
$rpc$;

REVOKE ALL ON FUNCTION public.configure_supervised_intake_control(BOOLEAN, INTEGER, INTEGER, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.configure_supervised_intake_control(BOOLEAN, INTEGER, INTEGER, INTEGER, TEXT, TEXT, TEXT) TO service_role;

-- ===========================================================================
-- RPC 2/12: create_supervised_intake_batch
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_supervised_intake_batch';
  IF v_hash IS NOT NULL AND v_hash <> '2e2905559389f64b54b7441b71b52ca5' THEN
    RAISE EXCEPTION '079 CRITICAL: create_supervised_intake_batch body hash changed (got %, expected 2e2905559389f64b54b7441b71b52ca5) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: create_supervised_intake_batch does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: create_supervised_intake_batch already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.create_supervised_intake_batch(
  p_evidence_ids UUID[],
  p_operator_reference TEXT,
  p_provider TEXT,
  p_usage_type TEXT,
  p_model TEXT,
  p_normalization_version INTEGER,
  p_extraction_schema_version INTEGER,
  p_prompt_version TEXT,
  p_deterministic_extractor_version INTEGER,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $rpc$
DECLARE
  v_config_digest TEXT;
  v_request_digest TEXT;
  v_ledger RECORD;
  v_control RECORD;
  v_batch_id UUID;
  v_evidence_id UUID;
  v_sorted_ids UUID[];
  v_blocked_ids UUID[];
  v_dup_count INTEGER;
BEGIN
  IF p_operator_reference !~ '^[A-Za-z0-9._@-]{3,64}$' THEN
    RAISE EXCEPTION 'create_supervised_intake_batch: INVALID_OPERATOR_REFERENCE' USING ERRCODE = 'P0001';
  END IF;
  IF p_evidence_ids IS NULL OR array_length(p_evidence_ids, 1) IS NULL OR array_length(p_evidence_ids, 1) < 1 THEN
    RAISE EXCEPTION 'create_supervised_intake_batch: EMPTY_EVIDENCE_LIST' USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(DISTINCT e) INTO v_sorted_ids FROM unnest(p_evidence_ids) AS e;
  SELECT count(*) INTO v_dup_count FROM unnest(p_evidence_ids) AS e;
  IF array_length(v_sorted_ids, 1) <> v_dup_count THEN
    RAISE EXCEPTION 'create_supervised_intake_batch: DUPLICATE_EVIDENCE_IN_REQUEST' USING ERRCODE = 'P0001';
  END IF;
  SELECT array_agg(e ORDER BY e) INTO v_sorted_ids FROM unnest(p_evidence_ids) AS e;

  -- Config digest computed the IDENTICAL way reserve_ai_provider_units (075)
  -- computes it -- byte-identical to what each item's later real reservation
  -- attempt will independently recompute, never a separately invented formula.
  v_config_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format(
      '{"extraction_method":%s,"normalization_version":%s,"extraction_schema_version":%s,"provider":%s,"model":%s,"prompt_version":%s,"deterministic_extractor_version":%s}',
      to_json('ai_assisted'::text)::text,
      coalesce(to_json(p_normalization_version)::text, 'null'),
      coalesce(to_json(p_extraction_schema_version)::text, 'null'),
      to_json(p_provider)::text,
      to_json(p_model)::text,
      coalesce(to_json(p_prompt_version)::text, 'null'),
      coalesce(to_json(p_deterministic_extractor_version)::text, 'null')
    ), 'UTF8')), 'hex');

  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"evidence_ids":%s,"operator_reference":%s,"extraction_config_digest":%s}',
      to_json('willviral.semantic-topic.supervised-intake-batch:v1'::text)::text,
      to_json(v_sorted_ids)::text, to_json(p_operator_reference)::text, to_json(v_config_digest)::text
    ), 'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'create_supervised_intake_batch: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;
  INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'create_batch', v_request_digest);

  SELECT * INTO v_control FROM public.supervised_intake_control WHERE id = 1 FOR UPDATE;
  IF v_control.enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'create_supervised_intake_batch: INTAKE_POLICY_DISABLED' USING ERRCODE = 'P0001';
  END IF;
  IF array_length(v_sorted_ids, 1) > v_control.max_batch_items THEN
    RAISE EXCEPTION 'create_supervised_intake_batch: BATCH_SIZE_EXCEEDS_LIMIT -- % requested, % allowed', array_length(v_sorted_ids, 1), v_control.max_batch_items USING ERRCODE = 'P0001';
  END IF;

  -- Preflight, whole-batch-atomic dedup check: rather than let a raw unique-
  -- constraint violation surface mid-insert-loop (which would still roll
  -- back cleanly, but with an unstructured Postgres error instead of a
  -- clean reason_code), reject the ENTIRE batch request up front and name
  -- every already-blocked evidence id, so the operator can correct the
  -- request and retry -- no partial batches are ever created.
  SELECT array_agg(DISTINCT bi.signal_evidence_id) INTO v_blocked_ids
    FROM public.supervised_intake_batch_items bi
    WHERE bi.signal_evidence_id = ANY(v_sorted_ids)
      AND bi.extraction_config_digest = v_config_digest
      AND (bi.status IN ('pending', 'claimed', 'succeeded', 'reconciliation_required') OR (bi.status = 'failed' AND bi.retryable IS TRUE));
  IF v_blocked_ids IS NOT NULL AND array_length(v_blocked_ids, 1) > 0 THEN
    RAISE EXCEPTION 'create_supervised_intake_batch: EVIDENCE_ALREADY_ACTIVE_ELSEWHERE -- blocked evidence ids: %', v_blocked_ids USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.supervised_intake_batches (
    status, requested_evidence_count, operator_reference, idempotency_key, request_digest, extraction_config_digest
  ) VALUES (
    'batch_created', array_length(v_sorted_ids, 1), p_operator_reference, p_idempotency_key, v_request_digest, v_config_digest
  ) RETURNING id INTO v_batch_id;

  FOREACH v_evidence_id IN ARRAY v_sorted_ids LOOP
    INSERT INTO public.supervised_intake_batch_items (batch_id, signal_evidence_id, extraction_config_digest, status)
      VALUES (v_batch_id, v_evidence_id, v_config_digest, 'pending');
  END LOOP;

  INSERT INTO public.supervised_intake_events (batch_id, event_kind, resulting_status, actor_kind, actor_reference, request_digest)
    VALUES (v_batch_id, 'batch_created', 'batch_created', 'operator_asserted', p_operator_reference, v_request_digest);

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'batch_id', v_batch_id, 'status', 'batch_created', 'extraction_config_digest', v_config_digest),
        entity_id = v_batch_id, completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'batch_id', v_batch_id, 'status', 'batch_created', 'extraction_config_digest', v_config_digest);
END;
$rpc$;

REVOKE ALL ON FUNCTION public.create_supervised_intake_batch(UUID[], TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_supervised_intake_batch(UUID[], TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT) TO service_role;

-- ===========================================================================
-- RPC 3/12: claim_next_intake_item
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'claim_next_intake_item';
  IF v_hash IS NOT NULL AND v_hash <> '29034537befec0b1c4fa7a5bb720988a' THEN
    RAISE EXCEPTION '079 CRITICAL: claim_next_intake_item body hash changed (got %, expected 29034537befec0b1c4fa7a5bb720988a) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: claim_next_intake_item does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: claim_next_intake_item already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

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
BEGIN
  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"batch_id":%s}', to_json('willviral.semantic-topic.supervised-intake-claim:v1'::text)::text, to_json(p_batch_id::text)::text),
    'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'claim_next_intake_item: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    -- A claim replay NEVER claims a new item and NEVER consumes new daily
    -- capacity -- it returns the cached result, which for a claim RPC
    -- deliberately omits the plaintext fencing token (it was never stored).
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
    -- The 'stopped' status_fields CHECK requires started_at IS NOT NULL --
    -- this can fire while the batch is still 'batch_created' (never ran),
    -- so started_at must be backfilled here, not only on the normal
    -- batch_created -> running path further below.
    UPDATE public.supervised_intake_batches SET status = 'stopped', reason_code = 'INTAKE_POLICY_DISABLED', started_at = coalesce(started_at, now()) WHERE id = p_batch_id AND status IN ('batch_created','running');
    INSERT INTO public.supervised_intake_events (batch_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
      VALUES (p_batch_id, 'batch_stopped', v_batch.status, 'stopped', 'INTAKE_POLICY_DISABLED', 'service_role_system');
    UPDATE public.supervised_intake_idempotency_ledger SET replay_result = jsonb_build_object('ok', true, 'outcome', 'batch_stopped', 'reason_code', 'INTAKE_POLICY_DISABLED'), completed_at = now() WHERE idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('ok', true, 'outcome', 'batch_stopped', 'reason_code', 'INTAKE_POLICY_DISABLED');
  END IF;

  IF v_batch.status NOT IN ('batch_created', 'running') THEN
    RAISE EXCEPTION 'claim_next_intake_item: BATCH_NOT_CLAIMABLE -- status=%', v_batch.status USING ERRCODE = 'P0001';
  END IF;

  -- Daily limit: counts IMMUTABLE attempt rows created today (UTC), under
  -- the control-singleton lock already held above -- this serializes ALL
  -- claims system-wide for the duration of this check+claim, which is what
  -- makes the count race-free across two concurrent OS processes/batches.
  SELECT count(*) INTO v_daily_count FROM public.supervised_intake_attempts
    WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF v_daily_count >= v_control.max_daily_claimed_items THEN
    UPDATE public.supervised_intake_batches SET status = 'stopped', reason_code = 'DAILY_LIMIT_REACHED', started_at = coalesce(started_at, now()) WHERE id = p_batch_id AND status IN ('batch_created','running');
    INSERT INTO public.supervised_intake_events (batch_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
      VALUES (p_batch_id, 'batch_stopped', v_batch.status, 'stopped', 'DAILY_LIMIT_REACHED', 'service_role_system');
    UPDATE public.supervised_intake_idempotency_ledger SET replay_result = jsonb_build_object('ok', true, 'outcome', 'batch_stopped', 'reason_code', 'DAILY_LIMIT_REACHED'), completed_at = now() WHERE idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('ok', true, 'outcome', 'batch_stopped', 'reason_code', 'DAILY_LIMIT_REACHED');
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

    -- Global lock order step 3: the evidence itself, serializing concurrent
    -- claims across DIFFERENT batches for the same evidence.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_item.signal_evidence_id::text, 40));

    -- Already-assigned preflight runs BEFORE the cache-hit check: an
    -- assignment decision is the more final, more informative terminal
    -- state (human review already resolved this evidence) -- if BOTH a
    -- completed extraction and a decision exist for this evidence, the
    -- operator needs to see ALREADY_ASSIGNED, not the weaker ALREADY_EXTRACTED.
    -- Mirrors 078's own ALREADY_ASSIGNED check.
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

    -- Cache-hit preflight: a completed extraction already exists for this
    -- evidence (no assignment decision yet) -- no new provider call is ever
    -- warranted.
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

    -- Found a genuinely claimable item -- generate the DB-side fencing token.
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_token_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8')), 'hex');
    v_lease_expires := now() + make_interval(secs => v_control.claim_lease_seconds);

    -- The item's own status_fields CHECK requires current_attempt_id NOT
    -- NULL whenever status='claimed' -- so the attempt row (whose own FK
    -- needs the item's id, which already exists) must be INSERTed first,
    -- and the item's status/current_attempt_id transition must land in a
    -- SINGLE UPDATE, never two separate ones that would transiently violate
    -- the constraint between them.
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

-- ===========================================================================
-- RPC 4/12: begin_intake_attempt_call -- prepared -> calling, BEFORE the
-- runner ever invokes runShadowExtraction(). No provider call happens here.
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'begin_intake_attempt_call';
  IF v_hash IS NOT NULL AND v_hash <> 'eca67e6f1c442bf496ed2cf09664e3b6' THEN
    RAISE EXCEPTION '079 CRITICAL: begin_intake_attempt_call body hash changed (got %, expected eca67e6f1c442bf496ed2cf09664e3b6) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: begin_intake_attempt_call does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: begin_intake_attempt_call already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.begin_intake_attempt_call(
  p_item_id UUID,
  p_claim_token TEXT,
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
  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"item_id":%s}', to_json('willviral.semantic-topic.supervised-intake-begin-call:v1'::text)::text, to_json(p_item_id::text)::text),
    'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'begin_intake_attempt_call: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;
  INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'begin_attempt_call', v_request_digest);

  SELECT * INTO v_item FROM public.supervised_intake_batch_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'begin_intake_attempt_call: ITEM_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_supplied_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token, 'UTF8')), 'hex');
  IF v_item.status <> 'claimed' OR v_item.token_digest IS DISTINCT FROM v_supplied_digest THEN
    RAISE EXCEPTION 'begin_intake_attempt_call: CLAIM_TOKEN_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_attempt FROM public.supervised_intake_attempts WHERE id = v_item.current_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.status <> 'prepared' THEN
    RAISE EXCEPTION 'begin_intake_attempt_call: ATTEMPT_NOT_PREPARED -- status=%', COALESCE(v_attempt.status, 'missing') USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.supervised_intake_attempts SET status = 'calling', provider_call_started_at = now() WHERE id = v_attempt.id;

  INSERT INTO public.supervised_intake_events (batch_id, item_id, attempt_id, event_kind, previous_status, resulting_status, actor_kind)
    VALUES (v_item.batch_id, v_item.id, v_attempt.id, 'attempt_calling', 'prepared', 'calling', 'service_role_system');

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'attempt_id', v_attempt.id, 'base_idempotency_key', v_attempt.base_idempotency_key, 'status', 'calling'),
        entity_id = v_attempt.id, completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'attempt_id', v_attempt.id, 'base_idempotency_key', v_attempt.base_idempotency_key, 'status', 'calling');
END;
$rpc$;

REVOKE ALL ON FUNCTION public.begin_intake_attempt_call(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_intake_attempt_call(UUID, TEXT, TEXT) TO service_role;

-- ===========================================================================
-- RPC 5/12: complete_intake_item_success
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'complete_intake_item_success';
  IF v_hash IS NOT NULL AND v_hash <> '2b3282629c0c796eeec16b1496f80e92' THEN
    RAISE EXCEPTION '079 CRITICAL: complete_intake_item_success body hash changed (got %, expected 2b3282629c0c796eeec16b1496f80e92) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: complete_intake_item_success does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: complete_intake_item_success already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.complete_intake_item_success(
  p_item_id UUID,
  p_claim_token TEXT,
  p_provider_reservation_id UUID,
  p_extraction_run_id UUID,
  p_review_request_id UUID,
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
  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"item_id":%s,"extraction_run_id":%s,"review_request_id":%s}',
      to_json('willviral.semantic-topic.supervised-intake-complete:v1'::text)::text, to_json(p_item_id::text)::text,
      to_json(p_extraction_run_id::text)::text, coalesce(to_json(p_review_request_id::text)::text, 'null')),
    'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'complete_intake_item_success: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;
  INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'complete_item', v_request_digest);

  SELECT * INTO v_item FROM public.supervised_intake_batch_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'complete_intake_item_success: ITEM_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_supplied_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token, 'UTF8')), 'hex');
  IF v_item.status <> 'claimed' OR v_item.token_digest IS DISTINCT FROM v_supplied_digest THEN
    RAISE EXCEPTION 'complete_intake_item_success: CLAIM_TOKEN_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF v_item.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'complete_intake_item_success: STALE_CLAIM_ALREADY_RECONCILED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_attempt FROM public.supervised_intake_attempts WHERE id = v_item.current_attempt_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.topic_extraction_runs t WHERE t.id = p_extraction_run_id AND t.signal_evidence_id = v_item.signal_evidence_id) THEN
    RAISE EXCEPTION 'complete_intake_item_success: EXTRACTION_RUN_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.supervised_intake_attempts
    SET status = 'completed', provider_reservation_id = p_provider_reservation_id, extraction_run_id = p_extraction_run_id, finished_at = now()
    WHERE id = v_attempt.id;

  UPDATE public.supervised_intake_batch_items
    SET status = 'succeeded', extraction_run_id = p_extraction_run_id, review_request_id = p_review_request_id, updated_at = now()
    WHERE id = v_item.id;

  INSERT INTO public.supervised_intake_events (batch_id, item_id, attempt_id, event_kind, previous_status, resulting_status, actor_kind, extraction_run_id, review_request_id)
    VALUES (v_item.batch_id, v_item.id, v_attempt.id, 'attempt_completed', 'calling', 'completed', 'service_role_system', p_extraction_run_id, p_review_request_id);
  INSERT INTO public.supervised_intake_events (batch_id, item_id, event_kind, previous_status, resulting_status, actor_kind, extraction_run_id, review_request_id)
    VALUES (v_item.batch_id, v_item.id, 'item_succeeded', 'claimed', 'succeeded', 'service_role_system', p_extraction_run_id, p_review_request_id);

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'item_id', v_item.id, 'status', 'succeeded'),
        entity_id = v_item.id, completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'item_id', v_item.id, 'status', 'succeeded');
END;
$rpc$;

REVOKE ALL ON FUNCTION public.complete_intake_item_success(UUID, TEXT, UUID, UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_intake_item_success(UUID, TEXT, UUID, UUID, UUID, TEXT) TO service_role;

-- ===========================================================================
-- RPC 6/12: fail_intake_item
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fail_intake_item';
  IF v_hash IS NOT NULL AND v_hash <> '8648193e6cc43edae02dc62c736efca5' THEN
    RAISE EXCEPTION '079 CRITICAL: fail_intake_item body hash changed (got %, expected 8648193e6cc43edae02dc62c736efca5) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: fail_intake_item does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: fail_intake_item already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

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
    'NOT_SPECIFIC', 'CONFIDENCE_NOT_REVIEW_ELIGIBLE', 'NO_SUPPORTING_SPANS', 'INVALID_EVIDENCE_STATE'
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

-- ===========================================================================
-- RPC 7/12: stop_intake_batch -- batch-fatal, system-initiated. Closes any
-- still-'pending' items into a terminal, provider-call-free status so no
-- row is ever left forever-reserving an evidence+config slot.
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'stop_intake_batch';
  IF v_hash IS NOT NULL AND v_hash <> '16df20786c5cf34c528cfb55b1bf7f57' THEN
    RAISE EXCEPTION '079 CRITICAL: stop_intake_batch body hash changed (got %, expected 16df20786c5cf34c528cfb55b1bf7f57) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: stop_intake_batch does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: stop_intake_batch already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

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

  WITH closed AS (
    UPDATE public.supervised_intake_batch_items
      SET status = 'unprocessed_batch_closed',
          reason_code = CASE WHEN p_reason_code IN ('AI_EXTRACTION_DISABLED','BUDGET_EXHAUSTED','AUTHORIZATION_OR_CONFIG_ERROR','INTAKE_POLICY_DISABLED','DAILY_LIMIT_REACHED') THEN 'BATCH_STOPPED' ELSE 'BATCH_STOPPED' END,
          updated_at = now()
      WHERE batch_id = p_batch_id AND status = 'pending'
      RETURNING id
  )
  SELECT count(*) INTO v_closed_count FROM closed;

  -- Unlike 'cancelled', both 'stopped' and 'reconciliation_pending' REQUIRE
  -- started_at IS NOT NULL per the status_fields CHECK -- must be backfilled
  -- here since this can fire on a batch that never left 'batch_created'.
  UPDATE public.supervised_intake_batches
    SET status = CASE WHEN p_reason_code = 'PROVIDER_OUTCOME_UNCERTAIN' THEN 'reconciliation_pending' ELSE 'stopped' END,
        reason_code = p_reason_code, started_at = COALESCE(started_at, now())
    WHERE id = p_batch_id;

  INSERT INTO public.supervised_intake_events (batch_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
    VALUES (p_batch_id, 'batch_stopped', v_batch.status, CASE WHEN p_reason_code = 'PROVIDER_OUTCOME_UNCERTAIN' THEN 'reconciliation_pending' ELSE 'stopped' END, p_reason_code, 'service_role_system');

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'closed_pending_items', v_closed_count),
        entity_id = p_batch_id, completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'closed_pending_items', v_closed_count);
END;
$rpc$;

REVOKE ALL ON FUNCTION public.stop_intake_batch(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stop_intake_batch(UUID, TEXT, TEXT) TO service_role;

-- ===========================================================================
-- RPC 8/12: cancel_intake_batch -- operator-initiated, only from
-- batch_created/running, same still-pending-items closure as stop.
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'cancel_intake_batch';
  IF v_hash IS NOT NULL AND v_hash <> '37660c09e977df2755677ff0ec079194' THEN
    RAISE EXCEPTION '079 CRITICAL: cancel_intake_batch body hash changed (got %, expected 37660c09e977df2755677ff0ec079194) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: cancel_intake_batch does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: cancel_intake_batch already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.cancel_intake_batch(
  p_batch_id UUID,
  p_operator_reference TEXT,
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
  IF p_operator_reference !~ '^[A-Za-z0-9._@-]{3,64}$' THEN
    RAISE EXCEPTION 'cancel_intake_batch: INVALID_OPERATOR_REFERENCE' USING ERRCODE = 'P0001';
  END IF;

  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"batch_id":%s,"operator_reference":%s,"reason_code":%s}',
      to_json('willviral.semantic-topic.supervised-intake-cancel:v1'::text)::text, to_json(p_batch_id::text)::text,
      to_json(p_operator_reference)::text, to_json(p_reason_code)::text),
    'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'cancel_intake_batch: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;
  INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'cancel_batch', v_request_digest);

  SELECT * INTO v_batch FROM public.supervised_intake_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cancel_intake_batch: BATCH_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_batch.status NOT IN ('batch_created', 'running') THEN
    RAISE EXCEPTION 'cancel_intake_batch: BATCH_NOT_CANCELLABLE -- status=%', v_batch.status USING ERRCODE = 'P0001';
  END IF;
  IF v_batch.operator_reference <> p_operator_reference THEN
    RAISE EXCEPTION 'cancel_intake_batch: OPERATOR_MISMATCH -- only the creating operator may cancel a v0 batch' USING ERRCODE = 'P0001';
  END IF;

  WITH closed AS (
    UPDATE public.supervised_intake_batch_items
      SET status = 'unprocessed_batch_closed', reason_code = 'BATCH_CANCELLED', updated_at = now()
      WHERE batch_id = p_batch_id AND status = 'pending'
      RETURNING id
  )
  SELECT count(*) INTO v_closed_count FROM closed;

  -- Deliberately does NOT backfill started_at: a batch cancelled while still
  -- 'batch_created' never actually began claiming, and the status_fields
  -- CHECK allows 'cancelled' with started_at IS NULL precisely so this stays
  -- an honest, never-started record rather than a fabricated start time.
  UPDATE public.supervised_intake_batches
    SET status = 'cancelled', reason_code = p_reason_code, finished_at = now()
    WHERE id = p_batch_id;

  INSERT INTO public.supervised_intake_events (batch_id, event_kind, previous_status, resulting_status, reason_code, actor_kind, actor_reference)
    VALUES (p_batch_id, 'batch_cancelled', v_batch.status, 'cancelled', p_reason_code, 'operator_asserted', p_operator_reference);

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'closed_pending_items', v_closed_count),
        entity_id = p_batch_id, completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'closed_pending_items', v_closed_count);
END;
$rpc$;

REVOKE ALL ON FUNCTION public.cancel_intake_batch(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_intake_batch(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ===========================================================================
-- RPC 9/12: reconcile_stale_intake_claims -- NO caller-supplied staleness
-- parameter; lease_expires_at < now() is the sole criterion. Never restores
-- 'pending' (which would allow an automatic retry) -- always
-- 'reconciliation_required'.
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reconcile_stale_intake_claims';
  IF v_hash IS NOT NULL AND v_hash <> 'fb99c42efa362530c0b5891e6e237f45' THEN
    RAISE EXCEPTION '079 CRITICAL: reconcile_stale_intake_claims body hash changed (got %, expected fb99c42efa362530c0b5891e6e237f45) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: reconcile_stale_intake_claims does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: reconcile_stale_intake_claims already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_intake_claims(
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $rpc$
DECLARE
  v_request_digest TEXT;
  v_ledger RECORD;
  v_item RECORD;
  v_reconciled_count INTEGER := 0;
BEGIN
  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"marker":%s}', to_json('willviral.semantic-topic.supervised-intake-reconcile-stale:v1'::text)::text, to_json(p_idempotency_key)::text),
    'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'reconcile_stale_intake_claims: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;
  INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'reconcile_stale', v_request_digest);

  FOR v_item IN
    SELECT * FROM public.supervised_intake_batch_items
      WHERE status = 'claimed' AND lease_expires_at < now()
      FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.supervised_intake_batch_items SET status = 'reconciliation_required', updated_at = now() WHERE id = v_item.id;
    UPDATE public.supervised_intake_attempts SET status = 'reconciliation_required' WHERE id = v_item.current_attempt_id AND status IN ('prepared', 'calling');

    INSERT INTO public.supervised_intake_events (batch_id, item_id, attempt_id, event_kind, previous_status, resulting_status, reason_code, actor_kind)
      VALUES (v_item.batch_id, v_item.id, v_item.current_attempt_id, 'item_stale_reconciliation_required', 'claimed', 'reconciliation_required', 'STALE_CLAIM_RECONCILIATION_REQUIRED', 'service_role_system');

    v_reconciled_count := v_reconciled_count + 1;
  END LOOP;

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'reconciled_count', v_reconciled_count), completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'reconciled_count', v_reconciled_count);
END;
$rpc$;

REVOKE ALL ON FUNCTION public.reconcile_stale_intake_claims(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_intake_claims(TEXT) TO service_role;

-- ===========================================================================
-- RPC 10/12: resolve_intake_attempt_reconciliation -- the resolution is
-- evidence-derived, NEVER a bare caller assertion: the RPC itself looks up
-- ai_provider_budget_reservations by the attempt's own base_idempotency_key
-- (":quota" / ":extraction-run" namespaced) and rejects any p_resolution
-- inconsistent with what it actually finds.
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_intake_attempt_reconciliation';
  IF v_hash IS NOT NULL AND v_hash <> '5603b605abdfb671784f2ac9d3abed29' THEN
    RAISE EXCEPTION '079 CRITICAL: resolve_intake_attempt_reconciliation body hash changed (got %, expected 5603b605abdfb671784f2ac9d3abed29) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: resolve_intake_attempt_reconciliation does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: resolve_intake_attempt_reconciliation already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_intake_attempt_reconciliation(
  p_attempt_id UUID,
  p_operator_reference TEXT,
  p_resolution TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $rpc$
DECLARE
  v_request_digest TEXT;
  v_ledger RECORD;
  v_attempt RECORD;
  v_item RECORD;
  v_reservation RECORD;
  v_extraction_run_id UUID;
  v_evidence_derived_resolution TEXT;
BEGIN
  IF p_operator_reference !~ '^[A-Za-z0-9._@-]{3,64}$' THEN
    RAISE EXCEPTION 'resolve_intake_attempt_reconciliation: INVALID_OPERATOR_REFERENCE' USING ERRCODE = 'P0001';
  END IF;
  IF p_resolution NOT IN ('CONFIRMED_COMPLETED', 'CONFIRMED_NOT_STARTED_OR_NOT_CHARGED', 'CONFIRMED_FAILED_CHARGED', 'STILL_UNKNOWN') THEN
    RAISE EXCEPTION 'resolve_intake_attempt_reconciliation: INVALID_RESOLUTION' USING ERRCODE = 'P0001';
  END IF;

  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"attempt_id":%s,"operator_reference":%s,"resolution":%s}',
      to_json('willviral.semantic-topic.supervised-intake-resolve-reconciliation:v1'::text)::text, to_json(p_attempt_id::text)::text,
      to_json(p_operator_reference)::text, to_json(p_resolution)::text),
    'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'resolve_intake_attempt_reconciliation: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;
  INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'resolve_reconciliation', v_request_digest);

  SELECT * INTO v_attempt FROM public.supervised_intake_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_intake_attempt_reconciliation: ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.status <> 'reconciliation_required' THEN
    RAISE EXCEPTION 'resolve_intake_attempt_reconciliation: NOT_IN_RECONCILIATION -- status=%', v_attempt.status USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_item FROM public.supervised_intake_batch_items WHERE id = v_attempt.batch_item_id FOR UPDATE;

  -- Evidence-derived lookup: exact idempotency key + evidence + config +
  -- provider/model via the (evidence, normalized_digest, extraction_config_digest)
  -- index -- never "the latest/current daily budget row".
  SELECT r.* INTO v_reservation
    FROM public.ai_provider_budget_reservations r
    WHERE r.idempotency_key = v_attempt.base_idempotency_key || ':quota'
      AND r.signal_evidence_id = v_item.signal_evidence_id
      AND r.extraction_config_digest = v_item.extraction_config_digest;

  IF NOT FOUND THEN
    v_evidence_derived_resolution := 'CONFIRMED_NOT_STARTED_OR_NOT_CHARGED';
  ELSIF v_reservation.status = 'released' THEN
    v_evidence_derived_resolution := 'CONFIRMED_NOT_STARTED_OR_NOT_CHARGED';
  ELSIF v_reservation.status = 'reserved' AND v_reservation.attempt_started_at IS NULL THEN
    v_evidence_derived_resolution := 'CONFIRMED_NOT_STARTED_OR_NOT_CHARGED';
  ELSIF v_reservation.status = 'reserved' AND v_reservation.attempt_started_at IS NOT NULL THEN
    v_evidence_derived_resolution := 'STILL_UNKNOWN';
  ELSIF v_reservation.status = 'committed' AND v_reservation.application_outcome = 'completed' THEN
    v_evidence_derived_resolution := 'CONFIRMED_COMPLETED';
    SELECT t.id INTO v_extraction_run_id FROM public.topic_extraction_runs t
      WHERE t.idempotency_key = v_attempt.base_idempotency_key || ':extraction-run';
    IF v_extraction_run_id IS NULL THEN
      v_evidence_derived_resolution := 'STILL_UNKNOWN'; -- reservation says completed but the extraction run row itself can't be found -- fail-closed, never assume.
    END IF;
  ELSIF v_reservation.status = 'committed' AND v_reservation.application_outcome = 'failed' THEN
    v_evidence_derived_resolution := 'CONFIRMED_FAILED_CHARGED';
  ELSIF v_reservation.status = 'committed_unknown' THEN
    v_evidence_derived_resolution := 'STILL_UNKNOWN';
  ELSE
    v_evidence_derived_resolution := 'STILL_UNKNOWN';
  END IF;

  IF p_resolution <> v_evidence_derived_resolution THEN
    RAISE EXCEPTION 'resolve_intake_attempt_reconciliation: RESOLUTION_NOT_SUPPORTED_BY_EVIDENCE -- claimed %, evidence supports %', p_resolution, v_evidence_derived_resolution USING ERRCODE = 'P0001';
  END IF;

  IF p_resolution = 'CONFIRMED_COMPLETED' THEN
    UPDATE public.supervised_intake_attempts SET status = 'completed', extraction_run_id = v_extraction_run_id, provider_reservation_id = v_reservation.id, finished_at = now() WHERE id = v_attempt.id;
    UPDATE public.supervised_intake_batch_items SET status = 'succeeded', extraction_run_id = v_extraction_run_id, updated_at = now() WHERE id = v_item.id;
  ELSIF p_resolution = 'CONFIRMED_NOT_STARTED_OR_NOT_CHARGED' THEN
    UPDATE public.supervised_intake_attempts SET status = 'failed_retryable', reason_code = 'RECONCILED_NOT_CHARGED', retryable = true, finished_at = now() WHERE id = v_attempt.id;
    UPDATE public.supervised_intake_batch_items SET status = 'failed', reason_code = 'RECONCILED_NOT_CHARGED', retryable = true, updated_at = now() WHERE id = v_item.id;
  ELSIF p_resolution = 'CONFIRMED_FAILED_CHARGED' THEN
    UPDATE public.supervised_intake_attempts SET status = 'failed_terminal', reason_code = 'RECONCILED_CHARGED_FAILURE', retryable = false, finished_at = now() WHERE id = v_attempt.id;
    UPDATE public.supervised_intake_batch_items SET status = 'failed', reason_code = 'RECONCILED_CHARGED_FAILURE', retryable = false, updated_at = now() WHERE id = v_item.id;
  END IF;
  -- STILL_UNKNOWN: no state change at all, only the audit event below.

  INSERT INTO public.supervised_intake_events (batch_id, item_id, attempt_id, event_kind, previous_status, resulting_status, reason_code, actor_kind, actor_reference, extraction_run_id)
    VALUES (v_item.batch_id, v_item.id, v_attempt.id, 'attempt_reconciliation_resolved', 'reconciliation_required',
            CASE p_resolution WHEN 'CONFIRMED_COMPLETED' THEN 'completed' WHEN 'STILL_UNKNOWN' THEN 'reconciliation_required' ELSE 'failed_retryable_or_terminal' END,
            p_resolution, 'operator_asserted', p_operator_reference, v_extraction_run_id);

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'attempt_id', v_attempt.id, 'resolution', p_resolution),
        entity_id = v_attempt.id, completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'attempt_id', v_attempt.id, 'resolution', p_resolution);
END;
$rpc$;

REVOKE ALL ON FUNCTION public.resolve_intake_attempt_reconciliation(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_intake_attempt_reconciliation(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ===========================================================================
-- RPC 11/12: authorize_intake_item_retry -- ONLY from failed_retryable,
-- never directly from reconciliation_required.
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'authorize_intake_item_retry';
  IF v_hash IS NOT NULL AND v_hash <> '935ba98d0ac2d2f700b90c0152aac0cd' THEN
    RAISE EXCEPTION '079 CRITICAL: authorize_intake_item_retry body hash changed (got %, expected 935ba98d0ac2d2f700b90c0152aac0cd) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: authorize_intake_item_retry does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: authorize_intake_item_retry already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.authorize_intake_item_retry(
  p_item_id UUID,
  p_operator_reference TEXT,
  p_reason_code TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $rpc$
DECLARE
  v_request_digest TEXT;
  v_ledger RECORD;
  v_item RECORD;
  v_attempt RECORD;
BEGIN
  IF p_operator_reference !~ '^[A-Za-z0-9._@-]{3,64}$' THEN
    RAISE EXCEPTION 'authorize_intake_item_retry: INVALID_OPERATOR_REFERENCE' USING ERRCODE = 'P0001';
  END IF;

  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"item_id":%s,"operator_reference":%s,"reason_code":%s}',
      to_json('willviral.semantic-topic.supervised-intake-authorize-retry:v1'::text)::text, to_json(p_item_id::text)::text,
      to_json(p_operator_reference)::text, coalesce(to_json(p_reason_code)::text, 'null')),
    'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'authorize_intake_item_retry: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;
  INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'authorize_retry', v_request_digest);

  SELECT * INTO v_item FROM public.supervised_intake_batch_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authorize_intake_item_retry: ITEM_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_item.status <> 'failed' OR v_item.retryable IS NOT TRUE THEN
    RAISE EXCEPTION 'authorize_intake_item_retry: ITEM_NOT_RETRYABLE -- status=%, retryable=%. reconciliation_required can never be retried directly.', v_item.status, v_item.retryable USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.supervised_intake_batch_items
    SET status = 'pending', token_digest = NULL, claimed_at = NULL, lease_expires_at = NULL,
        current_attempt_id = NULL, reason_code = NULL, retryable = NULL, updated_at = now()
    WHERE id = v_item.id;

  INSERT INTO public.supervised_intake_events (batch_id, item_id, event_kind, previous_status, resulting_status, reason_code, actor_kind, actor_reference)
    VALUES (v_item.batch_id, v_item.id, 'item_retry_authorized', 'failed', 'pending', p_reason_code, 'operator_asserted', p_operator_reference);

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'item_id', v_item.id, 'status', 'pending'),
        entity_id = v_item.id, completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'item_id', v_item.id, 'status', 'pending');
END;
$rpc$;

REVOKE ALL ON FUNCTION public.authorize_intake_item_retry(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_intake_item_retry(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ===========================================================================
-- RPC 12/12: finalize_intake_batch -- refuses while any item is still
-- reconciliation_required.
-- ===========================================================================
DO $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'finalize_intake_batch';
  IF v_hash IS NOT NULL AND v_hash <> 'a7587b9deb871c5b9fbb6439691fc2da' THEN
    RAISE EXCEPTION '079 CRITICAL: finalize_intake_batch body hash changed (got %, expected a7587b9deb871c5b9fbb6439691fc2da) -- this migration must NEVER silently redefine a drifted function. Aborting.', v_hash;
  END IF;
  IF v_hash IS NULL THEN
    RAISE NOTICE '079: finalize_intake_batch does not exist -- CREATE branch.';
  ELSE
    RAISE NOTICE '079: finalize_intake_batch already exists and matches exactly -- will be re-created byte-identical (no-op).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.finalize_intake_batch(
  p_batch_id UUID,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $rpc$
DECLARE
  v_request_digest TEXT;
  v_ledger RECORD;
  v_batch RECORD;
  v_unresolved_count INTEGER;
  v_failed_count INTEGER;
  v_final_status TEXT;
BEGIN
  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format('{"domain":%s,"batch_id":%s}', to_json('willviral.semantic-topic.supervised-intake-finalize:v1'::text)::text, to_json(p_batch_id::text)::text),
    'UTF8')), 'hex');

  SELECT * INTO v_ledger FROM public.supervised_intake_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'finalize_intake_batch: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;
  INSERT INTO public.supervised_intake_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'finalize_batch', v_request_digest);

  SELECT * INTO v_batch FROM public.supervised_intake_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_intake_batch: BATCH_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_batch.status IN ('completed', 'completed_with_failures', 'cancelled') THEN
    UPDATE public.supervised_intake_idempotency_ledger
      SET replay_result = jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'status', v_batch.status), completed_at = now()
      WHERE idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'status', v_batch.status);
  END IF;

  IF v_batch.status NOT IN ('running', 'stopped', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'finalize_intake_batch: BATCH_NOT_FINALIZABLE -- status=%', v_batch.status USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_unresolved_count FROM public.supervised_intake_batch_items
    WHERE batch_id = p_batch_id AND status = 'reconciliation_required';
  IF v_unresolved_count > 0 THEN
    RAISE EXCEPTION 'finalize_intake_batch: UNRESOLVED_RECONCILIATION_EXISTS -- % item(s) still reconciliation_required', v_unresolved_count USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_unresolved_count FROM public.supervised_intake_batch_items
    WHERE batch_id = p_batch_id AND status IN ('pending', 'claimed');
  IF v_unresolved_count > 0 THEN
    RAISE EXCEPTION 'finalize_intake_batch: ITEMS_STILL_IN_FLIGHT -- % item(s) still pending/claimed', v_unresolved_count USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_failed_count FROM public.supervised_intake_batch_items
    WHERE batch_id = p_batch_id AND status = 'failed';

  v_final_status := CASE WHEN v_failed_count > 0 THEN 'completed_with_failures' ELSE 'completed' END;

  UPDATE public.supervised_intake_batches
    SET status = v_final_status, finished_at = now(), started_at = COALESCE(started_at, now())
    WHERE id = p_batch_id;

  INSERT INTO public.supervised_intake_events (batch_id, event_kind, previous_status, resulting_status, actor_kind)
    VALUES (p_batch_id, 'batch_finalized', v_batch.status, v_final_status, 'service_role_system');

  UPDATE public.supervised_intake_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'status', v_final_status),
        entity_id = p_batch_id, completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'status', v_final_status);
END;
$rpc$;

REVOKE ALL ON FUNCTION public.finalize_intake_batch(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_intake_batch(UUID, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
