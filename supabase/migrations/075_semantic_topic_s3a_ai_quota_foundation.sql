-- ============================================================
-- Migration 075: Semantic Topic Identity v0 -- S3A AI quota & control foundation
--
-- Kanonikus döntési kör: "PFM Semantic Topic Identity v0 -- S3A AI Quota &
-- Shadow Extraction Foundation -- Local Implementation Gate", korrigálva a
-- "PFM Semantic Topic S3A -- Final Quota Failure-State & Cost-Reconciliation
-- Correction Gate" által. Ez a migráció (még commit előtt, tehát in-place
-- javítva, nem külön 076-ként) a signal_provider_* (058-066) YouTube
-- collector kvótarendszertől teljesen elkülönített AI-provider kvóta/vezérlő
-- alrendszert hozza létre.
--
-- HATÓKÖR: három tábla (ai_extraction_control, ai_provider_daily_budgets,
-- ai_provider_budget_reservations) + HÉT SECURITY DEFINER RPC. Nincs
-- AI-hívás, nincs cron, nincs új route, nincs ALTER a 001-074 migrációkon.
--
-- Pinnelt v0 döntések: provider='anthropic', usage_type='semantic_topic_extraction',
-- model='claude-sonnet-4-6', limit=10 request/UTC nap ÉS 1 000 000 micro-USD
-- ($1.000000)/UTC nap, ár $3/$15 per millió token (Sonnet), mindig ceil()+NUMERIC/BIGINT.
--
-- ============================================================
-- KORREKCIÓS GATE -- három blokkoló rés, javítva:
-- ============================================================
--
-- (1) GLOBÁLIS, quota-date-független attempt-limit. A korábbi verzió a
-- topic_extraction_runs 'failed' sorait számolta -- ez hiányos volt, mert
-- committed_unknown (timeout/bizonytalan kimenet) esetén SOSEM keletkezik
-- topic_extraction_runs sor. Az új számlálás magát az
-- ai_provider_budget_reservations táblát nézi, GLOBÁLISAN (nincs quota_date
-- szűrés): minden olyan sor beleszámít, aminek attempt_started_at KI VAN
-- TÖLTVE és application_outcome NEM 'completed' (tehát reserved+started,
-- committed+failed, committed_unknown mind beleszámít; egy sikeres,
-- completed kimenetű sor nem, de arra úgyis blokkol a külön completed-cache
-- őrzés). Ehhez a reservations tábla két új oszlopot kapott:
-- extraction_run_id (FK -> topic_extraction_runs, RESTRICT) és
-- application_outcome ('completed'|'failed'), amiket egy ÚJ RPC,
-- finalize_ai_provider_reservation_outcome köt össze a már meglévő 074
-- record_topic_extraction_run eredményével. A verseny ellen egy
-- pg_advisory_xact_lock szerializálja a (evidence, normalized_input_digest,
-- extraction_config_digest, provider, model) kulcsú konkurens reserve-eket,
-- MIELŐTT a számlálás vagy a beszúrás megtörténne.
--
-- (2) Actual-cost overage sosem veszhet el. A korábbi verzió RAISE
-- EXCEPTIONt dobott, ha az actual cost > estimated cost -- ez visszagörgette
-- volna a teljes auditbejegyzést, pont akkor, amikor a valós providerköltség
-- a legfontosabb lenne rögzíteni. Az új commit_ai_provider_units SOHA nem
-- dob kivételt emiatt: a tényleges (akár a becslést meghaladó) actual_micro_usd
-- mindig tartósan rögzül, a daily budget committed_micro_usd mezője a VALÓS
-- költséggel nő (ehhez az ai_provider_daily_budgets_micro_usd_within_limit
-- CHECK-et el kellett távolítani -- a napi $1 sapka ezután KIZÁRÓLAG a
-- reserve-oldali, pre-call atomikus UPDATE...WHERE-en keresztül érvényesül,
-- ami egy már bekövetkezett valós költséget nem tud és nem is szabad hogy
-- visszamenőleg tagadjon). Egy cap_breach BOOLEAN oszlop és a visszaadott
-- JSONB 'cap_breach' mezője jelzi kontrolláltan a túllépést, és UGYANABBAN a
-- tranzakcióban az ai_extraction_control.enabled automatikusan false-ra vált.
--
-- (3) Konzervatív pre-call reservation. A TypeScript-oldali becslés mostantól
-- a teljes UTF-8 kérés byte-hosszából indul ki (bizonyítható felső korlát
-- minden byte-szintű BPE tokenizálóra, mint amilyet Claude is használ -- egy
-- token sosem fedhet le kevesebb, mint 1 byte-ot), +15% dokumentált
-- biztonsági tartalékkal, és egy rögzített max input byte-méret felett
-- providerhívás előtt fail-closed elutasít (lásd lib/semantic-topic/extraction-config.ts).
-- A szerveroldali RPC továbbra sem fogad el semmilyen ár/költség paramétert
-- a hívótól -- csak tokenszámot, amiből a pinnelt egységáron maga számolja
-- a micro-USD-t.
--
-- (4) Stale reservation reconciliation -- ÚJ, önálló, auditálható RPC
-- (reconcile_stale_ai_provider_reservations), a 061 expire_stale_provider_reservations
-- mintájára: single-flight try-lock, FOR UPDATE SKIP LOCKED, idempotens.
-- Régi, el nem indult (attempt_started_at IS NULL) foglalás -> released.
-- Régi, elindult, de sosem lezárt foglalás -> committed_unknown (a teljes
-- becsült összeg végérvényesen elkönyvelve, error_class='stale_reconciled').
-- Az extraction-service.ts orchestrator ezt minden valódi futás ELSŐ
-- lépéseként meghívja, hogy sose maradjon rejtett, nyitva felejtett foglalás.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. GLOBÁLIS TÁBLA-TOPOLÓGIAI KAPU (3 új tábla)
-- ============================================================

DO $table_topology_gate$
DECLARE
  v_present_count int;
BEGIN
  SELECT count(*) INTO v_present_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('ai_extraction_control', 'ai_provider_daily_budgets', 'ai_provider_budget_reservations');

  IF v_present_count NOT IN (0, 3) THEN
    RAISE EXCEPTION '075 fail-closed: partial table topology detected -- % of 3 S3A tables exist. No DDL will run.', v_present_count;
  END IF;

  RAISE NOTICE '075: global table topology gate passed (% of 3 present).', v_present_count;
END;
$table_topology_gate$;

-- ============================================================
-- 1. ai_extraction_control -- egysoros kill switch (062 mintája)
-- ============================================================

DO $migrate_control$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ai_extraction_control')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '075: ai_extraction_control does not exist -- CREATE branch.';

    CREATE TABLE public.ai_extraction_control (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      enabled     BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT ai_extraction_control_single_row CHECK (id = 1)
    );

    INSERT INTO public.ai_extraction_control (id, enabled) VALUES (1, false);

    ALTER TABLE public.ai_extraction_control ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.ai_extraction_control FORCE ROW LEVEL SECURITY;

    GRANT SELECT, UPDATE ON public.ai_extraction_control TO service_role;

    RAISE NOTICE '075: ai_extraction_control created with the single required row (id=1, enabled=false).';
  ELSE
    RAISE NOTICE '075: ai_extraction_control already exists -- VALIDATE branch (no DDL/DCL, no row mutation will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ai_extraction_control' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '075 drift: ai_extraction_control owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'integer', 'int4', 'NO', '1'),
        ('enabled', 'boolean', 'bool', 'NO', 'false'),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('updated_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_extraction_control'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '075 drift: ai_extraction_control column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('ai_extraction_control_pkey', 'p', 'PRIMARY KEY (id)'),
        ('ai_extraction_control_single_row', 'c', 'CHECK (id = 1)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.ai_extraction_control'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '075 drift: ai_extraction_control constraint set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.ai_extraction_control WHERE id = 1) THEN
      RAISE EXCEPTION '075 drift: ai_extraction_control is missing its single required row (id=1)';
    END IF;
    IF (SELECT count(*) FROM public.ai_extraction_control) <> 1 THEN
      RAISE EXCEPTION '075 drift: ai_extraction_control has more than one row';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'ai_extraction_control'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '075 drift: ai_extraction_control RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_extraction_control') THEN
      RAISE EXCEPTION '075 drift: ai_extraction_control has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'ai_extraction_control' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT'), ('UPDATE')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT'), ('UPDATE')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'ai_extraction_control' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '075 drift: ai_extraction_control service_role grant set is not exactly SELECT+UPDATE';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'ai_extraction_control' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '075 drift: ai_extraction_control has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '075: ai_extraction_control already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_control$;

-- ============================================================
-- 2. ai_provider_daily_budgets
-- ============================================================

