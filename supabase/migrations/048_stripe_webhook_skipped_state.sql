-- ============================================================
-- Migration 048: 'skipped' vegallapot a stripe_webhook_events tablahoz
--
-- CEL: a checkout.session.completed esemeny (subscription ES payment
-- mod) eddig ket felrevezeto modon zarult, ha a fizetes nem volt
-- 'paid':
--   - subscription ag: csendben "break", majd a switch utani lezaro
--     blokk feltetel nelkul 'completed'-re allitotta — mintha kredit
--     jart volna erte, holott nem tortent jovairas;
--   - payment (top-up) ag: explicit throw, ami 'failed'-re allitotta —
--     ez viszont az egyeni incidenskezelesi eljarasban minden 'failed'
--     checkout.session.completed-et azonnali incidensnek jelolne, holott
--     ez nem hiba, csak szandekosan kihagyott esemeny.
--
-- A webhook route (app/api/stripe/webhook/route.ts) mostantol egy
-- harmadik, dedikalt vegallapotot ir: 'skipped', egy gephetl
-- ertelmezheto skip_reason kiserovel. A canClaimFailedWebhook() logika
-- NEM bovul 'skipped'-re — ez egy legitim, vegleges dontes, nem hiba,
-- tehat nem Stripe-retry-jelolt.
--
-- HATOKOR — KIZAROLAG:
--   1) stripe_webhook_events.status CHECK constraint bovitese
--      ('processing','completed','failed') -> (...,'skipped') —
--      kizarolag akkor, ha a jelenlegi definicio PONTOSAN a lent
--      auditalt regi alak; barmely mas alaknal fail-fast, nem talalgat.
--   2) uj, nullable stripe_webhook_events.skip_reason TEXT oszlop, zart
--      ertekkeszlettel es azzal a megkotessel, hogy PONTOSAN akkor es
--      csak akkor NOT NULL, ha status='skipped'.
--   3) idx_stripe_webhook_events_status particionalt index cseréje
--      "WHERE status != 'completed'"-rol "WHERE status IN
--      ('processing', 'failed')"-re — a 'skipped' vegleges, nem
--      ujrafeldolgozando allapot, nem tartozik a "figyelendo" halmazba,
--      amit ez az index gyorsitani hivatott.
--
-- NEM resze: grant-valtozas (a tabla mar csak service_role-nak
-- elerheto, 044 ota valtozatlanul), RLS-valtozas, error_message
-- szemantika, event_id/external_ref dedup-logika, mas tabla/function.
--
-- FONTOS: a lenti "regi definicio" audit egy jol ismert PostgreSQL-
-- viselkedesre epul (CHECK (col IN (a,b,c)) tarolaskor mindig
-- "col = ANY (ARRAY[a,b,c])" alakra normalizalodik, pg_get_constraintdef
-- ezt adja vissza) — ha ez a helyi/production peldanyon barmiert mas,
-- a migracio a 0. szakaszban azonnal, a tenyleges (megfigyelt)
-- definiciot idezve all le, NEM probal talalgatni vagy eroltetni egy
-- feltetelezett alakot.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. AUDIT — a jelenlegi status CHECK constraint nevenek es pontos
--    definiciojanak befogasa. Nev-fuggetlen: a status oszlop attnum-ja
--    alapjan azonositjuk, nem egy feltetelezett constraint-nevvel.
--
--    Emellett a tabla TELJES grant-keszletenek (anon/authenticated/
--    service_role/postgres/PUBLIC) snapshotja is itt keszul — NEM azert,
--    mert ez a migracio grant-et valtoztatna (nem valtoztat), hanem hogy
--    a validacio bizonyithassa: a grantok a migracio utan BYTRA PONTOSAN
--    ugyanazok, mint elotte. (A helyi rebuildben az anon/authenticated
--    mar most is rendelkezik REFERENCES/TRIGGER/TRUNCATE grant-tal ezen
--    a tablan — ez a 045/046-ban dokumentalt legacy auto_expose_new_
--    tables local-bootstrap artefaktum, NEM resze ennek a migracionak,
--    kulon hardening-kor targya, ha egyaltalan szukseges.)
-- ============================================================

