-- ============================================================
-- Migration 061: Signal collection — run provider usage audit
--                 + mind a HAT provider-budget RPC, VEGLEGES formaban
--
-- PFM-3B1 (korrekciós verzió). Fail-fast szerzodes MINDEN objektumra:
--   A) nem letezik -> CREATE
--   B) letezik     -> byte-/normalizalt-pontos VALIDACIO, no-op vagy EXCEPTION.
-- A B) agban SOHA nem fut DDL/DCL — es KULONOSEN nincs CREATE OR REPLACE
-- FUNCTION a validate/no-op agban.
--
-- VEGLEGES SZERKEZETI DONTES: a 6 SECURITY DEFINER RPC (reserve_
-- provider_units, mark_provider_attempt_started, commit_provider_units,
-- mark_provider_outcome_unknown, release_provider_units, expire_stale_
-- provider_reservations) KIZAROLAG ITT jon letre, egyszer, vegleges
-- formaban — az 059/060 migraciok NEM tartalmaznak RPC-t. Igy nincs
-- olyan koztes migracios allapot, amelyben egy service_role szamara
-- elerheto, de kesobb lecserelendo reszleges RPC-verzio letezne.
--
-- Fuggosegi indoklas: ezek az RPC-k (commit_provider_units, mark_
-- provider_outcome_unknown, expire_stale_provider_reservations) irnak
-- a signal_run_provider_usage tablaba, ami EBBEN a migracioban jon
-- letre — ezert csak itt definialhatok, miutan minden fuggo tabla
-- (058, 059, 060, 061) mar letezik.
--
-- A function-letezes/drift ellenorzese HAROM-agu (nem ket-agu, mint a
-- tablaknal), mert Postgres-ben egy nev tobb szignaturaval (overload)
-- is letezhet:
--   - name_count = 0                              -> CREATE (biztosan uj)
--   - name_count = 1 ES pontos szignatura egyezik  -> VALIDATE (letezo, egyezo)
--   - barmi mas (0 < name_count, de nem pontos egyezes, vagy name_count > 1)
--                                                   -> EXCEPTION (varatlan overload/drift)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. UJ TABLA: signal_run_provider_usage
-- ============================================================

