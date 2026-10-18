-- ============================================================
-- Migration 094: profiles mezo-szintu revizio (Creator Focus 2B, "V-trigger")
--
-- FUTASI STATUSZ: ez a fajl NEM rogzit futasi allapotot (az elavulna). Hol futott,
-- mi bizonyitott es mi nyitott: docs/operations/profiles-field-revision.md,
-- "Futasi statusz" es "Nyitott". A trigger-viselkedest DB-mentes teszt NEM
-- bizonyitja; ehhez valodi PostgreSQL-futas kell.
--
-- MIERT KELL
--   A Creator Focus 2B tiszta magja (lib/creator-focus/decision-*.ts) egy
--   megerosites-dontest a (felhasznalo, mezo, csatorna, ertek-ujjlenyomat,
--   MEZOREVIZIO) kotesre epit. A mezorevizio-nak egy olyan, ADATBAZIS altal
--   osztott azonositonak kell lennie, amely
--     * minden olyan mentesnel UJ, amely a mezo erteket megvaltoztatja,
--     * soha, semmilyen ertekvaltas utan nem hasznalodik ujra (A -> B -> A
--       harmadik, uj revizio),
--     * valtozatlan marad, ha a mezo erteke nem valtozott (az urlap minden
--       mentesnel az osszes mezot visszairja; ez nem ervenytelenitheti a
--       dontest),
--     * a klienstol nem allithato.
--   A revizio EGYEDI, nem rendezett azonosito: csak egyenloseg-osszehasonlitasra
--   szabad hasznalni (a sorozat ertekei tranzakciok kozott nem commit-sorrendben
--   adodnak ki). Olvasasa mindig ::text (a PostgREST a bigint-et JSON
--   szamkent adja, ami 2^53 felett veszteses lenne).
--
-- MIT CSINAL
--   1. Letrehozza (vagy, rollback utani ujraalkalmazaskor, ellenorzi es
--      ujrahasznositja) a public.profiles_field_revision_seq szekvenciat:
--      bigint, CACHE 1, NO CYCLE. A szekvenciat SOHA nem dobjuk el, nem
--      allitjuk vissza (nincs setval / RESTART): lasd a rollback szabalyait.
--   2. Hozzaadja a profiles.specific_focus_revision es
--      profiles.main_category_revision oszlopot (bigint NOT NULL). A meglevo
--      sorok EGYSZERI hatterezese a (volatile) oszlop-DEFAULT nextval()-javal
--      tortenik (tablaujrairas, soronkent kulonbozo ertek), igy sem a
--      profiles_updated_at trigger, sem mas trigger nem fut es az updated_at
--      nem valtozik. A DEFAULT-ot utana eldobjuk: ettol kezdve KIZAROLAG a
--      trigger oszt revizit (trigger nelkuli INSERT ertek hianyaban NOT NULL
--      hibaval all meg, nem kap csendben ismetlodo erteket).
--   3. CHECK (> 0) es UNIQUE index oszloponkent (olcso, csak ELO sorok kozti
--      ketszeres kiosztas ellen ved; a "soha ne hasznalodjon ujra" garanciat
--      a szekvencia adja, nem az index).
--   4. BEFORE INSERT OR UPDATE trigger (OF es WHEN nelkul, soronkent):
--        INSERT -> mindket mezo friss revizio, a kliens altal adott ertek
--                  FELULIRODIK.
--        UPDATE -> mezonkent: ha az ertek IS DISTINCT FROM a regitol, friss
--                  revizio; kulonben a REGI revizio (a kliens altal adott
--                  ertek FELULIRODIK).
--      A trigger neve ugy van megvalasztva, hogy a profiles BEFORE triggerei
--      kozul UTOLSONAK fusson (nev szerinti sorrend); a migracio fail-fast, ha
--      mar van nala "kesobbi" nevu BEFORE ROW trigger.
--   5. AFTER INSERT OR UPDATE ellenorzo trigger (soronkent): ha az ertek
--      valtozott, de a revizio nem; ha az ertek nem valtozott, de a revizio
--      igen; ha a revizio nem poziv vagy nagyobb mint a szekvencia utolso
--      kiosztott erteke; vagy a ket mezo revizioja azonos -> kivetel (a mentes
--      elbukik, fail-closed).
--   6. Mindket fuggveny SECURITY DEFINER, search_path = public, pg_temp, es
--      PUBLIC / anon / authenticated / service_role EXECUTE-ja visszavonva
--      (trigger-fuggveny hivasahoz nem kell hivoi EXECUTE jog). A szekvencia
--      jogai ugyanezen szerepkorok elol visszavonva (a definer tulajdonos hasznalja).
--
-- AMIT NEM CSINAL
--   Nincs dontes-tabla, audit, nyugta, RPC, API, UI; nem nyul a profiles
--   mas oszlopaihoz vagy adataihoz; nem ir at meglevo mezoerteket; nem
--   modositja az RLS-t es a tabla-szintu GRANT-okat.
--
-- A GARANCIA HATARA (ismert, dokumentalt)
--   Nincs garancia, ha a triggerek ki vannak kapcsolva (ALTER TABLE ...
--   DISABLE TRIGGER, session_replication_role = replica, pg_restore
--   --disable-triggers) vagy privilegizalt kozvetlen beavatkozas tortenik
--   (tulajdonos / superuser, setval, tablaszintu masolas). Ugyanez a
--   szekvencia-sorszamokra: nem commit-sorrend, nem folytonos (rollback
--   "lyukat" hagy), egyedisegi azonosito.
--
-- TELEPITES: docs/operations/profiles-field-revision.md (sorrend, zarak,
-- ellenorzo lekerdezesek). VISSZAGORGETES: ugyanott; a szekvencia NEM dobhato el.
-- ============================================================

