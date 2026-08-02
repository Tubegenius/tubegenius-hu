-- ============================================================
-- Migration 049: Emerging Signal capture — foundation identity tables
--
-- PFM-2A, 1. resze. Harom, EGYMASTOL FUGGETLEN uj tabla (nincs koztuk FK):
--   signal_runs      — egy feldolgozasi futas audit-egysege
--   signal_entities  — dedup-alapegyseg: egy konkret, normalizalt entitas
--   signal_sources   — egy evidence-termelo tartos azonositoja (domain/csatorna)
--
-- Ez a migracio BRAND NEW tablakat hoz letre (soha korabban nem leteztek
-- sem production-ben, sem migracios lancban) — ezert a 011/014 egyszeru,
-- idempotens CREATE TABLE IF NOT EXISTS mintajat koveti, NEM a 003/044
-- drift-rekonstrukcios mintajat (az csak MAR LETEZO, ismeretlen allapotu
-- tablakhoz kell).
--
-- A 046_harden_default_privileges.sql mar garantalja, hogy egy UJ,
-- postgres-tulajdonu public-semabeli tabla alapertelmezesben SEMMILYEN
-- jogot nem kap PUBLIC/anon/authenticated/service_role szamara — ezert
-- itt NINCS szukseg vedekezo REVOKE-ra, csak explicit, minimalis GRANT-ra
-- a service_role-nak. A vegallapot-validacio expliciten ellenorzi, hogy
-- anon/authenticated tenyleg nulla jogot kapott.
--
-- Grant-matrix (PFM-1D/2A szerint, "bizonyitottan szukseges" elv — nincs
-- blanket ALL, nincs DELETE ebben a korben, mert retention/purge job meg
-- nem resze ennek a korneknek):
--   signal_runs:      INSERT, SELECT, UPDATE
--   signal_entities:  INSERT, SELECT              (immutabilis, nincs UPDATE-elt mezo)
--   signal_sources:   INSERT, SELECT, UPDATE      (last_seen_at touch)
--
-- Retention (PFM-1D javitott dontese): MVP-ben NINCS automatikus hard
-- delete egyik tablan sem ebben a migracioban — ezert biztonsagos, hogy a
-- kesobbi migraciok (050-052) RESTRICT FK-kal hivatkozzanak a signal_runs-ra.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLAK
-- ============================================================

CREATE TABLE IF NOT EXISTS public.signal_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type              TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'started',
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  external_calls_made   INTEGER NOT NULL DEFAULT 0,
  -- Kizarolag nem erzekeny hiba-KATEGORIA (pl. 'db_error','validation_error') —
  -- SOHA nem nyers hibauzenet, stack trace, API-kulcs, prompt vagy raw
  -- request payload. Ez a tabla NEM tartalmaz semmilyen payload-mezot.
  error_class           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT signal_runs_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT signal_runs_run_type_check CHECK (run_type IN ('opportunity_side_effect', 'shadow_batch', 'scheduled_enrichment')),
  CONSTRAINT signal_runs_status_check CHECK (status IN ('started', 'completed', 'failed')),
  CONSTRAINT signal_runs_idempotency_key_not_blank CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT signal_runs_external_calls_nonneg CHECK (external_calls_made >= 0),
  -- completed_at pontosan akkor NULL, ha status='started', kulonben kotelezo
  CONSTRAINT signal_runs_completed_at_matches_status CHECK (
    (status = 'started' AND completed_at IS NULL) OR
    (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  ),
  -- error_class kizarolag failed statusznal lehet kitoltve
  CONSTRAINT signal_runs_error_class_only_when_failed CHECK (
    status = 'failed' OR error_class IS NULL
  )

  -- FONTOS, DB-CHECK-kel NEM vedheto invariansok (dokumentalva, alkalmazas-
  -- kodban/kesobbi RPC-ben vedendo egy jovobeli korben — ez a tabla MOST
  -- csak sema, iro-kod meg nem keszul):
  --   1) Egy CHECK constraint a sor SAJAT allapotat validalja, nem a
  --      valtozas IRANYAT — tehat ez a CHECK nem akadalyozza meg, hogy egy
  --      MAR 'completed' sort UPDATE-tel visszaallitsanak 'started'-re (a
  --      resultumsor onmagaban ervenyes maradna: completed_at NULL-ra
  --      allna egyutt a statusszal). Ezt UGY, hogy a 'completed' allapot
  --      veletlenul se nyithato vissza, csak egy trigger vagy alkalmazas-
  --      szintu RPC (pl. "UPDATE ... WHERE status <> 'completed'") tudja
  --      garantalni — ez jovobeli kor feladata.
  --   2) "A kesobbi writer csak akkor jelolhet completed allapotot, ha a
  --      teljes capture-folyamat sikerult" — ez uzleti logika, nem sema-
  --      szinten kikenyszerítheto tulajdonsag.
  --   3) Az idempotency_key alapjan tortono biztonsagos ujraprobalkozas
  --      (retry) az UNIQUE constraint-re epul (ON CONFLICT a jovobeli iro-
  --      kodban), de az UPSERT konkret logikaja alkalmazas-szintu.
);