DO $migrate$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_run_provider_usage')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '061: signal_run_provider_usage does not exist — CREATE branch.';

    CREATE TABLE public.signal_run_provider_usage (
      id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id                   UUID NOT NULL REFERENCES public.signal_runs(id) ON DELETE RESTRICT,
      provider                 TEXT NOT NULL,
      usage_type               TEXT NOT NULL,
      attempts                 INTEGER NOT NULL DEFAULT 0,
      quota_units              INTEGER NOT NULL DEFAULT 0,
      successful_attempts      INTEGER NOT NULL DEFAULT 0,
      unknown_outcome_attempts INTEGER NOT NULL DEFAULT 0,
      failed_attempts          INTEGER NOT NULL DEFAULT 0,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT signal_run_provider_usage_key UNIQUE (run_id, provider, usage_type),
      CONSTRAINT signal_run_provider_usage_provider_check CHECK (provider IN ('youtube')),
      CONSTRAINT signal_run_provider_usage_type_check CHECK (usage_type IN ('discovery_search', 'observation_stats')),
      CONSTRAINT signal_run_provider_usage_attempts_nonneg CHECK (attempts >= 0),
      CONSTRAINT signal_run_provider_usage_quota_units_nonneg CHECK (quota_units >= 0),
      CONSTRAINT signal_run_provider_usage_successful_nonneg CHECK (successful_attempts >= 0),
      CONSTRAINT signal_run_provider_usage_unknown_nonneg CHECK (unknown_outcome_attempts >= 0),
      CONSTRAINT signal_run_provider_usage_failed_nonneg CHECK (failed_attempts >= 0),
      CONSTRAINT signal_run_provider_usage_components_match_attempts CHECK (
        successful_attempts + unknown_outcome_attempts + failed_attempts = attempts
      )
    );

    ALTER TABLE public.signal_run_provider_usage ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_run_provider_usage FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.signal_run_provider_usage TO service_role;

    RAISE NOTICE '061: signal_run_provider_usage created.';
  ELSE
    RAISE NOTICE '061: signal_run_provider_usage already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_run_provider_usage' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '061 drift: signal_run_provider_usage owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('run_id', 'uuid', 'uuid', 'NO', NULL),
        ('provider', 'text', 'text', 'NO', NULL),
        ('usage_type', 'text', 'text', 'NO', NULL),
        ('attempts', 'integer', 'int4', 'NO', '0'),
        ('quota_units', 'integer', 'int4', 'NO', '0'),
        ('successful_attempts', 'integer', 'int4', 'NO', '0'),
        ('unknown_outcome_attempts', 'integer', 'int4', 'NO', '0'),
        ('failed_attempts', 'integer', 'int4', 'NO', '0'),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('updated_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signal_run_provider_usage'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '061 drift: signal_run_provider_usage column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_run_provider_usage_attempts_nonneg', 'c', 'CHECK (attempts >= 0)'),
        ('signal_run_provider_usage_components_match_attempts', 'c', 'CHECK ((successful_attempts + unknown_outcome_attempts + failed_attempts) = attempts)'),
        ('signal_run_provider_usage_failed_nonneg', 'c', 'CHECK (failed_attempts >= 0)'),
        ('signal_run_provider_usage_key', 'u', 'UNIQUE (run_id, provider, usage_type)'),
        ('signal_run_provider_usage_pkey', 'p', 'PRIMARY KEY (id)'),
        ('signal_run_provider_usage_provider_check', 'c', 'CHECK (provider = ''youtube''::text)'),
        ('signal_run_provider_usage_quota_units_nonneg', 'c', 'CHECK (quota_units >= 0)'),
        ('signal_run_provider_usage_run_id_fkey', 'f', 'FOREIGN KEY (run_id) REFERENCES signal_runs(id) ON DELETE RESTRICT'),
        ('signal_run_provider_usage_successful_nonneg', 'c', 'CHECK (successful_attempts >= 0)'),
        ('signal_run_provider_usage_type_check', 'c', 'CHECK (usage_type = ANY (ARRAY[''discovery_search''::text, ''observation_stats''::text]))'),
        ('signal_run_provider_usage_unknown_nonneg', 'c', 'CHECK (unknown_outcome_attempts >= 0)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.signal_run_provider_usage'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '061 drift: signal_run_provider_usage constraint set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_run_provider_usage_key', 'true', 'CREATE UNIQUE INDEX signal_run_provider_usage_key ON public.signal_run_provider_usage USING btree (run_id, provider, usage_type)'),
        ('signal_run_provider_usage_pkey', 'true', 'CREATE UNIQUE INDEX signal_run_provider_usage_pkey ON public.signal_run_provider_usage USING btree (id)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.signal_run_provider_usage'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '061 drift: signal_run_provider_usage index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_run_provider_usage'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '061 drift: signal_run_provider_usage RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_run_provider_usage') THEN
      RAISE EXCEPTION '061 drift: signal_run_provider_usage has an unexpected policy';
    END IF;

    IF EXISTS (
      -- ld. 055 megjegyzeset: mindket EXCEPT-ag KULON zarojelben, kulonben
      -- balrol-jobbra ertekelodo UNION ALL csendben elnyelheti a driftet.
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_run_provider_usage' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_run_provider_usage' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '061 drift: signal_run_provider_usage service_role grant set is not exactly SELECT';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_run_provider_usage' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '061 drift: signal_run_provider_usage has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '061: signal_run_provider_usage already exists and matches exactly — no-op.';
  END IF;
END;
$migrate$;

-- ============================================================
-- 2. RPC: reserve_provider_units
-- ============================================================

DO $fn_reserve$
DECLARE
  v_name_count int;
  v_exact_oid oid;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reserve_provider_units';
  v_exact_oid := to_regprocedure('public.reserve_provider_units(text, text, text, uuid, text, text, integer, integer)');

  IF v_name_count = 0 THEN
    RAISE NOTICE '061: reserve_provider_units does not exist — CREATE branch.';

    CREATE FUNCTION public.reserve_provider_units(
      p_provider TEXT,
      p_usage_scope TEXT,
      p_usage_type TEXT,
      p_run_id UUID,
      p_phase TEXT,
      p_idempotency_key TEXT,
      p_units INTEGER,
      p_lease_seconds INTEGER DEFAULT 120
    ) RETURNS UUID
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_quota_date DATE;
  v_limit INTEGER;
  v_daily_budget_id UUID;
  v_reservation_id UUID;
BEGIN
  IF p_provider IS DISTINCT FROM 'youtube' THEN
    RAISE EXCEPTION 'reserve_provider_units: unsupported provider %', p_provider USING ERRCODE = 'P0001';
  END IF;
  IF p_usage_scope IS DISTINCT FROM 'background' THEN
    RAISE EXCEPTION 'reserve_provider_units: unsupported usage_scope %', p_usage_scope USING ERRCODE = 'P0001';
  END IF;
  IF p_usage_type NOT IN ('discovery_search', 'observation_stats') THEN
    RAISE EXCEPTION 'reserve_provider_units: unsupported usage_type %', p_usage_type USING ERRCODE = 'P0001';
  END IF;
  IF p_phase NOT IN ('observation', 'discovery') THEN
    RAISE EXCEPTION 'reserve_provider_units: unsupported phase %', p_phase USING ERRCODE = 'P0001';
  END IF;
  IF p_units IS NULL OR p_units <= 0 THEN
    RAISE EXCEPTION 'reserve_provider_units: units must be positive' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'reserve_provider_units: idempotency_key required' USING ERRCODE = 'P0001';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'reserve_provider_units: run_id required' USING ERRCODE = 'P0001';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 THEN
    RAISE EXCEPTION 'reserve_provider_units: lease_seconds must be positive' USING ERRCODE = 'P0001';
  END IF;

  -- Rogzitett pilot-limit usage_type szerint — a hivo NEM adhat meg
  -- tetszoleges limitet, csak ket ismert ertek egyike ervenyes.
  v_limit := CASE p_usage_type
    WHEN 'discovery_search' THEN 300
    WHEN 'observation_stats' THEN 200
  END;

  -- PT naptari nap — a hivo NEM adhatja meg kliens-parameterkent, a
  -- szerver szamitja `statement_timestamp()`-bol, hogy a napi limit ne
  -- kerulhessen meg mas datum megadasaval.
  v_quota_date := (timezone('America/Los_Angeles', statement_timestamp()))::date;

  INSERT INTO public.signal_provider_daily_budgets
    (provider, usage_scope, usage_type, quota_date, limit_units)
  VALUES (p_provider, p_usage_scope, p_usage_type, v_quota_date, v_limit)
  ON CONFLICT (provider, usage_scope, usage_type, quota_date) DO NOTHING;

  SELECT id INTO v_daily_budget_id
  FROM public.signal_provider_daily_budgets
  WHERE provider = p_provider AND usage_scope = p_usage_scope
    AND usage_type = p_usage_type AND quota_date = v_quota_date;

  -- Idempotens replay — ha mar letezik foglalas erre a kulcsra, azt
  -- adjuk vissza, UJ foglalas es UJ egysegnovekmeny nelkul.
  SELECT id INTO v_reservation_id
  FROM public.signal_provider_budget_reservations
  WHERE daily_budget_id = v_daily_budget_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_reservation_id;
  END IF;

  -- Atomikus, guarded foglalas — a WHERE zaradek maga a
  -- konkurenciavedelem (sor-zar + MVCC garantalja, hogy ket egyidejo
  -- hivas kozul csak annyi sikerul, amennyi tenylegesen belefer).
  UPDATE public.signal_provider_daily_budgets
  SET reserved_units = reserved_units + p_units, updated_at = now()
  WHERE id = v_daily_budget_id
    AND limit_units - reserved_units - committed_units >= p_units;

  IF NOT FOUND THEN
    RETURN NULL; -- kimerult keret — nincs hivas, a hivo kod nem folytathatja
  END IF;

  BEGIN
    INSERT INTO public.signal_provider_budget_reservations
      (daily_budget_id, run_id, phase, idempotency_key, requested_units, status, lease_expires_at)
    VALUES
      -- clock_timestamp() (valodi falion-idő), NEM now()/statement_timestamp() —
      -- a lease lejarati logikanak a tenyleges eltelt idot kell tükröznie akkor
      -- is, ha a hivo tranzakcio (elvben) hosszabb ideig nyitva marad; now()
      -- tranzakcio-konzisztens erteket adna, ami lease-szamitashoz nem
      -- megfelelo (csak a rekord-szintu created_at/committed_at/released_at
      -- mezoknel kivant a tranzakcio-konzisztencia, ott valtozatlanul now()).
      (v_daily_budget_id, p_run_id, p_phase, p_idempotency_key, p_units, 'reserved', clock_timestamp() + make_interval(secs => p_lease_seconds))
    RETURNING id INTO v_reservation_id;
  EXCEPTION WHEN unique_violation THEN
    -- Konkurens replay ugyanarra a kulcsra futott be kozben — a masik
    -- hivas nyert; a MOST feleslegesen hozzaadott egyseget vissza kell
    -- vonni (nincs duplan novelt reserved_units), majd a mar letezo
    -- sort adjuk vissza.
    UPDATE public.signal_provider_daily_budgets
    SET reserved_units = reserved_units - p_units, updated_at = now()
    WHERE id = v_daily_budget_id;

    SELECT id INTO v_reservation_id
    FROM public.signal_provider_budget_reservations
    WHERE daily_budget_id = v_daily_budget_id AND idempotency_key = p_idempotency_key;
    RETURN v_reservation_id;
  END;

  RETURN v_reservation_id;
END;

$body$;

    REVOKE ALL ON FUNCTION public.reserve_provider_units(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.reserve_provider_units(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, INTEGER) TO service_role;

    RAISE NOTICE '061: reserve_provider_units created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    RAISE NOTICE '061: reserve_provider_units already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = 'p_provider text, p_usage_scope text, p_usage_type text, p_run_id uuid, p_phase text, p_idempotency_key text, p_units integer, p_lease_seconds integer'
        AND pg_get_function_result(p.oid) = 'uuid'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND md5(p.prosrc) = '36ce8f65663df3b408f1d7a9db0cf252'
    ) THEN
      RAISE EXCEPTION '061 drift: reserve_provider_units definition (args/return/language/volatility/secdef/owner/search_path/body) does not match exactly';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'reserve_provider_units' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '061 drift: reserve_provider_units missing service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'reserve_provider_units' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '061 drift: reserve_provider_units has an unexpected EXECUTE grantee';
    END IF;

    RAISE NOTICE '061: reserve_provider_units already exists and matches exactly — no-op.';
  ELSE
    RAISE EXCEPTION '061 drift: reserve_provider_units exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$fn_reserve$;

-- ============================================================
-- 3. RPC: mark_provider_attempt_started
-- ============================================================

DO $fn_mark_started$
DECLARE
  v_name_count int;
  v_exact_oid oid;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mark_provider_attempt_started';
  v_exact_oid := to_regprocedure('public.mark_provider_attempt_started(uuid)');

  IF v_name_count = 0 THEN
    RAISE NOTICE '061: mark_provider_attempt_started does not exist — CREATE branch.';

    CREATE FUNCTION public.mark_provider_attempt_started(
      p_reservation_id UUID
    ) RETURNS BOOLEAN
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_row_count INTEGER;
BEGIN
  -- COALESCE => idempotens: ismetelt hivas, amig meg 'reserved', nem
  -- valtoztat semmit, de a WHERE talalatot ad, tehat true-t kapunk.
  -- Mar terminalis (nem 'reserved') sort SOSEM modosit.
  UPDATE public.signal_provider_budget_reservations
  SET attempt_started_at = COALESCE(attempt_started_at, now())
  WHERE id = p_reservation_id AND status = 'reserved';

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RETURN v_row_count > 0;
END;

$body$;

    REVOKE ALL ON FUNCTION public.mark_provider_attempt_started(UUID) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.mark_provider_attempt_started(UUID) TO service_role;

    RAISE NOTICE '061: mark_provider_attempt_started created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    RAISE NOTICE '061: mark_provider_attempt_started already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = 'p_reservation_id uuid'
        AND pg_get_function_result(p.oid) = 'boolean'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND md5(p.prosrc) = 'e10f65bb0801665a727b73fe2ae6e4f3'
    ) THEN
      RAISE EXCEPTION '061 drift: mark_provider_attempt_started definition does not match exactly';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'mark_provider_attempt_started' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '061 drift: mark_provider_attempt_started missing service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'mark_provider_attempt_started' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '061 drift: mark_provider_attempt_started has an unexpected EXECUTE grantee';
    END IF;

    RAISE NOTICE '061: mark_provider_attempt_started already exists and matches exactly — no-op.';
  ELSE
    RAISE EXCEPTION '061 drift: mark_provider_attempt_started exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$fn_mark_started$;

