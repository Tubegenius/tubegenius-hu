-- ============================================================
-- Migration 045: Harden function execution (EXECUTE grants + search_path)
--
-- A P0/1I audit (2026-07-24/25, kizarolag production pg_catalog/
-- information_schema export + Security Advisor, nulla felhasznaloi sor
-- olvasasabol) 8 olyan public-semabeli functiont azonositott, amelynek
-- soha semmilyen migracio nem futtatott explicit GRANT/REVOKE-ot: ezek
-- proacl-je NULL, es a Postgres SQL-szabvany implicit alapertelmezesere
-- (PUBLIC kap EXECUTE-ot) esnek vissza. Ez a mechanizmus MAS, mint a
-- 044-es tabla-grant sprawl (ott egy postgres-tulajdonu default-ACL
-- szabaly okozta a jelenseget) — itt nincs is postgres-tulajdonu
-- function-default-ACL productionben, csak egy supabase_admin-tulajdonu,
-- ami a postgres-kent futo migraciokra nem vonatkozik.
--
-- Ugyanez az audit 8 SECURITY DEFINER/INVOKER functiont talalt, ahol a
-- search_path parameter nincs pinnelve (production Security Advisor:
-- "Function Search Path Mutable", 8 talalat, helyi rebuilddal egyezoen).
--
-- HATOKOR — KIZAROLAG:
--   1) EXECUTE REVOKE FROM PUBLIC 7 functionon (lasd lent — a 8. talalt,
--      production Advisor altal is jelzett public.rls_auto_enable() NEM
--      resze ennek a migracionak, mert lokalisan meg nem letezik — a
--      letrehozasa es grant-hardeningje egyutt a 047-es kor feladata).
--   2) SET search_path = public, pg_temp 8 functionon (a fenti 7 + a mar
--      korabban is EXECUTE-szempontbol rendben levo increment_* ketto).
--
-- NEM resze: function body-, owner-, security mode-, return type- vagy
-- signature-valtoztatas; rls_auto_enable/ensure_rls letrehozasa; ALTER
-- DEFAULT PRIVILEGES; config.toml; function torles; policy/RLS/tabla
-- grant valtozas.
--
-- FONTOS DOKUMENTACIOS MEGJEGYZES — tudatos felulvizsgalat:
-- A 040_restrict_credit_rpc_execution.sql migracio (18-21. sor) explicit,
-- dokumentalt dontesként hagyta PUBLIC-nak handle_new_user_credits()-t es
-- sync_credit_balance_from_buckets()-et, azzal az indoklassal, hogy
-- "NEW/OLD rekord nelkul, triggeren kivul nem hivhatok ertelmesen, tehat
-- nem jelentenek tenyleges kockazatot." Ez a migracio ezt a korabbi
-- dontest SZANDEKOSAN felulirja defense-in-depth cellal (a production
-- Security Advisor mindket functiont onallo "Signed-In/Public Can Execute
-- SECURITY DEFINER Function" figyelmeztetesként jelzi). A felulirasa NEM
-- azert tortenik, mert a korabbi kockazatelemzes teves lett volna — az
-- akkor is csak azt allitotta, hogy a nyitva hagyas artalmatlan, nem azt,
-- hogy szukseges — hanem mert az egyseges least-privilege allapot tobbet
-- er, mint egy funkcionalisan indokolt kivetel fenntartasa.
--
-- TRIGGER-VEGREHAJTAS PONTOSITASA (ne "owner kontextus" altalanossagban):
--   - PostgreSQL egy trigger tuzeleser nem ellenorzi ujra a triggerelt
--     function EXECUTE grantjat a hivo (session) szerepkorere — a trigger
--     manager kozvetlenul hivja a functiont, fuggetlenul attol, hogy a
--     DML-t kivalto szerepkornek van-e EXECUTE joga magara a functionre.
--     Ezert a PUBLIC EXECUTE revoke nem akadalyozza a mar letrehozott
--     triggerek mukodeset.
--   - SECURITY DEFINER functionok (cleanup_expired_cache, handle_new_user,
--     handle_new_user_credits) a TULAJDONOS (postgres) jogosultsagaival
--     futnak, fuggetlenul a hivo szereplotol.
--   - SECURITY INVOKER functionok (sync_credit_balance_from_buckets,
--     update_tracked_competitors_updated_at, update_updated_at,
--     update_video_ideas_updated_at) a HIVO (a DML-t kivalto session)
--     jogosultsagi kontextusaban futnak — ez a mai allapotban is igy volt,
--     a revoke ezt nem valtoztatja meg, csak a KOZVETLEN, RPC-szeru hivas
--     lehetoseget zarja le.
--
-- Forras: production pg_catalog/information_schema export + Security
-- Advisor (2026-07-24/25), kizarolag metaadat-lekerdezesbol.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. REVOKE EXECUTE FROM PUBLIC — 7 function
--    (public.rls_auto_enable() kimarad — lokalisan meg nem letezik,
--    letrehozasa + grant-hardeningje egyutt a 047-es kor feladata)
-- ============================================================

-- MEGJEGYZES: a REVOKE minden esetben mind a negy lehetseges grantee-t
-- (PUBLIC, anon, authenticated, service_role) explicit celozza. A lokalis
-- Supabase CLI bootstrap ugyanis — a production allapottal ellentetben
-- (ott ezen a 7 functionon proacl IS NULL, azaz a service_role-nak
-- SOSEM volt kulon grantja) — minden uj public-semabeli functionhoz
-- automatikusan kulon, explicit EXECUTE-ot ad service_role-nak, a bare-
-- PUBLIC alapertelmezestol fuggetlenul. Ez maskent viselkedik, mint a
-- 044-ben mar dokumentalt auto_expose_new_tables (az anon/authenticated
-- Data API automatikus expozicioja) — kulon, itt eloszor dokumentalt
-- lokalis-only mechanizmus. Csak a PUBLIC-rol valo revoke ITT NEM lenne
-- elegendo, mert a service_role kulon, PUBLIC-tol fuggetlen sajat
-- ACL-bejegyzest kap helyben.
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_cache() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_cache() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_cache() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_cache() FROM service_role;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM service_role;

REVOKE EXECUTE ON FUNCTION public.handle_new_user_credits() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_credits() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_credits() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_credits() FROM service_role;

REVOKE EXECUTE ON FUNCTION public.sync_credit_balance_from_buckets() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_credit_balance_from_buckets() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_credit_balance_from_buckets() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_credit_balance_from_buckets() FROM service_role;

REVOKE EXECUTE ON FUNCTION public.update_tracked_competitors_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_tracked_competitors_updated_at() FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_tracked_competitors_updated_at() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.update_tracked_competitors_updated_at() FROM service_role;

REVOKE EXECUTE ON FUNCTION public.update_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_updated_at() FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_updated_at() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at() FROM service_role;

REVOKE EXECUTE ON FUNCTION public.update_video_ideas_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_video_ideas_updated_at() FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_video_ideas_updated_at() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.update_video_ideas_updated_at() FROM service_role;

-- Egyik functionra sem kap VISSZA service_role EXECUTE-ot: a P0/1I audit
-- kimeritoen (app/, lib/, vercel.json, minden migracio) ellenorizte, es
-- egyetlen futasidejū hivot sem talalt egyikre sem, RPC-n vagy cron-on
-- keresztul sem — sem anon/authenticated, sem service_role oldalon.

-- ============================================================
-- 2. SET search_path = public, pg_temp — 8 function
--    (public.rls_auto_enable() es public.sync_credit_balance_from_buckets()
--    mar pinnelve vannak, nem resze ennek a bloknak)
-- ============================================================

ALTER FUNCTION public.cleanup_expired_cache() SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user() SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user_credits() SET search_path = public, pg_temp;
ALTER FUNCTION public.increment_subscription_credits(uuid, numeric, numeric) SET search_path = public, pg_temp;
ALTER FUNCTION public.increment_topup_credits(uuid, numeric) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_tracked_competitors_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_video_ideas_updated_at() SET search_path = public, pg_temp;

-- ============================================================
-- 3. FAIL-FAST VEGALLAPOT-VALIDACIO
--
-- Az elvart ertekhalmaz statikus, a migracioba rogzitett, review-zheto
-- adat — nem tamaszkodik futasidejū production-kapcsolatra. A
-- has_function_privilege()-t hasznaljuk elsodleges bizonyitekkent (nem
-- tenyleges SELECT-hivast a pseudo-return-tipusu trigger/event-trigger
-- functionokre, mert azokat Postgres mar a specialis return type miatt is
-- elutasithatja, fuggetlenul az ACL-tol — ez felrevezeto "bizonyitek"
-- lenne). A negy, 040-ben mar megkeményitett kredit-RPC-t (apply_*,
-- refund_credit_spend, spend_credits) is bevonjuk a validaciba, hogy
-- explicit bizonyitsuk: ez a migracio azok grantjat NEM erinti.
-- ============================================================

DO $validate$
DECLARE
  mismatch_count int;
  search_path_bad_count int;
  expected_count int;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS expected_function_privileges_045 (
    func_signature text NOT NULL,
    grantee text NOT NULL,
    expected boolean NOT NULL
  ) ON COMMIT DROP;
  DELETE FROM expected_function_privileges_045;

  INSERT INTO expected_function_privileges_045 (func_signature, grantee, expected) VALUES
    -- --- 7 revoke-cel: anon/authenticated/service_role = false, postgres (owner) = true ---
    ('public.cleanup_expired_cache()','anon',false),
    ('public.cleanup_expired_cache()','authenticated',false),
    ('public.cleanup_expired_cache()','service_role',false),
    ('public.cleanup_expired_cache()','postgres',true),

    ('public.handle_new_user()','anon',false),
    ('public.handle_new_user()','authenticated',false),
    ('public.handle_new_user()','service_role',false),
    ('public.handle_new_user()','postgres',true),

    ('public.handle_new_user_credits()','anon',false),
    ('public.handle_new_user_credits()','authenticated',false),
    ('public.handle_new_user_credits()','service_role',false),
    ('public.handle_new_user_credits()','postgres',true),

    ('public.sync_credit_balance_from_buckets()','anon',false),
    ('public.sync_credit_balance_from_buckets()','authenticated',false),
    ('public.sync_credit_balance_from_buckets()','service_role',false),
    ('public.sync_credit_balance_from_buckets()','postgres',true),

    ('public.update_tracked_competitors_updated_at()','anon',false),
    ('public.update_tracked_competitors_updated_at()','authenticated',false),
    ('public.update_tracked_competitors_updated_at()','service_role',false),
    ('public.update_tracked_competitors_updated_at()','postgres',true),

    ('public.update_updated_at()','anon',false),
    ('public.update_updated_at()','authenticated',false),
    ('public.update_updated_at()','service_role',false),
    ('public.update_updated_at()','postgres',true),

    ('public.update_video_ideas_updated_at()','anon',false),
    ('public.update_video_ideas_updated_at()','authenticated',false),
    ('public.update_video_ideas_updated_at()','service_role',false),
    ('public.update_video_ideas_updated_at()','postgres',true),

    -- --- increment_* keeperek: service_role + postgres = true, anon/authenticated = false ---
    ('public.increment_subscription_credits(uuid, numeric, numeric)','anon',false),
    ('public.increment_subscription_credits(uuid, numeric, numeric)','authenticated',false),
    ('public.increment_subscription_credits(uuid, numeric, numeric)','service_role',true),
    ('public.increment_subscription_credits(uuid, numeric, numeric)','postgres',true),

    ('public.increment_topup_credits(uuid, numeric)','anon',false),
    ('public.increment_topup_credits(uuid, numeric)','authenticated',false),
    ('public.increment_topup_credits(uuid, numeric)','service_role',true),
    ('public.increment_topup_credits(uuid, numeric)','postgres',true),

    -- --- erintetlen 040-es kredit-RPC-k: bizonyitek, hogy mas grant nem valtozott ---
    ('public.apply_bucket_credit_event(uuid, numeric, text, numeric, text, text, jsonb)','anon',false),
    ('public.apply_bucket_credit_event(uuid, numeric, text, numeric, text, text, jsonb)','authenticated',false),
    ('public.apply_bucket_credit_event(uuid, numeric, text, numeric, text, text, jsonb)','service_role',true),
    ('public.apply_bucket_credit_event(uuid, numeric, text, numeric, text, text, jsonb)','postgres',true),

    ('public.apply_credit_event(uuid, numeric, numeric, text, text, jsonb)','anon',false),
    ('public.apply_credit_event(uuid, numeric, numeric, text, text, jsonb)','authenticated',false),
    ('public.apply_credit_event(uuid, numeric, numeric, text, text, jsonb)','service_role',true),
    ('public.apply_credit_event(uuid, numeric, numeric, text, text, jsonb)','postgres',true),

    ('public.refund_credit_spend(uuid, uuid, text, jsonb)','anon',false),
    ('public.refund_credit_spend(uuid, uuid, text, jsonb)','authenticated',false),
    ('public.refund_credit_spend(uuid, uuid, text, jsonb)','service_role',true),
    ('public.refund_credit_spend(uuid, uuid, text, jsonb)','postgres',true),

    ('public.spend_credits(uuid, numeric, text, text, jsonb)','anon',false),
    ('public.spend_credits(uuid, numeric, text, text, jsonb)','authenticated',false),
    ('public.spend_credits(uuid, numeric, text, text, jsonb)','service_role',true),
    ('public.spend_credits(uuid, numeric, text, text, jsonb)','postgres',true);

  SELECT count(*) INTO expected_count FROM expected_function_privileges_045;
  IF expected_count <> 52 THEN
    RAISE EXCEPTION '045 validation setup error: expected_function_privileges_045 does not contain exactly 52 rows (got %)', expected_count;
  END IF;

  SELECT count(*) INTO mismatch_count
  FROM expected_function_privileges_045 e
  WHERE has_function_privilege(e.grantee, e.func_signature::regprocedure, 'EXECUTE') IS DISTINCT FROM e.expected;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION '045 validation failed: % function EXECUTE privilege(s) do not match the expected state', mismatch_count;
  END IF;

  -- --- search_path check a 8 celzott functionre ---
  SELECT count(*) INTO search_path_bad_count
  FROM pg_proc p
  WHERE p.oid IN (
      'public.cleanup_expired_cache()'::regprocedure,
      'public.handle_new_user()'::regprocedure,
      'public.handle_new_user_credits()'::regprocedure,
      'public.increment_subscription_credits(uuid, numeric, numeric)'::regprocedure,
      'public.increment_topup_credits(uuid, numeric)'::regprocedure,
      'public.update_tracked_competitors_updated_at()'::regprocedure,
      'public.update_updated_at()'::regprocedure,
      'public.update_video_ideas_updated_at()'::regprocedure
    )
    AND NOT ('search_path=public, pg_temp' = ANY(COALESCE(p.proconfig, ARRAY[]::text[])));

  IF search_path_bad_count > 0 THEN
    RAISE EXCEPTION '045 validation failed: % function(s) missing the expected search_path=public, pg_temp', search_path_bad_count;
  END IF;

  -- --- rls_auto_enable es sync_credit_balance_from_buckets search_path erintetlen ---
  IF NOT (
    SELECT 'search_path=public, pg_temp' = ANY(COALESCE(proconfig, ARRAY[]::text[]))
    FROM pg_proc WHERE oid = 'public.sync_credit_balance_from_buckets()'::regprocedure
  ) THEN
    RAISE EXCEPTION '045 validation failed: sync_credit_balance_from_buckets() search_path unexpectedly changed or missing';
  END IF;
END;
$validate$;

COMMIT;
