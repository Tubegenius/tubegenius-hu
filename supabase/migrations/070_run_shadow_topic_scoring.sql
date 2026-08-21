-- ============================================================
-- Migration 070: Shadow Topic v0 -- deterministic scoring RPC (S2)
--
-- PFM Shadow Topic v0 S2. Egyetlen atomi SECURITY DEFINER RPC:
--   public.run_shadow_topic_scoring(timestamptz, timestamptz, text) RETURNS jsonb
--
-- Kanonikus szerzodes forrasa: docs/architecture/shadow-topic-v0-contract.md
-- (a "Final Design Consistency Correction Gate" korrekcioival egyutt).
--
-- Fail-fast szerzodes (a 059-066 minta): A) nem letezik -> CREATE;
-- B) letezik -> byte-pontos VALIDACIO (to_regprocedure + md5(prosrc) body-
-- hash + ACL), no-op vagy EXCEPTION. A B) agban SOHA nem fut DDL/DCL.
--
-- HATOKOR: pontosan EGY function. Nincs uj tabla, nincs trigger, nincs
-- ALTER meglevo signal_* tablan, nincs cron/route/UI, nincs providerhivas.
-- A hivo KIZAROLAG (p_evaluation_time, p_input_cutoff, p_idempotency_key)-t
-- adhatja at -- score_profile/layer/algorithm_version/config/kuszobok/
-- cadence-ek/median policy/minimum_age_hours/rounding/ranking_eligible mind
-- server-oldali, function-testbe hardcode-olt konstansok.
--
-- ADVISORY LOCK -- teljes tranzakcio-hatokoru (pg_advisory_xact_lock),
-- SZANDEKOSAN: a shadow_topic_v0/1 lock-kulcs alatt futo hivasok TELJES
-- EGESZUKBEN sorosodnak (nem csak a config-ellenorzes/insert resz) --
-- v0-ban tudatosan elfogadott dontes, mert nincs cron/route ebben a
-- fazisban es a jelenlegi adatmennyiseg triviälis.
--
-- CLUSTER-UNIVERZUM: signal_clusters WHERE created_at <= p_input_cutoff
-- (minden status score-olodik diagnosztikai celbol). EVIDENCE-UNIVERZUM:
-- signal_cluster_evidence.relation_type='supports' AND created_at<=cutoff,
-- JOIN signal_evidence WHERE first_seen_at<=cutoff. OBSERVATION-UNIVERZUM:
-- metric_type='youtube_view_count', cadence IN ('daily','early8h','weekly'),
-- observed_at<=cutoff -- EVENT-TIME cutoff, nem DB-ingestion-time: egy
-- kesobb beerkezett, de observed_at szerint jogosult sor bekerulhet, ez
-- szandekos es dokumentalt (a snapshot a futaskor tenylegesen latott
-- bemenetet fagyasztja be, nem egy "adatbazis-allapot X idopontban"
-- illuziot).
--
-- youtube_evidence_count = evidence_type='youtube_video' szamlalasa,
-- published_at-tol FUGGETLENUL (a hianyzo/jovobeli published_at a
-- nevezoben marad, csokkentve a coverage-et, nem tunik el belole).
-- freshness/velocity eligible-szamlalo ebbol tovabb szukitve.
--
-- ELIGIBILITY REASON (v0-ban tenylegesen elerheto, precedencia sorrendben):
--   1. not_youtube_evidence
--   2. missing_published_at
--   3. published_after_evaluation_time
--   4. no_scheduled_view_observation
--   5. (egyik sem) -> eligible=true, reason=null
-- A linked_after_input_cutoff/first_seen_after_input_cutoff ERTEKEK NEM
-- ELERHETOEK v0-ban, mert az erintett sorok mar a bazis-lekerdezesben
-- kiszurodnek -- nincs szelesebb "audit-univerzum" a szamitasi
-- univerzumon tul (Model A, ld. kontraktus).
-- Freshness es velocity AZONOS feltetelt hasznal v0-ban -- egy evidence-re
-- mindket komponens eligible/reason erteke MINDIG azonos.
--
-- SZAMITAS: kizarolag PostgreSQL NUMERIC. Verifikalt teny (nem
-- feltetelezes): extract(epoch from (timestamptz-timestamptz)) NUMERIC-et
-- ad vissza ezen a Postgres 17-en, nem double precision-t. Median: egzakt
-- NUMERIC rangsor+felteteles-atlag (nincs percentile_cont, ami double
-- precision interpolaciot hasznalna).
--
-- KANONIKUS JSON: kezzel epitett TEXT-sablon fix, lexikografikus
-- kulcssorrendben -- SOHA nem jsonb_build_object(...)::text (bizonyitottan
-- NEM lexikografikus sorrendu a Postgres jsonb belso tarolasa miatt).
-- Minden scalar erteket pg_catalog.to_json(...)::text kodol (idezojel/
-- backslash/unicode-biztos escaping -- signal_clusters.category szabad
-- TEXT, nincs CHECK ra, tehat nem feltetelezheto elore biztonsagos).
-- input_digest = ugyanabbol a kanonikus szovegbol szamolt SHA-256, mint
-- amit a input_snapshot oszlopba ::jsonb-kent tarolunk -- nem ket kulon
-- SQL-agon epul.
--
-- OBSERVATION TIE-BREAK ES SNAPSHOT-SORREND EGYSEGESITVE:
-- evidence_id ASC, observed_at DESC, bucket_start DESC, id ASC -- ez
-- egyszerre a kivalasztasi (selected_for_calculation) es a snapshot-tombon
-- beluli rendezesi szabaly, igy minden evidence-csoport ELSO sora mindig
-- a kivalasztott sor.
--
-- HIBAMODELL: egyetlen tranzakcio. Barmilyen hiba -> SQL exception,
-- TELJES rollback, NINCS commitolt processing/failed sor, NINCS reszleges
-- score-halmaz. A signal_score_runs.status sematikusan megengedi a
-- 'failed'-et, de ez a v0 RPC SOHA nem ir/commitol ilyen sort.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_name_count int;
  v_exact_oid oid;
  v_body_hash text;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'run_shadow_topic_scoring';
  v_exact_oid := to_regprocedure('public.run_shadow_topic_scoring(timestamptz, timestamptz, text)');

  IF v_name_count = 0 THEN
    -- ============================================================
    -- A) CREATE BRANCH
    -- ============================================================
    RAISE NOTICE '070: run_shadow_topic_scoring does not exist -- CREATE branch.';

    CREATE FUNCTION public.run_shadow_topic_scoring(
      p_evaluation_time TIMESTAMPTZ,
      p_input_cutoff TIMESTAMPTZ,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_score_profile CONSTANT TEXT := 'shadow_topic_v0';
  v_layer CONSTANT TEXT := 'cluster_topic';
  v_algorithm_version CONSTANT INTEGER := 1;
  v_config_schema_version CONSTANT INTEGER := 1;
  v_config_canonical_text CONSTANT TEXT :=
    '{"confidence_thresholds":{"measured_min":3,"proxy_min":1},"config_schema_version":1,"eligible_cadences":["daily","early8h","weekly"],"eligible_metric_type":"youtube_view_count","median_policy":"standard_statistical_median","minimum_age_hours":"1.000000","raw_value_precision":{"median_average_view_velocity_per_hour":{"precision":20,"scale":6},"median_discovery_lag_hours":{"precision":12,"scale":4},"median_observation_age_hours":{"precision":12,"scale":4}},"rounding_policy":"round_half_away_from_zero_at_storage_only","timestamp_precision":"microsecond_6_digit"}';
  v_config_hash TEXT;
  v_lock_key CONSTANT BIGINT := pg_catalog.hashtextextended('shadow_topic_v0:1', 0);
  v_run_id UUID;
  v_existing RECORD;
  v_score_count INTEGER := 0;
BEGIN
  -- ============================================================
  -- 1. INPUT VALIDATION -- kontrollalt exception, nem tamaszkodunk
  --    kesobbi constraint-hibara.
  -- ============================================================
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

  -- ============================================================
  -- 2. ADVISORY LOCK -- teljes tranzakcio-hatokoru, szandekosan.
  -- ============================================================
  PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_key);

  -- ============================================================
  -- 3. CONFIG-HASH INVARIANS -- ugyanazon (profile, version) alatt
  --    mas config-hash nem engedhetett.
  -- ============================================================
  IF EXISTS (
    SELECT 1 FROM public.signal_score_runs
    WHERE score_profile = v_score_profile AND algorithm_version = v_algorithm_version
      AND algorithm_config_hash IS DISTINCT FROM v_config_hash
  ) THEN
    RAISE EXCEPTION 'run_shadow_topic_scoring: an existing run for % v% uses a different algorithm_config_hash', v_score_profile, v_algorithm_version USING ERRCODE = 'P0001';
  END IF;

  -- ============================================================
  -- 4. IDEMPOTENCY-KEY SZEMANTIKAI ELLENORZES
  -- ============================================================
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

  -- Azonos semantic tuple, mas idempotency_key -- kontrollalt hiba a
  -- ssr_semantic_dup_key UNIQUE nyers megsertese elott.
  IF EXISTS (
    SELECT 1 FROM public.signal_score_runs
    WHERE score_profile = v_score_profile AND algorithm_version = v_algorithm_version
      AND algorithm_config_hash = v_config_hash
      AND evaluation_time = p_evaluation_time AND input_cutoff = p_input_cutoff
  ) THEN
    RAISE EXCEPTION 'run_shadow_topic_scoring: a run already exists for this exact (profile, version, config, evaluation_time, input_cutoff) under a different idempotency_key' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================================
  -- 5. PROCESSING RUN LETREHOZASA
  -- ============================================================
  INSERT INTO public.signal_score_runs (
    score_profile, layer, algorithm_version, algorithm_config_hash, algorithm_config_snapshot,
    algorithm_config_schema_version, evaluation_time, input_cutoff, status, idempotency_key
  ) VALUES (
    v_score_profile, v_layer, v_algorithm_version, v_config_hash, v_config_canonical_text::jsonb,
    v_config_schema_version, p_evaluation_time, p_input_cutoff, 'processing', p_idempotency_key
  ) RETURNING id INTO v_run_id;

  -- ============================================================
  -- 6. CLUSTER-, EVIDENCE-, OBSERVATION-UNIVERZUM + SZAMITAS + INSERT
  --    -- egyetlen, halmaz-alapu INSERT...SELECT, minden clusterre
  --    egyszerre (nincs explicit ciklus).
  -- ============================================================
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
          '{"bucket_start":%s,"cadence":%s,"evidence_id":%s,"metric_type":"youtube_view_count","observation_id":%s,"observed_at":%s,"selected_for_calculation":%s}',
          to_json(to_char(oe.bucket_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
          to_json(oe.cadence)::text,
          to_json(oe.evidence_id::text)::text,
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
        '{"cluster_category_snapshot":%s,"cluster_id":%s,"cluster_status_snapshot":%s,"evaluation_time":%s,"evidence":[%s],"input_cutoff":%s,"observations":[%s],"schema_version":1}',
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
      1,
      ca.max_observed_at, 'scheduled_only'
    FROM cluster_aggregates ca
    JOIN snapshot_text st ON st.cluster_id = ca.cluster_id
    LEFT JOIN median_lag ml ON ml.cluster_id = ca.cluster_id
    LEFT JOIN median_age ma ON ma.cluster_id = ca.cluster_id
    LEFT JOIN median_vel mv ON mv.cluster_id = ca.cluster_id
    RETURNING 1
  )
  SELECT count(*) INTO v_score_count FROM scored;

  -- ============================================================
  -- 7. RUN LEZARASA -- completed
  -- ============================================================
  UPDATE public.signal_score_runs SET status = 'completed', completed_at = now() WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'ok', true, 'outcome', 'completed', 'run_id', v_run_id, 'status', 'completed',
    'cluster_count', v_score_count, 'score_count', v_score_count
  );
END;

$body$;

    REVOKE ALL ON FUNCTION public.run_shadow_topic_scoring(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.run_shadow_topic_scoring(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO service_role;

    RAISE NOTICE '070: run_shadow_topic_scoring created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    -- ============================================================
    -- B) VALIDATE/NO-OP BRANCH -- SOHA nem fut DDL/DCL.
    -- ============================================================
    RAISE NOTICE '070: run_shadow_topic_scoring already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_body_hash
    FROM pg_proc p WHERE p.oid = v_exact_oid;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = 'p_evaluation_time timestamp with time zone, p_input_cutoff timestamp with time zone, p_idempotency_key text'
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND v_body_hash = '017e7f031ea921c0f7d10b0c380fed9e'
    ) THEN
      RAISE EXCEPTION '070 drift: run_shadow_topic_scoring definition does not match exactly (body_hash=%)', v_body_hash;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'run_shadow_topic_scoring' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '070 drift: run_shadow_topic_scoring missing service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'run_shadow_topic_scoring' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '070 drift: run_shadow_topic_scoring has an unexpected EXECUTE grantee';
    END IF;

    RAISE NOTICE '070: run_shadow_topic_scoring already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '070 drift: run_shadow_topic_scoring exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
