-- ============================================================
-- Migration 088: PFM Lifecycle Reviewer Read Surface v1
--
-- Kanonikus elozmeny: a Lifecycle Reviewer Read Surface v1 tervezo-lezaro
-- gate (087-hez kepest kulon, uj migracio, mivel 087 mar productionben
-- van -- a 087 fajl ebben a migracioban NEM valtozik). Ket uj, kizarolag
-- OLVASO RPC-t vezet be az authenticated reviewer szamara:
--   list_semantic_topic_lifecycle_review_requests -- kicsi, lapozhato lista
--   get_semantic_topic_lifecycle_review_request -- teljes, redaktalt detail
-- plusz egy uj, szuk, privat helper a snapshot-digest ujraszamitasahoz
-- (_semantic_topic_lifecycle_snapshot_digest), amely BIT-PONTOSAN a 087
-- executor sajat, inline kepletet ismetli meg -- soha nem masodik,
-- eltero digest-definiciot vezet be. Mindharom uj objektum STABLE
-- (zero DML), SECURITY DEFINER, csak authenticated grant, auth.uid() +
-- aktiv semantic_topic_reviewers tagsag kotelezo, soha nyers Postgres-
-- hiba a kliens fele.
--
-- Redakcio: a detail response SOHA nem ad vissza reviewer/canceller
-- nyers user UUID-t (helyette decidedByCurrentReviewer/
-- cancelledByCurrentReviewer BOOLEAN, auth.uid() alapjan szerveroldalon
-- szamitva), transition_event_id-t, sem barmilyen nyers forras-
-- identitast (signal_source_id, external_ref, canonical_url) -- ezekhez
-- a detail SOHA nem is joinol signal_evidence/signal_sources tablaba,
-- kizarolag a mar aggregalt compute_topic_evidence_vector() kimenetet
-- (szamlalok/booleanek, nem nyers azonossag) adja tovabb.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. FUGGOSEGI ELOFELTETEL -- 087 teljes, valtozatlan alkalmazasa
-- ============================================================

DO $preflight_088$
DECLARE
  v_table_count int;
  v_hash text;
BEGIN
  SELECT count(*) INTO v_table_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (
      'semantic_topic_lifecycle_review_requests',
      'semantic_topic_lifecycle_review_events',
      'semantic_topic_lifecycle_transition_events'
    );
  IF v_table_count <> 3 THEN
    RAISE EXCEPTION '088 fail-closed: % of 3 required 087 tables present -- 087 must be fully applied first.', v_table_count;
  END IF;

  -- 087's own 5 objects must be exactly the production-committed bodies --
  -- 088 never redefines or depends on a drifted 087.
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public._semantic_topic_lifecycle_mechanical_check(jsonb)'::regprocedure;
  IF v_hash IS DISTINCT FROM 'd75add661114d913cd6e783481202128' THEN
    RAISE EXCEPTION '088 fail-closed: _semantic_topic_lifecycle_mechanical_check is not the expected 087-committed body (got %). Aborting.', v_hash;
  END IF;
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.create_semantic_topic_lifecycle_review_request(uuid, text, text)'::regprocedure;
  IF v_hash IS DISTINCT FROM '162b4b91d7d742722a4f580ababff34c' THEN
    RAISE EXCEPTION '088 fail-closed: create_semantic_topic_lifecycle_review_request is not the expected 087-committed body (got %). Aborting.', v_hash;
  END IF;
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.record_semantic_topic_lifecycle_review_decision(uuid, text, text, text, text, boolean, boolean, boolean, boolean, integer)'::regprocedure;
  IF v_hash IS DISTINCT FROM '84e841b23fe2d42725c53d09bbb1b2a7' THEN
    RAISE EXCEPTION '088 fail-closed: record_semantic_topic_lifecycle_review_decision is not the expected 087-committed body (got %). Aborting.', v_hash;
  END IF;
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.cancel_semantic_topic_lifecycle_review_request(uuid, text, text, text)'::regprocedure;
  IF v_hash IS DISTINCT FROM '3d89febb55199ecaaa6936d4e68bcecb' THEN
    RAISE EXCEPTION '088 fail-closed: cancel_semantic_topic_lifecycle_review_request is not the expected 087-committed body (got %). Aborting.', v_hash;
  END IF;
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.execute_approved_semantic_topic_lifecycle_transition(uuid, text)'::regprocedure;
  IF v_hash IS DISTINCT FROM '6c12de4cef728e046490645c0ce3b057' THEN
    RAISE EXCEPTION '088 fail-closed: execute_approved_semantic_topic_lifecycle_transition is not the expected 087-committed body (got %). Aborting.', v_hash;
  END IF;
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.compute_topic_evidence_vector(uuid)'::regprocedure;
  IF v_hash IS DISTINCT FROM '73aeb37846bcc80fd42a4e2c8862dc7c' THEN
    RAISE EXCEPTION '088 fail-closed: compute_topic_evidence_vector (086) is not the expected committed body (got %). Aborting.', v_hash;
  END IF;

  RAISE NOTICE '088: preflight gate passed (087 fully applied, all 6 upstream body hashes confirmed unchanged).';
