-- ============================================================
-- PFM Public Schema Privilege topology guard (read-only).
--
-- Egyetlen SQL, harom felhasznalas: (1) CI regression job
-- (tests/090-public-schema-privilege-hardening-db-integration.test.ts), (2) a
-- staging es (3) a production postcondition (a sajat interaktiv relay-eden,
-- BEGIN ... ROLLBACK). Kimenet: `VIOLATION|<kind>|<detail>` sorok, majd egy
-- `GUARD_RESULT|violations=<n>` sor. Minden VIOLATION blokkolo.
--
-- Fedezi: uj/meglevo public table, sequence, function tul szeles grantjat;
-- public schemaba telepitett extensiont (a mar telepitett pg_trgm kivetelevel);
-- a PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL felso korlat bovuleset (a szigorodas
-- elfogadott). Csak katalogust olvas: nincs iras, nincs ideiglenes objektum.
-- ============================================================
\pset format unaligned
\pset tuples_only on
\pset footer off
BEGIN;

WITH
pv AS (SELECT ARRAY['SELECT','INS' || 'ERT','UPD' || 'ATE','DEL' || 'ETE','TRUN' || 'CATE','REFERENCES','TRIGGER','MAINTAIN'] AS all_privs),
trgm AS (
  SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e' AND e.extname = 'pg_trgm')
),
v AS (
  -- T1: anon barmilyen tabla-privilegiuma
  SELECT 'VIOLATION|table_anon_privilege|' || c.relname || '|' || a.privilege_type AS line
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND a.grantee = 'anon'::regrole
  UNION ALL
  -- T2: PUBLIC barmilyen tabla-privilegiuma
  SELECT 'VIOLATION|table_public_privilege|' || c.relname || '|' || a.privilege_type
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND a.grantee = 0
  UNION ALL
  -- T3: authenticated / service_role a negy extra jog barmelyikevel
  SELECT 'VIOLATION|table_extra_privilege|' || c.relname || '|' || pg_get_userbyid(a.grantee) || ':' || a.privilege_type
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
    AND a.privilege_type IN ('TRUN' || 'CATE','REFERENCES','TRIGGER','MAINTAIN')
    AND a.grantee <> 0 AND pg_get_userbyid(a.grantee) IN ('authenticated','service_role')
  UNION ALL
  -- T4: effektiv (oroklott) anon/authenticated/service_role extra jog
  SELECT 'VIOLATION|table_effective_extra_privilege|' || c.relname || '|' || roles.rolname || ':' || p.priv
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) roles(rolname)
  CROSS JOIN (SELECT unnest(ARRAY['TRUN' || 'CATE','REFERENCES','TRIGGER','MAINTAIN']) AS priv) p
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(roles.rolname, c.oid, p.priv)
  UNION ALL
  -- T5: RLS kikapcsolva egy public tablan
  SELECT 'VIOLATION|table_rls_disabled|' || c.relname || '|'
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity
  UNION ALL
  -- S1: sequence anon / PUBLIC privilegiuma
  SELECT 'VIOLATION|sequence_broad_privilege|' || c.relname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind = 'S' AND (a.grantee = 0 OR a.grantee = 'anon'::regrole)
  UNION ALL
  -- F1: nem pg_trgm public fuggveny PUBLIC / anon EXECUTE-tel (az implicit PUBLIC default is: proacl IS NULL)
  SELECT 'VIOLATION|function_public_or_anon_execute|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.oid NOT IN (SELECT oid FROM trgm)
    AND (p.proacl IS NULL OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
  UNION ALL
  -- F2: a pg_trgm allowlist merete (31) valtozott
  SELECT 'VIOLATION|pg_trgm_allowlist_size|' || (SELECT count(*) FROM trgm) || ' (expected 31)'
  WHERE (SELECT count(*) FROM trgm) <> 31
  UNION ALL
  -- E1: public schemaba telepitett extension a pg_trgm-en kivul
  SELECT 'VIOLATION|extension_in_public|' || extname
  FROM pg_extension WHERE extnamespace = 'public'::regnamespace AND extname <> 'pg_trgm'
  UNION ALL
  -- E2: nem pg_trgm extension objektuma (fuggvenye) a public schemaban
  SELECT 'VIOLATION|foreign_extension_function_in_public|' || e.extname || ':' || p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
  JOIN pg_extension e ON e.oid = d.refobjid
  WHERE n.nspname = 'public' AND e.extname <> 'pg_trgm'
  UNION ALL
  -- D1: default ACL a public schemaban a rogzitett felso korlat FELETT (PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL)
  SELECT 'VIOLATION|default_acl_public_exceeds_bound|' || t FROM (
    SELECT pg_get_userbyid(d.defaclrole) || '|' || d.defaclobjtype::text || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || '|' || a.privilege_type AS t
    FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace = 'public'::regnamespace
    EXCEPT SELECT jsonb_array_elements_text($guard_dp$["postgres|S|postgres|SELECT","postgres|S|postgres|UPDATE","postgres|S|postgres|USAGE","postgres|f|postgres|EXECUTE","postgres|r|postgres|DELETE","postgres|r|postgres|INSERT","postgres|r|postgres|MAINTAIN","postgres|r|postgres|REFERENCES","postgres|r|postgres|SELECT","postgres|r|postgres|TRIGGER","postgres|r|postgres|TRUNCATE","postgres|r|postgres|UPDATE","supabase_admin|S|anon|SELECT","supabase_admin|S|anon|UPDATE","supabase_admin|S|anon|USAGE","supabase_admin|S|authenticated|SELECT","supabase_admin|S|authenticated|UPDATE","supabase_admin|S|authenticated|USAGE","supabase_admin|S|postgres|SELECT","supabase_admin|S|postgres|UPDATE","supabase_admin|S|postgres|USAGE","supabase_admin|S|service_role|SELECT","supabase_admin|S|service_role|UPDATE","supabase_admin|S|service_role|USAGE","supabase_admin|f|anon|EXECUTE","supabase_admin|f|authenticated|EXECUTE","supabase_admin|f|postgres|EXECUTE","supabase_admin|f|service_role|EXECUTE","supabase_admin|r|anon|DELETE","supabase_admin|r|anon|INSERT","supabase_admin|r|anon|MAINTAIN","supabase_admin|r|anon|REFERENCES","supabase_admin|r|anon|SELECT","supabase_admin|r|anon|TRIGGER","supabase_admin|r|anon|TRUNCATE","supabase_admin|r|anon|UPDATE","supabase_admin|r|authenticated|DELETE","supabase_admin|r|authenticated|INSERT","supabase_admin|r|authenticated|MAINTAIN","supabase_admin|r|authenticated|REFERENCES","supabase_admin|r|authenticated|SELECT","supabase_admin|r|authenticated|TRIGGER","supabase_admin|r|authenticated|TRUNCATE","supabase_admin|r|authenticated|UPDATE","supabase_admin|r|postgres|DELETE","supabase_admin|r|postgres|INSERT","supabase_admin|r|postgres|MAINTAIN","supabase_admin|r|postgres|REFERENCES","supabase_admin|r|postgres|SELECT","supabase_admin|r|postgres|TRIGGER","supabase_admin|r|postgres|TRUNCATE","supabase_admin|r|postgres|UPDATE","supabase_admin|r|service_role|DELETE","supabase_admin|r|service_role|INSERT","supabase_admin|r|service_role|MAINTAIN","supabase_admin|r|service_role|REFERENCES","supabase_admin|r|service_role|SELECT","supabase_admin|r|service_role|TRIGGER","supabase_admin|r|service_role|TRUNCATE","supabase_admin|r|service_role|UPDATE"]$guard_dp$::jsonb)) s1
  UNION ALL
  -- D2: globalis default ACL a felso korlat FELETT
  SELECT 'VIOLATION|default_acl_global_exceeds_bound|' || t FROM (
    SELECT pg_get_userbyid(d.defaclrole) || '|' || d.defaclobjtype::text || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || '|' || a.privilege_type AS t
    FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace = 0
    EXCEPT SELECT jsonb_array_elements_text($guard_dg$["postgres|f|postgres|EXECUTE"]$guard_dg$::jsonb)) s2
)
SELECT line FROM (
  SELECT 1 AS k, line FROM v
  UNION ALL
  SELECT 2, 'GUARD_RESULT|violations=' || (SELECT count(*) FROM v) ||
       '|public_tables=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) ||
       '|public_functions=' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
) z ORDER BY k, line;

ROLLBACK;
