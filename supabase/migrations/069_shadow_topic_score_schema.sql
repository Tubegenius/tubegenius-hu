-- ============================================================
-- Migration 069: Shadow Topic v0 — score schema foundation (S1)
--
-- PFM Shadow Topic v0. Kanonikus szerzodes forrasa: harom, egymast
-- pontosito Codex-jelentes (precedencia sorrendben, kesobbi felulirja
-- a korabbit):
--   1) "PFM Shadow Topic v0 - Vegleges Sema- es Szamitasi Szerzodes"
--   2) "PFM Shadow Topic v0 - Final Schema Closure Gate"
--   3) "PFM Shadow Topic v0 - Final Technical Correction Gate"
--      (legmagasabb prioritasu, ez a migracio EZT tukrozi pontosan)
--
-- Fail-fast szerzodes MINDEN objektumra (a 055-os migracio mintaja):
--   A) a tabla NEM letezik -> CREATE (tabla + index + RLS/FORCE + GRANT)
--   B) a tabla LETEZIK     -> byte-pontos VALIDACIO; pontos egyezes =
--                              NOTICE no-op; barmilyen elteres = RAISE
--                              EXCEPTION. A B) agban SOHA nem fut DDL/DCL.
--
-- HATOKOR (S1 - sema-only):
--   Pontosan ket uj tabla: signal_score_runs, signal_cluster_scores.
--   Nincs harmadik tabla, nincs RPC, nincs trigger, nincs backfill,
--   nincs adatiras, nincs ALTER egyetlen meglevo signal_* tablan sem.
--   service_role: SELECT only mindket uj tablan — a jovobeli iras
--   kizarolag SECURITY DEFINER RPC-ken keresztul tortenik (kesobbi
--   migracio), nem kozvetlen tabla-granton.
--
-- A v0 NEM ad vegleges, felhasznalonak mutathato pontszamot — kizarolag
-- diagnosztikai, reprodukalhato nyers komponenseket tarol.
-- ranking_eligible DB-CHECK-kel korlatozva mindig false-ra a v0-ban.
--
-- Reszletes tartalmi szerzodes: docs/architecture/shadow-topic-v0-contract.md
-- ============================================================

BEGIN;

-- ============================================================
-- 1. signal_score_runs
-- ============================================================