END;
$preflight_088$;

-- ============================================================
-- 1. _semantic_topic_lifecycle_snapshot_digest -- UJ, plain (nem
--    SECURITY DEFINER) helper. Az EGYETLEN hely, ahol a snapshot-digest
--    keplet definialva van a 088-ban -- bit-pontosan megismetli 087
--    execute_approved_semantic_topic_lifecycle_transition sajat, inline
--    kepletet (lasd a v_fresh_snapshot_digest szamitasat 087-ben). 087-et
--    ez a migracio SOHA nem modositja; a bit-pontos egyezest a committed
--    tesztsuite kulon, valos fixture-on (087 sajat create RPC-je altal
--    tarolt evidence_vector_digest ellen) igazolja.
-- ============================================================

DO $migrate_snapshot_digest$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '761d4217d220499617c54da6754bf347';
  v_expected_args CONSTANT text := 'p_semantic_topic_id uuid, p_target_status text, p_review_policy_version integer, p_vector jsonb';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '_semantic_topic_lifecycle_snapshot_digest';

  IF v_name_count = 0 THEN
    RAISE NOTICE '088: _semantic_topic_lifecycle_snapshot_digest does not exist -- CREATE branch.';

    CREATE FUNCTION public._semantic_topic_lifecycle_snapshot_digest(
      p_semantic_topic_id UUID,
      p_target_status TEXT,
      p_review_policy_version INTEGER,
      p_vector JSONB
    ) RETURNS TEXT
    LANGUAGE sql STABLE
    SET search_path = public, pg_temp
    AS $fn$
      SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"semanticTopicId":%s,"targetStatus":%s,"policyVersion":%s,"snapshot":%s}',
          to_json('willviral.semantic-topic.lifecycle-review-request:v1:snapshot'::text)::text,
          to_json(p_semantic_topic_id::text)::text,
          to_json(p_target_status)::text,
          to_json(p_review_policy_version)::text,
          p_vector::text
        ), 'UTF8')), 'hex')
    $fn$;

    REVOKE ALL ON FUNCTION public._semantic_topic_lifecycle_snapshot_digest(UUID, TEXT, INTEGER, JSONB) FROM PUBLIC, anon, authenticated, service_role;

    RAISE NOTICE '088: _semantic_topic_lifecycle_snapshot_digest created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '088: _semantic_topic_lifecycle_snapshot_digest already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = '_semantic_topic_lifecycle_snapshot_digest';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args AND pg_get_function_result(p.oid) = 'text'
        AND l.lanname = 'sql' AND p.provolatile = 's' AND p.proisstrict IS FALSE AND p.prosecdef IS FALSE
        AND p.proparallel = 'u' AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '088 drift: _semantic_topic_lifecycle_snapshot_digest structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '088 drift: _semantic_topic_lifecycle_snapshot_digest body hash does not match exactly (got %)', v_hash;
    END IF;

    IF EXISTS (
      SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid)))) acl
      WHERE acl.privilege_type = 'EXECUTE' AND acl.grantee <> (SELECT proowner FROM pg_proc WHERE oid = v_oid)
    ) THEN
      RAISE EXCEPTION '088 drift: _semantic_topic_lifecycle_snapshot_digest has an unexpected EXECUTE grant (expected NONE besides the owner)';
    END IF;

    RAISE NOTICE '088: _semantic_topic_lifecycle_snapshot_digest already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '088 fail-closed: _semantic_topic_lifecycle_snapshot_digest has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_snapshot_digest$;

-- ============================================================
-- 2. list_semantic_topic_lifecycle_review_requests -- authenticated-only,
--    kicsi/lapozhato lista. Soha nem ad vissza snapshotot, rationale-t,
--    checklistet, execution/cancellation reszletet vagy event historyt.
-- ============================================================

