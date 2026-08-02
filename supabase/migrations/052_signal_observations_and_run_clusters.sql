-- ============================================================
-- Migration 052: Emerging Signal capture — observations + run/cluster
-- vizsgalati bizonyitek
--
-- PFM-2A, 4. resze. Fugg: 049 (signal_runs), 050 (signal_clusters), 051
-- (signal_evidence).
--
--   signal_observations  — evidence-kozpontu, idosoros MERT (nyers,
--                          nem-negativ) ertek
--   signal_run_clusters  — "melyik run melyik klasztert vizsgalta, milyen
--                          eredmennyel" — a run puszta letezese onmagaban
--                          NEM bizonyitek egy adott klaszter vizsgalatara.
--
-- OBSERVATION BUCKET — kulon mezok, NEM egyetlen kodolt string (PFM-2A
-- korrekcio a korabbi "cadence:iso-timestamp" string-encoding tervhez
-- kepest): `cadence` (enum), `bucket_start` (TIMESTAMPTZ), `observed_at`
-- (TIMESTAMPTZ, a tenyleges meres pillanata). Az idempotens termeszetes
-- kulcs mind a negy azonosito mezot tartalmazza (signal_evidence_id,
-- metric_type, cadence, bucket_start) — mivel a bucket_start onmagaban
-- (kulon oszlopkent, nem string-prefixszel) NEM disambigual a cadence-ek
-- kozott (pl. egy napi es egy heti bucket kezdete egybeeshet hetfon), a
-- cadence-nek KOTELEZOEN resze kell legyen a UNIQUE-nak.
--
-- A `signal_observations.metric_value` KIZAROLAG nyers, termeszetenel
-- fogva nem-negativ mertekszamokat tarol (view/like/comment_count,
-- serper evidence-szamlalo). Szamitott momentum/acceleration (ami a nyers
-- delta szintjen lehetne negativ) SOHA nem kerul ebbe a tablaba — azok
-- kesobbi korben, egy kulon signal_snapshots tablaban elnek majd, mar
-- normalizalt, sosem negativ formaban. Ez a tabla meg nem is letezik
-- ebben a korben.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.signal_observations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_evidence_id     UUID NOT NULL REFERENCES public.signal_evidence(id) ON DELETE CASCADE,
  signal_run_id          UUID REFERENCES public.signal_runs(id) ON DELETE SET NULL,
  metric_type           TEXT NOT NULL,
  metric_value           NUMERIC NOT NULL,
  cadence               TEXT NOT NULL,
  bucket_start           TIMESTAMPTZ NOT NULL,
  observed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT signal_observations_natural_key UNIQUE (signal_evidence_id, metric_type, cadence, bucket_start),
  CONSTRAINT signal_observations_metric_type_check CHECK (metric_type IN (
    'youtube_view_count', 'youtube_like_count', 'youtube_comment_count',
    'serper_evidence_count', 'serper_new_evidence_count'
  )),
  CONSTRAINT signal_observations_metric_value_nonneg CHECK (metric_value >= 0),
  CONSTRAINT signal_observations_cadence_check CHECK (cadence IN ('early8h', 'daily', 'weekly', 'on_demand'))
);

