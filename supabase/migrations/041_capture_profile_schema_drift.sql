-- ============================================================
-- Migration 041: Capture profiles schema drift
--
-- A P0/1F-J alkalmazasszintu smoke teszt soran a teljes onboarding
-- lezarasa (POST /api/profile) minden esetben PGRST204-et dobott:
-- "Could not find the 'custom_prompt' column of 'profiles'". Ez egy
-- masodik, eddig fel nem tart drift-osztaly volt, ugyanabbol a
-- csaladbol mint a 003 altal lezart 8 hianyzo tabla — csak itt egy
-- MAR versionelt tablan (profiles, 001 ota letezik) belul hianyzik
-- ket, production-ban elo, sosem migralt oszlop.
--
-- Forras: production pg_catalog/information_schema export a
-- felhasznalo altal futtatva a Supabase Studio SQL Editor-ban
-- (2026-07-23), kizarolag metaadat-lekerdezesbol, nulla felhasznaloi
-- sor olvasasabol. A teljes production vs. lokalis rebuild diff:
--
--   COLUMN narration_style      MISSING_LOCAL  (text NOT NULL DEFAULT 'storytelling')
--   COLUMN custom_prompt        MISSING_LOCAL  (text, nullable)
--   CONSTRAINT profiles_narration_style_check  MISSING_LOCAL (CHECK a 10 NarrationStyle ertekre)
--   POLICY profiles_update_own  DEFINITION_MISMATCH
--       production: USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)
--       lokalis (001 eredeti):  USING (auth.uid() = user_id)  -- WITH CHECK hianyzik
--   GRANT anon SELECT/INSERT/UPDATE/DELETE ON profiles          EXTRA_LOCAL (production revokolta, csak TRUNCATE/TRIGGER/REFERENCES maradt anon-nak)
--   GRANT authenticated INSERT/DELETE ON profiles               EXTRA_LOCAL (production csak SELECT/UPDATE/TRUNCATE/TRIGGER/REFERENCES-t ad authenticated-nek)
--   GRANT service_role INSERT/DELETE ON profiles                EXTRA_LOCAL (production csak SELECT/UPDATE/TRUNCATE/TRIGGER/REFERENCES-t ad service_role-nak)
--
-- Minden mas oszlop/constraint/index/RLS-enabled/policy/trigger
-- MATCH volt production es a lokalis (001/015/029/038) rebuild kozott
-- — azokhoz ez a migracio semmit nem nyul.
--
-- A GRANT-tulterjeszkedes biztonsagos revokalasat az magyarazza, hogy
-- a profiles-ba torteno egyetlen INSERT a handle_new_user() trigger-
-- fuggvenyen keresztul tortenik (001, SECURITY DEFINER, postgres
-- tulajdonaban) — ez a hivo szerepkortol fuggetlenul lefut, tehat sem
-- anon-nak, sem authenticated-nek, sem service_role-nak nincs
-- szuksege kozvetlen INSERT grantra. DELETE-et a profiles soron
-- kozvetlenul soha nem hasznal az alkalmazaskod (kaszkad az
-- auth.users torlesekor, ami a FK sajat RI-mechanizmusaval, nem a
-- hivo szerepkor DELETE grantjaval mukodik) — production ezt is
-- igazolja, ez a migracio csak utana kovetkezik.
--
-- Nem nyul a 001-hez, nem kerul a 003-ba. Csak production-ban
-- bizonyitott, lokalisan hianyzo objektumokat rogzit. Adatot nem
-- torol, letezo mezoertekeket nem ir at.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Hianyzo oszlopok — hianyzik: letrehozza; letezik es egyezik:
--    no-op; letezik es elter: fail-fast.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.migration_041_ensure_column(
  p_table text, p_column text, p_add_type_sql text, p_udt_name text,
  p_nullable boolean, p_default text
) RETURNS void AS $fn$
DECLARE
  c RECORD;
  add_sql text;
