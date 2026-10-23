-- ============================================================
-- RPC/migration-level test plan for migration 093
-- (public.spend_credits_and_save_paid_result + public.paid_operations)
-- ============================================================
-- STATUS: WRITTEN, NOT RUN -- NO PASS/FAIL RESULT EXISTS FOR THIS FILE.
-- Per explicit instruction, this file has NOT been executed against the
-- shared local Docker DB, any hosted staging project, or anywhere else.
-- Nothing below has been proven correct by actually running it -- the
-- `RAISE NOTICE 'PASS: ...'` strings inside each scenario are text that
-- WOULD print IF AND WHEN that scenario is executed and succeeds; they are
-- not a claim that it already has. Do not report any scenario in this file
-- as passing, confirmed, or verified until it has actually been run. It is
-- meant to run later, ONLY against a disposable, throwaway Postgres/
-- Supabase instance (spun up fresh for this test run, torn down after) --
-- never against the shared staging schema, even temporarily.
--
-- No pgTAP dependency: this repo has no existing SQL-test convention, so
-- this uses plain `DO $$ ... IF NOT (condition) THEN RAISE EXCEPTION ...
-- END $$;` blocks as self-contained assertions -- a RAISE EXCEPTION would
-- abort the script with a clear message if any check failed, WHEN RUN; no
-- output would mean every assertion in the file passed, WHEN RUN.
--
-- Fixture convention: each scenario creates its OWN throwaway auth.users
-- row (via a helper) so scenarios don't interfere with each other even if
-- run in one shared, disposable database. Nothing here assumes or depends
-- on any specific pre-existing data.
-- ============================================================

-- ── Fixture helper ───────────────────────────────────────────
-- Creates a throwaway user with a given starting credit balance (all
-- "purchased", for simplicity) and returns its id.
CREATE OR REPLACE FUNCTION pg_temp.make_test_user(p_balance NUMERIC)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_user_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_user_id, v_user_id::text || '@test.local');
  -- user_credits is expected to already exist via the handle_new_user_credits
  -- trigger (lib/credits.ts's own assumption, confirmed by spend_credits's
  -- "user credit row not found" exception path existing at all) -- if the
  -- trigger didn't fire for some reason, force the row here so the test
  -- fixture is self-contained regardless of trigger wiring.
  INSERT INTO public.user_credits (user_id, balance, purchased_credit_balance, subscription_credit_balance)
    VALUES (v_user_id, p_balance, p_balance, 0)
    ON CONFLICT (user_id) DO UPDATE SET
      balance = p_balance, purchased_credit_balance = p_balance, subscription_credit_balance = 0;
  RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.call_rpc(p_user_id UUID, p_input_hash TEXT, p_result JSONB DEFAULT '{"hook":"test"}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.spend_credits_and_save_paid_result(
    p_user_id, 'video_package_long', 6, jsonb_build_object('topic','t'),
    'video_package', p_input_hash, 'norm', 'orig',
    NULL, NULL, 'youtube', p_result, '{}'::jsonb, 6, now() + interval '24 hours',
    'anthropic', 'combined', 'video_package', 'v1', 0.15
  );
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- 1. Migráció jogosultságai -- csak service_role futtathatja
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE leak_count INT;
BEGIN
  SELECT count(*) INTO leak_count
  FROM information_schema.role_routine_grants
  WHERE routine_schema = 'public' AND routine_name = 'spend_credits_and_save_paid_result'
    AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF leak_count > 0 THEN
    RAISE EXCEPTION 'TEST FAILED: spend_credits_and_save_paid_result has % unexpected non-service_role grant(s)', leak_count;
  END IF;

  SELECT count(*) INTO leak_count
  FROM information_schema.role_routine_grants
  WHERE routine_schema = 'public' AND routine_name = 'spend_credits_and_save_paid_result' AND grantee = 'service_role';
  IF leak_count = 0 THEN
    RAISE EXCEPTION 'TEST FAILED: spend_credits_and_save_paid_result has NO service_role EXECUTE grant';
  END IF;

  -- RLS: paid_operations must have a SELECT-own policy and no other policies
  -- for non-service-role writers.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='paid_operations' AND policyname='paid_operations_select_own'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: paid_operations_select_own RLS policy missing';
  END IF;
  RAISE NOTICE 'PASS: migration grants/RLS as expected';
END $$;