-- ============================================================
-- 4. RPC: commit_provider_units
-- ============================================================

DO $fn_commit$
DECLARE
  v_name_count int;
  v_exact_oid oid;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'commit_provider_units';
  v_exact_oid := to_regprocedure('public.commit_provider_units(uuid, integer)');

  IF v_name_count = 0 THEN
    RAISE NOTICE '061: commit_provider_units does not exist — CREATE branch.';

    CREATE FUNCTION public.commit_provider_units(
      p_reservation_id UUID,
      p_actual_units INTEGER
    ) RETURNS JSONB
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_res public.signal_provider_budget_reservations%ROWTYPE;
  v_provider TEXT;
  v_usage_type TEXT;
BEGIN
  SELECT * INTO v_res FROM public.signal_provider_budget_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commit_provider_units: reservation % not found', p_reservation_id USING ERRCODE = 'P0001';
  END IF;

  IF v_res.status IN ('committed', 'committed_unknown') THEN
    -- Dupla commit — stabil replay, NEM konyvel masodszor.
    RETURN jsonb_build_object(
      'reservation_id', v_res.id, 'status', v_res.status,
      'committed_units', v_res.committed_units, 'duplicate', true
    );
  END IF;

  IF v_res.status <> 'reserved' THEN
    RAISE EXCEPTION 'commit_provider_units: reservation % is not reserved (status=%)', p_reservation_id, v_res.status USING ERRCODE = 'P0001';
  END IF;
  IF v_res.attempt_started_at IS NULL THEN
    RAISE EXCEPTION 'commit_provider_units: reservation % has no attempt_started_at', p_reservation_id USING ERRCODE = 'P0001';
  END IF;
  IF p_actual_units IS NULL OR p_actual_units <= 0 OR p_actual_units > v_res.requested_units THEN
    RAISE EXCEPTION 'commit_provider_units: actual_units out of range (requested=%)', v_res.requested_units USING ERRCODE = 'P0001';
  END IF;

  SELECT provider, usage_type INTO v_provider, v_usage_type
  FROM public.signal_provider_daily_budgets WHERE id = v_res.daily_budget_id;

  UPDATE public.signal_provider_budget_reservations
  SET status = 'committed', committed_units = p_actual_units, committed_at = now()
  WHERE id = p_reservation_id AND status = 'reserved';

  UPDATE public.signal_provider_daily_budgets
  SET reserved_units = reserved_units - v_res.requested_units,
      committed_units = committed_units + p_actual_units,
      updated_at = now()
  WHERE id = v_res.daily_budget_id;

  INSERT INTO public.signal_run_provider_usage
    (run_id, provider, usage_type, attempts, quota_units, successful_attempts, unknown_outcome_attempts, failed_attempts)
  VALUES (v_res.run_id, v_provider, v_usage_type, 1, p_actual_units, 1, 0, 0)
  ON CONFLICT (run_id, provider, usage_type) DO UPDATE
    SET attempts = signal_run_provider_usage.attempts + 1,
        quota_units = signal_run_provider_usage.quota_units + p_actual_units,
        successful_attempts = signal_run_provider_usage.successful_attempts + 1,
        updated_at = now();

  RETURN jsonb_build_object('reservation_id', p_reservation_id, 'status', 'committed', 'committed_units', p_actual_units, 'duplicate', false);
