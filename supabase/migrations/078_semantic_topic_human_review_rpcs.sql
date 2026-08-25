-- ============================================================
-- Migration 078: Semantic Topic Identity v0 -- Human-Reviewed
-- Candidate Workflow, RPC layer (S4B)
--
-- Kanonikus szerzodes forrasa: "PFM Semantic Topic Identity v0 --
-- Human-Reviewed Candidate Workflow -- Local Implementation Phase 2
-- -- RPC Layer 078". Sema-forras: 077 (topic_assignment_review_requests,
-- topic_assignment_review_events, semantic_topic_reviewers,
-- semantic_topic_reviewer_events). Reszletes szerzodes:
-- docs/architecture/semantic-topic-identity-v0-contract.md SS32.
--
-- HATOKOR -- nyolc uj SECURITY DEFINER RPC. NINCS uj tabla, NINCS ALTER a
-- 001-077 migraciokon, NINCS record_topic_assignment_decision-modositas
-- (torzse/szignaturaja/grantjai/a 0.8500 kuszob erintetlen), NINCS
-- reviewer-provisioning/deaktivalo RPC (a semantic_topic_reviewers tabla
-- ures marad -- v0-ban kizarolag kezi, postgres-privilegizalt INSERT-tel
-- tolthetot), NINCS valodi reviewer bootstrap.
--
-- A nyolc RPC:
--   create_topic_assignment_review_request(extraction_run_id, idempotency_key)
--     -- service_role. Pending review-request + 'requested' event letrehozasa.
--   list_pending_topic_assignment_review_requests(limit, after_requested_at, after_id)
--     -- authenticated, aktiv reviewer. Adatminimalizalt lista.
--   get_topic_assignment_review_request(review_request_id)
--     -- authenticated, aktiv reviewer. Egyetlen request reszletei.
--   record_topic_assignment_review_decision(review_request_id, decision_idempotency_key, outcome, ...)
--     -- authenticated, aktiv reviewer. approved -> approval_digest;
--        rejected -> atomikus append-only QUARANTINE decision.
--   expire_stale_topic_assignment_review_requests(batch_limit)
--     -- service_role. Kulon sweeper RPC, sosem write-then-raise.
--   cancel_topic_assignment_review_request(review_request_id, cancelled_by_user_id)
--     -- service_role. Csak meg pending request.
--   revoke_topic_assignment_review_approval(review_request_id)
--     -- authenticated, aktiv reviewer. Csak meg nem executed approved request.
--   execute_approved_topic_assignment_review(review_request_id, idempotency_key)
--     -- service_role. Ujraszamolja es osszeveti a request_payload_digestet
--        es az approval_digestet, ujra-ellenorzi a reviewer aktivitasat es
--        (ATTACH_EXISTING eseten) a target topic eletciklusat FOR UPDATE
--        alatt, majd CREATE_NEW/ATTACH_EXISTING vegrehajtasa.
--
-- Digest-domainek (mindegyik a canonikus szoveg ELSO eleme, nem csak
-- dokumentacios cimke):
--   willviral.semantic-topic.review-request:v1
--   willviral.semantic-topic.review-decision:v1
--   willviral.semantic-topic.review-execution:v1
-- SHA-256, UTF-8, lowercase hex, fix mezosorrendu JSON-objektum szoveg
-- (format() + to_json(), sosem elhatarolo-alapu konkatenacio egy szabad
-- szoveges mezonel, amely a hatart elcsusztathatna).
-- ============================================================

BEGIN;

-- ============================================================
-- 0. FUGGOSEGI ELOFELTETEL -- 077 negy tablaja es a decision_reason
--    additiv bovitese nelkul ez a migracio fail-closed leall.
-- ============================================================

DO $dependency_check$
DECLARE
  v_table_count int;
  v_decision_reason_def text;
BEGIN
  SELECT count(*) INTO v_table_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (
      'semantic_topic_reviewers', 'semantic_topic_reviewer_events',
      'topic_assignment_review_requests', 'topic_assignment_review_events'
    );
  IF v_table_count <> 4 THEN
    RAISE EXCEPTION '078 fail-closed: migration 077 is not fully applied (% of 4 human-review tables present). Apply 077 first.', v_table_count;
  END IF;

  SELECT pg_get_constraintdef(oid, true) INTO v_decision_reason_def
  FROM pg_constraint
  WHERE conrelid = 'public.topic_assignment_decisions'::regclass
    AND conname = 'topic_assignment_decisions_decision_reason_check';
  IF v_decision_reason_def NOT LIKE '%human_review_approved%' OR v_decision_reason_def NOT LIKE '%human_review_rejected%' THEN
    RAISE EXCEPTION '078 fail-closed: topic_assignment_decisions_decision_reason_check does not include human_review_approved/human_review_rejected -- 077''s additive CHECK bump is missing or has drifted.';
  END IF;

  RAISE NOTICE '078: dependency pre-flight passed (077 fully applied).';
END;
$dependency_check$;

-- ============================================================
-- 1. GLOBALIS RPC-TOPOLOGIAI KAPU -- a nyolc UJ RPC-re
-- ============================================================

DO $topology_gate$
DECLARE
  v_present_count int;
BEGIN
  SELECT count(*) INTO v_present_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN (
    'create_topic_assignment_review_request', 'list_pending_topic_assignment_review_requests',
    'get_topic_assignment_review_request', 'record_topic_assignment_review_decision',
    'expire_stale_topic_assignment_review_requests', 'cancel_topic_assignment_review_request',
    'revoke_topic_assignment_review_approval', 'execute_approved_topic_assignment_review'
  );

  IF v_present_count NOT IN (0, 8) THEN
    RAISE EXCEPTION '078 fail-closed: partial topology detected -- % of 8 new RPCs exist. No DDL will run. Manual investigation required before this migration can proceed.', v_present_count;
  END IF;

  RAISE NOTICE '078: global RPC topology gate passed (% of 8 present).', v_present_count;
END;
$topology_gate$;

-- ============================================================
-- 2. create_topic_assignment_review_request
-- ============================================================

