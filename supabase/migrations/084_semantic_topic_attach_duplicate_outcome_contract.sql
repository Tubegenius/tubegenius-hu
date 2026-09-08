-- ============================================================
-- Migration 084: Semantic Topic Identity v0 -- Human-Reviewed
-- Candidate Workflow, ATTACH_EXISTING/duplicate_search_outcome
-- contract correction.
--
-- Kanonikus szerzodes forrasa: docs/architecture/semantic-topic-identity-v0-contract.md
-- SS37.
--
-- BUG, amit ez a migracio jav­t: a 077-es tabla-CHECK
-- (topic_assignment_review_requests_dup_search_check) es a 078-as
-- record_topic_assignment_review_decision RPC eddig KIZAROLAG ket
-- duplicate_search_outcome erteket ismerte -- 'no_duplicate_found' es
-- 'possible_duplicate_reviewed_and_distinct' -- proposed_outcome-tol
-- FUGGETLENUL. Mindket ertek TENYSZERUEN HAMIS egy ATTACH_EXISTING
-- dontesnel: a reviewer eppen egy MEGLEVO topic-hoz csatol, azaz
-- TALALT egyezest -- 'no_duplicate_found' ezt kozvetlenul tagadja,
-- 'possible_duplicate_reviewed_and_distinct' pedig pont az ellenkezojet
-- allitja (hogy a talalat MEGKULONBOZTETHETO, nem egyezo).
--
-- HATOKOR -- additiv, kizarolag ezt a szuk hibat javitja:
--   1. topic_assignment_review_requests_dup_search_check bovitese egy
--      harmadik ertekkel: 'existing_topic_match_confirmed'.
--   2. UJ CHECK -- topic_assignment_review_requests_dup_search_outcome_pairing
--      -- amely fail-closed modon parositja proposed_outcome-ot es
--      duplicate_search_outcome-ot:
--        ATTACH_EXISTING -> KIZAROLAG existing_topic_match_confirmed
--        CREATE_NEW      -> KIZAROLAG a ket regi ertek (existing_topic_match_confirmed TILOS)
--      proposed_outcome IS NULL (pending/rejected/expired/cancelled
--      allapotban) eseten a CHECK mindig atenged -- ugyanaz az IS
--      NULL-elso idioma, mint a tobbi 077-es kondicionalis CHECK-nek
--      (topic_assignment_review_requests_create_new_no_target /
--      _attach_requires_target).
--   3. record_topic_assignment_review_decision (078) CREATE OR REPLACE
--      -- ugyanaz a szignatura, ugyanaz a nyolc digest-formula-string
--      (a mezolista es sorrend VALTOZATLAN -- l. alant, miert nem kell
--      approval_digest_version-t emelni), csak KET UJ IF...RAISE
--      EXCEPTION blokk kerul bele, amely a fenti parositast a valos
--      RPC-hivas idejen is kikenyszeriti (nem csak a tabla-CHECK-en
--      keresztul -- belt-and-suspenders, ahogy ez a kodbazis mindenutt
--      teszi).
--
-- NEM VALTOZIK: approval_digest_version marad 1 (a digest FORMULA --
-- a mezolista es sorrend -- nem valtozik, csak egy MAR LETEZO mezo
-- (duplicate_search_outcome) megengedett ertekkeszlete bovul -- ez
-- nem ugyanaz, mint egy uj mezo hozzaadasa vagy a formula
-- atrendezese). execute_approved_topic_assignment_review (078) NEM
-- valtozik -- csak UJRASZAMOLJA es OSSZEVETI a tarolt approval_digestet,
-- a formula ismerete nala mar korabban is a 084 utani harom-erteku
-- duplicate_search_outcome-ot kell hogy tamogassa, es MAR IS
-- tamogatja, mert a to_json(p_duplicate_search_outcome) hivas
-- ertek-agnosztikus. record_topic_assignment_decision (074) es minden
-- mas 072-083 tabla/RPC bizonyithatoan erintetlen.
--
-- MINTA: pontosan a 077-es decision_reason-bovites (hash-gatelt
-- ALTER CHECK, DROP+ADD csak ismert legacy definiciobol, MINDIG
-- RAISE EXCEPTION driftre) ES a 076-os record_topic_extraction_run/
-- reserve_ai_provider_units korrekcio (hash-gatelt CREATE OR REPLACE
-- FUNCTION, elozetes es utolagos strukturalis/ACL-ellenorzessel)
-- otvozete. Nincs CASCADE. Egyetlen tranzakcio.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. ELOFELTETEL-KAPU -- a 077/078 baseline objektumoknak pontosan a
--    vart allapotban kell lenniuk, mielott ez a migracio barmit is
--    erintene.
-- ============================================================

