-- ============================================================
-- Migration 076: Semantic Topic Identity v0 -- canonical input timestamp v2
--
-- DEFECT IN v1 (074/075 as originally applied): record_topic_extraction_run's
-- source_snapshot embeds signal_evidence.published_at via a plain `::text`
-- cast on the timestamptz column, e.g. "2026-07-26 04:47:43+00" (space
-- separator, colon-less offset). Meanwhile the TypeScript normalization
-- layer (lib/semantic-topic/normalize.ts) that builds
-- normalized_extraction_input embeds whatever string the CALLER's data
-- source produced for that same column -- in the only real caller so far,
-- that is @supabase/supabase-js (PostgREST), which serializes timestamptz
-- via Postgres's own to_json()/to_jsonb() convention, e.g.
-- "2026-07-26T04:47:43+00:00" ("T" separator, colon offset). These are two
-- INDEPENDENT serializations of the identical column value, and they
-- disagree. Empirically confirmed (four representations of one instant
-- produced four different normalized_input_digest values -- see
-- docs/architecture/semantic-topic-identity-v0-contract.md SS30 for the
-- full incident writeup, root-caused during the first real production
-- shadow extraction, extraction_run_id
-- c5e4da64-7e23-4e56-9620-6cdcafb395d5).
--
-- WHY reserve_ai_provider_units ALSO NEEDS CORRECTING (not just the
-- writer): the first pass of this fix (076 v1, superseded by this file)
-- only corrected record_topic_extraction_run's stored source_snapshot,
-- reasoning that reserve_ai_provider_units "only hashes whatever text the
-- caller already built." That is true, but insufficient: because
-- topic_extraction_runs_completed_cache_key and the global attempt-limit
-- are BOTH keyed on normalized_input_digest, a caller that builds its own
-- (non-canonical, or tampered, or stale) normalized_extraction_input text
-- and calls reserve_ai_provider_units directly could still mint a real,
-- fee-incurring reservation under a digest the TypeScript layer would
-- never have produced -- completely bypassing the cache/attempt-limit
-- guard the canonical format exists to protect. A server-side RPC can
-- never trust a caller-supplied "already normalized" string to actually
-- BE canonical; it must rebuild the canonical form itself from the one
-- source of truth (the live signal_evidence row) and refuse anything that
-- doesn't match, byte for byte, before any budget/reservation DML.
--
-- THE EXISTING V1 PRODUCTION RUN (id=c5e4da64-7e23-4e56-9620-6cdcafb395d5)
-- IS NOT TOUCHED. topic_extraction_runs is never UPDATEd or DELETEd by
-- this migration -- this migration performs no DML whatsoever on it. It
-- remains normalization_version=1, status=completed, and is documented
-- (see the contract doc) as a historical, provenance-consistent-with-its-
-- own-era audit record, permanently distinguishable from v2 rows by its
-- normalization_version column alone.
--
-- WHY normalization_version BUMPS TO 2 (not a v1 patch): the actual
-- extraction/normalization semantics (which evidence fields feed the
-- model) are unchanged, but the canonical *serialization* of one of those
-- fields materially changes, which changes normalized_input_digest and
-- (via SEMANTIC_TOPIC_NORMALIZATION_VERSION's presence in the digest's
-- own field list) extraction_config_digest for every future call. v1 rows
-- are never silently reinterpreted as v2.
--
-- CANONICAL FORMAT (TypeScript AND both corrected RPCs, byte-identical
-- output): `YYYY-MM-DDTHH:mm:ss.sssZ` -- always UTC, always "T", always
-- exactly 3 millisecond digits (TRUNCATED, never rounded, from any finer
-- source precision), always "Z". SQL side (identical expression inlined in
-- both RPCs -- this codebase's established convention is to duplicate a
-- short canonicalization expression per-RPC rather than introduce a shared
-- helper function with its own separate hash-gate governance):
-- `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` --
-- explicit UTC conversion + explicit format string, independent of session
-- TimeZone/DateStyle (empirically verified: identical output under SET
-- DateStyle='German, DMY' and SET timezone='Asia/Tokyo'). TypeScript side:
-- lib/semantic-topic/canonical-timestamp.ts's canonicalizeTimestamp(),
-- which never calls `new Date(someString)` (unspecified parsing for
-- non-strict-ISO input) -- it extracts fields via an explicit regex and
-- combines them with the fully spec-guaranteed Date.UTC(...) arithmetic.
-- Both sides were cross-validated against the same precision/offset/
-- rollover matrix and produce byte-identical results.
--
-- FULL CANONICAL-INPUT CONTRACT (not just the timestamp field): both
-- corrected RPCs, and the TypeScript buildNormalizedExtractionInput they
-- must byte-match, build the SAME four-line (at most) text: `title: ...`
-- (always, whitespace-collapsed), `snippet: ...` (only if non-blank,
-- whitespace-collapsed), `published_at: ...` (only if non-null, the
-- canonical timestamp above), `canonical_url: ...` (only if non-blank,
-- trimmed but NOT whitespace-collapsed), each on its own line, joined by
-- "\n", in exactly that field order, with no field emitted at all when its
-- source value is null/blank (never an empty line, never a "null"
-- placeholder).
--
-- SCOPE: replaces public.record_topic_extraction_run(...) (074) and
-- public.reserve_ai_provider_units(...) (075) -- and ONLY these two.
-- record_topic_assignment_decision (074's other RPC) never references
-- published_at/first_seen_at. The other five 075 RPCs
-- (mark_ai_provider_attempt_started, commit_ai_provider_units,
-- mark_ai_provider_outcome_unknown, release_ai_provider_units,
-- finalize_ai_provider_reservation_outcome,
-- reconcile_stale_ai_provider_reservations) never reference
-- signal_evidence or a timestamp-bearing digest input at all -- audited,
-- confirmed, untouched. No new table, no ALTER on any existing table, no
-- RLS/grant change beyond re-verifying the unchanged baseline, no
-- cron/route/UI change, no provider call, no extraction, no assignment.
--
-- FAIL-CLOSED CONTRACT, BOTH FUNCTIONS TOGETHER, ONE TRANSACTION:
--   A) BOTH live body_hashes are EXACTLY their known legacy hashes
--      (record_topic_extraction_run=f6ed6773724c95c2deccc2f7ca692e89,
--      reserve_ai_provider_units=7782026c482e5ba6fd4f7a5a01a3d8aa) ->
--      CREATE OR REPLACE both with their corrected v2 bodies, then
--      re-validate both byte-exact.
--   B) BOTH live body_hashes are EXACTLY their already-corrected v2
--      hashes -> no-op (idempotent replay of this same migration).
--   C) ANYTHING ELSE -- one legacy and one corrected (mixed state), one or
--      both unknown/tampered/future, missing function, wrong overload
--      count, drifted owner/ACL/search_path on EITHER function -> RAISE
--      EXCEPTION, full ROLLBACK. No DDL/DCL runs in this branch, on either
--      function -- a migration that "fixed" only the function whose hash
--      it recognized while leaving the other's state ambiguous would be
--      exactly the kind of partial, silently-inconsistent state this
--      whole fail-closed pattern exists to prevent.
-- ============================================================

