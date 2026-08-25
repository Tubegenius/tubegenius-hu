-- ============================================================
-- Migration 077: Semantic Topic Identity v0 -- Human-Reviewed
-- Candidate Workflow, schema foundation ONLY (S4A)
--
-- Kanonikus szerzodes forrasa: "PFM Semantic Topic Identity v0 --
-- Human-Reviewed Candidate Workflow -- Local Implementation Phase 1
-- -- Schema Foundation 077" (a Contract Closure Remediation Gate
-- javitasait kovetve). Reszletes tartalmi szerzodes:
-- docs/architecture/semantic-topic-identity-v0-contract.md SS31.
--
-- HATOKOR -- kizarolag SEMA. Negy uj tabla, plusz a mar letezo
-- topic_assignment_decisions_decision_reason_check additiv bovitese
-- ket uj erettekkel. NINCS uj RPC (az a 078-as kor). NINCS
-- record_topic_assignment_decision-modositas -- sem torzse, sem
-- szignaturaja, sem grantjai nem valtoznak, a 0.8500 automatikus
-- kuszob erintetlen. NINCS valodi reviewer bootstrap (a
-- semantic_topic_reviewers/semantic_topic_reviewer_events tablak
-- uresen maradnak ebben a migracioban). NINCS provider-, RPC- vagy
-- alkalmazas-oldali valtozas.
--
-- Negy uj tabla:
--   semantic_topic_reviewers        -- allowlist, kezi provisioning
--   semantic_topic_reviewer_events  -- append-only, reviewer-eletciklus audit
--   topic_assignment_review_requests -- elo allapot, harom-fazisu idempotencia
--   topic_assignment_review_events   -- append-only, request-eletciklus audit
--
-- A 078-as kor fogja hozzaadni a tenyleges RPC-ket
-- (create_topic_assignment_review_request,
-- record_topic_assignment_review_decision,
-- execute_approved_topic_assignment_review,
-- expire_stale_topic_assignment_review_requests, stb.) es a
-- production RLS-en keresztuli iras minden utjat. Eddig a pontig
-- minden negy uj tablan RLS enabled+forced, 0 policy, csak
-- service_role SELECT (ahol egyaltalan van meg iras-elotti SELECT-
-- ertelme) -- kozvetlen DML senkinek, meg service_role-nak sem.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. GLOBALIS TOPOLOGIAI KAPU -- a negy UJ tablara
-- ============================================================

DO $topology_gate$
DECLARE
  v_present_count int;
BEGIN
  SELECT count(*) INTO v_present_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (
      'semantic_topic_reviewers', 'semantic_topic_reviewer_events',
      'topic_assignment_review_requests', 'topic_assignment_review_events'
    );

  IF v_present_count NOT IN (0, 4) THEN
    RAISE EXCEPTION '077 fail-closed: partial topology detected -- % of 4 new tables exist. No DDL will run. Manual investigation required before this migration can proceed.', v_present_count;
  END IF;

  RAISE NOTICE '077: global topology gate passed (% of 4 tables present).', v_present_count;
END;
$topology_gate$;

-- ============================================================
-- 1. semantic_topic_reviewers
-- ============================================================