DO $migrate_catar$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'e66bbbbc216ad678965c8c6906f7903a';
  v_expected_args CONSTANT text := 'p_extraction_run_id uuid, p_idempotency_key text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_topic_assignment_review_request';

  IF v_name_count = 0 THEN
    RAISE NOTICE '078: create_topic_assignment_review_request does not exist -- CREATE branch.';

    CREATE FUNCTION public.create_topic_assignment_review_request(
      p_extraction_run_id UUID,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_review_confidence_ceiling CONSTANT NUMERIC(5,4) := 0.8500;
      v_request_ttl_hours CONSTANT INTEGER := 168;
      v_domain CONSTANT TEXT := 'willviral.semantic-topic.review-request:v1';
      v_evidence_id UUID;
      v_extraction RECORD;
      v_generation INTEGER;
      v_request_payload_digest TEXT;
      v_request_operation_digest TEXT;
      v_expires_at TIMESTAMPTZ;
      v_new_id UUID;
      v_existing RECORD;
      v_existing_digest TEXT;
      v_constraint_name TEXT;
    BEGIN
      SELECT signal_evidence_id INTO v_evidence_id FROM public.topic_extraction_runs WHERE id = p_extraction_run_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'create_topic_assignment_review_request: extraction_run % not found', p_extraction_run_id;
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_evidence_id::text, 0));

      SELECT * INTO v_extraction FROM public.topic_extraction_runs WHERE id = p_extraction_run_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'create_topic_assignment_review_request: extraction_run % not found (post-lock)', p_extraction_run_id;
      END IF;
      IF v_extraction.status <> 'completed' THEN
        RAISE EXCEPTION 'create_topic_assignment_review_request: extraction_run % is not completed (status=%)', p_extraction_run_id, v_extraction.status;
      END IF;
      IF v_extraction.structured_output->>'specificity' <> 'specific' THEN
        RAISE EXCEPTION 'create_topic_assignment_review_request: requires structured_output.specificity=specific (got %)', v_extraction.structured_output->>'specificity';
      END IF;
      IF (v_extraction.structured_output->>'confidence')::numeric >= v_review_confidence_ceiling THEN
        RAISE EXCEPTION 'create_topic_assignment_review_request: requires confidence < % (got %) -- at/above threshold goes through the automatic path, not human review', v_review_confidence_ceiling, v_extraction.structured_output->>'confidence';
      END IF;
      IF jsonb_array_length(v_extraction.structured_output->'supporting_spans') < 1 THEN
        RAISE EXCEPTION 'create_topic_assignment_review_request: requires at least one supporting_spans entry';
      END IF;

      IF EXISTS (SELECT 1 FROM public.topic_assignment_decisions WHERE extraction_run_id = p_extraction_run_id) THEN
        RAISE EXCEPTION 'create_topic_assignment_review_request: extraction_run % already has a topic_assignment_decisions row -- no new review request is possible', p_extraction_run_id;
      END IF;

      -- request_payload_digest -- built from the extraction's OWN already-canonical
      -- output_digest (074's own structured_output canonicalization), never
      -- re-derived independently -- avoids a second, possibly-divergent
      -- canonicalization of the same JSON content. Purely a function of the
      -- (immutable) extraction row, never of server-side counter state, so it
      -- is safe to compute unconditionally, before the replay check below.
      v_request_payload_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"domain":%s,"extraction_run_id":%s,"output_digest":%s,"confidence":%s,"specificity":%s}',
          to_json(v_domain)::text, to_json(p_extraction_run_id::text)::text, to_json(v_extraction.output_digest)::text,
          (((v_extraction.structured_output->>'confidence')::numeric)::numeric(5,4))::text,
          to_json(v_extraction.structured_output->>'specificity')::text
        ), 'UTF8')), 'hex');

      -- Idempotency-key lookup FIRST, before computing a candidate generation.
      -- generation is server-computed, stateful (MAX(generation)+1 scoped to
      -- this extraction_run_id) -- computing it before knowing whether this
      -- call is a replay would inflate the count by the very row being
      -- replayed against, producing a spurious digest mismatch on an
      -- otherwise byte-identical retry. A genuine replay always reuses the
      -- EXISTING row's own stored generation, never a freshly recomputed one.
      SELECT * INTO v_existing FROM public.topic_assignment_review_requests WHERE request_idempotency_key = p_idempotency_key;
      IF FOUND THEN
        IF v_existing.extraction_run_id <> p_extraction_run_id THEN
          RAISE EXCEPTION 'create_topic_assignment_review_request: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used for a different extraction_run', p_idempotency_key;
        END IF;
        v_existing_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          format(
            '{"domain":%s,"extraction_run_id":%s,"generation":%s,"idempotency_key":%s,"request_payload_digest":%s}',
            to_json(v_domain)::text, to_json(v_existing.extraction_run_id::text)::text, to_json(v_existing.generation)::text,
            to_json(v_existing.request_idempotency_key)::text, to_json(v_request_payload_digest)::text
          ), 'UTF8')), 'hex');
        IF v_existing_digest = v_existing.request_operation_digest THEN
          RETURN jsonb_build_object(
            'ok', true, 'outcome', 'replayed', 'review_request_id', v_existing.id, 'generation', v_existing.generation,
            'status', v_existing.status, 'expires_at', v_existing.expires_at, 'idempotency_key', v_existing.request_idempotency_key
          );
        ELSE
          RAISE EXCEPTION 'create_topic_assignment_review_request: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key;
        END IF;
      END IF;

      -- Genuinely new key -- now safe to compute a fresh generation.
      SELECT coalesce(max(generation), 0) + 1 INTO v_generation
        FROM public.topic_assignment_review_requests WHERE extraction_run_id = p_extraction_run_id;

      v_request_operation_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"domain":%s,"extraction_run_id":%s,"generation":%s,"idempotency_key":%s,"request_payload_digest":%s}',
          to_json(v_domain)::text, to_json(p_extraction_run_id::text)::text, to_json(v_generation)::text,
          to_json(p_idempotency_key)::text, to_json(v_request_payload_digest)::text
        ), 'UTF8')), 'hex');

      v_expires_at := now() + make_interval(hours => v_request_ttl_hours);

      BEGIN
        INSERT INTO public.topic_assignment_review_requests (
          extraction_run_id, generation, status, request_idempotency_key, request_operation_digest,
          expires_at, request_payload_digest
        ) VALUES (
          p_extraction_run_id, v_generation, 'pending', p_idempotency_key, v_request_operation_digest,
          v_expires_at, v_request_payload_digest
        ) RETURNING id INTO v_new_id;

        INSERT INTO public.topic_assignment_review_events (
          review_request_id, event_type, actor_user_id, actor_kind, policy_version, operation_digest
        ) VALUES (
          v_new_id, 'requested', NULL, 'service_role_system', 1, v_request_operation_digest
        );

        RETURN jsonb_build_object(
          'ok', true, 'outcome', 'created', 'review_request_id', v_new_id, 'generation', v_generation,
          'status', 'pending', 'expires_at', v_expires_at, 'idempotency_key', p_idempotency_key
        );

      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;

        IF v_constraint_name = 'topic_assignment_review_requests_request_key_key' THEN
          -- Genuine concurrent race: another call with the same key committed
          -- between our SELECT above and this INSERT. Re-fetch and compare
          -- using ITS OWN stored generation, exactly as above.
          SELECT * INTO v_existing FROM public.topic_assignment_review_requests WHERE request_idempotency_key = p_idempotency_key;
          v_existing_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
            format(
              '{"domain":%s,"extraction_run_id":%s,"generation":%s,"idempotency_key":%s,"request_payload_digest":%s}',
              to_json(v_domain)::text, to_json(v_existing.extraction_run_id::text)::text, to_json(v_existing.generation)::text,
              to_json(v_existing.request_idempotency_key)::text, to_json(v_request_payload_digest)::text
            ), 'UTF8')), 'hex');
          IF v_existing_digest = v_existing.request_operation_digest THEN
            RETURN jsonb_build_object(
              'ok', true, 'outcome', 'replayed', 'review_request_id', v_existing.id, 'generation', v_existing.generation,
              'status', v_existing.status, 'expires_at', v_existing.expires_at, 'idempotency_key', v_existing.request_idempotency_key
            );
          ELSE
            RAISE EXCEPTION 'create_topic_assignment_review_request: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different request', p_idempotency_key;
          END IF;
        ELSIF v_constraint_name = 'idx_topic_assignment_review_requests_one_live_per_run' THEN
          RAISE EXCEPTION 'create_topic_assignment_review_request: extraction_run % already has a live (pending/approved) review request', p_extraction_run_id;
        ELSE
          RAISE;
        END IF;
      END;
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.create_topic_assignment_review_request(UUID, TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.create_topic_assignment_review_request(UUID, TEXT) TO service_role;

    RAISE NOTICE '078: create_topic_assignment_review_request created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '078: create_topic_assignment_review_request already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'create_topic_assignment_review_request';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '078 drift: create_topic_assignment_review_request structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '078 drift: create_topic_assignment_review_request body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'service_role')
       )
    THEN
      RAISE EXCEPTION '078 drift: create_topic_assignment_review_request ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '078: create_topic_assignment_review_request already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '078 fail-closed: create_topic_assignment_review_request has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_catar$;

-- ============================================================
-- 3. list_pending_topic_assignment_review_requests
-- ============================================================

