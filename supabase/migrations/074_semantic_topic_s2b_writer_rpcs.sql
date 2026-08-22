-- ============================================================
-- Migration 074: Semantic Topic Identity v0 -- S2B writer RPCs
--
-- Kanonikus szerzodes: docs/architecture/semantic-topic-identity-v0-contract.md
-- SS23+ (S2B). Az itt implementalt confidence-kuszob es lifecycle-atmenet
-- szabaly egy kulon, explicit jovahagyott design-closure korben szuletett
-- ("PFM Semantic Topic Identity v0 -- S2B Local Design Closure").
--
-- HATOKOR: pontosan ket SECURITY DEFINER writer RPC --
--   public.record_topic_extraction_run(...)
--   public.record_topic_assignment_decision(...)
-- Nincs alkalmazaskod, nincs API route, nincs provider/quota-integracio,
-- nincs AI-hivas, nincs uj tabla, nincs ALTER a 001-073 migraciokon.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. GLOBALIS RPC-TOPOLOGIAI KAPU
-- ============================================================

DO $topology_gate$
DECLARE
  v_present_count int;
BEGIN
  SELECT count(*) INTO v_present_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('record_topic_extraction_run', 'record_topic_assignment_decision');

  IF v_present_count NOT IN (0, 2) THEN
    RAISE EXCEPTION '074 fail-closed: partial topology detected -- % of 2 S2B writer RPCs exist. No DDL will run. Manual investigation required before this migration can proceed.', v_present_count;
  END IF;

  RAISE NOTICE '074: global RPC topology gate passed (% of 2 present).', v_present_count;
END;
$topology_gate$;

-- ============================================================
-- 1. record_topic_extraction_run
-- ============================================================

