-- ============================================================
-- Migration 073: Semantic Topic Identity v0 -- S2A writerless
-- audit/provenance schema + temporal non-overlap hardening
--
-- Kanonikus szerzodes forrasa: "PFM Semantic Topic Identity v0 -- S2
-- Final Pre-Implementation Correctness Gate" (legmagasabb prioritasu,
-- legutolso jovahagyott specifikacio), reflektalva:
-- docs/architecture/semantic-topic-identity-v0-contract.md
--
-- HATOKOR (S2A -- meg mindig teljesen writerless):
--   1) Harom uj tabla: topic_extraction_runs, topic_assignment_decisions,
--      semantic_topic_membership_events. Mindharom kizarolag audit/
--      provenance -- nincs writer RPC, nincs trigger, nincs backfill.
--   2) semantic_topic_membership.assignment_reason CHECK bovitese egy uj
--      ertekkel (topic_creation_seed) -- fail-closed, csak ismert legacy
--      vagy mar-corrected definiciobol.
--   3) btree_gist extension + EXCLUDE USING gist temporal non-overlap
--      constraint a semantic_topic_membership tablan -- fail-closed,
--      csak ismert hiany-allapotbol telepitheto extension, kotelezo
--      overlap-precheck a constraint hozzaadasa elott.
--
-- Meg mindig NINCS: writer RPC, AI/provider-hivas, alkalmazaskod,
-- topic_extraction usage_type/budget-integracio, automatikus semantic
-- topic/membership-iras. A service_role minden uj tablan csak SELECT-et
-- kap -- pontosan ugyanaz a hatarvonal, mint a 072-ben.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. GLOBALIS TOPOLOGIAI KAPU -- a harom UJ tablara
-- ============================================================

DO $topology_gate$
DECLARE
  v_present_count int;
BEGIN
  SELECT count(*) INTO v_present_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('topic_extraction_runs', 'topic_assignment_decisions', 'semantic_topic_membership_events');

  IF v_present_count NOT IN (0, 3) THEN
    RAISE EXCEPTION '073 fail-closed: partial topology detected -- % of 3 S2A tables exist. No DDL will run. Manual investigation required before this migration can proceed.', v_present_count;
  END IF;

  RAISE NOTICE '073: global topology gate passed (% of 3 tables present).', v_present_count;
END;
$topology_gate$;

-- ============================================================
-- 1. topic_extraction_runs
-- ============================================================