DO $preflight$
DECLARE
  v_table_exists boolean;
  v_fn_count int;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'topic_assignment_review_requests'
  ) INTO v_table_exists;
  IF NOT v_table_exists THEN
    RAISE EXCEPTION '084 fail-closed: topic_assignment_review_requests does not exist -- 077 must be applied first';
  END IF;

  SELECT count(*) INTO v_fn_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_topic_assignment_review_decision';
  IF v_fn_count <> 1 THEN
    RAISE EXCEPTION '084 fail-closed: record_topic_assignment_review_decision has % overloads, expected exactly 1 -- 078 must be applied first', v_fn_count;
  END IF;

  RAISE NOTICE '084: preflight gate passed (077/078 baseline present).';
END;
$preflight$;

-- ============================================================
-- 1. topic_assignment_review_requests_dup_search_check -- additiv
--    bovites egy harmadik ertekkel. Ugyanaz a hash-gatelt DROP+ADD
--    idioma, mint a 077-es decision_reason-bovitesnel (5. blokk).
-- ============================================================

DO $migrate_dup_search_check$
DECLARE
  v_current_def text;
  v_legacy_def CONSTANT text := 'CHECK (duplicate_search_outcome IS NULL OR (duplicate_search_outcome = ANY (ARRAY[''no_duplicate_found''::text, ''possible_duplicate_reviewed_and_distinct''::text])))';
  v_corrected_def CONSTANT text := 'CHECK (duplicate_search_outcome IS NULL OR (duplicate_search_outcome = ANY (ARRAY[''no_duplicate_found''::text, ''possible_duplicate_reviewed_and_distinct''::text, ''existing_topic_match_confirmed''::text])))';
BEGIN
  SELECT pg_get_constraintdef(oid, true) INTO v_current_def
  FROM pg_constraint
  WHERE conrelid = 'public.topic_assignment_review_requests'::regclass
    AND conname = 'topic_assignment_review_requests_dup_search_check';

  IF v_current_def IS NULL THEN
    RAISE EXCEPTION '084 fail-closed: topic_assignment_review_requests_dup_search_check not found -- expected the 077 baseline to exist. No DDL will run.';
  ELSIF v_current_def = v_corrected_def THEN
    RAISE NOTICE '084: topic_assignment_review_requests_dup_search_check already corrected -- no-op.';
  ELSIF v_current_def = v_legacy_def THEN
    RAISE NOTICE '084: topic_assignment_review_requests_dup_search_check is the known 077 legacy definition -- correcting.';
    ALTER TABLE public.topic_assignment_review_requests DROP CONSTRAINT topic_assignment_review_requests_dup_search_check;
    ALTER TABLE public.topic_assignment_review_requests ADD CONSTRAINT topic_assignment_review_requests_dup_search_check
      CHECK (duplicate_search_outcome IS NULL OR duplicate_search_outcome IN (
        'no_duplicate_found', 'possible_duplicate_reviewed_and_distinct', 'existing_topic_match_confirmed'
      ));

    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint
    WHERE conrelid = 'public.topic_assignment_review_requests'::regclass
      AND conname = 'topic_assignment_review_requests_dup_search_check';
    IF v_current_def <> v_corrected_def THEN
      RAISE EXCEPTION '084 post-alter self-check failed: new dup_search_check definition does not match the expected corrected text exactly (got: %)', v_current_def;
    END IF;
    RAISE NOTICE '084: topic_assignment_review_requests_dup_search_check corrected to include existing_topic_match_confirmed.';
  ELSE
    RAISE EXCEPTION '084 fail-closed: DEFINITION_DRIFT -- topic_assignment_review_requests_dup_search_check is neither the known 077 legacy definition nor the corrected definition (got: %). No DDL will run.', v_current_def;
  END IF;