BEGIN;

-- IDOKORLATOK. lock_timeout: a zar megszerzesere varakozas felso hatara. statement_timeout: MINDEN
-- ezutani utasitasra (a tablaujrairas, az indexek, a digest-szamitas mind O(sorok szama)) felso hatar;
-- tullepeskor a teljes migracio visszagordul (fail-closed). A kizarolagos zar a LOCK-tol a COMMIT-ig
-- tart, vagyis legfeljebb az utasitasok idejenek osszege; ez alatt a profiles olvasasa es irasa is
-- blokkol. Production meret ismereteben (sorok szama) kell merni; lasd a runbookot.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A teljes kizarolagos zar ELOBB, utana a pre-ellenorzesek: igy nem jonnek letre "kesobbi nevu" BEFORE
-- triggerek, revizios oszlopok vagy szekvencia-allapotvaltozasok az ellenorzes es a valtoztatas kozott.
-- (Ha a profiles nem letezik, a LOCK maga hibaval megall.)
LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;

-- ------------------------------------------------------------
-- 0. Elofeltetelek (fail-fast): semmit nem hozunk letre, ha az allapot nem
--    pontosan az elvart.
-- ------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '094 fail-closed: public.profiles is missing';
  END IF;

  -- a ket ertek-oszlop letezik es text tipusu
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles'
        AND column_name IN ('specific_focus', 'main_category') AND udt_name = 'text') <> 2 THEN
    RAISE EXCEPTION '094 fail-closed: profiles.specific_focus / profiles.main_category must both exist as text';
  END IF;

  -- a mi objektumaink meg nem leteznek (a szekvencia kivetelevel: rollback utani ujraalkalmazas)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'profiles'
               AND column_name IN ('specific_focus_revision', 'main_category_revision')) THEN
    RAISE EXCEPTION '094 fail-closed: a revision column already exists (partially applied?)';
  END IF;
  IF to_regprocedure('public.profiles_field_revision_assign()') IS NOT NULL
     OR to_regprocedure('public.profiles_field_revision_assert()') IS NOT NULL THEN
    RAISE EXCEPTION '094 fail-closed: a revision trigger function already exists (partially applied?)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal
               AND tgname IN ('profiles_zz_revision_assign', 'profiles_zz_revision_assert')) THEN
    RAISE EXCEPTION '094 fail-closed: a revision trigger already exists (partially applied?)';
  END IF;
  IF to_regclass('public.profiles_specific_focus_revision_key') IS NOT NULL
     OR to_regclass('public.profiles_main_category_revision_key') IS NOT NULL THEN
    RAISE EXCEPTION '094 fail-closed: a revision index already exists (partially applied?)';
  END IF;

  -- A mi BEFORE triggerunknek kell UTOLSONAK futnia a nev szerinti sorrendben.
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal
               AND (tgtype & 3) = 3  -- ROW + BEFORE
               AND tgname COLLATE "C" > 'profiles_zz_revision_assign') THEN
    RAISE EXCEPTION '094 fail-closed: a BEFORE ROW trigger on profiles would fire after the revision trigger';
  END IF;
