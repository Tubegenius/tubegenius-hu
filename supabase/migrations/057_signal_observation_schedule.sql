-- ============================================================
-- Migration 057: Signal collection — observation schedule
--
-- PFM-3B1 (korrekciós verzió). Fail-fast szerzodes:
--   A) nem letezik -> CREATE
--   B) letezik     -> byte-/normalizalt-pontos VALIDACIO, no-op vagy EXCEPTION.
-- A B) agban SOHA nem fut DDL/DCL.
--
-- Meg nem implemental cadence-valto workert vagy automatikus deaktivalast
-- — csak a targyi sema all rendelkezesre.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_observation_schedule')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '057: signal_observation_schedule does not exist — CREATE branch.';

    CREATE TABLE public.signal_observation_schedule (
      id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      signal_evidence_id          UUID NOT NULL REFERENCES public.signal_evidence(id) ON DELETE CASCADE,
      cadence                     TEXT NOT NULL DEFAULT 'daily',
      next_due_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_observed_at            TIMESTAMPTZ,
      consecutive_stagnant_checks INTEGER NOT NULL DEFAULT 0,
      consecutive_miss_checks     INTEGER NOT NULL DEFAULT 0,
      active                      BOOLEAN NOT NULL DEFAULT true,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT signal_observation_schedule_evidence_key UNIQUE (signal_evidence_id),
      CONSTRAINT signal_observation_schedule_cadence_check CHECK (cadence IN ('early8h', 'daily', 'weekly')),
      CONSTRAINT signal_observation_schedule_stagnant_nonneg CHECK (consecutive_stagnant_checks >= 0),
      CONSTRAINT signal_observation_schedule_miss_nonneg CHECK (consecutive_miss_checks >= 0)
    );

    CREATE INDEX idx_signal_observation_schedule_due
      ON public.signal_observation_schedule(next_due_at) WHERE active;

    ALTER TABLE public.signal_observation_schedule ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_observation_schedule FORCE ROW LEVEL SECURITY;

    GRANT INSERT, SELECT, UPDATE ON public.signal_observation_schedule TO service_role;

    RAISE NOTICE '057: signal_observation_schedule created.';
  ELSE
    RAISE NOTICE '057: signal_observation_schedule already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_observation_schedule' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '057 drift: signal_observation_schedule owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('signal_evidence_id', 'uuid', 'uuid', 'NO', NULL),
        ('cadence', 'text', 'text', 'NO', '''daily''::text'),
        ('next_due_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('last_observed_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('consecutive_stagnant_checks', 'integer', 'int4', 'NO', '0'),
        ('consecutive_miss_checks', 'integer', 'int4', 'NO', '0'),
        ('active', 'boolean', 'bool', 'NO', 'true'),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('updated_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signal_observation_schedule'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '057 drift: signal_observation_schedule column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_observation_schedule_cadence_check', 'c', 'CHECK (cadence = ANY (ARRAY[''early8h''::text, ''daily''::text, ''weekly''::text]))'),
        ('signal_observation_schedule_evidence_key', 'u', 'UNIQUE (signal_evidence_id)'),
        ('signal_observation_schedule_miss_nonneg', 'c', 'CHECK (consecutive_miss_checks >= 0)'),
        ('signal_observation_schedule_pkey', 'p', 'PRIMARY KEY (id)'),
        ('signal_observation_schedule_signal_evidence_id_fkey', 'f', 'FOREIGN KEY (signal_evidence_id) REFERENCES signal_evidence(id) ON DELETE CASCADE'),
        ('signal_observation_schedule_stagnant_nonneg', 'c', 'CHECK (consecutive_stagnant_checks >= 0)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.signal_observation_schedule'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '057 drift: signal_observation_schedule constraint set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('idx_signal_observation_schedule_due', 'false', 'CREATE INDEX idx_signal_observation_schedule_due ON public.signal_observation_schedule USING btree (next_due_at) WHERE active'),
        ('signal_observation_schedule_evidence_key', 'true', 'CREATE UNIQUE INDEX signal_observation_schedule_evidence_key ON public.signal_observation_schedule USING btree (signal_evidence_id)'),
        ('signal_observation_schedule_pkey', 'true', 'CREATE UNIQUE INDEX signal_observation_schedule_pkey ON public.signal_observation_schedule USING btree (id)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.signal_observation_schedule'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '057 drift: signal_observation_schedule index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_observation_schedule'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '057 drift: signal_observation_schedule RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_observation_schedule') THEN
      RAISE EXCEPTION '057 drift: signal_observation_schedule has an unexpected policy';
    END IF;

    IF EXISTS (
      -- ld. 055 megjegyzeset: mindket EXCEPT-ag KULON zarojelben, kulonben
      -- balrol-jobbra ertekelodo UNION ALL csendben elnyelheti a driftet.
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_observation_schedule' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('INSERT'), ('SELECT'), ('UPDATE')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('INSERT'), ('SELECT'), ('UPDATE')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_observation_schedule' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '057 drift: signal_observation_schedule service_role grant set does not match exactly';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_observation_schedule' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '057 drift: signal_observation_schedule has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '057: signal_observation_schedule already exists and matches exactly — no-op.';
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
