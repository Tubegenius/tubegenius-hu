-- ============================================================
-- Migration 086: Semantic Topic Identity v0 -- eligible-source
-- identity correctness remediation.
--
-- HATOKOR: EGYETLEN uj, plain (nem SECURITY DEFINER), kizarolag belso
-- hasznalatra szant helper fuggveny
-- (public._semantic_topic_eligible_membership_sources), plusz HAROM
-- MAR ELES, korabban letrehozott RPC testenek CREATE OR REPLACE-e
-- (record_topic_assignment_decision -- 074; execute_approved_topic_
-- assignment_review -- 078; compute_topic_evidence_vector -- 085).
-- A 072/074/078/084/085 migracios FAJLOK valtozatlanok maradnak --
-- ez a migracio kizarolag a pg_proc-ban elo FUGGVENYTESTEKET cvsereli,
-- pontosan a 084-es migracio mar bevalt precedense szerint
-- (record_topic_assignment_review_decision CREATE OR REPLACE-e).
--
-- MIERT KELL EZ A REMEDIACIO: a 074/078 eddigi
-- candidate_singleton->corroborating automatikus atmenete nyers
-- `count(*) FROM semantic_topic_membership WHERE ... valid_to IS NULL`
-- -t hasznalt -- ez NEM ugyanaz, mint a 085 `knownIndependentSourceCount`
-- mezoje (ami channel_id szerinti DISTINCT szamlalas volt). Harom valos
-- hamis-pozitiv forgatokonyv: (1) azonos csatorna ket membershipje;
-- (2) ismeretlen forras; (3) szindikacios-masolat evidence. A helyes,
-- egysegesitett javitas: EGYETLEN kozos definicio a "eligibilis forras-
-- identitas" fogalmara, amit mind a ket writer RPC, mind a
-- compute_topic_evidence_vector RPC ugyanabbol a helperbol szamol.
--
-- A KANONIKUS FORRAS-IDENTITAS: `signal_evidence.signal_source_id`
-- (NOT NULL, ON DELETE RESTRICT -- soha nem torolhet ki alola a
-- hivatkozott signal_sources sor) -- NEM a `youtube_videos.channel_id`
-- (nullable, ON DELETE SET NULL -- terekeny, es csak YouTube evidence-re
-- mukodik). A `signal_sources` tabla mar ma is egysegesen, tipusozottan
-- (`source_type` IN ('youtube_channel', 'web_domain')) es normalizaltan
-- (ld. lib/emerging-signal/capture.ts deriveYoutubeSourceKey/
-- deriveWebSourceKey, lib/emerging-signal/normalize.ts extractDomain)
-- tarolja mind a YouTube-csatorna, mind a web-domain forras-identitast
-- -- ezt a mar elo, eles infrastrukturat hasznaljuk ujra, nem talalunk
-- ki uj mezot vagy normalizaciot.
--
-- "corroborating" JELENTESENEK PONTOSITASA: a `candidate_singleton ->
-- corroborating` automatikus atmenet es a `compute_topic_evidence_vector`
-- `eligibleDistinctSourceIdentityCount` mezoje KIZAROLAG "mechanikus
-- forras-diverzitast" bizonyit -- kulonbozo, ismert `signal_source_id`-k
-- jelenletet az eligibilis (aktiv + nem szindikacios-masolat) membership-
-- halmazban. NEM bizonyit szerkesztoi/szerzoi fuggetlenseget (egy kulon
-- forras lehet derivativ, reupload, vagy ugyanazon muhelybol szarmazo
-- tartalom) es NEM bizonyit szemantikai azonossag-konzisztenciat. A
-- valodi provenance-fuggetlenseget es szemantikai koherenciat kizarolag
-- egy kesobbi, human-review-gated "coherent" atmenet igazolhatja --
-- ennek a migracionak nincs resze, csak a mechanikus szamlalo
-- korrektsege.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. FUGGOSEGI ELOFELTETEL -- a 6 erintett baseline tablanak
--    pontosan a vart allapotban kell lenniuk.
-- ============================================================

DO $preflight$
DECLARE
  v_table_count int;
BEGIN
  SELECT count(*) INTO v_table_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('semantic_topics', 'semantic_topic_membership', 'topic_extraction_runs', 'signal_evidence', 'youtube_videos', 'signal_sources');
  IF v_table_count <> 6 THEN
    RAISE EXCEPTION '086 fail-closed: % of 6 required baseline tables present (semantic_topics, semantic_topic_membership, topic_extraction_runs, signal_evidence, youtube_videos, signal_sources) -- 049/051/072 must be fully applied first.', v_table_count;
  END IF;

  RAISE NOTICE '086: preflight gate passed (baseline tables present).';