END
$pre$;

-- ------------------------------------------------------------
-- 1. A szekvencia: bigint, CACHE 1, NO CYCLE. Letezo szekvenciat (rollback
--    utani ujraalkalmazas) ellenorzunk es ujrahasznositunk; SOHA nem allitjuk vissza.
-- ------------------------------------------------------------
DO $seq$
BEGIN
  IF to_regclass('public.profiles_field_revision_seq') IS NULL THEN
    CREATE SEQUENCE public.profiles_field_revision_seq AS bigint INCREMENT BY 1 MINVALUE 1 START WITH 1 CACHE 1 NO CYCLE;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_sequence
    WHERE seqrelid = 'public.profiles_field_revision_seq'::regclass
      AND seqtypid = 'bigint'::regtype AND seqincrement = 1 AND seqmin = 1
      AND seqmax = 9223372036854775807 AND seqcache = 1 AND NOT seqcycle
  ) THEN
    RAISE EXCEPTION '094 fail-closed: an existing profiles_field_revision_seq has an unexpected definition';
  END IF;
END
$seq$;

REVOKE ALL ON SEQUENCE public.profiles_field_revision_seq FROM PUBLIC, anon, authenticated, service_role;

-- A hatterezes elotti pillanatkep: a migracio a meglevo adatot (az updated_at-et is) nem valtoztathatja.
-- MEMORIAKORLATOS: soronkent egy 64 bites md5-reszlet (a sor jsonb-szovegebol), amit NUMERIC-kent osszegzunk;
-- nincs egyetlen, az egesz tablat tartalmazo string_agg (annak merete a varlena-korlatba utkozhetne).
-- Az osszeg sorrendfuggetlen (nem kell ORDER BY). Valtozas-DETEKTALAS, nem kriptografiai bizonyitek.
-- Ido: O(sorok), a statement_timeout korlatozza.
CREATE TEMP TABLE profiles_094_before ON COMMIT DROP AS
SELECT count(*) AS rows_count,
       coalesce(sum((('x' || substr(md5(to_jsonb(t)::text), 1, 16))::bit(64)::bigint)::numeric), 0) AS row_hash_sum
FROM public.profiles t;

-- ------------------------------------------------------------
-- 2. Oszlopok + egyszeri hatterezes (volatile DEFAULT, nem UPDATE), majd a DEFAULT eldobasa.
-- ------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN specific_focus_revision bigint NOT NULL DEFAULT nextval('public.profiles_field_revision_seq'),
  ADD COLUMN main_category_revision  bigint NOT NULL DEFAULT nextval('public.profiles_field_revision_seq');

ALTER TABLE public.profiles
  ALTER COLUMN specific_focus_revision DROP DEFAULT,
  ALTER COLUMN main_category_revision  DROP DEFAULT;

-- ------------------------------------------------------------
-- 3. Megszoritasok (olcso mely-vedelem; a "soha ne hasznalodjon ujra" garanciat a szekvencia adja).
-- ------------------------------------------------------------
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_specific_focus_revision_positive CHECK (specific_focus_revision > 0),
  ADD CONSTRAINT profiles_main_category_revision_positive  CHECK (main_category_revision > 0);

CREATE UNIQUE INDEX profiles_specific_focus_revision_key ON public.profiles (specific_focus_revision);
CREATE UNIQUE INDEX profiles_main_category_revision_key  ON public.profiles (main_category_revision);

