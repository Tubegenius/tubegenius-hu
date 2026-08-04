-- ============================================================
-- Migration 056: Signal collection — run phases + signal_runs bovites
--
-- PFM-3B1 (korrekciós verzió). Fail-fast szerzodes MINDEN objektumra:
--   A) nem letezik -> CREATE / ADD COLUMN
--   B) letezik     -> byte-/normalizalt-pontos VALIDACIO, no-op vagy EXCEPTION.
-- A B) agban SOHA nem fut DDL/DCL.
--
-- A meglevo signal_runs.status CHECK-je (started|completed|failed, 049)
-- ezt a migraciot NEM erinti — csak azt ellenorizzuk, hogy a nevezett
-- constraint letezik (049 sajat validacioja mar garantalja a pontos
-- ertekkeszletet, azt itt nem duplikaljuk).
-- ============================================================

BEGIN;

-- ============================================================
-- 1. signal_runs.run_claim_expires_at — OSZLOP-szintu create/validate
--    (maga a signal_runs tabla mar letezik, 049 hozta letre).
-- ============================================================

DO $migrate_column$
DECLARE
  v_col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_runs' AND column_name = 'run_claim_expires_at'
  ) INTO v_col_exists;

  IF NOT v_col_exists THEN
    RAISE NOTICE '056: signal_runs.run_claim_expires_at does not exist — CREATE branch.';
    ALTER TABLE public.signal_runs ADD COLUMN run_claim_expires_at TIMESTAMPTZ;
    RAISE NOTICE '056: signal_runs.run_claim_expires_at added.';
  ELSE
    RAISE NOTICE '056: signal_runs.run_claim_expires_at already exists — VALIDATE branch.';
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'signal_runs' AND column_name = 'run_claim_expires_at'
        AND (data_type IS DISTINCT FROM 'timestamp with time zone'
             OR udt_name IS DISTINCT FROM 'timestamptz'
             OR is_nullable IS DISTINCT FROM 'YES'
             OR column_default IS NOT NULL
             OR is_identity IS DISTINCT FROM 'NO')
    ) THEN
      RAISE EXCEPTION '056 drift: signal_runs.run_claim_expires_at exists but its definition does not match exactly';
    END IF;
    -- A meglevo signal_runs_status_check VALTOZATLANUL letezik (049 sajat
    -- validacioja garantalja a pontos ertekkeszletet — itt csak letezest nezunk).
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
      WHERE cl.relname = 'signal_runs' AND c.conname = 'signal_runs_status_check'
    ) THEN
      RAISE EXCEPTION '056 drift: signal_runs_status_check missing (must remain untouched from 049)';
    END IF;
    RAISE NOTICE '056: signal_runs.run_claim_expires_at already exists and matches exactly — no-op.';
  END IF;
END;
$migrate_column$;

-- ============================================================
-- 2. UJ TABLA: signal_run_phases
-- ============================================================

