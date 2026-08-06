-- ============================================================
-- Migration 066: harden signal observation scheduling
--
-- PFM Collector Observation Reliability & Adaptive Cadence Hardening.
-- Fail-fast szerzodes MINDEN objektumra:
--   A) nem letezik -> CREATE
--   B) letezik     -> byte-/normalizalt-pontos VALIDACIO, no-op vagy EXCEPTION.
-- A B) agban SOHA nem fut DDL/DCL.
--
-- CEL 1 — evidence -> schedule konzisztencia:
--   Egy AFTER INSERT trigger a signal_evidence-en UGYANABBAN a
--   tranzakcioban hoz letre signal_observation_schedule sort minden
--   UJONNAN beszurt, 'scheduled_enrichment' run-bol szarmazo YouTube
--   evidence-hez (a discovered_in_run_id -> signal_runs.run_type
--   kapcsolaton keresztul dontve el a lane-et — a trigger NEM SECURITY
--   DEFINER, mert a service_role mar rendelkezik a szukseges INSERT/
--   SELECT jogokkal mindket erintett tablan, ld. 049/057). Az
--   interaktiv opportunity_side_effect evidence-et SOHA nem erinti,
--   mert a trigger kifejezetten a scheduled_enrichment run_type-ra szur.
--   Egy kulon, kotegelt, idempotens RPC
--   (reconcile_missing_signal_observation_schedules) potolja azt a
--   ket esetet, amit a trigger nem fedhet: mar letezo, korabban MAS
--   run altal letrehozott evidence-t, amit a scheduled lane csak
--   KESOBB, ujra megtalal (signal_cluster_evidence.linked_in_run_id
--   kapcsolaton keresztul), es barmilyen tortenelmi (066 elotti)
--   hianyt. Egyetlen INSERT...SELECT, nincs soronkenti round-trip,
--   nem indit provider-hivast, ON CONFLICT DO NOTHING miatt konkurens
--   hivasra sem duplikal.
--
-- CEL 2 — observation -> schedule atomi frissites + veglegesitett
--   adaptiv cadence-allapotgep (a korabbi, be nem kotott
--   early8h/daily/weekly tervet felvaltva):
--   Egy uj SECURITY DEFINER RPC (apply_signal_observation_batch) EGY
--   DB-tranzakcioban irja a signal_observations sorokat ES frissiti a
--   signal_observation_schedule allapotat (cadence/stagnant-szamlalo/
--   miss-szamlalo/active/next_due_at), kotegelt JSONB bemenettel
--   (legfeljebb 50 egyedi video_id/hivas). A regi, ket kulon
--   PostgREST-hivasra epulo persistObservationResults()-t ez valtja
--   fel az app-kodban (observation-worker.ts).
--
--   VEGLEGES CADENCE-SZABALYOK (a termek dontese szerint):
--     - uj schedule: cadence='daily', active=true, mindket szamlalo 0.
--     - elso sikeres meres: nem stagnalas (nincs elozo meres), a
--       stagnant-szamlalo 0 marad, kovetkezo meres +24 ora.
--     - "bizonyitott stagnalas" EGY sikeres meresre: a view_count
--       PONTOSAN valtozatlan, ES minden, MINDKET meresben jelenlevo
--       like_count/comment_count PONTOSAN valtozatlan; ha barmelyik
--       metrika no/csokken/megjelenik/eltunik, az NEM stagnalas, a
--       stagnant-szamlalo 0-ra all.
--     - daily + 3 egymast koveto bizonyitott stagnalas -> weekly,
--       stagnant-szamlalo 0-ra all, kovetkezo meres +7 nap.
--     - weekly + 4 egymast koveto bizonyitott stagnalas -> active=false,
--       stagnant-szamlalo=4.
--     - barmilyen valodi valtozas -> stagnant-szamlalo 0; ha cadence
--       weekly volt, visszavaltas daily-re; kovetkezo meres +24 ora.
--     - miss (a kert video_id hianyzik egy SIKERES videos.list
--       valaszbol): miss-szamlalo+1; elso miss = meg aktiv, kovetkezo
--       ellenorzes +24 ora; masodik egymast koveto miss = active=false;
--       ismet talalat = miss-szamlalo 0-ra all. A miss-ag SOHA nem
--       erinti a stagnant-szamlalot vagy a cadence-t.
--     - provider-hiba (timeout/kvotakimerules/kapcsolatvesztes/teljes
--       hiba): ezt az RPC-t egyaltalan NEM hivja a hivo kod ezekben az
--       agakban (observation-worker.ts korabban is korai return-nel
--       zarta ezeket, MIELOTT a schedule-t erinto iras megtortenne) —
--       tehat sem cadence, sem szamlalo, sem active nem valtozik, es
--       nem keletkezik hamis observation.
--
--   Az early8h ertek KOMPATIBILITASI okbol a sema resze marad (a CHECK
--   constraint tovabbra is engedi), DE: uj sorhoz SOHA nem allitodik be
--   (a DB-oszlop-default 'daily'), es az allapotgep SOHA nem allit be
--   early8h-t atmenetkent — ez kulon, jovobeli Pro/scheduler-fejlesztesi
--   tetel (a napi egyszeri cron strukturalisan nem tudna kiszolgalni).
--
-- last_view_count/last_like_count/last_comment_count: UJ, nullable
-- oszlopok a signal_observation_schedule-on — az "elozo meres" erteket
-- tarolja O(1) osszehasonlitashoz az RPC-ben, nincs szukseg
-- signal_observations-ellenes visszakereso lekerdezesre. Mindharomhoz
-- kulon egeszertek-invarians CHECK is tartozik (nem csak >=0), a
-- biztonsagos-egesz (2^53-1) felso hatarral egyutt.
--
-- APPLY_SIGNAL_OBSERVATION_BATCH — NEM bizik meg az alkalmazasoldali
-- payloadban (commit elotti szigoritas). A vegleges szignatura
-- (p_run_id, p_batch_id, p_lease_owner, p_observed_at, p_results) a
-- claimelt batchhez koti a hivast, es feldolgozas elott, sorral zarolva
-- ellenorzi: a batch letezik/observation/in_progress/lease_owner
-- egyezik/lease meg ervenyes; a batch run_phase-e observation fazis,
-- a run_phase.run_id egyezik p_run_id-vel; a run scheduled_enrichment
-- es nem terminalis; a batch item_ids halmaza pontosan egyezik a
-- payload distinct video_id halmazaval. Minden payload-elemre: a
-- schedule letezik/active/mar esedekes/nem regebbi observed_at-tal
-- irjuk felul, az evidence youtube_video es COALESCE(youtube_videos_ref,
-- external_ref) pontosan egyezik a payload video_id-javal. A next_due_at/
-- last_observed_at guard EGYBEN a dupla/kesoi alkalmazas elleni vedelem
-- is: egy sikeres alkalmazas utan ugyanaz a hivas (ugyanazzal a
-- p_observed_at-tal) mar elbukik, mert a schedule next_due_at-ja mar a
-- jovoben van.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. SIGNAL_OBSERVATION_SCHEDULE — 3 uj oszlop (last_view_count,
--    last_like_count, last_comment_count)
-- ============================================================