DO $migrate_budgets$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ai_provider_daily_budgets')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '075: ai_provider_daily_budgets does not exist -- CREATE branch.';

    CREATE TABLE public.ai_provider_daily_budgets (
      id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider                  TEXT NOT NULL,
      usage_type                TEXT NOT NULL,
      model                     TEXT NOT NULL,
      quota_date                DATE NOT NULL,
      limit_requests            INTEGER NOT NULL,
      limit_micro_usd           BIGINT NOT NULL,
      reserved_requests         INTEGER NOT NULL DEFAULT 0,
      committed_requests        INTEGER NOT NULL DEFAULT 0,
      released_requests_total   INTEGER NOT NULL DEFAULT 0,
      reserved_micro_usd        BIGINT NOT NULL DEFAULT 0,
      committed_micro_usd       BIGINT NOT NULL DEFAULT 0,
      released_micro_usd_total  BIGINT NOT NULL DEFAULT 0,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT ai_provider_daily_budgets_key UNIQUE (provider, usage_type, model, quota_date),
      CONSTRAINT ai_provider_daily_budgets_provider_check CHECK (provider IN ('anthropic')),
      CONSTRAINT ai_provider_daily_budgets_usage_type_check CHECK (usage_type IN ('semantic_topic_extraction')),
      CONSTRAINT ai_provider_daily_budgets_model_check CHECK (model IN ('claude-sonnet-4-6')),
      CONSTRAINT ai_provider_daily_budgets_limit_requests_positive CHECK (limit_requests > 0),
      CONSTRAINT ai_provider_daily_budgets_limit_micro_usd_positive CHECK (limit_micro_usd > 0),
      CONSTRAINT ai_provider_daily_budgets_reserved_requests_nonneg CHECK (reserved_requests >= 0),
      CONSTRAINT ai_provider_daily_budgets_committed_requests_nonneg CHECK (committed_requests >= 0),
      CONSTRAINT ai_provider_daily_budgets_released_requests_nonneg CHECK (released_requests_total >= 0),
      CONSTRAINT ai_provider_daily_budgets_reserved_micro_usd_nonneg CHECK (reserved_micro_usd >= 0),
      CONSTRAINT ai_provider_daily_budgets_committed_micro_usd_nonneg CHECK (committed_micro_usd >= 0),
      CONSTRAINT ai_provider_daily_budgets_released_micro_usd_nonneg CHECK (released_micro_usd_total >= 0),
      CONSTRAINT ai_provider_daily_budgets_requests_within_limit CHECK (reserved_requests + committed_requests <= limit_requests)
      -- Deliberately NO check coupling committed_micro_usd (or reserved+committed)
      -- to limit_micro_usd: the $1 cap is a PRE-CALL reservation gate only
      -- (enforced by reserve_ai_provider_units' own atomic UPDATE...WHERE).
      -- Once a real provider cost is known (commit_ai_provider_units), it is
      -- recorded exactly as it happened, even if it exceeds the cap that was
      -- reserved against -- a CHECK here would instead throw and roll back
      -- the one place a real, already-incurred cost must never be lost. See
      -- migration header (2).
    );

    ALTER TABLE public.ai_provider_daily_budgets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.ai_provider_daily_budgets FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.ai_provider_daily_budgets TO service_role;

    RAISE NOTICE '075: ai_provider_daily_budgets created.';
  ELSE
    RAISE NOTICE '075: ai_provider_daily_budgets already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ai_provider_daily_budgets' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_daily_budgets owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('provider', 'text', 'text', 'NO', NULL),
        ('usage_type', 'text', 'text', 'NO', NULL),
        ('model', 'text', 'text', 'NO', NULL),
        ('quota_date', 'date', 'date', 'NO', NULL),
        ('limit_requests', 'integer', 'int4', 'NO', NULL),
        ('limit_micro_usd', 'bigint', 'int8', 'NO', NULL),
        ('reserved_requests', 'integer', 'int4', 'NO', '0'),
        ('committed_requests', 'integer', 'int4', 'NO', '0'),
        ('released_requests_total', 'integer', 'int4', 'NO', '0'),
        ('reserved_micro_usd', 'bigint', 'int8', 'NO', '0'),
        ('committed_micro_usd', 'bigint', 'int8', 'NO', '0'),
        ('released_micro_usd_total', 'bigint', 'int8', 'NO', '0'),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('updated_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()')
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_provider_daily_budgets'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_daily_budgets column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('ai_provider_daily_budgets_committed_micro_usd_nonneg', 'c', 'CHECK (committed_micro_usd >= 0)'),
        ('ai_provider_daily_budgets_committed_requests_nonneg', 'c', 'CHECK (committed_requests >= 0)'),
        ('ai_provider_daily_budgets_key', 'u', 'UNIQUE (provider, usage_type, model, quota_date)'),
        ('ai_provider_daily_budgets_limit_micro_usd_positive', 'c', 'CHECK (limit_micro_usd > 0)'),
        ('ai_provider_daily_budgets_limit_requests_positive', 'c', 'CHECK (limit_requests > 0)'),
        ('ai_provider_daily_budgets_model_check', 'c', 'CHECK (model = ''claude-sonnet-4-6''::text)'),
        ('ai_provider_daily_budgets_pkey', 'p', 'PRIMARY KEY (id)'),
        ('ai_provider_daily_budgets_provider_check', 'c', 'CHECK (provider = ''anthropic''::text)'),
        ('ai_provider_daily_budgets_released_micro_usd_nonneg', 'c', 'CHECK (released_micro_usd_total >= 0)'),
        ('ai_provider_daily_budgets_released_requests_nonneg', 'c', 'CHECK (released_requests_total >= 0)'),
        ('ai_provider_daily_budgets_reserved_micro_usd_nonneg', 'c', 'CHECK (reserved_micro_usd >= 0)'),
        ('ai_provider_daily_budgets_reserved_requests_nonneg', 'c', 'CHECK (reserved_requests >= 0)'),
        ('ai_provider_daily_budgets_requests_within_limit', 'c', 'CHECK ((reserved_requests + committed_requests) <= limit_requests)'),
        ('ai_provider_daily_budgets_usage_type_check', 'c', 'CHECK (usage_type = ''semantic_topic_extraction''::text)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.ai_provider_daily_budgets'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_daily_budgets constraint set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('ai_provider_daily_budgets_key', 'true', 'CREATE UNIQUE INDEX ai_provider_daily_budgets_key ON public.ai_provider_daily_budgets USING btree (provider, usage_type, model, quota_date)'),
        ('ai_provider_daily_budgets_pkey', 'true', 'CREATE UNIQUE INDEX ai_provider_daily_budgets_pkey ON public.ai_provider_daily_budgets USING btree (id)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.ai_provider_daily_budgets'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_daily_budgets index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'ai_provider_daily_budgets'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_daily_budgets RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_provider_daily_budgets') THEN
      RAISE EXCEPTION '075 drift: ai_provider_daily_budgets has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'ai_provider_daily_budgets' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'ai_provider_daily_budgets' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_daily_budgets service_role grant set is not exactly SELECT';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'ai_provider_daily_budgets' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_daily_budgets has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '075: ai_provider_daily_budgets already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_budgets$;

-- ============================================================
-- 3. ai_provider_budget_reservations
-- ============================================================

DO $migrate_reservations$
DECLARE
  v_table_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ai_provider_budget_reservations')
    INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE NOTICE '075: ai_provider_budget_reservations does not exist -- CREATE branch.';

    CREATE TABLE public.ai_provider_budget_reservations (
      id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      daily_budget_id           UUID NOT NULL REFERENCES public.ai_provider_daily_budgets(id) ON DELETE RESTRICT,
      signal_evidence_id        UUID NOT NULL REFERENCES public.signal_evidence(id) ON DELETE RESTRICT,
      normalized_input_digest   TEXT NOT NULL,
      extraction_config_digest  TEXT NOT NULL,
      attempt_ordinal           INTEGER NOT NULL,
      idempotency_key           TEXT NOT NULL,
      estimated_micro_usd       BIGINT NOT NULL,
      actual_input_tokens       INTEGER,
      actual_output_tokens      INTEGER,
      actual_micro_usd          BIGINT,
      cap_breach                BOOLEAN NOT NULL DEFAULT false,
      extraction_run_id         UUID REFERENCES public.topic_extraction_runs(id) ON DELETE RESTRICT,
      application_outcome       TEXT,
      status                    TEXT NOT NULL DEFAULT 'reserved',
      error_class               TEXT,
      attempt_started_at        TIMESTAMPTZ,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      committed_at              TIMESTAMPTZ,
      released_at               TIMESTAMPTZ,

      CONSTRAINT ai_provider_budget_reservations_key UNIQUE (daily_budget_id, idempotency_key),
      CONSTRAINT ai_provider_budget_reservations_status_check CHECK (status IN ('reserved', 'committed', 'committed_unknown', 'released')),
      CONSTRAINT ai_provider_budget_reservations_estimated_positive CHECK (estimated_micro_usd > 0),
      CONSTRAINT ai_provider_budget_reservations_attempt_ordinal_positive CHECK (attempt_ordinal >= 1),
      CONSTRAINT ai_provider_budget_reservations_normalized_digest_format CHECK (normalized_input_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ai_provider_budget_reservations_config_digest_format CHECK (extraction_config_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ai_provider_budget_reservations_idempotency_not_blank CHECK (btrim(idempotency_key) <> ''),
      CONSTRAINT ai_provider_budget_reservations_error_class_bounded CHECK (error_class IS NULL OR length(error_class) <= 100),
      -- error_class: committed_unknown eseten (provider-oldali bizonytalansag),
      -- VAGY egy committed+failed soron, amikor a application_finalize_missing
      -- reconciliation-ag futott (lasd (17) korrekcios gate 2. pontja) --
      -- ez utobbi a hivo alkalmazas sosem kuldott finalize-ot es sosem
      -- keletkezett hozza extraction_run.
      CONSTRAINT ai_provider_budget_reservations_error_class_only_when_unknown CHECK (
        error_class IS NULL OR status = 'committed_unknown' OR
        (status = 'committed' AND application_outcome = 'failed' AND extraction_run_id IS NULL)
      ),
      CONSTRAINT ai_provider_budget_reservations_application_outcome_check CHECK (application_outcome IS NULL OR application_outcome IN ('completed', 'failed')),
      -- application_outcome csak 'committed' soron allhat. 'completed'
      -- kimenetnek MINDIG kell egy valos extraction_run_id (csak egy tenyleges
      -- completed sor alapjan johet letre). 'failed' ket uton johet letre:
      -- (a) finalize_ai_provider_reservation_outcome egy valos failed
      -- extraction_run-hoz kotve (extraction_run_id NOT NULL), VAGY (b) a
      -- reconciliation application_finalize_missing aga, amikor a hivo
      -- alkalmazas osszeomlott, MIELOTT barmilyen extraction_run keletkezett
      -- volna -- ott nincs mihez kotni, extraction_run_id marad NULL.
      CONSTRAINT ai_provider_budget_reservations_outcome_link_consistency CHECK (
        (application_outcome IS NULL AND extraction_run_id IS NULL) OR
        (application_outcome = 'completed' AND extraction_run_id IS NOT NULL AND status = 'committed') OR
        (application_outcome = 'failed' AND status = 'committed')
      ),
      CONSTRAINT ai_provider_budget_reservations_actual_matches_status CHECK (
        (status = 'reserved' AND actual_micro_usd IS NULL AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL) OR
        (status = 'committed' AND actual_micro_usd IS NOT NULL AND actual_input_tokens IS NOT NULL AND actual_output_tokens IS NOT NULL) OR
        (status = 'committed_unknown' AND actual_micro_usd = estimated_micro_usd AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL) OR
        (status = 'released' AND actual_micro_usd IS NULL AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL)
      ),
      -- Deliberately NO "actual <= estimated" check -- a korrekciós gate (2)
      -- pontja szerint egy valós túllépést sosem szabad elutasítani; a
      -- cap_breach oszlop és a commit_ai_provider_units visszatérési értéke
      -- jelzi kontrolláltan, ha actual_micro_usd > estimated_micro_usd.
      CONSTRAINT ai_provider_budget_reservations_committed_at_matches_status CHECK (
        (status IN ('committed', 'committed_unknown') AND committed_at IS NOT NULL) OR
        (status NOT IN ('committed', 'committed_unknown') AND committed_at IS NULL)
      ),
      CONSTRAINT ai_provider_budget_reservations_released_at_matches_status CHECK (
        (status = 'released' AND released_at IS NOT NULL) OR (status <> 'released' AND released_at IS NULL)
      ),
      CONSTRAINT ai_provider_budget_reservations_unknown_requires_attempt CHECK (
        status <> 'committed_unknown' OR attempt_started_at IS NOT NULL
      )
    );

    CREATE INDEX idx_ai_provider_budget_reservations_evidence_digest
      ON public.ai_provider_budget_reservations(signal_evidence_id, normalized_input_digest, extraction_config_digest);
    CREATE INDEX idx_ai_provider_budget_reservations_stale_reserved
      ON public.ai_provider_budget_reservations(status, attempt_started_at, created_at) WHERE status = 'reserved';

    ALTER TABLE public.ai_provider_budget_reservations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.ai_provider_budget_reservations FORCE ROW LEVEL SECURITY;

    GRANT SELECT ON public.ai_provider_budget_reservations TO service_role;

    RAISE NOTICE '075: ai_provider_budget_reservations created.';
  ELSE
    RAISE NOTICE '075: ai_provider_budget_reservations already exists -- VALIDATE branch (no DDL/DCL will run).';

    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ai_provider_budget_reservations' AND tableowner = 'postgres'
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_budget_reservations owner is not postgres';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
        ('daily_budget_id', 'uuid', 'uuid', 'NO', NULL),
        ('signal_evidence_id', 'uuid', 'uuid', 'NO', NULL),
        ('normalized_input_digest', 'text', 'text', 'NO', NULL),
        ('extraction_config_digest', 'text', 'text', 'NO', NULL),
        ('attempt_ordinal', 'integer', 'int4', 'NO', NULL),
        ('idempotency_key', 'text', 'text', 'NO', NULL),
        ('estimated_micro_usd', 'bigint', 'int8', 'NO', NULL),
        ('actual_input_tokens', 'integer', 'int4', 'YES', NULL),
        ('actual_output_tokens', 'integer', 'int4', 'YES', NULL),
        ('actual_micro_usd', 'bigint', 'int8', 'YES', NULL),
        ('cap_breach', 'boolean', 'bool', 'NO', 'false'),
        ('extraction_run_id', 'uuid', 'uuid', 'YES', NULL),
        ('application_outcome', 'text', 'text', 'YES', NULL),
        ('status', 'text', 'text', 'NO', '''reserved''::text'),
        ('error_class', 'text', 'text', 'YES', NULL),
        ('attempt_started_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('created_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'),
        ('committed_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL),
        ('released_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL)
      ) AS expected(column_name, data_type, udt_name, is_nullable, column_default)
      FULL JOIN (
        SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_provider_budget_reservations'
      ) actual ON actual.column_name = expected.column_name
      WHERE expected.column_name IS NULL OR actual.column_name IS NULL
         OR actual.data_type IS DISTINCT FROM expected.data_type
         OR actual.udt_name IS DISTINCT FROM expected.udt_name
         OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
         OR actual.column_default IS DISTINCT FROM expected.column_default
         OR actual.is_identity IS DISTINCT FROM 'NO'
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_budget_reservations column set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('ai_provider_budget_reservations_actual_matches_status', 'c', 'CHECK (status = ''reserved''::text AND actual_micro_usd IS NULL AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL OR status = ''committed''::text AND actual_micro_usd IS NOT NULL AND actual_input_tokens IS NOT NULL AND actual_output_tokens IS NOT NULL OR status = ''committed_unknown''::text AND actual_micro_usd = estimated_micro_usd AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL OR status = ''released''::text AND actual_micro_usd IS NULL AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL)'),
        ('ai_provider_budget_reservations_application_outcome_check', 'c', 'CHECK (application_outcome IS NULL OR (application_outcome = ANY (ARRAY[''completed''::text, ''failed''::text])))'),
        ('ai_provider_budget_reservations_attempt_ordinal_positive', 'c', 'CHECK (attempt_ordinal >= 1)'),
        ('ai_provider_budget_reservations_committed_at_matches_status', 'c', 'CHECK ((status = ANY (ARRAY[''committed''::text, ''committed_unknown''::text])) AND committed_at IS NOT NULL OR (status <> ALL (ARRAY[''committed''::text, ''committed_unknown''::text])) AND committed_at IS NULL)'),
        ('ai_provider_budget_reservations_config_digest_format', 'c', 'CHECK (extraction_config_digest ~ ''^[0-9a-f]{64}$''::text)'),
        ('ai_provider_budget_reservations_daily_budget_id_fkey', 'f', 'FOREIGN KEY (daily_budget_id) REFERENCES ai_provider_daily_budgets(id) ON DELETE RESTRICT'),
        ('ai_provider_budget_reservations_error_class_bounded', 'c', 'CHECK (error_class IS NULL OR length(error_class) <= 100)'),
        ('ai_provider_budget_reservations_error_class_only_when_unknown', 'c', 'CHECK (error_class IS NULL OR status = ''committed_unknown''::text OR status = ''committed''::text AND application_outcome = ''failed''::text AND extraction_run_id IS NULL)'),
        ('ai_provider_budget_reservations_estimated_positive', 'c', 'CHECK (estimated_micro_usd > 0)'),
        ('ai_provider_budget_reservations_extraction_run_id_fkey', 'f', 'FOREIGN KEY (extraction_run_id) REFERENCES topic_extraction_runs(id) ON DELETE RESTRICT'),
        ('ai_provider_budget_reservations_idempotency_not_blank', 'c', 'CHECK (btrim(idempotency_key) <> ''''::text)'),
        ('ai_provider_budget_reservations_key', 'u', 'UNIQUE (daily_budget_id, idempotency_key)'),
        ('ai_provider_budget_reservations_normalized_digest_format', 'c', 'CHECK (normalized_input_digest ~ ''^[0-9a-f]{64}$''::text)'),
        ('ai_provider_budget_reservations_outcome_link_consistency', 'c', 'CHECK (application_outcome IS NULL AND extraction_run_id IS NULL OR application_outcome = ''completed''::text AND extraction_run_id IS NOT NULL AND status = ''committed''::text OR application_outcome = ''failed''::text AND status = ''committed''::text)'),
        ('ai_provider_budget_reservations_pkey', 'p', 'PRIMARY KEY (id)'),
        ('ai_provider_budget_reservations_released_at_matches_status', 'c', 'CHECK (status = ''released''::text AND released_at IS NOT NULL OR status <> ''released''::text AND released_at IS NULL)'),
        ('ai_provider_budget_reservations_signal_evidence_id_fkey', 'f', 'FOREIGN KEY (signal_evidence_id) REFERENCES signal_evidence(id) ON DELETE RESTRICT'),
        ('ai_provider_budget_reservations_status_check', 'c', 'CHECK (status = ANY (ARRAY[''reserved''::text, ''committed''::text, ''committed_unknown''::text, ''released''::text]))'),
        ('ai_provider_budget_reservations_unknown_requires_attempt', 'c', 'CHECK (status <> ''committed_unknown''::text OR attempt_started_at IS NOT NULL)')
      ) AS expected(conname, contype, def)
      FULL JOIN (
        SELECT conname, contype::text, pg_get_constraintdef(oid, true) AS def, convalidated, condeferrable, condeferred
        FROM pg_constraint WHERE conrelid = 'public.ai_provider_budget_reservations'::regclass
      ) actual ON actual.conname = expected.conname
      WHERE expected.conname IS NULL OR actual.conname IS NULL
         OR actual.contype IS DISTINCT FROM expected.contype
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.convalidated IS DISTINCT FROM true
         OR actual.condeferrable IS DISTINCT FROM false
         OR actual.condeferred IS DISTINCT FROM false
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_budget_reservations constraint set/definition does not match exactly';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('ai_provider_budget_reservations_key', 'true', 'CREATE UNIQUE INDEX ai_provider_budget_reservations_key ON public.ai_provider_budget_reservations USING btree (daily_budget_id, idempotency_key)'),
        ('ai_provider_budget_reservations_pkey', 'true', 'CREATE UNIQUE INDEX ai_provider_budget_reservations_pkey ON public.ai_provider_budget_reservations USING btree (id)'),
        ('idx_ai_provider_budget_reservations_evidence_digest', 'false', 'CREATE INDEX idx_ai_provider_budget_reservations_evidence_digest ON public.ai_provider_budget_reservations USING btree (signal_evidence_id, normalized_input_digest, extraction_config_digest)'),
        ('idx_ai_provider_budget_reservations_stale_reserved', 'false', 'CREATE INDEX idx_ai_provider_budget_reservations_stale_reserved ON public.ai_provider_budget_reservations USING btree (status, attempt_started_at, created_at) WHERE (status = ''reserved''::text)')
      ) AS expected(indexname, is_unique, def)
      FULL JOIN (
        SELECT c.relname AS indexname, ix.indisunique::text AS is_unique, pg_get_indexdef(ix.indexrelid) AS def,
               ix.indisvalid, ix.indisready
        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
        WHERE ix.indrelid = 'public.ai_provider_budget_reservations'::regclass
      ) actual ON actual.indexname = expected.indexname
      WHERE expected.indexname IS NULL OR actual.indexname IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.def IS DISTINCT FROM expected.def
         OR actual.indisvalid IS DISTINCT FROM true
         OR actual.indisready IS DISTINCT FROM true
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_budget_reservations index set/definition does not match exactly';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'ai_provider_budget_reservations'
        AND cl.relrowsecurity IS TRUE AND cl.relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_budget_reservations RLS is not exactly enabled+forced';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_provider_budget_reservations') THEN
      RAISE EXCEPTION '075 drift: ai_provider_budget_reservations has an unexpected policy';
    END IF;

    IF EXISTS (
      (SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'ai_provider_budget_reservations' AND grantee = 'service_role'
       EXCEPT SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type))
      UNION ALL
      (SELECT * FROM (VALUES ('SELECT')) AS expected(privilege_type)
       EXCEPT SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'ai_provider_budget_reservations' AND grantee = 'service_role')
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_budget_reservations service_role grant set is not exactly SELECT';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'ai_provider_budget_reservations' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) THEN
      RAISE EXCEPTION '075 drift: ai_provider_budget_reservations has a forbidden anon/authenticated/PUBLIC grant';
    END IF;

    RAISE NOTICE '075: ai_provider_budget_reservations already exists and matches exactly -- no-op.';
  END IF;
END;
$migrate_reservations$;

-- ============================================================
-- 4. GLOBÁLIS FÜGGVÉNY-TOPOLÓGIAI KAPU (7 új RPC)
-- ============================================================

DO $fn_topology_gate$
DECLARE
  v_present_count int;
BEGIN
  SELECT count(*) INTO v_present_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN (
    'reserve_ai_provider_units', 'mark_ai_provider_attempt_started', 'commit_ai_provider_units',
    'mark_ai_provider_outcome_unknown', 'release_ai_provider_units',
    'finalize_ai_provider_reservation_outcome', 'reconcile_stale_ai_provider_reservations'
  );

  IF v_present_count NOT IN (0, 7) THEN
    RAISE EXCEPTION '075 fail-closed: partial function topology detected -- % of 7 S3A RPCs exist. No DDL will run.', v_present_count;
  END IF;

  RAISE NOTICE '075: global function topology gate passed (% of 7 present).', v_present_count;
END;
$fn_topology_gate$;

-- ============================================================
-- 5. RPC: reserve_ai_provider_units
-- ============================================================

DO $migrate_reserve$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '7782026c482e5ba6fd4f7a5a01a3d8aa';
  v_expected_args CONSTANT text := 'p_provider text, p_usage_type text, p_model text, p_signal_evidence_id uuid, p_normalization_version integer, p_extraction_schema_version integer, p_prompt_version text, p_normalized_extraction_input text, p_estimated_input_tokens integer, p_estimated_max_output_tokens integer, p_idempotency_key text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reserve_ai_provider_units';

  IF v_name_count = 0 THEN
    RAISE NOTICE '075: reserve_ai_provider_units does not exist -- CREATE branch.';

    CREATE FUNCTION public.reserve_ai_provider_units(
      p_provider TEXT,
      p_usage_type TEXT,
      p_model TEXT,
      p_signal_evidence_id UUID,
      p_normalization_version INTEGER,
      p_extraction_schema_version INTEGER,
      p_prompt_version TEXT,
      p_normalized_extraction_input TEXT,
      p_estimated_input_tokens INTEGER,
      p_estimated_max_output_tokens INTEGER,
      p_idempotency_key TEXT
    ) RETURNS UUID
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  -- Szerver-oldalon pinnelt v0 limitek és egységár -- a hívó SOHA nem
  -- adhat meg saját limitet vagy költséget.
  v_limit_requests CONSTANT INTEGER := 10;
  v_limit_micro_usd CONSTANT BIGINT := 1000000;
  v_price_input_per_million CONSTANT NUMERIC := 3.00;
  v_price_output_per_million CONSTANT NUMERIC := 15.00;
  v_max_attempts CONSTANT INTEGER := 3;
  v_quota_date DATE;
  v_daily_budget_id UUID;
  v_reservation_id UUID;
  v_enabled BOOLEAN;
  v_normalized_input_digest TEXT;
  v_extraction_config_text TEXT;
  v_extraction_config_digest TEXT;
  v_prior_attempts INTEGER;
  v_attempt_ordinal INTEGER;
  v_estimated_micro_usd BIGINT;
  v_attempt_lock_key BIGINT;
BEGIN
  IF p_provider IS DISTINCT FROM 'anthropic' THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: unsupported provider %', p_provider USING ERRCODE = 'P0001';
  END IF;
  IF p_usage_type IS DISTINCT FROM 'semantic_topic_extraction' THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: unsupported usage_type %', p_usage_type USING ERRCODE = 'P0001';
  END IF;
  IF p_model IS DISTINCT FROM 'claude-sonnet-4-6' THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: unsupported model %', p_model USING ERRCODE = 'P0001';
  END IF;
  IF p_signal_evidence_id IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: signal_evidence_id required' USING ERRCODE = 'P0001';
  END IF;
  IF p_normalization_version IS NULL OR p_normalization_version < 1 THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: normalization_version must be >= 1' USING ERRCODE = 'P0001';
  END IF;
  IF p_extraction_schema_version IS NULL OR p_extraction_schema_version < 1 THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: extraction_schema_version must be >= 1' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(btrim(p_prompt_version), '') IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: prompt_version required' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(p_normalized_extraction_input, '') IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: normalized_extraction_input required' USING ERRCODE = 'P0001';
  END IF;
  IF p_estimated_input_tokens IS NULL OR p_estimated_input_tokens <= 0 THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: estimated_input_tokens must be positive' USING ERRCODE = 'P0001';
  END IF;
  IF p_estimated_max_output_tokens IS NULL OR p_estimated_max_output_tokens <= 0 THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: estimated_max_output_tokens must be positive' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: idempotency_key required' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.signal_evidence WHERE id = p_signal_evidence_id) THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: signal_evidence % not found', p_signal_evidence_id USING ERRCODE = 'P0001';
  END IF;

  SELECT enabled INTO v_enabled FROM public.ai_extraction_control WHERE id = 1;
  IF v_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: AI extraction is currently disabled' USING ERRCODE = 'P0001';
  END IF;

  v_normalized_input_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(p_normalized_extraction_input, 'UTF8')), 'hex');

  v_extraction_config_text := format(
    '{"extraction_method":%s,"normalization_version":%s,"extraction_schema_version":%s,"provider":%s,"model":%s,"prompt_version":%s,"deterministic_extractor_version":%s}',
    to_json('ai_assisted'::text)::text,
    coalesce(to_json(p_normalization_version)::text, 'null'),
    coalesce(to_json(p_extraction_schema_version)::text, 'null'),
    to_json(p_provider)::text,
    to_json(p_model)::text,
    coalesce(to_json(p_prompt_version)::text, 'null'),
    'null'
  );
  v_extraction_config_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(v_extraction_config_text, 'UTF8')), 'hex');

  -- Korrekciós gate (1): a teljes (evidence, normalized_input_digest,
  -- extraction_config_digest, provider, model) kulcsra szerializál -- ez
  -- garantálja, hogy két konkurens hívás sose olvashassa mindkettő ugyanazt
  -- a "2 of 3" allapotot es ne indíthassanak mindketten egy 3./4. attemptet.
  v_attempt_lock_key := hashtextextended(
    p_signal_evidence_id::text || chr(31) || v_normalized_input_digest || chr(31) || v_extraction_config_digest || chr(31) || p_provider || chr(31) || p_model,
    0
  );
  PERFORM pg_advisory_xact_lock(v_attempt_lock_key);

  v_quota_date := (timezone('UTC', statement_timestamp()))::date;

  INSERT INTO public.ai_provider_daily_budgets
    (provider, usage_type, model, quota_date, limit_requests, limit_micro_usd)
  VALUES (p_provider, p_usage_type, p_model, v_quota_date, v_limit_requests, v_limit_micro_usd)
  ON CONFLICT (provider, usage_type, model, quota_date) DO NOTHING;

  SELECT id INTO v_daily_budget_id
  FROM public.ai_provider_daily_budgets
  WHERE provider = p_provider AND usage_type = p_usage_type AND model = p_model AND quota_date = v_quota_date;

  -- Idempotens replay -- ha már létezik foglalás erre a kulcsra, azt adjuk
  -- vissza, új foglalás, új kvóta-növekmény és attempt-számlálás nélkül.
  SELECT id INTO v_reservation_id
  FROM public.ai_provider_budget_reservations
  WHERE daily_budget_id = v_daily_budget_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_reservation_id;
  END IF;

  -- Defense-in-depth: egy már completed extraction ugyanerre a hármasra
  -- SOHA nem hívható újra (a 074 saját partial unique indexe, SS15, is
  -- garantálja ezt a topic_extraction_runs táblán).
  IF EXISTS (
    SELECT 1 FROM public.topic_extraction_runs
    WHERE signal_evidence_id = p_signal_evidence_id
      AND normalized_input_digest = v_normalized_input_digest
      AND extraction_config_digest = v_extraction_config_digest
      AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: a completed extraction already exists for this input/config digest -- use the cached result, do not re-reserve' USING ERRCODE = 'P0001';
  END IF;

  -- Korrekciós gate (1): GLOBÁLIS, quota-date-független attempt-számlálás,
  -- magát az ai_provider_budget_reservations táblát nézve (nem a
  -- topic_extraction_runs 'failed' sorait, ami hiányos lenne
  -- committed_unknown esetén). Minden sor beleszámít, aminek
  -- attempt_started_at ki van töltve ÉS application_outcome nem 'completed'
  -- -- a fenti advisory lock garantálja, hogy ez a SELECT és a lenti INSERT
  -- egyetlen konkurens versenytárs által se kerülhető meg ugyanerre a kulcsra.
  SELECT count(*) INTO v_prior_attempts
  FROM public.ai_provider_budget_reservations r
  JOIN public.ai_provider_daily_budgets b ON b.id = r.daily_budget_id
  WHERE r.signal_evidence_id = p_signal_evidence_id
    AND r.normalized_input_digest = v_normalized_input_digest
    AND r.extraction_config_digest = v_extraction_config_digest
    AND b.provider = p_provider AND b.model = p_model
    AND r.attempt_started_at IS NOT NULL
    AND r.application_outcome IS DISTINCT FROM 'completed';
  IF v_prior_attempts >= v_max_attempts THEN
    RAISE EXCEPTION 'reserve_ai_provider_units: attempt limit (%) reached for this input/config digest', v_max_attempts USING ERRCODE = 'P0001';
  END IF;
  v_attempt_ordinal := v_prior_attempts + 1;

  v_estimated_micro_usd := ceil(
    p_estimated_input_tokens::numeric * v_price_input_per_million
    + p_estimated_max_output_tokens::numeric * v_price_output_per_million
  )::bigint;

  -- Atomikus, guarded foglalás -- mindkét erőforrás-dimenzió (kérésszám ÉS
  -- dollárkeret) egyszerre ellenőrződik ugyanabban a WHERE zárádékban. A
  -- $1 sapka itt KIZÁRÓLAG pre-call kapu (korrekciós gate (2)) -- ha egy
  -- korábbi commit már túllépte a napi committed_micro_usd-t, ez a
  -- feltétel többé sose teljesül, tehát minden újabb foglalás itt
  -- automatikusan elutasul, DB CHECK vagy kivétel nélkül.
  UPDATE public.ai_provider_daily_budgets
  SET reserved_requests = reserved_requests + 1,
      reserved_micro_usd = reserved_micro_usd + v_estimated_micro_usd,
      updated_at = now()
  WHERE id = v_daily_budget_id
    AND limit_requests - reserved_requests - committed_requests >= 1
    AND limit_micro_usd - reserved_micro_usd - committed_micro_usd >= v_estimated_micro_usd;

  IF NOT FOUND THEN
    RETURN NULL; -- kimerült napi kvóta (kérés vagy dollárkeret) -- nincs hívás
  END IF;

  BEGIN
    INSERT INTO public.ai_provider_budget_reservations (
      daily_budget_id, signal_evidence_id, normalized_input_digest, extraction_config_digest,
      attempt_ordinal, idempotency_key, estimated_micro_usd, status
    ) VALUES (
      v_daily_budget_id, p_signal_evidence_id, v_normalized_input_digest, v_extraction_config_digest,
      v_attempt_ordinal, p_idempotency_key, v_estimated_micro_usd, 'reserved'
    )
    RETURNING id INTO v_reservation_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.ai_provider_daily_budgets
    SET reserved_requests = reserved_requests - 1,
        reserved_micro_usd = reserved_micro_usd - v_estimated_micro_usd,
        updated_at = now()
    WHERE id = v_daily_budget_id;

    SELECT id INTO v_reservation_id
    FROM public.ai_provider_budget_reservations
    WHERE daily_budget_id = v_daily_budget_id AND idempotency_key = p_idempotency_key;
    RETURN v_reservation_id;
  END;

  RETURN v_reservation_id;
END;

$body$;

    REVOKE ALL ON FUNCTION public.reserve_ai_provider_units(
      TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TEXT
    ) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.reserve_ai_provider_units(
      TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TEXT
    ) TO service_role;

    RAISE NOTICE '075: reserve_ai_provider_units created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '075: reserve_ai_provider_units already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'reserve_ai_provider_units';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'uuid'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '075 drift: reserve_ai_provider_units structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '075 drift: reserve_ai_provider_units body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '075 drift: reserve_ai_provider_units ACL does not match exactly';
    END IF;

    RAISE NOTICE '075: reserve_ai_provider_units already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '075 fail-closed: reserve_ai_provider_units has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_reserve$;

-- ============================================================
-- 6. RPC: mark_ai_provider_attempt_started
-- ============================================================

DO $migrate_mark_started$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '27f8326eb24641a149e72ac9748e0e1d';
  v_expected_args CONSTANT text := 'p_reservation_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mark_ai_provider_attempt_started';

  IF v_name_count = 0 THEN
    RAISE NOTICE '075: mark_ai_provider_attempt_started does not exist -- CREATE branch.';

    CREATE FUNCTION public.mark_ai_provider_attempt_started(
      p_reservation_id UUID
    ) RETURNS BOOLEAN
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_row_count INTEGER;
BEGIN
  UPDATE public.ai_provider_budget_reservations
  SET attempt_started_at = COALESCE(attempt_started_at, now())
  WHERE id = p_reservation_id AND status = 'reserved';

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RETURN v_row_count > 0;
END;

$body$;

    REVOKE ALL ON FUNCTION public.mark_ai_provider_attempt_started(UUID) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.mark_ai_provider_attempt_started(UUID) TO service_role;

    RAISE NOTICE '075: mark_ai_provider_attempt_started created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '075: mark_ai_provider_attempt_started already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'mark_ai_provider_attempt_started';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'boolean'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '075 drift: mark_ai_provider_attempt_started structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '075 drift: mark_ai_provider_attempt_started body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '075 drift: mark_ai_provider_attempt_started ACL does not match exactly';
    END IF;

    RAISE NOTICE '075: mark_ai_provider_attempt_started already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '075 fail-closed: mark_ai_provider_attempt_started has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_mark_started$;

-- ============================================================
-- 7. RPC: commit_ai_provider_units (korrigálva: sosem dob kivételt
--    overage miatt, ld. korrekciós gate (2))
-- ============================================================

DO $migrate_commit$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '1bfb1df62ceb15624583fedebd99f705';
  v_expected_args CONSTANT text := 'p_reservation_id uuid, p_actual_input_tokens integer, p_actual_output_tokens integer';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'commit_ai_provider_units';

  IF v_name_count = 0 THEN
    RAISE NOTICE '075: commit_ai_provider_units does not exist -- CREATE branch.';

    CREATE FUNCTION public.commit_ai_provider_units(
      p_reservation_id UUID,
      p_actual_input_tokens INTEGER,
      p_actual_output_tokens INTEGER
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_price_input_per_million CONSTANT NUMERIC := 3.00;
  v_price_output_per_million CONSTANT NUMERIC := 15.00;
  v_res public.ai_provider_budget_reservations%ROWTYPE;
  v_actual_micro_usd BIGINT;
  v_cap_breach BOOLEAN;
BEGIN
  SELECT * INTO v_res FROM public.ai_provider_budget_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commit_ai_provider_units: reservation % not found', p_reservation_id USING ERRCODE = 'P0001';
  END IF;

  IF v_res.status IN ('committed', 'committed_unknown') THEN
    -- Dupla commit -- stabil replay, NEM könyvel másodszor.
    RETURN jsonb_build_object(
      'reservation_id', v_res.id, 'status', v_res.status, 'actual_micro_usd', v_res.actual_micro_usd,
      'duplicate', true, 'cap_breach', v_res.cap_breach
    );
  END IF;

  IF v_res.status <> 'reserved' THEN
    RAISE EXCEPTION 'commit_ai_provider_units: reservation % is not reserved (status=%)', p_reservation_id, v_res.status USING ERRCODE = 'P0001';
  END IF;
  IF v_res.attempt_started_at IS NULL THEN
    RAISE EXCEPTION 'commit_ai_provider_units: reservation % has no attempt_started_at', p_reservation_id USING ERRCODE = 'P0001';
  END IF;
  IF p_actual_input_tokens IS NULL OR p_actual_input_tokens < 0 THEN
    RAISE EXCEPTION 'commit_ai_provider_units: actual_input_tokens must be non-negative' USING ERRCODE = 'P0001';
  END IF;
  IF p_actual_output_tokens IS NULL OR p_actual_output_tokens < 0 THEN
    RAISE EXCEPTION 'commit_ai_provider_units: actual_output_tokens must be non-negative' USING ERRCODE = 'P0001';
  END IF;

  v_actual_micro_usd := ceil(
    p_actual_input_tokens::numeric * v_price_input_per_million
    + p_actual_output_tokens::numeric * v_price_output_per_million
  )::bigint;
  v_cap_breach := v_actual_micro_usd > v_res.estimated_micro_usd;

  -- Korrekciós gate (2): SOHA nem dob kivételt emiatt -- a valós, akár a
  -- becslést meghaladó költség mindig tartósan rögzül. A daily budget
  -- committed_micro_usd mezője a VALÓS összeggel nő, nem a becsléssel; a
  -- tábla saját CHECK-je (lásd 2. blokk) szándékosan nem köti ezt a
  -- limithez, úgy, hogy ez az UPDATE sose bukjon el emiatt.
  UPDATE public.ai_provider_budget_reservations
  SET status = 'committed', actual_input_tokens = p_actual_input_tokens, actual_output_tokens = p_actual_output_tokens,
      actual_micro_usd = v_actual_micro_usd, cap_breach = v_cap_breach, committed_at = now()
  WHERE id = p_reservation_id AND status = 'reserved';

  UPDATE public.ai_provider_daily_budgets
  SET reserved_requests = reserved_requests - 1,
      committed_requests = committed_requests + 1,
      reserved_micro_usd = reserved_micro_usd - v_res.estimated_micro_usd,
      committed_micro_usd = committed_micro_usd + v_actual_micro_usd,
      updated_at = now()
  WHERE id = v_res.daily_budget_id;

  IF v_cap_breach THEN
    -- Egy már bekövetkezett, a becslést meghaladó valós költség azonnal
    -- letiltja a további AI-extractiont -- ugyanabban a tranzakcióban,
    -- amelyben a valós költség rögzül, nem egy külön, elveszíthető lépésben.
    UPDATE public.ai_extraction_control SET enabled = false, updated_at = now() WHERE id = 1;
  END IF;

  RETURN jsonb_build_object(
    'reservation_id', p_reservation_id, 'status', 'committed', 'actual_micro_usd', v_actual_micro_usd,
    'duplicate', false, 'cap_breach', v_cap_breach
  );
END;

$body$;

    REVOKE ALL ON FUNCTION public.commit_ai_provider_units(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.commit_ai_provider_units(UUID, INTEGER, INTEGER) TO service_role;

    RAISE NOTICE '075: commit_ai_provider_units created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '075: commit_ai_provider_units already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'commit_ai_provider_units';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '075 drift: commit_ai_provider_units structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '075 drift: commit_ai_provider_units body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '075 drift: commit_ai_provider_units ACL does not match exactly';
    END IF;

    RAISE NOTICE '075: commit_ai_provider_units already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '075 fail-closed: commit_ai_provider_units has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_commit$;

-- ============================================================
-- 8. RPC: mark_ai_provider_outcome_unknown
-- ============================================================

DO $migrate_mark_unknown$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '186d3f26bef951e79aff077f87e293ce';
  v_expected_args CONSTANT text := 'p_reservation_id uuid, p_error_class text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mark_ai_provider_outcome_unknown';

  IF v_name_count = 0 THEN
    RAISE NOTICE '075: mark_ai_provider_outcome_unknown does not exist -- CREATE branch.';

    CREATE FUNCTION public.mark_ai_provider_outcome_unknown(
      p_reservation_id UUID,
      p_error_class TEXT DEFAULT NULL
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_res public.ai_provider_budget_reservations%ROWTYPE;
  v_error_class TEXT;
BEGIN
  IF p_error_class IS NOT NULL AND length(p_error_class) > 100 THEN
    RAISE EXCEPTION 'mark_ai_provider_outcome_unknown: error_class must be a short classifier (<=100 chars), never a raw message or prompt content' USING ERRCODE = 'P0001';
  END IF;
  v_error_class := NULLIF(btrim(p_error_class), '');

  SELECT * INTO v_res FROM public.ai_provider_budget_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_ai_provider_outcome_unknown: reservation % not found', p_reservation_id USING ERRCODE = 'P0001';
  END IF;

  IF v_res.status = 'committed_unknown' THEN
    RETURN jsonb_build_object('reservation_id', v_res.id, 'status', v_res.status, 'duplicate', true);
  END IF;
  IF v_res.status <> 'reserved' THEN
    RAISE EXCEPTION 'mark_ai_provider_outcome_unknown: reservation % is not reserved (status=%)', p_reservation_id, v_res.status USING ERRCODE = 'P0001';
  END IF;
  IF v_res.attempt_started_at IS NULL THEN
    RAISE EXCEPTION 'mark_ai_provider_outcome_unknown: cannot mark unknown before attempt started' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.ai_provider_budget_reservations
  SET status = 'committed_unknown', actual_micro_usd = estimated_micro_usd, error_class = v_error_class, committed_at = now()
  WHERE id = p_reservation_id AND status = 'reserved';

  UPDATE public.ai_provider_daily_budgets
  SET reserved_requests = reserved_requests - 1,
      committed_requests = committed_requests + 1,
      reserved_micro_usd = reserved_micro_usd - v_res.estimated_micro_usd,
      committed_micro_usd = committed_micro_usd + v_res.estimated_micro_usd,
      updated_at = now()
  WHERE id = v_res.daily_budget_id;

  RETURN jsonb_build_object('reservation_id', p_reservation_id, 'status', 'committed_unknown', 'duplicate', false);
END;

$body$;

    REVOKE ALL ON FUNCTION public.mark_ai_provider_outcome_unknown(UUID, TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.mark_ai_provider_outcome_unknown(UUID, TEXT) TO service_role;

    RAISE NOTICE '075: mark_ai_provider_outcome_unknown created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '075: mark_ai_provider_outcome_unknown already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'mark_ai_provider_outcome_unknown';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '075 drift: mark_ai_provider_outcome_unknown structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '075 drift: mark_ai_provider_outcome_unknown body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '075 drift: mark_ai_provider_outcome_unknown ACL does not match exactly';
    END IF;

    RAISE NOTICE '075: mark_ai_provider_outcome_unknown already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '075 fail-closed: mark_ai_provider_outcome_unknown has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_mark_unknown$;

-- ============================================================
-- 9. RPC: release_ai_provider_units
-- ============================================================

DO $migrate_release$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '22b2b563668e71248731a707e6d6f12a';
  v_expected_args CONSTANT text := 'p_reservation_id uuid';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'release_ai_provider_units';

  IF v_name_count = 0 THEN
    RAISE NOTICE '075: release_ai_provider_units does not exist -- CREATE branch.';

    CREATE FUNCTION public.release_ai_provider_units(
      p_reservation_id UUID
    ) RETURNS BOOLEAN
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_res public.ai_provider_budget_reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_res FROM public.ai_provider_budget_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_res.status = 'released' THEN
    RETURN true; -- idempotens replay
  END IF;
  IF v_res.status <> 'reserved' THEN
    RAISE EXCEPTION 'release_ai_provider_units: reservation % is not releasable (status=%)', p_reservation_id, v_res.status USING ERRCODE = 'P0001';
  END IF;
  IF v_res.attempt_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'release_ai_provider_units: cannot voluntarily release a reservation whose attempt already started' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.ai_provider_budget_reservations
  SET status = 'released', released_at = now()
  WHERE id = p_reservation_id AND status = 'reserved';

  UPDATE public.ai_provider_daily_budgets
  SET reserved_requests = reserved_requests - 1,
      reserved_micro_usd = reserved_micro_usd - v_res.estimated_micro_usd,
      released_requests_total = released_requests_total + 1,
      released_micro_usd_total = released_micro_usd_total + v_res.estimated_micro_usd,
      updated_at = now()
  WHERE id = v_res.daily_budget_id;

  RETURN true;
END;

$body$;

    REVOKE ALL ON FUNCTION public.release_ai_provider_units(UUID) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.release_ai_provider_units(UUID) TO service_role;

    RAISE NOTICE '075: release_ai_provider_units created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '075: release_ai_provider_units already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'release_ai_provider_units';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'boolean'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '075 drift: release_ai_provider_units structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '075 drift: release_ai_provider_units body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '075 drift: release_ai_provider_units ACL does not match exactly';
    END IF;

    RAISE NOTICE '075: release_ai_provider_units already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '075 fail-closed: release_ai_provider_units has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_release$;

-- ============================================================
-- 10. RPC: finalize_ai_provider_reservation_outcome (ÚJ, korrekciós gate (1))
-- ============================================================

DO $migrate_finalize$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := 'f61c4c5791e578e4ed8f45816fc618b9';
  v_expected_args CONSTANT text := 'p_reservation_id uuid, p_extraction_run_id uuid, p_application_outcome text';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'finalize_ai_provider_reservation_outcome';

  IF v_name_count = 0 THEN
    RAISE NOTICE '075: finalize_ai_provider_reservation_outcome does not exist -- CREATE branch.';

    CREATE FUNCTION public.finalize_ai_provider_reservation_outcome(
      p_reservation_id UUID,
      p_extraction_run_id UUID,
      p_application_outcome TEXT
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_res public.ai_provider_budget_reservations%ROWTYPE;
  v_run RECORD;
BEGIN
  IF p_application_outcome NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'finalize_ai_provider_reservation_outcome: p_application_outcome must be completed or failed (got %)', p_application_outcome USING ERRCODE = 'P0001';
  END IF;
  IF p_extraction_run_id IS NULL THEN
    RAISE EXCEPTION 'finalize_ai_provider_reservation_outcome: extraction_run_id required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_res FROM public.ai_provider_budget_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_ai_provider_reservation_outcome: reservation % not found', p_reservation_id USING ERRCODE = 'P0001';
  END IF;

  IF v_res.application_outcome IS NOT NULL THEN
    IF v_res.application_outcome = p_application_outcome AND v_res.extraction_run_id = p_extraction_run_id THEN
      RETURN jsonb_build_object('reservation_id', v_res.id, 'application_outcome', v_res.application_outcome, 'extraction_run_id', v_res.extraction_run_id, 'duplicate', true);
    END IF;
    RAISE EXCEPTION 'finalize_ai_provider_reservation_outcome: reservation % already finalized with different parameters', p_reservation_id USING ERRCODE = 'P0001';
  END IF;

  IF v_res.status <> 'committed' THEN
    RAISE EXCEPTION 'finalize_ai_provider_reservation_outcome: reservation % is not committed (status=%)', p_reservation_id, v_res.status USING ERRCODE = 'P0001';
  END IF;

  -- Re-read the extraction run -- never trust the caller's claim about its
  -- status/evidence without verifying against the authoritative 074 row.
  SELECT * INTO v_run FROM public.topic_extraction_runs WHERE id = p_extraction_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_ai_provider_reservation_outcome: extraction_run % not found', p_extraction_run_id USING ERRCODE = 'P0001';
  END IF;
  IF v_run.signal_evidence_id <> v_res.signal_evidence_id THEN
    RAISE EXCEPTION 'finalize_ai_provider_reservation_outcome: extraction_run % belongs to a different evidence than reservation %', p_extraction_run_id, p_reservation_id USING ERRCODE = 'P0001';
  END IF;
  IF v_run.status <> p_application_outcome THEN
    RAISE EXCEPTION 'finalize_ai_provider_reservation_outcome: extraction_run % status (%) does not match p_application_outcome (%)', p_extraction_run_id, v_run.status, p_application_outcome USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.ai_provider_budget_reservations
  SET application_outcome = p_application_outcome, extraction_run_id = p_extraction_run_id
  WHERE id = p_reservation_id AND status = 'committed';

  RETURN jsonb_build_object('reservation_id', p_reservation_id, 'application_outcome', p_application_outcome, 'extraction_run_id', p_extraction_run_id, 'duplicate', false);
END;

$body$;

    REVOKE ALL ON FUNCTION public.finalize_ai_provider_reservation_outcome(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.finalize_ai_provider_reservation_outcome(UUID, UUID, TEXT) TO service_role;

    RAISE NOTICE '075: finalize_ai_provider_reservation_outcome created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '075: finalize_ai_provider_reservation_outcome already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'finalize_ai_provider_reservation_outcome';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '075 drift: finalize_ai_provider_reservation_outcome structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '075 drift: finalize_ai_provider_reservation_outcome body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '075 drift: finalize_ai_provider_reservation_outcome ACL does not match exactly';
    END IF;

    RAISE NOTICE '075: finalize_ai_provider_reservation_outcome already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '075 fail-closed: finalize_ai_provider_reservation_outcome has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_finalize$;

-- ============================================================
-- 11. RPC: reconcile_stale_ai_provider_reservations (ÚJ, korrekciós gate (4))
-- ============================================================

DO $migrate_reconcile$
DECLARE
  v_name_count int;
  v_oid oid;
  v_prosrc text;
  v_hash text;
  v_expected_hash CONSTANT text := '4729a222a07039de3ea94a7141cc0775';
  v_expected_args CONSTANT text := 'p_unstarted_stale_after_seconds integer, p_started_stale_after_seconds integer, p_committed_unfinalized_stale_after_seconds integer';
BEGIN
  SELECT count(*) INTO v_name_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reconcile_stale_ai_provider_reservations';

  IF v_name_count = 0 THEN
    RAISE NOTICE '075: reconcile_stale_ai_provider_reservations does not exist -- CREATE branch.';

    CREATE FUNCTION public.reconcile_stale_ai_provider_reservations(
      p_unstarted_stale_after_seconds INTEGER DEFAULT 600,
      p_started_stale_after_seconds INTEGER DEFAULT 300,
      p_committed_unfinalized_stale_after_seconds INTEGER DEFAULT 600
    ) RETURNS JSONB
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $body$
DECLARE
  v_lock_key CONSTANT BIGINT := hashtextextended('ai_provider_reservation_reconcile_sweep', 0);
  v_got_lock BOOLEAN;
  v_row RECORD;
  v_key_lock BIGINT;
  v_released_count INTEGER := 0;
  v_unknown_count INTEGER := 0;
  v_finalized_from_run_count INTEGER := 0;
  v_finalized_missing_count INTEGER := 0;
  v_ambiguous_count INTEGER := 0;
  v_match_count INTEGER;
  v_matched_run_id UUID;
  v_matched_run_status TEXT;
BEGIN
  IF p_unstarted_stale_after_seconds IS NULL OR p_unstarted_stale_after_seconds <= 0 OR p_unstarted_stale_after_seconds > 86400 THEN
    RAISE EXCEPTION 'reconcile_stale_ai_provider_reservations: unstarted_stale_after_seconds must be between 1 and 86400' USING ERRCODE = 'P0001';
  END IF;
  IF p_started_stale_after_seconds IS NULL OR p_started_stale_after_seconds <= 0 OR p_started_stale_after_seconds > 86400 THEN
    RAISE EXCEPTION 'reconcile_stale_ai_provider_reservations: started_stale_after_seconds must be between 1 and 86400' USING ERRCODE = 'P0001';
  END IF;
  IF p_committed_unfinalized_stale_after_seconds IS NULL OR p_committed_unfinalized_stale_after_seconds <= 0 OR p_committed_unfinalized_stale_after_seconds > 86400 THEN
    RAISE EXCEPTION 'reconcile_stale_ai_provider_reservations: committed_unfinalized_stale_after_seconds must be between 1 and 86400' USING ERRCODE = 'P0001';
  END IF;

  -- Single-flight -- ha egy másik reconcile éppen fut, ez a hívás azonnal
  -- nulla eredménnyel tér vissza (061 expire_stale_provider_reservations mintája).
  v_got_lock := pg_try_advisory_xact_lock(v_lock_key);
  IF NOT v_got_lock THEN
    RETURN jsonb_build_object(
      'released', 0, 'marked_unknown', 0, 'finalized_from_run', 0, 'finalized_missing', 0, 'ambiguous', 0,
      'skipped_concurrent_run', true
    );
  END IF;

  -- Régi, el nem indult foglalás -> released.
  FOR v_row IN
    SELECT r.*, b.provider, b.model FROM public.ai_provider_budget_reservations r
    JOIN public.ai_provider_daily_budgets b ON b.id = r.daily_budget_id
    WHERE r.status = 'reserved' AND r.attempt_started_at IS NULL
      AND r.created_at < now() - make_interval(secs => p_unstarted_stale_after_seconds)
    ORDER BY r.id
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    v_key_lock := hashtextextended(
      v_row.signal_evidence_id::text || chr(31) || v_row.normalized_input_digest || chr(31) || v_row.extraction_config_digest || chr(31) || v_row.provider || chr(31) || v_row.model,
      0
    );
    PERFORM pg_advisory_xact_lock(v_key_lock);

    UPDATE public.ai_provider_budget_reservations
    SET status = 'released', released_at = now()
    WHERE id = v_row.id AND status = 'reserved' AND attempt_started_at IS NULL;
    IF FOUND THEN
      UPDATE public.ai_provider_daily_budgets
      SET reserved_requests = reserved_requests - 1,
          reserved_micro_usd = reserved_micro_usd - v_row.estimated_micro_usd,
          released_requests_total = released_requests_total + 1,
          released_micro_usd_total = released_micro_usd_total + v_row.estimated_micro_usd,
          updated_at = now()
      WHERE id = v_row.daily_budget_id;
      v_released_count := v_released_count + 1;
    END IF;
  END LOOP;

  -- Régi, elindult, de sosem lezárt foglalás -> committed_unknown.
  FOR v_row IN
    SELECT r.*, b.provider, b.model FROM public.ai_provider_budget_reservations r
    JOIN public.ai_provider_daily_budgets b ON b.id = r.daily_budget_id
    WHERE r.status = 'reserved' AND r.attempt_started_at IS NOT NULL
      AND r.attempt_started_at < now() - make_interval(secs => p_started_stale_after_seconds)
    ORDER BY r.id
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    v_key_lock := hashtextextended(
      v_row.signal_evidence_id::text || chr(31) || v_row.normalized_input_digest || chr(31) || v_row.extraction_config_digest || chr(31) || v_row.provider || chr(31) || v_row.model,
      0
    );
    PERFORM pg_advisory_xact_lock(v_key_lock);

    UPDATE public.ai_provider_budget_reservations
    SET status = 'committed_unknown', actual_micro_usd = estimated_micro_usd, error_class = 'stale_reconciled', committed_at = now()
    WHERE id = v_row.id AND status = 'reserved';
    IF FOUND THEN
      UPDATE public.ai_provider_daily_budgets
      SET reserved_requests = reserved_requests - 1,
          committed_requests = committed_requests + 1,
          reserved_micro_usd = reserved_micro_usd - v_row.estimated_micro_usd,
          committed_micro_usd = committed_micro_usd + v_row.estimated_micro_usd,
          updated_at = now()
      WHERE id = v_row.daily_budget_id;
      v_unknown_count := v_unknown_count + 1;
    END IF;
  END LOOP;

  -- Korrekciós gate (2): régi, committed, de sosem finalizált foglalás --
  -- az alkalmazás összeomlott a valós költség rögzítése (commit) és a
  -- record_topic_extraction_run + finalize_ai_provider_reservation_outcome
  -- páros között. A költség már véglegesen rögzült (committed) -- ez a
  -- blokk kizárólag az application_outcome/extraction_run_id auditláncot
  -- zárja le, semmilyen daily_budgets/kvóta-mezőt nem módosít.
  FOR v_row IN
    SELECT r.* FROM public.ai_provider_budget_reservations r
    WHERE r.status = 'committed' AND r.application_outcome IS NULL
      AND r.committed_at < now() - make_interval(secs => p_committed_unfinalized_stale_after_seconds)
    ORDER BY r.id
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    SELECT count(*) INTO v_match_count
    FROM public.topic_extraction_runs t
    WHERE t.signal_evidence_id = v_row.signal_evidence_id
      AND t.normalized_input_digest = v_row.normalized_input_digest
      AND t.extraction_config_digest = v_row.extraction_config_digest
      AND t.status IN ('completed', 'failed');

    IF v_match_count = 1 THEN
      SELECT t.id, t.status INTO v_matched_run_id, v_matched_run_status
      FROM public.topic_extraction_runs t
      WHERE t.signal_evidence_id = v_row.signal_evidence_id
        AND t.normalized_input_digest = v_row.normalized_input_digest
        AND t.extraction_config_digest = v_row.extraction_config_digest
        AND t.status IN ('completed', 'failed');

      UPDATE public.ai_provider_budget_reservations
      SET application_outcome = v_matched_run_status, extraction_run_id = v_matched_run_id
      WHERE id = v_row.id AND status = 'committed' AND application_outcome IS NULL;
      IF FOUND THEN
        v_finalized_from_run_count := v_finalized_from_run_count + 1;
      END IF;

    ELSIF v_match_count = 0 THEN
      -- Az alkalmazás a valós commit UTÁN, de MÉG a record_topic_extraction_run
      -- hívás ELŐTT omlott össze -- soha nem is keletkezett extraction_run,
      -- nincs mihez kötni. A már rögzült költség (actual_micro_usd) érintetlen
      -- marad; ez az attempt a globális attempt-limitbe már eddig is
      -- beleszámított (application_outcome IS DISTINCT FROM 'completed'
      -- NULL-kor is igaz volt), ez a lépés csak auditálhatóvá teszi.
      UPDATE public.ai_provider_budget_reservations
      SET application_outcome = 'failed', error_class = 'application_finalize_missing'
      WHERE id = v_row.id AND status = 'committed' AND application_outcome IS NULL;
      IF FOUND THEN
        v_finalized_missing_count := v_finalized_missing_count + 1;
      END IF;

    ELSE
      -- Több, egymással ütköző lehetséges extraction_run -- fail-closed:
      -- NEM választunk önkényesen, a sort változatlanul hagyjuk, és
      -- óvatosságból letiltjuk a további AI-extractiont, hogy egy ember
      -- vizsgálja ki az anomáliát.
      v_ambiguous_count := v_ambiguous_count + 1;
      UPDATE public.ai_extraction_control SET enabled = false, updated_at = now() WHERE id = 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'released', v_released_count, 'marked_unknown', v_unknown_count,
    'finalized_from_run', v_finalized_from_run_count, 'finalized_missing', v_finalized_missing_count,
    'ambiguous', v_ambiguous_count, 'skipped_concurrent_run', false
  );
END;

$body$;

    REVOKE ALL ON FUNCTION public.reconcile_stale_ai_provider_reservations(INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.reconcile_stale_ai_provider_reservations(INTEGER, INTEGER, INTEGER) TO service_role;

    RAISE NOTICE '075: reconcile_stale_ai_provider_reservations created.';
  ELSIF v_name_count = 1 THEN
    RAISE NOTICE '075: reconcile_stale_ai_provider_reservations already exists -- VALIDATE branch (no DDL/DCL will run).';

    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'reconcile_stale_ai_provider_reservations';

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_oid AND n.nspname = 'public'
        AND pg_get_function_identity_arguments(p.oid) = v_expected_args
        AND pg_get_function_result(p.oid) = 'jsonb'
        AND l.lanname = 'plpgsql'
        AND p.provolatile = 'v'
        AND p.prosecdef IS TRUE
        AND r.rolname = 'postgres'
        AND (SELECT string_agg(cfg, ';') FROM unnest(p.proconfig) cfg) = 'search_path=public, pg_temp'
    ) THEN
      RAISE EXCEPTION '075 drift: reconcile_stale_ai_provider_reservations structural definition does not match exactly';
    END IF;

    SELECT prosrc INTO v_prosrc FROM pg_proc WHERE oid = v_oid;
    v_hash := md5(replace(v_prosrc, E'\r\n', E'\n'));
    IF v_hash <> v_expected_hash THEN
      RAISE EXCEPTION '075 drift: reconcile_stale_ai_provider_reservations body hash does not match exactly (got %)', v_hash;
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
      RAISE EXCEPTION '075 drift: reconcile_stale_ai_provider_reservations ACL does not match exactly';
    END IF;

    RAISE NOTICE '075: reconcile_stale_ai_provider_reservations already exists and matches exactly -- no-op.';
  ELSE
    RAISE EXCEPTION '075 fail-closed: reconcile_stale_ai_provider_reservations has % overloads, expected exactly 0 or 1', v_name_count;
  END IF;
END;
$migrate_reconcile$;

NOTIFY pgrst, 'reload schema';

COMMIT;
