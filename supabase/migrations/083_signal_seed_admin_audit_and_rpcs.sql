-- ============================================================
-- Migration 083: PFM Collector Seed Admin v0 -- audit, idempotency and
-- rollback contract.
--
-- Zarja le a "PFM Collector Seed Admin v0 -- Audit, Idempotency and
-- Rollback Contract Remediation Gate" tervet. Additiv migracio -- nem
-- modositja a meglevo, kezzel beszurt production seed sort, nem general
-- hozza hamis 'created' eventet arra a sorra.
--
-- Uj objektumok:
--   signal_seed_admin_idempotency_ledger  -- kulon ledger, nem osztott a
--                                             supervised-intake alrendszerrel
--   signal_seed_queue_events              -- append-only audit (csak SELECT
--                                             grant service_role-nak, iras
--                                             kizarolag a SECURITY DEFINER
--                                             RPC-ken keresztul)
--   register_signal_seed(...)             -- uj seed felvetele
--   deactivate_signal_seed(...)            -- meglevo seed deaktivalasa
--
-- Grant-audit (Column-Level Grant Remediation gate): signal_seed_queue-n a
-- service_role jelenleg INSERT+SELECT+UPDATE-et kap (055). A mukodo
-- collector kod (lib/emerging-signal/seed-selection.ts) kizarolag SELECT-et
-- es -- a markDiscoverySeedSuccess/Failure -> updateSeed() fuggvenyen
-- keresztul -- PONTOSAN negy oszlopra ir UPDATE-et: next_due_at,
-- last_run_at, consecutive_failure_count, updated_at (kozvetlen forraskod-
-- olvasassal igazolva, ld. seed-selection.ts updateSeed()). Semmilyen
-- alkalmazas-kod nem ir kozvetlen INSERT-et ebbe a tablaba, es semmilyen
-- alkalmazas-kod nem ir semelyik katalogus-identitasi mezot
-- (active/seed_fingerprint/seed_text/category/region/language/seed_type).
--
-- Az eredeti (v1) migracio tablaszintu UPDATE-et hagyott a service_role-nak
-- -- ez egy audit-megkerulesi res volt: egy service_role-hitelesitett
-- kozvetlen PostgREST-hivas csendben felulirhatta volna pl. az active-et
-- vagy a seed_text-et, teljesen megkerulve a register/deactivate RPC-k
-- audit-naplozasat. Ez a javitas oszlopszintu GRANT-ra szukiti a
-- service_role UPDATE-jogat -- kizarolag a negy, forraskoddal bizonyitott
-- scheduler-oszlopra. Az INSERT jog biztonsagosan visszavonhato marad --
-- az EGYETLEN irasi ut a register_signal_seed SECURITY DEFINER RPC, ami a
-- tabla-szintu grantot mar meg sem latja (postgres tulajdonoskent fut).
--
-- Fingerprint-kontraktus (nem ismetelve PL/pgSQL-ben): a
-- computeFingerprint() (lib/emerging-signal/fingerprint.ts) kizarolag
-- category+seed_text-bol szamol -- region/language/seed_type NEM resze.
-- Ezert egy naiv ON CONFLICT (seed_fingerprint) DO NOTHING csendben
-- elfogadna egy eltero region/language/seed_type-u kerelmet -- a
-- register_signal_seed ezert MINDIG explicit payload-osszehasonlitast
-- vegez egy fingerprint-utkozes eseten, sosem bizik az ON CONFLICT-ban.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. GRANT-AUDIT: signal_seed_queue -- INSERT visszavonasa, es a
--    tablaszintu UPDATE oszlopszintu UPDATE-re szukitese service_role-nal.
-- ============================================================
DO $$
DECLARE
  v_update_columns TEXT[];
  v_expected_update_columns CONSTANT TEXT[] := ARRAY['consecutive_failure_count', 'last_run_at', 'next_due_at', 'updated_at'];
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_seed_queue'
      AND grantee = 'service_role' AND privilege_type = 'INSERT'
  ) THEN
    REVOKE INSERT ON public.signal_seed_queue FROM service_role;
    RAISE NOTICE '083: signal_seed_queue INSERT revoked from service_role.';
  ELSE
    RAISE NOTICE '083: signal_seed_queue INSERT already absent for service_role -- no-op.';
  END IF;

  -- Tablaszintu UPDATE sosem maradhat -- ez az audit-megkerulesi res.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_seed_queue'
      AND grantee = 'service_role' AND privilege_type = 'UPDATE'
  ) THEN
    REVOKE UPDATE ON public.signal_seed_queue FROM service_role;
    RAISE NOTICE '083: signal_seed_queue table-level UPDATE revoked from service_role.';
  ELSE
    RAISE NOTICE '083: signal_seed_queue table-level UPDATE already absent for service_role -- no-op.';
  END IF;

  -- Oszlopszintu GRANT -- a GRANT onmagaban idempotens (biztonsagos
  -- ujra-futtatni), ezert feltetel nelkul, minden futasnal kiadva.
  GRANT UPDATE (next_due_at, last_run_at, consecutive_failure_count, updated_at)
    ON public.signal_seed_queue TO service_role;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_seed_queue'
      AND grantee = 'service_role' AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION '083 drift: signal_seed_queue must retain service_role SELECT -- aborting.';
  END IF;

  -- Vegallapot-igazolas: SEMMILYEN tablaszintu INSERT/UPDATE/DELETE/
  -- TRUNCATE nem lehet a service_role-nal (csak SELECT).
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_seed_queue'
      AND grantee = 'service_role' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION '083 drift: signal_seed_queue must NOT have any table-level INSERT/UPDATE/DELETE/TRUNCATE grant for service_role -- aborting.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_seed_queue'
      AND grantee = 'service_role' AND privilege_type NOT IN ('SELECT')
  ) THEN
    RAISE EXCEPTION '083 drift: signal_seed_queue service_role table-level grant set is not exactly SELECT -- aborting.';
  END IF;

  -- Vegallapot-igazolas: az oszlopszintu UPDATE PONTOSAN a negy
  -- scheduler-oszlopra all -- se tobb, se kevesebb.
  SELECT array_agg(DISTINCT column_name ORDER BY column_name) INTO v_update_columns
    FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'signal_seed_queue'
      AND grantee = 'service_role' AND privilege_type = 'UPDATE';
  IF v_update_columns IS DISTINCT FROM v_expected_update_columns THEN
    RAISE EXCEPTION '083 drift: signal_seed_queue service_role column-level UPDATE grant set is not exactly % (got %) -- aborting.', v_expected_update_columns, v_update_columns;
  END IF;

  -- Defense-in-depth: explicit negativ ellenorzes minden katalogus-
  -- identitasi mezore, meg akkor is, ha a fenti egyezes-ellenorzes ezt mar
  -- lefedte -- egy jovobeli oszlop-atnevezes/bovites sem csusztathat at
  -- csendben egy tiltott mezot.
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'signal_seed_queue'
      AND grantee = 'service_role' AND privilege_type = 'UPDATE'
      AND column_name IN ('id', 'seed_fingerprint', 'seed_type', 'seed_text', 'category', 'region', 'language', 'active', 'created_at')
  ) THEN
    RAISE EXCEPTION '083 drift: service_role must never hold UPDATE on a catalog-identity column of signal_seed_queue -- aborting.';
  END IF;
