-- ============================================================
-- Migration 042: Capture creator_memory schema drift
--
-- A P0/1H teljes production <-> clean rebuild reconciliation audit
-- (2026-07-23, production pg_catalog/information_schema export,
-- kizarolag metaadat-lekerdezesbol, nulla felhasznaloi sor olvasasabol)
-- ugyanazt a drift-osztalyt talalta a creator_memory tablan, mint amit
-- a 041 a profiles-nal mar lezart: 4, production-ban elo, sosem migralt
-- oszlop.
--
-- Elo kod bizonyitja, hogy nem holt mezokrol van szo:
-- app/api/memory/route.ts minden creator_memory INSERT-je kozvetlenul
-- olvassa es irja mind a negyet (search_keyword, audit_score, audit_id,
-- video_package_id).
--
-- Production teljes creator_memory constraint/index lista (ugyanabbol
-- az exportbol) igazolja pontosan mi jar hozza:
--   COLUMN search_keyword      MISSING_LOCAL  (text, nullable, nincs default)
--   COLUMN audit_score         MISSING_LOCAL  (integer, nullable, nincs default)
--   COLUMN video_package_id    MISSING_LOCAL  (uuid, nullable, nincs default)
--   COLUMN audit_id            MISSING_LOCAL  (uuid, nullable, nincs default)
--   CONSTRAINT creator_memory_video_package_id_fkey  MISSING_LOCAL
--     FOREIGN KEY (video_package_id) REFERENCES video_packages(id) ON DELETE SET NULL
--
-- audit_id-re EXPLICIT ellenorizve: a production constraint-lista
-- (opportunity_score_check, pkey, state_check, user_id_fkey,
-- user_id_topic_key, user_topic_unique, video_idea_id_fkey,
-- video_package_id_fkey, viral_score_check) NEM tartalmaz semmilyen
-- audit_id-hez kotott FK-t, CHECK-et vagy indexet — az audit_id
-- productionben is csupan egy sima, kapcsolat nelkuli UUID oszlop.
-- Ugyanigy video_package_id-re sincs kulon index productionben (csak
-- a video_idea_id-nak van, idx_creator_memory_video_idea), ezert ez a
-- migracio szandekosan NEM hoz letre uj indexet egyikre sem — az
-- pluszlenne a bizonyitott production-allapothoz kepest.
--
-- A production tartalmaz meg egy MASODIK, redundans UNIQUE(user_id, topic)
-- constraint-et is (creator_memory_user_topic_unique) a mar meglevo
-- creator_memory_user_id_topic_key mellett — ez egy production-oldali
-- technikai adossag (ket kulon migracio/kezi lepes ugyanazt a
-- egyedisegi szabalyt vitte fel ket nevvel), FUNKCIONALISAN semmi
-- ujat nem ad a mar meglevo constraint felett, ezert ez a migracio
-- SZANDEKOSAN NEM reprodukalja.
--
-- Nem nyul a 001-hez, nem kerul a 003-ba. Csak production-ban
-- bizonyitott, lokalisan hianyzo objektumokat rogzit. Adatot nem
-- torol, letezo mezoertekeket nem ir at.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.migration_042_ensure_column(
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

SELECT pg_temp.migration_042_ensure_column('creator_memory','search_keyword','TEXT','text',true,NULL);
SELECT pg_temp.migration_042_ensure_column('creator_memory','audit_score','INTEGER','int4',true,NULL);
SELECT pg_temp.migration_042_ensure_column('creator_memory','video_package_id','UUID','uuid',true,NULL);
SELECT pg_temp.migration_042_ensure_column('creator_memory','audit_id','UUID','uuid',true,NULL);

-- ------------------------------------------------------------
-- creator_memory_video_package_id_fkey — hianyzik: letrehozza;
-- egyezik: no-op; elter: fail-fast.
-- ------------------------------------------------------------

DO $$
DECLARE
  existing_def text;
  expected_def text := 'FOREIGN KEY (video_package_id) REFERENCES video_packages(id) ON DELETE SET NULL';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.creator_memory'::regclass AND conname = 'creator_memory_video_package_id_fkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.creator_memory ADD CONSTRAINT creator_memory_video_package_id_fkey
      FOREIGN KEY (video_package_id) REFERENCES public.video_packages(id) ON DELETE SET NULL;
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'creator_memory_video_package_id_fkey unexpected definition: %', existing_def;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