CREATE INDEX IF NOT EXISTS idx_signal_runs_status ON public.signal_runs(status);
CREATE INDEX IF NOT EXISTS idx_signal_runs_started ON public.signal_runs(started_at);

CREATE TABLE IF NOT EXISTS public.signal_entities (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name          TEXT NOT NULL,
  normalized_key          TEXT NOT NULL,
  entity_type             TEXT NOT NULL,
  first_seen_by_willviral TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT signal_entities_normalized_key_type_key UNIQUE (normalized_key, entity_type),
  CONSTRAINT signal_entities_type_check CHECK (entity_type IN ('person', 'event', 'product', 'organization', 'phenomenon', 'other')),
  CONSTRAINT signal_entities_canonical_name_not_blank CHECK (btrim(canonical_name) <> ''),
  CONSTRAINT signal_entities_normalized_key_not_blank CHECK (btrim(normalized_key) <> '')
);

CREATE INDEX IF NOT EXISTS idx_signal_entities_normalized_key ON public.signal_entities(normalized_key);

CREATE TABLE IF NOT EXISTS public.signal_sources (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type         TEXT NOT NULL,
  external_id         TEXT NOT NULL,
  display_name        TEXT,
  -- MVP: mindig = external_id (nincs kereszt-domain szindikacio-csoportositas
  -- ebben a korben, ld. PFM-1C/1D dontes). Kulon mezokent tartjuk, hogy egy
  -- kesobbi kor bovithesse anelkul, hogy az external_id jelenteset atirna.
  source_family_key   TEXT NOT NULL,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT signal_sources_type_external_id_key UNIQUE (source_type, external_id),
  CONSTRAINT signal_sources_type_check CHECK (source_type IN ('youtube_channel', 'web_domain')),
  CONSTRAINT signal_sources_external_id_not_blank CHECK (btrim(external_id) <> ''),
  CONSTRAINT signal_sources_family_key_not_blank CHECK (btrim(source_family_key) <> '')
);

CREATE INDEX IF NOT EXISTS idx_signal_sources_family_key ON public.signal_sources(source_family_key);

-- ============================================================
-- 2. RLS — mindharom tablan engedelyezve, NINCS policy (default-deny
--    mindenkinek, aki nem BYPASSRLS — a service_role Supabase-ben az).
-- ============================================================

ALTER TABLE public.signal_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_sources ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. GRANTOK — kizarolag service_role, bizonyitottan szukseges muveletek
-- ============================================================

GRANT INSERT, SELECT, UPDATE ON public.signal_runs TO service_role;
GRANT INSERT, SELECT ON public.signal_entities TO service_role;
GRANT INSERT, SELECT, UPDATE ON public.signal_sources TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- 4. FAIL-FAST VEGALLAPOT-VALIDACIO
-- ============================================================

DO $validate$
DECLARE
  bad_owner_count int;
  bad_rls_count int;
  policy_count int;
  bad_grant_count int;
  forbidden_grant_count int;
  missing_constraint_count int;