DO $columns$
DECLARE
  v_view_exists boolean;
  v_like_exists boolean;
  v_comment_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_observation_schedule' AND column_name = 'last_view_count'
  ) INTO v_view_exists;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_observation_schedule' AND column_name = 'last_like_count'
  ) INTO v_like_exists;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_observation_schedule' AND column_name = 'last_comment_count'
  ) INTO v_comment_exists;

  IF v_view_exists <> v_like_exists OR v_view_exists <> v_comment_exists THEN
    RAISE EXCEPTION '066 drift: signal_observation_schedule has a partial subset of the 3 expected new columns (view=%, like=%, comment=%)',
      v_view_exists, v_like_exists, v_comment_exists;
  END IF;

  IF NOT v_view_exists THEN
    RAISE NOTICE '066: signal_observation_schedule.last_{view,like,comment}_count do not exist — CREATE branch.';

    ALTER TABLE public.signal_observation_schedule
      ADD COLUMN last_view_count NUMERIC,
      ADD COLUMN last_like_count NUMERIC,
      ADD COLUMN last_comment_count NUMERIC;

    ALTER TABLE public.signal_observation_schedule
      ADD CONSTRAINT signal_observation_schedule_last_view_count_nonneg CHECK (last_view_count IS NULL OR last_view_count >= 0),
      ADD CONSTRAINT signal_observation_schedule_last_like_count_nonneg CHECK (last_like_count IS NULL OR last_like_count >= 0),
      ADD CONSTRAINT signal_observation_schedule_last_comment_count_nonneg CHECK (last_comment_count IS NULL OR last_comment_count >= 0),
      -- Egeszertek-invarians (kulon a >=0 feltetelektol) — a nyers YouTube
      -- szamlalok sosem torhetnek, es a JS/TS biztonsagos-egesz hatarat sem
      -- lephetik at, kulonben a hivo oldali Number(...) csendben pontossagot
      -- veszthetne.
      ADD CONSTRAINT signal_observation_schedule_last_view_count_integer CHECK (
        last_view_count IS NULL OR (last_view_count = floor(last_view_count) AND last_view_count <= 9007199254740991)
      ),
      ADD CONSTRAINT signal_observation_schedule_last_like_count_integer CHECK (
        last_like_count IS NULL OR (last_like_count = floor(last_like_count) AND last_like_count <= 9007199254740991)
      ),
      ADD CONSTRAINT signal_observation_schedule_last_comment_count_integer CHECK (
        last_comment_count IS NULL OR (last_comment_count = floor(last_comment_count) AND last_comment_count <= 9007199254740991)
      ),
      ADD CONSTRAINT signal_observation_schedule_last_observed_matches_view CHECK (
        (last_observed_at IS NULL) = (last_view_count IS NULL)
      );

    RAISE NOTICE '066: signal_observation_schedule.last_{view,like,comment}_count created.';
  ELSE
    RAISE NOTICE '066: signal_observation_schedule.last_{view,like,comment}_count already exist — VALIDATE branch (no DDL will run).';

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('last_view_count', 'numeric', 'numeric', 'YES', NULL),
        ('last_like_count', 'numeric', 'numeric', 'YES', NULL),
        ('last_comment_count', 'numeric', 'numeric', 'YES', NULL)
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'signal_observation_schedule'
          AND column_name IN ('last_view_count', 'last_like_count', 'last_comment_count')
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
    ) THEN
      RAISE EXCEPTION '066 drift: signal_observation_schedule last_{view,like,comment}_count column definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('signal_observation_schedule_last_view_count_nonneg', 'c', 'CHECK (last_view_count IS NULL OR last_view_count >= 0::numeric)'),
        ('signal_observation_schedule_last_like_count_nonneg', 'c', 'CHECK (last_like_count IS NULL OR last_like_count >= 0::numeric)'),
        ('signal_observation_schedule_last_comment_count_nonneg', 'c', 'CHECK (last_comment_count IS NULL OR last_comment_count >= 0::numeric)'),
        ('signal_observation_schedule_last_view_count_integer', 'c', 'CHECK (last_view_count IS NULL OR last_view_count = floor(last_view_count) AND last_view_count <= ''9007199254740991''::bigint::numeric)'),
        ('signal_observation_schedule_last_like_count_integer', 'c', 'CHECK (last_like_count IS NULL OR last_like_count = floor(last_like_count) AND last_like_count <= ''9007199254740991''::bigint::numeric)'),
        ('signal_observation_schedule_last_comment_count_integer', 'c', 'CHECK (last_comment_count IS NULL OR last_comment_count = floor(last_comment_count) AND last_comment_count <= ''9007199254740991''::bigint::numeric)'),
        ('signal_observation_schedule_last_observed_matches_view', 'c', 'CHECK ((last_observed_at IS NULL) = (last_view_count IS NULL))')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint
        WHERE conrelid = 'public.signal_observation_schedule'::regclass
          AND conname IN (
            'signal_observation_schedule_last_view_count_nonneg',
            'signal_observation_schedule_last_like_count_nonneg',
            'signal_observation_schedule_last_comment_count_nonneg',
            'signal_observation_schedule_last_view_count_integer',
            'signal_observation_schedule_last_like_count_integer',
            'signal_observation_schedule_last_comment_count_integer',
            'signal_observation_schedule_last_observed_matches_view'
          )
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '066 drift: signal_observation_schedule last_{view,like,comment}_count constraint set does not match exactly';
    END IF;

    RAISE NOTICE '066: signal_observation_schedule new columns already exist and match exactly — no-op.';
  END IF;
