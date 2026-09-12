-- ============================================================
-- Migration 087: Semantic Topic Lifecycle Review Framework v1
--
-- Kanonikus elozmeny: a Lifecycle v1 tervezesi-lezaro gate-ek (Post-
-- Corroboration State Contract -> Transition Authority Closure ->
-- Minimal Implementation Architecture) es a 086-os Foundation
-- Correctness migracio. Ez a migracio a MASODIK, kulon jovahagyott
-- resz (B. Minimal lifecycle review framework) -- a 086-os
-- Foundation Correctness (A. resz) mar production-ben fut, ettol
-- fuggetlenul.
--
-- HATOKOR -- HAROM UJ, egycelu tabla + NEGY UJ RPC, kizarolag a
-- MAR jovahagyott 4 v1 atmenetre:
--   corroborating -> coherent
--   corroborating -> ambiguous
--   ambiguous     -> corroborating
--   ambiguous     -> coherent
-- NINCS split_required/merge_candidate/superseded/archived/
-- candidate_singleton writer -- ezek szandekosan csak dokumentalt
-- enum-ertekek maradnak. NINCS automatikus lifecycle-democio.
-- NINCS UI, NINCS Creator Lane fogyaszto.
--
-- MIERT NEM a topic_assignment_review_requests tablat bovitjuk: az a
-- tabla egy MASIK dontesi domain-t hordoz (evidence -> topic
-- hozzarendeles, CREATE_NEW/ATTACH_EXISTING/QUARANTINE), teljesen mas
-- oszlopkeszlettel (canonical_topic_label, duplicate_search_outcome
-- stb.). A lifecycle-atmenet dontese (jelenlegi/cel lifecycle_status,
-- expected_status_version, evidence-vektor pillanatkep+digest,
-- identity-consistency checklist) strukturalisan mas -- egy kozos
-- tabla vagy nullable-oszlop-burjanzast, vagy ket, egymastol
-- fuggetlen CHECK-halmaz osszefonodasat eredmenyezne. Ket parhuzamos,
-- de strukturalisan azonos MINTAJU tablapar a helyes valasz -- ezt a
-- Transition Authority Closure gate mar explicit igy zarta le.
--
-- AMIT A 077/078 MINTABOL ATVESZUNK (a tenylegesen alkalmazhato
-- biztonsagi elemek, nem mechanikus masolas):
--   - harom-fazisu (request/decision/execution) idempotencia, kulon
--     idempotency_key + operation_digest oszloppar fazisonkent;
--   - append-only esemenytabla, actor_kind zart CHECK
--     (service_role_system / authenticated_reviewer), actor_pairing;
--   - reviewer-azonossag KIZAROLAG auth.uid()-bol, semantic_topic_
--     reviewers FOR SHARE aktiv-tagsag ellenorzessel -- SOHA nincs
--     p_reviewer_id/p_actor_id parameter;
--   - executor (service_role-only) NEM fogad el actor-parametert --
--     a mar auth.uid()-vel hitelesitett, tarolt dontest hajtja vegre;
--   - replay/konfliktus-eldontes MINDIG az allapot/expiry-kapu ELOTT
--     fut (078 sajat, dokumentalt sorrendi elve);
--   - statuszonkenti mezo-teljesseg CHECK constraint, explicit IS
--     NULL/IS NOT NULL/IS TRUE/IS FALSE mindenutt;
--   - RLS enabled+forced minden uj tablan, 0 policy, service_role
--     KIZAROLAG SELECT, minden iras SECURITY DEFINER RPC-n at;
--   - minden FK ON DELETE RESTRICT, ahol torteneti auditot vedenek.
--
-- AMIT SZANDEKOSAN NEM veszunk at: a 077/078 VALIDATE-agai
-- oszloponkent es constraint-enkent teljesen kimerito anti-join
-- osszehasonlitast futtatnak (lasd 077 sajat forrasa). Ez a migracio
-- a CREATE-agat ugyanolyan szigorral irja (ez hordozza a tenyleges
-- biztonsagi/korrektsegi garanciat), de a VALIDATE-aga egy szukebb,
-- de meg mindig fail-closed halmazt ellenoriz (tabla letezik, RLS
-- enabled+forced, 0 policy, pontos grant-halmaz, oszlopszam) --
-- explicit, dokumentalt hatokor-dontes, nem hanyagsag.
--
-- CORROBORATING KONTRA COHERENT -- ISMETELT, EXPLICIT KULONBSEGTETEL:
-- a corroborating allapot (es annak eligibleDistinctSourceIdentityCount
-- mezoje) KIZAROLAG mechanikus forras-diverzitast bizonyit -- nem
-- szerkesztoi/szerzoi fuggetlenseget, nem szemantikai azonossag-
-- konzisztenciat. A coherent allapot EGYETLEN modon erheto el: emberi
-- reviewer explicit, strukturalt megerositesevel (4 checklist-mezo),
-- SOHA automatikus kuszob alapjan -- ld. a Lifecycle v1 tervezesi
-- gate-ek sajat, korabban rogzitett zaro dontese.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. FUGGOSEGI ELOFELTETEL
-- ============================================================

DO $preflight$
DECLARE
  v_table_count int;
BEGIN
  SELECT count(*) INTO v_table_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('semantic_topics', 'semantic_topic_reviewers');
  IF v_table_count <> 2 THEN
    RAISE EXCEPTION '087 fail-closed: % of 2 required baseline tables present (semantic_topics, semantic_topic_reviewers) -- 072/077 must be fully applied first.', v_table_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='compute_topic_evidence_vector') THEN
    RAISE EXCEPTION '087 fail-closed: compute_topic_evidence_vector not found -- 085/086 must be fully applied first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.compute_topic_evidence_vector(uuid)'::regprocedure AND md5(replace(prosrc, E'\r\n', E'\n')) = '73aeb37846bcc80fd42a4e2c8862dc7c') THEN
    RAISE EXCEPTION '087 fail-closed: compute_topic_evidence_vector is not the expected 086-corrected body -- apply 086 first.';
  END IF;

  RAISE NOTICE '087: preflight gate passed (baseline present, compute_topic_evidence_vector confirmed 086-corrected).';
END;
$preflight$;

-- ============================================================
-- 1. semantic_topic_lifecycle_review_requests
-- ============================================================

