-- ============================================================
-- Migration 062: Signal collection — kill switch control table
--
-- PFM-3B1 (korrekciós verzió). Fail-fast szerzodes a SEMAra:
--   A) a tabla NEM letezik -> CREATE + pontosan 1 sor seedelese (id=1, enabled=false)
--   B) a tabla LETEZIK     -> byte-/normalizalt-pontos SEMA-validacio (mint a tobbi
--                              tablanal), PLUSZ kulon SOR-szintu ellenorzes:
--       - pontosan 1 sor kell letezzen, id=1 — hianyzo vagy extra sor EXCEPTION;
--       - az `enabled` ERTEKE FUTASIDEJU KONFIGURACIO, NEM sema-drift — akar
--         true, akar false, mindket ertek ELFOGADOTT no-op, a migracio SOHA
--         nem irja at csendben false-ra (vagy barmilyen mas ertekre).
-- A B) agban SOHA nem fut DDL/DCL, es SOHA nem fut INSERT/UPDATE a sorra.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_table_exists boolean;
  v_row_count int;
  v_current_enabled boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_collection_control')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    -- ============================================================
    -- A) CREATE BRANCH — tabla + pontosan 1, kotelezo seed-sor.
    -- ============================================================
    RAISE NOTICE '062: signal_collection_control does not exist — CREATE branch.';

    CREATE TABLE public.signal_collection_control (
      id          INTEGER PRIMARY KEY,
      enabled     BOOLEAN NOT NULL DEFAULT false,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by  TEXT,

      CONSTRAINT signal_collection_control_single_row CHECK (id = 1)
    );

    INSERT INTO public.signal_collection_control (id, enabled) VALUES (1, false);

    ALTER TABLE public.signal_collection_control ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_collection_control FORCE ROW LEVEL SECURITY;

    -- Kizarolag SELECT (futasideju olvasas) + UPDATE (admin be/kikapcsolas) —
    -- NINCS INSERT, NINCS DELETE.
    GRANT SELECT, UPDATE ON public.signal_collection_control TO service_role;

    RAISE NOTICE '062: signal_collection_control created with the single required row (id=1, enabled=false).';
  ELSE
    -- ============================================================
    -- B) VALIDATE/NO-OP BRANCH — SEMA pontos, SOR letezese kotelezo,
    --    de az `enabled` ERTEKE nem resze a drift-ellenorzesnek.
    -- ============================================================
    RAISE NOTICE '062: signal_collection_control already exists — VALIDATE branch (no DDL/DCL, no row mutation will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_collection_control' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '062 drift: signal_collection_control owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'integer', 'int4', 'NO', NULL),
        ('enabled', 'boolean', 'bool', 'NO', 'false'),
        ('updated_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('updated_by', 'text', 'text', 'YES', NULL)
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signal_collection_control'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '062 drift: signal_collection_control column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_collection_control_pkey', 'p', 'PRIMARY KEY (id)'),
        ('signal_collection_control_single_row', 'c', 'CHECK (id = 1)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.signal_collection_control'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '062 drift: signal_collection_control constraint set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
      WHERE ix.indrelid = 'public.signal_collection_control'::regclass
        AND c.relname = 'signal_collection_control_pkey'
        AND ix.indisunique IS TRUE AND ix.indisvalid IS TRUE AND ix.indisready IS TRUE
        AND pg_get_indexdef(ix.indexrelid) = 'CREATE UNIQUE INDEX signal_collection_control_pkey ON public.signal_collection_control USING btree (id)'
    ) THEN
      RAISE EXCEPTION '062 drift: signal_collection_control_pkey index missing or definition does not match exactly';
    END IF;
    IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'signal_collection_control') <> 1 THEN
      RAISE EXCEPTION '062 drift: signal_collection_control has an unexpected extra index';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_collection_control'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '062 drift: signal_collection_control RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_collection_control') THEN
      RAISE EXCEPTION '062 drift: signal_collection_control has an unexpected policy';
    END IF;

    -- service_role PONTOSAN SELECT+UPDATE — nincs INSERT, nincs DELETE.
    IF EXISTS (
      -- ld. 055 megjegyzeset: mindket EXCEPT-ag KULON zarojelben, kulonben
      -- balrol-jobbra ertekelodo UNION ALL csendben elnyelheti a driftet.
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_collection_control' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT'), ('UPDATE')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT'), ('UPDATE')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_collection_control' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '062 drift: signal_collection_control service_role grant set is not exactly SELECT+UPDATE';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_collection_control' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '062 drift: signal_collection_control has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    -- SOR-szintu ellenorzes: pontosan 1 sor, id=1 kotelezo — DE az
    -- `enabled` erteket (true VAGY false) SOHA nem irjuk at, es SOHA
    -- nem tekintjuk driftnek — futasideju konfiguracio, nem sema.
    SELECT count(*) INTO v_row_count FROM public.signal_collection_control;
    IF v_row_count <> 1 THEN
      RAISE EXCEPTION '062 drift: expected exactly 1 row in signal_collection_control, found % (missing or extra row is drift, NOT auto-repaired)', v_row_count;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.signal_collection_control WHERE id = 1) THEN
      RAISE EXCEPTION '062 drift: signal_collection_control row does not have id=1';
    END IF;

    SELECT enabled INTO v_current_enabled FROM public.signal_collection_control WHERE id = 1;
    RAISE NOTICE '062: signal_collection_control already exists and matches exactly — no-op. Current enabled=% (runtime config, not schema drift, left untouched).', v_current_enabled;
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