END;
$columns$;

-- ============================================================
-- 2. TRIGGER: uj, scheduled_enrichment run-bol szarmazo YouTube
--    evidence-hez atomi schedule-letrehozas
-- ============================================================

DO $trigger_fn$
DECLARE
  v_name_count int;
  v_exact_oid oid;
  v_body_hash text;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'trg_schedule_new_scheduled_youtube_evidence';
  v_exact_oid := to_regprocedure('public.trg_schedule_new_scheduled_youtube_evidence()');

  IF v_name_count = 0 THEN
    RAISE NOTICE '066: trg_schedule_new_scheduled_youtube_evidence does not exist — CREATE branch.';

    CREATE FUNCTION public.trg_schedule_new_scheduled_youtube_evidence()
    RETURNS trigger
    LANGUAGE plpgsql SET search_path = public, pg_temp
    AS $body$
BEGIN
  IF NEW.evidence_type = 'youtube_video' AND EXISTS (
    SELECT 1 FROM public.signal_runs r
    WHERE r.id = NEW.discovered_in_run_id AND r.run_type = 'scheduled_enrichment'
  ) THEN
    INSERT INTO public.signal_observation_schedule (signal_evidence_id)
    VALUES (NEW.id)
    ON CONFLICT (signal_evidence_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;

$body$;

    -- A trigger a rendszer altal, magatol az INSERT-tol hivodik meg — nem
    -- kozvetlen SELECT/RPC-hivassal — de az ACL-t akkor is explicit
    -- szukitjuk es validaljuk, defense-in-depth jelleggel: senki (PUBLIC/
    -- anon/authenticated/service_role) ne tudja kozvetlenul, function-
    -- hivaskent meghivni, kizarolag a tulajdonos postgres.
    REVOKE ALL ON FUNCTION public.trg_schedule_new_scheduled_youtube_evidence() FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.trg_schedule_new_scheduled_youtube_evidence() TO postgres;

    RAISE NOTICE '066: trg_schedule_new_scheduled_youtube_evidence created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    RAISE NOTICE '066: trg_schedule_new_scheduled_youtube_evidence already exists — VALIDATE branch (no DDL will run).';

    SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_body_hash
    FROM pg_proc p WHERE p.oid = v_exact_oid;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_result(p.oid) = 'trigger'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS FALSE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND v_body_hash = 'c7f3d7bb62073d8ce31df69dc103c9da'
    ) THEN
      RAISE EXCEPTION '066 drift: trg_schedule_new_scheduled_youtube_evidence definition (language/volatility/secdef/owner/search_path/body) does not match exactly (body_hash=%)', v_body_hash;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'trg_schedule_new_scheduled_youtube_evidence' AND grantee = 'postgres' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '066 drift: trg_schedule_new_scheduled_youtube_evidence missing postgres EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'trg_schedule_new_scheduled_youtube_evidence' AND grantee <> 'postgres'
    ) THEN
      RAISE EXCEPTION '066 drift: trg_schedule_new_scheduled_youtube_evidence has an unexpected EXECUTE grantee (only postgres is allowed)';
    END IF;

    RAISE NOTICE '066: trg_schedule_new_scheduled_youtube_evidence already exists and matches exactly — no-op.';
  ELSE
    RAISE EXCEPTION '066 drift: trg_schedule_new_scheduled_youtube_evidence exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$trigger_fn$;