DO $migrate_sltrr$
DECLARE
  v_table_exists boolean;
  v_col_count int;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_lifecycle_review_requests') INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '087: semantic_topic_lifecycle_review_requests does not exist -- CREATE branch.';

    CREATE TABLE public.semantic_topic_lifecycle_review_requests (
      id                                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      semantic_topic_id                           UUID NOT NULL REFERENCES public.semantic_topics(id) ON DELETE RESTRICT,
      generation                                  INTEGER NOT NULL,
      status                                      TEXT NOT NULL DEFAULT 'requested',
      from_status                                 TEXT NOT NULL,
      target_status                               TEXT NOT NULL,

      -- --- 1. fazis: request-letrehozas ---
      request_idempotency_key                     TEXT NOT NULL,
      request_operation_digest                    TEXT NOT NULL,
      requested_at                                TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at                                  TIMESTAMPTZ NOT NULL,
      expected_status_version                     INTEGER NOT NULL,
      review_policy_version                       INTEGER NOT NULL,
      -- Szerveroldalon eloallitott, megvaltoztathatatlan pillanatkep --
      -- a kliens SOHA nem adhatja at. A digest a snapshot::text
      -- kanonikus (kulcssorrend-fuggetlen -- jsonb::text mindig
      -- ugyanazt a determinisztikus alakot adja azonos logikai
      -- tartalomra) alakjabol keszul.
      evidence_vector_snapshot                    JSONB NOT NULL,
      evidence_vector_digest                      TEXT NOT NULL,

      -- --- 2. fazis: reviewer-dontes ---
      decision_idempotency_key                    TEXT,
      decision_operation_digest                   TEXT,
      reviewer_user_id                            UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
      reviewer_role_snapshot                      TEXT,
      decided_at                                  TIMESTAMPTZ,
      reason_code                                 TEXT,
      reviewer_rationale                          TEXT,
      same_semantic_identity_confirmed            BOOLEAN,
      no_material_identity_conflict               BOOLEAN,
      canonical_definition_scope_fit_confirmed    BOOLEAN,
      provenance_relationship_reviewed            BOOLEAN,

      -- --- 3. fazis: vegrehajtas ---
      execution_idempotency_key                   TEXT,
      execution_operation_digest                  TEXT,
      executed_at                                 TIMESTAMPTZ,

      -- --- cancel (kulon, szuk RPC -- ld. 6. blokk) ---
      cancelled_at                                TIMESTAMPTZ,
      cancelled_by_user_id                        UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
      cancel_operation_digest                     TEXT,

      CONSTRAINT sltrr_generation_key UNIQUE (semantic_topic_id, generation),
      CONSTRAINT sltrr_generation_positive CHECK (generation >= 1),
      CONSTRAINT sltrr_status_check CHECK (status IN ('requested', 'approved', 'rejected', 'expired', 'cancelled', 'executed')),
      CONSTRAINT sltrr_request_key_key UNIQUE (request_idempotency_key),
      CONSTRAINT sltrr_expected_version_positive CHECK (expected_status_version >= 1),
      CONSTRAINT sltrr_policy_version_positive CHECK (review_policy_version >= 1),
      CONSTRAINT sltrr_from_status_check CHECK (from_status IN ('corroborating', 'ambiguous')),
      CONSTRAINT sltrr_target_status_check CHECK (target_status IN ('coherent', 'ambiguous', 'corroborating')),
      -- Pontosan a negy v1-jovahagyott atmenet -- barmi mas
      -- kombinacio (pl. corroborating->corroborating, vagy barmilyen
      -- masik from_status) a CHECK szintjen eleve lehetetlen.
      CONSTRAINT sltrr_transition_pair_check CHECK (
        (from_status = 'corroborating' AND target_status IN ('coherent', 'ambiguous'))
        OR (from_status = 'ambiguous' AND target_status IN ('corroborating', 'coherent'))
      ),
      CONSTRAINT sltrr_rationale_length CHECK (reviewer_rationale IS NULL OR (length(reviewer_rationale) >= 1 AND length(reviewer_rationale) <= 1000)),
      -- Zart reason_code szotar -- 4 "approved" ertek + 4 "rejected"
      -- ertek, egyseges CHECK-ben (a p_outcome-fuggo szukebb halmazt
      -- az RPC alkalmazas-szinten kenyszeriti ki, ld. 4. blokk).
      CONSTRAINT sltrr_reason_code_check CHECK (reason_code IS NULL OR reason_code IN (
        'identity_consistency_confirmed', 'conflicting_identity_signal', 'insufficient_context_for_confirmation', 'suspicion_unfounded',
        'insufficient_evidence', 'invalid_identity_claim', 'not_ready_for_decision', 'other_lifecycle_rejection'
      )),

      -- coherent celallapotu, jovahagyott/vegrehajtott request eseten
      -- mind a negy strukturalt checklist-mezo kotelezoen TRUE -- a
      -- rationale SOHA nem helyettesitheti oket.
      CONSTRAINT sltrr_coherent_checklist_required CHECK (
        target_status <> 'coherent' OR status NOT IN ('approved', 'executed') OR (
          same_semantic_identity_confirmed IS TRUE AND no_material_identity_conflict IS TRUE
          AND canonical_definition_scope_fit_confirmed IS TRUE AND provenance_relationship_reviewed IS TRUE
        )
      ),

      CONSTRAINT sltrr_requested_fields_empty CHECK (
        status <> 'requested' OR (
          reviewer_user_id IS NULL AND decided_at IS NULL AND reason_code IS NULL AND reviewer_rationale IS NULL AND
          decision_idempotency_key IS NULL AND decision_operation_digest IS NULL AND
          executed_at IS NULL AND execution_idempotency_key IS NULL AND execution_operation_digest IS NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancel_operation_digest IS NULL
        )
      ),
      CONSTRAINT sltrr_approved_fields_required CHECK (
        status <> 'approved' OR (
          reviewer_user_id IS NOT NULL AND reviewer_role_snapshot IS NOT NULL AND decided_at IS NOT NULL AND
          reason_code IS NOT NULL AND reviewer_rationale IS NOT NULL AND
          decision_idempotency_key IS NOT NULL AND decision_operation_digest IS NOT NULL AND
          executed_at IS NULL AND execution_idempotency_key IS NULL AND execution_operation_digest IS NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancel_operation_digest IS NULL
        )
      ),
      CONSTRAINT sltrr_rejected_fields_required CHECK (
        status <> 'rejected' OR (
          reviewer_user_id IS NOT NULL AND reviewer_role_snapshot IS NOT NULL AND decided_at IS NOT NULL AND
          reason_code IS NOT NULL AND reviewer_rationale IS NOT NULL AND
          decision_idempotency_key IS NOT NULL AND decision_operation_digest IS NOT NULL AND
          executed_at IS NULL AND execution_idempotency_key IS NULL AND execution_operation_digest IS NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancel_operation_digest IS NULL
        )
      ),
      CONSTRAINT sltrr_expired_fields_empty CHECK (
        status <> 'expired' OR (
          reviewer_user_id IS NULL AND decided_at IS NULL AND
          executed_at IS NULL AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
        )
      ),
      CONSTRAINT sltrr_cancelled_fields CHECK (
        status <> 'cancelled' OR (
          cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancel_operation_digest IS NOT NULL AND
          reviewer_user_id IS NULL AND decided_at IS NULL AND executed_at IS NULL
        )
      ),
      CONSTRAINT sltrr_executed_fields_required CHECK (
        status <> 'executed' OR (
          reviewer_user_id IS NOT NULL AND reviewer_role_snapshot IS NOT NULL AND decided_at IS NOT NULL AND
          reason_code IS NOT NULL AND reviewer_rationale IS NOT NULL AND
          decision_idempotency_key IS NOT NULL AND decision_operation_digest IS NOT NULL AND
          executed_at IS NOT NULL AND execution_idempotency_key IS NOT NULL AND execution_operation_digest IS NOT NULL AND
          cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancel_operation_digest IS NULL
        )
      )
    );

    -- Topiconkent legfeljebb EGY elo (requested) request -- 072/077
    -- precedens mintajara, partial unique index.
    CREATE UNIQUE INDEX idx_sltrr_one_requested_per_topic
      ON public.semantic_topic_lifecycle_review_requests (semantic_topic_id) WHERE status = 'requested';
    CREATE UNIQUE INDEX idx_sltrr_decision_key_unique
      ON public.semantic_topic_lifecycle_review_requests (decision_idempotency_key) WHERE decision_idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX idx_sltrr_execution_key_unique
      ON public.semantic_topic_lifecycle_review_requests (execution_idempotency_key) WHERE execution_idempotency_key IS NOT NULL;
    CREATE INDEX idx_sltrr_status ON public.semantic_topic_lifecycle_review_requests (status);
    CREATE INDEX idx_sltrr_topic ON public.semantic_topic_lifecycle_review_requests (semantic_topic_id);

    ALTER TABLE public.semantic_topic_lifecycle_review_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.semantic_topic_lifecycle_review_requests FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.semantic_topic_lifecycle_review_requests TO service_role;

    RAISE NOTICE '087: semantic_topic_lifecycle_review_requests created.';
  ELSE
    RAISE NOTICE '087: semantic_topic_lifecycle_review_requests already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT count(*) INTO v_col_count FROM information_schema.columns WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_review_requests';
    IF v_col_count <> 31 THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_requests has % columns, expected 31', v_col_count;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'semantic_topic_lifecycle_review_requests'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_requests RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'semantic_topic_lifecycle_review_requests') THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_requests has an unexpected policy';
    END IF;
    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_review_requests' AND grantee='service_role' EXCEPT SELECT 'SELECT')
      UNION ALL
      (SELECT 'SELECT' EXCEPT SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_review_requests' AND grantee='service_role')
    ) THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_requests service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_review_requests' AND grantee IN ('anon','authenticated','PUBLIC')) THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_requests has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '087: semantic_topic_lifecycle_review_requests already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_sltrr$;

