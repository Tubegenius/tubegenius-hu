-- ============================================================
-- Migration 051: Emerging Signal capture — evidence
--
-- PFM-2A, 3. resze. Fugg: 049 (signal_runs, signal_sources), 050
-- (signal_clusters), es a mar letezo 011-es youtube_videos tablatol.
--
-- YOUTUBE EVIDENCE FK/CHECK JAVITAS (PFM-1D hiba korrigalva PFM-2A-ban):
-- A TARTOS IDENTITAS harom mezo: evidence_type + signal_source_id +
-- external_ref — EGYIKUK SEM erintett semmilyen ON DELETE akcio altal
-- (external_ref sima szoveg, nem FK-celpont). A `youtube_videos_ref` mezo
-- KIZAROLAG opcionalis JOIN-kenyelmi hivatkozas: nullable, ON DELETE SET
-- NULL, es SZANDEKOSAN nem resze semmilyen CHECK-nek — igy a
-- youtube_videos szulo-sor torlese SOSEM utkozhet egyetlen CHECK
-- constraint-tel sem, mert a CHECK-ek kizarolag az external_ref/
-- canonical_url mezokre epulnek, amiket semmilyen FK-akcio nem erint.
--
-- NINCS 11-karakteres YouTube-ID formatum-kenyszer DB-szinten (korabbi
-- PFM-1D terv visszavonva) — az external_ref egyszeruen "nem ures/nem
-- csak whitespace" szoveg, fuggetlenul a YouTube ID tenyleges jovobeli
-- formatumatol.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.signal_evidence (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_cluster_id          UUID REFERENCES public.signal_clusters(id) ON DELETE SET NULL,
  signal_source_id            UUID NOT NULL REFERENCES public.signal_sources(id) ON DELETE RESTRICT,
  evidence_type              TEXT NOT NULL,
  -- A tartos identitas erteke: youtube_video eseten a video_id, serper_*
  -- eseten a nyers URL. Ez a mezo SOSEM NULL, SOSEM cascade-elt.
  external_ref                TEXT NOT NULL,
  -- Opcionalis JOIN-kenyelem — ld. a fenti fejlec-magyarazatot. TEXT tipus,
  -- mert a youtube_videos.video_id PK is TEXT (011-es migracio).
  youtube_videos_ref          TEXT REFERENCES public.youtube_videos(video_id) ON DELETE SET NULL,
  title                      TEXT NOT NULL,
  snippet                    TEXT,
  published_at                TIMESTAMPTZ,
  canonical_url               TEXT,
  is_syndication_copy_of      UUID REFERENCES public.signal_evidence(id) ON DELETE SET NULL,
  discovered_in_run_id        UUID NOT NULL REFERENCES public.signal_runs(id) ON DELETE RESTRICT,
  first_seen_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT signal_evidence_identity_key UNIQUE (evidence_type, signal_source_id, external_ref),
  CONSTRAINT signal_evidence_type_check CHECK (evidence_type IN ('youtube_video', 'serper_news', 'serper_web')),
  CONSTRAINT signal_evidence_external_ref_not_blank CHECK (btrim(external_ref) <> ''),
  CONSTRAINT signal_evidence_title_not_blank CHECK (btrim(title) <> ''),
  -- Nem-YouTube evidence-nel kotelezo a canonical_url
  CONSTRAINT signal_evidence_canonical_url_required CHECK (
    evidence_type = 'youtube_video' OR canonical_url IS NOT NULL
  ),
  CONSTRAINT signal_evidence_not_syndication_of_self CHECK (is_syndication_copy_of IS NULL OR is_syndication_copy_of <> id)
);

-- Exact URL dedup — PARTIAL unique index, csak ahol canonical_url tenyleg
-- ki van toltve (youtube_video-nal NULL, ott nem is kell dedupolni ra).
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_evidence_canonical_url_unique
  ON public.signal_evidence(canonical_url) WHERE canonical_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signal_evidence_cluster ON public.signal_evidence(signal_cluster_id);
CREATE INDEX IF NOT EXISTS idx_signal_evidence_published_at ON public.signal_evidence(published_at);
CREATE INDEX IF NOT EXISTS idx_signal_evidence_discovered_in_run ON public.signal_evidence(discovered_in_run_id);
CREATE INDEX IF NOT EXISTS idx_signal_evidence_youtube_videos_ref ON public.signal_evidence(youtube_videos_ref);

