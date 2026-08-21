-- ============================================================
-- Migration 071: Shadow Topic v0 -- snapshot provenance correction (v2)
--
-- DEFECT IN 070 (v1): the observation elements written into
-- signal_cluster_scores.input_snapshot omit metric_value entirely (the
-- observation_json format string in 070 only encodes bucket_start,
-- cadence, evidence_id, metric_type, observation_id, observed_at,
-- selected_for_calculation). Consequently input_digest -- computed from
-- that same canonical text -- does not depend on metric_value either.
-- This violates docs/architecture/shadow-topic-v0-contract.md section 6,
-- which requires metric_value as part of the observation element so the
-- stored input_snapshot alone is sufficient to recompute the score, even
-- after the source signal_observations row is later modified. The v1
-- stored snapshot is provably NOT self-contained: any reconstruction that
-- claims to "verify" a v1 score against the live source tables is really
-- just re-reading the still-unchanged current metric_value from
-- signal_observations, not proving long-term reproducibility from the
-- snapshot itself.
--
-- THE EXISTING v1 PRODUCTION RUN (id=6853aa21-dbdf-4ec0-a6d9-6ba7f83d39c6)
-- IS NOT TOUCHED. It cannot be deleted, updated, or marked failed --
-- signal_score_runs/signal_cluster_scores are append-only and this
-- migration performs no DML whatsoever on either table. It remains
-- score_profile=shadow_topic_v0, algorithm_version=1, status=completed,
-- ranking_eligible=false, and is documented (see the contract doc) as
-- provenance-incomplete and excluded from any future calibration/quality
-- audit -- an audit trail, not a defect to be erased.
--
-- WHY algorithm_version BUMPS TO 2 (not a v1 patch): the score formula's
-- mathematics are unchanged, but the reproducibility contract and the
-- canonical input format materially change (metric_value now included in
-- both the snapshot and the digest). algorithm_version=2 draws a clean,
-- auditable line between the provenance-incomplete v1 and the fully
-- self-contained v2 -- v1 rows are never silently reinterpreted as v2.
-- input_snapshot_schema_version bumps to 2 for the same reason, and is
-- also carried explicitly inside algorithm_config_snapshot so a v2 row's
-- own config makes its snapshot format unambiguous without relying on
-- out-of-band knowledge. algorithm_config_schema_version also bumps to 2
-- because the config JSON's own structure gained a field
-- (input_snapshot_schema_version) -- this is a config-schema change, not
-- just a config-value change.
--
-- WHY NO DATA REPAIR: the missing metric_value in the v1 snapshot cannot
-- be safely backfilled -- the only way to recover a byte-exact canonical
-- v1-shaped payload with metric_value added would require re-deriving it
-- from current signal_observations, which reintroduces exactly the
-- non-self-contained-ness this migration exists to fix. Forward-only: v1
-- stays as a permanent, clearly-labeled provenance-incomplete record; all
-- future runs use v2.
--
-- SCOPE: replaces ONLY the public.run_shadow_topic_scoring(timestamptz,
-- timestamptz, text) function body. No new table, no ALTER on any
-- existing signal_* table, no score-table DML, no cron/route/UI change.
-- Owner (postgres), SET search_path = public, pg_temp, SECURITY DEFINER,
-- and the EXECUTE ACL (postgres + service_role only) are unchanged by
-- CREATE OR REPLACE and are re-verified, not re-granted.
--
-- FAIL-CLOSED CONTRACT (applies to the function *body only*; owner/
-- search_path/SECURITY DEFINER/ACL are checked in both branches before
-- and after, since CREATE OR REPLACE FUNCTION cannot change the argument
-- list or drop the object -- but an ACL/owner mismatch introduced by any
-- other process must still stop this migration cold):
--   A) the live body_hash is EXACTLY the known 070 legacy v1 hash
--      (017e7f031ea921c0f7d10b0c380fed9e) -> CREATE OR REPLACE with the
--      corrected v2 body, then re-validate byte-exact.
--   B) the live body_hash is EXACTLY the already-corrected v2 hash ->
--      no-op (idempotent replay of this same migration).
--   C) anything else (unknown/tampered/future body, missing function,
--      wrong overload count, drifted owner/ACL/search_path) -> RAISE
--      EXCEPTION, full ROLLBACK. No DDL/DCL runs in this branch.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_exact_oid oid;
  v_body_hash text;
  v_legacy_v1_hash CONSTANT text := '017e7f031ea921c0f7d10b0c380fed9e';
  v_corrected_v2_hash CONSTANT text := '75e1ff9653b362191e62b213ea06237a';