-- ============================================================
-- 2. semantic_topic_lifecycle_review_events (append-only, request-eletciklus audit)
-- ============================================================

DO $migrate_sltre$
DECLARE
  v_table_exists boolean;
  v_col_count int;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_lifecycle_review_events') INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '087: semantic_topic_lifecycle_review_events does not exist -- CREATE branch.';

    CREATE TABLE public.semantic_topic_lifecycle_review_events (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      review_request_id     UUID NOT NULL REFERENCES public.semantic_topic_lifecycle_review_requests(id) ON DELETE RESTRICT,
      event_type            TEXT NOT NULL,
      actor_user_id         UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
      actor_kind            TEXT NOT NULL,
      policy_version        INTEGER NOT NULL,
      operation_digest      TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT sltre_event_type_check CHECK (event_type IN ('requested', 'approved', 'rejected', 'expired', 'cancelled', 'executed')),
      CONSTRAINT sltre_actor_kind_check CHECK (actor_kind IN ('service_role_system', 'authenticated_reviewer')),
      CONSTRAINT sltre_policy_version_positive CHECK (policy_version >= 1),
      CONSTRAINT sltre_actor_pairing CHECK (
        (actor_kind = 'service_role_system' AND actor_user_id IS NULL)
        OR (actor_kind = 'authenticated_reviewer' AND actor_user_id IS NOT NULL)
      )
    );

    CREATE INDEX idx_sltre_request ON public.semantic_topic_lifecycle_review_events (review_request_id);
    -- pontosan-egyszer megkotes a terminalis esemenytipusokra egy adott
    -- requesten (tobbszori 'requested' nem korlatozott ezen a tablan --
    -- azt a requests tabla generation-UNIQUE parja adja).
    CREATE UNIQUE INDEX idx_sltre_once_per_request
      ON public.semantic_topic_lifecycle_review_events (review_request_id, event_type)
      WHERE event_type IN ('approved', 'rejected', 'expired', 'cancelled', 'executed');

    ALTER TABLE public.semantic_topic_lifecycle_review_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.semantic_topic_lifecycle_review_events FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.semantic_topic_lifecycle_review_events TO service_role;

    RAISE NOTICE '087: semantic_topic_lifecycle_review_events created.';
  ELSE
    RAISE NOTICE '087: semantic_topic_lifecycle_review_events already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT count(*) INTO v_col_count FROM information_schema.columns WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_review_events';
    IF v_col_count <> 8 THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_events has % columns, expected 8', v_col_count;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'semantic_topic_lifecycle_review_events'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_events RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'semantic_topic_lifecycle_review_events') THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_events has an unexpected policy';
    END IF;
    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_review_events' AND grantee='service_role' EXCEPT SELECT 'SELECT')
      UNION ALL
      (SELECT 'SELECT' EXCEPT SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_review_events' AND grantee='service_role')
    ) THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_events service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_review_events' AND grantee IN ('anon','authenticated','PUBLIC')) THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_review_events has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '087: semantic_topic_lifecycle_review_events already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_sltre$;

-- ============================================================
-- 3. semantic_topic_lifecycle_transition_events (append-only, a
--    TENYLEGES lifecycle_status-valtozas audit -- kulon a fenti
--    review-folyamat audittol, pontosan ahogy 073
--    semantic_topic_membership_events elkulonul a
--    topic_assignment_review_events-tol.)
-- ============================================================

DO $migrate_sltte$
DECLARE
  v_table_exists boolean;
  v_col_count int;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_lifecycle_transition_events') INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '087: semantic_topic_lifecycle_transition_events does not exist -- CREATE branch.';

    CREATE TABLE public.semantic_topic_lifecycle_transition_events (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      semantic_topic_id     UUID NOT NULL REFERENCES public.semantic_topics(id) ON DELETE RESTRICT,
      review_request_id     UUID NOT NULL REFERENCES public.semantic_topic_lifecycle_review_requests(id) ON DELETE RESTRICT,
      from_status           TEXT NOT NULL,
      target_status         TEXT NOT NULL,
      new_status_version    INTEGER NOT NULL,
      transition_digest     TEXT NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT sltte_from_status_check CHECK (from_status IN ('corroborating', 'ambiguous')),
      CONSTRAINT sltte_target_status_check CHECK (target_status IN ('coherent', 'ambiguous', 'corroborating')),
      CONSTRAINT sltte_transition_pair_check CHECK (
        (from_status = 'corroborating' AND target_status IN ('coherent', 'ambiguous'))
        OR (from_status = 'ambiguous' AND target_status IN ('corroborating', 'coherent'))
      ),
      CONSTRAINT sltte_version_positive CHECK (new_status_version >= 2),
      -- Egy adott review_request pontosan egy transition-eventet
      -- hozhat letre -- az executor RPC pontosan-egyszer-fut
      -- garanciajanak tabla-szintu kikenyszeritese.
      CONSTRAINT sltte_one_per_request UNIQUE (review_request_id)
    );

    CREATE INDEX idx_sltte_topic ON public.semantic_topic_lifecycle_transition_events (semantic_topic_id);

    ALTER TABLE public.semantic_topic_lifecycle_transition_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.semantic_topic_lifecycle_transition_events FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON public.semantic_topic_lifecycle_transition_events TO service_role;

    RAISE NOTICE '087: semantic_topic_lifecycle_transition_events created.';
  ELSE
    RAISE NOTICE '087: semantic_topic_lifecycle_transition_events already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT count(*) INTO v_col_count FROM information_schema.columns WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_transition_events';
    IF v_col_count <> 8 THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_transition_events has % columns, expected 8', v_col_count;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'semantic_topic_lifecycle_transition_events'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_transition_events RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'semantic_topic_lifecycle_transition_events') THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_transition_events has an unexpected policy';
    END IF;
    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_transition_events' AND grantee='service_role' EXCEPT SELECT 'SELECT')
      UNION ALL
      (SELECT 'SELECT' EXCEPT SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_transition_events' AND grantee='service_role')
    ) THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_transition_events service_role grant set does not match exactly (expected SELECT only)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='semantic_topic_lifecycle_transition_events' AND grantee IN ('anon','authenticated','PUBLIC')) THEN
      RAISE EXCEPTION '087 drift: semantic_topic_lifecycle_transition_events has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '087: semantic_topic_lifecycle_transition_events already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_sltte$;