-- ══════════════════════════════════════════════════════════════
-- 1b. FORCE RLS alatt a SECURITY DEFINER RPC ténylegesen ÍR tud a
--     paid_operations táblába, DE anon/authenticated KÖZVETLEN INSERT-je
--     nem tud -- explicit, külön bizonyítva, nem csak a 4. szcenárió
--     "duplicate" ellenőrzéséből következtetve.
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_user UUID := pg_temp.make_test_user(100);
  v_op_count INT;
BEGIN
  PERFORM pg_temp.call_rpc(v_user, 'hash-force-rls-write-proof');
  SELECT count(*) INTO v_op_count FROM public.paid_operations WHERE user_id = v_user;
  IF v_op_count <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: SECURITY DEFINER RPC did not write to paid_operations despite FORCE ROW LEVEL SECURITY (expected 1 row, got %)', v_op_count;
  END IF;
  RAISE NOTICE 'PASS: SECURITY DEFINER RPC writes to paid_operations despite FORCE ROW LEVEL SECURITY';
END $$;

DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    INSERT INTO public.paid_operations(operation_id, user_id, feature, tool_type, input_hash, credit_transaction_id, paid_result_id)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'video_package_long', 'video_package', 'anon-write-attempt', gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION 'TEST FAILED: anon direct INSERT into paid_operations SUCCEEDED (must be denied -- anon has zero grants on this table)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: anon direct INSERT into paid_operations correctly denied (insufficient_privilege)';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.paid_operations(operation_id, user_id, feature, tool_type, input_hash, credit_transaction_id, paid_result_id)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'video_package_long', 'video_package', 'authenticated-write-attempt', gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION 'TEST FAILED: authenticated direct INSERT into paid_operations SUCCEEDED (must be denied -- authenticated has SELECT-only grant on this table)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated direct INSERT into paid_operations correctly denied (insufficient_privilege)';
  END;
END $$;

-- ══════════════════════════════════════════════════════════════
-- 2. Elégtelen egyenleg -- NEM történik SEMMILYEN írás
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_user UUID := pg_temp.make_test_user(1); -- cost is 6, balance is 1 -- insufficient
  v_ledger_before INT;
  v_ledger_after INT;
  v_results_before INT;
  v_results_after INT;
  v_raised BOOLEAN := false;
BEGIN
  SELECT count(*) INTO v_ledger_before FROM public.credit_ledger WHERE user_id = v_user;
  SELECT count(*) INTO v_results_before FROM public.paid_results WHERE user_id = v_user;

  BEGIN
    PERFORM pg_temp.call_rpc(v_user, 'hash-insufficient-balance');
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    IF SQLERRM NOT ILIKE '%insufficient credits%' THEN
      RAISE EXCEPTION 'TEST FAILED: expected "insufficient credits", got: %', SQLERRM;
    END IF;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'TEST FAILED: expected an exception for insufficient balance, none raised';
  END IF;

  SELECT count(*) INTO v_ledger_after FROM public.credit_ledger WHERE user_id = v_user;
  SELECT count(*) INTO v_results_after FROM public.paid_results WHERE user_id = v_user;
  IF v_ledger_after <> v_ledger_before OR v_results_after <> v_results_before THEN
    RAISE EXCEPTION 'TEST FAILED: insufficient-balance attempt left behind ledger/paid_results rows (not fully rolled back)';
  END IF;
  RAISE NOTICE 'PASS: insufficient balance -- no charge, no save, fully rolled back';
END $$;

-- ══════════════════════════════════════════════════════════════
-- 3. Idegen/legacy, MÁR COMMITOLT completed sor ugyanarra a bemenetre --
--    (pl. egy a paid_operations bevezetése ELŐTTI, régi savePaidResult()
--    által írt sor) -- a lépés 2-nek EZT a levonás ELŐTT, user+status
--    szerint pontosan kell felismernie: nincs levonás, a meglévő sort adja
--    vissza. Ez a sima "egy másik sima INSERT korábban odaírt egy kész
--    sort" eset -- a VALÓDI, "a mi tranzakciónk már debitelt, és UTÁNA
--    ütközik" versenyhelyzet (lépés 5) két egyidejű munkamenetet igényel,
--    lásd 3b.
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_user UUID := pg_temp.make_test_user(100);
  v_balance_before NUMERIC;
  v_balance_after NUMERIC;
  v_result JSONB;