BEGIN
  -- 4a. Owner — mindharom tabla postgres-tulajdonu
  SELECT count(*) INTO bad_owner_count
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename IN ('signal_runs', 'signal_entities', 'signal_sources')
    AND tableowner <> 'postgres';
  IF bad_owner_count > 0 THEN
    RAISE EXCEPTION '049 validation failed: % table(s) not owned by postgres', bad_owner_count;
  END IF;

  -- 4b. RLS engedelyezve mindharomon
  SELECT count(*) INTO bad_rls_count
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename IN ('signal_runs', 'signal_entities', 'signal_sources')
    AND rowsecurity IS NOT TRUE;
  IF bad_rls_count > 0 THEN
    RAISE EXCEPTION '049 validation failed: % table(s) do not have RLS enabled', bad_rls_count;
  END IF;

  -- 4c. Nincs egyetlen policy sem (szandekosan)
  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('signal_runs', 'signal_entities', 'signal_sources');
  IF policy_count > 0 THEN
    RAISE EXCEPTION '049 validation failed: unexpected RLS policy exists (expected zero) — found %', policy_count;
  END IF;

  -- 4d. service_role grantok pontosan a vart halmaz
  SELECT count(*) INTO bad_grant_count
  FROM (
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee = 'service_role'
      AND table_name IN ('signal_runs', 'signal_entities', 'signal_sources')
    EXCEPT
    SELECT * FROM (VALUES
      ('signal_runs', 'INSERT'), ('signal_runs', 'SELECT'), ('signal_runs', 'UPDATE'),
      ('signal_entities', 'INSERT'), ('signal_entities', 'SELECT'),
      ('signal_sources', 'INSERT'), ('signal_sources', 'SELECT'), ('signal_sources', 'UPDATE')
    ) AS expected(table_name, privilege_type)
  ) extra
  UNION ALL
  SELECT count(*) FROM (
    SELECT * FROM (VALUES
      ('signal_runs', 'INSERT'), ('signal_runs', 'SELECT'), ('signal_runs', 'UPDATE'),
      ('signal_entities', 'INSERT'), ('signal_entities', 'SELECT'),
      ('signal_sources', 'INSERT'), ('signal_sources', 'SELECT'), ('signal_sources', 'UPDATE')
    ) AS expected(table_name, privilege_type)
    EXCEPT
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee = 'service_role'
      AND table_name IN ('signal_runs', 'signal_entities', 'signal_sources')
  ) missing;

  IF bad_grant_count > 0 THEN
    RAISE EXCEPTION '049 validation failed: service_role grant set does not exactly match the documented minimal matrix (% mismatch rows)', bad_grant_count;
  END IF;

  -- 4e. anon/authenticated NULLA jogot kaptak
  SELECT count(*) INTO forbidden_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
    AND table_name IN ('signal_runs', 'signal_entities', 'signal_sources');
  IF forbidden_grant_count > 0 THEN
    RAISE EXCEPTION '049 validation failed: anon/authenticated has % unexpected grant(s)', forbidden_grant_count;
  END IF;

  -- 4f. Minden nevezett constraint letezik
  SELECT count(*) INTO missing_constraint_count
  FROM (VALUES
    ('signal_runs', 'signal_runs_idempotency_key_key'),
    ('signal_runs', 'signal_runs_run_type_check'),
    ('signal_runs', 'signal_runs_status_check'),
    ('signal_runs', 'signal_runs_completed_at_matches_status'),
    ('signal_runs', 'signal_runs_error_class_only_when_failed'),
    ('signal_entities', 'signal_entities_normalized_key_type_key'),
    ('signal_entities', 'signal_entities_type_check'),
    ('signal_sources', 'signal_sources_type_external_id_key'),
    ('signal_sources', 'signal_sources_type_check')
  ) AS expected(tbl, conname)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = expected.tbl AND c.conname = expected.conname
  );
  IF missing_constraint_count > 0 THEN
    RAISE EXCEPTION '049 validation failed: % expected constraint(s) missing', missing_constraint_count;
  END IF;
END;
$validate$;

COMMIT;
