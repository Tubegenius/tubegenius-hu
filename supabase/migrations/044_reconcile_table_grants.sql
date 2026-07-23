-- ============================================================
-- Migration 044: Reconcile anon/authenticated/service_role table grants
--
-- A P0/1H teljes production <-> clean rebuild grant-reconciliation audit
-- (044-A/044-B/044-C, 2026-07-23, kizarolag production pg_catalog/
-- information_schema metaadat-exportbol, nulla felhasznaloi sor
-- olvasasabol) 279, bizonyitottan EXTRA_LOCAL TABLE_GRANT tuple-t
-- azonositott 37 tablan — a helyi Supabase CLI `auto_expose_new_tables`
-- alapertelmezese minden uj tablahoz automatikusan teljes CRUD-ot ad
-- anon/authenticated szamara, amig egy migracio explicit vissza nem
-- vonja (ahogy ezt a 036/039/040/041 mar megtette nehany tablanal).
--
-- Hatokor: KIZAROLAG a 044-C-ben jovahagyott, pontosan 279 tuple-t
-- lefedo 9 revoke-csoport. Nincs policy-, RLS-, function- vagy
-- event-trigger-valtoztatas, nincs ALTER DEFAULT PRIVILEGES, nincs
-- adatvaltoztatas. A 044-B dependency-audit bizonyitotta: mind a 37
-- tabla futasidejū eleresenek EGYETLEN kodutja sincs (sem anon, sem
-- authenticated szerepkorben) — minden app-kodos hozzaferes
-- kizarolag service_role-on keresztul, `.eq('user_id', ...)` kezi
-- szurussel megy, az RLS-policy-k egy tervezett, de jelenleg nem
-- hasznalt direkt-kliens utvonalat vedenek.
--
-- 24 authenticated DML grant es 133 service_role DML grant a 37
-- tablan BIZONYITOTTAN production-egyezo (MATCH) — ezek NEM kerulnek
-- visszavonasra, es a migracio vegi validacio explicit bizonyitja,
-- hogy egyik sem veszett el.
--
-- Forras: production pg_catalog/information_schema export (2026-07-23),
-- kizarolag metaadat-lekerdezesbol.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. REVOKE-CSOPORTOK (9 db, osszesen 279 tuple)
-- ============================================================

-- ---- #1: anon — SELECT, INSERT, UPDATE, DELETE — 36 tabla (144 tuple) ----
-- A credit_bucket_migration_backup_037 szandekosan KIMARAD: az a sajat
-- (037-es) migracioja mar letrehozaskor explicit revoke-olta anon/
-- authenticated jogait, sosem volt neki DML grantja egyik oldalon sem.
DO $grp1$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ai_usage_logs','competitor_alert_dismissals','competitor_performance_snapshots',
    'creator_memory','credit_ledger','in_flight_requests','opportunity_cache',
    'paid_results','similar_video_searches','source_video_analysis',
    'stripe_webhook_events','topic_clusters','topic_feedback',
    'tracked_competitor_videos','tracked_competitors','tracked_trend_candidates',
    'trend_alert_dismissals','trend_candidate_cache','trend_candidate_snapshots',
    'trend_candidates','trend_feed_daily_snapshots','usage_logs','user_credits',
    'video_audits','video_idea_events','video_idea_proof_signals','video_ideas',
    'video_packages','viral_score_cache','viral_score_searches',
    'youtube_channel_snapshots','youtube_channels','youtube_search_cache',
    'youtube_search_logs','youtube_video_snapshots','youtube_videos'
  ]
  LOOP
    EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I FROM %I', 'public', t, 'anon');
  END LOOP;
END;
$grp1$;

-- ---- #2: authenticated — DELETE, UPDATE — 4 tabla (8 tuple) ----
-- SELECT+INSERT production-egyezo, megmarad (select_own/insert_own policy).
DO $grp2$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_usage_logs','source_video_analysis','topic_feedback','usage_logs']
  LOOP
    EXECUTE format('REVOKE DELETE, UPDATE ON TABLE %I.%I FROM %I', 'public', t, 'authenticated');
  END LOOP;
END;
$grp2$;

