-- ============================================================
-- Migration 072: Semantic Topic Identity v0 — S1 local schema
-- foundation
--
-- Kanonikus szerzodes forrasa: "PFM Semantic Topic Identity v0 —
-- Final SQL Correctness Correction Gate" (a legmagasabb prioritasu,
-- legutolso jovahagyott specifikacio). Reszletes tartalmi szerzodes:
-- docs/architecture/semantic-topic-identity-v0-contract.md
--
-- HATOKOR (S1 — sema-only, teljesen inert):
--   Pontosan ket uj tabla: semantic_topics, semantic_topic_membership.
--   Nincs event/decision/lineage tabla, nincs RPC, nincs trigger,
--   nincs backfill, nincs adatiras, nincs ALTER egyetlen meglevo
--   tablan sem (sem signal_*, sem Creator Lane, sem legacy V1/V2
--   score objektumon). service_role: SELECT only mindket uj tablan —
--   a jovobeli iras kizarolag egy kesobbi (S2) SECURITY DEFINER
--   RPC-n keresztul tortenik, nem kozvetlen tabla-granton (a
--   069→070 mintat koveti).
--
-- GLOBALIS TOPOLOGIAI KAPU (fail-closed, MINDEN CREATE elott fut):
--   0/2 tabla jelen → mindket blokk CREATE agra fut.
--   2/2 tabla jelen → mindket blokk kizarolag VALIDATE/no-op agra fut.
--   1/2 tabla jelen → RAISE EXCEPTION MEG BARMELY CREATE elott — ez a
--   blokk a ket tablankenti DO-blokk elott fut, igy egy resze-alkalmazott
--   allapot sosem juthat tovabb CREATE-hez.
--
-- A VALIDATE agban SOHA nem fut DDL/DCL — barmilyen oszlop-, constraint-,
-- index-, owner-, RLS-, policy- vagy grant-elteres RAISE EXCEPTION,
-- nincs automatikus javitas, nincs DROP/RECREATE. A migracio masodik
-- lefuttatasa byte-pontos validalt no-op.
--
-- TEMPORAL NON-OVERLAP: S1 kizarolag a "legfeljebb egy AKTIV
-- (valid_to IS NULL) membership evidence-enkent" invariánst
-- garantalja (partial UNIQUE index). A lezart intervallumok teljes
-- atfedes-mentessege NINCS garantalva ebben a korben — ehhez
-- `EXCLUDE USING gist` kellene, ami `btree_gist` extension-t
-- igenyelne. Ez a kepesseg NINCS telepitve, es ez a migracio nem is
-- telepiti. TEMPORAL_NON_OVERLAP = DEFERRED_TO_S2. Mivel S1-ben nincs
-- writer (a service_role csak SELECT-et kap), productionben ebben a
-- korben egyetlen membership-sor sem johet letre.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. GLOBALIS TOPOLOGIAI KAPU
-- ============================================================

DO $topology_gate$
DECLARE
  v_present_count int;
BEGIN
  SELECT count(*) INTO v_present_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('semantic_topics', 'semantic_topic_membership');

  IF v_present_count = 1 THEN
    RAISE EXCEPTION '072 fail-closed: partial topology detected — exactly 1 of 2 semantic topic identity tables exists. No DDL will run. Manual investigation required before this migration can proceed.';
  END IF;

  RAISE NOTICE '072: global topology gate passed (% of 2 tables present).', v_present_count;
END;
$topology_gate$;

-- ============================================================
-- 1. semantic_topics
-- ============================================================