DO $migrate_lptarr$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'dc5bc62aa0a421daaa00aa49673cbedc';
  v_expected_args CONSTANT text := 'p_limit integer, p_after_requested_at timestamp with time zone, p_after_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'list_pending_topic_assignment_review_requests';

  IF v_name_count = 0 THEN
    RAISE NOTICE '078: list_pending_topic_assignment_review_requests does not exist -- CREATE branch.';

    CREATE FUNCTION public.list_pending_topic_assignment_review_requests(
      p_limit INTEGER DEFAULT 20,
      p_after_requested_at TIMESTAMPTZ DEFAULT NULL,
      p_after_id UUID DEFAULT NULL
    ) RETURNS JSONB
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_caller_user_id UUID;
      v_limit INTEGER;
      v_result JSONB;
    BEGIN
      v_caller_user_id := auth.uid();
      IF v_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'list_pending_topic_assignment_review_requests: authentication required';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.semantic_topic_reviewers WHERE user_id = v_caller_user_id AND active IS TRUE) THEN
        RAISE EXCEPTION 'list_pending_topic_assignment_review_requests: caller is not an active reviewer';
      END IF;

      v_limit := LEAST(GREATEST(coalesce(p_limit, 20), 1), 50);

      SELECT coalesce(jsonb_agg(row_data ORDER BY row_data->>'requested_at', row_data->>'review_request_id'), '[]'::jsonb)
      INTO v_result
      FROM (
        SELECT jsonb_build_object(
          'review_request_id', r.id,
          'generation', r.generation,
          'requested_at', r.requested_at,
          'expires_at', r.expires_at,
          'extraction_run_id', r.extraction_run_id,
          'evidence', jsonb_build_object(
            'evidence_id', e.id,
            'title', e.title,
            'external_ref', e.external_ref,
            'published_at', e.published_at,
            'canonical_url', e.canonical_url
          ),
          'source', jsonb_build_object(
            'source_type', s.source_type,
            'source_family_key', s.source_family_key
          ),
          'candidate_label', t.structured_output->>'canonical_phenomenon_label',
          'specificity', t.structured_output->>'specificity',
          'content_format', t.structured_output->>'content_format',
          'model_reported_confidence', t.structured_output->>'confidence',
          'supporting_spans', t.structured_output->'supporting_spans'
        ) AS row_data
        FROM public.topic_assignment_review_requests r
        JOIN public.topic_extraction_runs t ON t.id = r.extraction_run_id
        JOIN public.signal_evidence e ON e.id = t.signal_evidence_id
        JOIN public.signal_sources s ON s.id = e.signal_source_id
        WHERE r.status = 'pending' AND r.expires_at > statement_timestamp()
          AND (p_after_requested_at IS NULL OR r.requested_at > p_after_requested_at
               OR (r.requested_at = p_after_requested_at AND r.id > p_after_id))
        ORDER BY r.requested_at ASC, r.id ASC
        LIMIT v_limit
      ) sub;

      RETURN jsonb_build_object('ok', true, 'requests', v_result);
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.list_pending_topic_assignment_review_requests(INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.list_pending_topic_assignment_review_requests(INTEGER, TIMESTAMPTZ, UUID) TO authenticated;

    RAISE NOTICE '078: list_pending_topic_assignment_review_requests created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '078: list_pending_topic_assignment_review_requests already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'list_pending_topic_assignment_review_requests';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 's'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '078 drift: list_pending_topic_assignment_review_requests structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '078 drift: list_pending_topic_assignment_review_requests body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'authenticated')
       )
    THEN
      RAISE EXCEPTION '078 drift: list_pending_topic_assignment_review_requests ACL does not match exactly (expected postgres+authenticated EXECUTE only)';
    END IF;

    RAISE NOTICE '078: list_pending_topic_assignment_review_requests already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '078 fail-closed: list_pending_topic_assignment_review_requests has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_lptarr$;

-- ============================================================
-- 4. get_topic_assignment_review_request
-- ============================================================

DO $migrate_gtarr$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '702dff99375c953725c8ea966782d2d7';
  v_expected_args CONSTANT text := 'p_review_request_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_topic_assignment_review_request';

  IF v_name_count = 0 THEN
    RAISE NOTICE '078: get_topic_assignment_review_request does not exist -- CREATE branch.';

    CREATE FUNCTION public.get_topic_assignment_review_request(
      p_review_request_id UUID
    ) RETURNS JSONB
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_caller_user_id UUID;
      v_result JSONB;
    BEGIN
      v_caller_user_id := auth.uid();
      IF v_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'get_topic_assignment_review_request: authentication required';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.semantic_topic_reviewers WHERE user_id = v_caller_user_id AND active IS TRUE) THEN
        RAISE EXCEPTION 'get_topic_assignment_review_request: caller is not an active reviewer';
      END IF;

      SELECT jsonb_build_object(
        'review_request_id', r.id,
        'generation', r.generation,
        'status', r.status,
        'requested_at', r.requested_at,
        'expires_at', r.expires_at,
        'extraction_run_id', r.extraction_run_id,
        'evidence', jsonb_build_object(
          'evidence_id', e.id,
          'title', e.title,
          'snippet', e.snippet,
          'external_ref', e.external_ref,
          'published_at', e.published_at,
          'canonical_url', e.canonical_url,
          'first_seen_at', e.first_seen_at
        ),
        'source', jsonb_build_object(
          'source_type', s.source_type,
          'source_family_key', s.source_family_key
        ),
        'candidate_label', t.structured_output->>'canonical_phenomenon_label',
        'label_language', t.structured_output->>'label_language',
        'subject_entities', t.structured_output->'subject_entities',
        'action_or_event', t.structured_output->>'action_or_event',
        'location', t.structured_output->>'location',
        'temporal_context', t.structured_output->>'temporal_context',
        'specificity', t.structured_output->>'specificity',
        'content_format', t.structured_output->>'content_format',
        'model_reported_confidence', t.structured_output->>'confidence',
        'supporting_spans', t.structured_output->'supporting_spans',
        'decision', CASE WHEN r.status IN ('approved', 'rejected', 'revoked', 'executed') THEN jsonb_build_object(
          'decided_at', r.decided_at,
          'canonical_topic_label', r.canonical_topic_label,
          'topic_definition', r.topic_definition,
          'scope', r.scope,
          'inclusion_criteria', r.inclusion_criteria,
          'exclusion_criteria', r.exclusion_criteria,
          'lane_neutral_confirmed', r.lane_neutral_confirmed,
          'evidence_adequacy', r.evidence_adequacy,
          'duplicate_search_outcome', r.duplicate_search_outcome,
          'proposed_outcome', r.proposed_outcome,
          'target_semantic_topic_id', r.target_semantic_topic_id,
          'uncertainty_classification', r.uncertainty_classification,
          'reviewer_rationale', r.reviewer_rationale,
          'rejection_reason', r.rejection_reason
        ) ELSE NULL END
      ) INTO v_result
      FROM public.topic_assignment_review_requests r
      JOIN public.topic_extraction_runs t ON t.id = r.extraction_run_id
      JOIN public.signal_evidence e ON e.id = t.signal_evidence_id
      JOIN public.signal_sources s ON s.id = e.signal_source_id
      WHERE r.id = p_review_request_id;

      IF v_result IS NULL THEN
        RAISE EXCEPTION 'get_topic_assignment_review_request: review_request % not found', p_review_request_id;
      END IF;

      RETURN jsonb_build_object('ok', true, 'request', v_result);
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.get_topic_assignment_review_request(UUID) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.get_topic_assignment_review_request(UUID) TO authenticated;

    RAISE NOTICE '078: get_topic_assignment_review_request created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '078: get_topic_assignment_review_request already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_topic_assignment_review_request';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 's'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '078 drift: get_topic_assignment_review_request structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '078 drift: get_topic_assignment_review_request body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'authenticated')
       )
    THEN
      RAISE EXCEPTION '078 drift: get_topic_assignment_review_request ACL does not match exactly (expected postgres+authenticated EXECUTE only)';
    END IF;

    RAISE NOTICE '078: get_topic_assignment_review_request already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '078 fail-closed: get_topic_assignment_review_request has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_gtarr$;

-- ============================================================
-- 5. record_topic_assignment_review_decision
-- ============================================================