DO $migrate_list_088$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'e146ee7500646b5fd240545a0419d5a5';
  v_expected_args CONSTANT text := 'p_status_filter text, p_limit integer, p_after_requested_at timestamp with time zone, p_after_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'list_semantic_topic_lifecycle_review_requests';

  IF v_name_count = 0 THEN
    RAISE NOTICE '088: list_semantic_topic_lifecycle_review_requests does not exist -- CREATE branch.';

    CREATE FUNCTION public.list_semantic_topic_lifecycle_review_requests(
      p_status_filter TEXT DEFAULT 'actionable',
      p_limit INTEGER DEFAULT 20,
      p_after_requested_at TIMESTAMPTZ DEFAULT NULL,
      p_after_id UUID DEFAULT NULL
    ) RETURNS JSONB
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_caller_user_id UUID;
      v_limit INTEGER;
      v_statuses TEXT[];
      v_result JSONB;
    BEGIN
      v_caller_user_id := auth.uid();
      IF v_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'list_semantic_topic_lifecycle_review_requests: authentication required';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.semantic_topic_reviewers WHERE user_id = v_caller_user_id AND active IS TRUE) THEN
        RAISE EXCEPTION 'list_semantic_topic_lifecycle_review_requests: caller is not an active reviewer';
      END IF;

      -- Zart, dokumentalt szuro-nevter: a 7 konkret status ertek pontosan
      -- onmagat jelenti (nincs kulon "named filter" vs "literal status"
      -- kettosseg), plusz ket megnevezett osszetett halmaz.
      v_statuses := CASE p_status_filter
        WHEN 'requested' THEN ARRAY['requested']
        WHEN 'approved' THEN ARRAY['approved']
        WHEN 'rejected' THEN ARRAY['rejected']
        WHEN 'expired' THEN ARRAY['expired']
        WHEN 'cancelled' THEN ARRAY['cancelled']
        WHEN 'executed' THEN ARRAY['executed']
        WHEN 'stale' THEN ARRAY['stale']
        WHEN 'actionable' THEN ARRAY['requested', 'approved']
        WHEN 'history' THEN ARRAY['rejected', 'expired', 'cancelled', 'executed', 'stale']
        ELSE NULL
      END;
      IF v_statuses IS NULL THEN
        RAISE EXCEPTION 'list_semantic_topic_lifecycle_review_requests: INVALID_STATUS_FILTER -- got %', p_status_filter;
      END IF;

      v_limit := LEAST(GREATEST(coalesce(p_limit, 20), 1), 50);

      -- Keyset pagination (requested_at, id) -- pontosan a 077/078-as
      -- list_pending_topic_assignment_review_requests mar bevalt
      -- mintaja: stabil, nem-csuszo rendezes, nincs OFFSET.
      SELECT coalesce(jsonb_agg(row_data ORDER BY row_data->>'requested_at', row_data->>'review_request_id'), '[]'::jsonb)
      INTO v_result
      FROM (
        SELECT jsonb_build_object(
          'review_request_id', r.id,
          'generation', r.generation,
          'semantic_topic_id', r.semantic_topic_id,
          'topic_canonical_label', t.canonical_label,
          'from_status', r.from_status,
          'target_status', r.target_status,
          'request_status', r.status,
          'requested_at', r.requested_at,
          'expires_at', r.expires_at,
          'decided_at', r.decided_at,
          'stale_reason_code', CASE WHEN r.status = 'stale' THEN r.stale_reason_code ELSE NULL END
        ) AS row_data
        FROM public.semantic_topic_lifecycle_review_requests r
        JOIN public.semantic_topics t ON t.id = r.semantic_topic_id
        WHERE r.status = ANY(v_statuses)
          AND (p_after_requested_at IS NULL OR r.requested_at > p_after_requested_at
               OR (r.requested_at = p_after_requested_at AND r.id > p_after_id))
        ORDER BY r.requested_at ASC, r.id ASC
        LIMIT v_limit
      ) sub;

      RETURN jsonb_build_object('ok', true, 'requests', v_result);
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.list_semantic_topic_lifecycle_review_requests(TEXT, INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.list_semantic_topic_lifecycle_review_requests(TEXT, INTEGER, TIMESTAMPTZ, UUID) TO authenticated;

    RAISE NOTICE '088: list_semantic_topic_lifecycle_review_requests created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '088: list_semantic_topic_lifecycle_review_requests already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'list_semantic_topic_lifecycle_review_requests';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql' AND p.provolatile = 's' AND p.proisstrict IS FALSE AND p.prosecdef IS TRUE
        AND p.proparallel = 'u' AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '088 drift: list_semantic_topic_lifecycle_review_requests structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '088 drift: list_semantic_topic_lifecycle_review_requests body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid)))) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'authenticated')
       )
    THEN
      RAISE EXCEPTION '088 drift: list_semantic_topic_lifecycle_review_requests ACL does not match exactly (expected postgres+authenticated EXECUTE only)';
    END IF;

    RAISE NOTICE '088: list_semantic_topic_lifecycle_review_requests already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '088 fail-closed: list_semantic_topic_lifecycle_review_requests has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_list_088$;

