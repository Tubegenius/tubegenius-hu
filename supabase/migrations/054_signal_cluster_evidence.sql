-- ============================================================
-- Migration 054: Emerging Signal capture — evidence<->cluster N:M
--
-- PFM-2C korrekcio a 051-es migracioban bevezetett 1-cluster modellre.
-- Az EREDETI terv (051, signal_evidence.signal_cluster_id, nullable FK)
-- azt feltetelezte, hogy egy evidence (egy konkret YouTube video vagy
-- web forras) LEGFELJEBB EGY klasztert tamogathat. Ez hibas: ugyanaz a
-- video/cikk tobb, kulon klasztert (kulon fingerprintu "sztorit") is
-- alatamaszthat egyszerre (pl. egy osszefoglalo video tobb kulonbozo
-- temarol).
--
-- Ez a migracio:
--   1) letrehozza a signal_cluster_evidence N:M kapcsolo tablat;
--   2) MEGSZUNTETI a signal_evidence.signal_cluster_id oszlopot (es a
--      hozza tartozo indexet/FK-t) — az evidence identitasa mostantol
--      klaszterfuggetlen, minden klaszter-kapcsolat KIZAROLAG a
--      signal_cluster_evidence tablaban el.
--
-- Mivel az 049-053 mar `origin/main`-en van, de PRODUCTION-on meg NINCS
-- alkalmazva, es a signal_evidence.signal_cluster_id mezo meg SEHOL nincs
-- production-adattal feltoltve — nincs adatvesztesi kockazat, es a
-- pusholt 049-053 fajlokat SZANDEKOSAN nem irjuk at visszamenoleg (uj,
-- kovetkezo migraciokent kerul be a korrekcio, ld. a repo altalanos
-- migracios konvenciojat: mar pusholt migraciot soha nem modositunk).
--
-- IDEMPOTENCIA + FAIL-FAST a vart 053-as kiindulo allapotra:
--   - Ha a signal_evidence.signal_cluster_id oszlop MEG letezik (053
--     utani, elso 054-fututas), a migracio ELOSZOR ellenorzi, hogy az a
--     051-ben dokumentalt pontos alakban letezik-e (nullable UUID, ON
--     DELETE SET NULL FK signal_clusters(id)-re, dedikalt index) — ha
--     BARMI elter ettol, RAISE EXCEPTION (nem tालal ki hallgatolagos
--     migraciot egy ismeretlen allapotra).
--   - Ha az oszlop MAR NEM letezik (`054` mar egyszer sikeresen lefutott
--     ezen a peldanyon — pl. `supabase db reset` ujra lejatssza a teljes
--     migracios lancot), a DROP-lepesek no-op-kent viselkednek (`IF
--     EXISTS`), a migracio a tobbi reszt (CREATE TABLE IF NOT EXISTS,
--     GRANT) ismet biztonsagosan vegrehajtja, majd a zaro validacio
--     ugyanugy lefut es zoldet ad.
--   - Barmilyen HARMADIK allapot (pl. az oszlop letezik, de mas FK/index
--     alakkal) fail-fast RAISE EXCEPTION-t valt ki.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. FAIL-FAST ELOFELTETEL-ELLENORZES a signal_evidence.signal_cluster_id
--    tenyleges (053-as) alakjara, MIELOTT barmit modositanank.
-- ============================================================

DO $precheck$
DECLARE
  col_exists boolean;
  fk_deltype "char";
  idx_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_evidence' AND column_name = 'signal_cluster_id'
  ) INTO col_exists;

  IF col_exists THEN
    SELECT c.confdeltype INTO fk_deltype
    FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = 'signal_evidence' AND c.conname = 'signal_evidence_signal_cluster_id_fkey';

    IF fk_deltype IS DISTINCT FROM 'n' THEN
      RAISE EXCEPTION '054 precondition failed: signal_evidence_signal_cluster_id_fkey missing or not ON DELETE SET NULL (found %)', fk_deltype;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'signal_evidence' AND indexname = 'idx_signal_evidence_cluster'
    ) INTO idx_exists;
    IF NOT idx_exists THEN
      RAISE EXCEPTION '054 precondition failed: idx_signal_evidence_cluster missing while signal_cluster_id column still exists';
    END IF;
  END IF;
  -- col_exists = false: vagy ez a migracio mar egyszer lefutott (053-baseline
  -- utani ujrafuttatas), vagy az oszlop soha nem is letezett — mindket eset
  -- biztonsagos folytatas, a zaro validacio ugyis leleplezne, ha barmi
  -- hianyozna a vegallapotbol.