BEGIN
  INSERT INTO public.paid_results(user_id, tool_type, input_hash, normalized_input, original_input, result_json, status)
  VALUES (v_user, 'video_package', 'hash-foreign-completed', 'norm', 'orig', '{"hook":"someone else got there first"}'::jsonb, 'completed');

  SELECT balance INTO v_balance_before FROM public.user_credits WHERE user_id = v_user;
  v_result := pg_temp.call_rpc(v_user, 'hash-foreign-completed');
  IF NOT (v_result->>'duplicate')::boolean THEN
    RAISE EXCEPTION 'TEST FAILED: expected duplicate:true for a pre-existing completed row, got duplicate:false';
  END IF;

  SELECT balance INTO v_balance_after FROM public.user_credits WHERE user_id = v_user;
  IF v_balance_after <> v_balance_before THEN
    RAISE EXCEPTION 'TEST FAILED: balance changed even though an existing completed row should have short-circuited before any debit';
  END IF;
  RAISE NOTICE 'PASS: a pre-existing (foreign/legacy) completed row for the same input is detected BEFORE any debit';
END $$;

-- ══════════════════════════════════════════════════════════════
-- 3b. A VALÓDI "levonás UTÁN, de a paid_results INSERT-nél" ütközés --
--     NEM ebben a SQL-fájlban fut: a két párhuzamos OS-processzes
--     verseny a tests/093-video-package-atomic-charge-save-db-integration
--     .test.ts fájlban él, a VÁLTOZATLAN, valódi RPC-t egyetlen opaque
--     hívásként hívva (nem a lépéseit tükröző másolatot). Itt csak a
--     protokoll van rögzítve, hogy a két fájl ne szakadjon el egymástól.
--
-- Az egyetlen műszerezés egy TESZT-ONLY BEFORE INSERT trigger a
-- public.paid_results-on (csak az eldobható példányban létezik, a 093
-- migráció NEM tartalmazza), amely csak a marker input_hash-re ÉS csak az
-- `app.test093_barrier = 'on'` beállítást explicit bekapcsoló A munkamenetre
-- hat -- B saját, ütköztető INSERT-je nem váltja ki.
--
-- KÉZFOGÁS (szint-jelzések, nem esemény-jelzések): egy "elengedés" mint
-- jel elveszhet (ha A hamarabb ér a triggerig, mint B megszerezné a
-- zárat, A átfutna, és az ütközés elmaradna). Ezért mindkét oldal egy
-- pg_locks-ban MEGFIGYELHETŐ állapotot vár meg, és csak annak
-- visszaigazolása után lép tovább:
--   B: lock(K_B_HOLD)               -- B készenléte (szint)
--   A: VÁR, amíg a pg_locks-ban K_B_HOLD egy MÁSIK backendhez van rendelve
--      (határidős) -- CSAK EZUTÁN hívja a valódi RPC-t
--   A (az RPC-n belül, a paid_results INSERT-nél): a trigger előbb a saját,
--      nyitott tranzakcióján belül BIZONYÍTJA, hogy a debit már látszik
--      (credit_ledger sor + csökkent egyenleg, különben kivételt dob),
--      majd lock(K_A_AT_INSERT) [szint-jel], majd lock(K_B_HOLD) -- BLOKKOL
--   B: VÁR, amíg K_A_AT_INSERT egy másik backendhez van rendelve (határidős)
--      -- CSAK EZUTÁN INSERT-el (autocommit = commitolva), majd unlock(K_B_HOLD)
--   A: a trigger visszatér, a valódi INSERT ütközik B commitolt sorával ->
--      23505 -> az egész tranzakció (a debittel együtt) visszagördül.
--
-- A pg_sleep kizárólag a lekérdezés KADENCIÁJA (50 ms) a megfigyelő
-- ciklusban; a várt feltétel egy megfigyelt DB-állapot, határidővel
-- korlátozva -- nem időzítési feltevés. A teszt NOTICE-markerekkel
-- ellenőrzi, hogy minden visszaigazolási lépés ténylegesen lefutott.
-- ══════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════
-- 4. Elveszett RPC-válasz / idempotens visszajátszás -- UGYANAZZAL a
--    (user,tool_type,input_hash) kombinációval kétszer hívva a sikeres
--    hívást, a MÁSODIK hívás NEM von le újra, és a KORÁBBAN mentett
--    payloadot/paid_result_id-t/egyenleget adja vissza.
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_user UUID := pg_temp.make_test_user(100);
  v_first JSONB;
  v_second JSONB;
  v_balance_after_first NUMERIC;
  v_balance_after_second NUMERIC;