END;

$body$;

    REVOKE ALL ON FUNCTION public.commit_provider_units(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.commit_provider_units(UUID, INTEGER) TO service_role;

    RAISE NOTICE '061: commit_provider_units created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    RAISE NOTICE '061: commit_provider_units already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = 'p_reservation_id uuid, p_actual_units integer'
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND md5(p.prosrc) = '3af19fd58f0b9ace1cc2fdec938f0782'
    ) THEN
      RAISE EXCEPTION '061 drift: commit_provider_units definition does not match exactly';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'commit_provider_units' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '061 drift: commit_provider_units missing service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'commit_provider_units' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '061 drift: commit_provider_units has an unexpected EXECUTE grantee';
    END IF;

    RAISE NOTICE '061: commit_provider_units already exists and matches exactly — no-op.';
  ELSE
    RAISE EXCEPTION '061 drift: commit_provider_units exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$fn_commit$;

-- ============================================================
-- 5. RPC: mark_provider_outcome_unknown
-- ============================================================

DO $fn_mark_unknown$
DECLARE
  v_name_count int;
  v_exact_oid oid;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mark_provider_outcome_unknown';
  v_exact_oid := to_regprocedure('public.mark_provider_outcome_unknown(uuid)');

  IF v_name_count = 0 THEN
    RAISE NOTICE '061: mark_provider_outcome_unknown does not exist — CREATE branch.';

    CREATE FUNCTION public.mark_provider_outcome_unknown(
      p_reservation_id UUID
    ) RETURNS JSONB
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_res public.signal_provider_budget_reservations%ROWTYPE;
  v_provider TEXT;
  v_usage_type TEXT;
