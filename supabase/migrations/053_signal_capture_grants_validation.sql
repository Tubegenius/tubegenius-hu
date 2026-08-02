-- ============================================================
-- Migration 053: Emerging Signal capture — vegso, teljes grantmatrix
-- validacio
--
-- Ez a migracio KIZAROLAG VALIDACIO — nem hoz letre, nem modosit egyetlen
-- GRANT/REVOKE/RLS/CONSTRAINT allapotot sem. Celja: bizonyitani, hogy a
-- 049-052 EGYUTT pontosan a dokumentalt, minimalis 8-tablas grantmatrixot
-- allitottak elo — sem tobbet (pl. veletlen DELETE/ALL), sem kevesebbet.
-- Ha barmi elter, a migracio fail-fast RAISE EXCEPTION-nel all meg — ez
-- NEM pontolhatja a 049-052-ben esetlegesen elmulasztott beallitast, csak
-- LELEPLEZI, ha volt ilyen mulasztas.
-- ============================================================

BEGIN;

DO $validate$
DECLARE
  expected_tables text[] := ARRAY[
    'signal_runs', 'signal_entities', 'signal_sources', 'signal_clusters',
    'signal_cluster_members', 'signal_evidence', 'signal_observations',
    'signal_run_clusters'
  ];
  table_count int;
  bad_owner_count int;
  bad_rls_count int;
  policy_count int;
  bad_grant_count int;
  forbidden_grant_count int;
  delete_or_all_grant_count int;
BEGIN
  -- 1. Pontosan 8 tabla letezik, a vart nevekkel — sem tobb, sem kevesebb.
  SELECT count(*) INTO table_count
  FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(expected_tables);
  IF table_count <> 8 THEN
    RAISE EXCEPTION '053 validation failed: expected exactly 8 signal_* tables, found %', table_count;
  END IF;

  -- 2. Owner
  SELECT count(*) INTO bad_owner_count
  FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(expected_tables) AND tableowner <> 'postgres';
  IF bad_owner_count > 0 THEN
    RAISE EXCEPTION '053 validation failed: % table(s) not owned by postgres', bad_owner_count;
  END IF;

  -- 3. RLS mind a 8 tablan
  SELECT count(*) INTO bad_rls_count
  FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(expected_tables) AND rowsecurity IS NOT TRUE;
  IF bad_rls_count > 0 THEN
    RAISE EXCEPTION '053 validation failed: % table(s) missing RLS', bad_rls_count;
  END IF;

  -- 4. Nulla policy mindenhol
  SELECT count(*) INTO policy_count
  FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY(expected_tables);
  IF policy_count > 0 THEN
    RAISE EXCEPTION '053 validation failed: expected zero policies across all 8 tables, found %', policy_count;
  END IF;

  -- 5. A TELJES, konszolidalt service_role grantmatrix pontos egyezese
  SELECT count(*) INTO bad_grant_count
  FROM (
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee = 'service_role' AND table_name = ANY(expected_tables)
    EXCEPT
    SELECT * FROM (VALUES
      ('signal_runs', 'INSERT'), ('signal_runs', 'SELECT'), ('signal_runs', 'UPDATE'),
      ('signal_entities', 'INSERT'), ('signal_entities', 'SELECT'),
      ('signal_sources', 'INSERT'), ('signal_sources', 'SELECT'), ('signal_sources', 'UPDATE'),
      ('signal_clusters', 'INSERT'), ('signal_clusters', 'SELECT'), ('signal_clusters', 'UPDATE'),
      ('signal_cluster_members', 'INSERT'), ('signal_cluster_members', 'SELECT'),
      ('signal_evidence', 'INSERT'), ('signal_evidence', 'SELECT'),
      ('signal_observations', 'INSERT'), ('signal_observations', 'SELECT'), ('signal_observations', 'UPDATE'),
      ('signal_run_clusters', 'INSERT'), ('signal_run_clusters', 'SELECT'), ('signal_run_clusters', 'UPDATE')
    ) AS expected(table_name, privilege_type)
  ) extra
  UNION ALL
  SELECT count(*) FROM (
    SELECT * FROM (VALUES
      ('signal_runs', 'INSERT'), ('signal_runs', 'SELECT'), ('signal_runs', 'UPDATE'),
      ('signal_entities', 'INSERT'), ('signal_entities', 'SELECT'),
      ('signal_sources', 'INSERT'), ('signal_sources', 'SELECT'), ('signal_sources', 'UPDATE'),
      ('signal_clusters', 'INSERT'), ('signal_clusters', 'SELECT'), ('signal_clusters', 'UPDATE'),
      ('signal_cluster_members', 'INSERT'), ('signal_cluster_members', 'SELECT'),
      ('signal_evidence', 'INSERT'), ('signal_evidence', 'SELECT'),
      ('signal_observations', 'INSERT'), ('signal_observations', 'SELECT'), ('signal_observations', 'UPDATE'),
      ('signal_run_clusters', 'INSERT'), ('signal_run_clusters', 'SELECT'), ('signal_run_clusters', 'UPDATE')
    ) AS expected(table_name, privilege_type)
    EXCEPT
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee = 'service_role' AND table_name = ANY(expected_tables)
  ) missing;
  IF bad_grant_count > 0 THEN
    RAISE EXCEPTION '053 validation failed: consolidated 8-table service_role grant matrix mismatch (% rows)', bad_grant_count;
  END IF;

  -- 6. Explicit: sehol nincs DELETE grant service_role-nak sem ebben a korben
  SELECT count(*) INTO delete_or_all_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee = 'service_role' AND table_name = ANY(expected_tables)
    AND privilege_type = 'DELETE';
  IF delete_or_all_grant_count > 0 THEN
    RAISE EXCEPTION '053 validation failed: unexpected DELETE grant found on service_role (% tables)', delete_or_all_grant_count;
  END IF;

  -- 7. anon/authenticated NULLA joga van mind a 8 tablan
  SELECT count(*) INTO forbidden_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = ANY(expected_tables) AND grantee IN ('anon', 'authenticated');
  IF forbidden_grant_count > 0 THEN
    RAISE EXCEPTION '053 validation failed: anon/authenticated has % unexpected grant(s) across the 8 tables', forbidden_grant_count;
  END IF;

  RAISE NOTICE '053 validation PASSED: 8/8 signal_* tables — owner, RLS, zero policies, exact minimal service_role grants, zero anon/authenticated grants, zero DELETE grants.';
END;
$validate$;

COMMIT;
