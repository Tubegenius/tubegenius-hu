-- ============================================================
-- Migration 043: Enable RLS on tables that were missing it locally
--
-- A P0/1H teljes production <-> clean rebuild reconciliation audit
-- (2026-07-23) 2 tablat talalt, ahol production RLS_ENABLED=true, de a
-- lokalis rebuild (027/037 migraciok) sosem kapcsolta be:
--   in_flight_requests                    (027-es migracio)
--   credit_bucket_migration_backup_037    (037-es migracio)
--
-- Ok (kulon 043-preflight korben igazolva): productionben egy
-- "ensure_rls" nevu event trigger (rls_auto_enable() fuggveny, tulaj:
-- postgres, ddl_command_end a CREATE TABLE/CREATE TABLE AS/SELECT INTO
-- parancsokra) automatikusan bekapcsolja az RLS-t minden uj tablan —
-- ez sosem lett migralva, ezert minden migracio, ami maga nem irja ki
-- explicit az ENABLE ROW LEVEL SECURITY-t, helyben RLS nelkuli tablat
-- hoz letre.
--
-- Hatokor: KIZAROLAG a fenti 2 tabla RLS bekapcsolasa. Nincs uj policy
-- (egyik tablan sincs policy productionben sem — ez kulon igazolva a
-- preflight korben), nincs grant-valtozas, nincs bemasolt
-- rls_auto_enable/ensure_rls (az esemenytrigger sajat, kulon hardening
-- es kompatibilitasi audit utan kerul verziokovetesbe, nem itt). Mas
-- migraciot vagy alkalmazaskodot nem erint.
--
-- Biztonsagos: mindket tabla kizarolag service_role-on (vagy egyaltalan
-- nem) keresztul el a futasidejū kodban, a service_role pedig
-- bypassrls=true attributummal rendelkezik (platform-szintu, nem
-- migracio-fuggo) — az RLS bekapcsolasa a jelenlegi mukodest nem
-- erinti, csak az eddig nyitva maradt anon/authenticated sor-szintu
-- kitettseget zarja le.
--
-- Idempotens: az ALTER TABLE ... ENABLE ROW LEVEL SECURITY mar
-- termeszeteben idempotens (ujra futtatva no-op, PostgreSQL nem dob
-- hibat, ha mar be van kapcsolva).
-- ============================================================

BEGIN;

ALTER TABLE public.in_flight_requests
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.credit_bucket_migration_backup_037
  ENABLE ROW LEVEL SECURITY;

COMMIT;