-- ============================================================
-- 4. create_semantic_topic_lifecycle_review_request -- service_role-only.
-- ============================================================

DO $migrate_csltrr$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '3184eae2b484552478e36131a5c4d8e0';
  v_expected_args CONSTANT text := 'p_semantic_topic_id uuid, p_target_status text, p_idempotency_key text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_semantic_topic_lifecycle_review_request';

  IF v_name_count = 0 THEN
    RAISE NOTICE '087: create_semantic_topic_lifecycle_review_request does not exist -- CREATE branch.';

    CREATE FUNCTION public.create_semantic_topic_lifecycle_review_request(
      p_semantic_topic_id UUID,
      p_target_status TEXT,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_domain CONSTANT TEXT := 'willviral.semantic-topic.lifecycle-review-request:v1';
      v_policy_version CONSTANT INTEGER := 1;
      v_default_ttl CONSTANT INTERVAL := interval '72 hours';
      v_topic RECORD;
      v_existing RECORD;
      v_generation INTEGER;
      v_vector JSONB;
      v_request_digest TEXT;
      v_snapshot_digest TEXT;
      v_request_id UUID;
    BEGIN
      IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RAISE EXCEPTION 'create_semantic_topic_lifecycle_review_request: p_idempotency_key is required';
      END IF;
      IF p_target_status NOT IN ('coherent', 'ambiguous', 'corroborating') THEN
        RAISE EXCEPTION 'create_semantic_topic_lifecycle_review_request: p_target_status must be one of coherent, ambiguous, corroborating (got %)', p_target_status;
      END IF;

      -- Idempotens replay-ellenorzes MINDIG az elso lepes -- egy pontos
      -- kulcs+payload ismetles mindig ugyanazt az eredmenyt adja,
      -- fuggetlenul attol, hogy azota mas mar tortent a topiccal.
      SELECT * INTO v_existing FROM public.semantic_topic_lifecycle_review_requests WHERE request_idempotency_key = p_idempotency_key;
      IF FOUND THEN
        v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          format('{"domain":%s,"semantic_topic_id":%s,"target_status":%s,"idempotency_key":%s}',
            to_json(v_domain)::text, to_json(p_semantic_topic_id::text)::text, to_json(p_target_status)::text, to_json(p_idempotency_key)::text
          ), 'UTF8')), 'hex');
        IF v_existing.semantic_topic_id = p_semantic_topic_id AND v_existing.target_status = p_target_status AND v_existing.request_operation_digest = v_request_digest THEN
          RETURN jsonb_build_object('ok', true, 'outcomeKind', 'replayed', 'reviewRequestId', v_existing.id, 'status', v_existing.status, 'generation', v_existing.generation);
        ELSE
          RAISE EXCEPTION 'create_semantic_topic_lifecycle_review_request: idempotency_key % already used with different parameters', p_idempotency_key;
        END IF;
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_semantic_topic_id::text, 20));

      SELECT * INTO v_topic FROM public.semantic_topics WHERE id = p_semantic_topic_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'create_semantic_topic_lifecycle_review_request: semantic_topic % not found', p_semantic_topic_id;
      END IF;

      IF NOT (
        (v_topic.lifecycle_status = 'corroborating' AND p_target_status IN ('coherent', 'ambiguous'))
        OR (v_topic.lifecycle_status = 'ambiguous' AND p_target_status IN ('corroborating', 'coherent'))
      ) THEN
        RAISE EXCEPTION 'create_semantic_topic_lifecycle_review_request: UNSUPPORTED_TRANSITION -- %->% is not one of the four v1-supported transitions', v_topic.lifecycle_status, p_target_status;
      END IF;

      IF EXISTS (SELECT 1 FROM public.semantic_topic_lifecycle_review_requests WHERE semantic_topic_id = p_semantic_topic_id AND status = 'requested') THEN
        RAISE EXCEPTION 'create_semantic_topic_lifecycle_review_request: REQUEST_ALREADY_PENDING_FOR_TOPIC';
      END IF;

      -- Szerveroldali, hiteles pillanatkep -- a hivo SOHA nem adhat at
      -- snapshotot, digestet, from_statust, expected_versiont vagy
      -- generationt.
      v_vector := public.compute_topic_evidence_vector(p_semantic_topic_id);
      IF (v_vector->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'create_semantic_topic_lifecycle_review_request: compute_topic_evidence_vector did not return ok=true for topic %', p_semantic_topic_id;
      END IF;

      -- coherent cel eseten a mechanikus minimum mar request-
      -- letrehozaskor kotelezo. ambiguous cel eseten a hianyos vektor
      -- ONMAGABAN nem blokkol -- az lehet eppen az ambiguity oka.
      IF p_target_status = 'coherent' THEN
        IF coalesce((v_vector->>'eligibleDistinctSourceIdentityCount')::bigint, 0) < 2
           OR (v_vector->>'evidenceIdentityComplete')::boolean IS NOT TRUE
           OR (v_vector->>'sourceIdentityKnown')::boolean IS NOT TRUE
           OR (v_vector->>'assignmentReasonBreakdownComplete')::boolean IS NOT TRUE
        THEN
          RAISE EXCEPTION 'create_semantic_topic_lifecycle_review_request: COHERENT_MINIMUM_NOT_MET';
        END IF;
      END IF;

      SELECT coalesce(max(generation), 0) + 1 INTO v_generation FROM public.semantic_topic_lifecycle_review_requests WHERE semantic_topic_id = p_semantic_topic_id;

      v_snapshot_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"semanticTopicId":%s,"targetStatus":%s,"policyVersion":%s,"snapshot":%s}',
          to_json(v_domain || ':snapshot')::text, to_json(p_semantic_topic_id::text)::text, to_json(p_target_status)::text,
          to_json(v_policy_version)::text, v_vector::text
        ), 'UTF8')), 'hex');

      v_request_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"semantic_topic_id":%s,"target_status":%s,"idempotency_key":%s}',
          to_json(v_domain)::text, to_json(p_semantic_topic_id::text)::text, to_json(p_target_status)::text, to_json(p_idempotency_key)::text
        ), 'UTF8')), 'hex');

      INSERT INTO public.semantic_topic_lifecycle_review_requests (
        semantic_topic_id, generation, from_status, target_status,
        request_idempotency_key, request_operation_digest, expires_at,
        expected_status_version, review_policy_version, evidence_vector_snapshot, evidence_vector_digest
      ) VALUES (
        p_semantic_topic_id, v_generation, v_topic.lifecycle_status, p_target_status,
        p_idempotency_key, v_request_digest, now() + v_default_ttl,
        v_topic.status_version, v_policy_version, v_vector, v_snapshot_digest
      ) RETURNING id INTO v_request_id;

      INSERT INTO public.semantic_topic_lifecycle_review_events (review_request_id, event_type, actor_kind, policy_version, operation_digest)
      VALUES (v_request_id, 'requested', 'service_role_system', v_policy_version, v_request_digest);

      RETURN jsonb_build_object('ok', true, 'outcomeKind', 'created', 'reviewRequestId', v_request_id, 'status', 'requested', 'generation', v_generation);
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.create_semantic_topic_lifecycle_review_request(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.create_semantic_topic_lifecycle_review_request(UUID, TEXT, TEXT) TO service_role;

    RAISE NOTICE '087: create_semantic_topic_lifecycle_review_request created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '087: create_semantic_topic_lifecycle_review_request already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'create_semantic_topic_lifecycle_review_request';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql' AND p.provolatile = 'v' AND p.proisstrict IS FALSE AND p.prosecdef IS TRUE
        AND p.proparallel = 'u' AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '087 drift: create_semantic_topic_lifecycle_review_request structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '087 drift: create_semantic_topic_lifecycle_review_request body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE') OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid)))) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'service_role')
       )
    THEN
      RAISE EXCEPTION '087 drift: create_semantic_topic_lifecycle_review_request ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '087: create_semantic_topic_lifecycle_review_request already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '087 fail-closed: create_semantic_topic_lifecycle_review_request has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_csltrr$;