BEGIN;

DO $migrate$
DECLARE
  v_rter_oid oid;
  v_rter_hash text;
  v_rter_expected_args CONSTANT text := 'p_signal_evidence_id uuid, p_normalization_version integer, p_extraction_method text, p_provider text, p_model text, p_prompt_version text, p_deterministic_extractor_version integer, p_normalized_extraction_input text, p_extraction_schema_version integer, p_status text, p_structured_output jsonb, p_input_tokens integer, p_output_tokens integer, p_estimated_cost_usd numeric, p_error_class text, p_idempotency_key text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone';
  v_rter_legacy_hash CONSTANT text := 'f6ed6773724c95c2deccc2f7ca692e89';
  v_rter_corrected_hash CONSTANT text := 'ef55f0b83d78d001d9e2f903f434c79f';

  v_reserve_oid oid;
  v_reserve_hash text;
  v_reserve_expected_args CONSTANT text := 'p_provider text, p_usage_type text, p_model text, p_signal_evidence_id uuid, p_normalization_version integer, p_extraction_schema_version integer, p_prompt_version text, p_normalized_extraction_input text, p_estimated_input_tokens integer, p_estimated_max_output_tokens integer, p_idempotency_key text';
  v_reserve_legacy_hash CONSTANT text := '7782026c482e5ba6fd4f7a5a01a3d8aa';
  v_reserve_corrected_hash CONSTANT text := 'd781b17d74ab22fcd4e758408b75f0df';

  v_state text;
