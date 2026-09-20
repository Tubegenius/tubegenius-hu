-- ============================================================
-- 091 -- Starter Credit Contract v1
--
-- PROBLEM. Since 037 (credit buckets) a brand-new user ends up with a
-- user_credits row of balance 0, because:
--   * the AFTER INSERT trigger on auth.users, on_auth_user_created_credits ->
--     handle_new_user_credits(), creates the row (balance DEFAULT 0) at signup, and
--   * the 50-credit starter grant lives ONLY in the "row is missing" branch of
--     GET /api/credits, which the trigger made unreachable.
--
-- CONTRACT (canonical, see lib/starter-credit.ts and
-- docs/operations/starter-credit-contract.md). Every NEWLY created user gets
-- exactly one starter grant, issued through the existing idempotent RPC:
--   apply_bucket_credit_event(NEW.id, 50, 'subscription', 50,
--                             'initial:' || NEW.id, 'initial_credit', '{"plan":"beta"}')
-- i.e. 50 credits in the SUBSCRIPTION bucket, one credit_ledger row
-- (external_ref 'initial:<user_id>', which is UNIQUE), balance 50 =
-- subscription 50 + purchased 0, plan 'beta', monthly_allowance 50 (column
-- default), subscription_status 'free'. GET /api/credits keeps a fallback that
-- uses the SAME external_ref, so the two writers can never double-grant.
--
-- SCOPE / SAFETY.
--   * The only object changed is the body of public.handle_new_user_credits().
--     Its identity, owner, SECURITY DEFINER, search_path and ACL are preserved
--     and re-verified.
--   * NO data is written: no INSERT/UPDATE/DELETE against user_credits,
--     credit_ledger or auth.users. NO backfill. Existing users (including any
--     with a 0 balance) are untouched; the trigger only fires for rows created
--     after this migration.
--   * Fail-fast: the current function definition must equal EITHER the
--     recorded pre-091 definition OR the 091 definition (idempotent re-run);
--     the auth.users trigger set, the RPC identity/ACL/definition, the ledger
--     UNIQUE(external_ref), and the user_credits defaults the contract relies
--     on are all asserted before anything is replaced. Row counts of
--     user_credits / credit_ledger are asserted unchanged afterwards.
--   * Failure semantics: if the grant RPC ever raised, the auth.users INSERT
--     would fail (fail-closed, like the profile trigger) instead of silently
--     creating a 0-credit account.
-- ============================================================

BEGIN;

DO $pre$
DECLARE
  -- md5 of pg_get_functiondef() with CRLF normalised to LF.
  OLD_FN_MD5 CONSTANT text := '16eb95cb127b380595ba309dec739af3';
  NEW_FN_MD5 CONSTANT text := 'c0dfd1b3c3ca00edeed943b0263aabc2';
  ABC_FN_MD5 CONSTANT text := '96426e68955d706872623bda5563fc90';
  fn_oid oid;
  fn_def text;
  fn_md5 text;
  abc_oid oid;
  abc_md5 text;
  abc_acl text;
  trg_names text;
  bad_default text;