-- ============================================================
-- 3. get_semantic_topic_lifecycle_review_request -- authenticated-only,
--    teljes, redaktalt detail. SOHA nem ad vissza reviewer/canceller
--    nyers UUID-t, transition_event_id-t, nyers forras-identitast.
-- ============================================================

DO $migrate_get_088$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '74b1694a0f72dfb845d8a5e651423401';
  v_expected_args CONSTANT text := 'p_review_request_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_semantic_topic_lifecycle_review_request';

  IF v_name_count = 0 THEN
    RAISE NOTICE '088: get_semantic_topic_lifecycle_review_request does not exist -- CREATE branch.';

    CREATE FUNCTION public.get_semantic_topic_lifecycle_review_request(
      p_review_request_id UUID
    ) RETURNS JSONB
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_caller_user_id UUID;
      v_request RECORD;
      v_topic RECORD;
      v_live_vector JSONB;
      v_live_digest TEXT;
      v_mechanical_fail TEXT;
      v_stale_topic_state BOOLEAN;
      v_stale_topic_version BOOLEAN;
      v_stale_vector BOOLEAN;
      v_stale_mechanical BOOLEAN;
      v_is_potentially_stale BOOLEAN;
      v_history JSONB;
    BEGIN
      v_caller_user_id := auth.uid();
      IF v_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'get_semantic_topic_lifecycle_review_request: authentication required';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.semantic_topic_reviewers WHERE user_id = v_caller_user_id AND active IS TRUE) THEN
        RAISE EXCEPTION 'get_semantic_topic_lifecycle_review_request: caller is not an active reviewer';
      END IF;

      SELECT * INTO v_request FROM public.semantic_topic_lifecycle_review_requests WHERE id = p_review_request_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reasonCode', 'NOT_FOUND');
      END IF;

      -- semantic_topic_id FK is ON DELETE RESTRICT -- a hivatkozott topic
      -- garantaltan letezik, amig barmilyen review request ra mutat.
      SELECT * INTO v_topic FROM public.semantic_topics WHERE id = v_request.semantic_topic_id;

      v_live_vector := public.compute_topic_evidence_vector(v_request.semantic_topic_id);
      v_live_digest := public._semantic_topic_lifecycle_snapshot_digest(
        v_request.semantic_topic_id, v_request.target_status, v_request.review_policy_version, v_live_vector
      );

      v_stale_topic_state := v_topic.lifecycle_status IS DISTINCT FROM v_request.from_status;
      v_stale_topic_version := v_topic.status_version IS DISTINCT FROM v_request.expected_status_version;
      v_stale_vector := v_live_digest IS DISTINCT FROM v_request.evidence_vector_digest;

      v_mechanical_fail := NULL;
      IF v_request.target_status IN ('coherent', 'corroborating') THEN
        v_mechanical_fail := public._semantic_topic_lifecycle_mechanical_check(v_live_vector);
      END IF;
      v_stale_mechanical := v_mechanical_fail IS NOT NULL;

      -- Kizarolag UI-figyelmeztetes -- SOHA nem autoritativ. Az egyetlen
      -- tenyleges, kotelezo-erveny stale-donto 087
      -- execute_approved_semantic_topic_lifecycle_transition sajat, fix
      -- prioritasu lancolata vegrehajtaskor.
      v_is_potentially_stale := v_stale_topic_state OR v_stale_topic_version OR v_stale_vector OR v_stale_mechanical OR (v_request.status = 'stale');

      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'event_type', e.event_type,
        'actor_kind', e.actor_kind,
        'created_at', e.created_at
      ) ORDER BY e.created_at ASC), '[]'::jsonb)
      INTO v_history
      FROM public.semantic_topic_lifecycle_review_events e
      WHERE e.review_request_id = v_request.id;

      RETURN jsonb_build_object('ok', true, 'request', jsonb_build_object(
        'review_request_id', v_request.id,
        'generation', v_request.generation,
        'semantic_topic_id', v_request.semantic_topic_id,
        'topic_canonical_label', v_topic.canonical_label,
        'from_status', v_request.from_status,
        'target_status', v_request.target_status,
        'request_status', v_request.status,
        'requested_at', v_request.requested_at,
        'expires_at', v_request.expires_at,
        'decided_at', v_request.decided_at,
        'stale_reason_code', CASE WHEN v_request.status = 'stale' THEN v_request.stale_reason_code ELSE NULL END,
        'snapshot', jsonb_build_object(
          'evidence_vector', v_request.evidence_vector_snapshot,
          'digest', v_request.evidence_vector_digest,
          'captured_at', v_request.requested_at,
          'from_lifecycle_status', v_request.from_status,
          'expected_status_version', v_request.expected_status_version
        ),
        'review_policy_version', v_request.review_policy_version,
        'decision', CASE WHEN v_request.decided_at IS NOT NULL THEN jsonb_build_object(
          'reviewer_role_snapshot', v_request.reviewer_role_snapshot,
          'decided_at', v_request.decided_at,
          'reason_code', v_request.reason_code,
          'reviewer_rationale', v_request.reviewer_rationale,
          'same_semantic_identity_confirmed', v_request.same_semantic_identity_confirmed,
          'no_material_identity_conflict', v_request.no_material_identity_conflict,
          'canonical_definition_scope_fit_confirmed', v_request.canonical_definition_scope_fit_confirmed,
          'provenance_relationship_reviewed', v_request.provenance_relationship_reviewed,
          'decided_by_current_reviewer', (v_request.reviewer_user_id = v_caller_user_id)
        ) ELSE NULL END,
        'execution', CASE WHEN v_request.executed_at IS NOT NULL THEN jsonb_build_object(
          'executed_at', v_request.executed_at
        ) ELSE NULL END,
        'cancellation', CASE WHEN v_request.cancelled_at IS NOT NULL THEN jsonb_build_object(
          'cancelled_at', v_request.cancelled_at,
          'cancel_reason_code', v_request.cancel_reason_code,
          'cancel_rationale', v_request.cancel_rationale,
          'cancelled_by_current_reviewer', (v_request.cancelled_by_user_id = v_caller_user_id)
        ) ELSE NULL END,
        'transition_history', v_history,
        'live', jsonb_build_object(
          'lifecycle_status', v_topic.lifecycle_status,
          'status_version', v_topic.status_version,
          'evidence_vector', v_live_vector,
          'vector_digest', v_live_digest,
          'mechanical_requirements_currently_met', (v_request.target_status NOT IN ('coherent', 'corroborating')) OR (v_mechanical_fail IS NULL)
        ),
        'staleness_signals', jsonb_build_object(
          'topic_status_changed', v_stale_topic_state,
          'topic_version_changed', v_stale_topic_version,
          'evidence_vector_changed', v_stale_vector,
          'mechanical_requirements_lost', v_stale_mechanical
        ),
        'is_potentially_stale', v_is_potentially_stale
      ));
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.get_semantic_topic_lifecycle_review_request(UUID) FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.get_semantic_topic_lifecycle_review_request(UUID) TO authenticated;

    RAISE NOTICE '088: get_semantic_topic_lifecycle_review_request created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '088: get_semantic_topic_lifecycle_review_request already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_semantic_topic_lifecycle_review_request';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql' AND p.provolatile = 's' AND p.proisstrict IS FALSE AND p.prosecdef IS TRUE
        AND p.proparallel = 'u' AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '088 drift: get_semantic_topic_lifecycle_review_request structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '088 drift: get_semantic_topic_lifecycle_review_request body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid)))) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'authenticated')
       )
    THEN
      RAISE EXCEPTION '088 drift: get_semantic_topic_lifecycle_review_request ACL does not match exactly (expected postgres+authenticated EXECUTE only)';
    END IF;

    RAISE NOTICE '088: get_semantic_topic_lifecycle_review_request already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '088 fail-closed: get_semantic_topic_lifecycle_review_request has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_get_088$;