CREATE TEMP TABLE capture_048 (
  status_attnum smallint NOT NULL,
  status_conname text NOT NULL,
  status_condef text NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE grants_baseline_048 (
  grantee text NOT NULL,
  privilege_type text NOT NULL
) ON COMMIT DROP;

INSERT INTO grants_baseline_048 (grantee, privilege_type)
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events';

DO $capture$
DECLARE
  v_attnum smallint;
  v_conname text;
  v_condef text;
  v_match_count int;
BEGIN
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.stripe_webhook_events'::regclass
    AND attname = 'status' AND NOT attisdropped;

  IF v_attnum IS NULL THEN
    RAISE EXCEPTION '048 precondition failed: public.stripe_webhook_events.status column not found';
  END IF;

  SELECT count(*) INTO v_match_count
  FROM pg_constraint
  WHERE conrelid = 'public.stripe_webhook_events'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[v_attnum];

  IF v_match_count <> 1 THEN
    RAISE EXCEPTION '048 precondition failed: expected exactly 1 single-column CHECK constraint on stripe_webhook_events.status, found %. Refusing to guess which one to replace.', v_match_count;
  END IF;

  SELECT conname, pg_get_constraintdef(oid) INTO v_conname, v_condef
  FROM pg_constraint
  WHERE conrelid = 'public.stripe_webhook_events'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[v_attnum];

  INSERT INTO capture_048 (status_attnum, status_conname, status_condef)
  VALUES (v_attnum, v_conname, v_condef);
END;
$capture$;

-- ============================================================
-- 1. IDEMPOTENS CONSTRAINT-CSERE — csak PONTOSAN ismert regi vagy uj
--    definicion, minden mas eseten fail-fast (a tenyleges definiciot
--    idezve, nem csak "mismatch"-et jelezve).
-- ============================================================

DO $swap_constraint$
DECLARE
  v_conname text;
  v_condef text;
  v_expected_old text := 'CHECK ((status = ANY (ARRAY[''processing''::text, ''completed''::text, ''failed''::text])))';
  v_expected_new text := 'CHECK ((status = ANY (ARRAY[''processing''::text, ''completed''::text, ''failed''::text, ''skipped''::text])))';
BEGIN
  SELECT status_conname, status_condef INTO v_conname, v_condef FROM capture_048;

  IF v_condef = v_expected_new THEN
    RAISE NOTICE '048: status CHECK constraint already in the expected new state (%), skipping swap.', v_conname;
  ELSIF v_condef = v_expected_old THEN
    EXECUTE format('ALTER TABLE public.stripe_webhook_events DROP CONSTRAINT %I', v_conname);
    EXECUTE format(
      'ALTER TABLE public.stripe_webhook_events ADD CONSTRAINT %I CHECK (status IN (''processing'', ''completed'', ''failed'', ''skipped''))',
      v_conname
    );
  ELSE
    RAISE EXCEPTION '048 aborted: stripe_webhook_events status CHECK constraint (%) has an unexpected definition: %. This does not match either the known old or the known new definition — manual review required before migrating.', v_conname, v_condef;
  END IF;
END;
$swap_constraint$;

-- ============================================================
-- 2. skip_reason OSZLOP — idempotens hozzaadas + zart ertekkeszlet +
--    "csak es pontosan skipped-nel kotelezo" megkotes.
-- ============================================================

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS skip_reason TEXT;

DO $swap_skip_reason_constraints$
DECLARE
  v_pairing_exists boolean;
  v_enum_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.stripe_webhook_events'::regclass
      AND conname = 'stripe_webhook_events_skip_reason_pairing_check'
  ) INTO v_pairing_exists;

  IF NOT v_pairing_exists THEN
    ALTER TABLE public.stripe_webhook_events
      ADD CONSTRAINT stripe_webhook_events_skip_reason_pairing_check
      CHECK ((status = 'skipped') = (skip_reason IS NOT NULL));
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.stripe_webhook_events'::regclass
      AND conname = 'stripe_webhook_events_skip_reason_enum_check'
  ) INTO v_enum_exists;

  IF NOT v_enum_exists THEN
    ALTER TABLE public.stripe_webhook_events
      ADD CONSTRAINT stripe_webhook_events_skip_reason_enum_check
      CHECK (skip_reason IS NULL OR skip_reason IN (
        'unpaid_subscription_checkout',
        'no_payment_required_subscription',
        'unsupported_payment_status',
        'unpaid_topup_checkout',
        'no_payment_required_topup',
        'unsupported_topup_payment_status'
      ));
  END IF;
END;
$swap_skip_reason_constraints$;

-- ============================================================
-- 3. IDEMPOTENS INDEX-CSERE — a 'skipped' vegleges allapot, nem tartozik
--    a "figyelendo" (processing/failed) halmazba.
-- ============================================================

DO $swap_index$
DECLARE
  v_indexdef text;
  v_expected_old text := 'CREATE INDEX idx_stripe_webhook_events_status ON public.stripe_webhook_events USING btree (status) WHERE (status <> ''completed''::text)';
  v_expected_new text := 'CREATE INDEX idx_stripe_webhook_events_status ON public.stripe_webhook_events USING btree (status) WHERE (status = ANY (ARRAY[''processing''::text, ''failed''::text]))';
