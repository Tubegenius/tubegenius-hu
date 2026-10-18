-- ============================================================
-- profiles field-revision PROBE (migration 094): for the FIRST run on a DISPOSABLE, ISOLATED local PostgreSQL.
--
-- The run status of this probe is NOT recorded in this file (it would go stale): see "Futasi statusz" in
-- docs/operations/profiles-field-revision.md. Until a real run, its syntax and every expectation below are UNVERIFIED.
-- A wrong expectation is a FINDING (fix the script or the migration), never a reason to loosen a check.
--
-- WHERE (the user's direction): a throwaway local PostgreSQL (>= 17) with the Supabase roles (anon, authenticated,
-- service_role, postgres), migrations 001-091 and then 094 applied, SYNTHETIC data only. NOT the shared
-- supabase_db_WillViralFinal container, NOT staging, NOT production, NOT a provider database.
--
-- HOW:  psql -X -q -A -t -v ON_ERROR_STOP=1 -v synthetic_user=<uuid> -f scripts/profiles-field-revision-probe.sql
--   * <uuid> is a SYNTHETIC user created by the runner through auth.users beforehand, so that handle_new_user() created
--     its profiles row (that creation is itself the INSERT-path check, C05). The probe errors out if it is missing.
--   * Everything runs in ONE transaction that ends in ROLLBACK: no synthetic row change survives (sequence values are
--     consumed, which is expected).
--
-- NON-SKIPPABLE RESULT CONTRACT (a skipped or partial run is a FAILURE, never a PASS):
--   a run PASSES only if ALL of these hold: psql exit code 0; exactly 16 lines starting `PROBE_PASS|C01` ... `C16`
--   (each once, in order); and the last output line is `PROBE_RESULT|checks=16`. Any `PROBE_FAIL|` line, a missing
--   line, a different count, or a non-zero exit is a FAIL. There is no "skipped" state.
-- Run scripts/public-schema-privilege-guard.sql separately (it has its own BEGIN/ROLLBACK); expected there:
--   `GUARD_RESULT|violations=0` and `public_functions=110` on a 001-091 + 094 database.
-- ============================================================
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset footer off

BEGIN;

SELECT set_config('probe.user', :'synthetic_user', true);

-- C01 triggers: shape, enabled, no OF / WHEN / arguments, the right functions
DO $c01$
BEGIN
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'public.profiles'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
        AND t.tgqual IS NULL AND COALESCE(array_length(t.tgattr::int2[], 1), 0) = 0 AND t.tgnargs = 0
        AND ((t.tgname = 'profiles_zz_revision_assign' AND t.tgtype = 23 AND p.proname = 'profiles_field_revision_assign')
          OR (t.tgname = 'profiles_zz_revision_assert' AND t.tgtype = 21 AND p.proname = 'profiles_field_revision_assert'))) <> 2 THEN
    RAISE EXCEPTION 'PROBE_FAIL|C01 the two revision triggers are missing or have the wrong shape';
  END IF;
  -- the assigning trigger fires AFTER every other BEFORE ROW trigger (name order, C collation)
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal
             AND (tgtype & 3) = 3 AND tgname COLLATE "C" > 'profiles_zz_revision_assign') THEN
    RAISE EXCEPTION 'PROBE_FAIL|C01 a BEFORE ROW trigger fires after the assigning trigger';
  END IF;
END
$c01$;
SELECT 'PROBE_PASS|C01_triggers_shape_enabled_order';

-- C02 the two functions against the SAME contract line format as the 090 pins (body md5 included)
DO $c02$
DECLARE
  got text;
  expected text :=
    E'profiles_field_revision_assert()|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=7c97a9eb1eaa349d7b410eacd4d14bda\n'
    || E'profiles_field_revision_assign()|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=f03a538ec277850a5c6b65367dfb25d7';
BEGIN
  SELECT string_agg(line, E'\n' ORDER BY line) INTO got FROM (
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ||
      '|owner=' || pg_get_userbyid(p.proowner) || '|kind=' || p.prokind::text || '|secdef=' || p.prosecdef ||
      '|vol=' || p.provolatile::text || '|cfg=' || coalesce(array_to_string(p.proconfig, ';'), '') ||
      '|acl=' || coalesce((SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type, ',' ORDER BY (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END), a.privilege_type) FROM aclexplode(p.proacl) a), '<null>') ||
      '|body=' || md5(replace(p.prosrc, E'\r\n', E'\n')) AS line
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('profiles_field_revision_assign', 'profiles_field_revision_assert')) s;
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'PROBE_FAIL|C02 function contract differs: %', got;
  END IF;
END
$c02$;
SELECT 'PROBE_PASS|C02_function_contract_pins';