BEGIN
  v_rter_oid := to_regprocedure('public.record_topic_extraction_run(uuid, integer, text, text, text, text, integer, text, integer, text, jsonb, integer, integer, numeric, text, text, timestamptz, timestamptz)');
  IF v_rter_oid IS NULL THEN
    RAISE EXCEPTION '076 drift: public.record_topic_extraction_run(...) does not exist -- 074 must be applied first';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_topic_extraction_run') <> 1 THEN
    RAISE EXCEPTION '076 drift: record_topic_extraction_run has an unexpected overload count before replace';
  END IF;
  IF pg_get_function_identity_arguments(v_rter_oid) <> v_rter_expected_args THEN
    RAISE EXCEPTION '076 drift: record_topic_extraction_run argument list does not match the expected 074 signature before replace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_rter_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
  ) THEN
    RAISE EXCEPTION '076 drift: record_topic_extraction_run owner/SECURITY DEFINER/search_path does not match the expected baseline before replace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'record_topic_extraction_run' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '076 drift: record_topic_extraction_run is missing the service_role EXECUTE grant before replace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'record_topic_extraction_run' AND grantee NOT IN ('service_role', 'postgres')
  ) THEN
    RAISE EXCEPTION '076 drift: record_topic_extraction_run has an unexpected EXECUTE grantee before replace';
  END IF;
  SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_rter_hash FROM pg_proc p WHERE p.oid = v_rter_oid;

  v_reserve_oid := to_regprocedure('public.reserve_ai_provider_units(text, text, text, uuid, integer, integer, text, text, integer, integer, text)');
  IF v_reserve_oid IS NULL THEN
    RAISE EXCEPTION '076 drift: public.reserve_ai_provider_units(...) does not exist -- 075 must be applied first';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'reserve_ai_provider_units') <> 1 THEN
    RAISE EXCEPTION '076 drift: reserve_ai_provider_units has an unexpected overload count before replace';
  END IF;
  IF pg_get_function_identity_arguments(v_reserve_oid) <> v_reserve_expected_args THEN
    RAISE EXCEPTION '076 drift: reserve_ai_provider_units argument list does not match the expected 075 signature before replace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_reserve_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
  ) THEN
    RAISE EXCEPTION '076 drift: reserve_ai_provider_units owner/SECURITY DEFINER/search_path does not match the expected baseline before replace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'reserve_ai_provider_units' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '076 drift: reserve_ai_provider_units is missing the service_role EXECUTE grant before replace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'reserve_ai_provider_units' AND grantee NOT IN ('service_role', 'postgres')
  ) THEN
    RAISE EXCEPTION '076 drift: reserve_ai_provider_units has an unexpected EXECUTE grantee before replace';
  END IF;
  SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_reserve_hash FROM pg_proc p WHERE p.oid = v_reserve_oid;

  IF v_rter_hash = v_rter_corrected_hash AND v_reserve_hash = v_reserve_corrected_hash THEN
    v_state := 'both_corrected';
  ELSIF v_rter_hash = v_rter_legacy_hash AND v_reserve_hash = v_reserve_legacy_hash THEN
    v_state := 'both_legacy';
  ELSE
    RAISE EXCEPTION '076 drift: mixed or unrecognized state -- record_topic_extraction_run body_hash=%, reserve_ai_provider_units body_hash=% -- refusing to touch either function (both must be exactly legacy or both exactly corrected)', v_rter_hash, v_reserve_hash;
  END IF;

  IF v_state = 'both_corrected' THEN
    -- ============================================================
    -- B) ALREADY-CORRECTED NO-OP BRANCH -- NEVER runs DDL/DCL.
    -- ============================================================
    RAISE NOTICE '076: both record_topic_extraction_run and reserve_ai_provider_units already exactly the corrected v2 body -- no-op.';
  ELSE
    -- ============================================================
    -- A) REPLACE BRANCH -- both known legacy v1 bodies -> corrected v2.
    -- ============================================================
    RAISE NOTICE '076: both functions are the known legacy v1 body -- REPLACE branch (canonical input timestamp v2).';

    CREATE OR REPLACE FUNCTION public.record_topic_extraction_run(
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
      --
      -- v2 CORRECTION (076): published_at and first_seen_at are now
      -- formatted via the canonical `to_char(... AT TIME ZONE 'UTC',
      -- 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` contract -- explicit UTC,
      -- explicit format string, session TimeZone/DateStyle-independent,
      -- millisecond-truncated -- instead of the v1 `::text` cast, so the
      -- stored source_snapshot's published_at is now BYTE-IDENTICAL to
      -- what both lib/semantic-topic/normalize.ts's canonicalizeTimestamp()
      -- and this migration's corrected reserve_ai_provider_units embed
      -- into normalized_extraction_input. See this migration's header
      -- comment for the full incident writeup.
      v_source_snapshot_text := format(
        '{"evidence_id":%s,"evidence_type":%s,"external_ref":%s,"title":%s,"snippet":%s,"published_at":%s,"canonical_url":%s,"first_seen_at":%s,"signal_source_id":%s,"source_type":%s,"source_external_id":%s,"source_family_key":%s}',
        coalesce(to_json(v_evidence.id::text)::text, 'null'), coalesce(to_json(v_evidence.evidence_type)::text, 'null'), coalesce(to_json(v_evidence.external_ref)::text, 'null'),
        coalesce(to_json(v_evidence.title)::text, 'null'), coalesce(to_json(v_evidence.snippet)::text, 'null'),
        coalesce(to_json(to_char(v_evidence.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text, 'null'),
        coalesce(to_json(v_evidence.canonical_url)::text, 'null'),
        coalesce(to_json(to_char(v_evidence.first_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text, 'null'),
        coalesce(to_json(v_evidence.signal_source_id::text)::text, 'null'),
        coalesce(to_json(v_source.source_type)::text, 'null'), coalesce(to_json(v_source.external_id)::text, 'null'), coalesce(to_json(v_source.source_family_key)::text, 'null')
      );
      v_source_snapshot := v_source_snapshot_text::jsonb;
      v_source_snapshot_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(v_source_snapshot_text, 'UTF8')), 'hex');

      -- normalized_input_digest -- always server-recomputed, never trusted from client.
      -- (The caller-supplied p_normalized_extraction_input has ALREADY been
      -- validated byte-for-byte against the server-rebuilt canonical form
      -- by reserve_ai_provider_units, at reservation time, before this RPC
      -- is ever reached -- this RPC re-hashes it again here purely to keep
      -- the two RPCs' digest computation textually independent, never to
      -- re-validate; record_topic_extraction_run has no evidence-mismatch
      -- check of its own by design, mirroring 074's original v1 contract.)
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

    SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_rter_hash FROM pg_proc p WHERE p.oid = v_rter_oid;
    IF v_rter_hash <> v_rter_corrected_hash THEN
      RAISE EXCEPTION '076 drift: post-replace record_topic_extraction_run body_hash (%) does not match the expected corrected v2 hash', v_rter_hash;
    END IF;

    CREATE OR REPLACE FUNCTION public.reserve_ai_provider_units(
      p_provider TEXT,
      p_usage_type TEXT,
      p_model TEXT,
      p_signal_evidence_id UUID,
      p_normalization_version INTEGER,
      p_extraction_schema_version INTEGER,
      p_prompt_version TEXT,
      p_normalized_extraction_input TEXT,
      p_estimated_input_tokens INTEGER,
      p_estimated_max_output_tokens INTEGER,
      p_idempotency_key TEXT
    ) RETURNS UUID
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  -- Szerver-oldalon pinnelt v0 limitek és egységár -- a hívó SOHA nem
  -- adhat meg saját limitet vagy költséget.
  v_limit_requests CONSTANT INTEGER := 10;
  v_limit_micro_usd CONSTANT BIGINT := 1000000;
  v_price_input_per_million CONSTANT NUMERIC := 3.00;
  v_price_output_per_million CONSTANT NUMERIC := 15.00;
  v_max_attempts CONSTANT INTEGER := 3;
  v_quota_date DATE;
  v_daily_budget_id UUID;
  v_reservation_id UUID;
  v_enabled BOOLEAN;
  v_evidence RECORD;
  v_server_normalized_input TEXT;
  v_normalized_input_digest TEXT;
  v_extraction_config_text TEXT;
  v_extraction_config_digest TEXT;
  v_prior_attempts INTEGER;
  v_attempt_ordinal INTEGER;
  v_estimated_micro_usd BIGINT;
  v_attempt_lock_key BIGINT;
BEGIN
  IF p_provider IS DISTINCT FROM 'anthropic' THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: unsupported provider %', p_provider USING ERRCODE = 'P0001';
  END IF;
  IF p_usage_type IS DISTINCT FROM 'semantic_topic_extraction' THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: unsupported usage_type %', p_usage_type USING ERRCODE = 'P0001';
  END IF;
  IF p_model IS DISTINCT FROM 'claude-sonnet-4-6' THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: unsupported model %', p_model USING ERRCODE = 'P0001';
  END IF;
  IF p_signal_evidence_id IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: signal_evidence_id required' USING ERRCODE = 'P0001';
  END IF;
  IF p_normalization_version IS NULL OR p_normalization_version < 1 THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: normalization_version must be >= 1' USING ERRCODE = 'P0001';
  END IF;
  IF p_extraction_schema_version IS NULL OR p_extraction_schema_version < 1 THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: extraction_schema_version must be >= 1' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(btrim(p_prompt_version), '') IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: prompt_version required' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(p_normalized_extraction_input, '') IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: normalized_extraction_input required' USING ERRCODE = 'P0001';
  END IF;
  IF p_estimated_input_tokens IS NULL OR p_estimated_input_tokens <= 0 THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: estimated_input_tokens must be positive' USING ERRCODE = 'P0001';
  END IF;
  IF p_estimated_max_output_tokens IS NULL OR p_estimated_max_output_tokens <= 0 THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: estimated_max_output_tokens must be positive' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: idempotency_key required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_evidence FROM public.signal_evidence WHERE id = p_signal_evidence_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: signal_evidence % not found', p_signal_evidence_id USING ERRCODE = 'P0001';
  END IF;

  -- v2 (076): the server rebuilds the canonical normalized_extraction_input
  -- from the LIVE evidence row itself -- byte-identical to TypeScript's
  -- buildNormalizedExtractionInput (title always, whitespace-collapsed;
  -- snippet only if non-blank, whitespace-collapsed; published_at only if
  -- non-null, canonicalized via the same UTC/millisecond contract as this
  -- migration's corrected record_topic_extraction_run; canonical_url only
  -- if non-blank, trimmed but NOT whitespace-collapsed), each field on its
  -- own line joined by chr(10), in exactly that order, no field emitted at
  -- all when its source value is null/blank. The caller-supplied
  -- p_normalized_extraction_input is compared against this server-rebuilt
  -- text and REJECTED on ANY mismatch -- fail-closed, before any
  -- budget/reservation DML -- so a caller can never spend a reservation
  -- using its own timestamp/whitespace serialization, a stale evidence
  -- snapshot, or a tampered normalized-input string. This is what actually
  -- closes the canonicalization gap end-to-end: record_topic_extraction_run
  -- alone only fixed what got STORED; this is the gate that stops a
  -- non-canonical digest from ever being paid for in the first place.
  v_server_normalized_input := 'title: ' || btrim(regexp_replace(v_evidence.title, '\s+', ' ', 'g'));
  IF v_evidence.snippet IS NOT NULL AND btrim(v_evidence.snippet) <> '' THEN
    v_server_normalized_input := v_server_normalized_input || chr(10) || 'snippet: ' || btrim(regexp_replace(v_evidence.snippet, '\s+', ' ', 'g'));
  END IF;
  IF v_evidence.published_at IS NOT NULL THEN
    v_server_normalized_input := v_server_normalized_input || chr(10) || 'published_at: ' || to_char(v_evidence.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  END IF;
  IF v_evidence.canonical_url IS NOT NULL AND btrim(v_evidence.canonical_url) <> '' THEN
    v_server_normalized_input := v_server_normalized_input || chr(10) || 'canonical_url: ' || btrim(v_evidence.canonical_url);
  END IF;

  IF p_normalized_extraction_input IS DISTINCT FROM v_server_normalized_input THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: caller-supplied normalized_extraction_input does not match the server-rebuilt canonical form for this evidence -- refusing (stale snapshot, non-canonical serialization, or tampering)' USING ERRCODE = 'P0001';
  END IF;

  SELECT enabled INTO v_enabled FROM public.ai_extraction_control WHERE id = 1;
  IF v_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: AI extraction is currently disabled' USING ERRCODE = 'P0001';
  END IF;

  -- Server-rebuilt canonical text is now proven byte-identical to what the
  -- caller supplied (the check above already RAISE EXCEPTIONed otherwise),
  -- so hashing either is equivalent -- hashing the server's own text keeps
  -- the digest's provenance unambiguous.
  v_normalized_input_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(v_server_normalized_input, 'UTF8')), 'hex');

  v_extraction_config_text := format(
    '{"extraction_method":%s,"normalization_version":%s,"extraction_schema_version":%s,"provider":%s,"model":%s,"prompt_version":%s,"deterministic_extractor_version":%s}',
    to_json('ai_assisted'::text)::text,
    coalesce(to_json(p_normalization_version)::text, 'null'),
    coalesce(to_json(p_extraction_schema_version)::text, 'null'),
    to_json(p_provider)::text,
    to_json(p_model)::text,
    coalesce(to_json(p_prompt_version)::text, 'null'),
    'null'
  );
  v_extraction_config_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(v_extraction_config_text, 'UTF8')), 'hex');

  -- Korrekciós gate (1): a teljes (evidence, normalized_input_digest,
  -- extraction_config_digest, provider, model) kulcsra szerializál -- ez
  -- garantálja, hogy két konkurens hívás sose olvashassa mindkettő ugyanazt
  -- a "2 of 3" allapotot es ne indíthassanak mindketten egy 3./4. attemptet.
  v_attempt_lock_key := hashtextextended(
    p_signal_evidence_id::text || chr(31) || v_normalized_input_digest || chr(31) || v_extraction_config_digest || chr(31) || p_provider || chr(31) || p_model,
    0
  );
  PERFORM pg_advisory_xact_lock(v_attempt_lock_key);

  v_quota_date := (timezone('UTC', statement_timestamp()))::date;

  INSERT INTO public.ai_provider_daily_budgets
    (provider, usage_type, model, quota_date, limit_requests, limit_micro_usd)
  VALUES (p_provider, p_usage_type, p_model, v_quota_date, v_limit_requests, v_limit_micro_usd)
  ON CONFLICT (provider, usage_type, model, quota_date) DO NOTHING;

  SELECT id INTO v_daily_budget_id
  FROM public.ai_provider_daily_budgets
  WHERE provider = p_provider AND usage_type = p_usage_type AND model = p_model AND quota_date = v_quota_date;

  -- Idempotens replay -- ha már létezik foglalás erre a kulcsra, azt adjuk
  -- vissza, új foglalás, új kvóta-növekmény és attempt-számlálás nélkül.
  SELECT id INTO v_reservation_id
  FROM public.ai_provider_budget_reservations
  WHERE daily_budget_id = v_daily_budget_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_reservation_id;
  END IF;

  -- Defense-in-depth: egy már completed extraction ugyanerre a hármasra
  -- SOHA nem hívható újra (a 074 saját partial unique indexe, SS15, is
  -- garantálja ezt a topic_extraction_runs táblán).
  IF EXISTS (
    SELECT 1 FROM public.topic_extraction_runs
    WHERE signal_evidence_id = p_signal_evidence_id
      AND normalized_input_digest = v_normalized_input_digest
      AND extraction_config_digest = v_extraction_config_digest
      AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: a completed extraction already exists for this input/config digest -- use the cached result, do not re-reserve' USING ERRCODE = 'P0001';
  END IF;

  -- Korrekciós gate (1): GLOBÁLIS, quota-date-független attempt-számlálás,
  -- magát az ai_provider_budget_reservations táblát nézve (nem a
  -- topic_extraction_runs 'failed' sorait, ami hiányos lenne
  -- committed_unknown esetén). Minden sor beleszámít, aminek
  -- attempt_started_at ki van töltve ÉS application_outcome nem 'completed'
  -- -- a fenti advisory lock garantálja, hogy ez a SELECT és a lenti INSERT
  -- egyetlen konkurens versenytárs által se kerülhető meg ugyanerre a kulcsra.
  SELECT count(*) INTO v_prior_attempts
  FROM public.ai_provider_budget_reservations r
  JOIN public.ai_provider_daily_budgets b ON b.id = r.daily_budget_id
  WHERE r.signal_evidence_id = p_signal_evidence_id
    AND r.normalized_input_digest = v_normalized_input_digest
    AND r.extraction_config_digest = v_extraction_config_digest
    AND b.provider = p_provider AND b.model = p_model
    AND r.attempt_started_at IS NOT NULL
    AND r.application_outcome IS DISTINCT FROM 'completed';
  IF v_prior_attempts >= v_max_attempts THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: attempt limit (%) reached for this input/config digest', v_max_attempts USING ERRCODE = 'P0001';
  END IF;
  v_attempt_ordinal := v_prior_attempts + 1;

  v_estimated_micro_usd := ceil(
    p_estimated_input_tokens::numeric * v_price_input_per_million
    + p_estimated_max_output_tokens::numeric * v_price_output_per_million
  )::bigint;

  -- Atomikus, guarded foglalás -- mindkét erőforrás-dimenzió (kérésszám ÉS
  -- dollárkeret) egyszerre ellenőrződik ugyanabban a WHERE zárádékban. A
  -- $1 sapka itt KIZÁRÓLAG pre-call kapu (korrekciós gate (2)) -- ha egy
  -- korábbi commit már túllépte a napi committed_micro_usd-t, ez a
  -- feltétel többé sose teljesül, tehát minden újabb foglalás itt
  -- automatikusan elutasul, DB CHECK vagy kivétel nélkül.
  UPDATE public.ai_provider_daily_budgets
  SET reserved_requests = reserved_requests + 1,
      reserved_micro_usd = reserved_micro_usd + v_estimated_micro_usd,
      updated_at = now()
  WHERE id = v_daily_budget_id
    AND limit_requests - reserved_requests - committed_requests >= 1
    AND limit_micro_usd - reserved_micro_usd - committed_micro_usd >= v_estimated_micro_usd;

  IF NOT FOUND THEN
    RETURN NULL; -- kimerült napi kvóta (kérés vagy dollárkeret) -- nincs hívás
  END IF;

  BEGIN
    INSERT INTO public.ai_provider_budget_reservations (
      daily_budget_id, signal_evidence_id, normalized_input_digest, extraction_config_digest,
      attempt_ordinal, idempotency_key, estimated_micro_usd, status
    ) VALUES (
      v_daily_budget_id, p_signal_evidence_id, v_normalized_input_digest, v_extraction_config_digest,
      v_attempt_ordinal, p_idempotency_key, v_estimated_micro_usd, 'reserved'
    )
    RETURNING id INTO v_reservation_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.ai_provider_daily_budgets
    SET reserved_requests = reserved_requests - 1,
        reserved_micro_usd = reserved_micro_usd - v_estimated_micro_usd,
        updated_at = now()
    WHERE id = v_daily_budget_id;

    SELECT id INTO v_reservation_id
    FROM public.ai_provider_budget_reservations
    WHERE daily_budget_id = v_daily_budget_id AND idempotency_key = p_idempotency_key;
    RETURN v_reservation_id;
  END;

  RETURN v_reservation_id;
END;

$body$;

    SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_reserve_hash FROM pg_proc p WHERE p.oid = v_reserve_oid;
    IF v_reserve_hash <> v_reserve_corrected_hash THEN
      RAISE EXCEPTION '076 drift: post-replace reserve_ai_provider_units body_hash (%) does not match the expected corrected v2 hash', v_reserve_hash;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_rter_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '076 drift: post-replace record_topic_extraction_run owner/SECURITY DEFINER/search_path changed unexpectedly';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'record_topic_extraction_run' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '076 drift: post-replace record_topic_extraction_run missing the service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'record_topic_extraction_run' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '076 drift: post-replace record_topic_extraction_run unexpected EXECUTE grantee';
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'record_topic_extraction_run') <> 1 THEN
      RAISE EXCEPTION '076 drift: unexpected record_topic_extraction_run overload count after replace';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_reserve_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '076 drift: post-replace reserve_ai_provider_units owner/SECURITY DEFINER/search_path changed unexpectedly';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'reserve_ai_provider_units' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '076 drift: post-replace reserve_ai_provider_units missing the service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'reserve_ai_provider_units' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '076 drift: post-replace reserve_ai_provider_units unexpected EXECUTE grantee';
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'reserve_ai_provider_units') <> 1 THEN
      RAISE EXCEPTION '076 drift: unexpected reserve_ai_provider_units overload count after replace';
    END IF;

    RAISE NOTICE '076: both record_topic_extraction_run and reserve_ai_provider_units replaced with their corrected v2 bodies (canonical millisecond-UTC timestamp, server-side enforcement).';
  END IF;
END;
$migrate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