BEGIN
  v_exact_oid := to_regprocedure('public.run_shadow_topic_scoring(timestamptz, timestamptz, text)');

  IF v_exact_oid IS NULL THEN
    RAISE EXCEPTION '071 drift: public.run_shadow_topic_scoring(timestamptz, timestamptz, text) does not exist -- 070 must be applied first';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'run_shadow_topic_scoring') <> 1 THEN
    RAISE EXCEPTION '071 drift: run_shadow_topic_scoring has an unexpected overload count before replace';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_exact_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
  ) THEN
    RAISE EXCEPTION '071 drift: run_shadow_topic_scoring owner/SECURITY DEFINER/search_path does not match the expected baseline before replace';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'run_shadow_topic_scoring' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '071 drift: run_shadow_topic_scoring is missing the service_role EXECUTE grant before replace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'run_shadow_topic_scoring' AND grantee NOT IN ('service_role', 'postgres')
  ) THEN
    RAISE EXCEPTION '071 drift: run_shadow_topic_scoring has an unexpected EXECUTE grantee before replace';
  END IF;

  SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_body_hash FROM pg_proc p WHERE p.oid = v_exact_oid;

  IF v_body_hash = v_corrected_v2_hash THEN
    -- ============================================================
    -- B) ALREADY-CORRECTED NO-OP BRANCH -- NEVER runs DDL/DCL.
    -- ============================================================
    RAISE NOTICE '071: run_shadow_topic_scoring already exactly the corrected v2 body -- no-op.';
  ELSIF v_body_hash = v_legacy_v1_hash THEN
    -- ============================================================
    -- A) REPLACE BRANCH -- known 070 legacy v1 body -> corrected v2 body.
    -- ============================================================
    RAISE NOTICE '071: run_shadow_topic_scoring is the known legacy v1 body -- REPLACE branch (snapshot provenance correction).';

    CREATE OR REPLACE FUNCTION public.run_shadow_topic_scoring(
      p_evaluation_time TIMESTAMPTZ,
      p_input_cutoff TIMESTAMPTZ,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_score_profile CONSTANT TEXT := 'shadow_topic_v0';
  v_layer CONSTANT TEXT := 'cluster_topic';
  v_algorithm_version CONSTANT INTEGER := 2;
  v_config_schema_version CONSTANT INTEGER := 2;
  v_config_canonical_text CONSTANT TEXT :=
    '{"confidence_thresholds":{"measured_min":3,"proxy_min":1},"config_schema_version":2,"eligible_cadences":["daily","early8h","weekly"],"eligible_metric_type":"youtube_view_count","input_snapshot_schema_version":2,"median_policy":"standard_statistical_median","minimum_age_hours":"1.000000","raw_value_precision":{"median_average_view_velocity_per_hour":{"precision":20,"scale":6},"median_discovery_lag_hours":{"precision":12,"scale":4},"median_observation_age_hours":{"precision":12,"scale":4}},"rounding_policy":"round_half_away_from_zero_at_storage_only","timestamp_precision":"microsecond_6_digit"}';
  v_config_hash TEXT;
  v_lock_key CONSTANT BIGINT := pg_catalog.hashtextextended('shadow_topic_v0:2', 0);
  v_run_id UUID;
  v_existing RECORD;
  v_score_count INTEGER := 0;
BEGIN
  IF p_evaluation_time IS NULL THEN
    RAISE EXCEPTION 'run_shadow_topic_scoring: evaluation_time is required' USING ERRCODE = 'P0001';
  END IF;
  IF p_input_cutoff IS NULL THEN
    RAISE EXCEPTION 'run_shadow_topic_scoring: input_cutoff is required' USING ERRCODE = 'P0001';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'run_shadow_topic_scoring: idempotency_key must not be blank' USING ERRCODE = 'P0001';
  END IF;
  IF p_input_cutoff > p_evaluation_time THEN
    RAISE EXCEPTION 'run_shadow_topic_scoring: input_cutoff must not be after evaluation_time' USING ERRCODE = 'P0001';
  END IF;

  v_config_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(v_config_canonical_text, 'UTF8')), 'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_key);

  IF EXISTS (
    SELECT 1 FROM public.signal_score_runs
    WHERE score_profile = v_score_profile AND algorithm_version = v_algorithm_version
      AND algorithm_config_hash IS DISTINCT FROM v_config_hash
  ) THEN
    RAISE EXCEPTION 'run_shadow_topic_scoring: an existing run for % v% uses a different algorithm_config_hash', v_score_profile, v_algorithm_version USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_existing FROM public.signal_score_runs WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.status <> 'completed' THEN
      RAISE EXCEPTION 'run_shadow_topic_scoring: existing run % for this idempotency_key is not completed (status=%)', v_existing.id, v_existing.status USING ERRCODE = 'P0001';
    END IF;
    IF v_existing.score_profile IS DISTINCT FROM v_score_profile
       OR v_existing.algorithm_version IS DISTINCT FROM v_algorithm_version
       OR v_existing.algorithm_config_hash IS DISTINCT FROM v_config_hash
       OR v_existing.evaluation_time IS DISTINCT FROM p_evaluation_time
       OR v_existing.input_cutoff IS DISTINCT FROM p_input_cutoff
    THEN
      RAISE EXCEPTION 'run_shadow_topic_scoring: idempotency_key already used with different semantic parameters (existing run %)', v_existing.id USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*) INTO v_score_count FROM public.signal_cluster_scores WHERE score_run_id = v_existing.id;
    RETURN jsonb_build_object(
      'ok', true, 'outcome', 'replayed', 'run_id', v_existing.id, 'status', v_existing.status,
      'cluster_count', v_score_count, 'score_count', v_score_count
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.signal_score_runs
    WHERE score_profile = v_score_profile AND algorithm_version = v_algorithm_version
      AND algorithm_config_hash = v_config_hash
      AND evaluation_time = p_evaluation_time AND input_cutoff = p_input_cutoff
  ) THEN
    RAISE EXCEPTION 'run_shadow_topic_scoring: a run already exists for this exact (profile, version, config, evaluation_time, input_cutoff) under a different idempotency_key' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.signal_score_runs (
    score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot,
    algorithm_config_schema_version, evaluation_time, input_cutoff, status, idempotency_key
  ) VALUES (
    v_score_profile, v_layer, v_algorithm_version, v_config_hash, v_config_canonical_text::jsonb,
    v_config_schema_version, p_evaluation_time, p_input_cutoff, 'processing', p_idempotency_key
  ) RETURNING id INTO v_run_id;

  WITH cluster_universe AS (
    SELECT id AS cluster_id, category, status
    FROM public.signal_clusters
    WHERE created_at <= p_input_cutoff
  ),
  evidence_base AS (
    SELECT
      cu.cluster_id, e.id AS evidence_id, e.evidence_type, e.signal_source_id,
      e.published_at, e.first_seen_at, ce.created_at AS cluster_link_created_at
    FROM cluster_universe cu
    JOIN public.signal_cluster_evidence ce
      ON ce.signal_cluster_id = cu.cluster_id AND ce.relation_type = 'supports' AND ce.created_at <= p_input_cutoff
    JOIN public.signal_evidence e
      ON e.id = ce.signal_evidence_id AND e.first_seen_at <= p_input_cutoff
  ),
  observation_eligible AS (
    SELECT
      o.signal_evidence_id AS evidence_id, o.id AS observation_id, o.cadence,
      o.bucket_start, o.observed_at, o.metric_value,
      ROW_NUMBER() OVER (PARTITION BY o.signal_evidence_id ORDER BY o.observed_at DESC, o.bucket_start DESC, o.id ASC) AS rn
    FROM public.signal_observations o
    JOIN evidence_base eb ON eb.evidence_id = o.signal_evidence_id AND eb.evidence_type = 'youtube_video'
    WHERE o.metric_type = 'youtube_view_count'
      AND o.cadence IN ('daily', 'early8h', 'weekly')
      AND o.observed_at <= p_input_cutoff
  ),
  evidence_eligibility AS (
    SELECT
      eb.cluster_id, eb.evidence_id, eb.evidence_type, eb.signal_source_id,
      eb.published_at, eb.first_seen_at, eb.cluster_link_created_at,
      CASE
        WHEN eb.evidence_type <> 'youtube_video' THEN 'not_youtube_evidence'
        WHEN eb.published_at IS NULL THEN 'missing_published_at'
        WHEN eb.published_at > p_evaluation_time THEN 'published_after_evaluation_time'
        WHEN NOT EXISTS (SELECT 1 FROM observation_eligible oe WHERE oe.evidence_id = eb.evidence_id) THEN 'no_scheduled_view_observation'
        ELSE NULL
      END AS reason,
      (eb.evidence_type = 'youtube_video' AND eb.published_at IS NOT NULL AND eb.published_at <= p_evaluation_time
        AND EXISTS (SELECT 1 FROM observation_eligible oe WHERE oe.evidence_id = eb.evidence_id)) AS is_eligible
    FROM evidence_base eb
  ),
  evidence_metrics AS (
    SELECT
      ee.cluster_id, ee.evidence_id,
      GREATEST(0::numeric, EXTRACT(EPOCH FROM (ee.first_seen_at - ee.published_at))::numeric / 3600) AS discovery_lag_hours,
      GREATEST(0::numeric, EXTRACT(EPOCH FROM (p_evaluation_time - oe.observed_at))::numeric / 3600) AS observation_age_hours,
      oe.metric_value::numeric / GREATEST(EXTRACT(EPOCH FROM (oe.observed_at - ee.published_at))::numeric / 3600, 1.000000::numeric) AS average_view_velocity_per_hour,
      oe.observed_at
    FROM evidence_eligibility ee
    JOIN observation_eligible oe ON oe.evidence_id = ee.evidence_id AND oe.rn = 1
    WHERE ee.is_eligible
  ),
  ranked_lag AS (
    SELECT cluster_id, discovery_lag_hours AS v,
      ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY discovery_lag_hours, evidence_id) AS rn,
      COUNT(*) OVER (PARTITION BY cluster_id) AS n
    FROM evidence_metrics
  ),
  ranked_age AS (
    SELECT cluster_id, observation_age_hours AS v,
      ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY observation_age_hours, evidence_id) AS rn,
      COUNT(*) OVER (PARTITION BY cluster_id) AS n
    FROM evidence_metrics
  ),
  ranked_vel AS (
    SELECT cluster_id, average_view_velocity_per_hour AS v,
      ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY average_view_velocity_per_hour, evidence_id) AS rn,
      COUNT(*) OVER (PARTITION BY cluster_id) AS n
    FROM evidence_metrics
  ),
  median_lag AS (
    SELECT r.cluster_id,
      CASE WHEN r.n % 2 = 1 THEN (SELECT v FROM ranked_lag r2 WHERE r2.cluster_id = r.cluster_id AND r2.rn = (r.n + 1) / 2)
           ELSE (SELECT AVG(v) FROM ranked_lag r2 WHERE r2.cluster_id = r.cluster_id AND r2.rn IN (r.n / 2, r.n / 2 + 1))
      END AS median_value
    FROM (SELECT DISTINCT cluster_id, n FROM ranked_lag) r
  ),
  median_age AS (
    SELECT r.cluster_id,
      CASE WHEN r.n % 2 = 1 THEN (SELECT v FROM ranked_age r2 WHERE r2.cluster_id = r.cluster_id AND r2.rn = (r.n + 1) / 2)
           ELSE (SELECT AVG(v) FROM ranked_age r2 WHERE r2.cluster_id = r.cluster_id AND r2.rn IN (r.n / 2, r.n / 2 + 1))
      END AS median_value
    FROM (SELECT DISTINCT cluster_id, n FROM ranked_age) r
  ),
  median_vel AS (
    SELECT r.cluster_id,
      CASE WHEN r.n % 2 = 1 THEN (SELECT v FROM ranked_vel r2 WHERE r2.cluster_id = r.cluster_id AND r2.rn = (r.n + 1) / 2)
           ELSE (SELECT AVG(v) FROM ranked_vel r2 WHERE r2.cluster_id = r.cluster_id AND r2.rn IN (r.n / 2, r.n / 2 + 1))
      END AS median_value
    FROM (SELECT DISTINCT cluster_id, n FROM ranked_vel) r
  ),
  evidence_json AS (
    SELECT
      eb.cluster_id,
      string_agg(
        format(
          '{"cluster_link_created_at":%s,"eligibility":{"freshness":{"eligible":%s,"reason":%s},"velocity":{"eligible":%s,"reason":%s}},"evidence_id":%s,"evidence_type":%s,"first_seen_at":%s,"published_at":%s,"source_id":%s}',
          to_json(to_char(eb.cluster_link_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
          to_json(ee.is_eligible)::text,
          CASE WHEN ee.reason IS NULL THEN 'null' ELSE to_json(ee.reason)::text END,
          to_json(ee.is_eligible)::text,
          CASE WHEN ee.reason IS NULL THEN 'null' ELSE to_json(ee.reason)::text END,
          to_json(eb.evidence_id::text)::text,
          to_json(eb.evidence_type)::text,
          to_json(to_char(eb.first_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
          CASE WHEN eb.published_at IS NULL THEN 'null' ELSE to_json(to_char(eb.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text END,
          to_json(eb.signal_source_id::text)::text
        ), ',' ORDER BY eb.evidence_id::text
      ) AS agg
    FROM evidence_base eb
    JOIN evidence_eligibility ee ON ee.evidence_id = eb.evidence_id
    GROUP BY eb.cluster_id
  ),
  observation_json AS (
    SELECT
      eb.cluster_id,
      string_agg(
        format(
          '{"bucket_start":%s,"cadence":%s,"evidence_id":%s,"metric_type":"youtube_view_count","metric_value":%s,"observation_id":%s,"observed_at":%s,"selected_for_calculation":%s}',
          to_json(to_char(oe.bucket_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
          to_json(oe.cadence)::text,
          to_json(oe.evidence_id::text)::text,
          to_json(pg_catalog.trim_scale(round(oe.metric_value, 0))::text)::text,
          to_json(oe.observation_id::text)::text,
          to_json(to_char(oe.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
          to_json(oe.rn = 1)::text
        ), ',' ORDER BY oe.evidence_id::text ASC, oe.observed_at DESC, oe.bucket_start DESC, oe.observation_id::text ASC
      ) AS agg
    FROM observation_eligible oe
    JOIN evidence_base eb ON eb.evidence_id = oe.evidence_id
    GROUP BY eb.cluster_id
  ),
  cluster_aggregates AS (
    SELECT
      cu.cluster_id, cu.category, cu.status,
      COUNT(eb.evidence_id) AS evidence_count,
      COUNT(DISTINCT eb.signal_source_id) AS source_breadth,
      COUNT(*) FILTER (WHERE ee.evidence_type = 'youtube_video') AS youtube_evidence_count,
      COUNT(*) FILTER (WHERE ee.is_eligible) AS eligible_count,
      MAX(em.observed_at) AS max_observed_at
    FROM cluster_universe cu
    LEFT JOIN evidence_base eb ON eb.cluster_id = cu.cluster_id
    LEFT JOIN evidence_eligibility ee ON ee.evidence_id = eb.evidence_id
    LEFT JOIN evidence_metrics em ON em.evidence_id = eb.evidence_id
    GROUP BY cu.cluster_id, cu.category, cu.status
  ),
  snapshot_text AS (
    SELECT
      ca.cluster_id,
      format(
        '{"cluster_category_snapshot":%s,"cluster_id":%s,"cluster_status_snapshot":%s,"evaluation_time":%s,"evidence":[%s],"input_cutoff":%s,"observations":[%s],"schema_version":2}',
        CASE WHEN ca.category IS NULL THEN 'null' ELSE to_json(ca.category)::text END,
        to_json(ca.cluster_id::text)::text,
        to_json(ca.status)::text,
        to_json(to_char(p_evaluation_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
        coalesce(ej.agg, ''),
        to_json(to_char(p_input_cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
        coalesce(oj.agg, '')
      ) AS canonical_text
    FROM cluster_aggregates ca
    LEFT JOIN evidence_json ej ON ej.cluster_id = ca.cluster_id
    LEFT JOIN observation_json oj ON oj.cluster_id = ca.cluster_id
  ),
  scored AS (
    INSERT INTO public.signal_cluster_scores (
      score_run_id, signal_cluster_id, evidence_count, source_breadth, youtube_evidence_count,
      median_discovery_lag_hours, median_observation_age_hours, median_average_view_velocity_per_hour,
      freshness_eligible_evidence_count, velocity_eligible_evidence_count,
      freshness_confidence_class, velocity_confidence_class,
      freshness_exclusion_reason, velocity_exclusion_reason,
      input_snapshot, input_digest, input_snapshot_schema_version,
      max_observed_at, sampling_policy
    )
    SELECT
      v_run_id, ca.cluster_id, ca.evidence_count, ca.source_breadth, ca.youtube_evidence_count,
      ml.median_value, ma.median_value, mv.median_value,
      ca.eligible_count, ca.eligible_count,
      CASE WHEN ca.eligible_count = 0 THEN 'unknown' WHEN ca.eligible_count <= 2 THEN 'proxy' ELSE 'measured' END,
      CASE WHEN ca.eligible_count = 0 THEN 'unknown' WHEN ca.eligible_count <= 2 THEN 'proxy' ELSE 'measured' END,
      CASE WHEN ca.eligible_count = 0 THEN 'no_eligible_evidence' ELSE NULL END,
      CASE WHEN ca.eligible_count = 0 THEN 'no_eligible_evidence' ELSE NULL END,
      st.canonical_text::jsonb,
      encode(pg_catalog.sha256(pg_catalog.convert_to(st.canonical_text, 'UTF8')), 'hex'),
      2,
      ca.max_observed_at, 'scheduled_only'
    FROM cluster_aggregates ca
    JOIN snapshot_text st ON st.cluster_id = ca.cluster_id
    LEFT JOIN median_lag ml ON ml.cluster_id = ca.cluster_id
    LEFT JOIN median_age ma ON ma.cluster_id = ca.cluster_id
    LEFT JOIN median_vel mv ON mv.cluster_id = ca.cluster_id
    RETURNING 1
  )
  SELECT count(*) INTO v_score_count FROM scored;

  UPDATE public.signal_score_runs SET status = 'completed', completed_at = now() WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'ok', true, 'outcome', 'completed', 'run_id', v_run_id, 'status', 'completed',
    'cluster_count', v_score_count, 'score_count', v_score_count
  );
END;

$body$;

    SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_body_hash FROM pg_proc p WHERE p.oid = v_exact_oid;
    IF v_body_hash <> v_corrected_v2_hash THEN
      RAISE EXCEPTION '071 drift: post-replace body_hash (%) does not match the expected corrected v2 hash', v_body_hash;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '071 drift: post-replace owner/SECURITY DEFINER/search_path changed unexpectedly';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'run_shadow_topic_scoring' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '071 drift: post-replace missing the service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'run_shadow_topic_scoring' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '071 drift: post-replace unexpected EXECUTE grantee';
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'run_shadow_topic_scoring') <> 1 THEN
      RAISE EXCEPTION '071 drift: unexpected overload count after replace';
    END IF;

    RAISE NOTICE '071: run_shadow_topic_scoring replaced with the corrected v2 body (metric_value now in the snapshot and digest).';
  ELSE
    -- ============================================================
    -- C) FAIL-CLOSED BRANCH -- unrecognized body. NEVER runs DDL/DCL.
    -- ============================================================
    RAISE EXCEPTION '071 drift: run_shadow_topic_scoring body_hash (%) is neither the known legacy v1 hash nor the corrected v2 hash -- refusing to touch an unrecognized definition', v_body_hash;
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