BEGIN
  SELECT * INTO v_res FROM public.signal_provider_budget_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_provider_outcome_unknown: reservation % not found', p_reservation_id USING ERRCODE = 'P0001';
  END IF;

  IF v_res.status = 'committed_unknown' THEN
    RETURN jsonb_build_object('reservation_id', v_res.id, 'status', v_res.status, 'duplicate', true);
  END IF;
  IF v_res.status <> 'reserved' THEN
    RAISE EXCEPTION 'mark_provider_outcome_unknown: reservation % is not reserved (status=%)', p_reservation_id, v_res.status USING ERRCODE = 'P0001';
  END IF;
  IF v_res.attempt_started_at IS NULL THEN
    RAISE EXCEPTION 'mark_provider_outcome_unknown: cannot mark unknown before attempt started' USING ERRCODE = 'P0001';
  END IF;

  SELECT provider, usage_type INTO v_provider, v_usage_type
  FROM public.signal_provider_daily_budgets WHERE id = v_res.daily_budget_id;

  UPDATE public.signal_provider_budget_reservations
  SET status = 'committed_unknown', committed_units = requested_units, committed_at = now()
  WHERE id = p_reservation_id AND status = 'reserved';

  -- A kvota ITT IS elveszettnek szamit — konzervativan committed, nincs visszaadas.
  UPDATE public.signal_provider_daily_budgets
  SET reserved_units = reserved_units - v_res.requested_units,
      committed_units = committed_units + v_res.requested_units,
      updated_at = now()
  WHERE id = v_res.daily_budget_id;

  INSERT INTO public.signal_run_provider_usage
    (run_id, provider, usage_type, attempts, quota_units, successful_attempts, unknown_outcome_attempts, failed_attempts)
  VALUES (v_res.run_id, v_provider, v_usage_type, 1, v_res.requested_units, 0, 1, 0)
  ON CONFLICT (run_id, provider, usage_type) DO UPDATE
    SET attempts = signal_run_provider_usage.attempts + 1,
        quota_units = signal_run_provider_usage.quota_units + v_res.requested_units,
        unknown_outcome_attempts = signal_run_provider_usage.unknown_outcome_attempts + 1,
        updated_at = now();

  RETURN jsonb_build_object('reservation_id', p_reservation_id, 'status', 'committed_unknown', 'duplicate', false);
