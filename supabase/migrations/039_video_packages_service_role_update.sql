-- ============================================================
-- Migration 039: video_packages service-role UPDATE grant
--
-- Korábban 031_video_packages_service_update.sql néven létezett — a fájl
-- tévesen kapta a "031" verziószámot (kronológiailag 2026-07-17-én jött
-- létre, jóval a valódi 031_video_idea_tenant_integrity.sql és a 032-037
-- után), ami ütközött a schema_migrations egyediségi kényszerével egy
-- tiszta db reset során. Áthelyezve 039-re, tartalmi cél változatlan.
--
-- The API links a saved package to its canonical video idea after insert.
-- Production had INSERT/DELETE access for service_role, but UPDATE was missing,
-- so the compensating rollback deleted every newly saved package.
--
-- Egyetlen felelősség: a service_role rendelkezzen UPDATE jogosultsággal
-- a public.video_packages táblán. Ez a migráció NEM auditálja és NEM
-- módosítja a service_role egyéb jogosultságait, az anon/authenticated
-- grantjait, sem az RLS-t/policy-kat ezen a táblán — a GRANT UPDATE
-- önmagában idempotens, elég egyszer kiadni.
-- ============================================================

GRANT UPDATE ON TABLE public.video_packages TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_schema = 'public' AND table_name = 'video_packages'
      AND grantee = 'service_role' AND privilege_type = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'service_role UPDATE grant on public.video_packages was not applied';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