-- C03 the sequence: definition and no privilege for PUBLIC / the API roles
DO $c03$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid = 'public.profiles_field_revision_seq'::regclass
                 AND seqtypid = 'bigint'::regtype AND seqincrement = 1 AND seqmin = 1 AND seqmax = 9223372036854775807
                 AND seqcache = 1 AND NOT seqcycle) THEN
    RAISE EXCEPTION 'PROBE_FAIL|C03 sequence definition';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
             WHERE c.oid = 'public.profiles_field_revision_seq'::regclass
               AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole))) THEN
    RAISE EXCEPTION 'PROBE_FAIL|C03 sequence grants a privilege to PUBLIC/anon/authenticated/service_role';
  END IF;
END
$c03$;
SELECT 'PROBE_PASS|C03_sequence_definition_and_acl';

-- C04 columns, constraints, unique indexes
DO $c04$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name IN ('specific_focus_revision', 'main_category_revision')
      AND udt_name = 'int8' AND is_nullable = 'NO' AND column_default IS NULL) <> 2 THEN
    RAISE EXCEPTION 'PROBE_FAIL|C04 revision columns';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass AND contype = 'c' AND convalidated
      AND conname IN ('profiles_specific_focus_revision_positive', 'profiles_main_category_revision_positive')) <> 2 THEN
    RAISE EXCEPTION 'PROBE_FAIL|C04 CHECK constraints';
  END IF;
  IF (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = 'public.profiles'::regclass AND i.indisunique AND i.indisvalid AND i.indnatts = 1 AND i.indpred IS NULL
        AND ic.relname IN ('profiles_specific_focus_revision_key', 'profiles_main_category_revision_key')) <> 2 THEN
    RAISE EXCEPTION 'PROBE_FAIL|C04 unique indexes';
  END IF;
END
$c04$;
SELECT 'PROBE_PASS|C04_columns_constraints_indexes';

-- C05 INSERT path: the synthetic profile row, created through auth.users -> handle_new_user() -> INSERT
DO $c05$
DECLARE u uuid := current_setting('probe.user')::uuid; r record;
BEGIN
  SELECT specific_focus_revision AS f, main_category_revision AS c INTO STRICT r FROM public.profiles WHERE user_id = u;
  IF r.f < 1 OR r.c < 1 OR r.f = r.c THEN
    RAISE EXCEPTION 'PROBE_FAIL|C05 INSERT-path revisions are not positive and distinct: % %', r.f, r.c;
  END IF;
END
$c05$;
SELECT 'PROBE_PASS|C05_insert_path_positive_distinct';

-- C06 a focus change gives the focus a NEW revision and leaves the category revision alone
DO $c06$
DECLARE u uuid := current_setting('probe.user')::uuid; b record; a record;
BEGIN
  SELECT specific_focus_revision AS f, main_category_revision AS c INTO STRICT b FROM public.profiles WHERE user_id = u;
  UPDATE public.profiles SET specific_focus = 'probe-focus-1' WHERE user_id = u;
  SELECT specific_focus_revision AS f, main_category_revision AS c INTO STRICT a FROM public.profiles WHERE user_id = u;
  IF a.f = b.f OR a.c <> b.c THEN
    RAISE EXCEPTION 'PROBE_FAIL|C06 focus change: focus revision % -> %, category revision % -> %', b.f, a.f, b.c, a.c;
  END IF;
END
$c06$;
SELECT 'PROBE_PASS|C06_focus_change_new_revision_category_untouched';

-- C07 a form re-save that writes every field with the SAME values changes no revision
DO $c07$
DECLARE u uuid := current_setting('probe.user')::uuid; b record; a record;
BEGIN
  SELECT specific_focus_revision AS f, main_category_revision AS c INTO STRICT b FROM public.profiles WHERE user_id = u;
  UPDATE public.profiles SET specific_focus = specific_focus, main_category = main_category, onboarding_completed = true WHERE user_id = u;
  SELECT specific_focus_revision AS f, main_category_revision AS c INTO STRICT a FROM public.profiles WHERE user_id = u;
  IF a.f <> b.f OR a.c <> b.c THEN
    RAISE EXCEPTION 'PROBE_FAIL|C07 re-save with unchanged values changed a revision';
  END IF;
END
$c07$;
SELECT 'PROBE_PASS|C07_resave_unchanged_keeps_revisions';