BEGIN
  SELECT indexdef INTO v_indexdef
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'stripe_webhook_events'
    AND indexname = 'idx_stripe_webhook_events_status';

  IF v_indexdef IS NULL THEN
    EXECUTE 'CREATE INDEX idx_stripe_webhook_events_status ON public.stripe_webhook_events (status) WHERE status IN (''processing'', ''failed'')';
  ELSIF v_indexdef = v_expected_new THEN
    RAISE NOTICE '048: idx_stripe_webhook_events_status already in the expected new state, skipping swap.';
  ELSIF v_indexdef = v_expected_old THEN
    EXECUTE 'DROP INDEX public.idx_stripe_webhook_events_status';
    EXECUTE 'CREATE INDEX idx_stripe_webhook_events_status ON public.stripe_webhook_events (status) WHERE status IN (''processing'', ''failed'')';
  ELSE
    RAISE EXCEPTION '048 aborted: idx_stripe_webhook_events_status has an unexpected definition: %. This does not match either the known old or the known new definition — manual review required before migrating.', v_indexdef;
  END IF;
END;
$swap_index$;

-- ============================================================
-- 4. FAIL-FAST VEGALLAPOT-VALIDACIO
-- ============================================================

DO $validate$
DECLARE
  v_condef text;
  v_is_nullable text;
  v_indexdef text;
  v_skip_reason_type text;
  v_skip_reason_nullable text;
  v_pairing_exists boolean;
  v_enum_exists boolean;
  v_missing_grant_count int;
  v_added_grant_count int;
BEGIN
  -- status CHECK a vart uj alakban
  SELECT pg_get_constraintdef(oid) INTO v_condef
  FROM pg_constraint
  WHERE conrelid = 'public.stripe_webhook_events'::regclass AND contype = 'c'
    AND conkey = ARRAY[(SELECT status_attnum FROM capture_048)];
  IF v_condef <> 'CHECK ((status = ANY (ARRAY[''processing''::text, ''completed''::text, ''failed''::text, ''skipped''::text])))' THEN
    RAISE EXCEPTION '048 validation failed: unexpected status CHECK definition after migration: %', v_condef;
  END IF;

  -- status tovabbra is NOT NULL
  SELECT is_nullable INTO v_is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events' AND column_name = 'status';
  IF v_is_nullable <> 'NO' THEN
    RAISE EXCEPTION '048 validation failed: stripe_webhook_events.status is nullable (expected NOT NULL)';
  END IF;

  -- skip_reason oszlop tipus/nullability
  SELECT data_type, is_nullable INTO v_skip_reason_type, v_skip_reason_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events' AND column_name = 'skip_reason';
  IF v_skip_reason_type IS DISTINCT FROM 'text' OR v_skip_reason_nullable <> 'YES' THEN
    RAISE EXCEPTION '048 validation failed: skip_reason column is not a nullable text column (type=%, nullable=%)', v_skip_reason_type, v_skip_reason_nullable;
  END IF;

  -- ket kiserő CHECK letezik
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.stripe_webhook_events'::regclass
      AND conname = 'stripe_webhook_events_skip_reason_pairing_check'
  ) INTO v_pairing_exists;
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.stripe_webhook_events'::regclass
      AND conname = 'stripe_webhook_events_skip_reason_enum_check'
  ) INTO v_enum_exists;
  IF NOT v_pairing_exists OR NOT v_enum_exists THEN
    RAISE EXCEPTION '048 validation failed: skip_reason companion CHECK constraint(s) missing (pairing=%, enum=%)', v_pairing_exists, v_enum_exists;
  END IF;

  -- index a vart uj alakban
  SELECT indexdef INTO v_indexdef
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'stripe_webhook_events' AND indexname = 'idx_stripe_webhook_events_status';
  IF v_indexdef <> 'CREATE INDEX idx_stripe_webhook_events_status ON public.stripe_webhook_events USING btree (status) WHERE (status = ANY (ARRAY[''processing''::text, ''failed''::text]))' THEN
    RAISE EXCEPTION '048 validation failed: unexpected idx_stripe_webhook_events_status definition after migration: %', v_indexdef;
  END IF;

  -- grantok byte-pontosan valtozatlanok a migracio elotti allapothoz kepest
  -- (nem abszolut "nulla anon/authenticated" allitas — az emlitett
  -- REFERENCES/TRIGGER/TRUNCATE mar a migracio ELOTT is jelen volt, ld.
  -- 0. szakasz megjegyzese — ez a validacio kizarolag azt bizonyitja, hogy
  -- 048 semmit nem valtoztatott ezen)
  SELECT count(*) INTO v_missing_grant_count
  FROM (
    SELECT grantee, privilege_type FROM grants_baseline_048
    EXCEPT
    SELECT grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events'
  ) missing;

  SELECT count(*) INTO v_added_grant_count
  FROM (
    SELECT grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events'
    EXCEPT
    SELECT grantee, privilege_type FROM grants_baseline_048
  ) added;

  IF v_missing_grant_count > 0 OR v_added_grant_count > 0 THEN
    RAISE EXCEPTION '048 validation failed: stripe_webhook_events grants changed during this migration (% missing, % added) — this migration must not alter grants', v_missing_grant_count, v_added_grant_count;
  END IF;
END;
$validate$;

COMMIT;