END;
$preflight$;

-- ============================================================
-- 1. public._semantic_topic_eligible_membership_sources -- UJ, plain
--    (NEM SECURITY DEFINER), STABLE, LANGUAGE sql helper. Egyetlen
--    definicioja az "eligibilis membership + forras-identitas" halmaznak
--    -- ezt hasznalja mind a ket writer RPC (candidate_singleton ->
--    corroborating enforcement), mind a compute_topic_evidence_vector.
--
--    Biztonsag: ZERO kulso grant (meg service_role sem kapja kozvetlenul
--    -- kizarolag a masik ket, mar postgres-tulajdonu SECURITY DEFINER
--    RPC-bol erheto el, mert azok postgres tulajdonosi kontextusban
--    futva implicit vegre tudjak hajtani a sajat tulajdonu objektumaikat,
--    grant nelkul is). PostgreSQL minden uj fuggvenyre alapertelmezetten
--    EXECUTE-et ad PUBLIC-nak -- ezt itt explicit visszavonjuk, nem
--    feltetelezzuk, hogy grant hianyaban automatikusan privat.
-- ============================================================

DO $migrate_helper$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'fba8af744970df7f93ba96fd71d2a939';
  v_expected_args CONSTANT text := 'p_semantic_topic_id uuid';
  v_expected_result CONSTANT text := 'TABLE(membership_id uuid, evidence_id uuid, source_identity_id uuid, source_type text, assignment_reason text, algorithm_version integer, confidence numeric, evidence_type text, evidence_identity_complete boolean)';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '_semantic_topic_eligible_membership_sources';

  IF v_name_count = 0 THEN
    RAISE NOTICE '086: _semantic_topic_eligible_membership_sources does not exist -- CREATE branch.';

    -- Egyetlen, elore rogzitett eligibilitasi feltetel (aktiv: valid_to
    -- IS NULL; eligibilis: aktiv ES nem ismert szindikacios-masolat) --
    -- ezt EGYETLEN helyen definialjuk, mind a harom hivo (a ket writer
    -- RPC es a compute_topic_evidence_vector) innen olvassa. A
    -- `signal_sources`-t LEFT JOIN-nal kotjuk be -- NEM azert, mert ma
    -- barmelyik sor NULL-t adhatna (signal_evidence.signal_source_id
    -- NOT NULL, ON DELETE RESTRICT -- ma strukturalisan lehetetlen), de
    -- azert, hogy az eligibleMembershipCount (a hivo oldalon) TOVABBRA
    -- IS az OSSZES eligibilis membershipet szamolja, fuggetlenul a
    -- forras-feloldastol -- ha egy jovobeli semakorrekcio valaha
    -- nullable-ra valtoztatna ezt a mezot, ez a helper es minden hivoja
    -- azonnal, csendes hiba nelkul helyesen kezelne az "ismeretlen
    -- forras" esetet (source_identity_id/source_type NULL, a hivo
    -- COUNT(DISTINCT source_identity_id)-je automatikusan kizarja).
    CREATE FUNCTION public._semantic_topic_eligible_membership_sources(
      p_semantic_topic_id UUID
    ) RETURNS TABLE (
      membership_id UUID,
      evidence_id UUID,
      source_identity_id UUID,
      source_type TEXT,
      assignment_reason TEXT,
      algorithm_version INTEGER,
      confidence NUMERIC,
      evidence_type TEXT,
      evidence_identity_complete BOOLEAN
    )
    LANGUAGE sql STABLE
    SET search_path = public, pg_temp
    AS $helper$
      SELECT
        m.id,
        se.id,
        ss.id,
        ss.source_type,
        m.assignment_reason,
        m.algorithm_version,
        m.confidence,
        se.evidence_type,
        -- Evidence-type-specifikus stabil-identitas feltetel -- YouTube-nal
        -- az external_ref (garantalt NOT NULL/not-blank a semaban), minden
        -- ma tamogatott nem-YouTube tipusnal a canonical_url (a 051 CHECK
        -- mar ma kikenyszeriti nem-YouTube-nal). Barmilyen JOVOBELI,
        -- ismeretlen evidence_type fail-closed FALSE-t kap -- soha nem
        -- feltetelezunk ismeretlen tipusra biztonsagos identitast.
        CASE se.evidence_type
          WHEN 'youtube_video' THEN (se.external_ref IS NOT NULL AND btrim(se.external_ref) <> '')
          WHEN 'serper_web' THEN (se.canonical_url IS NOT NULL AND btrim(se.canonical_url) <> '')
          WHEN 'serper_news' THEN (se.canonical_url IS NOT NULL AND btrim(se.canonical_url) <> '')
          ELSE FALSE
        END
      FROM public.semantic_topic_membership m
      JOIN public.signal_evidence se ON se.id = m.signal_evidence_id
      LEFT JOIN public.signal_sources ss ON ss.id = se.signal_source_id
      WHERE m.semantic_topic_id = p_semantic_topic_id
        AND m.valid_to IS NULL
        AND se.is_syndication_copy_of IS NULL
    $helper$;

    REVOKE ALL ON FUNCTION public._semantic_topic_eligible_membership_sources(UUID) FROM PUBLIC, anon, authenticated, service_role;

    RAISE NOTICE '086: _semantic_topic_eligible_membership_sources created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '086: _semantic_topic_eligible_membership_sources already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = '_semantic_topic_eligible_membership_sources';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = v_expected_result
        AND l.lanname = 'sql'
        AND p.provolatile = 's'
        AND p.proisstrict IS FALSE
        AND p.prosecdef IS FALSE
        AND p.proparallel = 'u'
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '086 drift: _semantic_topic_eligible_membership_sources structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '086 drift: _semantic_topic_eligible_membership_sources body hash does not match exactly (got %)', v_hash;
    END IF;

    -- has_function_privilege() requires an ACTUAL role name -- 'PUBLIC' is
    -- a GRANT/REVOKE pseudo-role keyword, not a row in pg_roles, so it
    -- cannot be passed to has_function_privilege(). aclexplode() is the
    -- correct, role-name-independent way to check for a PUBLIC grant
    -- (represented as a NULL-grantee/grantee-oid-0 ACL item) alongside any
    -- named-role grant -- same idiom already used by 074/078/085's own ACL
    -- checks, generalized here to "no EXECUTE grant to anyone except the
    -- owner". Once any REVOKE is issued, Postgres materializes the
    -- previously-implicit default ACL (owner=ALL PRIVILEGES, PUBLIC=EXECUTE)
    -- into an explicit proacl with the PUBLIC entry removed -- the owner's
    -- own ALL-PRIVILEGES entry is expected and excluded here, it is not an
    -- "unexpected" grant.
    IF EXISTS (
      SELECT 1 FROM aclexplode(coalesce(
        (SELECT proacl FROM pg_proc WHERE oid = v_oid),
        acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
      )) acl
      WHERE acl.privilege_type = 'EXECUTE' AND acl.grantee <> (SELECT proowner FROM pg_proc WHERE oid = v_oid)
    ) THEN
      RAISE EXCEPTION '086 drift: _semantic_topic_eligible_membership_sources has an unexpected EXECUTE grant (expected NONE besides the owner -- only reachable from within postgres-owned SECURITY DEFINER callers)';
    END IF;

    RAISE NOTICE '086: _semantic_topic_eligible_membership_sources already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '086 fail-closed: _semantic_topic_eligible_membership_sources has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_helper$;