-- ============================================================
-- 5. record_semantic_topic_lifecycle_review_decision -- authenticated.
-- ============================================================

DO $migrate_rsltrd$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'df3441416c551b224337dff95b6483b1';
  v_expected_args CONSTANT text := 'p_review_request_id uuid, p_decision_idempotency_key text, p_outcome text, p_reason_code text, p_reviewer_rationale text, p_same_semantic_identity_confirmed boolean, p_no_material_identity_conflict boolean, p_canonical_definition_scope_fit_confirmed boolean, p_provenance_relationship_reviewed boolean, p_review_policy_version integer';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_semantic_topic_lifecycle_review_decision';

  IF v_name_count = 0 THEN
    RAISE NOTICE '087: record_semantic_topic_lifecycle_review_decision does not exist -- CREATE branch.';

    CREATE FUNCTION public.record_semantic_topic_lifecycle_review_decision(
      p_review_request_id UUID,
      p_decision_idempotency_key TEXT,
      p_outcome TEXT,
      p_reason_code TEXT,
      p_reviewer_rationale TEXT,
      p_same_semantic_identity_confirmed BOOLEAN,
      p_no_material_identity_conflict BOOLEAN,
      p_canonical_definition_scope_fit_confirmed BOOLEAN,
      p_provenance_relationship_reviewed BOOLEAN,
      p_review_policy_version INTEGER
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_domain CONSTANT TEXT := 'willviral.semantic-topic.lifecycle-review-decision:v1';
      v_supported_policy_version CONSTANT INTEGER := 1;
      v_caller_user_id UUID;
      v_reviewer RECORD;
      v_request RECORD;
      v_decision_digest TEXT;
      v_now TIMESTAMPTZ := now();
    BEGIN
      IF p_outcome NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: p_outcome must be approved or rejected (got %)', p_outcome;
      END IF;

      v_caller_user_id := auth.uid();
      IF v_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: authentication required';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_review_request_id::text, 21));

      SELECT * INTO v_request FROM public.semantic_topic_lifecycle_review_requests WHERE id = p_review_request_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: review_request % not found', p_review_request_id;
      END IF;

      -- FOR SHARE: zarja a TOCTOU-rest, ha a reviewer eppen
      -- deaktivalas alatt van ugyanebben az ablakban.
      SELECT * INTO v_reviewer FROM public.semantic_topic_reviewers WHERE user_id = v_caller_user_id AND active IS TRUE FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: caller is not an active reviewer';
      END IF;

      -- Replay/konfliktus-eldontes MINDIG az allapot/expiry-kapu ELOTT.
      IF v_request.status IN ('approved', 'rejected') THEN
        v_decision_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          format(
            '{"domain":%s,"review_request_id":%s,"generation":%s,"outcome":%s,"reason_code":%s,"reviewer_user_id":%s,"review_policy_version":%s,"reviewer_rationale":%s,"same_semantic_identity_confirmed":%s,"no_material_identity_conflict":%s,"canonical_definition_scope_fit_confirmed":%s,"provenance_relationship_reviewed":%s}',
            to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(v_request.generation)::text,
            to_json(p_outcome)::text, coalesce(to_json(p_reason_code)::text, 'null'), to_json(v_caller_user_id::text)::text,
            to_json(p_review_policy_version)::text, to_json(p_reviewer_rationale)::text,
            coalesce(to_json(p_same_semantic_identity_confirmed)::text, 'null'), coalesce(to_json(p_no_material_identity_conflict)::text, 'null'),
            coalesce(to_json(p_canonical_definition_scope_fit_confirmed)::text, 'null'), coalesce(to_json(p_provenance_relationship_reviewed)::text, 'null')
          ), 'UTF8')), 'hex');
        IF v_decision_digest = v_request.decision_operation_digest THEN
          RETURN jsonb_build_object('ok', true, 'outcomeKind', 'replayed', 'reviewRequestId', p_review_request_id, 'status', v_request.status);
        ELSE
          RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: review_request % already decided with different parameters', p_review_request_id;
        END IF;
      END IF;

      -- Lazy expiry -- perzisztalt allapotvaltas, majd NORMAL, nem
      -- kivetel-alapu zart visszateres. SOHA nem UPDATE+utana
      -- RAISE EXCEPTION -- az visszagorgetne az UPDATE-et is.
      IF v_request.status = 'requested' AND v_request.expires_at <= v_now THEN
        UPDATE public.semantic_topic_lifecycle_review_requests SET status = 'expired' WHERE id = p_review_request_id;
        INSERT INTO public.semantic_topic_lifecycle_review_events (review_request_id, event_type, actor_kind, policy_version)
        VALUES (p_review_request_id, 'expired', 'service_role_system', v_supported_policy_version);
        RETURN jsonb_build_object('ok', false, 'reasonCode', 'REQUEST_EXPIRED');
      END IF;

      IF v_request.status <> 'requested' THEN
        RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: REVIEW_REQUEST_NOT_DECIDABLE -- status=%', v_request.status;
      END IF;

      IF p_review_policy_version IS DISTINCT FROM v_supported_policy_version OR v_request.review_policy_version IS DISTINCT FROM v_supported_policy_version THEN
        RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: unsupported review_policy_version';
      END IF;

      IF p_reviewer_rationale IS NULL OR length(p_reviewer_rationale) < 1 OR length(p_reviewer_rationale) > 1000 THEN
        RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: reviewer_rationale is required (1-1000 chars)';
      END IF;

      IF p_outcome = 'approved' THEN
        IF v_request.target_status = 'coherent' THEN
          IF p_same_semantic_identity_confirmed IS NOT TRUE OR p_no_material_identity_conflict IS NOT TRUE
             OR p_canonical_definition_scope_fit_confirmed IS NOT TRUE OR p_provenance_relationship_reviewed IS NOT TRUE
          THEN
            RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: coherent approval requires all four structured checklist fields to be TRUE';
          END IF;
          IF p_reason_code IS DISTINCT FROM 'identity_consistency_confirmed' THEN
            RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: coherent approval requires reason_code=identity_consistency_confirmed (got %)', p_reason_code;
          END IF;
        ELSIF v_request.target_status = 'ambiguous' THEN
          IF p_reason_code NOT IN ('conflicting_identity_signal', 'insufficient_context_for_confirmation') THEN
            RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: ambiguous approval requires reason_code in (conflicting_identity_signal, insufficient_context_for_confirmation) (got %)', p_reason_code;
          END IF;
        ELSIF v_request.target_status = 'corroborating' THEN
          IF p_reason_code IS DISTINCT FROM 'suspicion_unfounded' THEN
            RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: corroborating approval (from ambiguous) requires reason_code=suspicion_unfounded (got %)', p_reason_code;
          END IF;
        END IF;
      ELSE -- rejected
        IF p_reason_code NOT IN ('insufficient_evidence', 'invalid_identity_claim', 'not_ready_for_decision', 'other_lifecycle_rejection') THEN
          RAISE EXCEPTION 'record_semantic_topic_lifecycle_review_decision: rejected requires a closed rejection reason_code (got %)', p_reason_code;
        END IF;
      END IF;

      v_decision_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"domain":%s,"review_request_id":%s,"generation":%s,"outcome":%s,"reason_code":%s,"reviewer_user_id":%s,"review_policy_version":%s,"reviewer_rationale":%s,"same_semantic_identity_confirmed":%s,"no_material_identity_conflict":%s,"canonical_definition_scope_fit_confirmed":%s,"provenance_relationship_reviewed":%s}',
          to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(v_request.generation)::text,
          to_json(p_outcome)::text, coalesce(to_json(p_reason_code)::text, 'null'), to_json(v_caller_user_id::text)::text,
          to_json(p_review_policy_version)::text, to_json(p_reviewer_rationale)::text,
          coalesce(to_json(p_same_semantic_identity_confirmed)::text, 'null'), coalesce(to_json(p_no_material_identity_conflict)::text, 'null'),
          coalesce(to_json(p_canonical_definition_scope_fit_confirmed)::text, 'null'), coalesce(to_json(p_provenance_relationship_reviewed)::text, 'null')
        ), 'UTF8')), 'hex');

      -- Nincs topic lifecycle-modositas ebben az RPC-ben -- csak a
      -- request sajat mezoi valtoznak. A tenyleges atmenetet kizarolag
      -- az executor (7. blokk) vegzi.
      UPDATE public.semantic_topic_lifecycle_review_requests SET
        status = p_outcome, reviewer_user_id = v_caller_user_id, reviewer_role_snapshot = v_reviewer.role, decided_at = v_now,
        reason_code = p_reason_code, reviewer_rationale = p_reviewer_rationale,
        same_semantic_identity_confirmed = p_same_semantic_identity_confirmed, no_material_identity_conflict = p_no_material_identity_conflict,
        canonical_definition_scope_fit_confirmed = p_canonical_definition_scope_fit_confirmed, provenance_relationship_reviewed = p_provenance_relationship_reviewed,
        decision_idempotency_key = p_decision_idempotency_key, decision_operation_digest = v_decision_digest
      WHERE id = p_review_request_id;

      INSERT INTO public.semantic_topic_lifecycle_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version, operation_digest)
      VALUES (p_review_request_id, p_outcome, v_caller_user_id, 'authenticated_reviewer', v_supported_policy_version, v_decision_digest);

      RETURN jsonb_build_object('ok', true, 'outcomeKind', p_outcome, 'reviewRequestId', p_review_request_id, 'status', p_outcome);
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.record_semantic_topic_lifecycle_review_decision(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER) FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.record_semantic_topic_lifecycle_review_decision(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER) TO authenticated;

    RAISE NOTICE '087: record_semantic_topic_lifecycle_review_decision created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '087: record_semantic_topic_lifecycle_review_decision already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_semantic_topic_lifecycle_review_decision';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql' AND p.provolatile = 'v' AND p.proisstrict IS FALSE AND p.prosecdef IS TRUE
        AND p.proparallel = 'u' AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '087 drift: record_semantic_topic_lifecycle_review_decision structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '087 drift: record_semantic_topic_lifecycle_review_decision body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid)))) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'authenticated')
       )
    THEN
      RAISE EXCEPTION '087 drift: record_semantic_topic_lifecycle_review_decision ACL does not match exactly (expected postgres+authenticated EXECUTE only)';
    END IF;

    RAISE NOTICE '087: record_semantic_topic_lifecycle_review_decision already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '087 fail-closed: record_semantic_topic_lifecycle_review_decision has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_rsltrd$;

