-- ============================================================
-- Migration 047: Capture and harden rls_auto_enable()/ensure_rls
--
-- A 043-as migracio (2026-07-23) mar dokumentalta, hogy productionben
-- letezik egy "ensure_rls" nevu event trigger (rls_auto_enable()
-- fuggveny, tulaj: postgres, ddl_command_end a CREATE TABLE/CREATE
-- TABLE AS/SELECT INTO parancsokra), amely automatikusan bekapcsolja
-- az RLS-t minden uj, "public" semaban letrehozott tablan — es hogy ez
-- sosem lett kulon verziokovetve. A 043-as production-audit 2 olyan
-- tablat talalt, ahol ez a mechanizmus mar bizonyithatoan mukodott
-- (production RLS_ENABLED=true, de a lokalis rebuild sosem kapcsolta
-- be explicit migracioval) — ez ERŐS KOZVETETT bizonyitek az event
-- trigger hasznossagara, de NEM tekintjuk bizonyitott, kizarolagos
-- tortenelmi ok-okozatnak (mas magyarazat — pl. kesobbi kezi ALTER
-- TABLE production oldalon — sem zarhato ki teljes bizonyossaggal
-- metaadat-alapu audittal).
--
-- A P0/1K audit (2026-07-26, kizarolag production pg_catalog metaadat-
-- lekerdezesbol, nulla felhasznaloi sor olvasasaval) rogzitette a
-- pontos jelenlegi definiciot mindket objektumra — ez a migracio ezt
-- a rogzitett allapotot hozza letre (vagy validalja, ha mar letezik)
-- lokalisan, MAJD megerositi az ACL-t.
--
-- HATOKOR — KIZAROLAG:
--   1) public.rls_auto_enable() fuggveny idempotens letrehozasa/
--      validalasa a pontos production-definicioval (RETURNS
--      event_trigger, LANGUAGE plpgsql, VOLATILE, SECURITY DEFINER,
--      tulaj postgres, SET search_path TO 'pg_catalog', a productionnel
--      egyezo body).
--   2) EXECUTE REVOKE FROM PUBLIC/anon/authenticated/service_role ezen
--      az egy functionon (a postgres tulajdonosi joga erintetlen).
--   3) "ensure_rls" event trigger idempotens letrehozasa/validalasa
--      (ddl_command_end, engedelyezve, tulaj postgres, pontosan a
--      CREATE TABLE/CREATE TABLE AS/SELECT INTO tag-harmas, a
--      rls_auto_enable()-re mutatva).
--
-- NEM resze es NEM erintett:
--   - fail-open -> fail-closed atalakitas (lasd lent, tudatos dontes);
--   - mas function/tabla ACL-je;
--   - mar letezo tablak RLS-allapota (a 043 mar kezelte az akkor
--     talalt 2 kivetelt; ez a migracio kizarolag a MECHANIZMUST
--     magat verziokoveti, nem fut ujra retroaktivan);
--   - config.toml;
--   - production modositas, supabase db push, migration repair/
--     history/baseline;
--   - felhasznaloi adat olvasasa.
--
-- FAIL-OPEN MUKODES — TUDATOSAN MEGTARTOTT, NEM VALTOZTATOTT VISELKEDES:
-- A function EXCEPTION WHEN OTHERS THEN blokkja elnyeli (swallow-olja)
-- az ENABLE ROW LEVEL SECURITY sikertelenseget: ha az ALTER TABLE
-- barmilyen okbol hibat dob (pl. lock, jogosultsag, mar torolt tabla a
-- tranzakcioban), a function csak egy RAISE LOG-ot ir, MAGAT A CREATE
-- TABLE-t nem allitja meg es nem dob hibat kifele. Ez a productionnel
-- EGYEZO, tudatosan megtartott viselkedes — ez a migracio NEM alakitja
-- at fail-closed mukodesre. Ebbol kovetkezik:
--   - az event trigger KIZAROLAG MASODLAGOS VEDOHALO, nem elsodleges
--     RLS-garancia;
--   - NEM helyettesiti az egyes tablak sajat migracioiban szereplo
--     explicit "ENABLE ROW LEVEL SECURITY" utasitast — minden uj
--     tablat letrehozo migracionak TOVABBRA IS sajat maganak kell
--     explicit bekapcsolnia az RLS-t;
--   - a "db reset" utani schema/RLS diff (minden migracio sajat
--     kotelezo zaro lepese) TOVABBRA IS kotelezo kapu marad, fuggetlenul
--     attol, hogy ez az event trigger jelen van-e.
--
-- Forras: production pg_catalog export (2026-07-26, Supabase Studio
-- SQL Editor, kizarolag metaadat-lekerdezes: pg_proc, pg_event_trigger,
-- aclexplode — nulla felhasznaloi sor olvasasa). A function body-t
-- soronkent, pg_get_functiondef() + unnest(string_to_array(...))
-- segitsegevel rogzitettuk; a RAISE LOG uzenetszovegek es a WHEN/IN
-- feltetelek karakterre pontosan egyeznek a rogzitett production-
-- kimenettel. A migracio sajat kanonikus formazast/behuzast hasznal —
-- ez a behuzas/sortores NEM befolyasolja a function tenyleges
-- viselkedeset (a Postgres a body-t a dollar-quote-on beluli tartalom
-- szerint tarolja, a whitespace nem szemantikus elem az SQL/plpgsql
-- futashoz kepest).
-- ============================================================