END;

$body$;

    REVOKE ALL ON FUNCTION public.mark_provider_outcome_unknown(UUID) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.mark_provider_outcome_unknown(UUID) TO service_role;

    RAISE NOTICE '061: mark_provider_outcome_unknown created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    RAISE NOTICE '061: mark_provider_outcome_unknown already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = 'p_reservation_id uuid'
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND md5(p.prosrc) = '2d8efc407c3b4682004db52c5423e974'
    ) THEN
      RAISE EXCEPTION '061 drift: mark_provider_outcome_unknown definition does not match exactly';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'mark_provider_outcome_unknown' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '061 drift: mark_provider_outcome_unknown missing service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'mark_provider_outcome_unknown' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '061 drift: mark_provider_outcome_unknown has an unexpected EXECUTE grantee';
    END IF;

    RAISE NOTICE '061: mark_provider_outcome_unknown already exists and matches exactly — no-op.';
  ELSE
    RAISE EXCEPTION '061 drift: mark_provider_outcome_unknown exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$fn_mark_unknown$;

-- ============================================================
-- 6. RPC: release_provider_units
-- ============================================================

DO $fn_release$
DECLARE
  v_name_count int;
  v_exact_oid oid;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'release_provider_units';
  v_exact_oid := to_regprocedure('public.release_provider_units(uuid)');

  IF v_name_count = 0 THEN
    RAISE NOTICE '061: release_provider_units does not exist — CREATE branch.';

    CREATE FUNCTION public.release_provider_units(
      p_reservation_id UUID
    ) RETURNS BOOLEAN
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_res public.signal_provider_budget_reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_res FROM public.signal_provider_budget_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_res.status = 'released' THEN
    RETURN true; -- idempotens replay
  END IF;
  IF v_res.status <> 'reserved' THEN
    RAISE EXCEPTION 'release_provider_units: reservation % is not releasable (status=%)', p_reservation_id, v_res.status USING ERRCODE = 'P0001';
  END IF;
  IF v_res.attempt_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'release_provider_units: cannot voluntarily release a reservation whose attempt already started' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.signal_provider_budget_reservations
  SET status = 'released', released_at = now()
  WHERE id = p_reservation_id AND status = 'reserved';

  UPDATE public.signal_provider_daily_budgets
  SET reserved_units = reserved_units - v_res.requested_units,
      released_units_total = released_units_total + v_res.requested_units,
      updated_at = now()
  WHERE id = v_res.daily_budget_id;

  RETURN true;