END;
$migrate_dup_search_check$;

-- ============================================================
-- 2. UJ CHECK -- topic_assignment_review_requests_dup_search_outcome_pairing.
--    proposed_outcome IS NULL -> mindig atenged (pending/rejected/
--    expired/cancelled soha nem tolti ki egyszerre a ket mezot -- l.
--    a mar letezo statuszonkenti field-completeness CHECK-eket, ezek
--    valtozatlanok). Csak akkor ervenyesul, ha proposed_outcome MAR
--    KI VAN TOLTVE (approved/revoked/executed).
-- ============================================================

DO $migrate_dup_search_pairing$
DECLARE
  v_current_def text;
  v_corrected_def CONSTANT text := 'CHECK (proposed_outcome IS NULL OR proposed_outcome = ''ATTACH_EXISTING''::text AND duplicate_search_outcome = ''existing_topic_match_confirmed''::text OR proposed_outcome = ''CREATE_NEW''::text AND (duplicate_search_outcome = ANY (ARRAY[''no_duplicate_found''::text, ''possible_duplicate_reviewed_and_distinct''::text])))';
BEGIN
  SELECT pg_get_constraintdef(oid, true) INTO v_current_def
  FROM pg_constraint
  WHERE conrelid = 'public.topic_assignment_review_requests'::regclass
    AND conname = 'topic_assignment_review_requests_dup_search_outcome_pairing';

  IF v_current_def IS NULL THEN
    RAISE NOTICE '084: topic_assignment_review_requests_dup_search_outcome_pairing does not exist -- CREATE branch.';
    ALTER TABLE public.topic_assignment_review_requests ADD CONSTRAINT topic_assignment_review_requests_dup_search_outcome_pairing
      CHECK (
        proposed_outcome IS NULL
        OR (proposed_outcome = 'ATTACH_EXISTING' AND duplicate_search_outcome = 'existing_topic_match_confirmed')
        OR (proposed_outcome = 'CREATE_NEW' AND duplicate_search_outcome IN ('no_duplicate_found', 'possible_duplicate_reviewed_and_distinct'))
      );

    SELECT pg_get_constraintdef(oid, true) INTO v_current_def
    FROM pg_constraint
    WHERE conrelid = 'public.topic_assignment_review_requests'::regclass
      AND conname = 'topic_assignment_review_requests_dup_search_outcome_pairing';
    IF v_current_def <> v_corrected_def THEN
      RAISE EXCEPTION '084 post-create self-check failed: new dup_search_outcome_pairing definition does not match the expected text exactly (got: %)', v_current_def;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.topic_assignment_review_requests'::regclass
        AND c.conname = 'topic_assignment_review_requests_dup_search_outcome_pairing' AND c.contype = 'c'
        AND c.convalidated IS true AND c.condeferrable IS false AND c.condeferred IS false
    ) THEN
      RAISE EXCEPTION '084 post-create self-check failed: dup_search_outcome_pairing is not a validated, non-deferrable CHECK constraint';
    END IF;
    RAISE NOTICE '084: topic_assignment_review_requests_dup_search_outcome_pairing created.';
  ELSIF v_current_def = v_corrected_def THEN
    RAISE NOTICE '084: topic_assignment_review_requests_dup_search_outcome_pairing already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '084 fail-closed: DEFINITION_DRIFT -- topic_assignment_review_requests_dup_search_outcome_pairing exists but does not match the expected text exactly (got: %). No DDL will run.', v_current_def;
  END IF;
END;
$migrate_dup_search_pairing$;

-- ============================================================
-- 3. record_topic_assignment_review_decision -- CREATE OR REPLACE
--    with the corrected body (same signature, same 8 digest-formula
--    format() strings verbatim -- only two new IF...RAISE EXCEPTION
--    application-level validation blocks added). Hash-gated exactly
--    like 076's record_topic_extraction_run/reserve_ai_provider_units
--    correction: legacy body_hash -> replace; already-corrected
--    body_hash -> no-op; anything else -> RAISE EXCEPTION, no DDL.
-- ============================================================

