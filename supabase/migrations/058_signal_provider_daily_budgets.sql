-- ============================================================
-- Migration 058: Signal collection — provider daily budget ledger
--
-- PFM-3B1 (korrekciós verzió). Fail-fast szerzodes:
--   A) nem letezik -> CREATE
--   B) letezik     -> byte-/normalizalt-pontos VALIDACIO, no-op vagy EXCEPTION.
-- A B) agban SOHA nem fut DDL/DCL.
--
-- Ez a tabla KIZAROLAG a hattermotor hozzaadott terheleset konyveli —
-- SZUK hatokor (PFM-3A.4 2. pont), NEM a teljes projekt kvotavedelme.
-- service_role KIZAROLAG SELECT — minden mutacio a 061-ben letrehozott
-- SECURITY DEFINER RPC-ken keresztul tortenik.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_provider_daily_budgets')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '058: signal_provider_daily_budgets does not exist — CREATE branch.';

    CREATE TABLE public.signal_provider_daily_budgets (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider              TEXT NOT NULL,
      usage_scope           TEXT NOT NULL,
      usage_type            TEXT NOT NULL,
      quota_date            DATE NOT NULL,
      limit_units           INTEGER NOT NULL,
      reserved_units        INTEGER NOT NULL DEFAULT 0,
      committed_units       INTEGER NOT NULL DEFAULT 0,
      released_units_total  INTEGER NOT NULL DEFAULT 0,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT signal_provider_daily_budgets_key UNIQUE (provider, usage_scope, usage_type, quota_date),
      CONSTRAINT signal_provider_daily_budgets_provider_check CHECK (provider IN ('youtube')),
      CONSTRAINT signal_provider_daily_budgets_scope_check CHECK (usage_scope IN ('background')),
      CONSTRAINT signal_provider_daily_budgets_type_check CHECK (usage_type IN ('discovery_search', 'observation_stats')),
      CONSTRAINT signal_provider_daily_budgets_limit_positive CHECK (limit_units > 0),
      CONSTRAINT signal_provider_daily_budgets_reserved_nonneg CHECK (reserved_units >= 0),
      CONSTRAINT signal_provider_daily_budgets_committed_nonneg CHECK (committed_units >= 0),
      CONSTRAINT signal_provider_daily_budgets_released_nonneg CHECK (released_units_total >= 0),
      CONSTRAINT signal_provider_daily_budgets_within_limit CHECK (reserved_units + committed_units <= limit_units)
    );

    ALTER TABLE public.signal_provider_daily_budgets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_provider_daily_budgets FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.signal_provider_daily_budgets TO service_role;

    RAISE NOTICE '058: signal_provider_daily_budgets created.';
  ELSE
    RAISE NOTICE '058: signal_provider_daily_budgets already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_provider_daily_budgets' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '058 drift: signal_provider_daily_budgets owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('provider', 'text', 'text', 'NO', NULL),
        ('usage_scope', 'text', 'text', 'NO', NULL),
        ('usage_type', 'text', 'text', 'NO', NULL),
        ('quota_date', 'date', 'date', 'NO', NULL),
        ('limit_units', 'integer', 'int4', 'NO', NULL),
        ('reserved_units', 'integer', 'int4', 'NO', '0'),
        ('committed_units', 'integer', 'int4', 'NO', '0'),
        ('released_units_total', 'integer', 'int4', 'NO', '0'),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('updated_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signal_provider_daily_budgets'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '058 drift: signal_provider_daily_budgets column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_provider_daily_budgets_committed_nonneg', 'c', 'CHECK (committed_units >= 0)'),
        ('signal_provider_daily_budgets_key', 'u', 'UNIQUE (provider, usage_scope, usage_type, quota_date)'),
        ('signal_provider_daily_budgets_limit_positive', 'c', 'CHECK (limit_units > 0)'),
        ('signal_provider_daily_budgets_pkey', 'p', 'PRIMARY KEY (id)'),
        ('signal_provider_daily_budgets_provider_check', 'c', 'CHECK (provider = ''youtube''::text)'),
        ('signal_provider_daily_budgets_released_nonneg', 'c', 'CHECK (released_units_total >= 0)'),
        ('signal_provider_daily_budgets_reserved_nonneg', 'c', 'CHECK (reserved_units >= 0)'),
        ('signal_provider_daily_budgets_scope_check', 'c', 'CHECK (usage_scope = ''background''::text)'),
        ('signal_provider_daily_budgets_type_check', 'c', 'CHECK (usage_type = ANY (ARRAY[''discovery_search''::text, ''observation_stats''::text]))'),
        ('signal_provider_daily_budgets_within_limit', 'c', 'CHECK ((reserved_units + committed_units) <= limit_units)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.signal_provider_daily_budgets'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '058 drift: signal_provider_daily_budgets constraint set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_provider_daily_budgets_key', 'true', 'CREATE UNIQUE INDEX signal_provider_daily_budgets_key ON public.signal_provider_daily_budgets USING btree (provider, usage_scope, usage_type, quota_date)'),
        ('signal_provider_daily_budgets_pkey', 'true', 'CREATE UNIQUE INDEX signal_provider_daily_budgets_pkey ON public.signal_provider_daily_budgets USING btree (id)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.signal_provider_daily_budgets'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '058 drift: signal_provider_daily_budgets index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_provider_daily_budgets'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '058 drift: signal_provider_daily_budgets RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_provider_daily_budgets') THEN
      RAISE EXCEPTION '058 drift: signal_provider_daily_budgets has an unexpected policy';
    END IF;

    -- service_role PONTOSAN SELECT — se INSERT, se UPDATE, se DELETE.
    IF EXISTS (
      -- ld. 055 megjegyzeset: mindket EXCEPT-ag KULON zarojelben, kulonben
      -- balrol-jobbra ertekelodo UNION ALL csendben elnyelheti a driftet.
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_provider_daily_budgets' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_provider_daily_budgets' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '058 drift: signal_provider_daily_budgets service_role grant set is not exactly SELECT';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_provider_daily_budgets' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '058 drift: signal_provider_daily_budgets has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '058: signal_provider_daily_budgets already exists and matches exactly — no-op.';
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
