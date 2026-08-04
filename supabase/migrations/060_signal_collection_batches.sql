-- ============================================================
-- Migration 060: Signal collection — work batches
--                 + signal_provider_budget_reservations.batch_id (ALTER)
--
-- PFM-3B1 (korrekciós verzió). Fail-fast szerzodes MINDEN objektumra:
--   A) nem letezik -> CREATE / ADD COLUMN
--   B) letezik     -> byte-/normalizalt-pontos VALIDACIO, no-op vagy EXCEPTION.
-- A B) agban SOHA nem fut DDL/DCL.
--
-- EGYIRANYU FK: signal_provider_budget_reservations.batch_id ->
-- signal_collection_batches(id) ON DELETE SET NULL. A batch-tablan
-- NINCS provider_reservation_id oszlop — korkoros FK tiltva (explicit
-- validalva a zaro ellenorzesben is). Az "aktualis/legutobbi
-- reservation" a batch_id + created_at index alapjan kerdezheto le; a
-- TELJES reservation-elozmeny a signal_provider_budget_reservations az
-- egyetlen source of truth.
--
-- FONTOS: a YouTube search.list NEM tamogat ID-listas kotegeleset —
-- egy discovery batch MINDIG pontosan 1 elemu (item_count=1), szemben
-- az observation batch 1..50 elemu kotegevel (videos.list kepessege).
-- ============================================================

BEGIN;

-- ============================================================
-- 1. UJ TABLA: signal_collection_batches
-- ============================================================

