-- ============================================================
-- Migration 085: Semantic Topic Identity v0 -- scalar-free evidence
-- support vector (read-only RPC).
--
-- Kanonikus szerzodes forrasa: elozo, kulon tervezesi-atvizsgalasi
-- korben mar jovahagyott vegleges specifikacio -- ez a migracio
-- SZO SZERINT azt valositja meg, nem terveztetes ujra.
--
-- HATOKOR -- egyetlen UJ, tisztan olvaso RPC:
--   public.compute_topic_evidence_vector(p_semantic_topic_id UUID) RETURNS JSONB
-- NINCS uj tabla, NINCS trigger, NINCS lifecycle-iras, NINCS tarolt
-- score-oszlop/snapshot-tabla. Kizarolag SELECT -- a fuggveny STABLE
-- (soha nem VOLATILE), mert tisztan olvas es semmilyen mellekhatasa
-- nincs.
--
-- MIERT `semantic_topic_membership.confidence`-et hasznaljuk (NEM
-- `topic_extraction_runs`-on at joinolva): `topic_extraction_runs`-nak
-- NINCS UNIQUE constraintje signal_evidence_id-n (csak
-- idempotency_key-n -- ld. 073), tehat egy adott evidence-hez tobb
-- extraction_run sor is tartozhat (ujra-extractionok, kulonbozo
-- normalization_version/probalkozasok). Egy membership -> extraction_run
-- JOIN signal_evidence_id szerint emiatt fan-out-olhatna (egyetlen
-- membership sor tobb extraction_run sorral latszana egyezni), ami
-- barmilyen COUNT/aggregatumot megsertene. A
-- `semantic_topic_membership.confidence` oszlop ezzel szemben mar
-- eleve egysoros, fan-out-mentes, tarolt ertek -- ezt hasznaljuk
-- kizarolag diagnosztikai celra (min/max/count), SOHA nem
-- sulyozasra/osszegzesre alkalmazva egyetlen COUNT-on vagy
-- forras-halmazon sem.
--
-- ELVETETT V1 MEZO -- languageDiversity: a `label_language` KIZAROLAG
-- a `topic_extraction_runs.structured_output` belsejeben el, es a fenti
-- fan-out-kockazat miatt NINCS bizonyithatoan-egysoros ut egyetlen
-- `semantic_topic_membership` sorbol egyetlen konkret
-- `topic_extraction_runs` sorig (nincs FK a membership tablan egy
-- konkret extraction_run_id-ra -- ld. 072-es sema, ellenorizve).
-- BACKLOG-JEGYZET (kovetkezo migracio dontese): ezt egy jovobeli
-- migracio oldhatja fel VAGY egy uj FK hozzaadasaval
-- (semantic_topic_membership -> topic_extraction_runs.id), VAGY egy
-- bizonyithatoan biztonsagos aggregacios strategia kidolgozasaval a
-- jelenlegi sema mellett. Ez a migracio SZANDEKOSAN nem probal
-- korulirni ezt a hianyt -- languageDiversity egyszeruen hianyzik a v1
-- visszateresi szerzodesbol.
--
-- inputIntegrityStatus -- SZUK, NEVEN NEVEZETT definicio (a korabbi,
-- helytelen "provenanceQuality" elnevezes mar korrigalva egy elozo
-- tervezesi korben): kizarolag azt vizsgalja, hogy minden eligibilis
-- membership evidence-enek `signal_evidence.canonical_url` mezoje
-- jelen van-e es nem ures/nem csak whitespace. A `signal_evidence`
-- tablan NINCS `status` oszlop (az extractios statusz a
-- `topic_extraction_runs`-on el, ami a fenti fan-out-kockazatot
-- hordozza) -- ezert v1-ben ez a mezo KIZAROLAG a canonical_url
-- jelenletet vizsgalja, semmi mast.
--
-- assignment_reason-bontas -- a harom forras-halmaz (manual confirmed /
-- manual override / automated) FEDHET egymassal (egy csatorna
-- rendelkezhet egyszerre human-reviewed ES automatikus eligibilis
-- membershippel is) -- osszeguk EMIATT NEM garantaltan egyenlo
-- knownIndependentSourceCount-tal. Ez SZANDEKOS, dokumentalt
-- viselkedes, nem hiba.
--
-- KRITIKUS HELYESSEGI KOVETELMENY -- knownIndependentSourceCount: a
-- top-level ertek EGYETLEN lekerdezesben szamitott COUNT(DISTINCT
-- channel_id) a TELJES eligibilis halmazon (minden algorithm_version
-- egyutt) -- SOHA nem az algorithm_version-onkenti kulon-kulon distinct
-- szamok osszege (az duplikalna egy olyan csatornat, amelynek KET
-- kulonbozo algorithm_version alatt is van eligibilis membershipje).
-- A `byAlgorithmVersion` bontas egy KULON, diagnosztikai vetulet --
-- SOHA nem helyettesiti es SOHA nem osszegzodik a top-level
-- knownIndependentSourceCount-ba. Sima COUNT-ok (nem
-- confidence-sulyozott mennyisegek) VISZONT biztonsagosan
-- osszegezhetok algorithm_version-ok kozott -- ezert a top-level
-- eligibleMembershipCount/unknownSourceCount/confidenceDiagnostics
-- ertekek a per-version bontasbol IS levezethetok (es abbol vannak
-- levezetve alant), pontosan azert, mert MIN/MAX/COUNT additiv
-- diszjunkt particiok felett -- csak a DISTINCT-alapu
-- knownIndependentSourceCount NEM az.
--
-- Nincs raw azonosito (channel_id, evidence UUID, canonical_url) a
-- visszateresi payloadban -- kizarolag szamlalok es diagnosztikai
-- aggregatumok, plusz a topic sajat id/lifecycle_status mezoje (ez mar
-- ma is lathato a reviewer UI-n, nem uj expozicio).
--
-- Grant-topologia -- v0, szandekos, SZUK hatokor: KIZAROLAG
-- service_role EXECUTE. Nincs jelenlegi UI-fogyaszto -- `authenticated`
-- grant hozzaadasa egy jovobeli, kulon jovahagyott migracio dontese.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. FUGGOSEGI ELOFELTETEL -- a 072/073 baseline tablaknak pontosan a
--    vart allapotban kell lenniuk, mielott ez a migracio barmit is
--    erintene.
-- ============================================================

