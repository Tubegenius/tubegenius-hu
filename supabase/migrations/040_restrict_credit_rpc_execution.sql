-- ============================================================
-- Migration 040: Restrict credit-mutating RPC execution
--
-- A 030/037 migrációk REVOKE ALL ... FROM PUBLIC-ot futtattak a kredit-RPC-
-- ken, de ez nem törli az anon/authenticated szerepkörök KÜLÖN, közvetlen
-- EXECUTE grantjait, amit a Supabase (helyi CLI bootstrap, és feltehetően
-- korábban maga a production is, valamilyen dokumentálatlan lépéssel)
-- automatikusan ad minden új public-séma function-höz. Egy valódi lokális
-- rebuild ezt bizonyította: mind a hat kreditmutáló RPC anon/authenticated
-- szerepkörből is hívható volt egy friss adatbázison.
--
-- Ez a migráció KIZÁRÓLAG a hat, közvetlenül hívható kreditmutáló RPC
-- EXECUTE jogosultságát szigorítja a production tényleges, igazolt
-- állapotára (postgres + service_role, semmi más). Nem módosít function
-- body-t, search_path-ot, tulajdonost, és nem ad jogot semmilyen más
-- szerepkörnek.
--
-- A trigger-only handle_new_user_credits()/sync_credit_balance_from_buckets()
-- SZÁNDÉKOSAN kimarad — production-ban is nyitva vannak (PUBLIC), mert
-- NEW/OLD rekord nélkül, triggeren kívül nem hívhatók értelmesen, tehát
-- nem jelentenek tényleges kockázatot.
--
-- Overload-ellenőrzés: mind a hat function pontosan egy signature-rel
-- rendelkezik (nincs overload).
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.spend_credits(uuid, numeric, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.spend_credits(uuid, numeric, text, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.spend_credits(uuid, numeric, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.spend_credits(uuid, numeric, text, text, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.refund_credit_spend(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refund_credit_spend(uuid, uuid, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.refund_credit_spend(uuid, uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refund_credit_spend(uuid, uuid, text, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.apply_bucket_credit_event(uuid, numeric, text, numeric, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_bucket_credit_event(uuid, numeric, text, numeric, text, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.apply_bucket_credit_event(uuid, numeric, text, numeric, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_bucket_credit_event(uuid, numeric, text, numeric, text, text, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.apply_credit_event(uuid, numeric, numeric, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_credit_event(uuid, numeric, numeric, text, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.apply_credit_event(uuid, numeric, numeric, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_credit_event(uuid, numeric, numeric, text, text, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.increment_subscription_credits(uuid, numeric, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_subscription_credits(uuid, numeric, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_subscription_credits(uuid, numeric, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_subscription_credits(uuid, numeric, numeric) TO service_role;

REVOKE EXECUTE ON FUNCTION public.increment_topup_credits(uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_topup_credits(uuid, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_topup_credits(uuid, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_topup_credits(uuid, numeric) TO service_role;

-- Utóellenőrzés: a hat function egyikén se maradjon anon/authenticated/PUBLIC EXECUTE.
DO $$
DECLARE
  leaked RECORD;
  leak_count INT := 0;
BEGIN
  FOR leaked IN
    SELECT routine_name, grantee
    FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'spend_credits', 'refund_credit_spend', 'apply_bucket_credit_event',
        'apply_credit_event', 'increment_subscription_credits', 'increment_topup_credits'
      )
      AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  LOOP
    leak_count := leak_count + 1;
    RAISE WARNING 'unexpected EXECUTE grant remains: % -> %', leaked.routine_name, leaked.grantee;
  END LOOP;

  IF leak_count > 0 THEN
    RAISE EXCEPTION '% unexpected credit-RPC EXECUTE grant(s) remain after revoke', leak_count;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