DO $migrate_rtard$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '2ff3bc959745d38561143d1baecb32d5';
  v_expected_args CONSTANT text := 'p_review_request_id uuid, p_decision_idempotency_key text, p_outcome text, p_canonical_topic_label text, p_topic_definition text, p_scope text, p_inclusion_criteria text, p_exclusion_criteria text, p_lane_neutral_confirmed boolean, p_evidence_adequacy text, p_duplicate_search_outcome text, p_proposed_outcome text, p_target_semantic_topic_id uuid, p_uncertainty_classification text, p_reviewer_rationale text, p_review_policy_version integer, p_rejection_reason text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_topic_assignment_review_decision';

  IF v_name_count = 0 THEN
    RAISE NOTICE '078: record_topic_assignment_review_decision does not exist -- CREATE branch.';

    CREATE FUNCTION public.record_topic_assignment_review_decision(
      p_review_request_id UUID,
      p_decision_idempotency_key TEXT,
      p_outcome TEXT,
      p_canonical_topic_label TEXT DEFAULT NULL,
      p_topic_definition TEXT DEFAULT NULL,
      p_scope TEXT DEFAULT NULL,
      p_inclusion_criteria TEXT DEFAULT NULL,
      p_exclusion_criteria TEXT DEFAULT NULL,
      p_lane_neutral_confirmed BOOLEAN DEFAULT NULL,
      p_evidence_adequacy TEXT DEFAULT NULL,
      p_duplicate_search_outcome TEXT DEFAULT NULL,
      p_proposed_outcome TEXT DEFAULT NULL,
      p_target_semantic_topic_id UUID DEFAULT NULL,
      p_uncertainty_classification TEXT DEFAULT NULL,
      p_reviewer_rationale TEXT DEFAULT NULL,
      p_review_policy_version INTEGER DEFAULT NULL,
      p_rejection_reason TEXT DEFAULT NULL
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_domain CONSTANT TEXT := 'willviral.semantic-topic.review-decision:v1';
      v_approval_digest_version CONSTANT INTEGER := 1;
      v_caller_user_id UUID;
      v_reviewer RECORD;
      v_extraction_run_id UUID;
      v_evidence_id UUID;
      v_request RECORD;
      v_topic RECORD;
      v_decision_digest TEXT;
      v_approval_digest TEXT;
      v_existing_check_digest TEXT;
      v_decision_id UUID;
      v_constraint_name TEXT;
      v_decision_reason CONSTANT TEXT := 'human_review_rejected';
    BEGIN
      IF p_outcome NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'record_topic_assignment_review_decision: p_outcome must be approved or rejected (got %)', p_outcome;
      END IF;

      v_caller_user_id := auth.uid();
      IF v_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'record_topic_assignment_review_decision: authentication required';
      END IF;

      SELECT extraction_run_id INTO v_extraction_run_id FROM public.topic_assignment_review_requests WHERE id = p_review_request_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'record_topic_assignment_review_decision: review_request % not found', p_review_request_id;
      END IF;
      SELECT signal_evidence_id INTO v_evidence_id FROM public.topic_extraction_runs WHERE id = v_extraction_run_id;

      -- Lock order: evidence (tag 0), then request (tag 10).
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_evidence_id::text, 0));
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_review_request_id::text, 10));

      SELECT * INTO v_request FROM public.topic_assignment_review_requests WHERE id = p_review_request_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'record_topic_assignment_review_decision: review_request % not found (post-lock)', p_review_request_id;
      END IF;

      SELECT * INTO v_reviewer FROM public.semantic_topic_reviewers WHERE user_id = v_caller_user_id AND active IS TRUE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'record_topic_assignment_review_decision: caller is not an active reviewer';
      END IF;

      -- Already-decided replay/conflict dispatch -- checked before the expiry
      -- gate, since a decided request is no longer subject to expiry at all.
      IF v_request.status IN ('approved', 'rejected') THEN
        IF v_request.decision_idempotency_key = p_decision_idempotency_key THEN
          -- Recompute using this call's parameters and compare to what's
          -- stored -- an identical retry always passes; a same-key call with
          -- different judgment content never silently "succeeds" as the old one.
          IF p_outcome = 'approved' THEN
            v_decision_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
              format(
                '{"domain":%s,"review_request_id":%s,"generation":%s,"decision_idempotency_key":%s,"outcome":%s,"reviewer_user_id":%s,"reviewer_role_snapshot":%s,"review_policy_version":%s,"canonical_topic_label":%s,"topic_definition":%s,"scope":%s,"inclusion_criteria":%s,"exclusion_criteria":%s,"lane_neutral_confirmed":%s,"evidence_adequacy":%s,"duplicate_search_outcome":%s,"proposed_outcome":%s,"target_semantic_topic_id":%s,"uncertainty_classification":%s,"reviewer_rationale":%s}',
                to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(v_request.generation)::text, to_json(p_decision_idempotency_key)::text, to_json(p_outcome)::text,
                to_json(v_caller_user_id::text)::text, to_json(v_reviewer.role)::text, to_json(p_review_policy_version)::text,
                to_json(p_canonical_topic_label)::text, to_json(p_topic_definition)::text, to_json(p_scope)::text,
                to_json(p_inclusion_criteria)::text, to_json(p_exclusion_criteria)::text, to_json(p_lane_neutral_confirmed)::text,
                to_json(p_evidence_adequacy)::text, to_json(p_duplicate_search_outcome)::text, to_json(p_proposed_outcome)::text,
                coalesce(to_json(p_target_semantic_topic_id::text)::text, 'null'), to_json(p_uncertainty_classification)::text, to_json(p_reviewer_rationale)::text
              ), 'UTF8')), 'hex');
          ELSE
            v_decision_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
              format(
                '{"domain":%s,"review_request_id":%s,"generation":%s,"decision_idempotency_key":%s,"outcome":%s,"reviewer_user_id":%s,"reviewer_role_snapshot":%s,"review_policy_version":%s,"rejection_reason":%s,"reviewer_rationale":%s}',
                to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(v_request.generation)::text, to_json(p_decision_idempotency_key)::text, to_json(p_outcome)::text,
                to_json(v_caller_user_id::text)::text, to_json(v_reviewer.role)::text, to_json(p_review_policy_version)::text,
                to_json(p_rejection_reason)::text, to_json(p_reviewer_rationale)::text
              ), 'UTF8')), 'hex');
          END IF;

          IF v_decision_digest = v_request.decision_operation_digest THEN
            RETURN jsonb_build_object(
              'ok', true, 'outcome', 'replayed', 'review_request_id', v_request.id, 'status', v_request.status,
              'resulting_decision_id', v_request.resulting_decision_id, 'approval_digest', v_request.approval_digest
            );
          ELSE
            RAISE EXCEPTION 'record_topic_assignment_review_decision: IDEMPOTENCY_KEY_REUSE -- decision_idempotency_key % already used with a different decision', p_decision_idempotency_key;
          END IF;
        ELSE
          RAISE EXCEPTION 'record_topic_assignment_review_decision: ALREADY_DECIDED -- review_request % already decided (status=%)', p_review_request_id, v_request.status;
        END IF;
      ELSIF v_request.status <> 'pending' THEN
        RAISE EXCEPTION 'record_topic_assignment_review_decision: REVIEW_REQUEST_NOT_DECIDABLE -- status=% is not decidable', v_request.status;
      END IF;

      -- status = 'pending' from here on.
      IF v_request.expires_at <= statement_timestamp() THEN
        RAISE EXCEPTION 'record_topic_assignment_review_decision: REVIEW_REQUEST_EXPIRED -- review_request % expired at % -- persistence of the expired state is the sweeper''s job, not this call''s', p_review_request_id, v_request.expires_at;
      END IF;

      IF p_outcome = 'approved' THEN
        IF p_lane_neutral_confirmed IS NOT TRUE THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: approved requires lane_neutral_confirmed=true';
        END IF;
        IF p_evidence_adequacy <> 'adequate' THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: approved requires evidence_adequacy=adequate (got %)', p_evidence_adequacy;
        END IF;
        IF p_proposed_outcome NOT IN ('CREATE_NEW', 'ATTACH_EXISTING') THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: approved requires proposed_outcome CREATE_NEW or ATTACH_EXISTING (got %)', p_proposed_outcome;
        END IF;
        IF p_proposed_outcome = 'CREATE_NEW' AND p_target_semantic_topic_id IS NOT NULL THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: CREATE_NEW must not supply target_semantic_topic_id';
        END IF;
        IF p_proposed_outcome = 'ATTACH_EXISTING' AND p_target_semantic_topic_id IS NULL THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: ATTACH_EXISTING requires target_semantic_topic_id';
        END IF;
        IF p_canonical_topic_label IS NULL OR p_topic_definition IS NULL OR p_scope IS NULL
           OR p_inclusion_criteria IS NULL OR p_exclusion_criteria IS NULL
           OR p_duplicate_search_outcome IS NULL OR p_uncertainty_classification IS NULL
           OR p_reviewer_rationale IS NULL OR p_review_policy_version IS NULL THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: approved requires the full structured review snapshot';
        END IF;

        IF p_proposed_outcome = 'ATTACH_EXISTING' THEN
          SELECT * INTO v_topic FROM public.semantic_topics WHERE id = p_target_semantic_topic_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'record_topic_assignment_review_decision: target semantic_topic % not found', p_target_semantic_topic_id;
          END IF;
          -- Decision-time validation only -- the executor re-validates under
          -- its own FOR UPDATE lock at execution time, since the target's
          -- lifecycle can change in the window between approval and execution.
          IF v_topic.lifecycle_status IN ('split_required', 'merge_candidate', 'superseded', 'archived') THEN
            RAISE EXCEPTION 'record_topic_assignment_review_decision: target topic lifecycle_status=% never accepts ATTACH_EXISTING', v_topic.lifecycle_status;
          END IF;
        END IF;

        v_decision_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          format(
            '{"domain":%s,"review_request_id":%s,"generation":%s,"decision_idempotency_key":%s,"outcome":%s,"reviewer_user_id":%s,"reviewer_role_snapshot":%s,"review_policy_version":%s,"canonical_topic_label":%s,"topic_definition":%s,"scope":%s,"inclusion_criteria":%s,"exclusion_criteria":%s,"lane_neutral_confirmed":%s,"evidence_adequacy":%s,"duplicate_search_outcome":%s,"proposed_outcome":%s,"target_semantic_topic_id":%s,"uncertainty_classification":%s,"reviewer_rationale":%s}',
            to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(v_request.generation)::text, to_json(p_decision_idempotency_key)::text, to_json(p_outcome)::text,
            to_json(v_caller_user_id::text)::text, to_json(v_reviewer.role)::text, to_json(p_review_policy_version)::text,
            to_json(p_canonical_topic_label)::text, to_json(p_topic_definition)::text, to_json(p_scope)::text,
            to_json(p_inclusion_criteria)::text, to_json(p_exclusion_criteria)::text, to_json(p_lane_neutral_confirmed)::text,
            to_json(p_evidence_adequacy)::text, to_json(p_duplicate_search_outcome)::text, to_json(p_proposed_outcome)::text,
            coalesce(to_json(p_target_semantic_topic_id::text)::text, 'null'), to_json(p_uncertainty_classification)::text, to_json(p_reviewer_rationale)::text
          ), 'UTF8')), 'hex');

        -- approval_digest: the long-lived, idempotency-key-free proof the
        -- executor recomputes later -- covers everything decision_digest does
        -- except the call-specific decision_idempotency_key, plus the
        -- extraction's own immutable request_payload_digest, so the executor
        -- transitively proves the extraction content too.
        v_approval_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          format(
            '{"domain":%s,"review_request_id":%s,"generation":%s,"extraction_run_id":%s,"request_payload_digest":%s,"reviewer_user_id":%s,"reviewer_role_snapshot":%s,"review_policy_version":%s,"canonical_topic_label":%s,"topic_definition":%s,"scope":%s,"inclusion_criteria":%s,"exclusion_criteria":%s,"lane_neutral_confirmed":%s,"evidence_adequacy":%s,"duplicate_search_outcome":%s,"proposed_outcome":%s,"target_semantic_topic_id":%s,"uncertainty_classification":%s,"reviewer_rationale":%s}',
            to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(v_request.generation)::text, to_json(v_extraction_run_id::text)::text, to_json(v_request.request_payload_digest)::text,
            to_json(v_caller_user_id::text)::text, to_json(v_reviewer.role)::text, to_json(p_review_policy_version)::text,
            to_json(p_canonical_topic_label)::text, to_json(p_topic_definition)::text, to_json(p_scope)::text,
            to_json(p_inclusion_criteria)::text, to_json(p_exclusion_criteria)::text, to_json(p_lane_neutral_confirmed)::text,
            to_json(p_evidence_adequacy)::text, to_json(p_duplicate_search_outcome)::text, to_json(p_proposed_outcome)::text,
            coalesce(to_json(p_target_semantic_topic_id::text)::text, 'null'), to_json(p_uncertainty_classification)::text, to_json(p_reviewer_rationale)::text
          ), 'UTF8')), 'hex');

        BEGIN
          UPDATE public.topic_assignment_review_requests SET
            status = 'approved', reviewer_user_id = v_caller_user_id, reviewer_role_snapshot = v_reviewer.role,
            decided_at = now(), canonical_topic_label = p_canonical_topic_label, topic_definition = p_topic_definition,
            scope = p_scope, inclusion_criteria = p_inclusion_criteria, exclusion_criteria = p_exclusion_criteria,
            lane_neutral_confirmed = p_lane_neutral_confirmed, evidence_adequacy = p_evidence_adequacy,
            duplicate_search_outcome = p_duplicate_search_outcome, proposed_outcome = p_proposed_outcome,
            target_semantic_topic_id = p_target_semantic_topic_id, uncertainty_classification = p_uncertainty_classification,
            reviewer_rationale = p_reviewer_rationale, review_policy_version = p_review_policy_version,
            approval_digest = v_approval_digest, approval_digest_version = v_approval_digest_version,
            decision_idempotency_key = p_decision_idempotency_key, decision_operation_digest = v_decision_digest
          WHERE id = p_review_request_id;
        EXCEPTION WHEN unique_violation THEN
          GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
          IF v_constraint_name = 'idx_topic_assignment_review_requests_decision_key_unique' THEN
            RAISE EXCEPTION 'record_topic_assignment_review_decision: IDEMPOTENCY_KEY_REUSE -- decision_idempotency_key % already used on a different review_request', p_decision_idempotency_key;
          ELSE
            RAISE;
          END IF;
        END;

        INSERT INTO public.topic_assignment_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version, operation_digest)
        VALUES (p_review_request_id, 'approved', v_caller_user_id, 'authenticated_reviewer', p_review_policy_version, v_decision_digest);

        RETURN jsonb_build_object('ok', true, 'outcome', 'approved', 'review_request_id', p_review_request_id, 'approval_digest', v_approval_digest);

      ELSE -- rejected
        IF p_rejection_reason NOT IN (
          'insufficient_evidence', 'invalid_topic_identity', 'not_lane_neutral',
          'malformed_candidate', 'duplicate_without_valid_target', 'other_review_rejection'
        ) THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: rejected requires a valid rejection_reason (got %)', p_rejection_reason;
        END IF;
        IF p_reviewer_rationale IS NULL OR p_review_policy_version IS NULL THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: rejected requires reviewer_rationale and review_policy_version';
        END IF;

        v_decision_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          format(
            '{"domain":%s,"review_request_id":%s,"generation":%s,"decision_idempotency_key":%s,"outcome":%s,"reviewer_user_id":%s,"reviewer_role_snapshot":%s,"review_policy_version":%s,"rejection_reason":%s,"reviewer_rationale":%s}',
            to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(v_request.generation)::text, to_json(p_decision_idempotency_key)::text, to_json(p_outcome)::text,
            to_json(v_caller_user_id::text)::text, to_json(v_reviewer.role)::text, to_json(p_review_policy_version)::text,
            to_json(p_rejection_reason)::text, to_json(p_reviewer_rationale)::text
          ), 'UTF8')), 'hex');

        -- Append-only QUARANTINE decision, same transaction, same canonical
        -- decision_digest FORM as record_topic_assignment_decision's own
        -- (074) -- topic_assignment_decisions.decision_digest stays
        -- self-consistent regardless of which RPC wrote the row. NOT calling
        -- the old RPC -- its own internal reason-matrix does not (and must
        -- not) accept human_review_rejected.
        INSERT INTO public.topic_assignment_decisions (
          extraction_run_id, signal_evidence_id, outcome, semantic_topic_id, resulting_membership_id,
          decision_reason, deterministic_signals, model_confidence, decision_digest, idempotency_key
        )
        SELECT
          v_extraction_run_id, v_evidence_id, 'QUARANTINE', NULL::uuid, NULL::uuid,
          v_decision_reason, '{}'::jsonb, (t.structured_output->>'confidence')::numeric,
          encode(pg_catalog.sha256(pg_catalog.convert_to(
            format(
              '{"extraction_run_id":%s,"outcome":%s,"decision_reason":%s,"deterministic_signals":{},"existing_semantic_topic_id":null,"idempotency_key":%s}',
              to_json(v_extraction_run_id::text)::text, to_json('QUARANTINE'::text)::text, to_json(v_decision_reason)::text,
              to_json('review-reject:' || p_review_request_id::text)::text
            ), 'UTF8')), 'hex'),
          'review-reject:' || p_review_request_id::text
        FROM public.topic_extraction_runs t WHERE t.id = v_extraction_run_id
        RETURNING id INTO v_decision_id;

        BEGIN
          UPDATE public.topic_assignment_review_requests SET
            status = 'rejected', reviewer_user_id = v_caller_user_id, reviewer_role_snapshot = v_reviewer.role,
            decided_at = now(), rejection_reason = p_rejection_reason, reviewer_rationale = p_reviewer_rationale,
            review_policy_version = p_review_policy_version, resulting_decision_id = v_decision_id,
            decision_idempotency_key = p_decision_idempotency_key, decision_operation_digest = v_decision_digest
          WHERE id = p_review_request_id;
        EXCEPTION WHEN unique_violation THEN
          GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
          IF v_constraint_name = 'idx_topic_assignment_review_requests_decision_key_unique' THEN
            RAISE EXCEPTION 'record_topic_assignment_review_decision: IDEMPOTENCY_KEY_REUSE -- decision_idempotency_key % already used on a different review_request', p_decision_idempotency_key;
          ELSE
            RAISE;
          END IF;
        END;

        INSERT INTO public.topic_assignment_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version, operation_digest)
        VALUES (p_review_request_id, 'rejected', v_caller_user_id, 'authenticated_reviewer', p_review_policy_version, v_decision_digest);

        RETURN jsonb_build_object('ok', true, 'outcome', 'rejected', 'review_request_id', p_review_request_id, 'resulting_decision_id', v_decision_id);
      END IF;
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.record_topic_assignment_review_decision(
      UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT
    ) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.record_topic_assignment_review_decision(
      UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT
    ) TO authenticated;

    RAISE NOTICE '078: record_topic_assignment_review_decision created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '078: record_topic_assignment_review_decision already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_topic_assignment_review_decision';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '078 drift: record_topic_assignment_review_decision structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '078 drift: record_topic_assignment_review_decision body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'authenticated')
       )
    THEN
      RAISE EXCEPTION '078 drift: record_topic_assignment_review_decision ACL does not match exactly (expected postgres+authenticated EXECUTE only)';
    END IF;

    RAISE NOTICE '078: record_topic_assignment_review_decision already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '078 fail-closed: record_topic_assignment_review_decision has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_rtard$;