-- ============================================================
-- 6. cancel_semantic_topic_lifecycle_review_request -- authenticated,
--    szuk, kulon RPC (item 7 -- egy requested request cancel-jehez).
-- ============================================================

DO $migrate_csltrreq$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'c3707f8f6d39967229c40f4898300e01';
  v_expected_args CONSTANT text := 'p_review_request_id uuid, p_idempotency_key text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'cancel_semantic_topic_lifecycle_review_request';

  IF v_name_count = 0 THEN
    RAISE NOTICE '087: cancel_semantic_topic_lifecycle_review_request does not exist -- CREATE branch.';

    CREATE FUNCTION public.cancel_semantic_topic_lifecycle_review_request(
      p_review_request_id UUID,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_domain CONSTANT TEXT := 'willviral.semantic-topic.lifecycle-review-cancel:v1';
      v_supported_policy_version CONSTANT INTEGER := 1;
      v_caller_user_id UUID;
      v_reviewer RECORD;
      v_request RECORD;
      v_cancel_digest TEXT;
    BEGIN
      v_caller_user_id := auth.uid();
      IF v_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'cancel_semantic_topic_lifecycle_review_request: authentication required';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_review_request_id::text, 21));

      SELECT * INTO v_request FROM public.semantic_topic_lifecycle_review_requests WHERE id = p_review_request_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'cancel_semantic_topic_lifecycle_review_request: review_request % not found', p_review_request_id;
      END IF;

      SELECT * INTO v_reviewer FROM public.semantic_topic_reviewers WHERE user_id = v_caller_user_id AND active IS TRUE FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'cancel_semantic_topic_lifecycle_review_request: caller is not an active reviewer';
      END IF;

      v_cancel_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"review_request_id":%s,"idempotency_key":%s}',
          to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(p_idempotency_key)::text
        ), 'UTF8')), 'hex');

      IF v_request.status = 'cancelled' THEN
        IF v_request.cancel_operation_digest = v_cancel_digest THEN
          RETURN jsonb_build_object('ok', true, 'outcomeKind', 'replayed', 'reviewRequestId', p_review_request_id, 'status', 'cancelled');
        ELSE
          RAISE EXCEPTION 'cancel_semantic_topic_lifecycle_review_request: idempotency_key % already used with different parameters', p_idempotency_key;
        END IF;
      END IF;

      IF v_request.status <> 'requested' THEN
        RAISE EXCEPTION 'cancel_semantic_topic_lifecycle_review_request: REVIEW_REQUEST_NOT_CANCELLABLE -- status=%', v_request.status;
      END IF;

      UPDATE public.semantic_topic_lifecycle_review_requests SET
        status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = v_caller_user_id, cancel_operation_digest = v_cancel_digest
      WHERE id = p_review_request_id;

      INSERT INTO public.semantic_topic_lifecycle_review_events (review_request_id, event_type, actor_user_id, actor_kind, policy_version, operation_digest)
      VALUES (p_review_request_id, 'cancelled', v_caller_user_id, 'authenticated_reviewer', v_supported_policy_version, v_cancel_digest);

      RETURN jsonb_build_object('ok', true, 'outcomeKind', 'cancelled', 'reviewRequestId', p_review_request_id, 'status', 'cancelled');
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.cancel_semantic_topic_lifecycle_review_request(UUID, TEXT) FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.cancel_semantic_topic_lifecycle_review_request(UUID, TEXT) TO authenticated;

    RAISE NOTICE '087: cancel_semantic_topic_lifecycle_review_request created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '087: cancel_semantic_topic_lifecycle_review_request already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'cancel_semantic_topic_lifecycle_review_request';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql' AND p.provolatile = 'v' AND p.proisstrict IS FALSE AND p.prosecdef IS TRUE
        AND p.proparallel = 'u' AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '087 drift: cancel_semantic_topic_lifecycle_review_request structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '087 drift: cancel_semantic_topic_lifecycle_review_request body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid)))) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'authenticated')
       )
    THEN
      RAISE EXCEPTION '087 drift: cancel_semantic_topic_lifecycle_review_request ACL does not match exactly (expected postgres+authenticated EXECUTE only)';
    END IF;

    RAISE NOTICE '087: cancel_semantic_topic_lifecycle_review_request already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '087 fail-closed: cancel_semantic_topic_lifecycle_review_request has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_csltrreq$;

