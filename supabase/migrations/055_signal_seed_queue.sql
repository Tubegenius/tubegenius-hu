-- ============================================================
-- Migration 055: Signal collection — discovery seed queue
--
-- PFM-3B1 (korrekciós verzió). Fail-fast szerzodes MINDEN objektumra:
--   A) a tabla NEM letezik  -> CREATE (tabla + index + RLS/FORCE + GRANT)
--   B) a tabla LETEZIK      -> byte-/normalizalt-pontos VALIDACIO;
--                              pontos egyezes = NOTICE no-op;
--                              barmilyen elteres = RAISE EXCEPTION.
-- A B) agban SOHA nem fut DDL/DCL (nincs javito ALTER/GRANT/REVOKE/
-- CREATE INDEX) — a driftet szandekosan NEM javitjuk csendben.
--
-- region/language a profiles tabla (001, 015) ertekkeszletet tukrozi;
-- category a TrendCandidate.category / NicheCategory ertekkeszletet
-- (lib/niche-seeds.ts); seed_type a globalis seed-univerzum forrasait
-- (PFM-3A terv 3. pont) — ld. eredeti fejlec-magyarazat.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_seed_queue')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    -- ============================================================
    -- A) CREATE BRANCH — a tabla meg nem letezik.
    -- ============================================================
    RAISE NOTICE '055: signal_seed_queue does not exist — CREATE branch.';

    CREATE TABLE public.signal_seed_queue (
      id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      seed_fingerprint            TEXT NOT NULL,
      seed_type                   TEXT NOT NULL,
      seed_text                   TEXT NOT NULL,
      category                    TEXT NOT NULL DEFAULT 'default',
      region                      TEXT NOT NULL DEFAULT 'HU',
      language                    TEXT NOT NULL DEFAULT 'hu',
      active                      BOOLEAN NOT NULL DEFAULT true,
      next_due_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_run_at                 TIMESTAMPTZ,
      consecutive_failure_count   INTEGER NOT NULL DEFAULT 0,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT signal_seed_queue_fingerprint_key UNIQUE (seed_fingerprint),
      CONSTRAINT signal_seed_queue_fingerprint_not_blank CHECK (btrim(seed_fingerprint) <> ''),
      CONSTRAINT signal_seed_queue_seed_type_check CHECK (
        seed_type IN ('curated_global', 'user_niche_aggregate', 'tracked_candidate', 'cluster_reseed')
      ),
      CONSTRAINT signal_seed_queue_seed_text_not_blank CHECK (btrim(seed_text) <> ''),
      CONSTRAINT signal_seed_queue_category_check CHECK (
        category IN (
          'news_current', 'tech_ai', 'science_medical', 'space_discovery', 'psychology',
          'health_wellness', 'finance_crypto', 'history_strange', 'gaming', 'entertainment', 'default'
        )
      ),
      CONSTRAINT signal_seed_queue_region_check CHECK (region IN ('HU', 'US', 'BOTH')),
      CONSTRAINT signal_seed_queue_language_check CHECK (language IN ('hu', 'en')),
      CONSTRAINT signal_seed_queue_failure_count_nonneg CHECK (consecutive_failure_count >= 0)
    );

    CREATE INDEX idx_signal_seed_queue_due
      ON public.signal_seed_queue(next_due_at) WHERE active;

    ALTER TABLE public.signal_seed_queue ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_seed_queue FORCE ROW LEVEL SECURITY;

    GRANT INSERT, SELECT, UPDATE ON public.signal_seed_queue TO service_role;

    RAISE NOTICE '055: signal_seed_queue created.';
  ELSE
    -- ============================================================
    -- B) VALIDATE/NO-OP BRANCH — a tabla mar letezik. Innentol NINCS
    --    DDL/DCL utasitas — csak SELECT-alapu ellenorzes es RAISE.
    -- ============================================================
    RAISE NOTICE '055: signal_seed_queue already exists — VALIDATE branch (no DDL/DCL will run).';

    -- Owner
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_seed_queue' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '055 drift: signal_seed_queue owner is not postgres';
    END IF;

    -- Oszlopok — nev, tipus, udt_name, nullable, default, identity; extra ES hianyzo is drift.
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('seed_fingerprint', 'text', 'text', 'NO', NULL),
        ('seed_type', 'text', 'text', 'NO', NULL),
        ('seed_text', 'text', 'text', 'NO', NULL),
        ('category', 'text', 'text', 'NO', '''default''::text'),
        ('region', 'text', 'text', 'NO', '''HU''::text'),
        ('language', 'text', 'text', 'NO', '''hu''::text'),
        ('active', 'boolean', 'bool', 'NO', 'true'),
        ('next_due_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('last_run_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('consecutive_failure_count', 'integer', 'int4', 'NO', '0'),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('updated_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signal_seed_queue'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '055 drift: signal_seed_queue column set/definition does not match exactly';
    END IF;

    -- Constraintok — nev, tipus, pontos definicio (pg_get_constraintdef), validated/deferrable/deferred.
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_seed_queue_category_check', 'c', 'CHECK (category = ANY (ARRAY[''news_current''::text, ''tech_ai''::text, ''science_medical''::text, ''space_discovery''::text, ''psychology''::text, ''health_wellness''::text, ''finance_crypto''::text, ''history_strange''::text, ''gaming''::text, ''entertainment''::text, ''default''::text]))'),
        ('signal_seed_queue_failure_count_nonneg', 'c', 'CHECK (consecutive_failure_count >= 0)'),
        ('signal_seed_queue_fingerprint_key', 'u', 'UNIQUE (seed_fingerprint)'),
        ('signal_seed_queue_fingerprint_not_blank', 'c', 'CHECK (btrim(seed_fingerprint) <> ''''::text)'),
        ('signal_seed_queue_language_check', 'c', 'CHECK (language = ANY (ARRAY[''hu''::text, ''en''::text]))'),
        ('signal_seed_queue_pkey', 'p', 'PRIMARY KEY (id)'),
        ('signal_seed_queue_region_check', 'c', 'CHECK (region = ANY (ARRAY[''HU''::text, ''US''::text, ''BOTH''::text]))'),
        ('signal_seed_queue_seed_text_not_blank', 'c', 'CHECK (btrim(seed_text) <> ''''::text)'),
        ('signal_seed_queue_seed_type_check', 'c', 'CHECK (seed_type = ANY (ARRAY[''curated_global''::text, ''user_niche_aggregate''::text, ''tracked_candidate''::text, ''cluster_reseed''::text]))')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.signal_seed_queue'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '055 drift: signal_seed_queue constraint set/definition does not match exactly';
    END IF;

    -- Indexek — nev, unique, pontos definicio (pg_get_indexdef), valid, ready.
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('idx_signal_seed_queue_due', 'false', 'CREATE INDEX idx_signal_seed_queue_due ON public.signal_seed_queue USING btree (next_due_at) WHERE active'),
        ('signal_seed_queue_fingerprint_key', 'true', 'CREATE UNIQUE INDEX signal_seed_queue_fingerprint_key ON public.signal_seed_queue USING btree (seed_fingerprint)'),
        ('signal_seed_queue_pkey', 'true', 'CREATE UNIQUE INDEX signal_seed_queue_pkey ON public.signal_seed_queue USING btree (id)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.signal_seed_queue'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '055 drift: signal_seed_queue index set/definition does not match exactly';
    END IF;

    -- RLS + FORCE + policy count
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_seed_queue'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '055 drift: signal_seed_queue RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_seed_queue') THEN
      RAISE EXCEPTION '055 drift: signal_seed_queue has an unexpected policy';
    END IF;

    -- Grantok — pontosan INSERT,SELECT,UPDATE service_role-nak; 0 anon/authenticated/PUBLIC.
    IF EXISTS (
      -- FONTOS: mindket EXCEPT-agat KULON zarojelbe kell tenni — EXCEPT es
      -- UNION ALL azonos precedenciaju es balrol-jobbra ertekelodik, tehat
      -- zarojel nelkul "(A EXCEPT B) UNION ALL C EXCEPT D" alakban
      -- ertekelodne ki, ami hamisan "egyezik"-et adhat vissza akkor is, ha
      -- van EXTRA (nem vart) grant — ez a hiba korabban valoban elofordult
      -- es teszttel bizonyitottan csendben elnyelte a driftet.
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_seed_queue' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('INSERT'), ('SELECT'), ('UPDATE')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('INSERT'), ('SELECT'), ('UPDATE')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_seed_queue' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '055 drift: signal_seed_queue service_role grant set does not match exactly';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_seed_queue' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '055 drift: signal_seed_queue has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '055: signal_seed_queue already exists and matches exactly — no-op.';
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