BEGIN;

-- ============================================================
-- 1. FUNCTION IDEMPOTENS LETREHOZAS / VALIDACIO
-- ============================================================

DO $migration_047_fn$
DECLARE
  fn_oid oid;
  expected_body text;
  actual_body text;
  actual_owner text;
  actual_lang text;
  actual_rettype text;
  actual_volatile "char";
  actual_secdef boolean;
  actual_config text[];
BEGIN
  expected_body := $BODY$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
    AND object_type IN ('table','partitioned table')
  LOOP
    IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
    ELSE
      RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
    END IF;
  END LOOP;
END;
$BODY$;

  fn_oid := to_regprocedure('public.rls_auto_enable()');

  IF fn_oid IS NULL THEN
    EXECUTE format(
      'CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO ''pg_catalog'' AS %L',
      expected_body
    );
    RAISE NOTICE '047: public.rls_auto_enable() created';
  ELSE
    SELECT p.prosrc, pg_get_userbyid(p.proowner), l.lanname, t.typname,
           p.provolatile, p.prosecdef, p.proconfig
    INTO actual_body, actual_owner, actual_lang, actual_rettype,
         actual_volatile, actual_secdef, actual_config
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_type t ON t.oid = p.prorettype
    WHERE p.oid = fn_oid;

    IF actual_body IS DISTINCT FROM expected_body
       OR actual_owner IS DISTINCT FROM 'postgres'
       OR actual_lang IS DISTINCT FROM 'plpgsql'
       OR actual_rettype IS DISTINCT FROM 'event_trigger'
       OR actual_volatile IS DISTINCT FROM 'v'
       OR actual_secdef IS DISTINCT FROM true
       OR NOT ('search_path=pg_catalog' = ANY(COALESCE(actual_config, ARRAY[]::text[])))
    THEN
      RAISE EXCEPTION '047 validation failed: public.rls_auto_enable() exists but does not match the expected definition (owner=%, lang=%, rettype=%, volatile=%, secdef=%, config=%)',
        actual_owner, actual_lang, actual_rettype, actual_volatile, actual_secdef, actual_config;
    END IF;
    RAISE NOTICE '047: public.rls_auto_enable() already matches the expected definition (no-op)';
  END IF;
END;
$migration_047_fn$;

-- ============================================================
-- 2. FUNCTION ACL HARDENING
--    Az ACL szerint jelenleg kitett (a REVOKE elott PUBLIC/anon/
--    authenticated/service_role is orokolhetne EXECUTE-ot az
--    implicit alapertelmezesbol), de a RETURNS event_trigger tipus
--    miatt normal SQL/RPC uton (SELECT public.rls_auto_enable(),
--    PostgREST RPC, stb.) KOZVETLENUL NEM VEGREHAJTHATO — a Postgres
--    csak az event trigger infrastrukturajan keresztul hivja. A REVOKE
--    igy defense-in-depth celu (least privilege), nem egy tenylegesen
--    kihasznalhato hivasi utvonalat zar le.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM service_role;