-- ============================================================
-- 2. record_topic_assignment_decision (074) -- CREATE OR REPLACE,
--    3-agu legacy/corrected/unknown hash-kapu, pontosan a 084-es
--    precedens mintaja szerint. Egyetlen valtozas a torzsben: a
--    candidate_singleton -> corroborating enforcement nyers
--    `count(*)`-ja lecserelve a kozos helperbol szamitott
--    `COUNT(DISTINCT source_identity_id)`-re. MINDEN mas parameter,
--    lock-sorrend, idempotencia, decision_digest-keplet, ATTACH_EXISTING/
--    CREATE_NEW/QUARANTINE agazas valtozatlan.
-- ============================================================

DO $migrate_rtad_086$
DECLARE
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_legacy_hash CONSTANT text := '759de5ab474c9a7aa105564ca95541cc';
  v_corrected_hash CONSTANT text := '9e681c94870719a0a7cb4605de458baf';
  v_expected_args CONSTANT text := 'p_extraction_run_id uuid, p_outcome text, p_decision_reason text, p_deterministic_signals jsonb, p_idempotency_key text, p_existing_semantic_topic_id uuid';
BEGIN
  v_oid := to_regprocedure('public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '086 fail-closed: public.record_topic_assignment_decision(...) does not exist -- 074 must be applied first';
  END IF;
  IF pg_get_function_identity_arguments(v_oid) <> v_expected_args THEN
    RAISE EXCEPTION '086 drift: record_topic_assignment_decision argument list does not match the expected 074 signature before replace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND p.provolatile = 'v' AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
  ) THEN
    RAISE EXCEPTION '086 drift: record_topic_assignment_decision owner/SECURITY DEFINER/volatility/search_path does not match the expected baseline before replace';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION '086 drift: record_topic_assignment_decision ACL does not match the expected baseline (service_role EXECUTE only) before replace';
  END IF;

  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
  v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));

  IF v_hash = v_corrected_hash THEN
    RAISE NOTICE '086: record_topic_assignment_decision already exactly the corrected body -- no-op.';
  ELSIF v_hash <> v_legacy_hash THEN
    RAISE EXCEPTION '086 fail-closed: DEFINITION_DRIFT -- record_topic_assignment_decision body_hash=% is neither the known 074 legacy hash nor the corrected hash. No DDL will run.', v_hash;
  ELSE
    RAISE NOTICE '086: record_topic_assignment_decision is the known 074 legacy body -- REPLACE branch (eligible-source-identity-based corroborating enforcement).';

    CREATE OR REPLACE FUNCTION public.record_topic_assignment_decision(
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
      v_min_confidence CONSTANT NUMERIC(5,4) := 0.8500;
      v_algorithm_version CONSTANT INTEGER := 1;
      v_extraction RECORD;
      v_evidence_id UUID;
      v_deterministic_signals JSONB;
      v_deterministic_signals_canonical TEXT;
      v_decision_digest TEXT;
      v_existing RECORD;
      v_specificity TEXT;
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

      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_evidence_id::text, 0));

      v_deterministic_signals := coalesce(p_deterministic_signals, '{}'::jsonb);

      IF EXISTS (
        SELECT 1 FROM jsonb_each(v_deterministic_signals) kv WHERE jsonb_typeof(kv.value) IN ('object', 'array')
      ) THEN
        RAISE EXCEPTION 'record_topic_assignment_decision: deterministic_signals must be a flat object of scalar values only (no nested object/array) in S2B v0';
      END IF;
      SELECT coalesce(string_agg(format('%s:%s', to_json(kv.key)::text, kv.value::text), ',' ORDER BY kv.key), '')
        INTO v_deterministic_signals_canonical
        FROM jsonb_each(v_deterministic_signals) kv;

      v_decision_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(
        format(
          '{"extraction_run_id":%s,"outcome":%s,"decision_reason":%s,"deterministic_signals":{%s},"existing_semantic_topic_id":%s,"idempotency_key":%s}',
          to_json(p_extraction_run_id::text)::text, to_json(p_outcome)::text, coalesce(to_json(p_decision_reason)::text, 'null'),
          v_deterministic_signals_canonical, coalesce(to_json(p_existing_semantic_topic_id::text)::text, 'null'), to_json(p_idempotency_key)::text
        ), 'UTF8')), 'hex');

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

      ELSE
        IF p_existing_semantic_topic_id IS NOT NULL THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: QUARANTINE must not supply p_existing_semantic_topic_id';
        END IF;
        IF p_decision_reason NOT IN ('malformed_extraction', 'below_confidence_threshold') THEN
          RAISE EXCEPTION 'record_topic_assignment_decision: QUARANTINE does not accept decision_reason=%', p_decision_reason;
        END IF;
      END IF;

      IF p_outcome = 'CREATE_NEW' THEN
        v_assignment_reason := 'topic_creation_seed';
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

        -- 086 KORREKCIO: a korabbi nyers `count(*) FROM
        -- semantic_topic_membership WHERE ... valid_to IS NULL` helyett a
        -- kozos helperbol szamitott, forras-identitas szerint DISTINCT
        -- szamlalas -- ez zarja ki az azonos-csatorna, ismeretlen-forras
        -- es szindikacios-masolat hamis-pozitiv eseteket. A topic sora mar
        -- FOR UPDATE-del zarolva van (fent), a most beszurt membership mar
        -- resze a helper altal latott elo tablaallapotnak -- ugyanaz a
        -- "pontosan egy atmenet konkurrencia alatt is" garancia, mint
        -- korabban.
        IF v_topic.lifecycle_status = 'candidate_singleton' THEN
          SELECT count(DISTINCT source_identity_id) INTO v_active_count
            FROM public._semantic_topic_eligible_membership_sources(p_existing_semantic_topic_id);
          IF v_active_count >= 2 THEN
            UPDATE public.semantic_topics SET lifecycle_status = 'corroborating', status_version = status_version + 1, updated_at = now()
              WHERE id = p_existing_semantic_topic_id;
          END IF;
        END IF;

      ELSE
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

    -- CREATE OR REPLACE FUNCTION preserves owner and ACL automatically --
    -- no REVOKE/GRANT needed (084 precedent).

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_corrected_hash THEN
      RAISE EXCEPTION '086: record_topic_assignment_decision post-replace body hash = % (put this exact value into v_corrected_hash and re-apply)', v_hash;
    END IF;

    RAISE NOTICE '086: record_topic_assignment_decision replaced with the corrected body.';
  END IF;