-- ---- #3: authenticated — DELETE, INSERT, SELECT, UPDATE — 25 tabla (100 tuple) ----
DO $grp3$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'competitor_alert_dismissals','competitor_performance_snapshots','credit_ledger',
    'in_flight_requests','paid_results','similar_video_searches','stripe_webhook_events',
    'topic_clusters','tracked_competitor_videos','tracked_competitors',
    'tracked_trend_candidates','trend_alert_dismissals','trend_candidate_cache',
    'trend_candidate_snapshots','trend_candidates','trend_feed_daily_snapshots',
    'video_audits','video_idea_events','video_idea_proof_signals','video_ideas',
    'viral_score_searches','youtube_channel_snapshots','youtube_channels',
    'youtube_video_snapshots','youtube_videos'
  ]
  LOOP
    EXECUTE format('REVOKE DELETE, INSERT, SELECT, UPDATE ON TABLE %I.%I FROM %I', 'public', t, 'authenticated');
  END LOOP;
END;
$grp3$;

-- ---- #4: authenticated — DELETE, INSERT, UPDATE — 3 tabla (9 tuple) ----
-- SELECT production-egyezo, megmarad (megosztott, "using=true" cache-policy).
DO $grp4$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['opportunity_cache','viral_score_cache','youtube_search_cache']
  LOOP
    EXECUTE format('REVOKE DELETE, INSERT, UPDATE ON TABLE %I.%I FROM %I', 'public', t, 'authenticated');
  END LOOP;
END;
$grp4$;

-- ---- #5: authenticated — DELETE, INSERT — user_credits (2 tuple) ----
-- SELECT+UPDATE production-egyezo, megmarad.
REVOKE DELETE, INSERT ON TABLE public.user_credits FROM authenticated;

-- ---- #6: authenticated — UPDATE — video_packages (1 tuple) ----
-- SELECT/INSERT/DELETE production-egyezo, megmarad.
REVOKE UPDATE ON TABLE public.video_packages FROM authenticated;

-- ---- #7: service_role — DELETE, UPDATE — 4 tabla (8 tuple) ----
DO $grp7$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_usage_logs','source_video_analysis','topic_feedback','usage_logs']
  LOOP
    EXECUTE format('REVOKE DELETE, UPDATE ON TABLE %I.%I FROM %I', 'public', t, 'service_role');
  END LOOP;
END;
$grp7$;

-- ---- #8: service_role — DELETE, INSERT, UPDATE — credit_bucket_migration_backup_037 (3 tuple) ----
-- SELECT production-egyezo (037-es migracio sajat GRANT SELECT-je), megmarad.
REVOKE DELETE, INSERT, UPDATE ON TABLE public.credit_bucket_migration_backup_037 FROM service_role;

-- ---- #9: service_role — DELETE — 4 tabla (4 tuple) ----
DO $grp9$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['opportunity_cache','user_credits','viral_score_cache','youtube_search_cache']
  LOOP
    EXECUTE format('REVOKE DELETE ON TABLE %I.%I FROM %I', 'public', t, 'service_role');
  END LOOP;
END;
$grp9$;

-- Csoportok osszesitett tuple-szama: 144+8+100+9+2+1+8+3+4 = 279.

-- ============================================================
-- 2. FAIL-FAST VEGALLAPOT-VALIDACIO
--
-- Az elvart mátrix statikus, a migracioba rogzitett, review-zhato
-- ertekhalmaz — nem tamaszkodik futasidejū production-kapcsolatra.
-- Forras: a 044-A/044-C production export MATCH-halmaza (37 tabla,
-- {anon, authenticated, service_role}, SELECT/INSERT/UPDATE/DELETE).
-- Kulcs mindenutt: (table_name, grantee, privilege_type).
-- ============================================================