-- ============================================================
-- 7. execute_approved_semantic_topic_lifecycle_transition -- service_role-only.
-- ============================================================

DO $migrate_easltt$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'a5edcd761ee5a9f7becdbab118d9b87d';
  v_expected_args CONSTANT text := 'p_review_request_id uuid, p_idempotency_key text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'execute_approved_semantic_topic_lifecycle_transition';

  IF v_name_count = 0 THEN
    RAISE NOTICE '087: execute_approved_semantic_topic_lifecycle_transition does not exist -- CREATE branch.';

    CREATE FUNCTION public.execute_approved_semantic_topic_lifecycle_transition(
      p_review_request_id UUID,
      p_idempotency_key TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_domain CONSTANT TEXT := 'willviral.semantic-topic.lifecycle-review-execution:v1';
      v_snapshot_domain CONSTANT TEXT := 'willviral.semantic-topic.lifecycle-review-request:v1:snapshot';
      v_transition_domain CONSTANT TEXT := 'willviral.semantic-topic.lifecycle-transition-event:v1';
      v_supported_policy_version CONSTANT INTEGER := 1;
      v_request RECORD;
      v_topic RECORD;
      v_fresh_vector JSONB;
      v_fresh_snapshot_digest TEXT;
      v_execution_digest TEXT;
      v_transition_digest TEXT;
      v_transition_event_id UUID;
    BEGIN
      -- Lock sorrend: MINDIG request-elobb-topic (soha nem forditva) --
      -- ugyanaz a globalis szabaly, mint a decision RPC-nel (ami
      -- SOHA nem zarolja a topicot), es konzisztens a 074/078
      -- "evidence(0) -> request(10)" mintajaval.
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_review_request_id::text, 21));

      SELECT * INTO v_request FROM public.semantic_topic_lifecycle_review_requests WHERE id = p_review_request_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_approved_semantic_topic_lifecycle_transition: review_request % not found', p_review_request_id;
      END IF;

      IF v_request.status = 'executed' THEN
        v_execution_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
          format('{"domain":%s,"review_request_id":%s,"execution_idempotency_key":%s,"decision_operation_digest":%s}',
            to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(p_idempotency_key)::text, to_json(v_request.decision_operation_digest)::text
          ), 'UTF8')), 'hex');
        IF v_execution_digest = v_request.execution_operation_digest THEN
          RETURN jsonb_build_object('ok', true, 'outcomeKind', 'replayed', 'reviewRequestId', p_review_request_id);
        ELSE
          RAISE EXCEPTION 'execute_approved_semantic_topic_lifecycle_transition: idempotency_key % already used with a different execution', p_idempotency_key;
        END IF;
      ELSIF v_request.status <> 'approved' THEN
        RAISE EXCEPTION 'execute_approved_semantic_topic_lifecycle_transition: REVIEW_REQUEST_NOT_EXECUTABLE -- status=%', v_request.status;
      END IF;

      SELECT * INTO v_topic FROM public.semantic_topics WHERE id = v_request.semantic_topic_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_approved_semantic_topic_lifecycle_transition: semantic_topic % not found', v_request.semantic_topic_id;
      END IF;

      IF v_topic.lifecycle_status IS DISTINCT FROM v_request.from_status THEN
        RAISE EXCEPTION 'execute_approved_semantic_topic_lifecycle_transition: STALE_TOPIC_STATE -- topic lifecycle_status=% no longer matches request.from_status=%', v_topic.lifecycle_status, v_request.from_status;
      END IF;
      IF v_topic.status_version IS DISTINCT FROM v_request.expected_status_version THEN
        RAISE EXCEPTION 'execute_approved_semantic_topic_lifecycle_transition: STALE_TOPIC_VERSION -- topic status_version=% no longer matches expected=%', v_topic.status_version, v_request.expected_status_version;
      END IF;

      -- Friss vektor-ujraszamitas -- a request-letrehozaskor tarolt
      -- pillanatkep digestjevel osszevetve. Eltero digest =>
      -- STALE_REVIEW_REQUEST, zart, nem-kivetel valasz -- NINCS
      -- automatikus retry, NINCS uj snapshot csendes keszitese.
      v_fresh_vector := public.compute_topic_evidence_vector(v_request.semantic_topic_id);
      v_fresh_snapshot_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"semanticTopicId":%s,"targetStatus":%s,"policyVersion":%s,"snapshot":%s}',
          to_json(v_snapshot_domain)::text, to_json(v_request.semantic_topic_id::text)::text,
          to_json(v_request.target_status)::text, to_json(v_request.review_policy_version)::text, v_fresh_vector::text
        ), 'UTF8')), 'hex');
      IF v_fresh_snapshot_digest <> v_request.evidence_vector_digest THEN
        RETURN jsonb_build_object('ok', false, 'reasonCode', 'STALE_REVIEW_REQUEST');
      END IF;

      -- coherent cel eseten a mechanikus minimumot vegrehajtaskor is
      -- ujra ellenorizzuk (defense-in-depth -- bar a digest-egyezes
      -- mar bizonyitja, hogy a vektor nem valtozott a snapshot ota).
      IF v_request.target_status = 'coherent' THEN
        IF coalesce((v_fresh_vector->>'eligibleDistinctSourceIdentityCount')::bigint, 0) < 2
           OR (v_fresh_vector->>'evidenceIdentityComplete')::boolean IS NOT TRUE
           OR (v_fresh_vector->>'sourceIdentityKnown')::boolean IS NOT TRUE
           OR (v_fresh_vector->>'assignmentReasonBreakdownComplete')::boolean IS NOT TRUE
        THEN
          RETURN jsonb_build_object('ok', false, 'reasonCode', 'STALE_REVIEW_REQUEST');
        END IF;
      END IF;

      -- Sikeres vegrehajtas -- pontosan egyszer modositja a
      -- lifecycle_status/status_version mezoket. Nem nyul
      -- membershiphez, topic identity payloadhoz vagy assignment
      -- decisionhoz.
      UPDATE public.semantic_topics SET lifecycle_status = v_request.target_status, status_version = status_version + 1, updated_at = now()
      WHERE id = v_request.semantic_topic_id;

      v_execution_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"review_request_id":%s,"execution_idempotency_key":%s,"decision_operation_digest":%s}',
          to_json(v_domain)::text, to_json(p_review_request_id::text)::text, to_json(p_idempotency_key)::text, to_json(v_request.decision_operation_digest)::text
        ), 'UTF8')), 'hex');

      UPDATE public.semantic_topic_lifecycle_review_requests SET
        status = 'executed', executed_at = now(), execution_idempotency_key = p_idempotency_key, execution_operation_digest = v_execution_digest
      WHERE id = p_review_request_id;

      INSERT INTO public.semantic_topic_lifecycle_review_events (review_request_id, event_type, actor_kind, policy_version, operation_digest)
      VALUES (p_review_request_id, 'executed', 'service_role_system', v_supported_policy_version, v_execution_digest);

      v_transition_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format('{"domain":%s,"review_request_id":%s,"from_status":%s,"target_status":%s,"new_status_version":%s}',
          to_json(v_transition_domain)::text, to_json(p_review_request_id::text)::text, to_json(v_request.from_status)::text,
          to_json(v_request.target_status)::text, to_json(v_topic.status_version + 1)::text
        ), 'UTF8')), 'hex');

      INSERT INTO public.semantic_topic_lifecycle_transition_events (
        semantic_topic_id, review_request_id, from_status, target_status, new_status_version, transition_digest
      ) VALUES (
        v_request.semantic_topic_id, p_review_request_id, v_request.from_status, v_request.target_status, v_topic.status_version + 1, v_transition_digest
      ) RETURNING id INTO v_transition_event_id;

      RETURN jsonb_build_object(
        'ok', true, 'outcomeKind', 'executed', 'reviewRequestId', p_review_request_id,
        'semanticTopicId', v_request.semantic_topic_id, 'newLifecycleStatus', v_request.target_status,
        'transitionEventId', v_transition_event_id
      );
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.execute_approved_semantic_topic_lifecycle_transition(UUID, TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.execute_approved_semantic_topic_lifecycle_transition(UUID, TEXT) TO service_role;

    RAISE NOTICE '087: execute_approved_semantic_topic_lifecycle_transition created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '087: execute_approved_semantic_topic_lifecycle_transition already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'execute_approved_semantic_topic_lifecycle_transition';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql' AND p.provolatile = 'v' AND p.proisstrict IS FALSE AND p.prosecdef IS TRUE
        AND p.proparallel = 'u' AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '087 drift: execute_approved_semantic_topic_lifecycle_transition structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '087 drift: execute_approved_semantic_topic_lifecycle_transition body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE') OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid)))) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'service_role')
       )
    THEN
      RAISE EXCEPTION '087 drift: execute_approved_semantic_topic_lifecycle_transition ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '087: execute_approved_semantic_topic_lifecycle_transition already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '087 fail-closed: execute_approved_semantic_topic_lifecycle_transition has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_easltt$;