DO $migrate$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_run_phases')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '056: signal_run_phases does not exist — CREATE branch.';

    CREATE TABLE public.signal_run_phases (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id              UUID NOT NULL REFERENCES public.signal_runs(id) ON DELETE CASCADE,
      phase               TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      attempt             INTEGER NOT NULL DEFAULT 0,
      max_attempts        INTEGER NOT NULL DEFAULT 2,
      lease_owner         TEXT,
      lease_acquired_at   TIMESTAMPTZ,
      lease_expires_at    TIMESTAMPTZ,
      started_at          TIMESTAMPTZ,
      completed_at        TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT signal_run_phases_run_phase_key UNIQUE (run_id, phase),
      CONSTRAINT signal_run_phases_phase_check CHECK (phase IN ('observation', 'discovery')),
      CONSTRAINT signal_run_phases_status_check CHECK (
        status IN ('pending', 'in_progress', 'completed', 'partially_completed', 'retryable', 'failed', 'skipped')
      ),
      CONSTRAINT signal_run_phases_attempt_nonneg CHECK (attempt >= 0),
      CONSTRAINT signal_run_phases_max_attempts_positive CHECK (max_attempts >= 1),
      CONSTRAINT signal_run_phases_attempt_within_max CHECK (attempt <= max_attempts),
      CONSTRAINT signal_run_phases_lease_all_or_nothing CHECK (
        (lease_owner IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL) OR
        (lease_owner IS NOT NULL AND lease_acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL)
      ),
      CONSTRAINT signal_run_phases_lease_matches_status CHECK (
        (status = 'in_progress' AND lease_owner IS NOT NULL) OR
        (status <> 'in_progress' AND lease_owner IS NULL)
      ),
      CONSTRAINT signal_run_phases_completed_at_matches_status CHECK (
        (status IN ('completed', 'partially_completed', 'failed', 'skipped') AND completed_at IS NOT NULL) OR
        (status IN ('pending', 'in_progress', 'retryable') AND completed_at IS NULL)
      ),
      CONSTRAINT signal_run_phases_retryable_has_attempts_left CHECK (
        status <> 'retryable' OR attempt < max_attempts
      )
    );

    CREATE INDEX idx_signal_run_phases_stale
      ON public.signal_run_phases(lease_expires_at) WHERE status = 'in_progress';
    CREATE INDEX idx_signal_run_phases_claimable
      ON public.signal_run_phases(status) WHERE status IN ('pending', 'retryable');

    ALTER TABLE public.signal_run_phases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_run_phases FORCE ROW LEVEL SECURITY;

    GRANT INSERT, SELECT, UPDATE ON public.signal_run_phases TO service_role;

    RAISE NOTICE '056: signal_run_phases created.';
  ELSE
    RAISE NOTICE '056: signal_run_phases already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_run_phases' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '056 drift: signal_run_phases owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('run_id', 'uuid', 'uuid', 'NO', NULL),
        ('phase', 'text', 'text', 'NO', NULL),
        ('status', 'text', 'text', 'NO', '''pending''::text'),
        ('attempt', 'integer', 'int4', 'NO', '0'),
        ('max_attempts', 'integer', 'int4', 'NO', '2'),
        ('lease_owner', 'text', 'text', 'YES', NULL),
        ('lease_acquired_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('lease_expires_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('started_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('completed_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signal_run_phases'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '056 drift: signal_run_phases column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_run_phases_attempt_nonneg', 'c', 'CHECK (attempt >= 0)'),
        ('signal_run_phases_attempt_within_max', 'c', 'CHECK (attempt <= max_attempts)'),
        ('signal_run_phases_completed_at_matches_status', 'c', 'CHECK ((status = ANY (ARRAY[''completed''::text, ''partially_completed''::text, ''failed''::text, ''skipped''::text])) AND completed_at IS NOT NULL OR (status = ANY (ARRAY[''pending''::text, ''in_progress''::text, ''retryable''::text])) AND completed_at IS NULL)'),
        ('signal_run_phases_lease_all_or_nothing', 'c', 'CHECK (lease_owner IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL OR lease_owner IS NOT NULL AND lease_acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL)'),
        ('signal_run_phases_lease_matches_status', 'c', 'CHECK (status = ''in_progress''::text AND lease_owner IS NOT NULL OR status <> ''in_progress''::text AND lease_owner IS NULL)'),
        ('signal_run_phases_max_attempts_positive', 'c', 'CHECK (max_attempts >= 1)'),
        ('signal_run_phases_phase_check', 'c', 'CHECK (phase = ANY (ARRAY[''observation''::text, ''discovery''::text]))'),
        ('signal_run_phases_pkey', 'p', 'PRIMARY KEY (id)'),
        ('signal_run_phases_retryable_has_attempts_left', 'c', 'CHECK (status <> ''retryable''::text OR attempt < max_attempts)'),
        ('signal_run_phases_run_id_fkey', 'f', 'FOREIGN KEY (run_id) REFERENCES signal_runs(id) ON DELETE CASCADE'),
        ('signal_run_phases_run_phase_key', 'u', 'UNIQUE (run_id, phase)'),
        ('signal_run_phases_status_check', 'c', 'CHECK (status = ANY (ARRAY[''pending''::text, ''in_progress''::text, ''completed''::text, ''partially_completed''::text, ''retryable''::text, ''failed''::text, ''skipped''::text]))')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.signal_run_phases'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '056 drift: signal_run_phases constraint set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('idx_signal_run_phases_claimable', 'false', 'CREATE INDEX idx_signal_run_phases_claimable ON public.signal_run_phases USING btree (status) WHERE (status = ANY (ARRAY[''pending''::text, ''retryable''::text]))'),
        ('idx_signal_run_phases_stale', 'false', 'CREATE INDEX idx_signal_run_phases_stale ON public.signal_run_phases USING btree (lease_expires_at) WHERE (status = ''in_progress''::text)'),
        ('signal_run_phases_pkey', 'true', 'CREATE UNIQUE INDEX signal_run_phases_pkey ON public.signal_run_phases USING btree (id)'),
        ('signal_run_phases_run_phase_key', 'true', 'CREATE UNIQUE INDEX signal_run_phases_run_phase_key ON public.signal_run_phases USING btree (run_id, phase)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.signal_run_phases'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '056 drift: signal_run_phases index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_run_phases'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '056 drift: signal_run_phases RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_run_phases') THEN
      RAISE EXCEPTION '056 drift: signal_run_phases has an unexpected policy';
    END IF;

    IF EXISTS (
      -- ld. 055 megjegyzeset: mindket EXCEPT-ag KULON zarojelben, kulonben
      -- balrol-jobbra ertekelodo UNION ALL csendben elnyelheti a driftet.
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_run_phases' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('INSERT'), ('SELECT'), ('UPDATE')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('INSERT'), ('SELECT'), ('UPDATE')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_run_phases' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '056 drift: signal_run_phases service_role grant set does not match exactly';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_run_phases' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '056 drift: signal_run_phases has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '056: signal_run_phases already exists and matches exactly — no-op.';
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