DO $trigger_attach$
DECLARE
  v_trigger_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class cl ON cl.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND cl.relname = 'signal_evidence'
      AND t.tgname = 'trg_signal_evidence_schedule_new_scheduled' AND NOT t.tgisinternal
  ) INTO v_trigger_exists;

  IF NOT v_trigger_exists THEN
    RAISE NOTICE '066: trg_signal_evidence_schedule_new_scheduled trigger does not exist — CREATE branch.';

    CREATE TRIGGER trg_signal_evidence_schedule_new_scheduled
    AFTER INSERT ON public.signal_evidence
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_schedule_new_scheduled_youtube_evidence();

    RAISE NOTICE '066: trg_signal_evidence_schedule_new_scheduled trigger created.';
  ELSE
    RAISE NOTICE '066: trg_signal_evidence_schedule_new_scheduled already exists — VALIDATE branch (no DDL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class cl ON cl.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'signal_evidence'
        AND t.tgname = 'trg_signal_evidence_schedule_new_scheduled' AND NOT t.tgisinternal
        AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_signal_evidence_schedule_new_scheduled AFTER INSERT ON public.signal_evidence FOR EACH ROW EXECUTE FUNCTION trg_schedule_new_scheduled_youtube_evidence()'
    ) THEN
      RAISE EXCEPTION '066 drift: trg_signal_evidence_schedule_new_scheduled trigger definition text does not match exactly';
    END IF;

    RAISE NOTICE '066: trg_signal_evidence_schedule_new_scheduled already exists and matches exactly — no-op.';
  END IF;
END;
$trigger_attach$;

-- ============================================================
-- 3. RPC: reconcile_missing_signal_observation_schedules
-- ============================================================