END $$;

-- ============================================================
-- 0b. seed_text hosszkorlat -- indokolt, fail-closed felso hatar.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'signal_seed_queue_seed_text_length'
      AND conrelid = 'public.signal_seed_queue'::regclass
  ) THEN
    ALTER TABLE public.signal_seed_queue
      ADD CONSTRAINT signal_seed_queue_seed_text_length CHECK (length(seed_text) <= 300);
    RAISE NOTICE '083: signal_seed_queue_seed_text_length constraint added.';
  ELSE
    RAISE NOTICE '083: signal_seed_queue_seed_text_length already present -- no-op.';
  END IF;
END $$;

-- ============================================================
-- 1. signal_seed_admin_idempotency_ledger -- kulon ledger a seed-admin
--    alrendszernek, nem osztott a supervised-intake-kel.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_seed_admin_idempotency_ledger') THEN
    RAISE NOTICE '083: signal_seed_admin_idempotency_ledger does not exist -- CREATE branch.';

    CREATE TABLE public.signal_seed_admin_idempotency_ledger (
      idempotency_key TEXT PRIMARY KEY,
      operation       TEXT NOT NULL,
      request_digest  TEXT NOT NULL,
      entity_id       UUID,
      replay_result   JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at    TIMESTAMPTZ,
      CONSTRAINT signal_seed_admin_idempotency_ledger_operation_check CHECK (operation IN ('register_seed', 'deactivate_seed')),
      CONSTRAINT signal_seed_admin_idempotency_ledger_digest_format CHECK (request_digest ~ '^[0-9a-f]{64}$')
    );

    ALTER TABLE public.signal_seed_admin_idempotency_ledger ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_seed_admin_idempotency_ledger FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.signal_seed_admin_idempotency_ledger TO service_role;

    RAISE NOTICE '083: signal_seed_admin_idempotency_ledger created.';
  ELSE
    RAISE NOTICE '083: signal_seed_admin_idempotency_ledger already exists -- VALIDATE branch (no DDL/DCL will run).';
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_seed_admin_idempotency_ledger'
        AND cl.relrowsecurity = true AND cl.relforcerowsecurity = true
    ) THEN
      RAISE EXCEPTION '083 drift: signal_seed_admin_idempotency_ledger RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_seed_admin_idempotency_ledger'
        AND (grantee IN ('anon', 'authenticated', 'PUBLIC') OR (grantee = 'service_role' AND privilege_type <> 'SELECT'))
    ) THEN
      RAISE EXCEPTION '083 drift: signal_seed_admin_idempotency_ledger grant set is not exactly service_role SELECT-only';
    END IF;
    RAISE NOTICE '083: signal_seed_admin_idempotency_ledger already exists and matches exactly -- no-op.';
  END IF;