-- ============================================================
-- 6. expire_stale_topic_assignment_review_requests
-- ============================================================

DO $migrate_estarr$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '57964e0dfea52dbe072e2b4f331cc8f2';
  v_expected_args CONSTANT text := 'p_batch_limit integer';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'expire_stale_topic_assignment_review_requests';

  IF v_name_count = 0 THEN
    RAISE NOTICE '078: expire_stale_topic_assignment_review_requests does not exist -- CREATE branch.';

    CREATE FUNCTION public.expire_stale_topic_assignment_review_requests(
      p_batch_limit INTEGER DEFAULT 100
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_batch_limit INTEGER;
      v_expired_ids UUID[];
      v_id UUID;
    BEGIN
      v_batch_limit := LEAST(GREATEST(coalesce(p_batch_limit, 100), 1), 500);

      -- Single UPDATE, no write-then-raise: a successful expire never throws,
      -- so there is nothing here that could roll back its own writes. Stable
      -- processing order (expires_at, id) and SKIP LOCKED so a concurrent
      -- decision/cancel/revoke on one of these rows is simply skipped this
      -- pass, not blocked or errored.
      WITH stale AS (
        SELECT id FROM public.topic_assignment_review_requests
        WHERE status = 'pending' AND expires_at <= statement_timestamp()
        ORDER BY expires_at ASC, id ASC
        LIMIT v_batch_limit
        FOR UPDATE SKIP LOCKED
      ),
      updated AS (
        UPDATE public.topic_assignment_review_requests r
        SET status = 'expired'
        FROM stale WHERE r.id = stale.id
        RETURNING r.id
      )
      SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_expired_ids FROM updated;

      FOREACH v_id IN ARRAY v_expired_ids LOOP
        INSERT INTO public.topic_assignment_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version, operation_digest)
        VALUES (v_id, 'expired', NULL, 'service_role_system', 1, NULL);
      END LOOP;

      RETURN jsonb_build_object('ok', true, 'expired_count', coalesce(array_length(v_expired_ids, 1), 0), 'expired_ids', to_jsonb(v_expired_ids));
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.expire_stale_topic_assignment_review_requests(INTEGER) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.expire_stale_topic_assignment_review_requests(INTEGER) TO service_role;

    RAISE NOTICE '078: expire_stale_topic_assignment_review_requests created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '078: expire_stale_topic_assignment_review_requests already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'expire_stale_topic_assignment_review_requests';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '078 drift: expire_stale_topic_assignment_review_requests structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '078 drift: expire_stale_topic_assignment_review_requests body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'service_role')
       )
    THEN
      RAISE EXCEPTION '078 drift: expire_stale_topic_assignment_review_requests ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '078: expire_stale_topic_assignment_review_requests already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '078 fail-closed: expire_stale_topic_assignment_review_requests has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_estarr$;