-- ============================================================
-- RLS + GRANTOK — nincs UPDATE (a jovobeli snippet-purge job SAJAT,
-- kesobbi migracioban kapja meg ezt a jogot, nem most).
-- ============================================================

ALTER TABLE public.signal_evidence ENABLE ROW LEVEL SECURITY;

GRANT INSERT, SELECT ON public.signal_evidence TO service_role;

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
  partial_index_count int;
BEGIN
  SELECT count(*) INTO bad_owner_count FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'signal_evidence' AND tableowner <> 'postgres';
  IF bad_owner_count > 0 THEN
    RAISE EXCEPTION '051 validation failed: signal_evidence not owned by postgres';
  END IF;

  SELECT count(*) INTO bad_rls_count FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'signal_evidence' AND rowsecurity IS NOT TRUE;
  IF bad_rls_count > 0 THEN
    RAISE EXCEPTION '051 validation failed: signal_evidence RLS not enabled';
  END IF;

  SELECT count(*) INTO policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'signal_evidence';
  IF policy_count > 0 THEN
    RAISE EXCEPTION '051 validation failed: unexpected policy on signal_evidence — found %', policy_count;
  END IF;

  SELECT count(*) INTO bad_grant_count
  FROM (
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_evidence' AND grantee = 'service_role'
    EXCEPT SELECT * FROM (VALUES ('INSERT'), ('SELECT')) AS expected(privilege_type)
  ) extra
  UNION ALL
  SELECT count(*) FROM (
    SELECT * FROM (VALUES ('INSERT'), ('SELECT')) AS expected(privilege_type)
    EXCEPT
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'signal_evidence' AND grantee = 'service_role'
  ) missing;
  IF bad_grant_count > 0 THEN
    RAISE EXCEPTION '051 validation failed: service_role grant mismatch on signal_evidence (% rows)', bad_grant_count;
  END IF;

  SELECT count(*) INTO forbidden_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'signal_evidence' AND grantee IN ('anon', 'authenticated');
  IF forbidden_grant_count > 0 THEN
    RAISE EXCEPTION '051 validation failed: anon/authenticated has % unexpected grant(s) on signal_evidence', forbidden_grant_count;
  END IF;

  SELECT count(*) INTO missing_constraint_count
  FROM (VALUES
    ('signal_evidence_identity_key'), ('signal_evidence_type_check'),
    ('signal_evidence_canonical_url_required'), ('signal_evidence_not_syndication_of_self')
  ) AS expected(conname)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = 'signal_evidence' AND c.conname = expected.conname
  );
  IF missing_constraint_count > 0 THEN
    RAISE EXCEPTION '051 validation failed: % expected constraint(s) missing', missing_constraint_count;
  END IF;

  -- Kritikus: youtube_videos_ref FK ON DELETE SET NULL, ES NEM resze
  -- semmilyen CHECK-nek (a CHECK-lista fentebb zart, csak a 4 nevezett
  -- constraint letezik — ha barmi tobb lenne, azt kulon vizsgalnank).
  SELECT count(*) INTO bad_fk_count
  FROM (VALUES
    ('signal_evidence_signal_cluster_id_fkey', 'n'),
    ('signal_evidence_signal_source_id_fkey', 'r'),
    ('signal_evidence_youtube_videos_ref_fkey', 'n'),
    ('signal_evidence_is_syndication_copy_of_fkey', 'n'),
    ('signal_evidence_discovered_in_run_id_fkey', 'r')
  ) AS expected(conname, expected_deltype)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = 'signal_evidence' AND c.conname = expected.conname AND c.confdeltype = expected.expected_deltype
  );
  IF bad_fk_count > 0 THEN
    RAISE EXCEPTION '051 validation failed: % FK(s) missing or wrong ON DELETE action', bad_fk_count;
  END IF;

  SELECT count(*) INTO partial_index_count
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'signal_evidence'
    AND indexname = 'idx_signal_evidence_canonical_url_unique'
    AND indexdef LIKE '%WHERE (canonical_url IS NOT NULL)%';
  IF partial_index_count <> 1 THEN
    RAISE EXCEPTION '051 validation failed: canonical_url partial unique index missing or malformed';
  END IF;
END;
$validate$;

COMMIT;