DO $migrate_ter$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_extraction_runs')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '073: topic_extraction_runs does not exist -- CREATE branch.';

    CREATE TABLE public.topic_extraction_runs (
      id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      signal_evidence_id              UUID NOT NULL REFERENCES public.signal_evidence(id) ON DELETE RESTRICT,
      normalization_version           INTEGER NOT NULL,
      extraction_method               TEXT NOT NULL,
      provider                        TEXT,
      model                           TEXT,
      prompt_version                  TEXT,
      deterministic_extractor_version INTEGER,
      source_snapshot                 JSONB NOT NULL,
      source_snapshot_digest          TEXT NOT NULL,
      normalized_extraction_input     TEXT NOT NULL,
      normalized_input_digest         TEXT NOT NULL,
      extraction_config_digest        TEXT NOT NULL,
      extraction_schema_version       INTEGER NOT NULL,
      structured_output               JSONB,
      output_digest                   TEXT,
      status                          TEXT NOT NULL,
      confidence                      NUMERIC(5,4),
      input_tokens                    INTEGER,
      output_tokens                   INTEGER,
      estimated_cost_usd              NUMERIC(10,6),
      error_class                     TEXT,
      idempotency_key                 TEXT NOT NULL,
      started_at                      TIMESTAMPTZ NOT NULL,
      completed_at                    TIMESTAMPTZ NOT NULL,
      created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT topic_extraction_runs_idempotency_key_key UNIQUE (idempotency_key),
      CONSTRAINT topic_extraction_runs_idempotency_key_not_blank CHECK (btrim(idempotency_key) <> ''),
      CONSTRAINT topic_extraction_runs_normalization_version_positive CHECK (normalization_version >= 1),
      CONSTRAINT topic_extraction_runs_extraction_method_check CHECK (extraction_method IN ('deterministic', 'ai_assisted')),
      -- Ketagu, teljes parositas -- egyik ag sem engedi meg reszleges
      -- kitoltest a masik ag mezoin.
      CONSTRAINT topic_extraction_runs_provider_fields_pairing CHECK (
        (extraction_method = 'deterministic'
          AND provider IS NULL AND model IS NULL AND prompt_version IS NULL
          AND deterministic_extractor_version IS NOT NULL AND deterministic_extractor_version >= 1)
        OR
        (extraction_method = 'ai_assisted'
          AND provider IS NOT NULL AND btrim(provider) <> '' AND length(provider) <= 50
          AND model IS NOT NULL AND btrim(model) <> '' AND length(model) <= 100
          AND prompt_version IS NOT NULL AND btrim(prompt_version) <> '' AND length(prompt_version) <= 50
          AND deterministic_extractor_version IS NULL)
      ),
      CONSTRAINT topic_extraction_runs_source_snapshot_is_object CHECK (jsonb_typeof(source_snapshot) = 'object'),
      CONSTRAINT topic_extraction_runs_source_snapshot_digest_format CHECK (source_snapshot_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT topic_extraction_runs_normalized_input_not_blank CHECK (btrim(normalized_extraction_input) <> ''),
      CONSTRAINT topic_extraction_runs_normalized_input_length CHECK (length(normalized_extraction_input) <= 20000),
      CONSTRAINT topic_extraction_runs_normalized_input_digest_format CHECK (normalized_input_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT topic_extraction_runs_config_digest_format CHECK (extraction_config_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT topic_extraction_runs_extraction_schema_version_positive CHECK (extraction_schema_version >= 1),
      CONSTRAINT topic_extraction_runs_status_check CHECK (status IN ('completed', 'failed')),
      -- structured_output/output_digest/confidence: NOT NULL azonosan
      -- akkor es csak akkor, ha status='completed'.
      CONSTRAINT topic_extraction_runs_completed_fields_pairing CHECK (
        (status = 'completed' AND structured_output IS NOT NULL AND output_digest IS NOT NULL AND confidence IS NOT NULL)
        OR
        (status = 'failed' AND structured_output IS NULL AND output_digest IS NULL AND confidence IS NULL)
      ),
      CONSTRAINT topic_extraction_runs_error_class_pairing CHECK (
        (status = 'failed') = (error_class IS NOT NULL)
      ),
      CONSTRAINT topic_extraction_runs_output_digest_format CHECK (output_digest IS NULL OR output_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT topic_extraction_runs_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      -- token/kolstseg mezok: csak ai_assisted eseten lehetnek kitoltve
      -- (de ott is nullable maradhat, pl. providerhiba tokenszamlalas elott).
      CONSTRAINT topic_extraction_runs_tokens_only_ai_assisted CHECK (
        extraction_method = 'ai_assisted' OR (input_tokens IS NULL AND output_tokens IS NULL AND estimated_cost_usd IS NULL)
      ),
      CONSTRAINT topic_extraction_runs_input_tokens_nonneg CHECK (input_tokens IS NULL OR input_tokens >= 0),
      CONSTRAINT topic_extraction_runs_output_tokens_nonneg CHECK (output_tokens IS NULL OR output_tokens >= 0),
      CONSTRAINT topic_extraction_runs_cost_nonneg CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
      CONSTRAINT topic_extraction_runs_completed_after_started CHECK (completed_at >= started_at),
      -- structured_output belso szerzodes (topic_extraction_output_v1) --
      -- csak a top-level skalar mezok/enumok/hosszak ellenorizhetok CHECK-kel
      -- (a CHECK nem tartalmazhat subqueryt/SRF-et, ezert a subject_entities/
      -- supporting_spans tomb ELEMEINEK belso alakja S2B/RPC-felelosseg).
      CONSTRAINT topic_extraction_runs_structured_output_shape CHECK (
        structured_output IS NULL OR (
          jsonb_typeof(structured_output) = 'object'
          -- nincs ismeretlen kulcs: a var kulcshalmaz eltavolitasa utan ures objektum marad
          AND (structured_output - ARRAY[
                'extraction_schema_version','canonical_phenomenon_label','label_language',
                'subject_entities','action_or_event','location','temporal_context',
                'specificity','content_format','confidence','supporting_spans'
              ]) = '{}'::jsonb
          AND (structured_output->>'extraction_schema_version')::int = extraction_schema_version
          AND jsonb_typeof(structured_output->'canonical_phenomenon_label') = 'string'
          AND btrim(structured_output->>'canonical_phenomenon_label') <> ''
          AND length(structured_output->>'canonical_phenomenon_label') <= 200
          AND jsonb_typeof(structured_output->'label_language') = 'string'
          AND (structured_output->>'label_language') ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'
          AND length(structured_output->>'label_language') <= 15
          AND jsonb_typeof(structured_output->'subject_entities') = 'array'
          AND jsonb_array_length(structured_output->'subject_entities') <= 20
          AND (structured_output->'action_or_event' IS NULL OR jsonb_typeof(structured_output->'action_or_event') IN ('string','null'))
          AND (structured_output->'location' IS NULL OR jsonb_typeof(structured_output->'location') IN ('string','null'))
          AND (structured_output->'temporal_context' IS NULL OR jsonb_typeof(structured_output->'temporal_context') IN ('string','null'))
          AND structured_output->>'specificity' IN ('specific', 'generic', 'unknown')
          AND structured_output->>'content_format' IN ('news_event', 'phenomenon', 'product_launch', 'person_focused', 'list_ranking', 'educational', 'other')
          AND (structured_output->>'confidence')::numeric >= 0 AND (structured_output->>'confidence')::numeric <= 1
          AND jsonb_typeof(structured_output->'supporting_spans') = 'array'
          AND jsonb_array_length(structured_output->'supporting_spans') <= 10
        )
      )
    );

    CREATE INDEX idx_topic_extraction_runs_evidence ON public.topic_extraction_runs (signal_evidence_id);

    -- Cache-azonossag: (evidence, normalizalt bemenet, config) legfeljebb
    -- egy 'completed' eredmenyt adhat -- 'failed' probalkozasok korlatlanul
    -- ujra rogzithetok (uj idempotency_key-jel), ez a partial index csak a
    -- vegleges eredmenyre vonatkozik.
    CREATE UNIQUE INDEX topic_extraction_runs_completed_cache_key
      ON public.topic_extraction_runs (signal_evidence_id, normalized_input_digest, extraction_config_digest)
      WHERE status = 'completed';

    ALTER TABLE public.topic_extraction_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.topic_extraction_runs FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.topic_extraction_runs TO service_role;

    RAISE NOTICE '073: topic_extraction_runs created.';
  ELSE
    RAISE NOTICE '073: topic_extraction_runs already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_extraction_runs' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('signal_evidence_id', 'uuid', 'uuid', 'NO', NULL),
        ('normalization_version', 'integer', 'int4', 'NO', NULL),
        ('extraction_method', 'text', 'text', 'NO', NULL),
        ('provider', 'text', 'text', 'YES', NULL),
        ('model', 'text', 'text', 'YES', NULL),
        ('prompt_version', 'text', 'text', 'YES', NULL),
        ('deterministic_extractor_version', 'integer', 'int4', 'YES', NULL),
        ('source_snapshot', 'jsonb', 'jsonb', 'NO', NULL),
        ('source_snapshot_digest', 'text', 'text', 'NO', NULL),
        ('normalized_extraction_input', 'text', 'text', 'NO', NULL),
        ('normalized_input_digest', 'text', 'text', 'NO', NULL),
        ('extraction_config_digest', 'text', 'text', 'NO', NULL),
        ('extraction_schema_version', 'integer', 'int4', 'NO', NULL),
        ('structured_output', 'jsonb', 'jsonb', 'YES', NULL),
        ('output_digest', 'text', 'text', 'YES', NULL),
        ('status', 'text', 'text', 'NO', NULL),
        ('confidence', 'numeric', 'numeric', 'YES', NULL),
        ('input_tokens', 'integer', 'int4', 'YES', NULL),
        ('output_tokens', 'integer', 'int4', 'YES', NULL),
        ('estimated_cost_usd', 'numeric', 'numeric', 'YES', NULL),
        ('error_class', 'text', 'text', 'YES', NULL),
        ('idempotency_key', 'text', 'text', 'NO', NULL),
        ('started_at', 'timestamp with time zone', 'timestamptz', 'NO', NULL),
        ('completed_at', 'timestamp with time zone', 'timestamptz', 'NO', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'topic_extraction_runs'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.topic_extraction_runs'::regclass
      EXCEPT SELECT unnest(ARRAY[
        'topic_extraction_runs_pkey','topic_extraction_runs_signal_evidence_id_fkey',
        'topic_extraction_runs_idempotency_key_key','topic_extraction_runs_idempotency_key_not_blank',
        'topic_extraction_runs_normalization_version_positive','topic_extraction_runs_extraction_method_check',
        'topic_extraction_runs_provider_fields_pairing','topic_extraction_runs_source_snapshot_is_object',
        'topic_extraction_runs_source_snapshot_digest_format','topic_extraction_runs_normalized_input_not_blank',
        'topic_extraction_runs_normalized_input_length','topic_extraction_runs_normalized_input_digest_format',
        'topic_extraction_runs_config_digest_format','topic_extraction_runs_extraction_schema_version_positive',
        'topic_extraction_runs_status_check','topic_extraction_runs_completed_fields_pairing',
        'topic_extraction_runs_error_class_pairing','topic_extraction_runs_output_digest_format',
        'topic_extraction_runs_confidence_range','topic_extraction_runs_tokens_only_ai_assisted',
        'topic_extraction_runs_input_tokens_nonneg','topic_extraction_runs_output_tokens_nonneg',
        'topic_extraction_runs_cost_nonneg','topic_extraction_runs_completed_after_started',
        'topic_extraction_runs_structured_output_shape'
      ])
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs has an unexpected extra constraint';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('topic_extraction_runs_pkey', 'p'),
        ('topic_extraction_runs_signal_evidence_id_fkey', 'f'),
        ('topic_extraction_runs_idempotency_key_key', 'u'),
        ('topic_extraction_runs_idempotency_key_not_blank', 'c'),
        ('topic_extraction_runs_normalization_version_positive', 'c'),
        ('topic_extraction_runs_extraction_method_check', 'c'),
        ('topic_extraction_runs_provider_fields_pairing', 'c'),
        ('topic_extraction_runs_source_snapshot_is_object', 'c'),
        ('topic_extraction_runs_source_snapshot_digest_format', 'c'),
        ('topic_extraction_runs_normalized_input_not_blank', 'c'),
        ('topic_extraction_runs_normalized_input_length', 'c'),
        ('topic_extraction_runs_normalized_input_digest_format', 'c'),
        ('topic_extraction_runs_config_digest_format', 'c'),
        ('topic_extraction_runs_extraction_schema_version_positive', 'c'),
        ('topic_extraction_runs_status_check', 'c'),
        ('topic_extraction_runs_completed_fields_pairing', 'c'),
        ('topic_extraction_runs_error_class_pairing', 'c'),
        ('topic_extraction_runs_output_digest_format', 'c'),
        ('topic_extraction_runs_confidence_range', 'c'),
        ('topic_extraction_runs_tokens_only_ai_assisted', 'c'),
        ('topic_extraction_runs_input_tokens_nonneg', 'c'),
        ('topic_extraction_runs_output_tokens_nonneg', 'c'),
        ('topic_extraction_runs_cost_nonneg', 'c'),
        ('topic_extraction_runs_completed_after_started', 'c'),
        ('topic_extraction_runs_structured_output_shape', 'c')
      ) AS expected(conname, contype)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.topic_extraction_runs'::regclass
          AND c.conname = expected.conname AND c.contype::text = expected.contype
          AND c.convalidated IS true AND c.condeferrable IS false AND c.condeferred IS false
      )
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs constraint set does not match exactly (missing/altered)';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.topic_extraction_runs'::regclass AND contype = 'f' AND confdeltype <> 'r'
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs FK ON DELETE action is not RESTRICT';
    END IF;

    IF EXISTS (
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'topic_extraction_runs'
      EXCEPT SELECT unnest(ARRAY['topic_extraction_runs_pkey','idx_topic_extraction_runs_evidence','topic_extraction_runs_completed_cache_key','topic_extraction_runs_idempotency_key_key'])
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs has an unexpected extra index';
    END IF;
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('topic_extraction_runs_pkey', 'true'),
        ('idx_topic_extraction_runs_evidence', 'false'),
        ('topic_extraction_runs_completed_cache_key', 'true'),
        ('topic_extraction_runs_idempotency_key_key', 'true')
      ) AS expected(indexname, is_unique)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.topic_extraction_runs'::regclass AND c.relname = expected.indexname
          AND ix.indisunique::text = expected.is_unique AND ix.indisvalid IS true AND ix.indisready IS true
      )
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'topic_extraction_runs'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'topic_extraction_runs') THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'topic_extraction_runs' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'topic_extraction_runs' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'topic_extraction_runs' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '073 drift: topic_extraction_runs has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '073: topic_extraction_runs already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_ter$;

-- ============================================================
-- 2. topic_assignment_decisions (extraction_run_id FK-t hasznal)
-- ============================================================

DO $migrate_tad$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_assignment_decisions')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '073: topic_assignment_decisions does not exist -- CREATE branch.';

    CREATE TABLE public.topic_assignment_decisions (
      id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      extraction_run_id           UUID NOT NULL REFERENCES public.topic_extraction_runs(id) ON DELETE RESTRICT,
      signal_evidence_id          UUID NOT NULL REFERENCES public.signal_evidence(id) ON DELETE RESTRICT,
      outcome                     TEXT NOT NULL,
      semantic_topic_id           UUID REFERENCES public.semantic_topics(id) ON DELETE RESTRICT,
      resulting_membership_id     UUID REFERENCES public.semantic_topic_membership(id) ON DELETE RESTRICT,
      decision_reason             TEXT NOT NULL,
      deterministic_signals       JSONB NOT NULL DEFAULT '{}'::jsonb,
      model_confidence            NUMERIC(5,4),
      decision_digest             TEXT NOT NULL,
      idempotency_key             TEXT NOT NULL,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT topic_assignment_decisions_extraction_run_id_key UNIQUE (extraction_run_id),
      CONSTRAINT topic_assignment_decisions_idempotency_key_key UNIQUE (idempotency_key),
      CONSTRAINT topic_assignment_decisions_idempotency_key_not_blank CHECK (btrim(idempotency_key) <> ''),
      CONSTRAINT topic_assignment_decisions_outcome_check CHECK (outcome IN ('CREATE_NEW', 'ATTACH_EXISTING', 'QUARANTINE')),
      CONSTRAINT topic_assignment_decisions_decision_reason_check CHECK (decision_reason IN (
        'no_similar_topic_found', 'exact_entity_match', 'embedding_similarity_match',
        'manual_review_confirmed', 'manual_review_override', 'malformed_extraction', 'below_confidence_threshold'
      )),
      -- outcome<->topic/membership parositas: QUARANTINE eseten mindketto
      -- NULL, minden mas outcome eseten mindketto kitoltott.
      CONSTRAINT topic_assignment_decisions_outcome_fields_pairing CHECK (
        (outcome = 'QUARANTINE' AND semantic_topic_id IS NULL AND resulting_membership_id IS NULL)
        OR
        (outcome IN ('CREATE_NEW', 'ATTACH_EXISTING') AND semantic_topic_id IS NOT NULL AND resulting_membership_id IS NOT NULL)
      ),
      CONSTRAINT topic_assignment_decisions_deterministic_signals_is_object CHECK (jsonb_typeof(deterministic_signals) = 'object'),
      CONSTRAINT topic_assignment_decisions_model_confidence_range CHECK (model_confidence IS NULL OR (model_confidence >= 0 AND model_confidence <= 1)),
      CONSTRAINT topic_assignment_decisions_decision_digest_format CHECK (decision_digest ~ '^[0-9a-f]{64}$')
    );

    CREATE INDEX idx_topic_assignment_decisions_evidence ON public.topic_assignment_decisions (signal_evidence_id);
    CREATE INDEX idx_topic_assignment_decisions_topic ON public.topic_assignment_decisions (semantic_topic_id) WHERE semantic_topic_id IS NOT NULL;

    ALTER TABLE public.topic_assignment_decisions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.topic_assignment_decisions FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.topic_assignment_decisions TO service_role;

    RAISE NOTICE '073: topic_assignment_decisions created.';
  ELSE
    RAISE NOTICE '073: topic_assignment_decisions already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_assignment_decisions' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('extraction_run_id', 'uuid', 'uuid', 'NO', NULL),
        ('signal_evidence_id', 'uuid', 'uuid', 'NO', NULL),
        ('outcome', 'text', 'text', 'NO', NULL),
        ('semantic_topic_id', 'uuid', 'uuid', 'YES', NULL),
        ('resulting_membership_id', 'uuid', 'uuid', 'YES', NULL),
        ('decision_reason', 'text', 'text', 'NO', NULL),
        ('deterministic_signals', 'jsonb', 'jsonb', 'NO', '''{}''::jsonb'),
        ('model_confidence', 'numeric', 'numeric', 'YES', NULL),
        ('decision_digest', 'text', 'text', 'NO', NULL),
        ('idempotency_key', 'text', 'text', 'NO', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'topic_assignment_decisions'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.topic_assignment_decisions'::regclass
      EXCEPT SELECT unnest(ARRAY[
        'topic_assignment_decisions_pkey','topic_assignment_decisions_extraction_run_id_fkey',
        'topic_assignment_decisions_signal_evidence_id_fkey','topic_assignment_decisions_semantic_topic_id_fkey',
        'topic_assignment_decisions_resulting_membership_id_fkey',
        'topic_assignment_decisions_extraction_run_id_key','topic_assignment_decisions_idempotency_key_key',
        'topic_assignment_decisions_idempotency_key_not_blank','topic_assignment_decisions_outcome_check',
        'topic_assignment_decisions_decision_reason_check','topic_assignment_decisions_outcome_fields_pairing',
        'topic_assignment_decisions_deterministic_signals_is_object','topic_assignment_decisions_model_confidence_range',
        'topic_assignment_decisions_decision_digest_format'
      ])
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions has an unexpected extra constraint';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('topic_assignment_decisions_pkey', 'p'),
        ('topic_assignment_decisions_extraction_run_id_fkey', 'f'),
        ('topic_assignment_decisions_signal_evidence_id_fkey', 'f'),
        ('topic_assignment_decisions_semantic_topic_id_fkey', 'f'),
        ('topic_assignment_decisions_resulting_membership_id_fkey', 'f'),
        ('topic_assignment_decisions_extraction_run_id_key', 'u'),
        ('topic_assignment_decisions_idempotency_key_key', 'u'),
        ('topic_assignment_decisions_idempotency_key_not_blank', 'c'),
        ('topic_assignment_decisions_outcome_check', 'c'),
        ('topic_assignment_decisions_decision_reason_check', 'c'),
        ('topic_assignment_decisions_outcome_fields_pairing', 'c'),
        ('topic_assignment_decisions_deterministic_signals_is_object', 'c'),
        ('topic_assignment_decisions_model_confidence_range', 'c'),
        ('topic_assignment_decisions_decision_digest_format', 'c')
      ) AS expected(conname, contype)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.topic_assignment_decisions'::regclass
          AND c.conname = expected.conname AND c.contype::text = expected.contype
          AND c.convalidated IS true AND c.condeferrable IS false AND c.condeferred IS false
      )
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions constraint set does not match exactly (missing/altered)';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.topic_assignment_decisions'::regclass AND contype = 'f' AND confdeltype <> 'r'
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions FK ON DELETE action is not RESTRICT';
    END IF;

    IF EXISTS (
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'topic_assignment_decisions'
      EXCEPT SELECT unnest(ARRAY['topic_assignment_decisions_pkey','topic_assignment_decisions_extraction_run_id_key','idx_topic_assignment_decisions_evidence','idx_topic_assignment_decisions_topic','topic_assignment_decisions_idempotency_key_key'])
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions has an unexpected extra index';
    END IF;
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('topic_assignment_decisions_pkey', 'true'),
        ('topic_assignment_decisions_extraction_run_id_key', 'true'),
        ('idx_topic_assignment_decisions_evidence', 'false'),
        ('idx_topic_assignment_decisions_topic', 'false'),
        ('topic_assignment_decisions_idempotency_key_key', 'true')
      ) AS expected(indexname, is_unique)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.topic_assignment_decisions'::regclass AND c.relname = expected.indexname
          AND ix.indisunique::text = expected.is_unique AND ix.indisvalid IS true AND ix.indisready IS true
      )
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'topic_assignment_decisions'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'topic_assignment_decisions') THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'topic_assignment_decisions' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'topic_assignment_decisions' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'topic_assignment_decisions' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '073 drift: topic_assignment_decisions has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '073: topic_assignment_decisions already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_tad$;

-- ============================================================
-- 3. semantic_topic_membership_events
-- ============================================================

DO $migrate_stme$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_membership_events')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '073: semantic_topic_membership_events does not exist -- CREATE branch.';

    CREATE TABLE public.semantic_topic_membership_events (
      id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      semantic_topic_id               UUID NOT NULL REFERENCES public.semantic_topics(id) ON DELETE RESTRICT,
      signal_evidence_id               UUID NOT NULL REFERENCES public.signal_evidence(id) ON DELETE RESTRICT,
      related_membership_id            UUID NOT NULL REFERENCES public.semantic_topic_membership(id) ON DELETE RESTRICT,
      event_type                       TEXT NOT NULL,
      related_assignment_decision_id   UUID NOT NULL REFERENCES public.topic_assignment_decisions(id) ON DELETE RESTRICT,
      event_reason                     TEXT NOT NULL,
      created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT semantic_topic_membership_events_event_type_check CHECK (event_type IN ('attached', 'detached', 'reassigned')),
      CONSTRAINT semantic_topic_membership_events_event_reason_check CHECK (event_reason IN (
        'entity_event_match', 'embedding_similarity', 'manual_review_confirmed', 'manual_review_override', 'topic_creation_seed'
      ))
    );

    CREATE INDEX idx_semantic_topic_membership_events_topic ON public.semantic_topic_membership_events (semantic_topic_id);
    CREATE INDEX idx_semantic_topic_membership_events_evidence ON public.semantic_topic_membership_events (signal_evidence_id);

    ALTER TABLE public.semantic_topic_membership_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.semantic_topic_membership_events FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.semantic_topic_membership_events TO service_role;

    RAISE NOTICE '073: semantic_topic_membership_events created.';
  ELSE
    RAISE NOTICE '073: semantic_topic_membership_events already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_membership_events' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('semantic_topic_id', 'uuid', 'uuid', 'NO', NULL),
        ('signal_evidence_id', 'uuid', 'uuid', 'NO', NULL),
        ('related_membership_id', 'uuid', 'uuid', 'NO', NULL),
        ('event_type', 'text', 'text', 'NO', NULL),
        ('related_assignment_decision_id', 'uuid', 'uuid', 'NO', NULL),
        ('event_reason', 'text', 'text', 'NO', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'semantic_topic_membership_events'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership_events'::regclass
      EXCEPT SELECT unnest(ARRAY[
        'semantic_topic_membership_events_pkey','semantic_topic_membership_events_semantic_topic_id_fkey',
        'semantic_topic_membership_events_signal_evidence_id_fkey','semantic_topic_membership_events_related_membership_id_fkey',
        'semantic_topic_membership_eve_related_assignment_decision__fkey',
        'semantic_topic_membership_events_event_type_check','semantic_topic_membership_events_event_reason_check'
      ])
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events has an unexpected extra constraint';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('semantic_topic_membership_events_pkey', 'p'),
        ('semantic_topic_membership_events_semantic_topic_id_fkey', 'f'),
        ('semantic_topic_membership_events_signal_evidence_id_fkey', 'f'),
        ('semantic_topic_membership_events_related_membership_id_fkey', 'f'),
        ('semantic_topic_membership_eve_related_assignment_decision__fkey', 'f'),
        ('semantic_topic_membership_events_event_type_check', 'c'),
        ('semantic_topic_membership_events_event_reason_check', 'c')
      ) AS expected(conname, contype)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.semantic_topic_membership_events'::regclass
          AND c.conname = expected.conname AND c.contype::text = expected.contype
          AND c.convalidated IS true AND c.condeferrable IS false AND c.condeferred IS false
      )
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events constraint set does not match exactly (missing/altered)';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership_events'::regclass AND contype = 'f' AND confdeltype <> 'r'
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events FK ON DELETE action is not RESTRICT';
    END IF;

    IF EXISTS (
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'semantic_topic_membership_events'
      EXCEPT SELECT unnest(ARRAY['semantic_topic_membership_events_pkey','idx_semantic_topic_membership_events_topic','idx_semantic_topic_membership_events_evidence'])
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events has an unexpected extra index';
    END IF;
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('semantic_topic_membership_events_pkey', 'true'),
        ('idx_semantic_topic_membership_events_topic', 'false'),
        ('idx_semantic_topic_membership_events_evidence', 'false')
      ) AS expected(indexname, is_unique)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.semantic_topic_membership_events'::regclass AND c.relname = expected.indexname
          AND ix.indisunique::text = expected.is_unique AND ix.indisvalid IS true AND ix.indisready IS true
      )
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'semantic_topic_membership_events'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'semantic_topic_membership_events') THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topic_membership_events' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topic_membership_events' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'semantic_topic_membership_events' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '073 drift: semantic_topic_membership_events has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '073: semantic_topic_membership_events already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_stme$;

-- ============================================================
-- 4. semantic_topic_membership.assignment_reason -- fail-closed bovites
--    (topic_creation_seed). Csak ISMERT legacy (072) vagy MAR-corrected
--    definiciobol indulhat -- barmilyen mas allapot DEFINITION_DRIFT.
-- ============================================================

DO $migrate_assignment_reason$
DECLARE
  v_current_def text;
  v_legacy_def CONSTANT text := 'CHECK (assignment_reason = ANY (ARRAY[''entity_event_match''::text, ''embedding_similarity''::text, ''manual_review_confirmed''::text, ''manual_review_override''::text]))';
  v_corrected_def CONSTANT text := 'CHECK (assignment_reason = ANY (ARRAY[''entity_event_match''::text, ''embedding_similarity''::text, ''manual_review_confirmed''::text, ''manual_review_override''::text, ''topic_creation_seed''::text]))';
BEGIN
  SELECT pg_get_constraintdef(oid, true) INTO v_current_def
  FROM pg_constraint
  WHERE conrelid = 'public.semantic_topic_membership'::regclass
    AND conname = 'semantic_topic_membership_assignment_reason_check';

  IF v_current_def IS NULL THEN
    RAISE EXCEPTION '073 fail-closed: semantic_topic_membership_assignment_reason_check not found -- expected the 072 baseline to exist. No DDL will run.';
  ELSIF v_current_def = v_corrected_def THEN
    RAISE NOTICE '073: semantic_topic_membership_assignment_reason_check already corrected -- no-op.';
  ELSIF v_current_def = v_legacy_def THEN
    RAISE NOTICE '073: semantic_topic_membership_assignment_reason_check is the known 072 legacy definition -- correcting.';
    ALTER TABLE public.semantic_topic_membership DROP CONSTRAINT semantic_topic_membership_assignment_reason_check;
    ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_assignment_reason_check
      CHECK (assignment_reason IN ('entity_event_match', 'embedding_similarity', 'manual_review_confirmed', 'manual_review_override', 'topic_creation_seed'));

    -- Fail-fast onellenorzes: a friss definicio pontosan a vart corrected szoveg.
    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint
    WHERE conrelid = 'public.semantic_topic_membership'::regclass
      AND conname = 'semantic_topic_membership_assignment_reason_check';
    IF v_current_def <> v_corrected_def THEN
      RAISE EXCEPTION '073 post-alter self-check failed: new assignment_reason definition does not match the expected corrected text exactly (got: %)', v_current_def;
    END IF;
    RAISE NOTICE '073: semantic_topic_membership_assignment_reason_check corrected to include topic_creation_seed.';
  ELSE
    RAISE EXCEPTION '073 fail-closed: DEFINITION_DRIFT -- semantic_topic_membership_assignment_reason_check is neither the known 072 legacy definition nor the corrected definition (got: %). No DDL will run.', v_current_def;
  END IF;
END;
$migrate_assignment_reason$;

-- ============================================================
-- 5. btree_gist extension -- fail-closed, csak ismert hianyallapotbol
-- ============================================================

DO $migrate_btree_gist$
DECLARE
  v_expected_version CONSTANT text := '1.7';
  v_expected_schema CONSTANT text := 'extensions';
  v_ext_exists boolean;
  v_ext_version text;
  v_ext_schema text;
  v_version_available boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') INTO v_ext_exists;

  IF NOT v_ext_exists THEN
    -- Kotelezo elofeltetel-ellenorzes MIELOTT barmilyen DDL futna:
    --   1) a vart 1.7 verzio tenylegesen elerheto ezen a PostgreSQL-
    --      telepitesen (pg_available_extension_versions szerint);
    --   2) a celseme (extensions) letezik;
    --   3) "nincs mar mas semaba telepitve" automatikusan igaz ebben az
    --      agban -- a pg_extension katalogus extname-enkent legfeljebb
    --      EGY sort tarolhat adatbazisonkent (nem lehet ugyanaz az
    --      extension ket kulonbozo semaba telepitve egyszerre), es ide
    --      csak akkor jutunk, ha v_ext_exists mar bizonyitottan false.
    SELECT EXISTS (
      SELECT 1 FROM pg_available_extension_versions WHERE name = 'btree_gist' AND version = v_expected_version
    ) INTO v_version_available;
    IF NOT v_version_available THEN
      RAISE EXCEPTION '073 fail-closed: btree_gist version % is not available on this PostgreSQL installation (per pg_available_extension_versions). No DDL will run.', v_expected_version;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_expected_schema) THEN
      RAISE EXCEPTION '073 fail-closed: target schema % does not exist. No DDL will run.', v_expected_schema;
    END IF;

    RAISE NOTICE '073: btree_gist not installed -- preflight passed (version % available, schema % exists) -- installing.', v_expected_version, v_expected_schema;

    -- A VERSION-klauzula kizarolag szuperfelhasznalonak mukodne (a
    -- production/lokalis 'postgres' role nem az -- lasd a migracio
    -- fejleceben es a kontraktus-dokumentumban szo szerint rogzitett
    -- WARNING-ot) -- csendben figyelmen kivul hagyodna WARNING-gal.
    -- Ezert nem is probaljuk expliciten rogziteni itt; a tenyleges
    -- fail-closed garanciat a telepites UTANI onellenorzes adja, ami a
    -- pontos vart verziot es semat MEGKOVETELI -- barmilyen elteres
    -- eseten RAISE EXCEPTION, ami (mivel a teljes migracio egyetlen
    -- BEGIN/COMMIT tranzakcio) magat a frissen letrehozott extensiont
    -- IS visszagorgeti, nem csak a hibauzenetet dobja el.
    EXECUTE format('CREATE EXTENSION btree_gist WITH SCHEMA %I', v_expected_schema);

    SELECT extversion, extnamespace::regnamespace::text INTO v_ext_version, v_ext_schema
    FROM pg_extension WHERE extname = 'btree_gist';
    IF v_ext_version <> v_expected_version OR v_ext_schema <> v_expected_schema THEN
      RAISE EXCEPTION '073 post-install self-check failed: btree_gist installed as version=% schema=%, expected version=% schema=%', v_ext_version, v_ext_schema, v_expected_version, v_expected_schema;
    END IF;
    RAISE NOTICE '073: btree_gist installed (version=%, schema=%).', v_ext_version, v_ext_schema;
  ELSE
    SELECT extversion, extnamespace::regnamespace::text INTO v_ext_version, v_ext_schema
    FROM pg_extension WHERE extname = 'btree_gist';
    IF v_ext_version <> v_expected_version OR v_ext_schema <> v_expected_schema THEN
      RAISE EXCEPTION '073 fail-closed: btree_gist already installed but version/schema does not match (got version=% schema=%, expected version=% schema=%). Not modifying an existing extension.', v_ext_version, v_ext_schema, v_expected_version, v_expected_schema;
    END IF;
    RAISE NOTICE '073: btree_gist already installed and matches exactly (version=%, schema=%) -- no-op.', v_ext_version, v_ext_schema;
  END IF;
END;
$migrate_btree_gist$;

-- ============================================================
-- 6. Temporal finite-timestamp guard -- fail-closed CREATE/VALIDATE/drift,
--    kotelezo elofeltetel-ellenorzes (nincs letezo nem-veges ertek)
--    MIELOTT barmelyik CHECK hozzaadasra kerulne.
-- ============================================================

DO $migrate_temporal_finite$
DECLARE
  v_bad_count int;
  v_current_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass
      AND conname = 'semantic_topic_membership_valid_from_finite'
  ) THEN
    SELECT count(*) INTO v_bad_count FROM public.semantic_topic_membership WHERE NOT isfinite(valid_from);
    IF v_bad_count > 0 THEN
      RAISE EXCEPTION '073 fail-closed: % existing row(s) have a non-finite valid_from -- cannot safely add the finite-timestamp guard. No DDL will run.', v_bad_count;
    END IF;
    ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_valid_from_finite CHECK (isfinite(valid_from));

    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass AND conname = 'semantic_topic_membership_valid_from_finite';
    IF v_current_def <> 'CHECK (isfinite(valid_from))' THEN
      RAISE EXCEPTION '073 post-add self-check failed: semantic_topic_membership_valid_from_finite definition does not match expected text exactly (got: %)', v_current_def;
    END IF;
    RAISE NOTICE '073: semantic_topic_membership_valid_from_finite added.';
  ELSE
    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass AND conname = 'semantic_topic_membership_valid_from_finite';
    IF v_current_def <> 'CHECK (isfinite(valid_from))' THEN
      RAISE EXCEPTION '073 fail-closed: semantic_topic_membership_valid_from_finite exists but its definition does not match exactly (got: %). No auto-repair.', v_current_def;
    END IF;
    RAISE NOTICE '073: semantic_topic_membership_valid_from_finite already exists and matches exactly -- no-op.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass
      AND conname = 'semantic_topic_membership_valid_to_finite'
  ) THEN
    SELECT count(*) INTO v_bad_count FROM public.semantic_topic_membership WHERE valid_to IS NOT NULL AND NOT isfinite(valid_to);
    IF v_bad_count > 0 THEN
      RAISE EXCEPTION '073 fail-closed: % existing row(s) have a non-finite valid_to -- cannot safely add the finite-timestamp guard. No DDL will run.', v_bad_count;
    END IF;
    ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_valid_to_finite CHECK (valid_to IS NULL OR isfinite(valid_to));

    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass AND conname = 'semantic_topic_membership_valid_to_finite';
    IF v_current_def <> 'CHECK (valid_to IS NULL OR isfinite(valid_to))' THEN
      RAISE EXCEPTION '073 post-add self-check failed: semantic_topic_membership_valid_to_finite definition does not match expected text exactly (got: %)', v_current_def;
    END IF;
    RAISE NOTICE '073: semantic_topic_membership_valid_to_finite added.';
  ELSE
    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass AND conname = 'semantic_topic_membership_valid_to_finite';
    IF v_current_def <> 'CHECK (valid_to IS NULL OR isfinite(valid_to))' THEN
      RAISE EXCEPTION '073 fail-closed: semantic_topic_membership_valid_to_finite exists but its definition does not match exactly (got: %). No auto-repair.', v_current_def;
    END IF;
    RAISE NOTICE '073: semantic_topic_membership_valid_to_finite already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_temporal_finite$;

-- ============================================================
-- 7. Temporal non-overlap EXCLUDE constraint -- kotelezo overlap-precheck
--    ELOTTE, fail-closed CREATE/VALIDATE/drift.
--
-- valid_to=NULL eseten VALODI, PostgreSQL-natív nyitott (unbounded) felso
-- hatart hasznalunk -- tstzrange(valid_from, valid_to, '[)'), NEM egy
-- coalesce-elt 'infinity'::timestamptz sentinel-erteket. A finite-guard
-- (6. blokk) mar garantalja, hogy sem valid_from, sem a kitoltott valid_to
-- nem lehet maga a 'infinity'/'-infinity' literal ertek -- igy a ket
-- vedelem egyutt zarja ki mind az explicit infinity-ertekkel torteno
-- megkerulest, mind azt, hogy a range-tipus implicit sentinel-kent
-- viselkedjen. Ures (empty) range a mar meglevo 072-es
-- `valid_to IS NULL OR valid_to > valid_from` CHECK miatt sosem johet
-- letre (az egyetlen mod egy tstzrange ures allapotara az lenne, ha also
-- >= felso hatar, amit az a CHECK mar kizar).
-- ============================================================

DO $migrate_temporal_exclude$
DECLARE
  v_constraint_exists boolean;
  v_overlap_count int;
  v_current_def text;
  v_expected_def CONSTANT text := 'EXCLUDE USING gist (signal_evidence_id WITH =, tstzrange(valid_from, valid_to, ''[)''::text) WITH &&)';
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass
      AND conname = 'semantic_topic_membership_no_overlap'
  ) INTO v_constraint_exists;

  IF NOT v_constraint_exists THEN
    -- Kotelezo overlap-precheck MIELOTT barmilyen DDL futna.
    SELECT count(*) INTO v_overlap_count
    FROM public.semantic_topic_membership a
    JOIN public.semantic_topic_membership b
      ON a.signal_evidence_id = b.signal_evidence_id AND a.id < b.id
      AND tstzrange(a.valid_from, a.valid_to, '[)')
          && tstzrange(b.valid_from, b.valid_to, '[)');

    IF v_overlap_count > 0 THEN
      RAISE EXCEPTION '073 fail-closed: % overlapping semantic_topic_membership interval pair(s) found for the same signal_evidence_id -- cannot safely add the EXCLUDE constraint over existing invalid data. No DDL will run.', v_overlap_count;
    END IF;

    RAISE NOTICE '073: overlap precheck passed (0 overlapping interval pairs) -- adding EXCLUDE constraint.';
    ALTER TABLE public.semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_no_overlap
      EXCLUDE USING gist (
        signal_evidence_id WITH =,
        tstzrange(valid_from, valid_to, '[)') WITH &&
      );

    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass AND conname = 'semantic_topic_membership_no_overlap';
    IF v_current_def <> v_expected_def THEN
      RAISE EXCEPTION '073 post-add self-check failed: EXCLUDE constraint definition does not match expected text exactly (got: %)', v_current_def;
    END IF;

    RAISE NOTICE '073: semantic_topic_membership_no_overlap EXCLUDE constraint added.';
  ELSE
    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass AND conname = 'semantic_topic_membership_no_overlap';

    IF v_current_def <> v_expected_def THEN
      RAISE EXCEPTION '073 fail-closed: semantic_topic_membership_no_overlap exists but its definition does not match exactly (got: %). No auto-repair.', v_current_def;
    END IF;

    RAISE NOTICE '073: semantic_topic_membership_no_overlap already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_temporal_exclude$;

NOTIFY pgrst, 'reload schema';

COMMIT;