DO $migrate_ssr$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_score_runs')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    -- ============================================================
    -- A) CREATE BRANCH
    -- ============================================================
    RAISE NOTICE '069: signal_score_runs does not exist — CREATE branch.';

    CREATE TABLE public.signal_score_runs (
      id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      score_profile                     TEXT NOT NULL,
      layer                             TEXT NOT NULL,
      algorithm_version                 INTEGER NOT NULL,
      algorithm_config_hash             TEXT NOT NULL,
      algorithm_config_snapshot         JSONB NOT NULL,
      algorithm_config_schema_version   INTEGER NOT NULL,
      evaluation_time                   TIMESTAMPTZ NOT NULL,
      input_cutoff                      TIMESTAMPTZ NOT NULL,
      status                            TEXT NOT NULL DEFAULT 'processing',
      error_class                       TEXT,
      idempotency_key                   TEXT NOT NULL,
      started_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at                      TIMESTAMPTZ,
      created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT ssr_idempotency_key_key UNIQUE (idempotency_key),
      CONSTRAINT ssr_semantic_dup_key UNIQUE (score_profile, algorithm_version, algorithm_config_hash, evaluation_time, input_cutoff),
      CONSTRAINT ssr_score_profile_check CHECK (score_profile IN ('shadow_topic_v0')),
      CONSTRAINT ssr_layer_check CHECK (layer IN ('cluster_topic')),
      CONSTRAINT ssr_status_check CHECK (status IN ('processing', 'completed', 'failed')),
      CONSTRAINT ssr_idempotency_key_not_blank CHECK (btrim(idempotency_key) <> ''),
      CONSTRAINT ssr_algorithm_version_positive CHECK (algorithm_version >= 1),
      CONSTRAINT ssr_config_hash_format CHECK (algorithm_config_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ssr_cutoff_not_after_eval CHECK (input_cutoff <= evaluation_time),
      CONSTRAINT ssr_error_class_pairing CHECK ((status = 'failed') = (error_class IS NOT NULL)),
      CONSTRAINT ssr_completed_at_pairing CHECK ((status IN ('completed', 'failed')) = (completed_at IS NOT NULL)),
      CONSTRAINT ssr_completed_after_started CHECK (completed_at IS NULL OR completed_at >= started_at),
      CONSTRAINT ssr_config_snapshot_is_object CHECK (jsonb_typeof(algorithm_config_snapshot) = 'object'),
      CONSTRAINT ssr_config_schema_version_positive CHECK (algorithm_config_schema_version >= 1)
    );

    ALTER TABLE public.signal_score_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_score_runs FORCE ROW LEVEL SECURITY;

    -- SELECT only — a jovobeli iras kizarolag SECURITY DEFINER RPC-ken
    -- keresztul tortenik (kesobbi migracio), amik postgres-jogosultsaggal
    -- irnak; a service_role-nak nincs kozvetlen INSERT/UPDATE/DELETE joga.
    GRANT SELECT ON public.signal_score_runs TO service_role;

    RAISE NOTICE '069: signal_score_runs created.';
  ELSE
    -- ============================================================
    -- B) VALIDATE/NO-OP BRANCH — SOHA nem fut DDL/DCL.
    -- ============================================================
    RAISE NOTICE '069: signal_score_runs already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_score_runs' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '069 drift: signal_score_runs owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('score_profile', 'text', 'text', 'NO', NULL),
        ('layer', 'text', 'text', 'NO', NULL),
        ('algorithm_version', 'integer', 'int4', 'NO', NULL),
        ('algorithm_config_hash', 'text', 'text', 'NO', NULL),
        ('algorithm_config_snapshot', 'jsonb', 'jsonb', 'NO', NULL),
        ('algorithm_config_schema_version', 'integer', 'int4', 'NO', NULL),
        ('evaluation_time', 'timestamp with time zone', 'timestamptz', 'NO', NULL),
        ('input_cutoff', 'timestamp with time zone', 'timestamptz', 'NO', NULL),
        ('status', 'text', 'text', 'NO', '''processing''::text'),
        ('error_class', 'text', 'text', 'YES', NULL),
        ('idempotency_key', 'text', 'text', 'NO', NULL),
        ('started_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('completed_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signal_score_runs'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '069 drift: signal_score_runs column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_score_runs_pkey', 'p', 'PRIMARY KEY (id)'),
        ('ssr_idempotency_key_key', 'u', 'UNIQUE (idempotency_key)'),
        ('ssr_semantic_dup_key', 'u', 'UNIQUE (score_profile, algorithm_version, algorithm_config_hash, evaluation_time, input_cutoff)'),
        ('ssr_score_profile_check', 'c', 'CHECK (score_profile = ''shadow_topic_v0''::text)'),
        ('ssr_layer_check', 'c', 'CHECK (layer = ''cluster_topic''::text)'),
        ('ssr_status_check', 'c', 'CHECK (status = ANY (ARRAY[''processing''::text, ''completed''::text, ''failed''::text]))'),
        ('ssr_idempotency_key_not_blank', 'c', 'CHECK (btrim(idempotency_key) <> ''''::text)'),
        ('ssr_algorithm_version_positive', 'c', 'CHECK (algorithm_version >= 1)'),
        ('ssr_config_hash_format', 'c', 'CHECK (algorithm_config_hash ~ ''^[0-9a-f]{64}$''::text)'),
        ('ssr_cutoff_not_after_eval', 'c', 'CHECK (input_cutoff <= evaluation_time)'),
        ('ssr_error_class_pairing', 'c', 'CHECK ((status = ''failed''::text) = (error_class IS NOT NULL))'),
        ('ssr_completed_at_pairing', 'c', 'CHECK ((status = ANY (ARRAY[''completed''::text, ''failed''::text])) = (completed_at IS NOT NULL))'),
        ('ssr_completed_after_started', 'c', 'CHECK (completed_at IS NULL OR completed_at >= started_at)'),
        ('ssr_config_snapshot_is_object', 'c', 'CHECK (jsonb_typeof(algorithm_config_snapshot) = ''object''::text)'),
        ('ssr_config_schema_version_positive', 'c', 'CHECK (algorithm_config_schema_version >= 1)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.signal_score_runs'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '069 drift: signal_score_runs constraint set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_score_runs_pkey', 'true', 'CREATE UNIQUE INDEX signal_score_runs_pkey ON public.signal_score_runs USING btree (id)'),
        ('ssr_idempotency_key_key', 'true', 'CREATE UNIQUE INDEX ssr_idempotency_key_key ON public.signal_score_runs USING btree (idempotency_key)'),
        ('ssr_semantic_dup_key', 'true', 'CREATE UNIQUE INDEX ssr_semantic_dup_key ON public.signal_score_runs USING btree (score_profile, algorithm_version, algorithm_config_hash, evaluation_time, input_cutoff)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.signal_score_runs'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '069 drift: signal_score_runs index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_score_runs'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '069 drift: signal_score_runs RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_score_runs') THEN
      RAISE EXCEPTION '069 drift: signal_score_runs has an unexpected policy';
    END IF;

    -- Grantok — pontosan SELECT service_role-nak; 0 anon/authenticated/PUBLIC.
    -- Mindket EXCEPT-ag KULON zarojelben (055/054 megjegyzese: EXCEPT es
    -- UNION ALL azonos precedenciaju, balrol-jobbra ertekelodik — zarojel
    -- nelkul hamisan "egyezik"-et adhat vissza extra grant eseten is).
    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_score_runs' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_score_runs' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '069 drift: signal_score_runs service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_score_runs' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '069 drift: signal_score_runs has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '069: signal_score_runs already exists and matches exactly — no-op.';
  END IF;