DO $migrate_str$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_reviewers')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '077: semantic_topic_reviewers does not exist -- CREATE branch.';

    -- Zart beta, egyetlen tulajdonosi reviewer -- v0-ban NINCS
    -- provisioning RPC. Az elso (es minden jovobeli) sor kizarolag
    -- kezi, postgres-privilegizalt INSERT-tel kerul be, ugyanugy,
    -- ahogy a 072-es S1 tablak teszt-fixture-jei is irodnak --
    -- nincs writer RPC, mert v0-ban nincs is ra szukseg. A tenyleges
    -- production bootstrap NEM resze ennek a migracionak -- ez a
    -- migracio uresen hagyja a tablat.
    CREATE TABLE public.semantic_topic_reviewers (
      id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                  UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
      role                     TEXT NOT NULL DEFAULT 'owner',
      active                   BOOLEAN NOT NULL DEFAULT true,
      granted_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      granted_by_user_id       UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
      provisioning_note        TEXT,
      deactivated_at           TIMESTAMPTZ,
      deactivated_by_user_id   UUID REFERENCES auth.users(id) ON DELETE RESTRICT,

      -- v0-ban pontosan egy szerepkor letezik -- bovitendo egy
      -- kesobbi, kulon jovahagyott migracioban, nem talalt-ki ertek
      -- elore felvetelevel.
      CONSTRAINT semantic_topic_reviewers_role_check CHECK (role = 'owner'),
      -- provisioning_note KIZAROLAG leiro szoveg -- SOHA nem
      -- biztonsagi bizonyitek (azt a semantic_topic_reviewer_events
      -- append-only tabla hordozza).
      CONSTRAINT semantic_topic_reviewers_note_length CHECK (provisioning_note IS NULL OR length(provisioning_note) <= 200),
      -- active<->deactivated_at parositas -- explicit IS TRUE/IS FALSE,
      -- hogy egy NULL active soha ne csusszon at egyik agon sem.
      CONSTRAINT semantic_topic_reviewers_active_pairing CHECK (
        (active IS TRUE AND deactivated_at IS NULL AND deactivated_by_user_id IS NULL)
        OR
        (active IS FALSE AND deactivated_at IS NOT NULL AND deactivated_by_user_id IS NOT NULL)
      )
    );

    ALTER TABLE public.semantic_topic_reviewers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.semantic_topic_reviewers FORCE ROW LEVEL SECURITY;

    -- SELECT only -- a 078-as kor RPC-i (SECURITY DEFINER) fogjak
    -- belsoleg olvasni auth.uid()-alapu ellenorzeshez; service_role-nak
    -- sincs kozvetlen INSERT/UPDATE/DELETE joga meg most sem.
    GRANT SELECT ON public.semantic_topic_reviewers TO service_role;

    RAISE NOTICE '077: semantic_topic_reviewers created (empty -- no bootstrap in this migration).';
  ELSE
    RAISE NOTICE '077: semantic_topic_reviewers already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_reviewers' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewers owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('user_id', 'uuid', 'uuid', 'NO', NULL),
        ('role', 'text', 'text', 'NO', '''owner''::text'),
        ('active', 'boolean', 'bool', 'NO', 'true'),
        ('granted_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('granted_by_user_id', 'uuid', 'uuid', 'YES', NULL),
        ('provisioning_note', 'text', 'text', 'YES', NULL),
        ('deactivated_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('deactivated_by_user_id', 'uuid', 'uuid', 'YES', NULL)
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewers'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewers column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.semantic_topic_reviewers'::regclass
      EXCEPT SELECT unnest(ARRAY[
        'semantic_topic_reviewers_pkey','semantic_topic_reviewers_user_id_key',
        'semantic_topic_reviewers_user_id_fkey','semantic_topic_reviewers_granted_by_user_id_fkey',
        'semantic_topic_reviewers_deactivated_by_user_id_fkey',
        'semantic_topic_reviewers_role_check','semantic_topic_reviewers_note_length',
        'semantic_topic_reviewers_active_pairing'
      ])
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewers has an unexpected extra constraint';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('semantic_topic_reviewers_pkey', 'p'),
        ('semantic_topic_reviewers_user_id_key', 'u'),
        ('semantic_topic_reviewers_user_id_fkey', 'f'),
        ('semantic_topic_reviewers_granted_by_user_id_fkey', 'f'),
        ('semantic_topic_reviewers_deactivated_by_user_id_fkey', 'f'),
        ('semantic_topic_reviewers_role_check', 'c'),
        ('semantic_topic_reviewers_note_length', 'c'),
        ('semantic_topic_reviewers_active_pairing', 'c')
      ) AS expected(conname, contype)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.semantic_topic_reviewers'::regclass
          AND c.conname = expected.conname AND c.contype::text = expected.contype
          AND c.convalidated IS true AND c.condeferrable IS false AND c.condeferred IS false
      )
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewers constraint set does not match exactly (missing/altered)';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.semantic_topic_reviewers'::regclass AND contype = 'f' AND confdeltype <> 'r'
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewers FK ON DELETE action is not RESTRICT';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'semantic_topic_reviewers'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewers RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'semantic_topic_reviewers') THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewers has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewers' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewers' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewers service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewers' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewers has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '077: semantic_topic_reviewers already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_str$;

-- ============================================================
-- 2. semantic_topic_reviewer_events (append-only reviewer-eletciklus audit)
-- ============================================================

DO $migrate_stre$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_reviewer_events')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '077: semantic_topic_reviewer_events does not exist -- CREATE branch.';

    CREATE TABLE public.semantic_topic_reviewer_events (
      id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reviewer_id                     UUID NOT NULL REFERENCES public.semantic_topic_reviewers(id) ON DELETE RESTRICT,
      reviewer_user_id                UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      event_type                      TEXT NOT NULL,
      -- actor_user_id NULL kizarolag postgres_bootstrap-nal --
      -- minden mas eseten (jovobeli, authenticated-uton hivott
      -- deactivate/reactivate RPC-k, 078+) az auth.uid()-bol szarmazo
      -- valodi szemely.
      actor_user_id                   UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
      actor_kind                      TEXT NOT NULL,
      authorization_policy_version    INTEGER NOT NULL,
      previous_active                 BOOLEAN,
      new_active                      BOOLEAN NOT NULL,
      created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT semantic_topic_reviewer_events_event_type_check CHECK (event_type IN ('granted', 'deactivated', 'reactivated')),
      CONSTRAINT semantic_topic_reviewer_events_actor_kind_check CHECK (actor_kind IN ('postgres_bootstrap', 'authenticated_reviewer')),
      CONSTRAINT semantic_topic_reviewer_events_policy_version_positive CHECK (authorization_policy_version >= 1),
      -- actor_kind<->actor_user_id parositas -- explicit IS NULL/IS NOT NULL.
      CONSTRAINT semantic_topic_reviewer_events_actor_pairing CHECK (
        (actor_kind = 'postgres_bootstrap' AND actor_user_id IS NULL)
        OR
        (actor_kind = 'authenticated_reviewer' AND actor_user_id IS NOT NULL)
      ),
      -- event_type<->previous_active/new_active parositas -- egyertelmu
      -- allapotatmenet minden esemenytipusnal, explicit IS TRUE/IS FALSE/IS NULL.
      CONSTRAINT semantic_topic_reviewer_events_transition_pairing CHECK (
        (event_type = 'granted' AND previous_active IS NULL AND new_active IS TRUE)
        OR
        (event_type = 'deactivated' AND previous_active IS TRUE AND new_active IS FALSE)
        OR
        (event_type = 'reactivated' AND previous_active IS FALSE AND new_active IS TRUE)
      )
    );

    CREATE INDEX idx_semantic_topic_reviewer_events_reviewer ON public.semantic_topic_reviewer_events (reviewer_id);

    ALTER TABLE public.semantic_topic_reviewer_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.semantic_topic_reviewer_events FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.semantic_topic_reviewer_events TO service_role;

    RAISE NOTICE '077: semantic_topic_reviewer_events created.';
  ELSE
    RAISE NOTICE '077: semantic_topic_reviewer_events already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_reviewer_events' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('reviewer_id', 'uuid', 'uuid', 'NO', NULL),
        ('reviewer_user_id', 'uuid', 'uuid', 'NO', NULL),
        ('event_type', 'text', 'text', 'NO', NULL),
        ('actor_user_id', 'uuid', 'uuid', 'YES', NULL),
        ('actor_kind', 'text', 'text', 'NO', NULL),
        ('authorization_policy_version', 'integer', 'int4', 'NO', NULL),
        ('previous_active', 'boolean', 'bool', 'YES', NULL),
        ('new_active', 'boolean', 'bool', 'NO', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewer_events'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.semantic_topic_reviewer_events'::regclass
      EXCEPT SELECT unnest(ARRAY[
        'semantic_topic_reviewer_events_pkey','semantic_topic_reviewer_events_reviewer_id_fkey',
        'semantic_topic_reviewer_events_reviewer_user_id_fkey','semantic_topic_reviewer_events_actor_user_id_fkey',
        'semantic_topic_reviewer_events_event_type_check','semantic_topic_reviewer_events_actor_kind_check',
        'semantic_topic_reviewer_events_policy_version_positive','semantic_topic_reviewer_events_actor_pairing',
        'semantic_topic_reviewer_events_transition_pairing'
      ])
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events has an unexpected extra constraint';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('semantic_topic_reviewer_events_pkey', 'p'),
        ('semantic_topic_reviewer_events_reviewer_id_fkey', 'f'),
        ('semantic_topic_reviewer_events_reviewer_user_id_fkey', 'f'),
        ('semantic_topic_reviewer_events_actor_user_id_fkey', 'f'),
        ('semantic_topic_reviewer_events_event_type_check', 'c'),
        ('semantic_topic_reviewer_events_actor_kind_check', 'c'),
        ('semantic_topic_reviewer_events_policy_version_positive', 'c'),
        ('semantic_topic_reviewer_events_actor_pairing', 'c'),
        ('semantic_topic_reviewer_events_transition_pairing', 'c')
      ) AS expected(conname, contype)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.semantic_topic_reviewer_events'::regclass
          AND c.conname = expected.conname AND c.contype::text = expected.contype
          AND c.convalidated IS true AND c.condeferrable IS false AND c.condeferred IS false
      )
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events constraint set does not match exactly (missing/altered)';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.semantic_topic_reviewer_events'::regclass AND contype = 'f' AND confdeltype <> 'r'
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events FK ON DELETE action is not RESTRICT';
    END IF;

    IF EXISTS (
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'semantic_topic_reviewer_events'
      EXCEPT SELECT unnest(ARRAY['semantic_topic_reviewer_events_pkey','idx_semantic_topic_reviewer_events_reviewer'])
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events has an unexpected extra index';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'semantic_topic_reviewer_events'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'semantic_topic_reviewer_events') THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewer_events' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewer_events' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewer_events' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '077 drift: semantic_topic_reviewer_events has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '077: semantic_topic_reviewer_events already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_stre$;

-- ============================================================
-- 3. topic_assignment_review_requests
-- ============================================================

DO $migrate_tarr$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_assignment_review_requests')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '077: topic_assignment_review_requests does not exist -- CREATE branch.';

    CREATE TABLE public.topic_assignment_review_requests (
      id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      extraction_run_id             UUID NOT NULL REFERENCES public.topic_extraction_runs(id) ON DELETE RESTRICT,
      generation                    INTEGER NOT NULL,
      status                        TEXT NOT NULL DEFAULT 'pending',

      -- --- 1. fazis: request-letrehozas idempotencia ---
      request_idempotency_key       TEXT NOT NULL,
      request_operation_digest      TEXT NOT NULL,
      requested_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at                    TIMESTAMPTZ NOT NULL,
      -- az immutabilis extraction-payload digest -- a 078-as
      -- create-RPC szerver-oldalon epiti a tarolt structured_output-bol,
      -- sosem a hivotol elfogadva.
      request_payload_digest        TEXT NOT NULL,

      -- --- 2. fazis: reviewer-dontes -- strukturalt topic-judgment ---
      decision_idempotency_key      TEXT,
      decision_operation_digest     TEXT,
      reviewer_user_id              UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
      reviewer_role_snapshot        TEXT,
      decided_at                    TIMESTAMPTZ,
      canonical_topic_label         TEXT,
      topic_definition              TEXT,
      scope                         TEXT,
      inclusion_criteria            TEXT,
      exclusion_criteria            TEXT,
      lane_neutral_confirmed        BOOLEAN,
      evidence_adequacy             TEXT,
      duplicate_search_outcome      TEXT,
      proposed_outcome              TEXT,
      target_semantic_topic_id      UUID REFERENCES public.semantic_topics(id) ON DELETE RESTRICT,
      uncertainty_classification    TEXT,
      reviewer_rationale            TEXT,
      review_policy_version         INTEGER,
      rejection_reason              TEXT,
      approval_digest                TEXT,
      approval_digest_version        INTEGER,

      -- --- 3. fazis: vegrehajtas (a tenyleges RPC csak 078-ban) ---
      execution_idempotency_key     TEXT,
      execution_operation_digest    TEXT,
      executed_at                   TIMESTAMPTZ,
      -- egyarant hasznalja 'rejected' (a 078-as kor atomikusan ide
      -- irja a QUARANTINE-decisiont) ES 'executed' (CREATE_NEW/
      -- ATTACH_EXISTING) statusz -- l. a fejlec-magyarazatot.
      resulting_decision_id         UUID REFERENCES public.topic_assignment_decisions(id) ON DELETE RESTRICT,

      -- --- cancel / revoke ---
      cancelled_at                  TIMESTAMPTZ,
      cancelled_by_user_id          UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
      revoked_at            TIMESTAMPTZ,
      revoked_by_user_id    UUID REFERENCES auth.users(id) ON DELETE RESTRICT,

      CONSTRAINT topic_assignment_review_requests_generation_key UNIQUE (extraction_run_id, generation),
      CONSTRAINT topic_assignment_review_requests_generation_positive CHECK (generation >= 1),
      CONSTRAINT topic_assignment_review_requests_status_check CHECK (status IN (
        'pending', 'approved', 'rejected', 'expired', 'cancelled', 'revoked', 'executed'
      )),
      CONSTRAINT topic_assignment_review_requests_request_key_key UNIQUE (request_idempotency_key),
      CONSTRAINT topic_assignment_review_requests_role_check CHECK (reviewer_role_snapshot IS NULL OR reviewer_role_snapshot = 'owner'),
      CONSTRAINT topic_assignment_review_requests_label_length CHECK (canonical_topic_label IS NULL OR length(canonical_topic_label) <= 200),
      CONSTRAINT topic_assignment_review_requests_definition_length CHECK (topic_definition IS NULL OR length(topic_definition) <= 1000),
      CONSTRAINT topic_assignment_review_requests_scope_length CHECK (scope IS NULL OR length(scope) <= 1000),
      CONSTRAINT topic_assignment_review_requests_inclusion_length CHECK (inclusion_criteria IS NULL OR length(inclusion_criteria) <= 1000),
      CONSTRAINT topic_assignment_review_requests_exclusion_length CHECK (exclusion_criteria IS NULL OR length(exclusion_criteria) <= 1000),
      CONSTRAINT topic_assignment_review_requests_adequacy_check CHECK (evidence_adequacy IS NULL OR evidence_adequacy IN ('adequate', 'marginal')),
      CONSTRAINT topic_assignment_review_requests_dup_search_check CHECK (
        duplicate_search_outcome IS NULL OR duplicate_search_outcome IN ('no_duplicate_found', 'possible_duplicate_reviewed_and_distinct')
      ),
      CONSTRAINT topic_assignment_review_requests_proposed_outcome_check CHECK (proposed_outcome IS NULL OR proposed_outcome IN ('CREATE_NEW', 'ATTACH_EXISTING')),
      CONSTRAINT topic_assignment_review_requests_uncertainty_check CHECK (uncertainty_classification IS NULL OR uncertainty_classification IN ('low', 'medium', 'high')),
      CONSTRAINT topic_assignment_review_requests_rationale_length CHECK (reviewer_rationale IS NULL OR length(reviewer_rationale) <= 1000),
      CONSTRAINT topic_assignment_review_requests_policy_version_positive CHECK (review_policy_version IS NULL OR review_policy_version >= 1),
      CONSTRAINT topic_assignment_review_requests_rejection_reason_check CHECK (rejection_reason IS NULL OR rejection_reason IN (
        'insufficient_evidence', 'invalid_topic_identity', 'not_lane_neutral',
        'malformed_candidate', 'duplicate_without_valid_target', 'other_review_rejection'
      )),
      CONSTRAINT topic_assignment_review_requests_digest_version_positive CHECK (approval_digest_version IS NULL OR approval_digest_version >= 1),

      -- CREATE_NEW/ATTACH_EXISTING kondicionalis target-check -- IS
      -- DISTINCT FROM, hogy egy meg-nem-dontott (proposed_outcome
      -- IS NULL) soron sose triggerelodjon.
      CONSTRAINT topic_assignment_review_requests_create_new_no_target CHECK (proposed_outcome IS DISTINCT FROM 'CREATE_NEW' OR target_semantic_topic_id IS NULL),
      CONSTRAINT topic_assignment_review_requests_attach_requires_target CHECK (proposed_outcome IS DISTINCT FROM 'ATTACH_EXISTING' OR target_semantic_topic_id IS NOT NULL),

      -- --- statuszonkenti mezo-teljesseg -- explicit IS NULL/IS NOT
      -- NULL/IS TRUE/IS FALSE mindenutt, hogy egy NULL/UNKNOWN
      -- sose engedjen at hianyos sort. ---

      CONSTRAINT topic_assignment_review_requests_pending_fields_empty CHECK (
        status <> 'pending' OR (
          reviewer_user_id IS NULL AND reviewer_role_snapshot IS NULL AND decided_at IS NULL AND
          canonical_topic_label IS NULL AND topic_definition IS NULL AND scope IS NULL AND
          inclusion_criteria IS NULL AND exclusion_criteria IS NULL AND lane_neutral_confirmed IS NULL AND
          evidence_adequacy IS NULL AND duplicate_search_outcome IS NULL AND proposed_outcome IS NULL AND
          target_semantic_topic_id IS NULL AND uncertainty_classification IS NULL AND reviewer_rationale IS NULL AND
          review_policy_version IS NULL AND rejection_reason IS NULL AND
          approval_digest IS NULL AND approval_digest_version IS NULL AND
          decision_idempotency_key IS NULL AND decision_operation_digest IS NULL AND
          executed_at IS NULL AND resulting_decision_id IS NULL AND
          execution_idempotency_key IS NULL AND execution_operation_digest IS NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND
          revoked_at IS NULL AND revoked_by_user_id IS NULL
        )
      ),

      CONSTRAINT topic_assignment_review_requests_approved_fields_required CHECK (
        status <> 'approved' OR (
          reviewer_user_id IS NOT NULL AND reviewer_role_snapshot IS NOT NULL AND decided_at IS NOT NULL AND
          canonical_topic_label IS NOT NULL AND topic_definition IS NOT NULL AND scope IS NOT NULL AND
          inclusion_criteria IS NOT NULL AND exclusion_criteria IS NOT NULL AND
          lane_neutral_confirmed IS TRUE AND
          evidence_adequacy = 'adequate' AND
          duplicate_search_outcome IS NOT NULL AND
          proposed_outcome IS NOT NULL AND
          uncertainty_classification IS NOT NULL AND reviewer_rationale IS NOT NULL AND
          review_policy_version IS NOT NULL AND
          approval_digest IS NOT NULL AND approval_digest_version IS NOT NULL AND
          decision_idempotency_key IS NOT NULL AND decision_operation_digest IS NOT NULL AND
          rejection_reason IS NULL AND
          executed_at IS NULL AND resulting_decision_id IS NULL AND
          execution_idempotency_key IS NULL AND execution_operation_digest IS NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND
          revoked_at IS NULL AND revoked_by_user_id IS NULL
        )
      ),

      -- Rejected: csak a szuk, valoban kotelezo mezokeszlet -- a
      -- teljes topic-judgment mezok (canonical_topic_label stb.)
      -- SZANDEKOSAN nincsenek sem kotelezove, sem tiltva teve, hogy
      -- egy "nincs ervenyes topic identity" indoku elutasitasnal a
      -- reviewer ne legyen kenyszeritve hamis definiciora.
      CONSTRAINT topic_assignment_review_requests_rejected_fields_required CHECK (
        status <> 'rejected' OR (
          reviewer_user_id IS NOT NULL AND reviewer_role_snapshot IS NOT NULL AND decided_at IS NOT NULL AND
          rejection_reason IS NOT NULL AND reviewer_rationale IS NOT NULL AND review_policy_version IS NOT NULL AND
          resulting_decision_id IS NOT NULL AND
          decision_idempotency_key IS NOT NULL AND decision_operation_digest IS NOT NULL AND
          approval_digest IS NULL AND approval_digest_version IS NULL AND
          executed_at IS NULL AND
          execution_idempotency_key IS NULL AND execution_operation_digest IS NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND
          revoked_at IS NULL AND revoked_by_user_id IS NULL
        )
      ),

      CONSTRAINT topic_assignment_review_requests_expired_fields_empty CHECK (
        status <> 'expired' OR (
          reviewer_user_id IS NULL AND decided_at IS NULL AND approval_digest IS NULL AND
          rejection_reason IS NULL AND resulting_decision_id IS NULL AND executed_at IS NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND
          revoked_at IS NULL AND revoked_by_user_id IS NULL
        )
      ),

      CONSTRAINT topic_assignment_review_requests_cancelled_fields CHECK (
        status <> 'cancelled' OR (
          cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND
          reviewer_user_id IS NULL AND decided_at IS NULL AND approval_digest IS NULL AND
          rejection_reason IS NULL AND resulting_decision_id IS NULL AND
          executed_at IS NULL AND revoked_at IS NULL AND revoked_by_user_id IS NULL
        )
      ),

      -- Revoked: az eredeti approval-pillanatkep (beleertve az
      -- approval_digestet) MEGMARAD -- csak a statusz es a revoke-
      -- jelolok valtoznak. Ez a korabbi, hibas tervet javitja ki.
      CONSTRAINT topic_assignment_review_requests_revoked_fields CHECK (
        status <> 'revoked' OR (
          reviewer_user_id IS NOT NULL AND reviewer_role_snapshot IS NOT NULL AND decided_at IS NOT NULL AND
          canonical_topic_label IS NOT NULL AND topic_definition IS NOT NULL AND scope IS NOT NULL AND
          inclusion_criteria IS NOT NULL AND exclusion_criteria IS NOT NULL AND
          lane_neutral_confirmed IS TRUE AND evidence_adequacy = 'adequate' AND
          duplicate_search_outcome IS NOT NULL AND proposed_outcome IS NOT NULL AND
          uncertainty_classification IS NOT NULL AND reviewer_rationale IS NOT NULL AND
          review_policy_version IS NOT NULL AND
          approval_digest IS NOT NULL AND approval_digest_version IS NOT NULL AND
          decision_idempotency_key IS NOT NULL AND decision_operation_digest IS NOT NULL AND
          revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND
          rejection_reason IS NULL AND
          executed_at IS NULL AND resulting_decision_id IS NULL AND
          execution_idempotency_key IS NULL AND execution_operation_digest IS NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL
        )
      ),

      -- Executed: ugyanaz az approval-pillanatkep megorizve, plusz
      -- a vegrehajtas mezoi kotelezoek.
      CONSTRAINT topic_assignment_review_requests_executed_fields CHECK (
        status <> 'executed' OR (
          reviewer_user_id IS NOT NULL AND reviewer_role_snapshot IS NOT NULL AND decided_at IS NOT NULL AND
          canonical_topic_label IS NOT NULL AND topic_definition IS NOT NULL AND scope IS NOT NULL AND
          inclusion_criteria IS NOT NULL AND exclusion_criteria IS NOT NULL AND
          lane_neutral_confirmed IS TRUE AND evidence_adequacy = 'adequate' AND
          duplicate_search_outcome IS NOT NULL AND proposed_outcome IS NOT NULL AND
          uncertainty_classification IS NOT NULL AND reviewer_rationale IS NOT NULL AND
          review_policy_version IS NOT NULL AND
          approval_digest IS NOT NULL AND approval_digest_version IS NOT NULL AND
          decision_idempotency_key IS NOT NULL AND decision_operation_digest IS NOT NULL AND
          executed_at IS NOT NULL AND resulting_decision_id IS NOT NULL AND
          execution_idempotency_key IS NOT NULL AND execution_operation_digest IS NOT NULL AND
          rejection_reason IS NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND
          revoked_at IS NULL AND revoked_by_user_id IS NULL
        )
      )
    );

    -- Legfeljebb EGY elo (pending/approved) request/run -- 072
    -- precedens (semantic_topic_membership_active_evidence_key)
    -- mintajara, partial unique index.
    CREATE UNIQUE INDEX idx_topic_assignment_review_requests_one_live_per_run
      ON public.topic_assignment_review_requests (extraction_run_id) WHERE status IN ('pending', 'approved');

    -- decision_idempotency_key/execution_idempotency_key csak
    -- decision-tol/execution-tol kezdve toltodik -- partial unique
    -- index, hogy NULL-ok sose utkozzenek egymassal.
    CREATE UNIQUE INDEX idx_topic_assignment_review_requests_decision_key_unique
      ON public.topic_assignment_review_requests (decision_idempotency_key) WHERE decision_idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX idx_topic_assignment_review_requests_execution_key_unique
      ON public.topic_assignment_review_requests (execution_idempotency_key) WHERE execution_idempotency_key IS NOT NULL;

    CREATE INDEX idx_topic_assignment_review_requests_status ON public.topic_assignment_review_requests (status);
    CREATE INDEX idx_topic_assignment_review_requests_target_topic ON public.topic_assignment_review_requests (target_semantic_topic_id) WHERE target_semantic_topic_id IS NOT NULL;

    ALTER TABLE public.topic_assignment_review_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.topic_assignment_review_requests FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.topic_assignment_review_requests TO service_role;

    RAISE NOTICE '077: topic_assignment_review_requests created.';
  ELSE
    RAISE NOTICE '077: topic_assignment_review_requests already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_assignment_review_requests' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('extraction_run_id', 'uuid', 'uuid', 'NO', NULL),
        ('generation', 'integer', 'int4', 'NO', NULL),
        ('status', 'text', 'text', 'NO', '''pending''::text'),
        ('request_idempotency_key', 'text', 'text', 'NO', NULL),
        ('request_operation_digest', 'text', 'text', 'NO', NULL),
        ('requested_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('expires_at', 'timestamp with time zone', 'timestamptz', 'NO', NULL),
        ('request_payload_digest', 'text', 'text', 'NO', NULL),
        ('decision_idempotency_key', 'text', 'text', 'YES', NULL),
        ('decision_operation_digest', 'text', 'text', 'YES', NULL),
        ('reviewer_user_id', 'uuid', 'uuid', 'YES', NULL),
        ('reviewer_role_snapshot', 'text', 'text', 'YES', NULL),
        ('decided_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('canonical_topic_label', 'text', 'text', 'YES', NULL),
        ('topic_definition', 'text', 'text', 'YES', NULL),
        ('scope', 'text', 'text', 'YES', NULL),
        ('inclusion_criteria', 'text', 'text', 'YES', NULL),
        ('exclusion_criteria', 'text', 'text', 'YES', NULL),
        ('lane_neutral_confirmed', 'boolean', 'bool', 'YES', NULL),
        ('evidence_adequacy', 'text', 'text', 'YES', NULL),
        ('duplicate_search_outcome', 'text', 'text', 'YES', NULL),
        ('proposed_outcome', 'text', 'text', 'YES', NULL),
        ('target_semantic_topic_id', 'uuid', 'uuid', 'YES', NULL),
        ('uncertainty_classification', 'text', 'text', 'YES', NULL),
        ('reviewer_rationale', 'text', 'text', 'YES', NULL),
        ('review_policy_version', 'integer', 'int4', 'YES', NULL),
        ('rejection_reason', 'text', 'text', 'YES', NULL),
        ('approval_digest', 'text', 'text', 'YES', NULL),
        ('approval_digest_version', 'integer', 'int4', 'YES', NULL),
        ('execution_idempotency_key', 'text', 'text', 'YES', NULL),
        ('execution_operation_digest', 'text', 'text', 'YES', NULL),
        ('executed_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('resulting_decision_id', 'uuid', 'uuid', 'YES', NULL),
        ('cancelled_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('cancelled_by_user_id', 'uuid', 'uuid', 'YES', NULL),
        ('revoked_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('revoked_by_user_id', 'uuid', 'uuid', 'YES', NULL)
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'topic_assignment_review_requests'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.topic_assignment_review_requests'::regclass
      EXCEPT SELECT unnest(ARRAY[
        'topic_assignment_review_requests_pkey',
        'topic_assignment_review_requests_extraction_run_id_fkey',
        'topic_assignment_review_requests_target_semantic_topic_id_fkey',
        'topic_assignment_review_requests_reviewer_user_id_fkey',
        'topic_assignment_review_requests_cancelled_by_user_id_fkey',
        'topic_assignment_review_requests_revoked_by_user_id_fkey',
        'topic_assignment_review_requests_resulting_decision_id_fkey',
        'topic_assignment_review_requests_generation_key',
        'topic_assignment_review_requests_generation_positive',
        'topic_assignment_review_requests_status_check',
        'topic_assignment_review_requests_request_key_key',
        'topic_assignment_review_requests_role_check',
        'topic_assignment_review_requests_label_length',
        'topic_assignment_review_requests_definition_length',
        'topic_assignment_review_requests_scope_length',
        'topic_assignment_review_requests_inclusion_length',
        'topic_assignment_review_requests_exclusion_length',
        'topic_assignment_review_requests_adequacy_check',
        'topic_assignment_review_requests_dup_search_check',
        'topic_assignment_review_requests_proposed_outcome_check',
        'topic_assignment_review_requests_uncertainty_check',
        'topic_assignment_review_requests_rationale_length',
        'topic_assignment_review_requests_policy_version_positive',
        'topic_assignment_review_requests_rejection_reason_check',
        'topic_assignment_review_requests_digest_version_positive',
        'topic_assignment_review_requests_create_new_no_target',
        'topic_assignment_review_requests_attach_requires_target',
        'topic_assignment_review_requests_pending_fields_empty',
        'topic_assignment_review_requests_approved_fields_required',
        'topic_assignment_review_requests_rejected_fields_required',
        'topic_assignment_review_requests_expired_fields_empty',
        'topic_assignment_review_requests_cancelled_fields',
        'topic_assignment_review_requests_revoked_fields',
        'topic_assignment_review_requests_executed_fields'
      ])
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests has an unexpected extra constraint';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('topic_assignment_review_requests_pkey', 'p'),
        ('topic_assignment_review_requests_extraction_run_id_fkey', 'f'),
        ('topic_assignment_review_requests_target_semantic_topic_id_fkey', 'f'),
        ('topic_assignment_review_requests_reviewer_user_id_fkey', 'f'),
        ('topic_assignment_review_requests_cancelled_by_user_id_fkey', 'f'),
        ('topic_assignment_review_requests_revoked_by_user_id_fkey', 'f'),
        ('topic_assignment_review_requests_resulting_decision_id_fkey', 'f'),
        ('topic_assignment_review_requests_generation_key', 'u'),
        ('topic_assignment_review_requests_generation_positive', 'c'),
        ('topic_assignment_review_requests_status_check', 'c'),
        ('topic_assignment_review_requests_request_key_key', 'u'),
        ('topic_assignment_review_requests_role_check', 'c'),
        ('topic_assignment_review_requests_label_length', 'c'),
        ('topic_assignment_review_requests_definition_length', 'c'),
        ('topic_assignment_review_requests_scope_length', 'c'),
        ('topic_assignment_review_requests_inclusion_length', 'c'),
        ('topic_assignment_review_requests_exclusion_length', 'c'),
        ('topic_assignment_review_requests_adequacy_check', 'c'),
        ('topic_assignment_review_requests_dup_search_check', 'c'),
        ('topic_assignment_review_requests_proposed_outcome_check', 'c'),
        ('topic_assignment_review_requests_uncertainty_check', 'c'),
        ('topic_assignment_review_requests_rationale_length', 'c'),
        ('topic_assignment_review_requests_policy_version_positive', 'c'),
        ('topic_assignment_review_requests_rejection_reason_check', 'c'),
        ('topic_assignment_review_requests_digest_version_positive', 'c'),
        ('topic_assignment_review_requests_create_new_no_target', 'c'),
        ('topic_assignment_review_requests_attach_requires_target', 'c'),
        ('topic_assignment_review_requests_pending_fields_empty', 'c'),
        ('topic_assignment_review_requests_approved_fields_required', 'c'),
        ('topic_assignment_review_requests_rejected_fields_required', 'c'),
        ('topic_assignment_review_requests_expired_fields_empty', 'c'),
        ('topic_assignment_review_requests_cancelled_fields', 'c'),
        ('topic_assignment_review_requests_revoked_fields', 'c'),
        ('topic_assignment_review_requests_executed_fields', 'c')
      ) AS expected(conname, contype)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.topic_assignment_review_requests'::regclass
          AND c.conname = expected.conname AND c.contype::text = expected.contype
          AND c.convalidated IS true AND c.condeferrable IS false AND c.condeferred IS false
      )
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests constraint set does not match exactly (missing/altered)';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.topic_assignment_review_requests'::regclass AND contype = 'f' AND confdeltype <> 'r'
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests FK ON DELETE action is not RESTRICT';
    END IF;

    IF EXISTS (
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'topic_assignment_review_requests'
      EXCEPT SELECT unnest(ARRAY[
        'topic_assignment_review_requests_pkey','topic_assignment_review_requests_generation_key',
        'topic_assignment_review_requests_request_key_key',
        'idx_topic_assignment_review_requests_one_live_per_run',
        'idx_topic_assignment_review_requests_decision_key_unique',
        'idx_topic_assignment_review_requests_execution_key_unique',
        'idx_topic_assignment_review_requests_status',
        'idx_topic_assignment_review_requests_target_topic'
      ])
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests has an unexpected extra index';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
      WHERE ix.indrelid = 'public.topic_assignment_review_requests'::regclass AND c.relname = 'idx_topic_assignment_review_requests_one_live_per_run'
        AND ix.indisunique IS TRUE AND ix.indisvalid IS TRUE AND ix.indisready IS TRUE
        AND pg_get_indexdef(ix.indexrelid) = 'CREATE UNIQUE INDEX idx_topic_assignment_review_requests_one_live_per_run ON public.topic_assignment_review_requests USING btree (extraction_run_id) WHERE (status = ANY (ARRAY[''pending''::text, ''approved''::text]))'
    ) THEN
      RAISE EXCEPTION '077 drift: idx_topic_assignment_review_requests_one_live_per_run does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'topic_assignment_review_requests'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'topic_assignment_review_requests') THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'topic_assignment_review_requests' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'topic_assignment_review_requests' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'topic_assignment_review_requests' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_requests has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '077: topic_assignment_review_requests already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_tarr$;

-- ============================================================
-- 4. topic_assignment_review_events (append-only request-eletciklus audit)
-- ============================================================

DO $migrate_tare$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_assignment_review_events')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '077: topic_assignment_review_events does not exist -- CREATE branch.';

    CREATE TABLE public.topic_assignment_review_events (
      id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      review_request_id        UUID NOT NULL REFERENCES public.topic_assignment_review_requests(id) ON DELETE RESTRICT,
      event_type                TEXT NOT NULL,
      actor_user_id             UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
      actor_kind                TEXT NOT NULL,
      policy_version             INTEGER NOT NULL,
      -- a hozzatartozo fazis operation/state-transition digestje --
      -- melyik mezo toltodik, a event_type dontii el (a 078-as RPC-k
      -- felelossege, itt csak a tarolohely keszul elo).
      operation_digest           TEXT,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT topic_assignment_review_events_event_type_check CHECK (event_type IN (
        'requested', 'approved', 'rejected', 'expired', 'cancelled', 'revoked', 'executed'
      )),
      CONSTRAINT topic_assignment_review_events_actor_kind_check CHECK (actor_kind IN ('postgres_bootstrap', 'service_role_system', 'authenticated_reviewer')),
      CONSTRAINT topic_assignment_review_events_policy_version_positive CHECK (policy_version >= 1),
      -- 'requested' es 'expired' esemeny rendszer-generalt lehet
      -- (nincs emberi actor); minden mas esemenynel valodi szemely
      -- kell -- explicit IS NULL/IS NOT NULL parositas.
      CONSTRAINT topic_assignment_review_events_actor_pairing CHECK (
        (actor_kind IN ('postgres_bootstrap', 'service_role_system') AND actor_user_id IS NULL)
        OR
        (actor_kind = 'authenticated_reviewer' AND actor_user_id IS NOT NULL)
      )
    );

    CREATE INDEX idx_topic_assignment_review_events_request ON public.topic_assignment_review_events (review_request_id);

    -- Pontosan-egyszer megkotes azokra az esemenytipusokra, amelyek
    -- requestenkent csak egyszer tortenhetnek -- partial unique index,
    -- a tobbi (pl. tobbszori generation eseten tobb 'requested') nem
    -- korlatozott EZEN a tablan (a tenyleges "csak uj generacio utan
    -- uj request" szabalyt a 078-as RPC-invarians es a
    -- topic_assignment_review_requests-en levo partial unique index
    -- adja, nem ez).
    CREATE UNIQUE INDEX idx_topic_assignment_review_events_once_per_request
      ON public.topic_assignment_review_events (review_request_id, event_type)
      WHERE event_type IN ('approved', 'rejected', 'expired', 'cancelled', 'revoked', 'executed');

    ALTER TABLE public.topic_assignment_review_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.topic_assignment_review_events FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.topic_assignment_review_events TO service_role;

    RAISE NOTICE '077: topic_assignment_review_events created.';
  ELSE
    RAISE NOTICE '077: topic_assignment_review_events already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_assignment_review_events' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('review_request_id', 'uuid', 'uuid', 'NO', NULL),
        ('event_type', 'text', 'text', 'NO', NULL),
        ('actor_user_id', 'uuid', 'uuid', 'YES', NULL),
        ('actor_kind', 'text', 'text', 'NO', NULL),
        ('policy_version', 'integer', 'int4', 'NO', NULL),
        ('operation_digest', 'text', 'text', 'YES', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'topic_assignment_review_events'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.topic_assignment_review_events'::regclass
      EXCEPT SELECT unnest(ARRAY[
        'topic_assignment_review_events_pkey','topic_assignment_review_events_review_request_id_fkey',
        'topic_assignment_review_events_actor_user_id_fkey',
        'topic_assignment_review_events_event_type_check','topic_assignment_review_events_actor_kind_check',
        'topic_assignment_review_events_policy_version_positive','topic_assignment_review_events_actor_pairing'
      ])
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events has an unexpected extra constraint';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('topic_assignment_review_events_pkey', 'p'),
        ('topic_assignment_review_events_review_request_id_fkey', 'f'),
        ('topic_assignment_review_events_actor_user_id_fkey', 'f'),
        ('topic_assignment_review_events_event_type_check', 'c'),
        ('topic_assignment_review_events_actor_kind_check', 'c'),
        ('topic_assignment_review_events_policy_version_positive', 'c'),
        ('topic_assignment_review_events_actor_pairing', 'c')
      ) AS expected(conname, contype)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.topic_assignment_review_events'::regclass
          AND c.conname = expected.conname AND c.contype::text = expected.contype
          AND c.convalidated IS true AND c.condeferrable IS false AND c.condeferred IS false
      )
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events constraint set does not match exactly (missing/altered)';
    END IF;

    IF EXISTS (
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.topic_assignment_review_events'::regclass AND contype = 'f' AND confdeltype <> 'r'
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events FK ON DELETE action is not RESTRICT';
    END IF;

    IF EXISTS (
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'topic_assignment_review_events'
      EXCEPT SELECT unnest(ARRAY['topic_assignment_review_events_pkey','idx_topic_assignment_review_events_request','idx_topic_assignment_review_events_once_per_request'])
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events has an unexpected extra index';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'topic_assignment_review_events'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'topic_assignment_review_events') THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'topic_assignment_review_events' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'topic_assignment_review_events' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'topic_assignment_review_events' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '077 drift: topic_assignment_review_events has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '077: topic_assignment_review_events already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_tare$;

-- ============================================================
-- 5. topic_assignment_decisions.decision_reason -- additiv bovites
--    ket uj ertekkel. Fail-closed, csak ISMERT legacy (073) vagy
--    MAR-corrected definiciobol indulhat -- pontosan a 073
--    assignment_reason-bovites mintaja (semantic_topic_membership).
--    A record_topic_assignment_decision fuggveny TORZSE, SZIGNATURAJA
--    es GRANTJAI valtozatlanok maradnak -- ez a blokk KIZAROLAG a
--    tabla-CHECK-et bovii.
-- ============================================================

DO $migrate_decision_reason$
DECLARE
  v_current_def text;
  v_legacy_def CONSTANT text := 'CHECK (decision_reason = ANY (ARRAY[''no_similar_topic_found''::text, ''exact_entity_match''::text, ''embedding_similarity_match''::text, ''manual_review_confirmed''::text, ''manual_review_override''::text, ''malformed_extraction''::text, ''below_confidence_threshold''::text]))';
  v_corrected_def CONSTANT text := 'CHECK (decision_reason = ANY (ARRAY[''no_similar_topic_found''::text, ''exact_entity_match''::text, ''embedding_similarity_match''::text, ''manual_review_confirmed''::text, ''manual_review_override''::text, ''malformed_extraction''::text, ''below_confidence_threshold''::text, ''human_review_approved''::text, ''human_review_rejected''::text]))';
BEGIN
  SELECT pg_get_constraintdef(oid, true) INTO v_current_def
  FROM pg_constraint
  WHERE conrelid = 'public.topic_assignment_decisions'::regclass
    AND conname = 'topic_assignment_decisions_decision_reason_check';

  IF v_current_def IS NULL THEN
    RAISE EXCEPTION '077 fail-closed: topic_assignment_decisions_decision_reason_check not found -- expected the 073 baseline to exist. No DDL will run.';
  ELSIF v_current_def = v_corrected_def THEN
    RAISE NOTICE '077: topic_assignment_decisions_decision_reason_check already corrected -- no-op.';
  ELSIF v_current_def = v_legacy_def THEN
    RAISE NOTICE '077: topic_assignment_decisions_decision_reason_check is the known 073 legacy definition -- correcting.';
    ALTER TABLE public.topic_assignment_decisions DROP CONSTRAINT topic_assignment_decisions_decision_reason_check;
    ALTER TABLE public.topic_assignment_decisions ADD CONSTRAINT topic_assignment_decisions_decision_reason_check
      CHECK (decision_reason IN (
        'no_similar_topic_found', 'exact_entity_match', 'embedding_similarity_match',
        'manual_review_confirmed', 'manual_review_override', 'malformed_extraction', 'below_confidence_threshold',
        'human_review_approved', 'human_review_rejected'
      ));

    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint
    WHERE conrelid = 'public.topic_assignment_decisions'::regclass
      AND conname = 'topic_assignment_decisions_decision_reason_check';
    IF v_current_def <> v_corrected_def THEN
      RAISE EXCEPTION '077 post-alter self-check failed: new decision_reason definition does not match the expected corrected text exactly (got: %)', v_current_def;
    END IF;
    RAISE NOTICE '077: topic_assignment_decisions_decision_reason_check corrected to include human_review_approved/human_review_rejected.';
  ELSE
    RAISE EXCEPTION '077 fail-closed: DEFINITION_DRIFT -- topic_assignment_decisions_decision_reason_check is neither the known 073 legacy definition nor the corrected definition (got: %). No DDL will run.', v_current_def;
  END IF;
END;
$migrate_decision_reason$;

-- ============================================================
-- 6. Fail-fast vegallapot onellenorzes -- a MEGLEVO
--    record_topic_assignment_decision fuggveny torzse/szignaturaja/
--    grantja bizonyithatoan VALTOZATLAN maradt ebben a migracioban.
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
    RAISE EXCEPTION '077 CRITICAL: record_topic_assignment_decision body hash changed (got %, expected %) -- this migration must NEVER touch this function. Aborting.', v_hash, v_expected_hash;
  END IF;
  IF v_actual_args <> v_expected_args THEN
    RAISE EXCEPTION '077 CRITICAL: record_topic_assignment_decision signature changed (got %, expected %) -- this migration must NEVER touch this function. Aborting.', v_actual_args, v_expected_args;
  END IF;

  RAISE NOTICE '077: final self-check passed -- record_topic_assignment_decision body/signature confirmed unchanged.';
END;
$final_selfcheck$;

NOTIFY pgrst, 'reload schema';

COMMIT;
