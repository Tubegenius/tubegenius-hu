-- ============================================================
-- Migration 046: Harden default privileges for future public-schema objects
--
-- A P0/1J audit (2026-07-26, kizarolag production+local pg_catalog
-- metaadat-lekerdezesbol, nulla felhasznaloi sor olvasasaval) feltarta,
-- hogy a "postgres" szerepkor (ez a szerepkor futtatja mind a lokalis
-- CLI migraciokat, mind a Studio SQL Editort, mindket kornyezetben
-- kozvetlenul igazolva: current_user/session_user = postgres) rendelkezik
-- egy sajat, ALTER DEFAULT PRIVILEGES altal rogzitett alapertelmezessel a
-- "public" semaban, ami lokalisan minden uj tablanak/function-nek/
-- sequence-nek TELJES DML/EXECUTE/USAGE-ot ad anon/authenticated/
-- service_role-nak is (a helyi CLI legacy auto_expose_new_tables=true
-- bootstrapja miatt); productionben mar ma szukebb, de meg nem nulla.
--
-- Ez a migracio EGYETLEN celt szolgal: minden JOVOBENI (a migracio utan
-- letrehozott) public-semabeli tabla/function/sequence alapertelmezesben
-- SEMMILYEN jogot ne kapjon anon/authenticated/service_role/PUBLIC
-- szamara — minden ilyen jogot a LETREHOZO migracionak kell explicit
-- megadnia (ahogy 036/039/040/041/045 mar tette egyedi eseteknel).
--
-- FONTOS, FIXTURE-TESZTTEL FELTART KORLAT ES ANNAK MEGOLDASA:
-- Egy elozo verzio ezt a migraciot kizarolag "FOR ROLE postgres IN SCHEMA
-- public REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role"
-- alakban probalta megoldani mindharom objektumtipusra. Tabla es sequence
-- eseten ez fixture-tesztelve helyesen mukodott. Function eseten viszont
-- — tobbszoros, kontrollalt kiserlettel igazoltan (helyi PostgreSQL 17.6,
-- event trigger es connection-pooling kizarva) — ha egy sema-szintu
-- ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS vegeredmenye "csak a
-- tulajdonos marad", PostgreSQL EZT FIGYELMEN KIVUL HAGYJA uj function
-- letrehozasakor, es az implicit SQL-szabvany alapertelmezesre (PUBLIC
-- kap EXECUTE-ot) esik vissza.
--
-- A megoldas: a PUBLIC-tol valo EXECUTE-revoke-ot KULON, GLOBALIS
-- (nem IN SCHEMA-hoz kotott) ALTER DEFAULT PRIVILEGES-kent kell kiadni —
-- ez az implicit PUBLIC-EXECUTE konvenciot magan a szerepkoron (postgres)
-- keresztul, semaba nem kotve valtoztatja meg, es minden altala kesobb,
-- BARMELY semaban letrehozott functionre hat (ld. 6. pont). A public
-- semaban az anon/authenticated/service_role explicit (nem PUBLIC-on
-- keresztuli) named-role grantjait KULON, sema-szintu REVOKE-kal kell
-- lezarni. A ket ACL-allapot (globalis defaclnamespace=0, es sema-szintu
-- defaclnamespace=public_oid) egymastol fuggetlen katalogus-bejegyzes,
-- a validacio ezert is kulon-kulon ellenorzi oket.
--
-- HATOKOR — KIZAROLAG:
--   1) ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--      REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
--   2) ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--      REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
--   3) ALTER DEFAULT PRIVILEGES FOR ROLE postgres
--      REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;                    (globalis!)
--   4) ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--      REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
--
-- NEM resze es NEM erintett:
--   - postgres (owner) sajat implicit joga — ezt sem revoke-olni nem kell,
--     sem nem lehet ertelmesen (a tulajdonjog fuggetlenul minden jogot ad);
--   - supabase_admin default ACL-je (masik owner, kulon audit targya,
--     jelenleg egyetlen public-semabeli objektumot sem birtokol egyik
--     kornyezetben sem — ld. P0/1J audit 9. pont);
--   - barmely mas schema (auth/storage/realtime/extensions/stb.) default
--     ACL-je postgres-tol elteroe tulajdonosokra;
--   - meglevo objektumok (044/045-ben mar rendezett) tenyleges grantjai —
--     az ALTER DEFAULT PRIVILEGES kizarolag a MEG NEM LETEZO, jovobeli
--     objektumokra hat, retroaktivan semmit nem valtoztat;
--   - config.toml;
--   - event trigger (nem kerul bevezetesre).
--
-- Verzio-fuggoseg: a celallapot (a MAINTAIN privilege-et is beleertve a
-- tablaknal) PostgreSQL 17+-t felteteleez — a MAINTAIN privilege csak
-- PG17-ben jelent meg. A validacio explicit ellenorzi a szerver verziojat.
--
-- Forras: production+local pg_catalog export (2026-07-26), current_user/
-- session_user kozvetlen ellenorzese, event trigger es tulajdonos-lista
-- kimeriti attekintese, tobbszoros kontrollalt kiserlet a function-default
-- viselkedes korulhatarolasara.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. VERZIO-ELOFELTETEL
-- ============================================================