END;

$body$;

    REVOKE ALL ON FUNCTION public.release_provider_units(UUID) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.release_provider_units(UUID) TO service_role;

    RAISE NOTICE '061: release_provider_units created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    RAISE NOTICE '061: release_provider_units already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = 'p_reservation_id uuid'
        AND pg_get_function_result(p.oid) = 'boolean'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND md5(p.prosrc) = 'da4ec39e3b20211e0a8f9c77e6bd7231'
    ) THEN
      RAISE EXCEPTION '061 drift: release_provider_units definition does not match exactly';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'release_provider_units' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '061 drift: release_provider_units missing service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'release_provider_units' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '061 drift: release_provider_units has an unexpected EXECUTE grantee';
    END IF;

    RAISE NOTICE '061: release_provider_units already exists and matches exactly — no-op.';
  ELSE
    RAISE EXCEPTION '061 drift: release_provider_units exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$fn_release$;

-- ============================================================
-- 7. RPC: expire_stale_provider_reservations (VEGLEGES, egyetlen
--    definicio — nincs koztes v1, nincs CREATE OR REPLACE csere).
-- ============================================================

DO $fn_expire$
DECLARE
  v_name_count int;
  v_exact_oid oid;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'expire_stale_provider_reservations';
  v_exact_oid := to_regprocedure('public.expire_stale_provider_reservations(text)');

  IF v_name_count = 0 THEN
    RAISE NOTICE '061: expire_stale_provider_reservations does not exist — CREATE branch.';

    CREATE FUNCTION public.expire_stale_provider_reservations(
      p_provider TEXT DEFAULT NULL
    ) RETURNS INTEGER
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_lock_key BIGINT := hashtextextended('signal_provider_reservation_sweep', 0);
  v_got_lock BOOLEAN;
  v_row RECORD;
  v_provider TEXT;
  v_usage_type TEXT;
  v_count INTEGER := 0;