-- ============================================================
-- 7. cancel_topic_assignment_review_request
-- ============================================================

DO $migrate_ctarr$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '61a16967ee7a608c40516d5cd9c580d7';
  v_expected_args CONSTANT text := 'p_review_request_id uuid, p_cancelled_by_user_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'cancel_topic_assignment_review_request';

  IF v_name_count = 0 THEN
    RAISE NOTICE '078: cancel_topic_assignment_review_request does not exist -- CREATE branch.';

    CREATE FUNCTION public.cancel_topic_assignment_review_request(
      p_review_request_id UUID,
      p_cancelled_by_user_id UUID
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_request RECORD;
    BEGIN
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_review_request_id::text, 10));

      SELECT * INTO v_request FROM public.topic_assignment_review_requests WHERE id = p_review_request_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'cancel_topic_assignment_review_request: review_request % not found', p_review_request_id;
      END IF;

      IF v_request.status = 'cancelled' THEN
        RETURN jsonb_build_object('ok', true, 'outcome', 'replayed', 'review_request_id', p_review_request_id, 'status', 'cancelled');
      ELSIF v_request.status <> 'pending' THEN
        RAISE EXCEPTION 'cancel_topic_assignment_review_request: REVIEW_REQUEST_NOT_CANCELLABLE -- status=% is a different terminal/live state', v_request.status;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_cancelled_by_user_id) THEN
        RAISE EXCEPTION 'cancel_topic_assignment_review_request: cancelled_by_user_id % not found', p_cancelled_by_user_id;
      END IF;

      UPDATE public.topic_assignment_review_requests
      SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = p_cancelled_by_user_id
      WHERE id = p_review_request_id;

      INSERT INTO public.topic_assignment_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version, operation_digest)
      VALUES (p_review_request_id, 'cancelled', NULL, 'service_role_system', 1, NULL);

      RETURN jsonb_build_object('ok', true, 'outcome', 'cancelled', 'review_request_id', p_review_request_id, 'status', 'cancelled');
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.cancel_topic_assignment_review_request(UUID, UUID) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.cancel_topic_assignment_review_request(UUID, UUID) TO service_role;

    RAISE NOTICE '078: cancel_topic_assignment_review_request created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '078: cancel_topic_assignment_review_request already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'cancel_topic_assignment_review_request';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '078 drift: cancel_topic_assignment_review_request structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '078 drift: cancel_topic_assignment_review_request body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'service_role')
       )
    THEN
      RAISE EXCEPTION '078 drift: cancel_topic_assignment_review_request ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '078: cancel_topic_assignment_review_request already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '078 fail-closed: cancel_topic_assignment_review_request has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_ctarr$;

-- ============================================================
-- 8. revoke_topic_assignment_review_approval
-- ============================================================

DO $migrate_rtara$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'bbb9214c179ea55e854dea098c06fdb0';
  v_expected_args CONSTANT text := 'p_review_request_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'revoke_topic_assignment_review_approval';

  IF v_name_count = 0 THEN
    RAISE NOTICE '078: revoke_topic_assignment_review_approval does not exist -- CREATE branch.';

    CREATE FUNCTION public.revoke_topic_assignment_review_approval(
      p_review_request_id UUID
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_caller_user_id UUID;
      v_request RECORD;
    BEGIN
      v_caller_user_id := auth.uid();
      IF v_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'revoke_topic_assignment_review_approval: authentication required';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.semantic_topic_reviewers WHERE user_id = v_caller_user_id AND active IS TRUE) THEN
        RAISE EXCEPTION 'revoke_topic_assignment_review_approval: caller is not an active reviewer';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_review_request_id::text, 10));

      SELECT * INTO v_request FROM public.topic_assignment_review_requests WHERE id = p_review_request_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'revoke_topic_assignment_review_approval: review_request % not found', p_review_request_id;
      END IF;

      IF v_request.status = 'revoked' THEN
        RETURN jsonb_build_object('ok', true, 'outcome', 'replayed', 'review_request_id', p_review_request_id, 'status', 'revoked');
      ELSIF v_request.status <> 'approved' THEN
        RAISE EXCEPTION 'revoke_topic_assignment_review_approval: REVIEW_APPROVAL_NOT_REVOCABLE -- status=% (only an approved, not-yet-executed request can be revoked)', v_request.status;
      END IF;

      UPDATE public.topic_assignment_review_requests
      SET status = 'revoked', revoked_at = now(), revoked_by_user_id = v_caller_user_id
      WHERE id = p_review_request_id;

      INSERT INTO public.topic_assignment_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version, operation_digest)
      VALUES (p_review_request_id, 'revoked', v_caller_user_id, 'authenticated_reviewer', 1, NULL);

      RETURN jsonb_build_object('ok', true, 'outcome', 'revoked', 'review_request_id', p_review_request_id, 'status', 'revoked');
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.revoke_topic_assignment_review_approval(UUID) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.revoke_topic_assignment_review_approval(UUID) TO authenticated;

    RAISE NOTICE '078: revoke_topic_assignment_review_approval created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '078: revoke_topic_assignment_review_approval already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'revoke_topic_assignment_review_approval';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '078 drift: revoke_topic_assignment_review_approval structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '078 drift: revoke_topic_assignment_review_approval body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'authenticated')
       )
    THEN
      RAISE EXCEPTION '078 drift: revoke_topic_assignment_review_approval ACL does not match exactly (expected postgres+authenticated EXECUTE only)';
    END IF;

    RAISE NOTICE '078: revoke_topic_assignment_review_approval already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '078 fail-closed: revoke_topic_assignment_review_approval has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_rtara$;