END;
$migrate_rtad_086$;

-- ============================================================
-- 3. execute_approved_topic_assignment_review (078) -- CREATE OR
--    REPLACE, ugyanaz a minta es ugyanaz az egyetlen valtozas (sor
--    ~1611-1618 a 078-ban), minden mas viselkedes valtozatlan.
-- ============================================================

DO $migrate_eatar_086$
DECLARE
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_legacy_hash CONSTANT text := '8959b234dec66b872c59bb695e832158';
  v_corrected_hash CONSTANT text := '4b0569a4ebb39b63d918b27859be2ea6';
  v_expected_args CONSTANT text := 'p_review_request_id uuid, p_idempotency_key text';
BEGIN
  v_oid := to_regprocedure('public.execute_approved_topic_assignment_review(uuid, text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '086 fail-closed: public.execute_approved_topic_assignment_review(...) does not exist -- 078 must be applied first';
  END IF;
  IF pg_get_function_identity_arguments(v_oid) <> v_expected_args THEN
    RAISE EXCEPTION '086 drift: execute_approved_topic_assignment_review argument list does not match the expected 078 signature before replace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND p.provolatile = 'v' AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
  ) THEN
    RAISE EXCEPTION '086 drift: execute_approved_topic_assignment_review owner/SECURITY DEFINER/volatility/search_path does not match the expected baseline before replace';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION '086 drift: execute_approved_topic_assignment_review ACL does not match the expected baseline (service_role EXECUTE only) before replace';
  END IF;

  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
  v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));

  IF v_hash = v_corrected_hash THEN
    RAISE NOTICE '086: execute_approved_topic_assignment_review already exactly the corrected body -- no-op.';
  ELSIF v_hash <> v_legacy_hash THEN
    RAISE EXCEPTION '086 fail-closed: DEFINITION_DRIFT -- execute_approved_topic_assignment_review body_hash=% is neither the known 078 legacy hash nor the corrected hash. No DDL will run.', v_hash;
  ELSE
    RAISE NOTICE '086: execute_approved_topic_assignment_review is the known 078 legacy body -- REPLACE branch (eligible-source-identity-based corroborating enforcement).';

    CREATE OR REPLACE FUNCTION public.execute_approved_topic_assignment_review(
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

      IF NOT EXISTS (SELECT 1 FROM public.semantic_topic_reviewers WHERE user_id = v_request.reviewer_user_id AND active IS TRUE FOR SHARE) THEN
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
        IF v_topic.lifecycle_status IN ('split_required', 'merge_candidate', 'superseded', 'archived') THEN
          RAISE EXCEPTION 'execute_approved_topic_assignment_review: target topic lifecycle_status=% no longer accepts ATTACH_EXISTING', v_topic.lifecycle_status;
        END IF;

        INSERT INTO public.semantic_topic_membership (semantic_topic_id, signal_evidence_id, assignment_reason, confidence, algorithm_version)
        VALUES (v_request.target_semantic_topic_id, v_evidence_id, v_assignment_reason, v_confidence, v_algorithm_version)
        RETURNING id INTO v_membership_id;

        v_topic_id := v_request.target_semantic_topic_id;

        -- 086 KORREKCIO: ugyanaz a csere, mint 074-ben.
        IF v_topic.lifecycle_status = 'candidate_singleton' THEN
          SELECT count(DISTINCT source_identity_id) INTO v_active_count
            FROM public._semantic_topic_eligible_membership_sources(v_request.target_semantic_topic_id);
          IF v_active_count >= 2 THEN
            UPDATE public.semantic_topics SET lifecycle_status = 'corroborating', status_version = status_version + 1, updated_at = now()
              WHERE id = v_request.target_semantic_topic_id;
          END IF;
        END IF;
      ELSE
        RAISE EXCEPTION 'execute_approved_topic_assignment_review: unexpected proposed_outcome % on an approved request', v_request.proposed_outcome;
      END IF;

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

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_corrected_hash THEN
      RAISE EXCEPTION '086: execute_approved_topic_assignment_review post-replace body hash = % (put this exact value into v_corrected_hash and re-apply)', v_hash;
    END IF;

    RAISE NOTICE '086: execute_approved_topic_assignment_review replaced with the corrected body.';
  END IF;
END;
$migrate_eatar_086$;

-- ============================================================
-- 4. compute_topic_evidence_vector (085) -- CREATE OR REPLACE, 3-agu
--    hash-kapu. A teljes eligibilis-halmaz szamitas most a kozos
--    helperbol szarmazik -- nincs tobbe kulon, parhuzamos eligibility
--    CTE. JSON-kontraktus valtozasok: knownIndependentSourceCount ->
--    eligibleDistinctSourceIdentityCount (tiszta csere, nincs elo
--    fogyasztoja -- ld. gate-audit), uj evidenceIdentityComplete /
--    sourceIdentityKnown mezok, evidence-type-fuggo inputIntegrityStatus.
-- ============================================================

DO $migrate_ctev_086$
DECLARE
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_legacy_hash CONSTANT text := 'f08afed6a21ebf4af78cd6ecfd92025c';
  v_corrected_hash CONSTANT text := '73aeb37846bcc80fd42a4e2c8862dc7c';
  v_expected_args CONSTANT text := 'p_semantic_topic_id uuid';
BEGIN
  v_oid := to_regprocedure('public.compute_topic_evidence_vector(uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '086 fail-closed: public.compute_topic_evidence_vector(...) does not exist -- 085 must be applied first';
  END IF;
  IF pg_get_function_identity_arguments(v_oid) <> v_expected_args THEN
    RAISE EXCEPTION '086 drift: compute_topic_evidence_vector argument list does not match the expected 085 signature before replace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_oid AND n.nspname = 'public' AND p.prosecdef IS TRUE AND p.provolatile = 's' AND r.rolname = 'postgres'
      AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
  ) THEN
    RAISE EXCEPTION '086 drift: compute_topic_evidence_vector owner/SECURITY DEFINER/volatility/search_path does not match the expected baseline before replace';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION '086 drift: compute_topic_evidence_vector ACL does not match the expected baseline (service_role EXECUTE only) before replace';
  END IF;

  SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
  v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));

  IF v_hash = v_corrected_hash THEN
    RAISE NOTICE '086: compute_topic_evidence_vector already exactly the corrected body -- no-op.';
  ELSIF v_hash <> v_legacy_hash THEN
    RAISE EXCEPTION '086 fail-closed: DEFINITION_DRIFT -- compute_topic_evidence_vector body_hash=% is neither the known 085 legacy hash nor the corrected hash. No DDL will run.', v_hash;
  ELSE
    RAISE NOTICE '086: compute_topic_evidence_vector is the known 085 legacy body -- REPLACE branch (common-helper-based, evidence-type-aware).';

    CREATE OR REPLACE FUNCTION public.compute_topic_evidence_vector(
      p_semantic_topic_id UUID
    ) RETURNS JSONB
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_lifecycle_status TEXT;
      v_active_count BIGINT;
      v_eligible_count BIGINT;
      v_syndication_excluded_count BIGINT;
      v_eligible_distinct_source_identity_count BIGINT;
      v_unknown_source_count BIGINT;
      v_manual_confirmed_source_count BIGINT;
      v_manual_override_source_count BIGINT;
      v_automated_source_count BIGINT;
      v_topic_creation_seed_source_count BIGINT;
      v_unclassified_reason_membership_count BIGINT;
      v_mixed_algorithm_versions BOOLEAN;
      v_by_algorithm_version JSONB;
      v_confidence_min NUMERIC;
      v_confidence_max NUMERIC;
      v_confidence_count BIGINT;
      v_evidence_identity_complete BOOLEAN;
      v_source_identity_known BOOLEAN;
      v_input_integrity_status TEXT;
    BEGIN
      SELECT lifecycle_status INTO v_lifecycle_status
      FROM public.semantic_topics WHERE id = p_semantic_topic_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reasonCode', 'TOPIC_NOT_FOUND');
      END IF;

      -- activeMembershipCount/syndicationExcludedCount nem az eligibilis
      -- halmazbol szarmaznak (definicio szerint az EXCLUDED/teljes aktiv
      -- kort merik) -- ez NEM egy parhuzamos eligibility predicate, csak
      -- egy egyszeru, a helpertol fuggetlen celu szamlalas.
      SELECT count(*), count(*) FILTER (WHERE se.is_syndication_copy_of IS NOT NULL)
        INTO v_active_count, v_syndication_excluded_count
      FROM public.semantic_topic_membership m
      JOIN public.signal_evidence se ON se.id = m.signal_evidence_id
      WHERE m.semantic_topic_id = p_semantic_topic_id AND m.valid_to IS NULL;

      -- A TELJES eligibilis membership/source halmaz -- EGYETLEN forrasbol,
      -- a kozos helperbol. Minden alabbi mezo ebbol a materializalt
      -- eredmenybol szarmazik, nincs kulon, ujrairt eligibility CTE.
      WITH eligible AS (
        SELECT * FROM public._semantic_topic_eligible_membership_sources(p_semantic_topic_id)
      )
      SELECT
        (SELECT count(*) FROM eligible),
        (SELECT count(DISTINCT source_identity_id) FROM eligible),
        (SELECT count(*) FROM eligible WHERE source_identity_id IS NULL),
        (SELECT count(DISTINCT source_identity_id) FROM eligible WHERE assignment_reason = 'manual_review_confirmed'),
        (SELECT count(DISTINCT source_identity_id) FROM eligible WHERE assignment_reason = 'manual_review_override'),
        (SELECT count(DISTINCT source_identity_id) FROM eligible WHERE assignment_reason IN ('entity_event_match', 'embedding_similarity')),
        (SELECT count(DISTINCT source_identity_id) FROM eligible WHERE assignment_reason = 'topic_creation_seed'),
        (SELECT count(*) FROM eligible WHERE assignment_reason NOT IN (
          'entity_event_match', 'embedding_similarity', 'manual_review_confirmed', 'manual_review_override', 'topic_creation_seed'
        )),
        (SELECT count(DISTINCT algorithm_version) > 1 FROM eligible),
        (SELECT min(confidence) FROM eligible),
        (SELECT max(confidence) FROM eligible),
        (SELECT count(confidence) FROM eligible),
        (SELECT coalesce(jsonb_object_agg(
            per_version.algorithm_version::text,
            jsonb_build_object(
              'eligibleMembershipCount', per_version.cnt,
              'eligibleDistinctSourceIdentityCount', per_version.known_cnt,
              'unknownSourceCount', per_version.unknown_cnt,
              'confidenceDiagnostics', jsonb_build_object('min', per_version.conf_min, 'max', per_version.conf_max, 'count', per_version.conf_cnt)
            )
          ), '{}'::jsonb)
         FROM (
           SELECT
             algorithm_version,
             count(*) AS cnt,
             count(DISTINCT source_identity_id) AS known_cnt,
             count(*) FILTER (WHERE source_identity_id IS NULL) AS unknown_cnt,
             min(confidence) AS conf_min,
             max(confidence) AS conf_max,
             count(confidence) AS conf_cnt
           FROM eligible
           GROUP BY algorithm_version
         ) per_version
        ),
        -- Vacuously-FALSE fail-closed: ures eligibilis halmaz eseten a
        -- bool_and(...) SQL-szinten NULL-t adna -- ez sose valik hamisan
        -- TRUE-va, coalesce FALSE-ra zarja.
        (SELECT coalesce(bool_and(evidence_identity_complete), false) FROM eligible),
        (SELECT coalesce(bool_and(source_identity_id IS NOT NULL), false) FROM eligible)
      INTO
        v_eligible_count, v_eligible_distinct_source_identity_count, v_unknown_source_count,
        v_manual_confirmed_source_count, v_manual_override_source_count, v_automated_source_count,
        v_topic_creation_seed_source_count, v_unclassified_reason_membership_count,
        v_mixed_algorithm_versions, v_confidence_min, v_confidence_max, v_confidence_count,
        v_by_algorithm_version, v_evidence_identity_complete, v_source_identity_known;

      -- inputIntegrityStatus KIZAROLAG a ket fenti boolean + az ures-halmaz
      -- eset dokumentalt kombinaciojabol szarmazik -- nincs kulon, negyedik
      -- logikai ag.
      IF v_eligible_count = 0 THEN
        v_input_integrity_status := 'not_applicable';
      ELSIF v_evidence_identity_complete IS TRUE AND v_source_identity_known IS TRUE THEN
        v_input_integrity_status := 'complete';
      ELSE
        v_input_integrity_status := 'incomplete';
      END IF;

      RETURN jsonb_build_object(
        'ok', true,
        'formulaVersion', 'topic_evidence_vector_v1',
        'semanticTopicId', p_semantic_topic_id,
        'lifecycleStatus', v_lifecycle_status,
        'activeMembershipCount', v_active_count,
        'eligibleMembershipCount', v_eligible_count,
        'syndicationExcludedCount', v_syndication_excluded_count,
        'eligibleDistinctSourceIdentityCount', v_eligible_distinct_source_identity_count,
        'unknownSourceCount', v_unknown_source_count,
        'manualReviewConfirmedSourceCount', v_manual_confirmed_source_count,
        'manualReviewOverrideSourceCount', v_manual_override_source_count,
        'automatedAssignmentSourceCount', v_automated_source_count,
        'topicCreationSeedSourceCount', v_topic_creation_seed_source_count,
        'assignmentReasonBreakdownComplete', (v_unclassified_reason_membership_count = 0),
        'unclassifiedAssignmentReasonEligibleMembershipCount', v_unclassified_reason_membership_count,
        'mixedAlgorithmVersions', v_mixed_algorithm_versions,
        'byAlgorithmVersion', v_by_algorithm_version,
        'confidenceDiagnostics', jsonb_build_object('min', v_confidence_min, 'max', v_confidence_max, 'count', v_confidence_count),
        'evidenceIdentityComplete', v_evidence_identity_complete,
        'sourceIdentityKnown', v_source_identity_known,
        'inputIntegrityStatus', v_input_integrity_status
      );
    END;
    $rpc$;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_corrected_hash THEN
      RAISE EXCEPTION '086: compute_topic_evidence_vector post-replace body hash = % (put this exact value into v_corrected_hash and re-apply)', v_hash;
    END IF;

    RAISE NOTICE '086: compute_topic_evidence_vector replaced with the corrected body.';
  END IF;