DO $fn_reconcile$
DECLARE
  v_name_count int;
  v_exact_oid oid;
  v_body_hash text;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reconcile_missing_signal_observation_schedules';
  v_exact_oid := to_regprocedure('public.reconcile_missing_signal_observation_schedules()');

  IF v_name_count = 0 THEN
    RAISE NOTICE '066: reconcile_missing_signal_observation_schedules does not exist — CREATE branch.';

    CREATE FUNCTION public.reconcile_missing_signal_observation_schedules()
    RETURNS INTEGER
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_inserted INTEGER;
BEGIN
  INSERT INTO public.signal_observation_schedule (signal_evidence_id)
  SELECT DISTINCT sce.signal_evidence_id
  FROM public.signal_cluster_evidence sce
  JOIN public.signal_runs r ON r.id = sce.linked_in_run_id
  JOIN public.signal_evidence se ON se.id = sce.signal_evidence_id
  WHERE r.run_type = 'scheduled_enrichment'
    AND se.evidence_type = 'youtube_video'
  ON CONFLICT (signal_evidence_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;

$body$;

    REVOKE ALL ON FUNCTION public.reconcile_missing_signal_observation_schedules() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.reconcile_missing_signal_observation_schedules() TO service_role;

    RAISE NOTICE '066: reconcile_missing_signal_observation_schedules created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    RAISE NOTICE '066: reconcile_missing_signal_observation_schedules already exists — VALIDATE branch (no DDL/DCL will run).';

    SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_body_hash
    FROM pg_proc p WHERE p.oid = v_exact_oid;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = ''
        AND pg_get_function_result(p.oid) = 'integer'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND v_body_hash = 'c8f0784b89b785423622f49d9a3bc6e1'
    ) THEN
      RAISE EXCEPTION '066 drift: reconcile_missing_signal_observation_schedules definition does not match exactly (body_hash=%)', v_body_hash;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'reconcile_missing_signal_observation_schedules' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '066 drift: reconcile_missing_signal_observation_schedules missing service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'reconcile_missing_signal_observation_schedules' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '066 drift: reconcile_missing_signal_observation_schedules has an unexpected EXECUTE grantee';
    END IF;

    RAISE NOTICE '066: reconcile_missing_signal_observation_schedules already exists and matches exactly — no-op.';
  ELSE
    RAISE EXCEPTION '066 drift: reconcile_missing_signal_observation_schedules exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$fn_reconcile$;

-- ============================================================
-- 4. RPC: apply_signal_observation_batch
-- ============================================================