-- ============================================================
-- 9. execute_approved_topic_assignment_review
-- ============================================================

DO $migrate_eatar$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '5fce42a55012f6f8c6f6767baac48a68';
  v_expected_args CONSTANT text := 'p_review_request_id uuid, p_idempotency_key text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'execute_approved_topic_assignment_review';

  IF v_name_count = 0 THEN
    RAISE NOTICE '078: execute_approved_topic_assignment_review does not exist -- CREATE branch.';

    CREATE FUNCTION public.execute_approved_topic_assignment_review(
      p_review_request_id UUID,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_request_domain CONSTANT TEXT := 'willviral.semantic-topic.review-request:v1';
      v_decision_domain CONSTANT TEXT := 'willviral.semantic-topic.review-decision:v1';
      v_execution_domain CONSTANT TEXT := 'willviral.semantic-topic.review-execution:v1';
      v_supported_policy_version CONSTANT INTEGER := 1;
      v_algorithm_version CONSTANT INTEGER := 2;
      v_decision_reason CONSTANT TEXT := 'human_review_approved';
      v_assignment_reason CONSTANT TEXT := 'manual_review_confirmed';
      v_extraction_run_id UUID;
      v_evidence_id UUID;
      v_request RECORD;
      v_extraction RECORD;
      v_topic RECORD;
      v_recomputed_payload_digest TEXT;
      v_recomputed_approval_digest TEXT;
      v_execution_digest TEXT;
      v_confidence NUMERIC;
      v_topic_id UUID;
      v_membership_id UUID;
      v_decision_id UUID;
      v_decision_digest TEXT;
      v_active_count INTEGER;
      v_creation_request_digest TEXT;
      v_constraint_name TEXT;
    BEGIN
      SELECT extraction_run_id INTO v_extraction_run_id FROM public.topic_assignment_review_requests WHERE id = p_review_request_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: review_request % not found', p_review_request_id;
      END IF;
      SELECT signal_evidence_id INTO v_evidence_id FROM public.topic_extraction_runs WHERE id = v_extraction_run_id;

      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_evidence_id::text, 0));
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_review_request_id::text, 10));

      SELECT * INTO v_request FROM public.topic_assignment_review_requests WHERE id = p_review_request_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: review_request % not found (post-lock)', p_review_request_id;
      END IF;

      -- Replay / already-executed / not-executable dispatch.
      IF v_request.status = 'executed' THEN
        IF v_request.execution_idempotency_key = p_idempotency_key THEN
          v_execution_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
            format(
              '{"domain":%s,"review_request_id":%s,"execution_idempotency_key":%s,"request_payload_digest":%s,"approval_digest":%s,"proposed_outcome":%s,"target_semantic_topic_id":%s,"execution_policy_version":%s}',
              to_json(v_execution_domain)::text, to_json(p_review_request_id::text)::text, to_json(p_idempotency_key)::text,
              to_json(v_request.request_payload_digest)::text, to_json(v_request.approval_digest)::text, to_json(v_request.proposed_outcome)::text,
              coalesce(to_json(v_request.target_semantic_topic_id::text)::text, 'null'), to_json(v_supported_policy_version)::text
            ), 'UTF8')), 'hex');
          IF v_execution_digest = v_request.execution_operation_digest THEN
            RETURN jsonb_build_object(
              'ok', true, 'outcome', 'replayed', 'review_request_id', p_review_request_id,
              'resulting_decision_id', v_request.resulting_decision_id
            );
          ELSE
            RAISE EXCEPTION 'execute_approved_topic_assignment_review: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used with a different execution', p_idempotency_key;
          END IF;
        ELSE
          RAISE EXCEPTION 'execute_approved_topic_assignment_review: ALREADY_EXECUTED -- review_request % already executed', p_review_request_id;
        END IF;
      ELSIF v_request.status <> 'approved' THEN
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: REVIEW_REQUEST_NOT_EXECUTABLE -- status=%', v_request.status;
      END IF;

      IF EXISTS (SELECT 1 FROM public.topic_assignment_decisions WHERE extraction_run_id = v_extraction_run_id) THEN
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: extraction_run % already has a topic_assignment_decisions row', v_extraction_run_id;
      END IF;

      SELECT * INTO v_extraction FROM public.topic_extraction_runs WHERE id = v_extraction_run_id;
      IF v_extraction.status <> 'completed' THEN
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: extraction_run % is no longer completed (status=%)', v_extraction_run_id, v_extraction.status;
      END IF;

      -- Recompute request_payload_digest fresh from the CURRENT extraction row
      -- and compare -- proves the immutable extraction content the approval
      -- was based on has not drifted (defense in depth; extraction rows are
      -- immutable by design, but this is an explicit structural proof, not an
      -- assumption).
      v_recomputed_payload_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"domain":%s,"extraction_run_id":%s,"output_digest":%s,"confidence":%s,"specificity":%s}',
          to_json(v_request_domain)::text, to_json(v_extraction_run_id::text)::text, to_json(v_extraction.output_digest)::text,
          (((v_extraction.structured_output->>'confidence')::numeric)::numeric(5,4))::text,
          to_json(v_extraction.structured_output->>'specificity')::text
        ), 'UTF8')), 'hex');
      IF v_recomputed_payload_digest <> v_request.request_payload_digest THEN
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: request_payload_digest drift detected for review_request %', p_review_request_id;
      END IF;

      -- Recompute approval_digest fresh from the row's CURRENT stored judgment
      -- fields and compare to what was stored at approval time -- proves no
      -- tampering/drift between approval and execution.
      v_recomputed_approval_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"domain":%s,"review_request_id":%s,"generation":%s,"extraction_run_id":%s,"request_payload_digest":%s,"reviewer_user_id":%s,"reviewer_role_snapshot":%s,"review_policy_version":%s,"canonical_topic_label":%s,"topic_definition":%s,"scope":%s,"inclusion_criteria":%s,"exclusion_criteria":%s,"lane_neutral_confirmed":%s,"evidence_adequacy":%s,"duplicate_search_outcome":%s,"proposed_outcome":%s,"target_semantic_topic_id":%s,"uncertainty_classification":%s,"reviewer_rationale":%s}',
          to_json(v_decision_domain)::text, to_json(p_review_request_id::text)::text, to_json(v_request.generation)::text, to_json(v_extraction_run_id::text)::text, to_json(v_request.request_payload_digest)::text,
          to_json(v_request.reviewer_user_id::text)::text, to_json(v_request.reviewer_role_snapshot)::text, to_json(v_request.review_policy_version)::text,
          to_json(v_request.canonical_topic_label)::text, to_json(v_request.topic_definition)::text, to_json(v_request.scope)::text,
          to_json(v_request.inclusion_criteria)::text, to_json(v_request.exclusion_criteria)::text, to_json(v_request.lane_neutral_confirmed)::text,
          to_json(v_request.evidence_adequacy)::text, to_json(v_request.duplicate_search_outcome)::text, to_json(v_request.proposed_outcome)::text,
          coalesce(to_json(v_request.target_semantic_topic_id::text)::text, 'null'), to_json(v_request.uncertainty_classification)::text, to_json(v_request.reviewer_rationale)::text
        ), 'UTF8')), 'hex');
      IF v_recomputed_approval_digest <> v_request.approval_digest THEN
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: approval_digest drift detected for review_request %', p_review_request_id;
      END IF;

      IF v_request.review_policy_version <> v_supported_policy_version OR v_request.approval_digest_version <> v_supported_policy_version THEN
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: unsupported review_policy_version/approval_digest_version for review_request %', p_review_request_id;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM public.semantic_topic_reviewers WHERE user_id = v_request.reviewer_user_id AND active IS TRUE) THEN
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: reviewer for review_request % is no longer active', p_review_request_id;
      END IF;

      v_confidence := (v_extraction.structured_output->>'confidence')::numeric;

      IF v_request.proposed_outcome = 'CREATE_NEW' THEN
        v_creation_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          p_review_request_id::text || chr(31) || 'human_review_topic_creation_seed', 'UTF8')), 'hex');

        INSERT INTO public.semantic_topics (canonical_label, label_language, specificity, creation_request_digest)
        VALUES (v_request.canonical_topic_label, v_extraction.structured_output->>'label_language', v_extraction.structured_output->>'specificity', v_creation_request_digest)
        RETURNING id INTO v_topic_id;

        INSERT INTO public.semantic_topic_membership (semantic_topic_id, signal_evidence_id, assignment_reason, confidence, algorithm_version)
        VALUES (v_topic_id, v_evidence_id, v_assignment_reason, v_confidence, v_algorithm_version)
        RETURNING id INTO v_membership_id;

      ELSIF v_request.proposed_outcome = 'ATTACH_EXISTING' THEN
        SELECT * INTO v_topic FROM public.semantic_topics WHERE id = v_request.target_semantic_topic_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'execute_approved_topic_assignment_review: target semantic_topic % not found', v_request.target_semantic_topic_id;
        END IF;
        -- A human explicitly selected this exact target during review -- that
        -- IS the manual confirmation, so (unlike the automated 074 path)
        -- 'ambiguous' does not additionally block a human-reviewed attach;
        -- only the genuinely non-attachable states do.
        IF v_topic.lifecycle_status IN ('split_required', 'merge_candidate', 'superseded', 'archived') THEN
          RAISE EXCEPTION 'execute_approved_topic_assignment_review: target topic lifecycle_status=% no longer accepts ATTACH_EXISTING', v_topic.lifecycle_status;
        END IF;

        INSERT INTO public.semantic_topic_membership (semantic_topic_id, signal_evidence_id, assignment_reason, confidence, algorithm_version)
        VALUES (v_request.target_semantic_topic_id, v_evidence_id, v_assignment_reason, v_confidence, v_algorithm_version)
        RETURNING id INTO v_membership_id;

        v_topic_id := v_request.target_semantic_topic_id;

        IF v_topic.lifecycle_status = 'candidate_singleton' THEN
          SELECT count(*) INTO v_active_count FROM public.semantic_topic_membership
            WHERE semantic_topic_id = v_request.target_semantic_topic_id AND valid_to IS NULL;
          IF v_active_count >= 2 THEN
            UPDATE public.semantic_topics SET lifecycle_status = 'corroborating', status_version = status_version + 1, updated_at = now()
              WHERE id = v_request.target_semantic_topic_id;
          END IF;
        END IF;
      ELSE
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: unexpected proposed_outcome % on an approved request', v_request.proposed_outcome;
      END IF;

      -- Same canonical decision_digest FORM as 074's own RPC, for
      -- table-wide self-consistency of topic_assignment_decisions.decision_digest.
      v_decision_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"extraction_run_id":%s,"outcome":%s,"decision_reason":%s,"deterministic_signals":{},"existing_semantic_topic_id":%s,"idempotency_key":%s}',
          to_json(v_extraction_run_id::text)::text, to_json(v_request.proposed_outcome)::text, to_json(v_decision_reason)::text,
          CASE WHEN v_request.proposed_outcome = 'ATTACH_EXISTING' THEN to_json(v_request.target_semantic_topic_id::text)::text ELSE 'null' END,
          to_json(p_idempotency_key)::text
        ), 'UTF8')), 'hex');

      INSERT INTO public.topic_assignment_decisions (
        extraction_run_id, signal_evidence_id, outcome, semantic_topic_id, resulting_membership_id,
        decision_reason, deterministic_signals, model_confidence, decision_digest, idempotency_key
      ) VALUES (
        v_extraction_run_id, v_evidence_id, v_request.proposed_outcome, v_topic_id, v_membership_id,
        v_decision_reason, '{}'::jsonb, v_confidence, v_decision_digest, p_idempotency_key
      ) RETURNING id INTO v_decision_id;

      INSERT INTO public.semantic_topic_membership_events (
        semantic_topic_id, signal_evidence_id, related_membership_id, event_type, related_assignment_decision_id, event_reason
      ) VALUES (
        v_topic_id, v_evidence_id, v_membership_id, 'attached', v_decision_id, v_assignment_reason
      );

      v_execution_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"domain":%s,"review_request_id":%s,"execution_idempotency_key":%s,"request_payload_digest":%s,"approval_digest":%s,"proposed_outcome":%s,"target_semantic_topic_id":%s,"execution_policy_version":%s}',
          to_json(v_execution_domain)::text, to_json(p_review_request_id::text)::text, to_json(p_idempotency_key)::text,
          to_json(v_request.request_payload_digest)::text, to_json(v_request.approval_digest)::text, to_json(v_request.proposed_outcome)::text,
          coalesce(to_json(v_request.target_semantic_topic_id::text)::text, 'null'), to_json(v_supported_policy_version)::text
        ), 'UTF8')), 'hex');

      BEGIN
        UPDATE public.topic_assignment_review_requests SET
          status = 'executed', executed_at = now(), resulting_decision_id = v_decision_id,
          execution_idempotency_key = p_idempotency_key, execution_operation_digest = v_execution_digest
        WHERE id = p_review_request_id;
      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
        IF v_constraint_name = 'idx_topic_assignment_review_requests_execution_key_unique' THEN
          RAISE EXCEPTION 'execute_approved_topic_assignment_review: IDEMPOTENCY_KEY_REUSE -- idempotency_key % already used on a different review_request', p_idempotency_key;
        ELSE
          RAISE;
        END IF;
      END;

      INSERT INTO public.topic_assignment_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version, operation_digest)
      VALUES (p_review_request_id, 'executed', NULL, 'service_role_system', v_supported_policy_version, v_execution_digest);

      RETURN jsonb_build_object(
        'ok', true, 'outcome', 'executed', 'review_request_id', p_review_request_id, 'proposed_outcome', v_request.proposed_outcome,
        'semantic_topic_id', v_topic_id, 'resulting_membership_id', v_membership_id, 'resulting_decision_id', v_decision_id
      );
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.execute_approved_topic_assignment_review(UUID, TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.execute_approved_topic_assignment_review(UUID, TEXT) TO service_role;

    RAISE NOTICE '078: execute_approved_topic_assignment_review created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '078: execute_approved_topic_assignment_review already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'execute_approved_topic_assignment_review';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS TRUE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '078 drift: execute_approved_topic_assignment_review structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '078 drift: execute_approved_topic_assignment_review body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) acl JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'service_role')
       )
    THEN
      RAISE EXCEPTION '078 drift: execute_approved_topic_assignment_review ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '078: execute_approved_topic_assignment_review already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '078 fail-closed: execute_approved_topic_assignment_review has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_eatar$;