BEGIN
  SELECT udt_name, is_nullable, column_default, is_identity
  INTO c
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_column;

  IF NOT FOUND THEN
    add_sql := format('ALTER TABLE public.%I ADD COLUMN %I %s %s %s',
      p_table, p_column, p_add_type_sql,
      CASE WHEN p_nullable THEN '' ELSE 'NOT NULL' END,
      CASE WHEN p_default IS NULL THEN '' ELSE 'DEFAULT ' || p_default END);
    EXECUTE add_sql;
  ELSE
    IF c.udt_name IS DISTINCT FROM p_udt_name
       OR c.is_nullable IS DISTINCT FROM (CASE WHEN p_nullable THEN 'YES' ELSE 'NO' END)
       OR c.column_default IS DISTINCT FROM p_default
       OR c.is_identity IS DISTINCT FROM 'NO'
    THEN
      RAISE EXCEPTION 'column %.% unexpected definition (udt=%, nullable=%, default=%, identity=%)',
        p_table, p_column, c.udt_name, c.is_nullable, c.column_default, c.is_identity;
    END IF;
  END IF;
END;
$fn$ LANGUAGE plpgsql;

SELECT pg_temp.migration_041_ensure_column('profiles','narration_style','TEXT','text',false,'''storytelling''::text');
SELECT pg_temp.migration_041_ensure_column('profiles','custom_prompt','TEXT','text',true,NULL);

-- ------------------------------------------------------------
-- 2. profiles_narration_style_check — hianyzik: letrehozza;
--    egyezik: no-op; elter: fail-fast.
-- ------------------------------------------------------------

DO $$
DECLARE
  existing_def text;
  expected_def text := 'CHECK ((narration_style = ANY (ARRAY[''mrbeast''::text, ''bright_side''::text, ''dylan_page''::text, ''dokumentarista''::text, ''tenyfeltaro''::text, ''tudomanyos''::text, ''storytelling''::text, ''mrballen''::text, ''magyar_tiktok''::text, ''sajat''::text])))';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_narration_style_check';
  IF existing_def IS NULL THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_narration_style_check
      CHECK (narration_style IN (
        'mrbeast', 'bright_side', 'dylan_page', 'dokumentarista', 'tenyfeltaro',
        'tudomanyos', 'storytelling', 'mrballen', 'magyar_tiktok', 'sajat'
      ));
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'profiles_narration_style_check unexpected definition: %', existing_def;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. profiles_update_own — production a WITH CHECK-et is tartalmazza,
--    a lokalis (001-bol orokolt) valtozat nem. Hianyzik: hozzaadja;
--    egyezik: no-op; barmi mas: fail-fast.
-- ------------------------------------------------------------

DO $$
DECLARE
  existing_check text;
BEGIN
  SELECT with_check INTO existing_check FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_update_own';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profiles_update_own policy does not exist — expected from migration 001';
  ELSIF existing_check IS NULL THEN
    ALTER POLICY profiles_update_own ON public.profiles
      WITH CHECK (auth.uid() = user_id);
  ELSIF existing_check <> '(auth.uid() = user_id)' THEN
    RAISE EXCEPTION 'profiles_update_own WITH CHECK unexpected definition: %', existing_check;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Grant-tulterjeszkedes visszavagasa a production tenyleges,
--    igazolt allapotara. Csak azt vonja vissza, amit a diff
--    EXTRA_LOCAL-kent igazolt — semmi mast (TRUNCATE/TRIGGER/
--    REFERENCES erintetlen marad, azok production-ban is megvannak).
-- ------------------------------------------------------------

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.profiles FROM anon;
REVOKE INSERT, DELETE ON public.profiles FROM authenticated;
REVOKE INSERT, DELETE ON public.profiles FROM service_role;

-- Utoellenorzes: a fenti szerepkorok egyike se tartsa meg a revokolt jogot.
DO $$
DECLARE
  leaked RECORD;
  leak_count INT := 0;
BEGIN
  FOR leaked IN
    SELECT grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND (
        (grantee = 'anon' AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
        OR (grantee IN ('authenticated', 'service_role') AND privilege_type IN ('INSERT', 'DELETE'))
      )
  LOOP
    leak_count := leak_count + 1;
    RAISE WARNING 'unexpected grant remains on profiles: % -> %', leaked.grantee, leaked.privilege_type;
  END LOOP;

  IF leak_count > 0 THEN
    RAISE EXCEPTION '% unexpected profiles grant(s) remain after revoke', leak_count;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