END $$;

-- ============================================================
-- 2. signal_seed_queue_events -- append-only audit. Csak SELECT grant
--    service_role-nak -- iras kizarolag a SECURITY DEFINER RPC-ken
--    keresztul (postgres tulajdonos, a grant-korlatozas nem erinti).
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_seed_queue_events') THEN
    RAISE NOTICE '083: signal_seed_queue_events does not exist -- CREATE branch.';

    CREATE TABLE public.signal_seed_queue_events (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      seed_id             UUID NOT NULL REFERENCES public.signal_seed_queue(id) ON DELETE RESTRICT,
      event_kind          TEXT NOT NULL,
      reason_code         TEXT NOT NULL,
      operator_reference  TEXT NOT NULL,
      idempotency_key     TEXT NOT NULL,
      request_digest      TEXT NOT NULL,
      occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

      -- Zart szotar: event_kind es reason_code kombinacioja -- NULL/szabad
      -- szoveges reason sosem maradhat. 'created' MINDIG
      -- CURATED_CATALOG_REGISTRATION-t hordoz (v0-ban ez az EGYETLEN
      -- letrehozasi ut), 'deactivated' egy zart, valodi operacios
      -- ok-listabol jon.
      CONSTRAINT signal_seed_queue_events_kind_reason_check CHECK (
        (event_kind = 'created' AND reason_code = 'CURATED_CATALOG_REGISTRATION') OR
        (event_kind = 'deactivated' AND reason_code IN (
          'LOW_QUALITY_YIELD', 'DUPLICATE_COVERAGE', 'QUOTA_REDUCTION', 'OPERATOR_REQUESTED', 'PHASE_ROLLBACK'
        ))
      ),
      CONSTRAINT signal_seed_queue_events_operator_ref_format CHECK (operator_reference ~ '^[A-Za-z0-9._@-]{3,64}$'),
      CONSTRAINT signal_seed_queue_events_digest_format CHECK (request_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT signal_seed_queue_events_idempotency_key_not_blank CHECK (btrim(idempotency_key) <> ''),
      -- Defense-in-depth (5. pont): egy idempotency_key legfeljebb EGY
      -- eventet hozhat letre -- egy replay sosem ir uj sort.
      CONSTRAINT signal_seed_queue_events_idempotency_key_unique UNIQUE (idempotency_key)
    );

    CREATE INDEX idx_signal_seed_queue_events_seed_id ON public.signal_seed_queue_events(seed_id);

    ALTER TABLE public.signal_seed_queue_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_seed_queue_events FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.signal_seed_queue_events TO service_role;

    RAISE NOTICE '083: signal_seed_queue_events created.';
  ELSE
    RAISE NOTICE '083: signal_seed_queue_events already exists -- VALIDATE branch (no DDL/DCL will run).';
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_seed_queue_events'
        AND cl.relrowsecurity = true AND cl.relforcerowsecurity = true
    ) THEN
      RAISE EXCEPTION '083 drift: signal_seed_queue_events RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_seed_queue_events'
        AND (grantee IN ('anon', 'authenticated', 'PUBLIC') OR (grantee = 'service_role' AND privilege_type <> 'SELECT'))
    ) THEN
      RAISE EXCEPTION '083 drift: signal_seed_queue_events grant set is not exactly service_role SELECT-only';
    END IF;
    RAISE NOTICE '083: signal_seed_queue_events already exists and matches exactly -- no-op.';
  END IF;