-- C08 A -> B -> A: three DIFFERENT revisions
DO $c08$
DECLARE u uuid := current_setting('probe.user')::uuid; r1 bigint; r2 bigint; r3 bigint;
BEGIN
  UPDATE public.profiles SET specific_focus = 'probe-A' WHERE user_id = u;
  SELECT specific_focus_revision INTO STRICT r1 FROM public.profiles WHERE user_id = u;
  UPDATE public.profiles SET specific_focus = 'probe-B' WHERE user_id = u;
  SELECT specific_focus_revision INTO STRICT r2 FROM public.profiles WHERE user_id = u;
  UPDATE public.profiles SET specific_focus = 'probe-A' WHERE user_id = u;
  SELECT specific_focus_revision INTO STRICT r3 FROM public.profiles WHERE user_id = u;
  IF r1 = r2 OR r2 = r3 OR r1 = r3 THEN
    RAISE EXCEPTION 'PROBE_FAIL|C08 A->B->A revisions: % % %', r1, r2, r3;
  END IF;
END
$c08$;
SELECT 'PROBE_PASS|C08_a_b_a_three_distinct_revisions';

-- C09 a client-supplied revision is ignored, with and without a value change
DO $c09$
DECLARE u uuid := current_setting('probe.user')::uuid; b bigint; a bigint;
BEGIN
  SELECT specific_focus_revision INTO STRICT b FROM public.profiles WHERE user_id = u;
  UPDATE public.profiles SET specific_focus = specific_focus, specific_focus_revision = 1 WHERE user_id = u;
  SELECT specific_focus_revision INTO STRICT a FROM public.profiles WHERE user_id = u;
  IF a <> b THEN RAISE EXCEPTION 'PROBE_FAIL|C09 a client revision changed an unchanged field (% -> %)', b, a; END IF;
  UPDATE public.profiles SET specific_focus = 'probe-C', specific_focus_revision = b WHERE user_id = u;
  SELECT specific_focus_revision INTO STRICT a FROM public.profiles WHERE user_id = u;
  IF a = b THEN RAISE EXCEPTION 'PROBE_FAIL|C09 a client revision kept the old revision on a value change'; END IF;
END
$c09$;
SELECT 'PROBE_PASS|C09_client_revision_ignored';

-- C10 NULL transitions: value -> NULL is a change; NULL -> NULL is not
DO $c10$
DECLARE u uuid := current_setting('probe.user')::uuid; r0 bigint; r1 bigint; r2 bigint;
BEGIN
  SELECT specific_focus_revision INTO STRICT r0 FROM public.profiles WHERE user_id = u;
  UPDATE public.profiles SET specific_focus = NULL WHERE user_id = u;
  SELECT specific_focus_revision INTO STRICT r1 FROM public.profiles WHERE user_id = u;
  UPDATE public.profiles SET specific_focus = NULL WHERE user_id = u;
  SELECT specific_focus_revision INTO STRICT r2 FROM public.profiles WHERE user_id = u;
  IF r1 = r0 OR r2 <> r1 THEN RAISE EXCEPTION 'PROBE_FAIL|C10 NULL transitions: % % %', r0, r1, r2; END IF;
END
$c10$;
SELECT 'PROBE_PASS|C10_null_transitions';

-- C11 both fields in one UPDATE: two new, mutually different revisions
DO $c11$
DECLARE u uuid := current_setting('probe.user')::uuid; b record; a record;
BEGIN
  SELECT specific_focus_revision AS f, main_category_revision AS c INTO STRICT b FROM public.profiles WHERE user_id = u;
  UPDATE public.profiles SET specific_focus = 'probe-M', main_category = 'probe-cat' WHERE user_id = u;
  SELECT specific_focus_revision AS f, main_category_revision AS c INTO STRICT a FROM public.profiles WHERE user_id = u;
  IF a.f = b.f OR a.c = b.c OR a.f = a.c THEN
    RAISE EXCEPTION 'PROBE_FAIL|C11 two-field update: % % -> % %', b.f, b.c, a.f, a.c;
  END IF;
END
$c11$;
SELECT 'PROBE_PASS|C11_two_field_update';

-- C12 the e2e fixture shape: INSERT ... ON CONFLICT (user_id) DO UPDATE SET <non-focus column>
--     expected: the revisions are UNCHANGED, and the BEFORE INSERT trigger consumed at least two sequence values
DO $c12$
DECLARE u uuid := current_setting('probe.user')::uuid; b record; a record; s0 bigint; s1 bigint;
BEGIN
  SELECT specific_focus_revision AS f, main_category_revision AS c INTO STRICT b FROM public.profiles WHERE user_id = u;
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO s0 FROM public.profiles_field_revision_seq;
  INSERT INTO public.profiles (user_id, onboarding_completed) VALUES (u, true)
    ON CONFLICT (user_id) DO UPDATE SET onboarding_completed = true;
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO s1 FROM public.profiles_field_revision_seq;
  SELECT specific_focus_revision AS f, main_category_revision AS c INTO STRICT a FROM public.profiles WHERE user_id = u;
  IF a.f <> b.f OR a.c <> b.c THEN RAISE EXCEPTION 'PROBE_FAIL|C12 ON CONFLICT path changed a revision'; END IF;
  IF s1 - s0 < 2 THEN RAISE EXCEPTION 'PROBE_FAIL|C12 expected >= 2 consumed sequence values, got %', s1 - s0; END IF;