DO $migrate_rtard_084$
DECLARE
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_legacy_hash CONSTANT text := '044169f63ad29e599208853204e95e18';
  v_corrected_hash CONSTANT text := 'cf8fa6dece05fc6e8f24a361939acce9';
  v_expected_args CONSTANT text := 'p_review_request_id uuid, p_decision_idempotency_key text, p_outcome text, p_canonical_topic_label text, p_topic_definition text, p_scope text, p_inclusion_criteria text, p_exclusion_criteria text, p_lane_neutral_confirmed boolean, p_evidence_adequacy text, p_duplicate_search_outcome text, p_proposed_outcome text, p_target_semantic_topic_id uuid, p_uncertainty_classification text, p_reviewer_rationale text, p_review_policy_version integer, p_rejection_reason text';
BEGIN
  v_oid := to_regprocedure('public.record_topic_assignment_review_decision(uuid, text, text, text, text, text, text, text, boolean, text, text, text, uuid, text, text, integer, text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '084 fail-closed: public.record_topic_assignment_review_decision(...) does not exist -- 078 must be applied first';
  END IF;
  IF pg_get_function_identity_arguments(v_oid) <> v_expected_args THEN
    RAISE EXCEPTION '084 drift: record_topic_assignment_review_decision argument list does not match the expected 078 signature before replace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
  ) THEN
    RAISE EXCEPTION '084 drift: record_topic_assignment_review_decision owner/SECURITY DEFINER/search_path does not match the expected baseline before replace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'record_topic_assignment_review_decision' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '084 drift: record_topic_assignment_review_decision is missing the authenticated EXECUTE grant before replace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'record_topic_assignment_review_decision' AND grantee NOT IN ('authenticated', 'postgres')
  ) THEN
    RAISE EXCEPTION '084 drift: record_topic_assignment_review_decision has an unexpected EXECUTE grantee before replace';
  END IF;

  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
  v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));

  IF v_hash = v_corrected_hash THEN
    RAISE NOTICE '084: record_topic_assignment_review_decision already exactly the corrected body -- no-op.';
  ELSIF v_hash <> v_legacy_hash THEN
    RAISE EXCEPTION '084 fail-closed: DEFINITION_DRIFT -- record_topic_assignment_review_decision body_hash=% is neither the known 078 legacy hash nor the corrected hash. No DDL will run.', v_hash;
  ELSE
    RAISE NOTICE '084: record_topic_assignment_review_decision is the known 078 legacy body -- REPLACE branch (ATTACH_EXISTING/duplicate_search_outcome pairing enforcement).';

    CREATE OR REPLACE FUNCTION public.record_topic_assignment_review_decision(
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

      -- FOR SHARE: closes the TOCTOU window where a concurrent
      -- deactivation of this exact reviewer could otherwise commit
      -- between this check and this call's own commit.
      SELECT * INTO v_reviewer FROM public.semantic_topic_reviewers WHERE user_id = v_caller_user_id AND active IS TRUE FOR SHARE;
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

        -- Migration 084 -- fail-closed pairing rule: a duplicate_search_outcome
        -- value now asserts something specific about whether a matching
        -- existing topic was found, so it must agree with proposed_outcome.
        -- ATTACH_EXISTING means the reviewer FOUND a match and is attaching to
        -- it -- 'no_duplicate_found' and 'possible_duplicate_reviewed_and_distinct'
        -- are both factually false for that case (see
        -- docs/architecture/semantic-topic-identity-v0-contract.md SS37).
        IF p_proposed_outcome = 'ATTACH_EXISTING' AND p_duplicate_search_outcome <> 'existing_topic_match_confirmed' THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: ATTACH_EXISTING requires duplicate_search_outcome=existing_topic_match_confirmed (got %)', p_duplicate_search_outcome;
        END IF;
        IF p_proposed_outcome = 'CREATE_NEW' AND p_duplicate_search_outcome NOT IN ('no_duplicate_found', 'possible_duplicate_reviewed_and_distinct') THEN
          RAISE EXCEPTION 'record_topic_assignment_review_decision: CREATE_NEW requires duplicate_search_outcome no_duplicate_found or possible_duplicate_reviewed_and_distinct (got %)', p_duplicate_search_outcome;
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

    -- CREATE OR REPLACE FUNCTION preserves owner and ACL automatically
    -- when the signature is unchanged (Postgres semantics) -- no
    -- REVOKE/GRANT re-run here, deliberately, to avoid a narrow window
    -- where a mistaken re-grant could widen access. The post-replace
    -- self-check below proves the ACL is exactly what it was before.
    RAISE NOTICE '084: record_topic_assignment_review_decision replaced with the corrected body (ATTACH_EXISTING/duplicate_search_outcome pairing enforcement).';
  END IF;

  -- ------------------------------------------------------------
  -- Post-replace (or post-no-op) self-check -- runs in BOTH branches,
  -- proving the final state is exactly the corrected one either way.
  -- ------------------------------------------------------------
  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
  v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
  IF v_hash <> v_corrected_hash THEN
    RAISE EXCEPTION '084 drift: post-replace record_topic_assignment_review_decision body_hash (%) does not match the expected corrected hash', v_hash;
  END IF;
  IF pg_get_function_identity_arguments(v_oid) <> v_expected_args THEN
    RAISE EXCEPTION '084 drift: post-replace record_topic_assignment_review_decision argument list changed unexpectedly';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
  ) THEN
    RAISE EXCEPTION '084 drift: post-replace record_topic_assignment_review_decision owner/SECURITY DEFINER/search_path changed unexpectedly';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'record_topic_assignment_review_decision' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '084 drift: post-replace record_topic_assignment_review_decision missing the authenticated EXECUTE grant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'record_topic_assignment_review_decision' AND grantee NOT IN ('authenticated', 'postgres')
  ) THEN
    RAISE EXCEPTION '084 drift: post-replace record_topic_assignment_review_decision has an unexpected EXECUTE grantee';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_topic_assignment_review_decision') <> 1 THEN
    RAISE EXCEPTION '084 drift: unexpected record_topic_assignment_review_decision overload count after replace';
  END IF;

  RAISE NOTICE '084: record_topic_assignment_review_decision final self-check passed (body_hash=%, signature/owner/search_path/ACL exact).', v_hash;