END $$;

-- ============================================================
-- 3. register_signal_seed -- uj seed felvetele.
--
-- Lock-sorrend (determinisztikus, dokumentalt, MINDIG ez a sorrend
-- register_signal_seed-ben ES deactivate_signal_seed-ben egyarant --
-- deadlock kizarva, mert minden hivo ugyanabban a sorrendben zarolja):
--   1) pg_advisory_xact_lock(hashtextextended(fingerprint, 41))
--   2) pg_advisory_xact_lock(hashtextextended(idempotency_key, 42))
-- A tranzakcio vegen (commit/rollback) mindket zar automatikusan
-- felszabadul. Igy ket konkurens, kliensoldali retry nelkuli RPC-hivas
-- soha nem futhat at egy valodi unique_violation-be: a masodik hivo
-- egyszeruen kivarja az elsot, majd a mar bejegyzett sor alapjan
-- determinisztikus replay/already_exists-et kap.
--
-- Request digest (4. pont, verziozott es domain-separated, dokumentalt
-- mezosorrend): domain, operation, fingerprint, teljes seed-payload
-- (seed_text, category, region, language, seed_type), operator_reference,
-- contract_version. A digestet MINDIG az RPC szamolja a sajat parametereibol
-- -- a hivo sosem adhatja at kesz digestkent.
-- ============================================================
CREATE OR REPLACE FUNCTION public.register_signal_seed(
  p_seed_text TEXT,
  p_category TEXT,
  p_region TEXT,
  p_language TEXT,
  p_seed_type TEXT,
  p_fingerprint TEXT,
  p_operator_reference TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $rpc$
DECLARE
  v_request_digest TEXT;
  v_ledger RECORD;
  v_existing RECORD;
  v_new_id UUID;
BEGIN
  IF p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'register_signal_seed: INVALID_FINGERPRINT_FORMAT' USING ERRCODE = 'P0001';
  END IF;
  IF p_operator_reference !~ '^[A-Za-z0-9._@-]{3,64}$' THEN
    RAISE EXCEPTION 'register_signal_seed: INVALID_OPERATOR_REFERENCE_FORMAT' USING ERRCODE = 'P0001';
  END IF;
  IF btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'register_signal_seed: INVALID_IDEMPOTENCY_KEY' USING ERRCODE = 'P0001';
  END IF;

  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format(
      '{"domain":%s,"operation":%s,"fingerprint":%s,"seed_text":%s,"category":%s,"region":%s,"language":%s,"seed_type":%s,"operator_reference":%s,"contract_version":%s}',
      to_json('willviral.emerging-signal.seed-admin'::text)::text,
      to_json('register_seed'::text)::text,
      to_json(p_fingerprint)::text,
      to_json(p_seed_text)::text,
      to_json(p_category)::text,
      to_json(p_region)::text,
      to_json(p_language)::text,
      to_json(p_seed_type)::text,
      to_json(p_operator_reference)::text,
      to_json('v1'::text)::text
    ),
    'UTF8')), 'hex');

  -- Determinisztikus lock-sorrend: fingerprint (41) mindig elobb, mint
  -- idempotency_key (42).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_fingerprint, 41));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key, 42));

  SELECT * INTO v_ledger FROM public.signal_seed_admin_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'register_signal_seed: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;

  INSERT INTO public.signal_seed_admin_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'register_seed', v_request_digest);

  SELECT * INTO v_existing FROM public.signal_seed_queue WHERE seed_fingerprint = p_fingerprint FOR UPDATE;
  IF FOUND THEN
    -- Fingerprint-utkozes: bitpontos payload-osszehasonlitas -- az
    -- ON CONFLICT DO NOTHING onmagaban NEM hasznalhato, mert a
    -- fingerprint nem fedi le region/language/seed_type-ot.
    IF v_existing.seed_text IS DISTINCT FROM p_seed_text
      OR v_existing.category IS DISTINCT FROM p_category
      OR v_existing.region IS DISTINCT FROM p_region
      OR v_existing.language IS DISTINCT FROM p_language
      OR v_existing.seed_type IS DISTINCT FROM p_seed_type
    THEN
      RAISE EXCEPTION 'register_signal_seed: FINGERPRINT_PAYLOAD_CONFLICT -- fingerprint % already exists with a different payload', p_fingerprint USING ERRCODE = 'P0001';
    END IF;

    -- Azonos payload -- determinisztikus replay. Az inaktiv seedet
    -- SOSEM aktivaljuk vissza itt -- ez tisztan informacios visszajelzes,
    -- nincs UPDATE a signal_seed_queue-n.
    UPDATE public.signal_seed_admin_idempotency_ledger
      SET replay_result = jsonb_build_object('ok', true, 'outcome', 'already_exists', 'seed_id', v_existing.id, 'active', v_existing.active),
          entity_id = v_existing.id, completed_at = now()
      WHERE idempotency_key = p_idempotency_key;

    RETURN jsonb_build_object('ok', true, 'outcome', 'already_exists', 'seed_id', v_existing.id, 'active', v_existing.active);
  END IF;

  -- Genuinely uj fingerprint -- letrehozas.
  INSERT INTO public.signal_seed_queue (seed_fingerprint, seed_type, seed_text, category, region, language)
    VALUES (p_fingerprint, p_seed_type, p_seed_text, p_category, p_region, p_language)
    RETURNING id INTO v_new_id;

  INSERT INTO public.signal_seed_queue_events (seed_id, event_kind, reason_code, operator_reference, idempotency_key, request_digest)
    VALUES (v_new_id, 'created', 'CURATED_CATALOG_REGISTRATION', p_operator_reference, p_idempotency_key, v_request_digest);

  UPDATE public.signal_seed_admin_idempotency_ledger
    SET replay_result = jsonb_build_object('ok', true, 'outcome', 'created', 'seed_id', v_new_id, 'active', true),
        entity_id = v_new_id, completed_at = now()
    WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('ok', true, 'outcome', 'created', 'seed_id', v_new_id, 'active', true);