DO $version_check$
BEGIN
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION '046 precondition failed: PostgreSQL server_version_num=% (< 170000). This migration''s expected default-ACL tuple count assumes PostgreSQL 17+ (MAINTAIN privilege on tables). Do not apply on an older server without first re-deriving the expected owner-only tuple set for that version.',
      current_setting('server_version_num');
  END IF;
END;
$version_check$;

-- ============================================================
-- 1. SNAPSHOT — minden NEM celzott pg_default_acl tuple, a valtoztatas
--    ELOTT. A celzott halmaz MOST MAR NEGY resz (nem harom):
--      a) postgres + public + TABLES
--      b) postgres + public + SEQUENCES
--      c) postgres + GLOBAL (defaclnamespace = 0) + FUNCTIONS
--      d) postgres + public + FUNCTIONS (anon/authenticated/service_role
--         resze — ld. 3c. pont, a postgres sajat sora ezen a soron belul
--         erintetlen marad)
--    Minden EGYEB (mas owner, mas schema, mas objektumtipus) a "nem
--    celzott" snapshotba kerul es valtozatlansaga bizonyitando.
-- ============================================================

CREATE TEMP TABLE default_acl_baseline_046 (
  owner text NOT NULL,
  schema_name text,
  object_type "char" NOT NULL,
  grantee text NOT NULL,
  privilege_type text NOT NULL,
  is_grantable boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO default_acl_baseline_046 (owner, schema_name, object_type, grantee, privilege_type, is_grantable)
SELECT pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,
       acl.privilege_type, acl.is_grantable
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
WHERE NOT (
  pg_get_userbyid(d.defaclrole) = 'postgres' AND (
    (n.nspname = 'public' AND d.defaclobjtype IN ('r','S'))         -- (a)+(b)
    OR (d.defaclnamespace = 0 AND d.defaclobjtype = 'f')             -- (c)
    OR (n.nspname = 'public' AND d.defaclobjtype = 'f')              -- (d)
  )
);

-- ============================================================
-- 2. A TENYLEGES HARDENING
-- ============================================================

-- --- (a) Tablak — sema-szintu, valtozatlan a korabbi tervhez kepest ---
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, anon, authenticated, service_role;

-- --- (b) Sequence-ek — sema-szintu, valtozatlan a korabbi tervhez kepest ---
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;

-- --- (c) Functionok — GLOBALIS PUBLIC EXECUTE revoke (nem sema-kotott!) ---
-- Ez az implicit SQL-szabvany "PUBLIC kap EXECUTE-ot" konvenciot szunteti
-- meg a postgres szerepkorre, FUGGETLENUL attol, melyik semaban hozza
-- letre a functiont kesobb (ld. 6. pont a hatokor dokumentaciojahoz).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- --- (d) Functionok — public-sema explicit role grantok ---
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON FUNCTIONS FROM anon, authenticated, service_role;

-- ============================================================
-- 3. FAIL-FAST VEGALLAPOT-VALIDACIO
-- ============================================================

DO $validate$
DECLARE
  missing_count int;
  extra_count int;
  target_table_seq_bad int;
  target_global_fn_bad int;
  target_schema_fn_bad int;
  owner_mismatch_count int;
  expected_count int;
BEGIN
  -- --- 3a. Minden NEM celzott tuple valtozatlan (mindket iranyban) ---
  CREATE TEMP TABLE default_acl_current_046 ON COMMIT DROP AS
  SELECT pg_get_userbyid(d.defaclrole) AS owner, n.nspname AS schema_name, d.defaclobjtype AS object_type,
         CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
         acl.privilege_type, acl.is_grantable
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
  WHERE NOT (
    pg_get_userbyid(d.defaclrole) = 'postgres' AND (
      (n.nspname = 'public' AND d.defaclobjtype IN ('r','S'))
      OR (d.defaclnamespace = 0 AND d.defaclobjtype = 'f')
      OR (n.nspname = 'public' AND d.defaclobjtype = 'f')
    )
  );

  SELECT count(*) INTO missing_count
  FROM (SELECT * FROM default_acl_baseline_046 EXCEPT SELECT * FROM default_acl_current_046) m;
  IF missing_count > 0 THEN
    RAISE EXCEPTION '046 validation failed: % non-targeted default-ACL tuple(s) disappeared', missing_count;
  END IF;

  SELECT count(*) INTO extra_count
  FROM (SELECT * FROM default_acl_current_046 EXCEPT SELECT * FROM default_acl_baseline_046) e;
  IF extra_count > 0 THEN
    RAISE EXCEPTION '046 validation failed: % unexpected new non-targeted default-ACL tuple(s) appeared', extra_count;
  END IF;

  -- --- 3b. postgres+public+{TABLES,SEQUENCES}: nincs PUBLIC/anon/
  --         authenticated/service_role sor ---
  SELECT count(*) INTO target_table_seq_bad
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
  WHERE pg_get_userbyid(d.defaclrole) = 'postgres' AND n.nspname = 'public'
    AND d.defaclobjtype IN ('r','S')
    AND (acl.grantee = 0 OR pg_get_userbyid(acl.grantee) IN ('anon', 'authenticated', 'service_role'));

  IF target_table_seq_bad > 0 THEN
    RAISE EXCEPTION '046 validation failed: % PUBLIC/anon/authenticated/service_role tuple(s) remain on postgres+public TABLES/SEQUENCES default ACL', target_table_seq_bad;
  END IF;

  -- --- 3c. GLOBALIS scope (defaclnamespace = 0): postgres+FUNCTIONS-on
  --         nincs PUBLIC, postgres sajat EXECUTE-ja megmarad ---
  SELECT count(*) INTO target_global_fn_bad
  FROM pg_default_acl d
  CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
  WHERE pg_get_userbyid(d.defaclrole) = 'postgres' AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'
    AND acl.grantee = 0;

  IF target_global_fn_bad > 0 THEN
    RAISE EXCEPTION '046 validation failed: PUBLIC still has EXECUTE in the global (namespace-independent) postgres FUNCTIONS default ACL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
    WHERE pg_get_userbyid(d.defaclrole) = 'postgres' AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'
      AND pg_get_userbyid(acl.grantee) = 'postgres' AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '046 validation failed: postgres owner EXECUTE tuple missing from the global FUNCTIONS default ACL';
  END IF;

  -- --- 3d. PUBLIC-SEMA scope (defaclnamespace = public): FUNCTIONS-on
  --         nincs anon/authenticated/service_role, es nincs explicit
  --         PUBLIC per-schema sor sem (ezt sosem hoztuk letre itt) ---
  SELECT count(*) INTO target_schema_fn_bad
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
  WHERE pg_get_userbyid(d.defaclrole) = 'postgres' AND n.nspname = 'public' AND d.defaclobjtype = 'f'
    AND (acl.grantee = 0 OR pg_get_userbyid(acl.grantee) IN ('anon', 'authenticated', 'service_role'));

  IF target_schema_fn_bad > 0 THEN
    RAISE EXCEPTION '046 validation failed: % PUBLIC/anon/authenticated/service_role tuple(s) remain on postgres+public FUNCTIONS default ACL', target_schema_fn_bad;
  END IF;

  -- --- 3e. Owner-tuple-k: a validacio NEM felteleezi, hogy a function
  --         owner-tuple feltetlenul a public-sema soron jelenik meg — a
  --         globalis es sema-szintu ACL kulon katalogus-allapot. Csak a
  --         postgres+public+{TABLES,SEQUENCES} owner-tuple-ket varjuk el
  --         pontosan; a function owner-jogot a 3c pont mar kulon ellenorizte.
  CREATE TEMP TABLE expected_owner_tuples_046 (
    object_type "char" NOT NULL, privilege_type text NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO expected_owner_tuples_046 (object_type, privilege_type) VALUES
    ('r','DELETE'), ('r','INSERT'), ('r','MAINTAIN'), ('r','REFERENCES'),
    ('r','SELECT'), ('r','TRIGGER'), ('r','TRUNCATE'), ('r','UPDATE'),
    ('S','SELECT'), ('S','UPDATE'), ('S','USAGE');

  SELECT count(*) INTO expected_count FROM expected_owner_tuples_046;
  IF expected_count <> 11 THEN
    RAISE EXCEPTION '046 validation setup error: expected_owner_tuples_046 does not contain exactly 11 rows (got %)', expected_count;
  END IF;

  SELECT
    (SELECT count(*) FROM (
      SELECT d.defaclobjtype AS object_type, acl.privilege_type
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
      WHERE pg_get_userbyid(d.defaclrole) = 'postgres' AND n.nspname = 'public'
        AND d.defaclobjtype IN ('r','S') AND pg_get_userbyid(acl.grantee) = 'postgres'
      EXCEPT
      SELECT object_type, privilege_type FROM expected_owner_tuples_046
    ) extra_owner)
    +
    (SELECT count(*) FROM (
      SELECT object_type, privilege_type FROM expected_owner_tuples_046
      EXCEPT
      SELECT d.defaclobjtype, acl.privilege_type
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
      WHERE pg_get_userbyid(d.defaclrole) = 'postgres' AND n.nspname = 'public'
        AND d.defaclobjtype IN ('r','S') AND pg_get_userbyid(acl.grantee) = 'postgres'
    ) missing_owner)
  INTO owner_mismatch_count;

  IF owner_mismatch_count > 0 THEN
    RAISE EXCEPTION '046 validation failed: postgres owner TABLES/SEQUENCES default-ACL tuples do not exactly match the expected 11-tuple set (% mismatch rows)', owner_mismatch_count;
  END IF;
END;
$validate$;

COMMIT;
