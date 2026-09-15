-- ============================================================
-- Migration 089: PFM Lifecycle Reviewer Self-Capability v1
--
-- Kanonikus elozmeny: a Lifecycle Reviewer Self-Capability v1 tervezo-
-- lezaro gate. A Lifecycle Reviewer Frontend 4B audit megallapitotta,
-- hogy nincs stabil, biztonsagos capability-szerzodes -- a dashboard
-- csak session usert es profilt ismer, a profil nem hordoz reviewer-
-- jogosultsagot, a reviewer-menupont jelenleg feltetel nelkul lathato,
-- a reviewer-tabla kozvetlen authenticated/client-side olvasasa
-- szandekosan tiltott (077 sajat FORCE ROW LEVEL SECURITY + kizarolag
-- service_role SELECT grantja), es a list API 200/403 eredmenyet
-- capability-jelkent hasznalni nem elfogadhato (osszekotne a
-- navigaciot egy adatlista lekeresevel es annak uzemallapotaval).
--
-- Ez a migracio EGYETLEN, uj, minimalis RPC-t vezet be:
--   get_semantic_topic_lifecycle_reviewer_capability() -- parameter
--     nelkuli, STABLE, SECURITY DEFINER, BOOLEAN visszateressel.
-- Kizarolag azt valaszolja meg, hogy a HIVO SAJAT auth.uid()-jahoz
-- letezik-e active=true sor a semantic_topic_reviewers tablaban --
-- soha nem ad vissza reviewer UUID-t, listat, szerepkort, e-mailt vagy
-- barmilyen mas adatot. Inaktiv reviewer es nem-reviewer UGYANAZT a
-- false erteket kapja, ugyanazon a kodutan (EXISTS), kulonbseg soha
-- nem fedheto fel. auth.uid() hianya (session nelkuli kozvetlen hivas)
-- fail-closed RAISE EXCEPTION-t dob -- ezt a HTTP route sosem eri el
-- sajat auth.getUser() 401-es on elutasitasa miatt, csak egy session
-- nelkuli, kozvetlen RPC-hivas (pl. anon kulccsal) eseten aktivalodik.
--
-- Ez a migracio a 077-es semantic_topic_reviewers tablan KIVUL semmi
-- mast nem felteteez es semmi mast nem erint -- 086/087/088 sajat
-- objektumai valtozatlanok maradnak, ez a migracio nem is hivatkozik
-- rajuk.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. FUGGOSEGI ELOFELTETEL -- 077 semantic_topic_reviewers tabla
--    valtozatlan jelenlete es alapveto alakja (a ket erintett oszlop:
--    user_id, active).
-- ============================================================

DO $preflight_089$
DECLARE
  v_table_count int;
BEGIN
  SELECT count(*) INTO v_table_count
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'semantic_topic_reviewers';
  IF v_table_count <> 1 THEN
    RAISE EXCEPTION '089 fail-closed: semantic_topic_reviewers table not present -- 077 must be fully applied first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewers'
      AND column_name = 'user_id' AND data_type = 'uuid' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '089 fail-closed: semantic_topic_reviewers.user_id column does not match expected shape.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'semantic_topic_reviewers'
      AND column_name = 'active' AND data_type = 'boolean' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '089 fail-closed: semantic_topic_reviewers.active column does not match expected shape.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'semantic_topic_reviewers' AND rowsecurity = true
  ) THEN
    RAISE EXCEPTION '089 fail-closed: semantic_topic_reviewers no longer has row security enabled.';
  END IF;

  RAISE NOTICE '089: preflight gate passed (semantic_topic_reviewers table present with expected shape).';
END;
$preflight_089$;

-- ============================================================
-- 1. get_semantic_topic_lifecycle_reviewer_capability -- UJ, minimalis,
--    parameter nelkuli, kizarolag a hivo SAJAT aktiv-reviewer statusat
--    valaszolo RPC.
-- ============================================================