BEGIN
  v_got_lock := pg_try_advisory_xact_lock(v_lock_key);
  IF NOT v_got_lock THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT r.* FROM public.signal_provider_budget_reservations r
    WHERE r.status = 'reserved' AND r.lease_expires_at < clock_timestamp()
      AND (p_provider IS NULL OR EXISTS (
        SELECT 1 FROM public.signal_provider_daily_budgets d
        WHERE d.id = r.daily_budget_id AND d.provider = p_provider
      ))
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    IF v_row.attempt_started_at IS NULL THEN
      UPDATE public.signal_provider_budget_reservations
      SET status = 'expired_unstarted', released_at = now()
      WHERE id = v_row.id AND status = 'reserved';

      UPDATE public.signal_provider_daily_budgets
      SET reserved_units = reserved_units - v_row.requested_units,
          released_units_total = released_units_total + v_row.requested_units,
          updated_at = now()
      WHERE id = v_row.daily_budget_id;
    ELSE
      UPDATE public.signal_provider_budget_reservations
      SET status = 'committed_unknown', committed_units = v_row.requested_units, committed_at = now()
      WHERE id = v_row.id AND status = 'reserved';

      UPDATE public.signal_provider_daily_budgets
      SET reserved_units = reserved_units - v_row.requested_units,
          committed_units = committed_units + v_row.requested_units,
          updated_at = now()
      WHERE id = v_row.daily_budget_id;

      SELECT provider, usage_type INTO v_provider, v_usage_type
      FROM public.signal_provider_daily_budgets WHERE id = v_row.daily_budget_id;

      INSERT INTO public.signal_run_provider_usage
        (run_id, provider, usage_type, attempts, quota_units, successful_attempts, unknown_outcome_attempts, failed_attempts)
      VALUES (v_row.run_id, v_provider, v_usage_type, 1, v_row.requested_units, 0, 1, 0)
      ON CONFLICT (run_id, provider, usage_type) DO UPDATE
        SET attempts = signal_run_provider_usage.attempts + 1,
            quota_units = signal_run_provider_usage.quota_units + v_row.requested_units,
            unknown_outcome_attempts = signal_run_provider_usage.unknown_outcome_attempts + 1,
            updated_at = now();
    END IF;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;

$body$;

    REVOKE ALL ON FUNCTION public.expire_stale_provider_reservations(TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.expire_stale_provider_reservations(TEXT) TO service_role;

    RAISE NOTICE '061: expire_stale_provider_reservations created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    RAISE NOTICE '061: expire_stale_provider_reservations already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = 'p_provider text'
        AND pg_get_function_result(p.oid) = 'integer'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND md5(p.prosrc) = '49de87d163f5c31b216e357f675bbb08'
    ) THEN
      RAISE EXCEPTION '061 drift: expire_stale_provider_reservations definition does not match exactly';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'expire_stale_provider_reservations' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '061 drift: expire_stale_provider_reservations missing service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'expire_stale_provider_reservations' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '061 drift: expire_stale_provider_reservations has an unexpected EXECUTE grantee';
    END IF;

    RAISE NOTICE '061: expire_stale_provider_reservations already exists and matches exactly — no-op.';
  ELSE
    RAISE EXCEPTION '061 drift: expire_stale_provider_reservations exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$fn_expire$;

NOTIFY pgrst, 'reload schema';

COMMIT;