END;
$precheck$;

-- ============================================================
-- 2. signal_evidence.signal_cluster_id ELTAVOLITASA — explicit,
--    egyenkenti lepesek (index -> FK -> oszlop), NEM CASCADE-re
--    tamaszkodva, hogy semmi ne tunjon el hallgatolagosan.
-- ============================================================

DROP INDEX IF EXISTS public.idx_signal_evidence_cluster;
ALTER TABLE public.signal_evidence DROP CONSTRAINT IF EXISTS signal_evidence_signal_cluster_id_fkey;
ALTER TABLE public.signal_evidence DROP COLUMN IF EXISTS signal_cluster_id;

-- ============================================================
-- 3. UJ TABLA: signal_cluster_evidence (N:M evidence<->cluster)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.signal_cluster_evidence (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_cluster_id      UUID NOT NULL REFERENCES public.signal_clusters(id) ON DELETE CASCADE,
  signal_evidence_id      UUID NOT NULL REFERENCES public.signal_evidence(id) ON DELETE CASCADE,
  linked_in_run_id        UUID REFERENCES public.signal_runs(id) ON DELETE SET NULL,
  relation_type           TEXT NOT NULL DEFAULT 'supports',
  -- MVP: a jelenlegi iro-kod SOHA nem szamit tenyleges match-konfidenciat
  -- a cluster<->evidence kapcsolatra (az egyetlen jelenleg irt relacio a
  -- "ez az evidence ebbol a candidate-bol szarmazott, aminek EZ a
  -- fingerprintje" — determinisztikus teny, nem mert valoszinuseg). Ezert
  -- NULL, amig nincs valodi meres — SOHA nem kitalalt szam (pl. korabban
  -- hibasan hasznalt 60-as konstans mintajara, ld. signal_entities
  -- proxy-hiba, PFM-2C korrekcio).
  relation_confidence      INTEGER,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT signal_cluster_evidence_cluster_evidence_key UNIQUE (signal_cluster_id, signal_evidence_id),
  -- Szandekosan SZUK, dokumentalt ertekkeszlet — a jelenlegi iro-kod
  -- KIZAROLAG 'supports'-ot ir. Egy jovobeli relacio-tipus (pl.
  -- 'mentions', 'duplicate_of') bevezetese EZT a CHECK-et bovito, uj
  -- migraciot igenyel — nincs "elore felvett", meg nem hasznalt ertek.
  CONSTRAINT signal_cluster_evidence_relation_type_check CHECK (relation_type IN ('supports')),
  CONSTRAINT signal_cluster_evidence_confidence_range CHECK (relation_confidence IS NULL OR relation_confidence BETWEEN 0 AND 100)
);

-- Masodik oszlop indexe a kompozit UNIQUE-hoz (a signal_cluster_id mint
-- elso oszlop mar lefedett a UNIQUE indexen keresztul) — ugyanaz a minta,
-- mint idx_signal_cluster_members_entity / idx_signal_run_clusters_cluster.
CREATE INDEX IF NOT EXISTS idx_signal_cluster_evidence_evidence ON public.signal_cluster_evidence(signal_evidence_id);

-- ============================================================
-- 4. RLS + GRANTOK — csak INSERT+SELECT (nincs UPDATE/DELETE, a
--    kapcsolat-sorok immutabilisnak szantak, ugyanaz a minta mint
--    signal_evidence/signal_entities/signal_cluster_members eseten).
-- ============================================================

ALTER TABLE public.signal_cluster_evidence ENABLE ROW LEVEL SECURITY;

GRANT INSERT, SELECT ON public.signal_cluster_evidence TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- 5. FAIL-FAST VEGALLAPOT-VALIDACIO
-- ============================================================

DO $validate$
DECLARE
  bad_owner_count int;
  bad_rls_count int;
  policy_count int;
  bad_grant_count int;
  forbidden_grant_count int;
  missing_constraint_count int;
  bad_fk_count int;
  old_column_count int;
  old_index_count int;
  old_fk_count int;
BEGIN
  -- 5a. signal_cluster_id oszlop/index/FK TENYLEG eltunt signal_evidence-rol
  SELECT count(*) INTO old_column_count FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'signal_evidence' AND column_name = 'signal_cluster_id';
  IF old_column_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: signal_evidence.signal_cluster_id still exists';
  END IF;

  SELECT count(*) INTO old_index_count FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'signal_evidence' AND indexname = 'idx_signal_evidence_cluster';
  IF old_index_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: idx_signal_evidence_cluster still exists';
  END IF;

  SELECT count(*) INTO old_fk_count FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
  WHERE cl.relname = 'signal_evidence' AND c.conname = 'signal_evidence_signal_cluster_id_fkey';
  IF old_fk_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: signal_evidence_signal_cluster_id_fkey still exists';
  END IF;

  -- 5b. Owner
  SELECT count(*) INTO bad_owner_count FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'signal_cluster_evidence' AND tableowner <> 'postgres';
  IF bad_owner_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: signal_cluster_evidence not owned by postgres';
  END IF;

  -- 5c. RLS
  SELECT count(*) INTO bad_rls_count FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'signal_cluster_evidence' AND rowsecurity IS NOT TRUE;
  IF bad_rls_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: signal_cluster_evidence RLS not enabled';
  END IF;

  -- 5d. Nulla policy
  SELECT count(*) INTO policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'signal_cluster_evidence';
  IF policy_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: unexpected policy on signal_cluster_evidence — found %', policy_count;
  END IF;

  -- 5e. service_role grantok pontosan INSERT+SELECT
  SELECT count(*) INTO bad_grant_count
  FROM (
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_cluster_evidence' AND grantee = 'service_role'
    EXCEPT SELECT * FROM (VALUES ('INSERT'), ('SELECT')) AS expected(privilege_type)
  ) extra
  UNION ALL
  SELECT count(*) FROM (
    SELECT * FROM (VALUES ('INSERT'), ('SELECT')) AS expected(privilege_type)
    EXCEPT
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_cluster_evidence' AND grantee = 'service_role'
  ) missing;
  IF bad_grant_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: service_role grant mismatch on signal_cluster_evidence (% rows)', bad_grant_count;
  END IF;

  -- 5f. anon/authenticated nulla joga
  SELECT count(*) INTO forbidden_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'signal_cluster_evidence' AND grantee IN ('anon', 'authenticated');
  IF forbidden_grant_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: anon/authenticated has % unexpected grant(s) on signal_cluster_evidence', forbidden_grant_count;
  END IF;

  -- 5g. Constraintok
  SELECT count(*) INTO missing_constraint_count
  FROM (VALUES
    ('signal_cluster_evidence_cluster_evidence_key'),
    ('signal_cluster_evidence_relation_type_check'),
    ('signal_cluster_evidence_confidence_range')
  ) AS expected(conname)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = 'signal_cluster_evidence' AND c.conname = expected.conname
  );
  IF missing_constraint_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: % expected constraint(s) missing on signal_cluster_evidence', missing_constraint_count;
  END IF;

  -- 5h. FK ON DELETE akciok
  SELECT count(*) INTO bad_fk_count
  FROM (VALUES
    ('signal_cluster_evidence_signal_cluster_id_fkey', 'c'),
    ('signal_cluster_evidence_signal_evidence_id_fkey', 'c'),
    ('signal_cluster_evidence_linked_in_run_id_fkey', 'n')
  ) AS expected(conname, expected_deltype)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = 'signal_cluster_evidence' AND c.conname = expected.conname AND c.confdeltype = expected.expected_deltype
  );
  IF bad_fk_count > 0 THEN
    RAISE EXCEPTION '054 validation failed: % FK(s) missing or wrong ON DELETE action on signal_cluster_evidence', bad_fk_count;
  END IF;

  -- 5i. DELETE grant sehol
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_cluster_evidence' AND grantee = 'service_role' AND privilege_type = 'DELETE'
  ) THEN
    RAISE EXCEPTION '054 validation failed: unexpected DELETE grant on signal_cluster_evidence';
  END IF;

  RAISE NOTICE '054 validation PASSED: signal_evidence.signal_cluster_id removed, signal_cluster_evidence created with exact grant/RLS/constraint matrix.';
END;
$validate$;

COMMIT;