END;
$migrate_ctev_086$;

-- ============================================================
-- 5. Fail-fast vegallapot onellenorzes.
-- ============================================================

DO $final_selfcheck_086$
DECLARE
  v_helper_hash text;
  v_rtad_hash text;
  v_eatar_hash text;
  v_ctev_hash text;
  v_expected_helper_hash CONSTANT text := 'fba8af744970df7f93ba96fd71d2a939';
  v_expected_rtad_hash CONSTANT text := '9e681c94870719a0a7cb4605de458baf';
  v_expected_eatar_hash CONSTANT text := '4b0569a4ebb39b63d918b27859be2ea6';
  v_expected_ctev_hash CONSTANT text := '73aeb37846bcc80fd42a4e2c8862dc7c';
BEGIN
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_helper_hash
  FROM pg_proc WHERE oid = 'public._semantic_topic_eligible_membership_sources(uuid)'::regprocedure;
  IF v_helper_hash <> v_expected_helper_hash THEN
    RAISE EXCEPTION '086 CRITICAL: _semantic_topic_eligible_membership_sources final body hash (%) does not match the expected hash.', v_helper_hash;
  END IF;

  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_rtad_hash
  FROM pg_proc WHERE oid = 'public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)'::regprocedure;
  IF v_rtad_hash <> v_expected_rtad_hash THEN
    RAISE EXCEPTION '086 CRITICAL: record_topic_assignment_decision final body hash (%) does not match the expected corrected hash.', v_rtad_hash;
  END IF;

  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_eatar_hash
  FROM pg_proc WHERE oid = 'public.execute_approved_topic_assignment_review(uuid, text)'::regprocedure;
  IF v_eatar_hash <> v_expected_eatar_hash THEN
    RAISE EXCEPTION '086 CRITICAL: execute_approved_topic_assignment_review final body hash (%) does not match the expected corrected hash.', v_eatar_hash;
  END IF;

  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_ctev_hash
  FROM pg_proc WHERE oid = 'public.compute_topic_evidence_vector(uuid)'::regprocedure;
  IF v_ctev_hash <> v_expected_ctev_hash THEN
    RAISE EXCEPTION '086 CRITICAL: compute_topic_evidence_vector final body hash (%) does not match the expected corrected hash.', v_ctev_hash;
  END IF;

  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('semantic_topics', 'semantic_topic_membership', 'topic_extraction_runs', 'signal_evidence', 'youtube_videos', 'signal_sources')) <> 6 THEN
    RAISE EXCEPTION '086 CRITICAL: baseline tables are no longer all present after this migration.';
  END IF;

  RAISE NOTICE '086: final self-check passed -- helper and all three remediated RPCs present with the expected corrected body hashes, baseline tables unchanged.';
END;
$final_selfcheck_086$;

NOTIFY pgrst, 'reload schema';

COMMIT;