DO $migrate_capability_089$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '141a93f922973dc9b2b20dc8df7e2de0';
  v_expected_args CONSTANT text := '';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_semantic_topic_lifecycle_reviewer_capability';

  IF v_name_count = 0 THEN
    RAISE NOTICE '089: get_semantic_topic_lifecycle_reviewer_capability does not exist -- CREATE branch.';

    CREATE FUNCTION public.get_semantic_topic_lifecycle_reviewer_capability()
    RETURNS BOOLEAN
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $rpc$
    DECLARE
      v_caller_user_id UUID;
    BEGIN
      v_caller_user_id := auth.uid();
      IF v_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'get_semantic_topic_lifecycle_reviewer_capability: authentication required';
      END IF;

      -- Egyetlen kodut, egyetlen EXISTS -- inaktiv reviewer es
      -- nem-reviewer szandekosan megkulonboztethetetlen: mindketto
      -- ugyanazt a false erteket adja, nincs kulon ELSE ag, nincs
      -- masik lekerdezes, ami idozitessel vagy hibauzenettel arulna el
      -- a kulonbseget.
      RETURN EXISTS (
        SELECT 1 FROM public.semantic_topic_reviewers
        WHERE user_id = v_caller_user_id AND active IS TRUE
      );
    END;
    $rpc$;

    REVOKE ALL ON FUNCTION public.get_semantic_topic_lifecycle_reviewer_capability() FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.get_semantic_topic_lifecycle_reviewer_capability() TO authenticated;

    RAISE NOTICE '089: get_semantic_topic_lifecycle_reviewer_capability created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '089: get_semantic_topic_lifecycle_reviewer_capability already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_semantic_topic_lifecycle_reviewer_capability';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args AND pg_get_function_result(p.oid) = 'boolean'
        AND l.lanname = 'plpgsql' AND p.provolatile = 's' AND p.proisstrict IS FALSE AND p.prosecdef IS TRUE
        AND p.proparallel = 'u' AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '089 drift: get_semantic_topic_lifecycle_reviewer_capability structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '089 drift: get_semantic_topic_lifecycle_reviewer_capability body hash does not match exactly (got %)', v_hash;
    END IF;

    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid)))) acl
         JOIN pg_roles grantee ON grantee.oid = acl.grantee
         WHERE acl.privilege_type = 'EXECUTE' AND grantee.rolname NOT IN ('postgres', 'authenticated')
       )
    THEN
      RAISE EXCEPTION '089 drift: get_semantic_topic_lifecycle_reviewer_capability ACL does not match exactly (expected postgres+authenticated EXECUTE only)';
    END IF;

    RAISE NOTICE '089: get_semantic_topic_lifecycle_reviewer_capability already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '089 fail-closed: get_semantic_topic_lifecycle_reviewer_capability has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_capability_089$;

-- ============================================================
-- 2. Fail-fast vegallapot onellenorzes.
-- ============================================================

DO $final_selfcheck_089$
DECLARE
  v_hash text;
  v_expected_capability_hash CONSTANT text := '141a93f922973dc9b2b20dc8df7e2de0';
BEGIN
  SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_hash FROM pg_proc WHERE oid = 'public.get_semantic_topic_lifecycle_reviewer_capability()'::regprocedure;
  IF v_hash <> v_expected_capability_hash THEN
    RAISE EXCEPTION '089 CRITICAL: get_semantic_topic_lifecycle_reviewer_capability final body hash (%) does not match expected.', v_hash;
  END IF;

  IF has_function_privilege('anon', 'public.get_semantic_topic_lifecycle_reviewer_capability()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_semantic_topic_lifecycle_reviewer_capability()'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION '089 CRITICAL: get_semantic_topic_lifecycle_reviewer_capability has an EXECUTE grant to anon or service_role -- must be authenticated-only.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_semantic_topic_lifecycle_reviewer_capability()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '089 CRITICAL: get_semantic_topic_lifecycle_reviewer_capability is missing its required authenticated EXECUTE grant.';
  END IF;

  RAISE NOTICE '089: final self-check passed -- capability RPC present with expected body hash and authenticated-only grant.';
END;
$final_selfcheck_089$;

NOTIFY pgrst, 'reload schema';

COMMIT;