-- ============================================================
-- 4. Fail-fast vegallapot onellenorzes -- a 2 uj + 1 helper hash MELLETT
--    ujra megerositi mind a 6 upstream (086+087) hash valtozatlansagat.
-- ============================================================

DO $final_selfcheck_088$
DECLARE
  v_hash text;
  v_expected_digest_hash CONSTANT text := '761d4217d220499617c54da6754bf347';
  v_expected_list_hash CONSTANT text := 'e146ee7500646b5fd240545a0419d5a5';
  v_expected_get_hash CONSTANT text := '74b1694a0f72dfb845d8a5e651423401';
BEGIN
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public._semantic_topic_lifecycle_snapshot_digest(uuid, text, integer, jsonb)'::regprocedure;
  IF v_hash <> v_expected_digest_hash THEN
    RAISE EXCEPTION '088 CRITICAL: _semantic_topic_lifecycle_snapshot_digest final body hash (%) does not match expected.', v_hash;
  END IF;

  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.list_semantic_topic_lifecycle_review_requests(text, integer, timestamp with time zone, uuid)'::regprocedure;
  IF v_hash <> v_expected_list_hash THEN
    RAISE EXCEPTION '088 CRITICAL: list_semantic_topic_lifecycle_review_requests final body hash (%) does not match expected.', v_hash;
  END IF;

  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.get_semantic_topic_lifecycle_review_request(uuid)'::regprocedure;
  IF v_hash <> v_expected_get_hash THEN
    RAISE EXCEPTION '088 CRITICAL: get_semantic_topic_lifecycle_review_request final body hash (%) does not match expected.', v_hash;
  END IF;

  -- Upstream (086+087) chain-of-custody -- 088 sem hagyhatja csendben
  -- driftelni oket.
  IF (SELECT md5(replace(prosrc, E'\r\n', E'\n')) FROM pg_proc WHERE oid = 'public.compute_topic_evidence_vector(uuid)'::regprocedure) <> '73aeb37846bcc80fd42a4e2c8862dc7c' THEN
    RAISE EXCEPTION '088 CRITICAL: compute_topic_evidence_vector (086) body hash changed -- this migration must NEVER touch it. Aborting.';
  END IF;
  IF (SELECT md5(replace(prosrc, E'\r\n', E'\n')) FROM pg_proc WHERE oid = 'public._semantic_topic_lifecycle_mechanical_check(jsonb)'::regprocedure) <> 'd75add661114d913cd6e783481202128' THEN
    RAISE EXCEPTION '088 CRITICAL: _semantic_topic_lifecycle_mechanical_check (087) body hash changed -- this migration must NEVER touch it. Aborting.';
  END IF;
  IF (SELECT md5(replace(prosrc, E'\r\n', E'\n')) FROM pg_proc WHERE oid = 'public.create_semantic_topic_lifecycle_review_request(uuid, text, text)'::regprocedure) <> '162b4b91d7d742722a4f580ababff34c' THEN
    RAISE EXCEPTION '088 CRITICAL: create_semantic_topic_lifecycle_review_request (087) body hash changed -- this migration must NEVER touch it. Aborting.';
  END IF;
  IF (SELECT md5(replace(prosrc, E'\r\n', E'\n')) FROM pg_proc WHERE oid = 'public.record_semantic_topic_lifecycle_review_decision(uuid, text, text, text, text, boolean, boolean, boolean, boolean, integer)'::regprocedure) <> '84e841b23fe2d42725c53d09bbb1b2a7' THEN
    RAISE EXCEPTION '088 CRITICAL: record_semantic_topic_lifecycle_review_decision (087) body hash changed -- this migration must NEVER touch it. Aborting.';
  END IF;
  IF (SELECT md5(replace(prosrc, E'\r\n', E'\n')) FROM pg_proc WHERE oid = 'public.cancel_semantic_topic_lifecycle_review_request(uuid, text, text, text)'::regprocedure) <> '3d89febb55199ecaaa6936d4e68bcecb' THEN
    RAISE EXCEPTION '088 CRITICAL: cancel_semantic_topic_lifecycle_review_request (087) body hash changed -- this migration must NEVER touch it. Aborting.';
  END IF;
  IF (SELECT md5(replace(prosrc, E'\r\n', E'\n')) FROM pg_proc WHERE oid = 'public.execute_approved_semantic_topic_lifecycle_transition(uuid, text)'::regprocedure) <> '6c12de4cef728e046490645c0ce3b057' THEN
    RAISE EXCEPTION '088 CRITICAL: execute_approved_semantic_topic_lifecycle_transition (087) body hash changed -- this migration must NEVER touch it. Aborting.';
  END IF;

  RAISE NOTICE '088: final self-check passed -- helper + 2 read RPCs present with expected body hashes, all 6 upstream (086+087) hashes confirmed unchanged.';
END;
$final_selfcheck_088$;

NOTIFY pgrst, 'reload schema';

COMMIT;