BEGIN
  v_first := pg_temp.call_rpc(v_user, 'hash-replay', '{"hook":"first and only real generation"}'::jsonb);
  IF (v_first->>'duplicate')::boolean THEN
    RAISE EXCEPTION 'TEST FAILED: first call should not be a duplicate';
  END IF;
  SELECT balance INTO v_balance_after_first FROM public.user_credits WHERE user_id = v_user;

  -- Simulates: the first call's RPC response was lost in transit, the
  -- caller retries with the SAME (user,tool_type,input_hash).
  v_second := pg_temp.call_rpc(v_user, 'hash-replay', '{"hook":"a DIFFERENT, wastefully-regenerated payload -- must be discarded"}'::jsonb);

  IF NOT (v_second->>'duplicate')::boolean THEN
    RAISE EXCEPTION 'TEST FAILED: second call with the same input_hash should be duplicate:true';
  END IF;
  IF (v_second->'paid_result'->>'id') IS DISTINCT FROM (v_first->'paid_result'->>'id') THEN
    RAISE EXCEPTION 'TEST FAILED: duplicate response returned a DIFFERENT paid_result_id than the original';
  END IF;
  IF (v_second->'paid_result'->'result_json'->>'hook') <> 'first and only real generation' THEN
    RAISE EXCEPTION 'TEST FAILED: duplicate response did not return the ORIGINAL saved payload -- got: %', v_second->'paid_result'->'result_json'->>'hook';
  END IF;

  SELECT balance INTO v_balance_after_second FROM public.user_credits WHERE user_id = v_user;
  IF v_balance_after_second <> v_balance_after_first THEN
    RAISE EXCEPTION 'TEST FAILED: balance changed on the duplicate (replay) call -- double charge';
  END IF;

  IF (SELECT count(*) FROM public.paid_operations WHERE user_id = v_user) <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: expected exactly 1 paid_operations row (audit of the one real commit), got %', (SELECT count(*) FROM public.paid_operations WHERE user_id = v_user);
  END IF;
  RAISE NOTICE 'PASS: duplicate/replay call returns the original payload, paid_result_id and unchanged balance -- no second charge';
END $$;

-- ══════════════════════════════════════════════════════════════
-- 5. "Azonos hash-ű, de nem completed régi sor" -- explicit hiba, nincs
--    levonás, nincs felülírás.
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_user UUID := pg_temp.make_test_user(100);
  v_balance_before NUMERIC;
  v_balance_after NUMERIC;
  v_raised BOOLEAN := false;
BEGIN
  INSERT INTO public.paid_results(user_id, tool_type, input_hash, normalized_input, original_input, result_json, status)
  VALUES (v_user, 'video_package', 'hash-stale-row', 'norm', 'orig', '{"hook":"never finished"}'::jsonb, 'failed');

  SELECT balance INTO v_balance_before FROM public.user_credits WHERE user_id = v_user;

  BEGIN
    PERFORM pg_temp.call_rpc(v_user, 'hash-stale-row');
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    IF SQLSTATE <> 'P0003' THEN
      RAISE EXCEPTION 'TEST FAILED: expected SQLSTATE P0003, got % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'TEST FAILED: expected an exception for the non-completed existing row, none raised';
  END IF;

  SELECT balance INTO v_balance_after FROM public.user_credits WHERE user_id = v_user;
  IF v_balance_after <> v_balance_before THEN
    RAISE EXCEPTION 'TEST FAILED: balance changed despite the explicit-stop contract for a non-completed existing row';
  END IF;

  IF (SELECT result_json->>'hook' FROM public.paid_results WHERE user_id=v_user AND input_hash='hash-stale-row') <> 'never finished' THEN
    RAISE EXCEPTION 'TEST FAILED: the stale row was overwritten -- it must be left untouched';
  END IF;
  RAISE NOTICE 'PASS: non-completed existing row -- explicit error, no charge, no overwrite';
END $$;

DO $$ BEGIN RAISE NOTICE 'All migration 093 RPC-level assertions in this file passed.'; END $$;