END;
$migrate_ssr$;

-- ============================================================
-- 2. signal_cluster_scores (score_run_id FK-t hasznal, ezert a
--    signal_score_runs blokk UTAN kell kovetkeznie)
-- ============================================================

DO $migrate_scs$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_cluster_scores')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    -- ============================================================
    -- A) CREATE BRANCH
    -- ============================================================
    RAISE NOTICE '069: signal_cluster_scores does not exist — CREATE branch.';

    CREATE TABLE public.signal_cluster_scores (
      id                                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      score_run_id                           UUID NOT NULL REFERENCES public.signal_score_runs(id) ON DELETE RESTRICT,
      signal_cluster_id                      UUID NOT NULL REFERENCES public.signal_clusters(id) ON DELETE RESTRICT,

      evidence_count                         INTEGER NOT NULL,
      source_breadth                         INTEGER NOT NULL,
      youtube_evidence_count                 INTEGER NOT NULL,

      median_discovery_lag_hours             NUMERIC(12,4),
      median_observation_age_hours           NUMERIC(12,4),
      median_average_view_velocity_per_hour  NUMERIC(20,6),

      freshness_eligible_evidence_count      INTEGER NOT NULL,
      velocity_eligible_evidence_count       INTEGER NOT NULL,
      freshness_coverage NUMERIC(5,4) GENERATED ALWAYS AS (
        CASE WHEN youtube_evidence_count = 0 THEN 0.0000
             ELSE ROUND(freshness_eligible_evidence_count::numeric / youtube_evidence_count::numeric, 4)
        END
      ) STORED,
      velocity_coverage NUMERIC(5,4) GENERATED ALWAYS AS (
        CASE WHEN youtube_evidence_count = 0 THEN 0.0000
             ELSE ROUND(velocity_eligible_evidence_count::numeric / youtube_evidence_count::numeric, 4)
        END
      ) STORED,
      freshness_confidence_class             TEXT NOT NULL,
      velocity_confidence_class              TEXT NOT NULL,
      freshness_exclusion_reason             TEXT,
      velocity_exclusion_reason              TEXT,

      ranking_eligible                       BOOLEAN NOT NULL DEFAULT false,

      input_snapshot                         JSONB NOT NULL,
      input_digest                           TEXT NOT NULL,
      input_snapshot_schema_version          INTEGER NOT NULL,

      max_observed_at                        TIMESTAMPTZ,
      sampling_policy                        TEXT NOT NULL,

      created_at                             TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT scs_run_cluster_key UNIQUE (score_run_id, signal_cluster_id),
      CONSTRAINT scs_evidence_count_nonneg CHECK (evidence_count >= 0),
      CONSTRAINT scs_source_breadth_nonneg CHECK (source_breadth >= 0),
      CONSTRAINT scs_source_breadth_le_evidence CHECK (source_breadth <= evidence_count),
      CONSTRAINT scs_youtube_count_nonneg CHECK (youtube_evidence_count >= 0),
      CONSTRAINT scs_youtube_count_le_evidence CHECK (youtube_evidence_count <= evidence_count),
      CONSTRAINT scs_freshness_eligible_nonneg CHECK (freshness_eligible_evidence_count >= 0),
      CONSTRAINT scs_freshness_eligible_le_youtube CHECK (freshness_eligible_evidence_count <= youtube_evidence_count),
      CONSTRAINT scs_velocity_eligible_nonneg CHECK (velocity_eligible_evidence_count >= 0),
      CONSTRAINT scs_velocity_eligible_le_youtube CHECK (velocity_eligible_evidence_count <= youtube_evidence_count),
      CONSTRAINT scs_discovery_lag_nonneg CHECK (median_discovery_lag_hours IS NULL OR median_discovery_lag_hours >= 0),
      CONSTRAINT scs_observation_age_nonneg CHECK (median_observation_age_hours IS NULL OR median_observation_age_hours >= 0),
      CONSTRAINT scs_velocity_nonneg CHECK (median_average_view_velocity_per_hour IS NULL OR median_average_view_velocity_per_hour >= 0),
      CONSTRAINT scs_freshness_null_pairing CHECK (
        (freshness_eligible_evidence_count = 0
          AND median_discovery_lag_hours IS NULL
          AND median_observation_age_hours IS NULL
          AND freshness_confidence_class = 'unknown'
          AND freshness_exclusion_reason = 'no_eligible_evidence')
        OR
        (freshness_eligible_evidence_count > 0
          AND median_discovery_lag_hours IS NOT NULL
          AND median_observation_age_hours IS NOT NULL
          AND freshness_confidence_class IN ('proxy', 'measured')
          AND freshness_exclusion_reason IS NULL)
      ),
      CONSTRAINT scs_freshness_confidence_threshold CHECK (
        (freshness_eligible_evidence_count = 0 AND freshness_confidence_class = 'unknown')
        OR (freshness_eligible_evidence_count BETWEEN 1 AND 2 AND freshness_confidence_class = 'proxy')
        OR (freshness_eligible_evidence_count >= 3 AND freshness_confidence_class = 'measured')
      ),
      CONSTRAINT scs_velocity_null_pairing CHECK (
        (velocity_eligible_evidence_count = 0
          AND median_average_view_velocity_per_hour IS NULL
          AND velocity_confidence_class = 'unknown'
          AND velocity_exclusion_reason = 'no_eligible_evidence')
        OR
        (velocity_eligible_evidence_count > 0
          AND median_average_view_velocity_per_hour IS NOT NULL
          AND velocity_confidence_class IN ('proxy', 'measured')
          AND velocity_exclusion_reason IS NULL)
      ),
      CONSTRAINT scs_velocity_confidence_threshold CHECK (
        (velocity_eligible_evidence_count = 0 AND velocity_confidence_class = 'unknown')
        OR (velocity_eligible_evidence_count BETWEEN 1 AND 2 AND velocity_confidence_class = 'proxy')
        OR (velocity_eligible_evidence_count >= 3 AND velocity_confidence_class = 'measured')
      ),
      CONSTRAINT scs_freshness_confidence_class_check CHECK (freshness_confidence_class IN ('unknown', 'proxy', 'measured')),
      CONSTRAINT scs_velocity_confidence_class_check CHECK (velocity_confidence_class IN ('unknown', 'proxy', 'measured')),
      CONSTRAINT scs_freshness_exclusion_reason_check CHECK (freshness_exclusion_reason IS NULL OR freshness_exclusion_reason IN ('no_eligible_evidence')),
      CONSTRAINT scs_velocity_exclusion_reason_check CHECK (velocity_exclusion_reason IS NULL OR velocity_exclusion_reason IN ('no_eligible_evidence')),
      CONSTRAINT scs_ranking_eligible_false_in_v0 CHECK (ranking_eligible = false),
      CONSTRAINT scs_snapshot_is_object CHECK (jsonb_typeof(input_snapshot) = 'object'),
      CONSTRAINT scs_digest_format CHECK (input_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT scs_snapshot_schema_version_positive CHECK (input_snapshot_schema_version >= 1),
      CONSTRAINT scs_sampling_policy_check CHECK (sampling_policy IN ('scheduled_only')),
      CONSTRAINT scs_max_observed_at_pairing CHECK (
        (freshness_eligible_evidence_count = 0 AND velocity_eligible_evidence_count = 0 AND max_observed_at IS NULL)
        OR
        ((freshness_eligible_evidence_count > 0 OR velocity_eligible_evidence_count > 0) AND max_observed_at IS NOT NULL)
      )
    );

    CREATE INDEX idx_signal_cluster_scores_cluster ON public.signal_cluster_scores(signal_cluster_id);

    ALTER TABLE public.signal_cluster_scores ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.signal_cluster_scores FORCE ROW LEVEL SECURITY;

    -- SELECT only — append-only eredmenytabla, jovobeli iras kizarolag
    -- SECURITY DEFINER RPC-n keresztul (kesobbi migracio).
    GRANT SELECT ON public.signal_cluster_scores TO service_role;

    RAISE NOTICE '069: signal_cluster_scores created.';
  ELSE
    -- ============================================================
    -- B) VALIDATE/NO-OP BRANCH — SOHA nem fut DDL/DCL.
    -- ============================================================
    RAISE NOTICE '069: signal_cluster_scores already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signal_cluster_scores' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '069 drift: signal_cluster_scores owner is not postgres';
    END IF;

    -- Oszlopok — a ket GENERATED oszlopnal a numeric_precision/scale ES a
    -- generation_expression is resze az egzakt osszehasonlitasnak, mert
    -- a `numeric` data_type onmagaban nem kulonbozteti meg a precizios/
    -- scale-variansokat, es a generalt kifejezes maga a szamitasi
    -- szerzodes resze.
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()', NULL::int, NULL::int, 'NEVER', NULL::text),
        ('score_run_id', 'uuid', 'uuid', 'NO', NULL, NULL, NULL, 'NEVER', NULL),
        ('signal_cluster_id', 'uuid', 'uuid', 'NO', NULL, NULL, NULL, 'NEVER', NULL),
        ('evidence_count', 'integer', 'int4', 'NO', NULL, 32, 0, 'NEVER', NULL),
        ('source_breadth', 'integer', 'int4', 'NO', NULL, 32, 0, 'NEVER', NULL),
        ('youtube_evidence_count', 'integer', 'int4', 'NO', NULL, 32, 0, 'NEVER', NULL),
        ('median_discovery_lag_hours', 'numeric', 'numeric', 'YES', NULL, 12, 4, 'NEVER', NULL),
        ('median_observation_age_hours', 'numeric', 'numeric', 'YES', NULL, 12, 4, 'NEVER', NULL),
        ('median_average_view_velocity_per_hour', 'numeric', 'numeric', 'YES', NULL, 20, 6, 'NEVER', NULL),
        ('freshness_eligible_evidence_count', 'integer', 'int4', 'NO', NULL, 32, 0, 'NEVER', NULL),
        ('velocity_eligible_evidence_count', 'integer', 'int4', 'NO', NULL, 32, 0, 'NEVER', NULL),
        ('freshness_coverage', 'numeric', 'numeric', 'YES', NULL, 5, 4, 'ALWAYS', '
CASE
    WHEN (youtube_evidence_count = 0) THEN 0.0000
    ELSE round(((freshness_eligible_evidence_count)::numeric / (youtube_evidence_count)::numeric), 4)
END'),
        ('velocity_coverage', 'numeric', 'numeric', 'YES', NULL, 5, 4, 'ALWAYS', '
CASE
    WHEN (youtube_evidence_count = 0) THEN 0.0000
    ELSE round(((velocity_eligible_evidence_count)::numeric / (youtube_evidence_count)::numeric), 4)
END'),
        ('freshness_confidence_class', 'text', 'text', 'NO', NULL, NULL, NULL, 'NEVER', NULL),
        ('velocity_confidence_class', 'text', 'text', 'NO', NULL, NULL, NULL, 'NEVER', NULL),
        ('freshness_exclusion_reason', 'text', 'text', 'YES', NULL, NULL, NULL, 'NEVER', NULL),
        ('velocity_exclusion_reason', 'text', 'text', 'YES', NULL, NULL, NULL, 'NEVER', NULL),
        ('ranking_eligible', 'boolean', 'bool', 'NO', 'false', NULL, NULL, 'NEVER', NULL),
        ('input_snapshot', 'jsonb', 'jsonb', 'NO', NULL, NULL, NULL, 'NEVER', NULL),
        ('input_digest', 'text', 'text', 'NO', NULL, NULL, NULL, 'NEVER', NULL),
        ('input_snapshot_schema_version', 'integer', 'int4', 'NO', NULL, 32, 0, 'NEVER', NULL),
        ('max_observed_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL, NULL, NULL, 'NEVER', NULL),
        ('sampling_policy', 'text', 'text', 'NO', NULL, NULL, NULL, 'NEVER', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()', NULL, NULL, 'NEVER', NULL)
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default, numeric_precision, numeric_scale, is_generated, generation_expression)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity,
               numeric_precision, numeric_scale, is_generated, generation_expression
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signal_cluster_scores'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
         OR actual.numeric_precision IS DISTINCT FROM expected.numeric_precision
         OR actual.numeric_scale IS DISTINCT FROM expected.numeric_scale
         OR actual.is_generated IS DISTINCT FROM expected.is_generated
         OR actual.generation_expression IS DISTINCT FROM expected.generation_expression
    ) THEN
      RAISE EXCEPTION '069 drift: signal_cluster_scores column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_cluster_scores_pkey', 'p', 'PRIMARY KEY (id)'),
        ('signal_cluster_scores_score_run_id_fkey', 'f', 'FOREIGN KEY (score_run_id) REFERENCES signal_score_runs(id) ON DELETE RESTRICT'),
        ('signal_cluster_scores_signal_cluster_id_fkey', 'f', 'FOREIGN KEY (signal_cluster_id) REFERENCES signal_clusters(id) ON DELETE RESTRICT'),
        ('scs_run_cluster_key', 'u', 'UNIQUE (score_run_id, signal_cluster_id)'),
        ('scs_evidence_count_nonneg', 'c', 'CHECK (evidence_count >= 0)'),
        ('scs_source_breadth_nonneg', 'c', 'CHECK (source_breadth >= 0)'),
        ('scs_source_breadth_le_evidence', 'c', 'CHECK (source_breadth <= evidence_count)'),
        ('scs_youtube_count_nonneg', 'c', 'CHECK (youtube_evidence_count >= 0)'),
        ('scs_youtube_count_le_evidence', 'c', 'CHECK (youtube_evidence_count <= evidence_count)'),
        ('scs_freshness_eligible_nonneg', 'c', 'CHECK (freshness_eligible_evidence_count >= 0)'),
        ('scs_freshness_eligible_le_youtube', 'c', 'CHECK (freshness_eligible_evidence_count <= youtube_evidence_count)'),
        ('scs_velocity_eligible_nonneg', 'c', 'CHECK (velocity_eligible_evidence_count >= 0)'),
        ('scs_velocity_eligible_le_youtube', 'c', 'CHECK (velocity_eligible_evidence_count <= youtube_evidence_count)'),
        ('scs_discovery_lag_nonneg', 'c', 'CHECK (median_discovery_lag_hours IS NULL OR median_discovery_lag_hours >= 0::numeric)'),
        ('scs_observation_age_nonneg', 'c', 'CHECK (median_observation_age_hours IS NULL OR median_observation_age_hours >= 0::numeric)'),
        ('scs_velocity_nonneg', 'c', 'CHECK (median_average_view_velocity_per_hour IS NULL OR median_average_view_velocity_per_hour >= 0::numeric)'),
        ('scs_freshness_null_pairing', 'c', 'CHECK (freshness_eligible_evidence_count = 0 AND median_discovery_lag_hours IS NULL AND median_observation_age_hours IS NULL AND freshness_confidence_class = ''unknown''::text AND freshness_exclusion_reason = ''no_eligible_evidence''::text OR freshness_eligible_evidence_count > 0 AND median_discovery_lag_hours IS NOT NULL AND median_observation_age_hours IS NOT NULL AND (freshness_confidence_class = ANY (ARRAY[''proxy''::text, ''measured''::text])) AND freshness_exclusion_reason IS NULL)'),
        ('scs_freshness_confidence_threshold', 'c', 'CHECK (freshness_eligible_evidence_count = 0 AND freshness_confidence_class = ''unknown''::text OR freshness_eligible_evidence_count >= 1 AND freshness_eligible_evidence_count <= 2 AND freshness_confidence_class = ''proxy''::text OR freshness_eligible_evidence_count >= 3 AND freshness_confidence_class = ''measured''::text)'),
        ('scs_velocity_null_pairing', 'c', 'CHECK (velocity_eligible_evidence_count = 0 AND median_average_view_velocity_per_hour IS NULL AND velocity_confidence_class = ''unknown''::text AND velocity_exclusion_reason = ''no_eligible_evidence''::text OR velocity_eligible_evidence_count > 0 AND median_average_view_velocity_per_hour IS NOT NULL AND (velocity_confidence_class = ANY (ARRAY[''proxy''::text, ''measured''::text])) AND velocity_exclusion_reason IS NULL)'),
        ('scs_velocity_confidence_threshold', 'c', 'CHECK (velocity_eligible_evidence_count = 0 AND velocity_confidence_class = ''unknown''::text OR velocity_eligible_evidence_count >= 1 AND velocity_eligible_evidence_count <= 2 AND velocity_confidence_class = ''proxy''::text OR velocity_eligible_evidence_count >= 3 AND velocity_confidence_class = ''measured''::text)'),
        ('scs_freshness_confidence_class_check', 'c', 'CHECK (freshness_confidence_class = ANY (ARRAY[''unknown''::text, ''proxy''::text, ''measured''::text]))'),
        ('scs_velocity_confidence_class_check', 'c', 'CHECK (velocity_confidence_class = ANY (ARRAY[''unknown''::text, ''proxy''::text, ''measured''::text]))'),
        ('scs_freshness_exclusion_reason_check', 'c', 'CHECK (freshness_exclusion_reason IS NULL OR freshness_exclusion_reason = ''no_eligible_evidence''::text)'),
        ('scs_velocity_exclusion_reason_check', 'c', 'CHECK (velocity_exclusion_reason IS NULL OR velocity_exclusion_reason = ''no_eligible_evidence''::text)'),
        ('scs_ranking_eligible_false_in_v0', 'c', 'CHECK (ranking_eligible = false)'),
        ('scs_snapshot_is_object', 'c', 'CHECK (jsonb_typeof(input_snapshot) = ''object''::text)'),
        ('scs_digest_format', 'c', 'CHECK (input_digest ~ ''^[0-9a-f]{64}$''::text)'),
        ('scs_snapshot_schema_version_positive', 'c', 'CHECK (input_snapshot_schema_version >= 1)'),
        ('scs_sampling_policy_check', 'c', 'CHECK (sampling_policy = ''scheduled_only''::text)'),
        ('scs_max_observed_at_pairing', 'c', 'CHECK (freshness_eligible_evidence_count = 0 AND velocity_eligible_evidence_count = 0 AND max_observed_at IS NULL OR (freshness_eligible_evidence_count > 0 OR velocity_eligible_evidence_count > 0) AND max_observed_at IS NOT NULL)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.signal_cluster_scores'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '069 drift: signal_cluster_scores constraint set/definition does not match exactly';
    END IF;

    -- FK ON DELETE akciok (RESTRICT mindket iranyban)
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_cluster_scores_score_run_id_fkey', 'r'),
        ('signal_cluster_scores_signal_cluster_id_fkey', 'r')
      ) AS expected(conname, expected_deltype)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
        WHERE cl.relname = 'signal_cluster_scores' AND c.conname = expected.conname AND c.confdeltype = expected.expected_deltype
      )
    ) THEN
      RAISE EXCEPTION '069 drift: signal_cluster_scores FK ON DELETE action does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('idx_signal_cluster_scores_cluster', 'false', 'CREATE INDEX idx_signal_cluster_scores_cluster ON public.signal_cluster_scores USING btree (signal_cluster_id)'),
        ('scs_run_cluster_key', 'true', 'CREATE UNIQUE INDEX scs_run_cluster_key ON public.signal_cluster_scores USING btree (score_run_id, signal_cluster_id)'),
        ('signal_cluster_scores_pkey', 'true', 'CREATE UNIQUE INDEX signal_cluster_scores_pkey ON public.signal_cluster_scores USING btree (id)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.signal_cluster_scores'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '069 drift: signal_cluster_scores index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_cluster_scores'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '069 drift: signal_cluster_scores RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signal_cluster_scores') THEN
      RAISE EXCEPTION '069 drift: signal_cluster_scores has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_cluster_scores' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'signal_cluster_scores' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '069 drift: signal_cluster_scores service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'signal_cluster_scores' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '069 drift: signal_cluster_scores has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '069: signal_cluster_scores already exists and matches exactly — no-op.';
  END IF;
END;
$migrate_scs$;

NOTIFY pgrst, 'reload schema';

COMMIT;