-- ------------------------------------------------------------
-- 4. A kiosztott revizio trigger-fuggvenye (assign).
-- ------------------------------------------------------------
CREATE FUNCTION public.profiles_field_revision_assign()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Mindig friss; a kliens altal megadott ertek FELULIRODIK.
    NEW.specific_focus_revision := nextval('public.profiles_field_revision_seq');
    NEW.main_category_revision := nextval('public.profiles_field_revision_seq');
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.specific_focus IS DISTINCT FROM OLD.specific_focus THEN
      NEW.specific_focus_revision := nextval('public.profiles_field_revision_seq');
    ELSE
      NEW.specific_focus_revision := OLD.specific_focus_revision;
    END IF;
    IF NEW.main_category IS DISTINCT FROM OLD.main_category THEN
      NEW.main_category_revision := nextval('public.profiles_field_revision_seq');
    ELSE
      NEW.main_category_revision := OLD.main_category_revision;
    END IF;
  ELSE
    RAISE EXCEPTION 'profiles_field_revision_assign: unsupported operation %', TG_OP;
  END IF;
  RETURN NEW;
END;
$function$;

-- ------------------------------------------------------------
-- 5. Az ellenorzo trigger-fuggveny (AFTER): fail-closed, ha barmi mas trigger vagy
--    kozvetlen beavatkozas megsertette az invariansokat.
-- ------------------------------------------------------------
CREATE FUNCTION public.profiles_field_revision_assert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  issued bigint;
BEGIN
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO issued FROM public.profiles_field_revision_seq;

  IF NEW.specific_focus_revision IS NULL OR NEW.main_category_revision IS NULL
     OR NEW.specific_focus_revision < 1 OR NEW.main_category_revision < 1
     OR NEW.specific_focus_revision > issued OR NEW.main_category_revision > issued THEN
    RAISE EXCEPTION 'profiles_field_revision_assert: a revision is missing, not positive, or was never issued';
  END IF;
  IF NEW.specific_focus_revision = NEW.main_category_revision THEN
    RAISE EXCEPTION 'profiles_field_revision_assert: two fields share one revision';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.specific_focus IS DISTINCT FROM OLD.specific_focus THEN
      IF NEW.specific_focus_revision = OLD.specific_focus_revision THEN
        RAISE EXCEPTION 'profiles_field_revision_assert: specific_focus changed without a new revision';
      END IF;
    ELSIF NEW.specific_focus_revision <> OLD.specific_focus_revision THEN
      RAISE EXCEPTION 'profiles_field_revision_assert: specific_focus revision changed without a value change';
    END IF;
    IF NEW.main_category IS DISTINCT FROM OLD.main_category THEN
      IF NEW.main_category_revision = OLD.main_category_revision THEN
        RAISE EXCEPTION 'profiles_field_revision_assert: main_category changed without a new revision';
      END IF;
    ELSIF NEW.main_category_revision <> OLD.main_category_revision THEN
      RAISE EXCEPTION 'profiles_field_revision_assert: main_category revision changed without a value change';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.profiles_field_revision_assign() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.profiles_field_revision_assert() FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 6. A triggerek. NINCS "OF <oszlop>" es NINCS "WHEN": minden INSERT / UPDATE vegigmegy rajtuk.
-- ------------------------------------------------------------
CREATE TRIGGER profiles_zz_revision_assign
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_field_revision_assign();

CREATE TRIGGER profiles_zz_revision_assert
  AFTER INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_field_revision_assert();

-- ------------------------------------------------------------
-- 7. Utoellenorzes (fail-closed): ha barmi nem pontosan az elvart, a teljes migracio visszagordul.
-- ------------------------------------------------------------
DO $post$
DECLARE
  b record;
  a record;