END
$c12$;
SELECT 'PROBE_PASS|C12_on_conflict_e2e_shape';

-- C13 as the `authenticated` API role through RLS (profiles_update_own): the trigger works for a role without EXECUTE
--     on the function and without any sequence privilege, and a direct write of the revision column is ignored
SELECT set_config('request.jwt.claim.sub', current_setting('probe.user'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('probe.user'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $c13$
DECLARE u uuid := current_setting('probe.user')::uuid; b bigint; a bigint; n integer;
BEGIN
  SELECT specific_focus_revision INTO STRICT b FROM public.profiles WHERE user_id = u;
  UPDATE public.profiles SET specific_focus = 'probe-auth', specific_focus_revision = b WHERE user_id = u;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'PROBE_FAIL|C13 RLS/grant blocked the authenticated UPDATE (rows=%)', n; END IF;
  SELECT specific_focus_revision INTO STRICT a FROM public.profiles WHERE user_id = u;
  IF a = b THEN RAISE EXCEPTION 'PROBE_FAIL|C13 authenticated UPDATE did not get a new revision'; END IF;
  UPDATE public.profiles SET specific_focus = specific_focus, main_category_revision = 1 WHERE user_id = u;
  IF (SELECT specific_focus_revision FROM public.profiles WHERE user_id = u) <> a THEN
    RAISE EXCEPTION 'PROBE_FAIL|C13 authenticated unchanged re-save changed a revision';
  END IF;
END
$c13$;
RESET ROLE;
SELECT 'PROBE_PASS|C13_authenticated_role_update';

-- C14 the AFTER guard fails closed when the assigning trigger is disabled: value changed, revision did not
DO $c14$
DECLARE u uuid := current_setting('probe.user')::uuid; caught text := NULL;
BEGIN
  ALTER TABLE public.profiles DISABLE TRIGGER profiles_zz_revision_assign;
  BEGIN
    UPDATE public.profiles SET specific_focus = 'probe-guard' WHERE user_id = u;
  EXCEPTION WHEN OTHERS THEN
    caught := SQLERRM;
  END;
  ALTER TABLE public.profiles ENABLE TRIGGER profiles_zz_revision_assign;
  IF caught IS NULL OR caught NOT LIKE '%specific_focus changed without a new revision%' THEN
    RAISE EXCEPTION 'PROBE_FAIL|C14 the AFTER guard did not stop the write (got: %)', caught;
  END IF;
END
$c14$;
SELECT 'PROBE_PASS|C14_after_guard_catches_disabled_assign';

-- C15 the AFTER guard also stops the opposite violation: a revision change without a value change
DO $c15$
DECLARE u uuid := current_setting('probe.user')::uuid; caught text := NULL;
BEGIN
  ALTER TABLE public.profiles DISABLE TRIGGER profiles_zz_revision_assign;
  BEGIN
    UPDATE public.profiles SET specific_focus_revision = nextval('public.profiles_field_revision_seq') WHERE user_id = u;
  EXCEPTION WHEN OTHERS THEN
    caught := SQLERRM;
  END;
  ALTER TABLE public.profiles ENABLE TRIGGER profiles_zz_revision_assign;
  IF caught IS NULL OR caught NOT LIKE '%revision changed without a value change%' THEN
    RAISE EXCEPTION 'PROBE_FAIL|C15 the AFTER guard did not stop the write (got: %)', caught;
  END IF;
END
$c15$;
SELECT 'PROBE_PASS|C15_after_guard_catches_revision_without_value_change';

-- C16 the text form the decision core reads (::text): canonical decimal, at most 19 digits
DO $c16$
DECLARE u uuid := current_setting('probe.user')::uuid; r record;
BEGIN
  SELECT specific_focus_revision::text AS f, main_category_revision::text AS c INTO STRICT r FROM public.profiles WHERE user_id = u;
  IF r.f !~ '^(0|[1-9][0-9]{0,18})$' OR r.c !~ '^(0|[1-9][0-9]{0,18})$' THEN
    RAISE EXCEPTION 'PROBE_FAIL|C16 revision text form: % %', r.f, r.c;
  END IF;
END
$c16$;
SELECT 'PROBE_PASS|C16_revision_text_canonical';

SELECT 'PROBE_RESULT|checks=16';

ROLLBACK;