END;
$rpc$;

REVOKE ALL ON FUNCTION public.register_signal_seed(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_signal_seed(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ============================================================
-- 4. deactivate_signal_seed -- pontos fingerprinttel celzott
--    active->inactive atmenet. Nincs DELETE, nincs reactivate.
-- ============================================================
CREATE OR REPLACE FUNCTION public.deactivate_signal_seed(
  p_target_seed_fingerprint TEXT,
  p_reason_code TEXT,
  p_operator_reference TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $rpc$
DECLARE
  v_request_digest TEXT;
  v_ledger RECORD;
  v_seed RECORD;
  v_prior_digest TEXT;
BEGIN
  IF p_target_seed_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'deactivate_signal_seed: INVALID_FINGERPRINT_FORMAT' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason_code NOT IN ('LOW_QUALITY_YIELD', 'DUPLICATE_COVERAGE', 'QUOTA_REDUCTION', 'OPERATOR_REQUESTED', 'PHASE_ROLLBACK') THEN
    RAISE EXCEPTION 'deactivate_signal_seed: INVALID_REASON_CODE -- %', p_reason_code USING ERRCODE = 'P0001';
  END IF;
  IF p_operator_reference !~ '^[A-Za-z0-9._@-]{3,64}$' THEN
    RAISE EXCEPTION 'deactivate_signal_seed: INVALID_OPERATOR_REFERENCE_FORMAT' USING ERRCODE = 'P0001';
  END IF;
  IF btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'deactivate_signal_seed: INVALID_IDEMPOTENCY_KEY' USING ERRCODE = 'P0001';
  END IF;

  v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
    format(
      '{"domain":%s,"operation":%s,"fingerprint":%s,"reason_code":%s,"operator_reference":%s,"contract_version":%s}',
      to_json('willviral.emerging-signal.seed-admin'::text)::text,
      to_json('deactivate_seed'::text)::text,
      to_json(p_target_seed_fingerprint)::text,
      to_json(p_reason_code)::text,
      to_json(p_operator_reference)::text,
      to_json('v1'::text)::text
    ),
    'UTF8')), 'hex');

  -- Ugyanaz a determinisztikus lock-sorrend, mint register_signal_seed-ben.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_target_seed_fingerprint, 41));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key, 42));

  SELECT * INTO v_ledger FROM public.signal_seed_admin_idempotency_ledger WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_ledger.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'deactivate_signal_seed: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN v_ledger.replay_result;
  END IF;

  INSERT INTO public.signal_seed_admin_idempotency_ledger (idempotency_key, operation, request_digest)
    VALUES (p_idempotency_key, 'deactivate_seed', v_request_digest);

  SELECT * INTO v_seed FROM public.signal_seed_queue WHERE seed_fingerprint = p_target_seed_fingerprint FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deactivate_signal_seed: SEED_NOT_FOUND -- fingerprint %', p_target_seed_fingerprint USING ERRCODE = 'P0001';
  END IF;

  IF v_seed.active THEN
    UPDATE public.signal_seed_queue SET active = false, updated_at = now() WHERE id = v_seed.id;

    INSERT INTO public.signal_seed_queue_events (seed_id, event_kind, reason_code, operator_reference, idempotency_key, request_digest)
      VALUES (v_seed.id, 'deactivated', p_reason_code, p_operator_reference, p_idempotency_key, v_request_digest);

    UPDATE public.signal_seed_admin_idempotency_ledger
      SET replay_result = jsonb_build_object('ok', true, 'outcome', 'deactivated', 'seed_id', v_seed.id),
          entity_id = v_seed.id, completed_at = now()
      WHERE idempotency_key = p_idempotency_key;

    RETURN jsonb_build_object('ok', true, 'outcome', 'deactivated', 'seed_id', v_seed.id);
  END IF;

  -- Mar inaktiv -- azonos kerest (a legutobbi 'deactivated' esemeny
  -- request_digestjevel egyezo) replay-eljuk, elterot fail-closed
  -- hibaval zarjuk.
  SELECT request_digest INTO v_prior_digest FROM public.signal_seed_queue_events
    WHERE seed_id = v_seed.id AND event_kind = 'deactivated'
    ORDER BY occurred_at DESC LIMIT 1;

  IF v_prior_digest IS NOT NULL AND v_prior_digest = v_request_digest THEN
    UPDATE public.signal_seed_admin_idempotency_ledger
      SET replay_result = jsonb_build_object('ok', true, 'outcome', 'already_inactive_replay', 'seed_id', v_seed.id),
          entity_id = v_seed.id, completed_at = now()
      WHERE idempotency_key = p_idempotency_key;

    RETURN jsonb_build_object('ok', true, 'outcome', 'already_inactive_replay', 'seed_id', v_seed.id);
  END IF;

  RAISE EXCEPTION 'deactivate_signal_seed: ALREADY_INACTIVE_DIFFERENT_REQUEST -- seed % is already inactive from a different deactivation request', v_seed.id USING ERRCODE = 'P0001';
END;
$rpc$;

REVOKE ALL ON FUNCTION public.deactivate_signal_seed(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_signal_seed(TEXT, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