BEGIN
  SELECT * INTO b FROM profiles_094_before;
  -- ugyanaz a soronkenti, memoriakorlatos osszeg, a ket UJ kulcs nelkul
  SELECT count(*) AS rows_count,
         coalesce(sum((('x' || substr(md5((to_jsonb(t) - 'specific_focus_revision' - 'main_category_revision')::text), 1, 16))::bit(64)::bigint)::numeric), 0) AS row_hash_sum
    INTO a FROM public.profiles t;
  IF a.rows_count <> b.rows_count OR a.row_hash_sum <> b.row_hash_sum THEN
    RAISE EXCEPTION '094 post-check failed: the migration changed existing profile data (it must not)';
  END IF;

  -- minden revizio kiosztva, a ket oszlop soronkent es sorok kozott is mind kulonbozo
  IF (SELECT count(*) FROM (SELECT specific_focus_revision AS v FROM public.profiles UNION ALL SELECT main_category_revision FROM public.profiles) s)
     <> (SELECT count(DISTINCT v) FROM (SELECT specific_focus_revision AS v FROM public.profiles UNION ALL SELECT main_category_revision FROM public.profiles) s2) THEN
    RAISE EXCEPTION '094 post-check failed: backfilled revisions are not all distinct';
  END IF;

  -- oszlopok: bigint, NOT NULL, nincs DEFAULT
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles'
        AND column_name IN ('specific_focus_revision', 'main_category_revision')
        AND udt_name = 'int8' AND is_nullable = 'NO' AND column_default IS NULL) <> 2 THEN
    RAISE EXCEPTION '094 post-check failed: revision columns must be bigint NOT NULL without a default';
  END IF;

  -- megszoritasok: mindket CHECK (> 0) letezik es ervenyes; mindket egyedi index letezik, ervenyes, egy oszlopos,
  -- a megfelelo oszlopon
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.profiles'::regclass AND contype = 'c' AND convalidated
        AND conname IN ('profiles_specific_focus_revision_positive', 'profiles_main_category_revision_positive')) <> 2 THEN
    RAISE EXCEPTION '094 post-check failed: the revision CHECK constraints are missing or not validated';
  END IF;
  IF (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = 'public.profiles'::regclass AND i.indisunique AND i.indisvalid AND i.indnatts = 1 AND i.indpred IS NULL
        AND ((ic.relname = 'profiles_specific_focus_revision_key'
              AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attname = 'specific_focus_revision' AND NOT attisdropped))
          OR (ic.relname = 'profiles_main_category_revision_key'
              AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attname = 'main_category_revision' AND NOT attisdropped)))) <> 2 THEN
    RAISE EXCEPTION '094 post-check failed: the revision unique indexes are missing, invalid, partial or on the wrong column';
  END IF;

  -- szekvencia: definicio (a seqmax is) + jogok
  IF NOT EXISTS (SELECT 1 FROM pg_sequence
                 WHERE seqrelid = 'public.profiles_field_revision_seq'::regclass AND seqtypid = 'bigint'::regtype
                   AND seqincrement = 1 AND seqmin = 1 AND seqmax = 9223372036854775807 AND seqcache = 1 AND NOT seqcycle) THEN
    RAISE EXCEPTION '094 post-check failed: sequence definition drifted';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
             WHERE c.oid = 'public.profiles_field_revision_seq'::regclass
               AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole))) THEN
    RAISE EXCEPTION '094 post-check failed: the sequence grants privileges to PUBLIC/anon/authenticated/service_role';
  END IF;

  -- fuggvenyek: SECURITY DEFINER, search_path, a profiles tulajdonosa a tulajdonos, nincs szeles EXECUTE
  IF (SELECT count(*) FROM pg_proc p
      WHERE p.oid IN (to_regprocedure('public.profiles_field_revision_assign()'), to_regprocedure('public.profiles_field_revision_assert()'))
        AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND p.proacl IS NOT NULL
        AND p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'public.profiles'::regclass)
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) x
                        WHERE x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole))) <> 2 THEN
    RAISE EXCEPTION '094 post-check failed: trigger functions must be SECURITY DEFINER, pinned search_path, with no PUBLIC/anon/authenticated/service_role EXECUTE';
  END IF;

  -- triggerek: tipus, bekapcsolt allapot, OF/WHEN nelkul, a megfelelo fuggveny
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'public.profiles'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
        AND t.tgqual IS NULL AND COALESCE(array_length(t.tgattr::int2[], 1), 0) = 0 AND t.tgnargs = 0
        AND ((t.tgname = 'profiles_zz_revision_assign' AND t.tgtype = 23 AND p.proname = 'profiles_field_revision_assign')
          OR (t.tgname = 'profiles_zz_revision_assert' AND t.tgtype = 21 AND p.proname = 'profiles_field_revision_assert'))) <> 2 THEN
    RAISE EXCEPTION '094 post-check failed: revision triggers are missing, disabled, or have OF/WHEN/arguments';
  END IF;
END
$post$;

NOTIFY pgrst, 'reload schema';

COMMIT;