DO $preflight$
DECLARE
  v_table_count int;
BEGIN
  SELECT count(*) INTO v_table_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('semantic_topics', 'semantic_topic_membership', 'topic_extraction_runs', 'signal_evidence', 'youtube_videos');
  IF v_table_count <> 5 THEN
    RAISE EXCEPTION '085 fail-closed: % of 5 required baseline tables present (semantic_topics, semantic_topic_membership, topic_extraction_runs, signal_evidence, youtube_videos) -- 051/072/073 must be fully applied first.', v_table_count;
  END IF;

  RAISE NOTICE '085: preflight gate passed (baseline tables present).';
END;
$preflight$;

-- ============================================================
-- 1. public.compute_topic_evidence_vector -- CREATE-once, hash-gated
--    fail-closed VALIDATE on re-application (same idiom as 078's
--    create_topic_assignment_review_request: CREATE branch if the name
--    does not exist at all; VALIDATE branch -- never DDL/DCL -- if it
--    does, comparing structural definition + body hash + ACL exactly;
--    RAISE EXCEPTION on ANY mismatch, never a silent replace).
-- ============================================================

DO $migrate_ctev$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'fa63b2064fa8450c227dce539476fc80';
  v_expected_args CONSTANT text := 'p_semantic_topic_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'compute_topic_evidence_vector';

  IF v_name_count = 0 THEN
    RAISE NOTICE '085: compute_topic_evidence_vector does not exist -- CREATE branch.';

    CREATE FUNCTION public.compute_topic_evidence_vector(
      p_semantic_topic_id UUID
    ) RETURNS JSONB
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_lifecycle_status TEXT;
      v_active_count BIGINT;
      v_eligible_count BIGINT;
      v_syndication_excluded_count BIGINT;
      v_known_independent_source_count BIGINT;
      v_unknown_source_count BIGINT;
      v_manual_confirmed_source_count BIGINT;
      v_manual_override_source_count BIGINT;
      v_automated_source_count BIGINT;
      v_mixed_algorithm_versions BOOLEAN;
      v_by_algorithm_version JSONB;
      v_confidence_min NUMERIC;
      v_confidence_max NUMERIC;
      v_confidence_count BIGINT;
      v_all_canonical_url_present BOOLEAN;
      v_input_integrity_status TEXT;
    BEGIN
      SELECT lifecycle_status INTO v_lifecycle_status
      FROM public.semantic_topics WHERE id = p_semantic_topic_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reasonCode', 'TOPIC_NOT_FOUND');
      END IF;

      -- Single materialization of the "active" (valid_to IS NULL) and
      -- "eligible" (active AND not a syndication copy) membership sets for
      -- this topic -- every downstream count/diagnostic below is a scalar
      -- or grouped subquery against these SAME two CTEs, never a
      -- re-derived or textually-duplicated eligibility filter, so there is
      -- exactly one place a future edit to the eligibility rule would need
      -- to change.
      WITH active AS (
        SELECT
          m.confidence,
          m.algorithm_version,
          m.assignment_reason,
          se.is_syndication_copy_of,
          se.canonical_url,
          yv.channel_id
        FROM public.semantic_topic_membership m
        JOIN public.signal_evidence se ON se.id = m.signal_evidence_id
        LEFT JOIN public.youtube_videos yv ON yv.video_id = se.youtube_videos_ref
        WHERE m.semantic_topic_id = p_semantic_topic_id
          AND m.valid_to IS NULL
      ),
      eligible AS (
        SELECT confidence, algorithm_version, assignment_reason, canonical_url, channel_id
        FROM active
        WHERE is_syndication_copy_of IS NULL
      )
      SELECT
        (SELECT count(*) FROM active),
        (SELECT count(*) FROM eligible),
        (SELECT count(*) FROM active WHERE is_syndication_copy_of IS NOT NULL),
        -- Critical correctness requirement: ONE query, DISTINCT over the
        -- FULL eligible set (all algorithm_versions together) -- never a
        -- sum of per-algorithm_version distinct counts, which would
        -- double-count a channel eligible under two different versions.
        (SELECT count(DISTINCT channel_id) FROM eligible),
        (SELECT count(*) FROM eligible WHERE channel_id IS NULL),
        (SELECT count(DISTINCT channel_id) FROM eligible WHERE assignment_reason = 'manual_review_confirmed'),
        (SELECT count(DISTINCT channel_id) FROM eligible WHERE assignment_reason = 'manual_review_override'),
        (SELECT count(DISTINCT channel_id) FROM eligible WHERE assignment_reason IN ('entity_event_match', 'embedding_similarity')),
        (SELECT count(DISTINCT algorithm_version) > 1 FROM eligible),
        (SELECT min(confidence) FROM eligible),
        (SELECT max(confidence) FROM eligible),
        (SELECT count(confidence) FROM eligible),
        (SELECT coalesce(jsonb_object_agg(
            per_version.algorithm_version::text,
            jsonb_build_object(
              'eligibleMembershipCount', per_version.cnt,
              'knownIndependentSourceCount', per_version.known_cnt,
              'unknownSourceCount', per_version.unknown_cnt,
              'confidenceDiagnostics', jsonb_build_object('min', per_version.conf_min, 'max', per_version.conf_max, 'count', per_version.conf_cnt)
            )
          ), '{}'::jsonb)
         FROM (
           SELECT
             algorithm_version,
             count(*) AS cnt,
             count(DISTINCT channel_id) AS known_cnt,
             count(*) FILTER (WHERE channel_id IS NULL) AS unknown_cnt,
             min(confidence) AS conf_min,
             max(confidence) AS conf_max,
             count(confidence) AS conf_cnt
           FROM eligible
           GROUP BY algorithm_version
         ) per_version
        ),
        (SELECT bool_and(canonical_url IS NOT NULL AND btrim(canonical_url) <> '') FROM eligible)
      INTO
        v_active_count, v_eligible_count, v_syndication_excluded_count,
        v_known_independent_source_count, v_unknown_source_count,
        v_manual_confirmed_source_count, v_manual_override_source_count, v_automated_source_count,
        v_mixed_algorithm_versions, v_confidence_min, v_confidence_max, v_confidence_count,
        v_by_algorithm_version, v_all_canonical_url_present;

      IF v_eligible_count = 0 THEN
        v_input_integrity_status := 'not_applicable';
      ELSIF v_all_canonical_url_present IS TRUE THEN
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
        'knownIndependentSourceCount', v_known_independent_source_count,
        'unknownSourceCount', v_unknown_source_count,
        'manualReviewConfirmedSourceCount', v_manual_confirmed_source_count,
        'manualReviewOverrideSourceCount', v_manual_override_source_count,
        'automatedAssignmentSourceCount', v_automated_source_count,
        'mixedAlgorithmVersions', v_mixed_algorithm_versions,
        'byAlgorithmVersion', v_by_algorithm_version,
        'confidenceDiagnostics', jsonb_build_object('min', v_confidence_min, 'max', v_confidence_max, 'count', v_confidence_count),
        'inputIntegrityStatus', v_input_integrity_status
      );
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.compute_topic_evidence_vector(UUID) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.compute_topic_evidence_vector(UUID) TO service_role;

    RAISE NOTICE '085: compute_topic_evidence_vector created.';

  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '085: compute_topic_evidence_vector already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'compute_topic_evidence_vector';

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
      RAISE EXCEPTION '085 drift: compute_topic_evidence_vector structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '085 drift: compute_topic_evidence_vector body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '085 drift: compute_topic_evidence_vector ACL does not match exactly (expected postgres+service_role EXECUTE only)';
    END IF;

    RAISE NOTICE '085: compute_topic_evidence_vector already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '085 fail-closed: compute_topic_evidence_vector has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_ctev$;