DO $validate$
DECLARE
  extra_count int;
  missing_count int;
  mismatch_count int;
  expected_count int;
  scoped_tables text[] := ARRAY[
    'ai_usage_logs','competitor_alert_dismissals','competitor_performance_snapshots','creator_memory',
    'credit_bucket_migration_backup_037','credit_ledger','in_flight_requests','opportunity_cache',
    'paid_results','similar_video_searches','source_video_analysis','stripe_webhook_events',
    'topic_clusters','topic_feedback','tracked_competitor_videos','tracked_competitors',
    'tracked_trend_candidates','trend_alert_dismissals','trend_candidate_cache','trend_candidate_snapshots',
    'trend_candidates','trend_feed_daily_snapshots','usage_logs','user_credits','video_audits',
    'video_idea_events','video_idea_proof_signals','video_ideas','video_packages','viral_score_cache',
    'viral_score_searches','youtube_channel_snapshots','youtube_channels','youtube_search_cache',
    'youtube_search_logs','youtube_video_snapshots','youtube_videos'
  ];
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS expected_grants_044 (
    table_name text NOT NULL, grantee text NOT NULL, privilege_type text NOT NULL
  ) ON COMMIT DROP;
  DELETE FROM expected_grants_044;

  -- --- 24 authenticated keeper (production-egyezo, bizonyitott MATCH) ---
  INSERT INTO expected_grants_044 (table_name, grantee, privilege_type) VALUES
    ('ai_usage_logs','authenticated','INSERT'),
    ('ai_usage_logs','authenticated','SELECT'),
    ('creator_memory','authenticated','SELECT'),
    ('creator_memory','authenticated','INSERT'),
    ('creator_memory','authenticated','UPDATE'),
    ('creator_memory','authenticated','DELETE'),
    ('opportunity_cache','authenticated','SELECT'),
    ('source_video_analysis','authenticated','SELECT'),
    ('source_video_analysis','authenticated','INSERT'),
    ('topic_feedback','authenticated','SELECT'),
    ('topic_feedback','authenticated','INSERT'),
    ('usage_logs','authenticated','INSERT'),
    ('usage_logs','authenticated','SELECT'),
    ('user_credits','authenticated','SELECT'),
    ('user_credits','authenticated','UPDATE'),
    ('video_packages','authenticated','INSERT'),
    ('video_packages','authenticated','SELECT'),
    ('video_packages','authenticated','DELETE'),
    ('viral_score_cache','authenticated','SELECT'),
    ('youtube_search_cache','authenticated','SELECT'),
    ('youtube_search_logs','authenticated','DELETE'),
    ('youtube_search_logs','authenticated','UPDATE'),
    ('youtube_search_logs','authenticated','SELECT'),
    ('youtube_search_logs','authenticated','INSERT');

  -- --- 133 service_role MATCH (production-egyezo, DML) ---
  INSERT INTO expected_grants_044 (table_name, grantee, privilege_type) VALUES
    ('ai_usage_logs','service_role','INSERT'),
    ('ai_usage_logs','service_role','SELECT'),
    ('competitor_alert_dismissals','service_role','DELETE'),
    ('competitor_alert_dismissals','service_role','INSERT'),
    ('competitor_alert_dismissals','service_role','SELECT'),
    ('competitor_alert_dismissals','service_role','UPDATE'),
    ('competitor_performance_snapshots','service_role','DELETE'),
    ('competitor_performance_snapshots','service_role','INSERT'),
    ('competitor_performance_snapshots','service_role','SELECT'),
    ('competitor_performance_snapshots','service_role','UPDATE'),
    ('creator_memory','service_role','DELETE'),
    ('creator_memory','service_role','INSERT'),
    ('creator_memory','service_role','SELECT'),
    ('creator_memory','service_role','UPDATE'),
    ('credit_bucket_migration_backup_037','service_role','SELECT'),
    ('credit_ledger','service_role','DELETE'),
    ('credit_ledger','service_role','INSERT'),
    ('credit_ledger','service_role','SELECT'),
    ('credit_ledger','service_role','UPDATE'),
    ('in_flight_requests','service_role','DELETE'),
    ('in_flight_requests','service_role','INSERT'),
    ('in_flight_requests','service_role','SELECT'),
    ('in_flight_requests','service_role','UPDATE'),
    ('opportunity_cache','service_role','INSERT'),
    ('opportunity_cache','service_role','SELECT'),
    ('opportunity_cache','service_role','UPDATE'),
    ('paid_results','service_role','DELETE'),
    ('paid_results','service_role','INSERT'),
    ('paid_results','service_role','SELECT'),
    ('paid_results','service_role','UPDATE'),
    ('similar_video_searches','service_role','DELETE'),
    ('similar_video_searches','service_role','INSERT'),
    ('similar_video_searches','service_role','SELECT'),
    ('similar_video_searches','service_role','UPDATE'),
    ('source_video_analysis','service_role','INSERT'),
    ('source_video_analysis','service_role','SELECT'),
    ('stripe_webhook_events','service_role','DELETE'),
    ('stripe_webhook_events','service_role','INSERT'),
    ('stripe_webhook_events','service_role','SELECT'),
    ('stripe_webhook_events','service_role','UPDATE'),
    ('topic_clusters','service_role','DELETE'),
    ('topic_clusters','service_role','INSERT'),
    ('topic_clusters','service_role','SELECT'),
    ('topic_clusters','service_role','UPDATE'),
    ('topic_feedback','service_role','INSERT'),
    ('topic_feedback','service_role','SELECT'),
    ('tracked_competitor_videos','service_role','DELETE'),
    ('tracked_competitor_videos','service_role','INSERT'),
    ('tracked_competitor_videos','service_role','SELECT'),
    ('tracked_competitor_videos','service_role','UPDATE'),
    ('tracked_competitors','service_role','DELETE'),
    ('tracked_competitors','service_role','INSERT'),
    ('tracked_competitors','service_role','SELECT'),
    ('tracked_competitors','service_role','UPDATE'),
    ('tracked_trend_candidates','service_role','DELETE'),
    ('tracked_trend_candidates','service_role','INSERT'),
    ('tracked_trend_candidates','service_role','SELECT'),
    ('tracked_trend_candidates','service_role','UPDATE'),
    ('trend_alert_dismissals','service_role','DELETE'),
    ('trend_alert_dismissals','service_role','INSERT'),
    ('trend_alert_dismissals','service_role','SELECT'),
    ('trend_alert_dismissals','service_role','UPDATE'),
    ('trend_candidate_cache','service_role','DELETE'),
    ('trend_candidate_cache','service_role','INSERT'),
    ('trend_candidate_cache','service_role','SELECT'),
    ('trend_candidate_cache','service_role','UPDATE'),
    ('trend_candidate_snapshots','service_role','DELETE'),
    ('trend_candidate_snapshots','service_role','INSERT'),
    ('trend_candidate_snapshots','service_role','SELECT'),
    ('trend_candidate_snapshots','service_role','UPDATE'),
    ('trend_candidates','service_role','DELETE'),
    ('trend_candidates','service_role','INSERT'),
    ('trend_candidates','service_role','SELECT'),
    ('trend_candidates','service_role','UPDATE'),
    ('trend_feed_daily_snapshots','service_role','DELETE'),
    ('trend_feed_daily_snapshots','service_role','INSERT'),
    ('trend_feed_daily_snapshots','service_role','SELECT'),
    ('trend_feed_daily_snapshots','service_role','UPDATE'),
    ('usage_logs','service_role','INSERT'),
    ('usage_logs','service_role','SELECT'),
    ('user_credits','service_role','INSERT'),
    ('user_credits','service_role','SELECT'),
    ('user_credits','service_role','UPDATE'),
    ('video_audits','service_role','DELETE'),
    ('video_audits','service_role','INSERT'),
    ('video_audits','service_role','SELECT'),
    ('video_audits','service_role','UPDATE'),
    ('video_idea_events','service_role','DELETE'),
    ('video_idea_events','service_role','INSERT'),
    ('video_idea_events','service_role','SELECT'),
    ('video_idea_events','service_role','UPDATE'),
    ('video_idea_proof_signals','service_role','DELETE'),
    ('video_idea_proof_signals','service_role','INSERT'),
    ('video_idea_proof_signals','service_role','SELECT'),
    ('video_idea_proof_signals','service_role','UPDATE'),
    ('video_ideas','service_role','DELETE'),
    ('video_ideas','service_role','INSERT'),
    ('video_ideas','service_role','SELECT'),
    ('video_ideas','service_role','UPDATE'),
    ('video_packages','service_role','DELETE'),
    ('video_packages','service_role','INSERT'),
    ('video_packages','service_role','SELECT'),
    ('video_packages','service_role','UPDATE'),
    ('viral_score_cache','service_role','INSERT'),
    ('viral_score_cache','service_role','SELECT'),
    ('viral_score_cache','service_role','UPDATE'),
    ('viral_score_searches','service_role','DELETE'),
    ('viral_score_searches','service_role','INSERT'),
    ('viral_score_searches','service_role','SELECT'),
    ('viral_score_searches','service_role','UPDATE'),
    ('youtube_channel_snapshots','service_role','DELETE'),
    ('youtube_channel_snapshots','service_role','INSERT'),
    ('youtube_channel_snapshots','service_role','SELECT'),
    ('youtube_channel_snapshots','service_role','UPDATE'),
    ('youtube_channels','service_role','DELETE'),
    ('youtube_channels','service_role','INSERT'),
    ('youtube_channels','service_role','SELECT'),
    ('youtube_channels','service_role','UPDATE'),
    ('youtube_search_cache','service_role','INSERT'),
    ('youtube_search_cache','service_role','SELECT'),
    ('youtube_search_cache','service_role','UPDATE'),
    ('youtube_search_logs','service_role','DELETE'),
    ('youtube_search_logs','service_role','INSERT'),
    ('youtube_search_logs','service_role','SELECT'),
    ('youtube_search_logs','service_role','UPDATE'),
    ('youtube_video_snapshots','service_role','DELETE'),
    ('youtube_video_snapshots','service_role','INSERT'),
    ('youtube_video_snapshots','service_role','SELECT'),
    ('youtube_video_snapshots','service_role','UPDATE'),
    ('youtube_videos','service_role','DELETE'),
    ('youtube_videos','service_role','INSERT'),
    ('youtube_videos','service_role','SELECT'),
    ('youtube_videos','service_role','UPDATE');

  SELECT count(*) INTO expected_count FROM expected_grants_044;
  IF expected_count <> 157 THEN
    RAISE EXCEPTION '044 validation setup error: expected_grants_044 does not contain exactly 157 rows (got %)', expected_count;
  END IF;

  -- --- EXTRA_LOCAL: jelenleg meglevo grant, ami nincs az elvart halmazban ---
  SELECT count(*) INTO extra_count
  FROM information_schema.role_table_grants g
  WHERE g.table_schema = 'public'
    AND g.table_name = ANY(scoped_tables)
    AND g.grantee IN ('anon','authenticated','service_role')
    AND g.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
    AND NOT EXISTS (
      SELECT 1 FROM expected_grants_044 e
      WHERE e.table_name = g.table_name AND e.grantee = g.grantee AND e.privilege_type = g.privilege_type
    );
  IF extra_count > 0 THEN
    RAISE EXCEPTION '044 validation failed: % unexpected (EXTRA_LOCAL) grant(s) remain after revoke', extra_count;
  END IF;

  -- --- MISSING_LOCAL: elvart grant, ami nem talalhato meg ---
  SELECT count(*) INTO missing_count
  FROM expected_grants_044 e
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants g
    WHERE g.table_schema = 'public' AND g.table_name = e.table_name
      AND g.grantee = e.grantee AND g.privilege_type = e.privilege_type
  );
  IF missing_count > 0 THEN
    RAISE EXCEPTION '044 validation failed: % expected grant(s) are missing (MISSING_LOCAL) — a keeper may have been revoked in error', missing_count;
  END IF;

  -- --- is_grantable mismatch: minden elvart sor grantable=NO kell legyen ---
  SELECT count(*) INTO mismatch_count
  FROM information_schema.role_table_grants g
  JOIN expected_grants_044 e
    ON e.table_name = g.table_name AND e.grantee = g.grantee AND e.privilege_type = g.privilege_type
  WHERE g.table_schema = 'public' AND g.is_grantable <> 'NO';
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION '044 validation failed: % grant(s) have unexpected is_grantable value', mismatch_count;
  END IF;

  -- --- tenyleges tuple-szam pontos egyezese ---
  IF (
    SELECT count(*) FROM information_schema.role_table_grants g
    WHERE g.table_schema = 'public'
      AND g.table_name = ANY(scoped_tables)
      AND g.grantee IN ('anon','authenticated','service_role')
      AND g.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
  ) <> 157 THEN
    RAISE EXCEPTION '044 validation failed: actual scoped DML grant count does not equal the expected 157';
  END IF;
END;
$validate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