DO $fn_apply$
DECLARE
  v_name_count int;
  v_exact_oid oid;
  v_body_hash text;
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'apply_signal_observation_batch';
  v_exact_oid := to_regprocedure('public.apply_signal_observation_batch(uuid, uuid, text, timestamptz, jsonb)');

  IF v_name_count = 0 THEN
    RAISE NOTICE '066: apply_signal_observation_batch does not exist — CREATE branch.';

    CREATE FUNCTION public.apply_signal_observation_batch(
      p_run_id UUID,
      p_batch_id UUID,
      p_lease_owner TEXT,
      p_observed_at TIMESTAMPTZ,
      p_results JSONB
    ) RETURNS TABLE (schedule_id UUID, new_cadence TEXT, new_active BOOLEAN, observation_rows_written INTEGER)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_batch public.signal_collection_batches%ROWTYPE;
  v_phase public.signal_run_phases%ROWTYPE;
  v_run public.signal_runs%ROWTYPE;
  v_evidence public.signal_evidence%ROWTYPE;
  v_batch_video_ids TEXT[];
  v_payload_video_ids TEXT[];
  v_item JSONB;
  v_schedule_id UUID;
  v_evidence_id UUID;
  v_video_id TEXT;
  v_found BOOLEAN;
  v_view_count NUMERIC;
  v_like_count NUMERIC;
  v_comment_count NUMERIC;
  v_row public.signal_observation_schedule%ROWTYPE;
  v_bucket_start TIMESTAMPTZ;
  v_next_due_at TIMESTAMPTZ;
  v_is_stagnant BOOLEAN;
  v_new_stagnant INTEGER;
  v_new_miss INTEGER;
  v_new_cadence TEXT;
  v_new_active BOOLEAN;
  v_written INTEGER;
  v_item_count INTEGER;
  v_distinct_video_count INTEGER;
  v_safe_int_max CONSTANT NUMERIC := 9007199254740991;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: run_id required' USING ERRCODE = 'P0001';
  END IF;
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: batch_id required' USING ERRCODE = 'P0001';
  END IF;
  IF p_lease_owner IS NULL OR btrim(p_lease_owner) = '' THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: lease_owner required' USING ERRCODE = 'P0001';
  END IF;
  IF p_observed_at IS NULL THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: observed_at required' USING ERRCODE = 'P0001';
  END IF;
  IF p_results IS NULL OR jsonb_typeof(p_results) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: results must be a JSON array' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_item_count FROM jsonb_array_elements(p_results);
  IF v_item_count = 0 OR v_item_count > 500 THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: results must contain 1 to 500 items, found %', v_item_count USING ERRCODE = 'P0001';
  END IF;
  IF v_item_count <> (SELECT count(DISTINCT elem->>'schedule_id') FROM jsonb_array_elements(p_results) elem) THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: duplicate schedule_id in results' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(DISTINCT elem->>'video_id') INTO v_distinct_video_count FROM jsonb_array_elements(p_results) elem;
  IF v_distinct_video_count > 50 THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: at most 50 unique video_id values allowed, found %', v_distinct_video_count USING ERRCODE = 'P0001';
  END IF;

  -- ============================================================
  -- BATCH/RUN/PHASE/LEASE GUARD — a batch sorat itt zaroljuk (FOR
  -- UPDATE), hogy ket konkurens hivas ugyanarra a batchre sorba alljon,
  -- ne parhuzamosan irjon. Minden eltereskor teljes RAISE EXCEPTION —
  -- a hivo payloadja sosem "megbizhato" onmagaban, minden allitasat a
  -- DB tenyleges allapotahoz kell kotni.
  -- ============================================================
  SELECT * INTO v_batch FROM public.signal_collection_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: batch % not found', p_batch_id USING ERRCODE = 'P0001';
  END IF;
  IF v_batch.batch_type <> 'observation' THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: batch % is not an observation batch (batch_type=%)', p_batch_id, v_batch.batch_type USING ERRCODE = 'P0001';
  END IF;
  IF v_batch.status <> 'in_progress' THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: batch % is not in_progress (status=%)', p_batch_id, v_batch.status USING ERRCODE = 'P0001';
  END IF;
  IF v_batch.lease_owner IS DISTINCT FROM p_lease_owner THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: lease_owner mismatch for batch %', p_batch_id USING ERRCODE = 'P0001';
  END IF;
  IF v_batch.lease_expires_at IS NULL OR v_batch.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: lease expired for batch %', p_batch_id USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_phase FROM public.signal_run_phases WHERE id = v_batch.run_phase_id;
  IF NOT FOUND OR v_phase.phase <> 'observation' THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: batch % is not linked to an observation phase', p_batch_id USING ERRCODE = 'P0001';
  END IF;
  IF v_phase.run_id <> p_run_id THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: batch % run_phase does not belong to run %', p_batch_id, p_run_id USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_run FROM public.signal_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: run % not found', p_run_id USING ERRCODE = 'P0001';
  END IF;
  IF v_run.run_type <> 'scheduled_enrichment' THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: run % is not scheduled_enrichment (run_type=%)', p_run_id, v_run.run_type USING ERRCODE = 'P0001';
  END IF;
  IF v_run.status <> 'started' THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: run % is terminal (status=%)', p_run_id, v_run.status USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(v ORDER BY v) INTO v_batch_video_ids FROM jsonb_array_elements_text(v_batch.item_ids) v;
  SELECT array_agg(DISTINCT elem->>'video_id' ORDER BY elem->>'video_id') INTO v_payload_video_ids FROM jsonb_array_elements(p_results) elem;
  IF v_batch_video_ids IS DISTINCT FROM v_payload_video_ids THEN
    RAISE EXCEPTION 'apply_signal_observation_batch: payload video_id set does not match batch item_ids for batch %', p_batch_id USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_results)
  LOOP
    IF NOT (v_item ? 'schedule_id' AND v_item ? 'evidence_id' AND v_item ? 'video_id' AND v_item ? 'found') THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: each item requires schedule_id, evidence_id, video_id, found' USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      v_schedule_id := (v_item->>'schedule_id')::UUID;
      v_evidence_id := (v_item->>'evidence_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: schedule_id/evidence_id must be valid UUIDs' USING ERRCODE = 'P0001';
    END;
    v_video_id := v_item->>'video_id';
    IF v_video_id IS NULL OR v_video_id !~ '^[A-Za-z0-9_-]{1,100}$' THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: invalid video_id (schedule_id=%)', v_schedule_id USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(v_item->'found') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: found must be a boolean (schedule_id=%)', v_schedule_id USING ERRCODE = 'P0001';
    END IF;
    v_found := (v_item->>'found')::BOOLEAN;
    v_view_count := NULLIF(v_item->>'view_count', '')::NUMERIC;
    v_like_count := NULLIF(v_item->>'like_count', '')::NUMERIC;
    v_comment_count := NULLIF(v_item->>'comment_count', '')::NUMERIC;

    IF v_found THEN
      IF v_view_count IS NULL OR v_view_count < 0 OR v_view_count <> floor(v_view_count) OR v_view_count > v_safe_int_max THEN
        RAISE EXCEPTION 'apply_signal_observation_batch: found=true requires a non-negative safe-integer view_count (schedule_id=%)', v_schedule_id USING ERRCODE = 'P0001';
      END IF;
      IF v_like_count IS NOT NULL AND (v_like_count < 0 OR v_like_count <> floor(v_like_count) OR v_like_count > v_safe_int_max) THEN
        RAISE EXCEPTION 'apply_signal_observation_batch: like_count must be a non-negative safe integer (schedule_id=%)', v_schedule_id USING ERRCODE = 'P0001';
      END IF;
      IF v_comment_count IS NOT NULL AND (v_comment_count < 0 OR v_comment_count <> floor(v_comment_count) OR v_comment_count > v_safe_int_max) THEN
        RAISE EXCEPTION 'apply_signal_observation_batch: comment_count must be a non-negative safe integer (schedule_id=%)', v_schedule_id USING ERRCODE = 'P0001';
      END IF;
    ELSE
      IF v_view_count IS NOT NULL OR v_like_count IS NOT NULL OR v_comment_count IS NOT NULL THEN
        RAISE EXCEPTION 'apply_signal_observation_batch: found=false must not carry metric values (schedule_id=%)', v_schedule_id USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- ============================================================
    -- EVIDENCE/SCHEDULE GUARD — a schedule sort itt zaroljuk. A
    -- next_due_at/last_observed_at ellenorzes egyben a dupla/kesoi
    -- alkalmazas elleni vedelem is: az elso sikeres hivas mar a jovobe
    -- tolja a next_due_at-ot, igy egy megismetelt hivas UGYANAZZAL a
    -- p_observed_at-tal itt mar elbukik.
    -- ============================================================
    SELECT * INTO v_row FROM public.signal_observation_schedule
    WHERE id = v_schedule_id AND signal_evidence_id = v_evidence_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: schedule_id % / evidence_id % not found', v_schedule_id, v_evidence_id USING ERRCODE = 'P0001';
    END IF;
    IF v_row.active IS NOT TRUE THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: schedule % is not active', v_schedule_id USING ERRCODE = 'P0001';
    END IF;
    IF v_row.next_due_at > p_observed_at THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: schedule % is not yet due (next_due_at=%, observed_at=%)', v_schedule_id, v_row.next_due_at, p_observed_at USING ERRCODE = 'P0001';
    END IF;
    IF v_row.last_observed_at IS NOT NULL AND v_row.last_observed_at > p_observed_at THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: observed_at % is older than the schedule''s last_observed_at % (schedule_id=%)', p_observed_at, v_row.last_observed_at, v_schedule_id USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_evidence FROM public.signal_evidence WHERE id = v_evidence_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: evidence % not found', v_evidence_id USING ERRCODE = 'P0001';
    END IF;
    IF v_evidence.evidence_type <> 'youtube_video' THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: evidence % is not a youtube_video (evidence_type=%)', v_evidence_id, v_evidence.evidence_type USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(v_evidence.youtube_videos_ref, v_evidence.external_ref) IS DISTINCT FROM v_video_id THEN
      RAISE EXCEPTION 'apply_signal_observation_batch: video_id % does not match evidence % (schedule_id=%)', v_video_id, v_evidence_id, v_schedule_id USING ERRCODE = 'P0001';
    END IF;

    v_bucket_start := date_trunc('day', p_observed_at);
    IF v_row.cadence = 'weekly' THEN
      v_bucket_start := date_trunc('week', p_observed_at);
    ELSIF v_row.cadence = 'early8h' THEN
      v_bucket_start := date_trunc('day', p_observed_at)
        + make_interval(hours => (floor(extract(hour FROM p_observed_at) / 8) * 8)::int);
    END IF;

    v_written := 0;

    IF v_found THEN
      v_is_stagnant := v_row.last_observed_at IS NOT NULL
        AND v_row.last_view_count IS NOT NULL AND v_view_count = v_row.last_view_count
        AND (v_row.last_like_count IS NULL) = (v_like_count IS NULL)
        AND (v_row.last_like_count IS NULL OR v_row.last_like_count = v_like_count)
        AND (v_row.last_comment_count IS NULL) = (v_comment_count IS NULL)
        AND (v_row.last_comment_count IS NULL OR v_row.last_comment_count = v_comment_count);

      IF v_is_stagnant THEN
        v_new_stagnant := v_row.consecutive_stagnant_checks + 1;
        IF v_row.cadence = 'daily' AND v_new_stagnant >= 3 THEN
          v_new_cadence := 'weekly';
          v_new_stagnant := 0;
        ELSE
          v_new_cadence := v_row.cadence;
        END IF;
        v_new_active := NOT (v_row.cadence = 'weekly' AND v_new_stagnant >= 4);
      ELSE
        v_new_stagnant := 0;
        v_new_cadence := CASE WHEN v_row.cadence = 'weekly' THEN 'daily' ELSE v_row.cadence END;
        v_new_active := true;
      END IF;
      v_new_miss := 0;
      v_next_due_at := p_observed_at + (CASE WHEN v_new_cadence = 'weekly' THEN interval '7 days' ELSE interval '24 hours' END);

      INSERT INTO public.signal_observations
        (signal_evidence_id, signal_run_id, metric_type, metric_value, cadence, bucket_start, observed_at)
      VALUES (v_evidence_id, p_run_id, 'youtube_view_count', v_view_count, v_row.cadence, v_bucket_start, p_observed_at)
      ON CONFLICT (signal_evidence_id, metric_type, cadence, bucket_start) DO UPDATE
        SET metric_value = EXCLUDED.metric_value, signal_run_id = EXCLUDED.signal_run_id, observed_at = EXCLUDED.observed_at;
      v_written := v_written + 1;

      IF v_like_count IS NOT NULL THEN
        INSERT INTO public.signal_observations
          (signal_evidence_id, signal_run_id, metric_type, metric_value, cadence, bucket_start, observed_at)
        VALUES (v_evidence_id, p_run_id, 'youtube_like_count', v_like_count, v_row.cadence, v_bucket_start, p_observed_at)
        ON CONFLICT (signal_evidence_id, metric_type, cadence, bucket_start) DO UPDATE
          SET metric_value = EXCLUDED.metric_value, signal_run_id = EXCLUDED.signal_run_id, observed_at = EXCLUDED.observed_at;
        v_written := v_written + 1;
      END IF;
      IF v_comment_count IS NOT NULL THEN
        INSERT INTO public.signal_observations
          (signal_evidence_id, signal_run_id, metric_type, metric_value, cadence, bucket_start, observed_at)
        VALUES (v_evidence_id, p_run_id, 'youtube_comment_count', v_comment_count, v_row.cadence, v_bucket_start, p_observed_at)
        ON CONFLICT (signal_evidence_id, metric_type, cadence, bucket_start) DO UPDATE
          SET metric_value = EXCLUDED.metric_value, signal_run_id = EXCLUDED.signal_run_id, observed_at = EXCLUDED.observed_at;
        v_written := v_written + 1;
      END IF;

      UPDATE public.signal_observation_schedule
      SET cadence = v_new_cadence,
          next_due_at = v_next_due_at,
          last_observed_at = p_observed_at,
          last_view_count = v_view_count,
          last_like_count = v_like_count,
          last_comment_count = v_comment_count,
          consecutive_stagnant_checks = v_new_stagnant,
          consecutive_miss_checks = v_new_miss,
          active = v_new_active,
          updated_at = now()
      WHERE id = v_schedule_id;
    ELSE
      v_new_miss := v_row.consecutive_miss_checks + 1;
      v_new_active := v_new_miss < 2;
      v_new_cadence := v_row.cadence;
      v_next_due_at := p_observed_at + interval '24 hours';

      UPDATE public.signal_observation_schedule
      SET next_due_at = v_next_due_at,
          consecutive_miss_checks = v_new_miss,
          active = v_new_active,
          updated_at = now()
      WHERE id = v_schedule_id;
    END IF;

    schedule_id := v_schedule_id;
    new_cadence := v_new_cadence;
    new_active := v_new_active;
    observation_rows_written := v_written;
    RETURN NEXT;
  END LOOP;
END;

$body$;

    REVOKE ALL ON FUNCTION public.apply_signal_observation_batch(UUID, UUID, TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.apply_signal_observation_batch(UUID, UUID, TEXT, TIMESTAMPTZ, JSONB) TO service_role;

    RAISE NOTICE '066: apply_signal_observation_batch created.';
  ELSIF v_name_count = 1 AND v_exact_oid IS NOT NULL THEN
    RAISE NOTICE '066: apply_signal_observation_batch already exists — VALIDATE branch (no DDL/DCL will run).';

    SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) INTO v_body_hash
    FROM pg_proc p WHERE p.oid = v_exact_oid;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_exact_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = 'p_run_id uuid, p_batch_id uuid, p_lease_owner text, p_observed_at timestamp with time zone, p_results jsonb'
        AND pg_get_function_result(p.oid) = 'TABLE(schedule_id uuid, new_cadence text, new_active boolean, observation_rows_written integer)'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
        AND v_body_hash = 'f67212b8e05095e0118c0562d09b1b0b'
    ) THEN
      RAISE EXCEPTION '066 drift: apply_signal_observation_batch definition does not match exactly (body_hash=%)', v_body_hash;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'apply_signal_observation_batch' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '066 drift: apply_signal_observation_batch missing service_role EXECUTE grant';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'apply_signal_observation_batch' AND grantee NOT IN ('service_role', 'postgres')
    ) THEN
      RAISE EXCEPTION '066 drift: apply_signal_observation_batch has an unexpected EXECUTE grantee';
    END IF;

    RAISE NOTICE '066: apply_signal_observation_batch already exists and matches exactly — no-op.';
  ELSE
    RAISE EXCEPTION '066 drift: apply_signal_observation_batch exists with an unexpected overload/signature (name_count=%, exact_match=%)', v_name_count, (v_exact_oid IS NOT NULL);
  END IF;
END;
$fn_apply$;

NOTIFY pgrst, 'reload schema';

COMMIT;