-- ============================================================
-- 2. Fail-fast vegallapot onellenorzes -- a fuggveny pontosan egyszer
--    letezik, es a meglevo 072/073/084 objektumok bizonyithatoan
--    erintetlenek maradtak.
-- ============================================================

DO $final_selfcheck$
DECLARE
  v_fn_count int;
  v_final_hash text;
  v_expected_hash CONSTANT text := 'fa63b2064fa8450c227dce539476fc80';
BEGIN
  SELECT count(*) INTO v_fn_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'compute_topic_evidence_vector';
  IF v_fn_count <> 1 THEN
    RAISE EXCEPTION '085 CRITICAL: compute_topic_evidence_vector has % overloads after migration, expected exactly 1.', v_fn_count;
  END IF;

  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_final_hash
  FROM pg_proc WHERE oid = 'public.compute_topic_evidence_vector(uuid)'::regprocedure;
  IF v_final_hash <> v_expected_hash THEN
    RAISE EXCEPTION '085 CRITICAL: final compute_topic_evidence_vector body hash (%) does not match the expected v1 hash.', v_final_hash;
  END IF;

  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('semantic_topics', 'semantic_topic_membership', 'topic_extraction_runs')) <> 3 THEN
    RAISE EXCEPTION '085 CRITICAL: 072/073 baseline tables are no longer all present after this migration.';
  END IF;

  RAISE NOTICE '085: final self-check passed -- compute_topic_evidence_vector present exactly once with the expected body hash, baseline tables unchanged.';
END;
$final_selfcheck$;

NOTIFY pgrst, 'reload schema';

COMMIT;