DO $migrate$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_collection_batches')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '060: signal_collection_batches does not exist — CREATE branch.';

    CREATE TABLE public.signal_collection_batches (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_phase_id            UUID NOT NULL REFERENCES public.signal_run_phases(id) ON DELETE CASCADE,
      batch_type              TEXT NOT NULL,
      deterministic_batch_key TEXT NOT NULL,
      payload_hash            TEXT NOT NULL,
      item_ids                JSONB NOT NULL,
      algorithm_version       INTEGER NOT NULL DEFAULT 1,
      status                  TEXT NOT NULL DEFAULT 'pending',
      attempt                 INTEGER NOT NULL DEFAULT 0,
      max_attempts            INTEGER NOT NULL DEFAULT 2,
      lease_owner             TEXT,
      lease_acquired_at       TIMESTAMPTZ,
      lease_expires_at        TIMESTAMPTZ,
      item_count              INTEGER NOT NULL,
      completed_item_count    INTEGER NOT NULL DEFAULT 0,
      error_class             TEXT,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at              TIMESTAMPTZ,
      completed_at            TIMESTAMPTZ,

      CONSTRAINT signal_collection_batches_key UNIQUE (run_phase_id, deterministic_batch_key),
      CONSTRAINT signal_collection_batches_type_check CHECK (batch_type IN ('observation', 'discovery')),
      CONSTRAINT signal_collection_batches_key_not_blank CHECK (btrim(deterministic_batch_key) <> ''),
      CONSTRAINT signal_collection_batches_payload_hash_not_blank CHECK (btrim(payload_hash) <> ''),
      CONSTRAINT signal_collection_batches_algorithm_version_not_blank CHECK (algorithm_version >= 1),
      CONSTRAINT signal_collection_batches_item_ids_is_array CHECK (jsonb_typeof(item_ids) = 'array'),
      CONSTRAINT signal_collection_batches_status_check CHECK (
        status IN ('pending', 'in_progress', 'completed', 'retryable', 'failed', 'outcome_unknown')
      ),
      CONSTRAINT signal_collection_batches_attempt_nonneg CHECK (attempt >= 0),
      CONSTRAINT signal_collection_batches_max_attempts_positive CHECK (max_attempts >= 1),
      CONSTRAINT signal_collection_batches_attempt_within_max CHECK (attempt <= max_attempts),
      CONSTRAINT signal_collection_batches_lease_all_or_nothing CHECK (
        (lease_owner IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL) OR
        (lease_owner IS NOT NULL AND lease_acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL)
      ),
      CONSTRAINT signal_collection_batches_lease_matches_status CHECK (
        (status = 'in_progress' AND lease_owner IS NOT NULL) OR
        (status <> 'in_progress' AND lease_owner IS NULL)
      ),
      CONSTRAINT signal_collection_batches_item_count_range CHECK (
        (batch_type = 'observation' AND item_count BETWEEN 1 AND 50) OR
        (batch_type = 'discovery' AND item_count = 1)
      ),
      CONSTRAINT signal_collection_batches_completed_item_count_range CHECK (
        completed_item_count >= 0 AND completed_item_count <= item_count
      ),
      CONSTRAINT signal_collection_batches_completed_requires_full_count CHECK (
        status <> 'completed' OR completed_item_count = item_count
      ),
      CONSTRAINT signal_collection_batches_completed_at_matches_status CHECK (
        (status IN ('completed', 'failed', 'outcome_unknown') AND completed_at IS NOT NULL) OR
        (status IN ('pending', 'in_progress', 'retryable') AND completed_at IS NULL)
      ),
      CONSTRAINT signal_collection_batches_error_class_only_when_failed CHECK (
        status = 'failed' OR error_class IS NULL
      )
    );

    CREATE INDEX idx_signal_collection_batches_claimable
      ON public.signal_collection_batches(status) WHERE status IN ('pending', 'retryable');
    CREATE INDEX idx_signal_collection_batches_stale
      ON public.signal_collection_batches(lease_expires_at) WHERE status = 'in_progress';

    ALTER TABLE public.signal_collection_batches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_collection_batches FORCE ROW LEVEL SECURITY;

    GRANT INSERT, SELECT, UPDATE ON public.signal_collection_batches TO service_role;

    RAISE NOTICE '060: signal_collection_batches created.';
  ELSE
    RAISE NOTICE '060: signal_collection_batches already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_collection_batches' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '060 drift: signal_collection_batches owner is not postgres';
    END IF;

    -- KORKOROS FK TILTASA: nincs provider_reservation_id oszlop.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'signal_collection_batches' AND column_name = 'provider_reservation_id'
    ) THEN
      RAISE EXCEPTION '060 drift: signal_collection_batches must NOT have a provider_reservation_id column (circular FK forbidden)';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('run_phase_id', 'uuid', 'uuid', 'NO', NULL),
        ('batch_type', 'text', 'text', 'NO', NULL),
        ('deterministic_batch_key', 'text', 'text', 'NO', NULL),
        ('payload_hash', 'text', 'text', 'NO', NULL),
        ('item_ids', 'jsonb', 'jsonb', 'NO', NULL),
        ('algorithm_version', 'integer', 'int4', 'NO', '1'),
        ('status', 'text', 'text', 'NO', '''pending''::text'),
        ('attempt', 'integer', 'int4', 'NO', '0'),
        ('max_attempts', 'integer', 'int4', 'NO', '2'),
        ('lease_owner', 'text', 'text', 'YES', NULL),
        ('lease_acquired_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('lease_expires_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('item_count', 'integer', 'int4', 'NO', NULL),
        ('completed_item_count', 'integer', 'int4', 'NO', '0'),
        ('error_class', 'text', 'text', 'YES', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('started_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('completed_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL)
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signal_collection_batches'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '060 drift: signal_collection_batches column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_collection_batches_algorithm_version_not_blank', 'c', 'CHECK (algorithm_version >= 1)'),
        ('signal_collection_batches_attempt_nonneg', 'c', 'CHECK (attempt >= 0)'),
        ('signal_collection_batches_attempt_within_max', 'c', 'CHECK (attempt <= max_attempts)'),
        ('signal_collection_batches_completed_at_matches_status', 'c', 'CHECK ((status = ANY (ARRAY[''completed''::text, ''failed''::text, ''outcome_unknown''::text])) AND completed_at IS NOT NULL OR (status = ANY (ARRAY[''pending''::text, ''in_progress''::text, ''retryable''::text])) AND completed_at IS NULL)'),
        ('signal_collection_batches_completed_item_count_range', 'c', 'CHECK (completed_item_count >= 0 AND completed_item_count <= item_count)'),
        ('signal_collection_batches_completed_requires_full_count', 'c', 'CHECK (status <> ''completed''::text OR completed_item_count = item_count)'),
        ('signal_collection_batches_error_class_only_when_failed', 'c', 'CHECK (status = ''failed''::text OR error_class IS NULL)'),
        ('signal_collection_batches_item_count_range', 'c', 'CHECK (batch_type = ''observation''::text AND item_count >= 1 AND item_count <= 50 OR batch_type = ''discovery''::text AND item_count = 1)'),
        ('signal_collection_batches_item_ids_is_array', 'c', 'CHECK (jsonb_typeof(item_ids) = ''array''::text)'),
        ('signal_collection_batches_key', 'u', 'UNIQUE (run_phase_id, deterministic_batch_key)'),
        ('signal_collection_batches_key_not_blank', 'c', 'CHECK (btrim(deterministic_batch_key) <> ''''::text)'),
        ('signal_collection_batches_lease_all_or_nothing', 'c', 'CHECK (lease_owner IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL OR lease_owner IS NOT NULL AND lease_acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL)'),
        ('signal_collection_batches_lease_matches_status', 'c', 'CHECK (status = ''in_progress''::text AND lease_owner IS NOT NULL OR status <> ''in_progress''::text AND lease_owner IS NULL)'),
        ('signal_collection_batches_max_attempts_positive', 'c', 'CHECK (max_attempts >= 1)'),
        ('signal_collection_batches_payload_hash_not_blank', 'c', 'CHECK (btrim(payload_hash) <> ''''::text)'),
        ('signal_collection_batches_pkey', 'p', 'PRIMARY KEY (id)'),
        ('signal_collection_batches_run_phase_id_fkey', 'f', 'FOREIGN KEY (run_phase_id) REFERENCES signal_run_phases(id) ON DELETE CASCADE'),
        ('signal_collection_batches_status_check', 'c', 'CHECK (status = ANY (ARRAY[''pending''::text, ''in_progress''::text, ''completed''::text, ''retryable''::text, ''failed''::text, ''outcome_unknown''::text]))'),
        ('signal_collection_batches_type_check', 'c', 'CHECK (batch_type = ANY (ARRAY[''observation''::text, ''discovery''::text]))')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.signal_collection_batches'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '060 drift: signal_collection_batches constraint set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('idx_signal_collection_batches_claimable', 'false', 'CREATE INDEX idx_signal_collection_batches_claimable ON public.signal_collection_batches USING btree (status) WHERE (status = ANY (ARRAY[''pending''::text, ''retryable''::text]))'),
        ('idx_signal_collection_batches_stale', 'false', 'CREATE INDEX idx_signal_collection_batches_stale ON public.signal_collection_batches USING btree (lease_expires_at) WHERE (status = ''in_progress''::text)'),
        ('signal_collection_batches_key', 'true', 'CREATE UNIQUE INDEX signal_collection_batches_key ON public.signal_collection_batches USING btree (run_phase_id, deterministic_batch_key)'),
        ('signal_collection_batches_pkey', 'true', 'CREATE UNIQUE INDEX signal_collection_batches_pkey ON public.signal_collection_batches USING btree (id)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.signal_collection_batches'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '060 drift: signal_collection_batches index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_collection_batches'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '060 drift: signal_collection_batches RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_collection_batches') THEN
      RAISE EXCEPTION '060 drift: signal_collection_batches has an unexpected policy';
    END IF;

    IF EXISTS (
      -- ld. 055 megjegyzeset: mindket EXCEPT-ag KULON zarojelben, kulonben
      -- balrol-jobbra ertekelodo UNION ALL csendben elnyelheti a driftet.
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_collection_batches' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('INSERT'), ('SELECT'), ('UPDATE')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('INSERT'), ('SELECT'), ('UPDATE')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_collection_batches' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '060 drift: signal_collection_batches service_role grant set does not match exactly';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_collection_batches' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '060 drift: signal_collection_batches has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '060: signal_collection_batches already exists and matches exactly — no-op.';
  END IF;
END;
$migrate$;

-- ============================================================
-- 2. signal_provider_budget_reservations.batch_id — OSZLOP-szintu
--    create/validate (egyiranyu FK, hozza tartozo index).
-- ============================================================

DO $migrate_batch_id$
DECLARE
  v_col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_provider_budget_reservations' AND column_name = 'batch_id'
  ) INTO v_col_exists;

  IF NOT v_col_exists THEN
    RAISE NOTICE '060: signal_provider_budget_reservations.batch_id does not exist — CREATE branch.';

    ALTER TABLE public.signal_provider_budget_reservations
      ADD COLUMN batch_id UUID REFERENCES public.signal_collection_batches(id) ON DELETE SET NULL;

    CREATE INDEX idx_signal_provider_budget_reservations_batch
      ON public.signal_provider_budget_reservations(batch_id, created_at);

    RAISE NOTICE '060: signal_provider_budget_reservations.batch_id added.';
  ELSE
    RAISE NOTICE '060: signal_provider_budget_reservations.batch_id already exists — VALIDATE branch (no DDL/DCL will run).';

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'signal_provider_budget_reservations' AND column_name = 'batch_id'
        AND (data_type IS DISTINCT FROM 'uuid' OR udt_name IS DISTINCT FROM 'uuid'
             OR is_nullable IS DISTINCT FROM 'YES' OR column_default IS NOT NULL
             OR is_identity IS DISTINCT FROM 'NO')
    ) THEN
      RAISE EXCEPTION '060 drift: signal_provider_budget_reservations.batch_id exists but its column definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
      WHERE cl.relname = 'signal_provider_budget_reservations'
        AND c.conname = 'signal_provider_budget_reservations_batch_id_fkey'
        AND c.contype = 'f' AND c.confdeltype = 'n'
        AND pg_get_constraintdef(c.oid, true) = 'FOREIGN KEY (batch_id) REFERENCES signal_collection_batches(id) ON DELETE SET NULL'
        AND c.convalidated IS TRUE AND c.condeferrable IS FALSE AND c.condeferred IS FALSE
    ) THEN
      RAISE EXCEPTION '060 drift: signal_provider_budget_reservations_batch_id_fkey missing or definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
      WHERE ix.indrelid = 'public.signal_provider_budget_reservations'::regclass
        AND c.relname = 'idx_signal_provider_budget_reservations_batch'
        AND ix.indisunique IS FALSE AND ix.indisvalid IS TRUE AND ix.indisready IS TRUE
        AND pg_get_indexdef(ix.indexrelid) = 'CREATE INDEX idx_signal_provider_budget_reservations_batch ON public.signal_provider_budget_reservations USING btree (batch_id, created_at)'
    ) THEN
      RAISE EXCEPTION '060 drift: idx_signal_provider_budget_reservations_batch missing or definition does not match exactly';
    END IF;

    RAISE NOTICE '060: signal_provider_budget_reservations.batch_id already exists and matches exactly — no-op.';
  END IF;
END;
$migrate_batch_id$;

NOTIFY pgrst, 'reload schema';

COMMIT;