-- ============================================================
-- 8. Fail-fast vegallapot onellenorzes.
-- ============================================================

DO $final_selfcheck_087$
DECLARE
  v_hash text;
  v_expected_csltrr_hash CONSTANT text := '3184eae2b484552478e36131a5c4d8e0';
  v_expected_rsltrd_hash CONSTANT text := 'df3441416c551b224337dff95b6483b1';
  v_expected_cancel_hash CONSTANT text := 'c3707f8f6d39967229c40f4898300e01';
  v_expected_easltt_hash CONSTANT text := 'a5edcd761ee5a9f7becdbab118d9b87d';
BEGIN
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.create_semantic_topic_lifecycle_review_request(uuid, text, text)'::regprocedure;
  IF v_hash <> v_expected_csltrr_hash THEN
    RAISE EXCEPTION '087 CRITICAL: create_semantic_topic_lifecycle_review_request final body hash (%) does not match expected.', v_hash;
  END IF;

  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.record_semantic_topic_lifecycle_review_decision(uuid, text, text, text, text, boolean, boolean, boolean, boolean, integer)'::regprocedure;
  IF v_hash <> v_expected_rsltrd_hash THEN
    RAISE EXCEPTION '087 CRITICAL: record_semantic_topic_lifecycle_review_decision final body hash (%) does not match expected.', v_hash;
  END IF;

  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.cancel_semantic_topic_lifecycle_review_request(uuid, text)'::regprocedure;
  IF v_hash <> v_expected_cancel_hash THEN
    RAISE EXCEPTION '087 CRITICAL: cancel_semantic_topic_lifecycle_review_request final body hash (%) does not match expected.', v_hash;
  END IF;

  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.execute_approved_semantic_topic_lifecycle_transition(uuid, text)'::regprocedure;
  IF v_hash <> v_expected_easltt_hash THEN
    RAISE EXCEPTION '087 CRITICAL: execute_approved_semantic_topic_lifecycle_transition final body hash (%) does not match expected.', v_hash;
  END IF;

  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN (
    'semantic_topic_lifecycle_review_requests', 'semantic_topic_lifecycle_review_events', 'semantic_topic_lifecycle_transition_events'
  )) <> 3 THEN
    RAISE EXCEPTION '087 CRITICAL: not all 3 new tables present after this migration.';
  END IF;

  -- 086 sajat fuggvenye erintetlen maradt -- ez a migracio soha nem
  -- nyul a 086-osan mar lezart eligible-source helperhez/RPC-khez.
  IF (SELECT md5(replace(prosrc, E'\r\n', E'\n')) FROM pg_proc WHERE oid = 'public.compute_topic_evidence_vector(uuid)'::regprocedure) <> '73aeb37846bcc80fd42a4e2c8862dc7c' THEN
    RAISE EXCEPTION '087 CRITICAL: compute_topic_evidence_vector body hash changed -- this migration must NEVER touch it. Aborting.';
  END IF;

  RAISE NOTICE '087: final self-check passed -- all 4 RPCs and 3 tables present with expected corrected body hashes, 086 confirmed unchanged.';
END;
$final_selfcheck_087$;

NOTIFY pgrst, 'reload schema';

COMMIT;