DO $migrate_rter$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'f6ed6773724c95c2deccc2f7ca692e89';
  v_expected_args CONSTANT text := 'p_signal_evidence_id uuid, p_normalization_version integer, p_extraction_method text, p_provider text, p_model text, p_prompt_version text, p_deterministic_extractor_version integer, p_normalized_extraction_input text, p_extraction_schema_version integer, p_status text, p_structured_output jsonb, p_input_tokens integer, p_output_tokens integer, p_estimated_cost_usd numeric, p_error_class text, p_idempotency_key text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_topic_extraction_run';

  IF v_name_count = 0 THEN
    RAISE NOTICE '074: record_topic_extraction_run does not exist -- CREATE branch.';

    CREATE FUNCTION public.record_topic_extraction_run(
      p_signal_evidence_id UUID,
      p_normalization_version INTEGER,
      p_extraction_method TEXT,
      p_provider TEXT,
      p_model TEXT,
      p_prompt_version TEXT,
      p_deterministic_extractor_version INTEGER,
      p_normalized_extraction_input TEXT,
      p_extraction_schema_version INTEGER,
      p_status TEXT,
      p_structured_output JSONB,
      p_input_tokens INTEGER,
      p_output_tokens INTEGER,
      p_estimated_cost_usd NUMERIC,
      p_error_class TEXT,
      p_idempotency_key TEXT,
      p_started_at TIMESTAMPTZ,
      p_completed_at TIMESTAMPTZ
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_evidence RECORD;
      v_source RECORD;
      v_source_snapshot_text TEXT;
      v_source_snapshot JSONB;
      v_source_snapshot_digest TEXT;
      v_normalized_input_digest TEXT;
      v_extraction_config_text TEXT;
      v_extraction_config_digest TEXT;
      v_output_digest TEXT;
      v_confidence NUMERIC(5,4);
      v_new_id UUID;
      v_existing RECORD;
      v_cache RECORD;
      v_constraint_name TEXT;
      v_request_digest TEXT;
      v_existing_request_digest TEXT;
    BEGIN
      IF p_status NOT IN ('completed', 'failed') THEN
        RAISE EXCEPTION 'record_topic_extraction_run: p_status must be completed or failed (got %)', p_status;
      END IF;

      -- Re-read evidence + source from the DB -- never trust a client snapshot.
      SELECT * INTO v_evidence FROM public.signal_evidence WHERE id = p_signal_evidence_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'record_topic_extraction_run: signal_evidence % not found', p_signal_evidence_id;
      END IF;
      SELECT * INTO v_source FROM public.signal_sources WHERE id = v_evidence.signal_source_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'record_topic_extraction_run: signal_sources % not found for evidence %', v_evidence.signal_source_id, p_signal_evidence_id;
      END IF;

      -- Canonical source_snapshot -- fixed field order, server-built only.
      -- Every field is wrapped in coalesce(...::text, 'null') because
      -- to_json(NULL) returns SQL NULL (not the JSON literal "null"),
      -- which format() would otherwise substitute as an empty string and
      -- produce invalid JSON for any nullable evidence/source column.
      v_source_snapshot_text := format(
        '{"evidence_id":%s,"evidence_type":%s,"external_ref":%s,"title":%s,"snippet":%s,"published_at":%s,"canonical_url":%s,"first_seen_at":%s,"signal_source_id":%s,"source_type":%s,"source_external_id":%s,"source_family_key":%s}',
        coalesce(to_json(v_evidence.id::text)::text, 'null'), coalesce(to_json(v_evidence.evidence_type)::text, 'null'), coalesce(to_json(v_evidence.external_ref)::text, 'null'),
        coalesce(to_json(v_evidence.title)::text, 'null'), coalesce(to_json(v_evidence.snippet)::text, 'null'), coalesce(to_json(v_evidence.published_at::text)::text, 'null'),
        coalesce(to_json(v_evidence.canonical_url)::text, 'null'), coalesce(to_json(v_evidence.first_seen_at::text)::text, 'null'), coalesce(to_json(v_evidence.signal_source_id::text)::text, 'null'),
        coalesce(to_json(v_source.source_type)::text, 'null'), coalesce(to_json(v_source.external_id)::text, 'null'), coalesce(to_json(v_source.source_family_key)::text, 'null')
      );
      v_source_snapshot := v_source_snapshot_text::jsonb;
      v_source_snapshot_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(v_source_snapshot_text, 'UTF8')), 'hex');

      -- normalized_input_digest -- always server-recomputed, never trusted from client.
      v_normalized_input_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(p_normalized_extraction_input, 'UTF8')), 'hex');

      -- extraction_config_digest -- fixed field order per contract SS15.
      v_extraction_config_text := format(
        '{"extraction_method":%s,"normalization_version":%s,"extraction_schema_version":%s,"provider":%s,"model":%s,"prompt_version":%s,"deterministic_extractor_version":%s}',
        coalesce(to_json(p_extraction_method)::text, 'null'), coalesce(to_json(p_normalization_version)::text, 'null'), coalesce(to_json(p_extraction_schema_version)::text, 'null'),
        coalesce(to_json(p_provider)::text, 'null'), coalesce(to_json(p_model)::text, 'null'), coalesce(to_json(p_prompt_version)::text, 'null'), coalesce(to_json(p_deterministic_extractor_version)::text, 'null')
      );
      v_extraction_config_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(v_extraction_config_text, 'UTF8')), 'hex');

      IF p_status = 'completed' THEN
        IF p_structured_output IS NULL THEN
          RAISE EXCEPTION 'record_topic_extraction_run: structured_output is required when status=completed';
        END IF;
        -- output_digest canonicalization contract (topic_extraction_output_v1,
        -- canonicalization schema version 1) -- explicit fixed field order and
        -- names, never Postgres's own internal jsonb::text serialization
        -- order (documented behavior, not a guaranteed public API -- same
        -- reasoning the Shadow Topic v0 contract already applies to
        -- input_digest, see docs/architecture/shadow-topic-v0-contract.md SS6).
        -- Field order: extraction_schema_version, canonical_phenomenon_label,
        -- label_language, subject_entities, action_or_event, location,
        -- temporal_context, specificity, content_format, confidence,
        -- supporting_spans. Strings via to_json() (proper JSON escaping of
        -- quotes/backslashes/control chars/Unicode). Nullable string fields:
        -- SQL NULL -> JSON null literal. confidence: cast to NUMERIC(5,4)
        -- then ::text, so 0.85 and 0.8500 always canonicalize identically to
        -- "0.8500" (exactly 4 decimal places, fixed-point, never scientific
        -- notation). subject_entities: array order preserved (semantic
        -- order, not sorted), each element via its own jsonb ::text (already
        -- JSON-typed, so no double-encoding). supporting_spans: array order
        -- preserved (semantic citation order), each span object rebuilt in
        -- a fixed {source_field, quoted_text} field order regardless of the
        -- original object's key order -- WITH ORDINALITY guarantees the
        -- aggregation preserves each array's original element order (plain
        -- string_agg without an explicit ORDER BY does not guarantee that).
        v_output_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          format(
            '{"extraction_schema_version":%s,"canonical_phenomenon_label":%s,"label_language":%s,"subject_entities":[%s],"action_or_event":%s,"location":%s,"temporal_context":%s,"specificity":%s,"content_format":%s,"confidence":%s,"supporting_spans":[%s]}',
            to_json((p_structured_output->>'extraction_schema_version')::int)::text,
            to_json(p_structured_output->>'canonical_phenomenon_label')::text,
            to_json(p_structured_output->>'label_language')::text,
            coalesce((SELECT string_agg(elem::text, ',' ORDER BY ord) FROM jsonb_array_elements(p_structured_output->'subject_entities') WITH ORDINALITY AS t(elem, ord)), ''),
            coalesce(to_json(p_structured_output->>'action_or_event')::text, 'null'),
            coalesce(to_json(p_structured_output->>'location')::text, 'null'),
            coalesce(to_json(p_structured_output->>'temporal_context')::text, 'null'),
            to_json(p_structured_output->>'specificity')::text,
            to_json(p_structured_output->>'content_format')::text,
            (((p_structured_output->>'confidence')::numeric)::numeric(5,4))::text,
            coalesce((SELECT string_agg(format('{"source_field":%s,"quoted_text":%s}', to_json(elem->>'source_field')::text, to_json(elem->>'quoted_text')::text), ',' ORDER BY ord)
                      FROM jsonb_array_elements(p_structured_output->'supporting_spans') WITH ORDINALITY AS t(elem, ord)), '')
          ), 'UTF8')), 'hex');
        v_confidence := (p_structured_output->>'confidence')::numeric;
      ELSE
        IF p_structured_output IS NOT NULL THEN
          RAISE EXCEPTION 'record_topic_extraction_run: structured_output must be NULL when status=failed';
        END IF;
        v_output_digest := NULL;
        v_confidence := NULL;
      END IF;

      -- Whole-request digest, used only for in-memory idempotency-key
      -- replay-vs-mismatch comparison -- not a stored column. Explicit
      -- JSON-object canonical form (fixed field order/names, to_json()
      -- string escaping, SQL NULL -> JSON null) -- not a chr(31)-delimited
      -- concatenation, which a free-text field (provider/model/
      -- prompt_version/error_class are caller-supplied for ai_assisted
      -- extractions) could contain literally, shifting field boundaries
      -- and colliding two genuinely different requests onto one digest.
      v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"signal_evidence_id":%s,"normalization_version":%s,"extraction_method":%s,"provider":%s,"model":%s,"prompt_version":%s,"deterministic_extractor_version":%s,"normalized_input_digest":%s,"extraction_config_digest":%s,"extraction_schema_version":%s,"status":%s,"output_digest":%s,"error_class":%s}',
          to_json(p_signal_evidence_id::text)::text, to_json(p_normalization_version)::text, to_json(p_extraction_method)::text,
          coalesce(to_json(p_provider)::text, 'null'), coalesce(to_json(p_model)::text, 'null'), coalesce(to_json(p_prompt_version)::text, 'null'),
          coalesce(to_json(p_deterministic_extractor_version)::text, 'null'), to_json(v_normalized_input_digest)::text, to_json(v_extraction_config_digest)::text,
          to_json(p_extraction_schema_version)::text, to_json(p_status)::text, coalesce(to_json(v_output_digest)::text, 'null'), coalesce(to_json(p_error_class)::text, 'null')
        ), 'UTF8')), 'hex');

      BEGIN
        INSERT INTO public.topic_extraction_runs (
          signal_evidence_id, normalization_version, extraction_method, provider, model, prompt_version,
          deterministic_extractor_version, source_snapshot, source_snapshot_digest, normalized_extraction_input,
          normalized_input_digest, extraction_config_digest, extraction_schema_version, structured_output,
          output_digest, status, confidence, input_tokens, output_tokens, estimated_cost_usd, error_class,
          idempotency_key, started_at, completed_at
        ) VALUES (
          p_signal_evidence_id, p_normalization_version, p_extraction_method, p_provider, p_model, p_prompt_version,
          p_deterministic_extractor_version, v_source_snapshot, v_source_snapshot_digest, p_normalized_extraction_input,
          v_normalized_input_digest, v_extraction_config_digest, p_extraction_schema_version, p_structured_output,
          v_output_digest, p_status, v_confidence, p_input_tokens, p_output_tokens, p_estimated_cost_usd, p_error_class,
          p_idempotency_key, p_started_at, p_completed_at
        )
        RETURNING id INTO v_new_id;

        RETURN jsonb_build_object(
          'ok', true, 'outcome', 'created', 'extraction_run_id', v_new_id, 'status', p_status,
          'idempotency_key', p_idempotency_key
        );

      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;

        IF v_constraint_name = 'topic_extraction_runs_idempotency_key_key' THEN
          SELECT * INTO v_existing FROM public.topic_extraction_runs WHERE idempotency_key = p_idempotency_key;
          -- Same explicit JSON-object canonical form as v_request_digest
          -- above, rebuilt from the stored row's columns instead of the
          -- current call's parameters.
          v_existing_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
            format(
              '{"signal_evidence_id":%s,"normalization_version":%s,"extraction_method":%s,"provider":%s,"model":%s,"prompt_version":%s,"deterministic_extractor_version":%s,"normalized_input_digest":%s,"extraction_config_digest":%s,"extraction_schema_version":%s,"status":%s,"output_digest":%s,"error_class":%s}',
              to_json(v_existing.signal_evidence_id::text)::text, to_json(v_existing.normalization_version)::text, to_json(v_existing.extraction_method)::text,
              coalesce(to_json(v_existing.provider)::text, 'null'), coalesce(to_json(v_existing.model)::text, 'null'), coalesce(to_json(v_existing.prompt_version)::text, 'null'),
              coalesce(to_json(v_existing.deterministic_extractor_version)::text, 'null'), to_json(v_existing.normalized_input_digest)::text, to_json(v_existing.extraction_config_digest)::text,
              to_json(v_existing.extraction_schema_version)::text, to_json(v_existing.status)::text, coalesce(to_json(v_existing.output_digest)::text, 'null'), coalesce(to_json(v_existing.error_class)::text, 'null')
            ), 'UTF8')), 'hex');

          IF v_existing_request_digest = v_request_digest THEN
            RETURN jsonb_build_object(
              'ok', true, 'outcome', 'replayed', 'extraction_run_id', v_existing.id, 'status', v_existing.status,
              'idempotency_key', v_existing.idempotency_key
            );
          ELSE
            RAISE EXCEPTION 'record_topic_extraction_run: idempotency_key % already used with a different request', p_idempotency_key;
          END IF;

        ELSIF v_constraint_name = 'topic_extraction_runs_completed_cache_key' THEN
          -- Same (evidence, normalized_input_digest, extraction_config_digest)
          -- already has a completed result under a different idempotency_key --
          -- return it directly instead of surfacing a raw constraint violation.
          SELECT * INTO v_cache FROM public.topic_extraction_runs
            WHERE signal_evidence_id = p_signal_evidence_id AND normalized_input_digest = v_normalized_input_digest
              AND extraction_config_digest = v_extraction_config_digest AND status = 'completed';
          RETURN jsonb_build_object(
            'ok', true, 'outcome', 'cache_hit', 'extraction_run_id', v_cache.id, 'status', v_cache.status,
            'idempotency_key', v_cache.idempotency_key
          );
        ELSE
          RAISE;
        END IF;
      END;
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.record_topic_extraction_run(
      UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER, TEXT, JSONB, INTEGER, INTEGER, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.record_topic_extraction_run(
      UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER, TEXT, JSONB, INTEGER, INTEGER, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
    ) TO service_role;

    RAISE NOTICE '074: record_topic_extraction_run created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '074: record_topic_extraction_run already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_topic_extraction_run';

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
      RAISE EXCEPTION '074 drift: record_topic_extraction_run structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '074 drift: record_topic_extraction_run body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '074 drift: record_topic_extraction_run ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '074: record_topic_extraction_run already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '074 fail-closed: record_topic_extraction_run has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_rter$;

-- ============================================================
-- 2. record_topic_assignment_decision
-- ============================================================

DO $migrate_rtad$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '759de5ab474c9a7aa105564ca95541cc';
  v_expected_args CONSTANT text := 'p_extraction_run_id uuid, p_outcome text, p_decision_reason text, p_deterministic_signals jsonb, p_idempotency_key text, p_existing_semantic_topic_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_topic_assignment_decision';

  IF v_name_count = 0 THEN
    RAISE NOTICE '074: record_topic_assignment_decision does not exist -- CREATE branch.';

    CREATE FUNCTION public.record_topic_assignment_decision(
      p_extraction_run_id UUID,
      p_outcome TEXT,
      p_decision_reason TEXT,
      p_deterministic_signals JSONB,
      p_idempotency_key TEXT,
      p_existing_semantic_topic_id UUID
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      -- S2B v0 design-closure constants (see contract SS23) -- not
      -- invented here, pinned by an explicit, separately-approved decision.
      v_min_confidence CONSTANT NUMERIC(5,4) := 0.8500;
      v_algorithm_version CONSTANT INTEGER := 1;
      v_extraction RECORD;
      v_evidence_id UUID;
      v_deterministic_signals JSONB;
      v_deterministic_signals_canonical TEXT;
      v_decision_digest TEXT;
      v_existing RECORD;
      v_specificity TEXT;
      -- Deliberately unconstrained precision -- a NUMERIC(5,4) variable
      -- would round 0.849999 up to 0.8500 on assignment, silently passing
      -- the threshold check it should fail. The full-precision value is
      -- compared against v_min_confidence below; only the later INSERTs
      -- (into real NUMERIC(5,4) columns) round it, after the comparison
      -- already happened correctly.
      v_confidence NUMERIC;
      v_canonical_label TEXT;
      v_label_language TEXT;
      v_assignment_reason TEXT;
      v_topic RECORD;
      v_topic_id UUID;
      v_membership_id UUID;
      v_decision_id UUID;
      v_active_count INTEGER;
      v_creation_request_digest TEXT;
    BEGIN
      IF p_outcome NOT IN ('CREATE_NEW', 'ATTACH_EXISTING', 'QUARANTINE') THEN
        RAISE EXCEPTION 'record_topic_assignment_decision: p_outcome must be CREATE_NEW, ATTACH_EXISTING or QUARANTINE (got %)', p_outcome;
      END IF;

      SELECT * INTO v_extraction FROM public.topic_extraction_runs WHERE id = p_extraction_run_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'record_topic_assignment_decision: extraction_run % not found', p_extraction_run_id;
      END IF;
      IF v_extraction.status <> 'completed' THEN
        RAISE EXCEPTION 'record_topic_assignment_decision: extraction_run % is not completed (status=%)', p_extraction_run_id, v_extraction.status;
      END IF;
      v_evidence_id := v_extraction.signal_evidence_id;

      -- Evidence-level advisory lock -- taken before any idempotency
      -- lookup or write. Two concurrent calls for the same extraction_run
      -- necessarily share this evidence_id (an extraction_run belongs to
      -- exactly one evidence), so this alone serializes that race; the
      -- cross-evidence ATTACH_EXISTING race onto the same target topic is
      -- separately serialized below by SELECT ... FOR UPDATE on the topic.
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_evidence_id::text, 0));

      v_deterministic_signals := coalesce(p_deterministic_signals, '{}'::jsonb);

      -- S2B v0 canonical contract for deterministic_signals: the 073 CHECK
      -- only requires jsonb_typeof=object -- no key set has ever been
      -- specified or is read by any S2B code path yet, so for digest
      -- purposes this migration closes it as a FLAT object of scalar
      -- (string/number/boolean/null) values only; nested object/array
      -- values are rejected outright rather than silently canonicalized
      -- ambiguously. Keys are sorted lexicographically (byte order, via
      -- plain ORDER BY on the key text -- not Postgres's internal jsonb
      -- storage order, which is an implementation detail, not a
      -- guaranteed public API) so the canonical form never depends on
      -- insertion order or the database's internal representation.
      IF EXISTS (
        SELECT 1 FROM jsonb_each(v_deterministic_signals) kv WHERE jsonb_typeof(kv.value) IN ('object', 'array')
      ) THEN
        RAISE EXCEPTION 'record_topic_assignment_decision: deterministic_signals must be a flat object of scalar values only (no nested object/array) in S2B v0';
      END IF;
      SELECT coalesce(string_agg(format('%s:%s', to_json(kv.key)::text, kv.value::text), ',' ORDER BY kv.key), '')
        INTO v_deterministic_signals_canonical
        FROM jsonb_each(v_deterministic_signals) kv;

      -- decision_digest canonicalization contract, S2B v0. Explicit fixed
      -- field order/names, never a chr(31)-delimited concatenation -- a
      -- literal chr(31) byte inside a free-text field (deterministic_signals
      -- string values are caller-supplied) could otherwise shift field
      -- boundaries and collide two genuinely different decisions onto the
      -- same digest. Field order: extraction_run_id, outcome,
      -- decision_reason, deterministic_signals, existing_semantic_topic_id,
      -- idempotency_key. UUIDs via ::text (Postgres's uuid type always
      -- renders lowercase canonical form on cast, regardless of input
      -- case). Strings via to_json() (proper JSON escaping). SQL NULL
      -- (p_existing_semantic_topic_id for CREATE_NEW/QUARANTINE) -> JSON null.
      v_decision_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"extraction_run_id":%s,"outcome":%s,"decision_reason":%s,"deterministic_signals":{%s},"existing_semantic_topic_id":%s,"idempotency_key":%s}',
          to_json(p_extraction_run_id::text)::text, to_json(p_outcome)::text, coalesce(to_json(p_decision_reason)::text, 'null'),
          v_deterministic_signals_canonical, coalesce(to_json(p_existing_semantic_topic_id::text)::text, 'null'), to_json(p_idempotency_key)::text
        ), 'UTF8')), 'hex');

      -- Idempotency: at most one decision per extraction_run_id (table UNIQUE).
      SELECT * INTO v_existing FROM public.topic_assignment_decisions WHERE extraction_run_id = p_extraction_run_id;
      IF FOUND THEN
        IF v_existing.decision_digest = v_decision_digest THEN
          RETURN jsonb_build_object(
            'ok', true, 'outcome_kind', 'replayed', 'decision_id', v_existing.id, 'outcome', v_existing.outcome,
            'semantic_topic_id', v_existing.semantic_topic_id, 'resulting_membership_id', v_existing.resulting_membership_id
          );
        ELSE
          RAISE EXCEPTION 'record_topic_assignment_decision: extraction_run % already has a decision with different parameters', p_extraction_run_id;
        END IF;
      END IF;
      IF EXISTS (SELECT 1 FROM public.topic_assignment_decisions WHERE idempotency_key = p_idempotency_key) THEN
        RAISE EXCEPTION 'record_topic_assignment_decision: idempotency_key % already used for a different extraction_run', p_idempotency_key;
      END IF;

      -- The only source of canonical_label/label_language/specificity/
      -- confidence is the persisted structured_output -- the caller
      -- cannot supply redundant copies of these fields.
      v_specificity := v_extraction.structured_output->>'specificity';
      v_confidence := (v_extraction.structured_output->>'confidence')::numeric;
      v_canonical_label := v_extraction.structured_output->>'canonical_phenomenon_label';
      v_label_language := v_extraction.structured_output->>'label_language';

      IF p_outcome = 'CREATE_NEW' THEN
        IF p_existing_semantic_topic_id IS NOT NULL THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: CREATE_NEW must not supply p_existing_semantic_topic_id';
        END IF;
        IF p_decision_reason <> 'no_similar_topic_found' THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: CREATE_NEW requires decision_reason=no_similar_topic_found (got %)', p_decision_reason;
        END IF;
        IF v_specificity <> 'specific' THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: CREATE_NEW requires structured_output.specificity=specific (got %)', v_specificity;
        END IF;
        IF v_confidence < v_min_confidence THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: CREATE_NEW requires confidence >= % (got %)', v_min_confidence, v_confidence;
        END IF;

      ELSIF p_outcome = 'ATTACH_EXISTING' THEN
        IF p_existing_semantic_topic_id IS NULL THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: ATTACH_EXISTING requires p_existing_semantic_topic_id';
        END IF;
        IF p_decision_reason NOT IN ('exact_entity_match', 'embedding_similarity_match', 'manual_review_confirmed', 'manual_review_override') THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: ATTACH_EXISTING does not accept decision_reason=%', p_decision_reason;
        END IF;
        IF v_specificity <> 'specific' THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: ATTACH_EXISTING requires structured_output.specificity=specific (got %)', v_specificity;
        END IF;
        IF v_confidence < v_min_confidence THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: ATTACH_EXISTING requires confidence >= % (got %)', v_min_confidence, v_confidence;
        END IF;

      ELSE -- QUARANTINE
        IF p_existing_semantic_topic_id IS NOT NULL THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: QUARANTINE must not supply p_existing_semantic_topic_id';
        END IF;
        IF p_decision_reason NOT IN ('malformed_extraction', 'below_confidence_threshold') THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: QUARANTINE does not accept decision_reason=%', p_decision_reason;
        END IF;
      END IF;

      IF p_outcome = 'CREATE_NEW' THEN
        v_assignment_reason := 'topic_creation_seed';
        -- extraction_run_id is UNIQUE on topic_assignment_decisions, so at
        -- most one CREATE_NEW can ever exist per extraction_run_id --
        -- deterministic and trivially unique for semantic_topics'
        -- creation_request_digest without inventing any client-supplied
        -- content for it.
        v_creation_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          p_extraction_run_id::text || chr(31) || 'topic_creation_seed', 'UTF8')), 'hex');

        INSERT INTO public.semantic_topics (canonical_label, label_language, specificity, creation_request_digest)
        VALUES (v_canonical_label, v_label_language, v_specificity, v_creation_request_digest)
        RETURNING id INTO v_topic_id;

        INSERT INTO public.semantic_topic_membership (semantic_topic_id, signal_evidence_id, assignment_reason, confidence, algorithm_version)
        VALUES (v_topic_id, v_evidence_id, v_assignment_reason, v_confidence, v_algorithm_version)
        RETURNING id INTO v_membership_id;

      ELSIF p_outcome = 'ATTACH_EXISTING' THEN
        SELECT * INTO v_topic FROM public.semantic_topics WHERE id = p_existing_semantic_topic_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: target semantic_topic % not found', p_existing_semantic_topic_id;
        END IF;

        IF v_topic.lifecycle_status IN ('split_required', 'merge_candidate', 'superseded', 'archived') THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: target topic lifecycle_status=% never accepts ATTACH_EXISTING', v_topic.lifecycle_status;
        ELSIF v_topic.lifecycle_status = 'ambiguous' AND p_decision_reason NOT IN ('manual_review_confirmed', 'manual_review_override') THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: target topic lifecycle_status=ambiguous requires a manual_review_* decision_reason (got %)', p_decision_reason;
        END IF;

        v_assignment_reason := CASE p_decision_reason
          WHEN 'exact_entity_match' THEN 'entity_event_match'
          WHEN 'embedding_similarity_match' THEN 'embedding_similarity'
          WHEN 'manual_review_confirmed' THEN 'manual_review_confirmed'
          WHEN 'manual_review_override' THEN 'manual_review_override'
        END;

        INSERT INTO public.semantic_topic_membership (semantic_topic_id, signal_evidence_id, assignment_reason, confidence, algorithm_version)
        VALUES (p_existing_semantic_topic_id, v_evidence_id, v_assignment_reason, v_confidence, v_algorithm_version)
        RETURNING id INTO v_membership_id;

        v_topic_id := p_existing_semantic_topic_id;

        -- Lifecycle transition -- the ONLY automatic transition S2B makes:
        -- candidate_singleton -> corroborating, exactly once, the moment a
        -- second active membership exists. The topic row is already
        -- locked (FOR UPDATE above), so a concurrent second ATTACH from a
        -- different evidence blocks here until the first commits, then
        -- re-reads a fresh lifecycle_status -- guaranteeing exactly one
        -- transition even under concurrency.
        IF v_topic.lifecycle_status = 'candidate_singleton' THEN
          SELECT count(*) INTO v_active_count FROM public.semantic_topic_membership
            WHERE semantic_topic_id = p_existing_semantic_topic_id AND valid_to IS NULL;
          IF v_active_count >= 2 THEN
            UPDATE public.semantic_topics SET lifecycle_status = 'corroborating', status_version = status_version + 1, updated_at = now()
              WHERE id = p_existing_semantic_topic_id;
          END IF;
        END IF;

      ELSE -- QUARANTINE
        v_topic_id := NULL;
        v_membership_id := NULL;
      END IF;

      INSERT INTO public.topic_assignment_decisions (
        extraction_run_id, signal_evidence_id, outcome, semantic_topic_id, resulting_membership_id,
        decision_reason, deterministic_signals, model_confidence, decision_digest, idempotency_key
      ) VALUES (
        p_extraction_run_id, v_evidence_id, p_outcome, v_topic_id, v_membership_id,
        p_decision_reason, v_deterministic_signals, v_confidence, v_decision_digest, p_idempotency_key
      ) RETURNING id INTO v_decision_id;

      IF p_outcome IN ('CREATE_NEW', 'ATTACH_EXISTING') THEN
        INSERT INTO public.semantic_topic_membership_events (
          semantic_topic_id, signal_evidence_id, related_membership_id, event_type, related_assignment_decision_id, event_reason
        ) VALUES (
          v_topic_id, v_evidence_id, v_membership_id, 'attached', v_decision_id, v_assignment_reason
        );
      END IF;

      RETURN jsonb_build_object(
        'ok', true, 'outcome_kind', 'created', 'decision_id', v_decision_id, 'outcome', p_outcome,
        'semantic_topic_id', v_topic_id, 'resulting_membership_id', v_membership_id
      );
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.record_topic_assignment_decision(
      UUID, TEXT, TEXT, JSONB, TEXT, UUID
    ) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.record_topic_assignment_decision(
      UUID, TEXT, TEXT, JSONB, TEXT, UUID
    ) TO service_role;

    RAISE NOTICE '074: record_topic_assignment_decision created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '074: record_topic_assignment_decision already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_topic_assignment_decision';

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
      RAISE EXCEPTION '074 drift: record_topic_assignment_decision structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '074 drift: record_topic_assignment_decision body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '074 drift: record_topic_assignment_decision ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '074: record_topic_assignment_decision already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '074 fail-closed: record_topic_assignment_decision has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_rtad$;

NOTIFY pgrst, 'reload schema';

COMMIT;