CREATE INDEX IF NOT EXISTS idx_signal_observations_evidence_observed ON public.signal_observations(signal_evidence_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_signal_observations_bucket_start ON public.signal_observations(bucket_start);

CREATE TABLE IF NOT EXISTS public.signal_run_clusters (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_run_id            UUID NOT NULL REFERENCES public.signal_runs(id) ON DELETE CASCADE,
  signal_cluster_id         UUID NOT NULL REFERENCES public.signal_clusters(id) ON DELETE CASCADE,
  -- Milyen bemenetbol dolgozott a vizsgalat — hash, NEM a nyers bemenet
  -- (nincs raw request payload/prompt tarolva, ld. lent).
  input_summary_hash      TEXT NOT NULL,
  new_evidence_found      BOOLEAN NOT NULL DEFAULT false,
  new_evidence_count      INTEGER NOT NULL DEFAULT 0,
  check_status            TEXT NOT NULL,
  skip_reason             TEXT,
  -- Kizarolag nem erzekeny hiba-KATEGORIA — SOHA nem stack trace, API-kulcs,
  -- prompt vagy raw request payload (ld. a fejlec-magyarazatot).
  error_class             TEXT,
  checked_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT signal_run_clusters_run_cluster_key UNIQUE (signal_run_id, signal_cluster_id),
  CONSTRAINT signal_run_clusters_status_check CHECK (check_status IN ('completed', 'failed', 'skipped')),
  CONSTRAINT signal_run_clusters_evidence_count_nonneg CHECK (new_evidence_count >= 0),
  CONSTRAINT signal_run_clusters_found_matches_count CHECK (new_evidence_found = (new_evidence_count > 0)),
  CONSTRAINT signal_run_clusters_input_hash_not_blank CHECK (btrim(input_summary_hash) <> ''),
  -- skip_reason PONTOSAN akkor kotelezo, ha skipped; completed/failed-nel tilos
  CONSTRAINT signal_run_clusters_skip_reason_matches_status CHECK (
    (check_status = 'skipped' AND skip_reason IS NOT NULL) OR
    (check_status IN ('completed', 'failed') AND skip_reason IS NULL)
  ),
  -- error_class kizarolag failed statusznal lehet kitoltve
  CONSTRAINT signal_run_clusters_error_class_only_when_failed CHECK (
    check_status = 'failed' OR error_class IS NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_signal_run_clusters_cluster ON public.signal_run_clusters(signal_cluster_id);
CREATE INDEX IF NOT EXISTS idx_signal_run_clusters_checked_at ON public.signal_run_clusters(checked_at);

-- ============================================================
-- RLS + GRANTOK
-- ============================================================

ALTER TABLE public.signal_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_run_clusters ENABLE ROW LEVEL SECURITY;

GRANT INSERT, SELECT, UPDATE ON public.signal_observations TO service_role;
GRANT INSERT, SELECT, UPDATE ON public.signal_run_clusters TO service_role;

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
  SELECT count(*) INTO bad_owner_count FROM pg_tables
  WHERE schemaname = 'public' AND tablename IN ('signal_observations', 'signal_run_clusters')
    AND tableowner <> 'postgres';
  IF bad_owner_count > 0 THEN
    RAISE EXCEPTION '052 validation failed: % table(s) not owned by postgres', bad_owner_count;
  END IF;

  SELECT count(*) INTO bad_rls_count FROM pg_tables
  WHERE schemaname = 'public' AND tablename IN ('signal_observations', 'signal_run_clusters')
    AND rowsecurity IS NOT TRUE;
  IF bad_rls_count > 0 THEN
    RAISE EXCEPTION '052 validation failed: % table(s) do not have RLS enabled', bad_rls_count;
  END IF;

  SELECT count(*) INTO policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('signal_observations', 'signal_run_clusters');
  IF policy_count > 0 THEN
    RAISE EXCEPTION '052 validation failed: unexpected policy exists — found %', policy_count;
  END IF;

  SELECT count(*) INTO bad_grant_count
  FROM (
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee = 'service_role'
      AND table_name IN ('signal_observations', 'signal_run_clusters')
    EXCEPT
    SELECT * FROM (VALUES
      ('signal_observations', 'INSERT'), ('signal_observations', 'SELECT'), ('signal_observations', 'UPDATE'),
      ('signal_run_clusters', 'INSERT'), ('signal_run_clusters', 'SELECT'), ('signal_run_clusters', 'UPDATE')
    ) AS expected(table_name, privilege_type)
  ) extra
  UNION ALL
  SELECT count(*) FROM (
    SELECT * FROM (VALUES
      ('signal_observations', 'INSERT'), ('signal_observations', 'SELECT'), ('signal_observations', 'UPDATE'),
      ('signal_run_clusters', 'INSERT'), ('signal_run_clusters', 'SELECT'), ('signal_run_clusters', 'UPDATE')
    ) AS expected(table_name, privilege_type)
    EXCEPT
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee = 'service_role'
      AND table_name IN ('signal_observations', 'signal_run_clusters')
  ) missing;
  IF bad_grant_count > 0 THEN
    RAISE EXCEPTION '052 validation failed: service_role grant set mismatch (% rows)', bad_grant_count;
  END IF;

  SELECT count(*) INTO forbidden_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
    AND table_name IN ('signal_observations', 'signal_run_clusters');
  IF forbidden_grant_count > 0 THEN
    RAISE EXCEPTION '052 validation failed: anon/authenticated has % unexpected grant(s)', forbidden_grant_count;
  END IF;

  SELECT count(*) INTO missing_constraint_count
  FROM (VALUES
    ('signal_observations', 'signal_observations_natural_key'),
    ('signal_observations', 'signal_observations_metric_value_nonneg'),
    ('signal_observations', 'signal_observations_cadence_check'),
    ('signal_run_clusters', 'signal_run_clusters_run_cluster_key'),
    ('signal_run_clusters', 'signal_run_clusters_found_matches_count'),
    ('signal_run_clusters', 'signal_run_clusters_skip_reason_matches_status'),
    ('signal_run_clusters', 'signal_run_clusters_error_class_only_when_failed')
  ) AS expected(tbl, conname)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = expected.tbl AND c.conname = expected.conname
  );
  IF missing_constraint_count > 0 THEN
    RAISE EXCEPTION '052 validation failed: % expected constraint(s) missing', missing_constraint_count;
  END IF;

  SELECT count(*) INTO bad_fk_count
  FROM (VALUES
    ('signal_observations', 'signal_observations_signal_evidence_id_fkey', 'c'),
    ('signal_observations', 'signal_observations_signal_run_id_fkey', 'n'),
    ('signal_run_clusters', 'signal_run_clusters_signal_run_id_fkey', 'c'),
    ('signal_run_clusters', 'signal_run_clusters_signal_cluster_id_fkey', 'c')
  ) AS expected(tbl, conname, expected_deltype)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = expected.tbl AND c.conname = expected.conname AND c.confdeltype = expected.expected_deltype
  );
  IF bad_fk_count > 0 THEN
    RAISE EXCEPTION '052 validation failed: % FK(s) missing or wrong ON DELETE action', bad_fk_count;
  END IF;
END;
$validate$;

COMMIT;
