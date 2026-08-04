-- ============================================================
-- Migration 059: Signal collection — provider budget reservations
--
-- PFM-3B1 (korrekciós verzió). Fail-fast szerzodes:
--   A) nem letezik -> CREATE (kizarolag ez a tabla + sajat objektumai)
--   B) letezik     -> byte-/normalizalt-pontos VALIDACIO, no-op vagy EXCEPTION.
-- A B) agban SOHA nem fut DDL/DCL.
--
-- VEGLEGES SZERKEZETI DONTES (korrekcio a korabbi verzioval szemben):
-- ez a migracio KIZAROLAG a signal_provider_budget_reservations tablat
-- es a sajat objektumait (constraint/index/RLS/grant) hozza letre —
-- NINCS benne RPC. A 6 SECURITY DEFINER RPC (reserve_provider_units,
-- mark_provider_attempt_started, commit_provider_units,
-- mark_provider_outcome_unknown, release_provider_units,
-- expire_stale_provider_reservations) KIZAROLAG a 061-ben jon letre,
-- VEGLEGES formaban, amikor mar minden fuggo tabla (058, 059, 060, 061)
-- letezik — igy nincs koztes, service_role szamara elerheto, kesobb
-- lecserelendo reszleges RPC-verzio egyetlen migracios allapotban sem.
--
-- A batch_id oszlopot (signal_collection_batches-re mutato, EGYIRANYU
-- FK) a 060 adja hozza ALTER-rel, miutan a signal_collection_batches
-- tabla mar letezik — ITT meg nincs.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_provider_budget_reservations')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '059: signal_provider_budget_reservations does not exist — CREATE branch.';

    CREATE TABLE public.signal_provider_budget_reservations (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      daily_budget_id     UUID NOT NULL REFERENCES public.signal_provider_daily_budgets(id) ON DELETE RESTRICT,
      run_id              UUID NOT NULL REFERENCES public.signal_runs(id) ON DELETE RESTRICT,
      phase               TEXT NOT NULL,
      idempotency_key     TEXT NOT NULL,
      requested_units     INTEGER NOT NULL,
      committed_units     INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'reserved',
      attempt_started_at  TIMESTAMPTZ,
      lease_expires_at    TIMESTAMPTZ NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      committed_at        TIMESTAMPTZ,
      released_at         TIMESTAMPTZ,

      CONSTRAINT signal_provider_budget_reservations_key UNIQUE (daily_budget_id, idempotency_key),
      CONSTRAINT signal_provider_budget_reservations_phase_check CHECK (phase IN ('observation', 'discovery')),
      CONSTRAINT signal_provider_budget_reservations_idempotency_not_blank CHECK (btrim(idempotency_key) <> ''),
      CONSTRAINT signal_provider_budget_reservations_status_check CHECK (
        status IN ('reserved', 'committed', 'committed_unknown', 'released', 'expired_unstarted')
      ),
      CONSTRAINT signal_provider_budget_reservations_requested_positive CHECK (requested_units > 0),
      CONSTRAINT signal_provider_budget_reservations_committed_nonneg CHECK (committed_units >= 0),
      CONSTRAINT signal_provider_budget_reservations_committed_within_requested CHECK (committed_units <= requested_units),
      CONSTRAINT signal_provider_budget_reservations_units_status_match CHECK (
        (status = 'reserved' AND committed_units = 0) OR
        (status = 'committed' AND committed_units > 0) OR
        (status = 'committed_unknown' AND committed_units = requested_units) OR
        (status IN ('released', 'expired_unstarted') AND committed_units = 0)
      ),
      CONSTRAINT signal_provider_budget_reservations_committed_at_matches_status CHECK (
        (status IN ('committed', 'committed_unknown') AND committed_at IS NOT NULL) OR
        (status NOT IN ('committed', 'committed_unknown') AND committed_at IS NULL)
      ),
      CONSTRAINT signal_provider_budget_reservations_released_at_matches_status CHECK (
        (status IN ('released', 'expired_unstarted') AND released_at IS NOT NULL) OR
        (status NOT IN ('released', 'expired_unstarted') AND released_at IS NULL)
      ),
      CONSTRAINT signal_provider_budget_reservations_unknown_requires_attempt CHECK (
        status <> 'committed_unknown' OR attempt_started_at IS NOT NULL
      )
    );

    CREATE INDEX idx_signal_provider_budget_reservations_stale
      ON public.signal_provider_budget_reservations(lease_expires_at) WHERE status = 'reserved';
    CREATE INDEX idx_signal_provider_budget_reservations_run
      ON public.signal_provider_budget_reservations(run_id);

    ALTER TABLE public.signal_provider_budget_reservations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_provider_budget_reservations FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.signal_provider_budget_reservations TO service_role;

    RAISE NOTICE '059: signal_provider_budget_reservations created.';
  ELSE
    RAISE NOTICE '059: signal_provider_budget_reservations already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_provider_budget_reservations' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '059 drift: signal_provider_budget_reservations owner is not postgres';
    END IF;

    -- OSZLOPOK: a batch_id (060-ban adodik hozza) itt SZANDEKOSAN NEM
    -- szerepel az elvart listaban — ha ez a migracio masodszor fut le
    -- AZUTAN, hogy a 060 mar hozzaadta a batch_id-t, a validacio ezt
    -- "extra oszlopkent" driftnek jelezne. Ezert a batch_id oszlopot
    -- explicit KIVESSZUK a diff-bol (WHERE ... AND expected.column_name
    -- IS NOT NULL A hianyzo-oldalon, illetve kulon engedelyezett kivetel
    -- az extra-oldalon), es a batch_id sajat, teljes validaciojat a 060
    -- vegzi.
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('daily_budget_id', 'uuid', 'uuid', 'NO', NULL),
        ('run_id', 'uuid', 'uuid', 'NO', NULL),
        ('phase', 'text', 'text', 'NO', NULL),
        ('idempotency_key', 'text', 'text', 'NO', NULL),
        ('requested_units', 'integer', 'int4', 'NO', NULL),
        ('committed_units', 'integer', 'int4', 'NO', '0'),
        ('status', 'text', 'text', 'NO', '''reserved''::text'),
        ('attempt_started_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('lease_expires_at', 'timestamp with time zone', 'timestamptz', 'NO', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('committed_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('released_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL)
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'signal_provider_budget_reservations'
          AND column_name <> 'batch_id'   -- a 060 sajat hataskoreben validalt oszlop
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '059 drift: signal_provider_budget_reservations column set/definition (excluding batch_id, owned by 060) does not match exactly';
    END IF;

    -- CONSTRAINTOK: a batch_id FK-ja (060 hozza adja) itt szanden szerint
    -- nem szerepel az elvart listaban — annak validaciojat a 060 vegzi.
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_provider_budget_reservations_committed_at_matches_status', 'c', 'CHECK ((status = ANY (ARRAY[''committed''::text, ''committed_unknown''::text])) AND committed_at IS NOT NULL OR (status <> ALL (ARRAY[''committed''::text, ''committed_unknown''::text])) AND committed_at IS NULL)'),
        ('signal_provider_budget_reservations_committed_nonneg', 'c', 'CHECK (committed_units >= 0)'),
        ('signal_provider_budget_reservations_committed_within_requested', 'c', 'CHECK (committed_units <= requested_units)'),
        ('signal_provider_budget_reservations_daily_budget_id_fkey', 'f', 'FOREIGN KEY (daily_budget_id) REFERENCES signal_provider_daily_budgets(id) ON DELETE RESTRICT'),
        ('signal_provider_budget_reservations_idempotency_not_blank', 'c', 'CHECK (btrim(idempotency_key) <> ''''::text)'),
        ('signal_provider_budget_reservations_key', 'u', 'UNIQUE (daily_budget_id, idempotency_key)'),
        ('signal_provider_budget_reservations_phase_check', 'c', 'CHECK (phase = ANY (ARRAY[''observation''::text, ''discovery''::text]))'),
        ('signal_provider_budget_reservations_pkey', 'p', 'PRIMARY KEY (id)'),
        ('signal_provider_budget_reservations_released_at_matches_status', 'c', 'CHECK ((status = ANY (ARRAY[''released''::text, ''expired_unstarted''::text])) AND released_at IS NOT NULL OR (status <> ALL (ARRAY[''released''::text, ''expired_unstarted''::text])) AND released_at IS NULL)'),
        ('signal_provider_budget_reservations_requested_positive', 'c', 'CHECK (requested_units > 0)'),
        ('signal_provider_budget_reservations_run_id_fkey', 'f', 'FOREIGN KEY (run_id) REFERENCES signal_runs(id) ON DELETE RESTRICT'),
        ('signal_provider_budget_reservations_status_check', 'c', 'CHECK (status = ANY (ARRAY[''reserved''::text, ''committed''::text, ''committed_unknown''::text, ''released''::text, ''expired_unstarted''::text]))'),
        ('signal_provider_budget_reservations_units_status_match', 'c', 'CHECK (status = ''reserved''::text AND committed_units = 0 OR status = ''committed''::text AND committed_units > 0 OR status = ''committed_unknown''::text AND committed_units = requested_units OR (status = ANY (ARRAY[''released''::text, ''expired_unstarted''::text])) AND committed_units = 0)'),
        ('signal_provider_budget_reservations_unknown_requires_attempt', 'c', 'CHECK (status <> ''committed_unknown''::text OR attempt_started_at IS NOT NULL)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint
        WHERE conrelid = 'public.signal_provider_budget_reservations'::regclass
          AND conname <> 'signal_provider_budget_reservations_batch_id_fkey'  -- 060 hataskore
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '059 drift: signal_provider_budget_reservations constraint set/definition (excluding batch_id FK, owned by 060) does not match exactly';
    END IF;

    -- INDEXEK: a batch_id-s indexet (060 hozza adja) itt kihagyjuk.
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('idx_signal_provider_budget_reservations_run', 'false', 'CREATE INDEX idx_signal_provider_budget_reservations_run ON public.signal_provider_budget_reservations USING btree (run_id)'),
        ('idx_signal_provider_budget_reservations_stale', 'false', 'CREATE INDEX idx_signal_provider_budget_reservations_stale ON public.signal_provider_budget_reservations USING btree (lease_expires_at) WHERE (status = ''reserved''::text)'),
        ('signal_provider_budget_reservations_key', 'true', 'CREATE UNIQUE INDEX signal_provider_budget_reservations_key ON public.signal_provider_budget_reservations USING btree (daily_budget_id, idempotency_key)'),
        ('signal_provider_budget_reservations_pkey', 'true', 'CREATE UNIQUE INDEX signal_provider_budget_reservations_pkey ON public.signal_provider_budget_reservations USING btree (id)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.signal_provider_budget_reservations'::regclass
          AND c.relname <> 'idx_signal_provider_budget_reservations_batch'  -- 060 hataskore
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '059 drift: signal_provider_budget_reservations index set/definition (excluding batch_id index, owned by 060) does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_provider_budget_reservations'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '059 drift: signal_provider_budget_reservations RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_provider_budget_reservations') THEN
      RAISE EXCEPTION '059 drift: signal_provider_budget_reservations has an unexpected policy';
    END IF;

    IF EXISTS (
      -- ld. 055 megjegyzeset: mindket EXCEPT-ag KULON zarojelben, kulonben
      -- balrol-jobbra ertekelodo UNION ALL csendben elnyelheti a driftet.
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_provider_budget_reservations' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_provider_budget_reservations' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '059 drift: signal_provider_budget_reservations service_role grant set is not exactly SELECT';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_provider_budget_reservations' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '059 drift: signal_provider_budget_reservations has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '059: signal_provider_budget_reservations already exists and matches exactly (excluding batch_id, owned by 060) — no-op.';
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