END;
$migrate_rtard_084$;

-- ============================================================
-- 4. Fail-fast vegallapot onellenorzes -- a MEGLEVO
--    record_topic_assignment_decision (074) es
--    execute_approved_topic_assignment_review (078) fuggvenyek
--    torzse/szignaturaja bizonyithatoan VALTOZATLAN maradt ebben a
--    migracioban -- ugyanaz a minta, mint a 077-es 6. blokk.
-- ============================================================

DO $final_selfcheck$
DECLARE
  v_hash text;
  v_expected_hash_074 CONSTANT text := '759de5ab474c9a7aa105564ca95541cc';
  v_expected_args_074 CONSTANT text := 'p_extraction_run_id uuid, p_outcome text, p_decision_reason text, p_deterministic_signals jsonb, p_idempotency_key text, p_existing_semantic_topic_id uuid';
  v_actual_args text;
  v_execute_fn_count int;
BEGIN
  SELECT md5(replace(prosrc, E'\r\n', E'\n')), pg_get_function_identity_arguments(oid)
    INTO v_hash, v_actual_args
  FROM pg_proc WHERE oid = 'public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)'::regprocedure;

  IF v_hash <> v_expected_hash_074 THEN
    RAISE EXCEPTION '084 CRITICAL: record_topic_assignment_decision body hash changed (got %, expected %) -- this migration must NEVER touch this function. Aborting.', v_hash, v_expected_hash_074;
  END IF;
  IF v_actual_args <> v_expected_args_074 THEN
    RAISE EXCEPTION '084 CRITICAL: record_topic_assignment_decision signature changed (got %, expected %) -- this migration must NEVER touch this function. Aborting.', v_actual_args, v_expected_args_074;
  END IF;

  SELECT count(*) INTO v_execute_fn_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'execute_approved_topic_assignment_review';
  IF v_execute_fn_count <> 1 THEN
    RAISE EXCEPTION '084 CRITICAL: execute_approved_topic_assignment_review has % overloads (expected exactly 1) -- this migration must never touch this function. Aborting.', v_execute_fn_count;
  END IF;

  RAISE NOTICE '084: final self-check passed -- record_topic_assignment_decision (074) and execute_approved_topic_assignment_review (078) confirmed unchanged.';
END;
$final_selfcheck$;

NOTIFY pgrst, 'reload schema';

COMMIT;