DO $migration_047_acl$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
  FROM (
    SELECT acl.grantee
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) acl
    WHERE p.oid = 'public.rls_auto_enable()'::regprocedure
      AND acl.privilege_type = 'EXECUTE'
      AND (acl.grantee = 0 OR pg_get_userbyid(acl.grantee) IN ('anon', 'authenticated', 'service_role'))
  ) bad;

  IF bad_count > 0 THEN
    RAISE EXCEPTION '047 validation failed: % PUBLIC/anon/authenticated/service_role EXECUTE tuple(s) remain on public.rls_auto_enable()', bad_count;
  END IF;

  IF NOT has_function_privilege('postgres', 'public.rls_auto_enable()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '047 validation failed: postgres (owner) unexpectedly lost EXECUTE on public.rls_auto_enable()';
  END IF;

  IF has_function_privilege('anon', 'public.rls_auto_enable()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rls_auto_enable()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.rls_auto_enable()'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION '047 validation failed: anon/authenticated/service_role unexpectedly retain EXECUTE on public.rls_auto_enable()';
  END IF;
END;
$migration_047_acl$;

-- ============================================================
-- 3. EVENT TRIGGER IDEMPOTENS LETREHOZAS / VALIDACIO
-- ============================================================

DO $migration_047_evt$
DECLARE
  fn_oid oid;
  evt_oid oid;
  evt_event text;
  evt_enabled "char";
  evt_owner text;
  evt_tags text[];
  evt_fn_oid oid;
  expected_tags text[] := ARRAY['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO'];
  extra_tags int;
  missing_tags int;
BEGIN
  fn_oid := to_regprocedure('public.rls_auto_enable()');
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION '047 internal error: public.rls_auto_enable() missing right before the event trigger step (should already exist from section 1)';
  END IF;

  SELECT oid INTO evt_oid FROM pg_event_trigger WHERE evtname = 'ensure_rls';

  IF evt_oid IS NULL THEN
    EXECUTE format(
      'CREATE EVENT TRIGGER ensure_rls ON ddl_command_end WHEN TAG IN (%L, %L, %L) EXECUTE FUNCTION public.rls_auto_enable()',
      'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO'
    );
    RAISE NOTICE '047: event trigger ensure_rls created';
  ELSE
    SELECT et.evtevent, et.evtenabled, pg_get_userbyid(et.evtowner), et.evttags, et.evtfoid
    INTO evt_event, evt_enabled, evt_owner, evt_tags, evt_fn_oid
    FROM pg_event_trigger et
    WHERE et.oid = evt_oid;

    SELECT count(*) INTO extra_tags
    FROM (SELECT unnest(evt_tags) EXCEPT SELECT unnest(expected_tags)) x;

    SELECT count(*) INTO missing_tags
    FROM (SELECT unnest(expected_tags) EXCEPT SELECT unnest(evt_tags)) x;

    IF evt_event IS DISTINCT FROM 'ddl_command_end'
       OR evt_enabled IS DISTINCT FROM 'O'
       OR evt_owner IS DISTINCT FROM 'postgres'
       OR evt_fn_oid IS DISTINCT FROM fn_oid
       OR extra_tags > 0
       OR missing_tags > 0
    THEN
      RAISE EXCEPTION '047 validation failed: event trigger ensure_rls exists but does not match the expected definition (event=%, enabled=%, owner=%, fn_oid=% vs expected %, extra_tags=%, missing_tags=%)',
        evt_event, evt_enabled, evt_owner, evt_fn_oid, fn_oid, extra_tags, missing_tags;
    END IF;
    RAISE NOTICE '047: event trigger ensure_rls already matches the expected definition (no-op)';
  END IF;
END;
$migration_047_evt$;

COMMIT;
