-- ============================================================
-- Migration 050: Emerging Signal capture — clusters + entity membership
--
-- PFM-2A, 2. resze. Fugg: 049 (signal_runs, signal_entities).
--   signal_clusters         — a score-olhato "sztori", determinisztikus
--                             fingerprinttel
--   signal_cluster_members  — entity<->cluster N:M, confidence-szel
--
-- ============================================================
-- CLUSTER FINGERPRINT — PONTOS ALGORITMUS ES INDOKLAS (PFM-2A korrekcio)
-- ============================================================
--
-- ELLENORZOTT TENY (lib/trend-radar.ts:121-141, grep-pelt 2026-08-02-en):
-- a `TrendCandidate` interfesz EXPORTALT mezoi:
--   id, candidate_topic, candidate_topic_en?, category, region,
--   trend_source_type, confidence, opportunity_type, serper_evidence_count,
--   youtube_relevant_videos_count, unique_creator_count, freshness_score,
--   pollution_score, relevance_average, source_videos[], web_sources[],
--   seed_keyword, market_type, reject_reason?
--
-- A `key_entity` mezo NEM resze ennek a listanak — kizarolag a
-- buildTrendCandidates() BELSO, nem exportalt `ExtractedTopic` tipusan
-- letezik feldolgozas kozben, es SOHA nem kerul at a vegleges,
-- visszaadott TrendCandidate objektumra. Ebbol kovetkezik: EGY JOVOBELI
-- iro-kod (ez a migracio meg NEM tartalmaz iro-kodot) a jelenlegi
-- TrendCandidate-bol UJ AI/API-hivas NELKUL NULLA elore kinyert,
-- confidence-pontozott entitast tud felhasznalni — csak szabad szoveges
-- mezoket (candidate_topic, candidate_topic_en, seed_keyword).
--
-- Ezert a "top-3 confidence-rangsorolt entitas" fingerprint-terv (PFM-1C/1D)
-- NEM valosithato meg uj kod nelkul, es ez a kor NEM ir uj kodot. Az MVP-elv
-- ("ha nincs megbizhato top-3 strukturalt entitas, ne talalj ki harmat")
-- szerint a JAVASOLT (de ITT MEG NEM IMPLEMENTALT) konzervativ formula:
--
--   fingerprint_input =
--     fingerprint_version || ":" ||
--     category || ":" ||
--     normalize(candidate_topic_en COALESCE candidate_topic) || ":" ||
--     normalize(seed_keyword)
--
--   normalize(x) = lowercase(x) -> NFD unicode-normalizacio -> ekezet
--     eltavolitas -> nem-alfanumerikus torles -> whitespace osszevonas
--     -> trim. (A mar 3 helyen hasznalt, bevalt normalizeForMatch-mintazat
--     ujrahasznositasa: lib/trend-radar.ts, lib/candidate-consistency.ts,
--     lib/niche-fit.ts.)
--
--   hash = SHA-256(fingerprint_input), teljes 64 hex karakteres alakban
--     tarolva (256 bit — tobb, mint a kotelezo minimum 128 bit).
--
-- FONTOS, EXPLICIT VISSZAVONT ALLITASOK a korabbi korokbol:
--   - A honap-bucket NEM resze a namespace-nek (korabbi PFM-1C hiba —
--     visszavonva ebben a korben, a user explicit utasitasara).
--   - NEM allitjuk, hogy egyszeru normalizalas osszehozna pl. az "altman"
--     es a "sam altman" szoveget — ezek KULONBOZO stringek normalizalas
--     utan is, entitas-felismeres (nem resze ennek a korenek) nelkul nem
--     egyeznek. A candidate_topic/seed_keyword-alapu fingerprint EZERT
--     SZANDEKOSAN konzervativabb (tobb false-split, kevesebb false-merge),
--     mint egy entitas-alapu valtozat lenne — ez OSSZHANGBAN van az MVP
--     elvvel ("false merge veszelyesebb, mint false split").
--
-- Tesztvektorok (a DB-reteg szempontjabol a "bemeneti string" a
-- tesztelheto resz, a tenyleges hash-szamitas jovobeli iro-kod feladata —
-- az itt megadott string-peldak NEM kerulnek be ebbe a migracioba, csak
-- dokumentaciokent):
--   A) category='tech_ai', candidate_topic_en='GPT-6 launch', seed='openai gpt6'
--      -> input = "1:tech_ai:gpt 6 launch:openai gpt6"
--   B) ugyanaz, mas megfogalmazasu candidate_topic_en='OpenAI GPT-6 megjelent'
--      -> input = "1:tech_ai:openai gpt 6 megjelent:openai gpt6" (ELTER A-tol!
--      -> KULONBOZO fingerprint — ez a candidate_topic-alapu terv dokumentalt
--      korlatja: nem paraphrase-tolerans, csak a seed_keyword-azonossag
--      menti at a legtobb ismetelt lekerdezest ugyanarra a klaszterre)
--   C) fingerprint_version=2 ugyanarra a bemenetre -> MAS sor, a UNIQUE(
--      cluster_fingerprint, fingerprint_version) miatt nem utkozik A-val
--
-- EZ A MIGRACIO ONMAGABAN CSAK A SEMAT hozza letre (TEXT oszlop + INTEGER
-- verzio + UNIQUE constraint) — algoritmus-fuggetlen. A tenyleges ertek-
-- szamitas egy KOVETKEZO kor iro-kodjanak feladata.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.signal_clusters (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_label                 TEXT NOT NULL,
  category                      TEXT,
  cluster_fingerprint            TEXT NOT NULL,
  fingerprint_version            INTEGER NOT NULL DEFAULT 1,
  status                        TEXT NOT NULL DEFAULT 'active',
  merged_into_cluster_id         UUID REFERENCES public.signal_clusters(id) ON DELETE SET NULL,
  split_from_cluster_id          UUID REFERENCES public.signal_clusters(id) ON DELETE SET NULL,
  created_by_run_id              UUID NOT NULL REFERENCES public.signal_runs(id) ON DELETE RESTRICT,
  first_evidence_published_at    TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Kotelezo egyedi constraint a fingerprint+verzio parra — ez a cluster
  -- idempotenciajanak DB-szintu garanciaja (nem app-level SELECT-majd-INSERT).
  CONSTRAINT signal_clusters_fingerprint_version_key UNIQUE (cluster_fingerprint, fingerprint_version),
  CONSTRAINT signal_clusters_status_check CHECK (status IN ('active', 'stale', 'merged', 'rejected')),
  CONSTRAINT signal_clusters_fingerprint_not_blank CHECK (btrim(cluster_fingerprint) <> ''),
  -- Legalabb 128 bit — nem koti meg konkretan a SHA-256-ot, hogy egy
  -- kesobbi algoritmus-valtas (fingerprint_version noveleset kiserve) ne
  -- utkozzon egy tul szoros DB-szintu formatum-kenyszerrel.
  CONSTRAINT signal_clusters_fingerprint_min_length CHECK (length(cluster_fingerprint) >= 32),
  CONSTRAINT signal_clusters_fingerprint_version_positive CHECK (fingerprint_version >= 1),
  CONSTRAINT signal_clusters_primary_label_not_blank CHECK (btrim(primary_label) <> ''),
  CONSTRAINT signal_clusters_merged_into_not_self CHECK (merged_into_cluster_id IS NULL OR merged_into_cluster_id <> id),
  CONSTRAINT signal_clusters_split_from_not_self CHECK (split_from_cluster_id IS NULL OR split_from_cluster_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_signal_clusters_status ON public.signal_clusters(status);
CREATE INDEX IF NOT EXISTS idx_signal_clusters_category ON public.signal_clusters(category);
CREATE INDEX IF NOT EXISTS idx_signal_clusters_first_evidence_published ON public.signal_clusters(first_evidence_published_at);
CREATE INDEX IF NOT EXISTS idx_signal_clusters_created_by_run ON public.signal_clusters(created_by_run_id);

CREATE TABLE IF NOT EXISTS public.signal_cluster_members (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_cluster_id    UUID NOT NULL REFERENCES public.signal_clusters(id) ON DELETE CASCADE,
  signal_entity_id      UUID NOT NULL REFERENCES public.signal_entities(id) ON DELETE CASCADE,
  match_confidence     NUMERIC NOT NULL,
  added_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT signal_cluster_members_cluster_entity_key UNIQUE (signal_cluster_id, signal_entity_id),
  CONSTRAINT signal_cluster_members_confidence_range CHECK (match_confidence BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_signal_cluster_members_entity ON public.signal_cluster_members(signal_entity_id);

-- ============================================================
-- RLS + GRANTOK
-- ============================================================

ALTER TABLE public.signal_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_cluster_members ENABLE ROW LEVEL SECURITY;

GRANT INSERT, SELECT, UPDATE ON public.signal_clusters TO service_role;
GRANT INSERT, SELECT ON public.signal_cluster_members TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- FAIL-FAST VEGALLAPOT-VALIDACIO
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
BEGIN
  SELECT count(*) INTO bad_owner_count
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename IN ('signal_clusters', 'signal_cluster_members')
    AND tableowner <> 'postgres';
  IF bad_owner_count > 0 THEN
    RAISE EXCEPTION '050 validation failed: % table(s) not owned by postgres', bad_owner_count;
  END IF;

  SELECT count(*) INTO bad_rls_count
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename IN ('signal_clusters', 'signal_cluster_members')
    AND rowsecurity IS NOT TRUE;
  IF bad_rls_count > 0 THEN
    RAISE EXCEPTION '050 validation failed: % table(s) do not have RLS enabled', bad_rls_count;
  END IF;

  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('signal_clusters', 'signal_cluster_members');
  IF policy_count > 0 THEN
    RAISE EXCEPTION '050 validation failed: unexpected RLS policy exists — found %', policy_count;
  END IF;

  SELECT count(*) INTO bad_grant_count
  FROM (
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee = 'service_role'
      AND table_name IN ('signal_clusters', 'signal_cluster_members')
    EXCEPT
    SELECT * FROM (VALUES
      ('signal_clusters', 'INSERT'), ('signal_clusters', 'SELECT'), ('signal_clusters', 'UPDATE'),
      ('signal_cluster_members', 'INSERT'), ('signal_cluster_members', 'SELECT')
    ) AS expected(table_name, privilege_type)
  ) extra
  UNION ALL
  SELECT count(*) FROM (
    SELECT * FROM (VALUES
      ('signal_clusters', 'INSERT'), ('signal_clusters', 'SELECT'), ('signal_clusters', 'UPDATE'),
      ('signal_cluster_members', 'INSERT'), ('signal_cluster_members', 'SELECT')
    ) AS expected(table_name, privilege_type)
    EXCEPT
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee = 'service_role'
      AND table_name IN ('signal_clusters', 'signal_cluster_members')
  ) missing;
  IF bad_grant_count > 0 THEN
    RAISE EXCEPTION '050 validation failed: service_role grant set mismatch (% rows)', bad_grant_count;
  END IF;

  SELECT count(*) INTO forbidden_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
    AND table_name IN ('signal_clusters', 'signal_cluster_members');
  IF forbidden_grant_count > 0 THEN
    RAISE EXCEPTION '050 validation failed: anon/authenticated has % unexpected grant(s)', forbidden_grant_count;
  END IF;

  SELECT count(*) INTO missing_constraint_count
  FROM (VALUES
    ('signal_clusters', 'signal_clusters_fingerprint_version_key'),
    ('signal_clusters', 'signal_clusters_status_check'),
    ('signal_clusters', 'signal_clusters_fingerprint_min_length'),
    ('signal_cluster_members', 'signal_cluster_members_cluster_entity_key'),
    ('signal_cluster_members', 'signal_cluster_members_confidence_range')
  ) AS expected(tbl, conname)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = expected.tbl AND c.conname = expected.conname
  );
  IF missing_constraint_count > 0 THEN
    RAISE EXCEPTION '050 validation failed: % expected constraint(s) missing', missing_constraint_count;
  END IF;

  -- FK ON DELETE akciok pontos ellenorzese (confdeltype: a=no action, r=restrict, c=cascade, n=set null)
  SELECT count(*) INTO bad_fk_count
  FROM (VALUES
    ('signal_clusters', 'signal_clusters_created_by_run_id_fkey', 'r'),
    ('signal_cluster_members', 'signal_cluster_members_signal_cluster_id_fkey', 'c'),
    ('signal_cluster_members', 'signal_cluster_members_signal_entity_id_fkey', 'c')
  ) AS expected(tbl, conname, expected_deltype)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = expected.tbl AND c.conname = expected.conname AND c.confdeltype = expected.expected_deltype
  );
  IF bad_fk_count > 0 THEN
    RAISE EXCEPTION '050 validation failed: % FK(s) missing or wrong ON DELETE action', bad_fk_count;
  END IF;
END;
$validate$;

COMMIT;