-- ============================================================
-- 10. Fail-fast vegallapot onellenorzes -- a MEGLEVO
--     record_topic_assignment_decision fuggveny torzse/szignaturaja/
--     grantja bizonyithatoan VALTOZATLAN maradt ebben a migracioban.
-- ============================================================

DO $final_selfcheck$
DECLARE
  v_hash text;
  v_expected_hash CONSTANT text := '759de5ab474c9a7aa105564ca95541cc';
  v_expected_args CONSTANT text := 'p_extraction_run_id uuid, p_outcome text, p_decision_reason text, p_deterministic_signals jsonb, p_idempotency_key text, p_existing_semantic_topic_id uuid';
  v_actual_args text;
BEGIN
  SELECT md5(replace(prosrc, E'\r\n', E'\n')), pg_get_function_identity_arguments(oid)
    INTO v_hash, v_actual_args
  FROM pg_proc WHERE oid = 'public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)'::regprocedure;

  IF v_hash <> v_expected_hash THEN
    RAISE EXCEPTION '078 CRITICAL: record_topic_assignment_decision body hash changed (got %, expected %) -- this migration must NEVER touch this function. Aborting.', v_hash, v_expected_hash;
  END IF;
  IF v_actual_args <> v_expected_args THEN
    RAISE EXCEPTION '078 CRITICAL: record_topic_assignment_decision signature changed (got %, expected %) -- this migration must NEVER touch this function. Aborting.', v_actual_args, v_expected_args;
  END IF;

  RAISE NOTICE '078: final self-check passed -- record_topic_assignment_decision body/signature confirmed unchanged.';
END;
$final_selfcheck$;

NOTIFY pgrst, 'reload schema';

COMMIT;