BEGIN
  SET LOCAL lock_timeout = '5s';

  fn_oid := to_regprocedure('public.handle_new_user_credits()');
  IF fn_oid IS NULL THEN RAISE EXCEPTION '091 fail-closed: public.handle_new_user_credits() is missing'; END IF;
  fn_def := regexp_replace(pg_get_functiondef(fn_oid), E'\r\n', E'\n', 'g');
  fn_md5 := md5(fn_def);
  IF fn_md5 NOT IN (OLD_FN_MD5, NEW_FN_MD5) THEN
    RAISE EXCEPTION '091 fail-closed: handle_new_user_credits() has an unexpected definition (md5 %)', fn_md5;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = fn_oid AND prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION '091 fail-closed: handle_new_user_credits() must be SECURITY DEFINER with search_path=public, pg_temp';
  END IF;

  -- Exactly the two known signup triggers, both enabled and unchanged.
  SELECT string_agg(t.tgname, ',' ORDER BY t.tgname) INTO trg_names
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'auth' AND c.relname = 'users' AND NOT t.tgisinternal;
  IF trg_names IS DISTINCT FROM 'on_auth_user_created,on_auth_user_created_credits' THEN
    RAISE EXCEPTION '091 fail-closed: unexpected auth.users trigger set: %', coalesce(trg_names, '<none>');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND c.relname = 'users' AND t.tgname = 'on_auth_user_created_credits' AND t.tgenabled = 'O'
      AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER on_auth_user_created_credits AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user_credits()'
  ) THEN
    RAISE EXCEPTION '091 fail-closed: on_auth_user_created_credits is missing, disabled or changed';
  END IF;

  -- The grant goes through the existing idempotent RPC; pin it.
  abc_oid := to_regprocedure('public.apply_bucket_credit_event(uuid,numeric,text,numeric,text,text,jsonb)');
  IF abc_oid IS NULL THEN RAISE EXCEPTION '091 fail-closed: apply_bucket_credit_event is missing'; END IF;
  abc_md5 := md5(regexp_replace(pg_get_functiondef(abc_oid), E'\r\n', E'\n', 'g'));
  IF abc_md5 <> ABC_FN_MD5 THEN
    RAISE EXCEPTION '091 fail-closed: apply_bucket_credit_event has an unexpected definition (md5 %)', abc_md5;
  END IF;
  SELECT coalesce(proacl::text, 'null') INTO abc_acl FROM pg_proc WHERE oid = abc_oid;
  IF abc_acl <> '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION '091 fail-closed: apply_bucket_credit_event ACL drifted: %', abc_acl;
  END IF;

  -- Idempotency anchor: the ledger external_ref UNIQUE constraint.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.credit_ledger'::regclass AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (external_ref)'
  ) THEN
    RAISE EXCEPTION '091 fail-closed: credit_ledger UNIQUE(external_ref) is missing';
  END IF;

  -- user_credits defaults the contract relies on (balance 0 + grant => 50; plan beta; allowance 50).
  SELECT string_agg(column_name || '=' || coalesce(column_default, '<none>'), ', ') INTO bad_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'user_credits'
    AND ((column_name = 'balance' AND column_default IS DISTINCT FROM '0')
      OR (column_name = 'subscription_credit_balance' AND column_default IS DISTINCT FROM '0')
      OR (column_name = 'purchased_credit_balance' AND column_default IS DISTINCT FROM '0')
      OR (column_name = 'plan' AND column_default IS DISTINCT FROM '''beta''::text')
      OR (column_name = 'monthly_allowance' AND column_default IS DISTINCT FROM '50.0'));
  IF bad_default IS NOT NULL THEN
    RAISE EXCEPTION '091 fail-closed: user_credits defaults drifted: %', bad_default;
  END IF;

  -- Snapshot for the post-check (dropped at COMMIT; the IF EXISTS drop keeps a same-transaction re-apply idempotent).
  DROP TABLE IF EXISTS pg_temp.starter_credit_091_before;
  CREATE TEMP TABLE starter_credit_091_before ON COMMIT DROP AS
  SELECT
    (SELECT count(*) FROM public.user_credits) AS user_credits_rows,
    (SELECT count(*) FROM public.credit_ledger) AS ledger_rows,
    (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.user_id), '')) FROM public.user_credits t) AS user_credits_digest,
    p.proowner AS fn_owner, p.prosecdef AS fn_secdef, coalesce(p.proconfig::text, 'null') AS fn_config, coalesce(p.proacl::text, 'null') AS fn_acl
  FROM pg_proc p WHERE p.oid = fn_oid;
END
$pre$;

CREATE OR REPLACE FUNCTION public.handle_new_user_credits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.user_credits (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  -- Canonical starter grant (Starter Credit Contract v1): 50 credits, subscription bucket,
  -- one idempotent ledger event keyed 'initial:<user_id>' (shared with GET /api/credits).
  PERFORM public.apply_bucket_credit_event(
    NEW.id, 50, 'subscription', 50, 'initial:' || NEW.id::text, 'initial_credit',
    jsonb_build_object('plan', 'beta')
  );
  RETURN NEW;
END;
$function$;

DO $post$
DECLARE
  NEW_FN_MD5 CONSTANT text := 'c0dfd1b3c3ca00edeed943b0263aabc2';
  b record;
  a record;
BEGIN
  SELECT * INTO b FROM starter_credit_091_before;
  SELECT p.proowner AS fn_owner, p.prosecdef AS fn_secdef, coalesce(p.proconfig::text, 'null') AS fn_config, coalesce(p.proacl::text, 'null') AS fn_acl,
         md5(regexp_replace(pg_get_functiondef(p.oid), E'\r\n', E'\n', 'g')) AS def_md5
    INTO a FROM pg_proc p WHERE p.oid = to_regprocedure('public.handle_new_user_credits()');

  IF a.def_md5 <> NEW_FN_MD5 THEN RAISE EXCEPTION '091 post-check failed: handle_new_user_credits() md5 % <> %', a.def_md5, NEW_FN_MD5; END IF;
  IF a.fn_owner <> b.fn_owner OR a.fn_secdef IS DISTINCT FROM b.fn_secdef OR a.fn_config <> b.fn_config OR a.fn_acl <> b.fn_acl THEN
    RAISE EXCEPTION '091 post-check failed: handle_new_user_credits() owner/security/config/ACL changed';
  END IF;
  IF (SELECT count(*) FROM public.user_credits) <> b.user_credits_rows
     OR (SELECT count(*) FROM public.credit_ledger) <> b.ledger_rows
     OR (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.user_id), '')) FROM public.user_credits t) <> b.user_credits_digest THEN
    RAISE EXCEPTION '091 post-check failed: migration changed credit data (it must not)';
  END IF;
END
$post$;

COMMIT;