DO $migrate_st$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topics')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    -- ============================================================
    -- A) CREATE BRANCH
    -- ============================================================
    RAISE NOTICE '072: semantic_topics does not exist — CREATE branch.';

    CREATE TABLE public.semantic_topics (
      id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lifecycle_status            TEXT NOT NULL DEFAULT 'candidate_singleton',
      canonical_label             TEXT NOT NULL,
      label_language              TEXT NOT NULL,
      specificity                 TEXT NOT NULL DEFAULT 'unknown',
      creation_request_digest     TEXT NOT NULL,
      status_version              INTEGER NOT NULL DEFAULT 1,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT semantic_topics_creation_request_digest_key UNIQUE (creation_request_digest),
      CONSTRAINT semantic_topics_lifecycle_status_check CHECK (lifecycle_status IN (
        'candidate_singleton', 'corroborating', 'coherent', 'ambiguous',
        'split_required', 'merge_candidate', 'superseded', 'archived'
      )),
      CONSTRAINT semantic_topics_canonical_label_not_blank CHECK (btrim(canonical_label) <> ''),
      CONSTRAINT semantic_topics_specificity_check CHECK (specificity IN ('specific', 'generic', 'unknown')),
      CONSTRAINT semantic_topics_digest_format_check CHECK (creation_request_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT semantic_topics_status_version_positive CHECK (status_version >= 1),
      -- v0-tamogatott kanonikus BCP-47 reszhalmaz — NEM teljes BCP-47
      -- implementacio. Elfogad: 2-3 kisbetus primary subtag (pl. en, hu,
      -- id, und), opcionalis 4-betus Titlecase script subtag (pl. Hans,
      -- Hant), opcionalis 2-betus NAGYBETUS region subtag (pl. BR, TW),
      -- ebben a sorrendben. Elutasit ures stringet, csupa-nagybetus
      -- primary subtagot (ENG), alaljel-elvalasztot (hu_HU), kisbetus
      -- region subtagot (pt-br).
      CONSTRAINT semantic_topics_label_language_format_check CHECK (
        label_language ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'
      ),
      CONSTRAINT semantic_topics_label_language_length_check CHECK (length(label_language) <= 15)
    );

    -- Nincs UNIQUE canonical_label-en, nincs self-FK
    -- (superseded_by_topic_id/split_from_topic_id), nincs writer trigger,
    -- nincs lifecycle RPC, nincs automatikus updated_at trigger — ezt a
    -- fenti hatarok szandekosan zarjak ki. Az updated_at es
    -- status_version viselkedeset egy kesobbi (S2) SECURITY DEFINER
    -- writer RPC fogja tranzakcionalisan kezelni.

    ALTER TABLE public.semantic_topics ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.semantic_topics FORCE ROW LEVEL SECURITY;

    -- SELECT only — a jovobeli iras kizarolag egy kesobbi (S2) SECURITY
    -- DEFINER RPC-n keresztul tortenik, ami postgres-jogosultsaggal ir;
    -- a service_role-nak nincs kozvetlen INSERT/UPDATE/DELETE joga.
    GRANT SELECT ON public.semantic_topics TO service_role;

    RAISE NOTICE '072: semantic_topics created.';
  ELSE
    -- ============================================================
    -- B) VALIDATE/NO-OP BRANCH — SOHA nem fut DDL/DCL.
    -- ============================================================
    RAISE NOTICE '072: semantic_topics already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topics' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topics owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('lifecycle_status', 'text', 'text', 'NO', '''candidate_singleton''::text'),
        ('canonical_label', 'text', 'text', 'NO', NULL),
        ('label_language', 'text', 'text', 'NO', NULL),
        ('specificity', 'text', 'text', 'NO', '''unknown''::text'),
        ('creation_request_digest', 'text', 'text', 'NO', NULL),
        ('status_version', 'integer', 'int4', 'NO', '1'),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('updated_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'semantic_topics'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topics column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('semantic_topics_pkey', 'p', 'PRIMARY KEY (id)'),
        ('semantic_topics_creation_request_digest_key', 'u', 'UNIQUE (creation_request_digest)'),
        ('semantic_topics_lifecycle_status_check', 'c', 'CHECK (lifecycle_status = ANY (ARRAY[''candidate_singleton''::text, ''corroborating''::text, ''coherent''::text, ''ambiguous''::text, ''split_required''::text, ''merge_candidate''::text, ''superseded''::text, ''archived''::text]))'),
        ('semantic_topics_canonical_label_not_blank', 'c', 'CHECK (btrim(canonical_label) <> ''''::text)'),
        ('semantic_topics_specificity_check', 'c', 'CHECK (specificity = ANY (ARRAY[''specific''::text, ''generic''::text, ''unknown''::text]))'),
        ('semantic_topics_digest_format_check', 'c', 'CHECK (creation_request_digest ~ ''^[0-9a-f]{64}$''::text)'),
        ('semantic_topics_status_version_positive', 'c', 'CHECK (status_version >= 1)'),
        ('semantic_topics_label_language_format_check', 'c', 'CHECK (label_language ~ ''^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$''::text)'),
        ('semantic_topics_label_language_length_check', 'c', 'CHECK (length(label_language) <= 15)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.semantic_topics'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topics constraint set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('semantic_topics_pkey', 'true', 'CREATE UNIQUE INDEX semantic_topics_pkey ON public.semantic_topics USING btree (id)'),
        ('semantic_topics_creation_request_digest_key', 'true', 'CREATE UNIQUE INDEX semantic_topics_creation_request_digest_key ON public.semantic_topics USING btree (creation_request_digest)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.semantic_topics'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topics index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'semantic_topics'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topics RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'semantic_topics') THEN
      RAISE EXCEPTION '072 drift: semantic_topics has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topics' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topics' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topics service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'semantic_topics' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topics has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '072: semantic_topics already exists and matches exactly — no-op.';
  END IF;
END;
$migrate_st$;

-- ============================================================
-- 2. semantic_topic_membership (semantic_topic_id FK-t hasznal,
--    ezert a semantic_topics blokk UTAN kell kovetkeznie)
-- ============================================================

DO $migrate_stm$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_membership')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    -- ============================================================
    -- A) CREATE BRANCH
    -- ============================================================
    RAISE NOTICE '072: semantic_topic_membership does not exist — CREATE branch.';

    CREATE TABLE public.semantic_topic_membership (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      semantic_topic_id     UUID NOT NULL REFERENCES public.semantic_topics(id) ON DELETE RESTRICT,
      signal_evidence_id    UUID NOT NULL REFERENCES public.signal_evidence(id) ON DELETE RESTRICT,
      valid_from            TIMESTAMPTZ NOT NULL DEFAULT now(),
      valid_to              TIMESTAMPTZ NULL,
      assignment_reason     TEXT NOT NULL,
      confidence            NUMERIC(5,4) NOT NULL,
      algorithm_version     INTEGER NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT semantic_topic_membership_valid_to_after_valid_from CHECK (valid_to IS NULL OR valid_to > valid_from),
      CONSTRAINT semantic_topic_membership_assignment_reason_check CHECK (assignment_reason IN (
        'entity_event_match', 'embedding_similarity', 'manual_review_confirmed', 'manual_review_override'
      )),
      CONSTRAINT semantic_topic_membership_confidence_range_check CHECK (confidence >= 0 AND confidence <= 1),
      CONSTRAINT semantic_topic_membership_algorithm_version_positive CHECK (algorithm_version >= 1)
    );

    -- Partial UNIQUE — legfeljebb egy AKTIV (valid_to IS NULL) membership
    -- evidence-enkent. Ez NEM garantal teljes temporal atfedes-mentesseget
    -- a lezart intervallumok kozott — ld. a fejlec-magyarazatot
    -- (TEMPORAL_NON_OVERLAP = DEFERRED_TO_S2).
    CREATE UNIQUE INDEX semantic_topic_membership_active_evidence_key
      ON public.semantic_topic_membership (signal_evidence_id) WHERE valid_to IS NULL;

    CREATE INDEX idx_semantic_topic_membership_active_topic
      ON public.semantic_topic_membership (semantic_topic_id) WHERE valid_to IS NULL;

    CREATE INDEX idx_semantic_topic_membership_temporal
      ON public.semantic_topic_membership (semantic_topic_id, valid_from, valid_to);

    ALTER TABLE public.semantic_topic_membership ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.semantic_topic_membership FORCE ROW LEVEL SECURITY;

    -- SELECT only — S1-ben nincs writer, tehat productionben nem
    -- keletkezhet membership-adat ezen a tablan. A jovobeli iras
    -- kizarolag egy kesobbi (S2) SECURITY DEFINER writer RPC-n keresztul
    -- tortenik, kotelezo overlap-check + evidence advisory lock (vagy
    -- kulon jovahagyott exclusion-constraint migracio) utan.
    GRANT SELECT ON public.semantic_topic_membership TO service_role;

    RAISE NOTICE '072: semantic_topic_membership created.';
  ELSE
    -- ============================================================
    -- B) VALIDATE/NO-OP BRANCH — SOHA nem fut DDL/DCL.
    -- ============================================================
    RAISE NOTICE '072: semantic_topic_membership already exists — VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_membership' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topic_membership owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('semantic_topic_id', 'uuid', 'uuid', 'NO', NULL),
        ('signal_evidence_id', 'uuid', 'uuid', 'NO', NULL),
        ('valid_from', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('valid_to', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('assignment_reason', 'text', 'text', 'NO', NULL),
        ('confidence', 'numeric', 'numeric', 'NO', NULL),
        ('algorithm_version', 'integer', 'int4', 'NO', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity,
               numeric_precision, numeric_scale
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'semantic_topic_membership'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
         OR (actual.column_name = 'confidence' AND (actual.numeric_precision IS DISTINCT FROM 5 OR actual.numeric_scale IS DISTINCT FROM 4))
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topic_membership column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('semantic_topic_membership_pkey', 'p', 'PRIMARY KEY (id)'),
        ('semantic_topic_membership_semantic_topic_id_fkey', 'f', 'FOREIGN KEY (semantic_topic_id) REFERENCES semantic_topics(id) ON DELETE RESTRICT'),
        ('semantic_topic_membership_signal_evidence_id_fkey', 'f', 'FOREIGN KEY (signal_evidence_id) REFERENCES signal_evidence(id) ON DELETE RESTRICT'),
        ('semantic_topic_membership_valid_to_after_valid_from', 'c', 'CHECK (valid_to IS NULL OR valid_to > valid_from)'),
        ('semantic_topic_membership_assignment_reason_check', 'c', 'CHECK (assignment_reason = ANY (ARRAY[''entity_event_match''::text, ''embedding_similarity''::text, ''manual_review_confirmed''::text, ''manual_review_override''::text]))'),
        ('semantic_topic_membership_confidence_range_check', 'c', 'CHECK (confidence >= 0::numeric AND confidence <= 1::numeric)'),
        ('semantic_topic_membership_algorithm_version_positive', 'c', 'CHECK (algorithm_version >= 1)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.semantic_topic_membership'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topic_membership constraint set/definition does not match exactly';
    END IF;

    -- FK ON DELETE akciok (RESTRICT mindket iranyban)
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('semantic_topic_membership_semantic_topic_id_fkey', 'r'),
        ('semantic_topic_membership_signal_evidence_id_fkey', 'r')
      ) AS expected(conname, expected_deltype)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
        WHERE cl.relname = 'semantic_topic_membership' AND c.conname = expected.conname AND c.confdeltype = expected.expected_deltype
      )
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topic_membership FK ON DELETE action does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('semantic_topic_membership_pkey', 'true', 'CREATE UNIQUE INDEX semantic_topic_membership_pkey ON public.semantic_topic_membership USING btree (id)'),
        ('semantic_topic_membership_active_evidence_key', 'true', 'CREATE UNIQUE INDEX semantic_topic_membership_active_evidence_key ON public.semantic_topic_membership USING btree (signal_evidence_id) WHERE (valid_to IS NULL)'),
        ('idx_semantic_topic_membership_active_topic', 'false', 'CREATE INDEX idx_semantic_topic_membership_active_topic ON public.semantic_topic_membership USING btree (semantic_topic_id) WHERE (valid_to IS NULL)'),
        ('idx_semantic_topic_membership_temporal', 'false', 'CREATE INDEX idx_semantic_topic_membership_temporal ON public.semantic_topic_membership USING btree (semantic_topic_id, valid_from, valid_to)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.semantic_topic_membership'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topic_membership index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'semantic_topic_membership'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topic_membership RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'semantic_topic_membership') THEN
      RAISE EXCEPTION '072 drift: semantic_topic_membership has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topic_membership' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topic_membership' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topic_membership service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'semantic_topic_membership' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '072 drift: semantic_topic_membership has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '072: semantic_topic_membership already exists and matches exactly — no-op.';
  END IF;
END;
$migrate_stm$;

NOTIFY pgrst, 'reload schema';

COMMIT;
