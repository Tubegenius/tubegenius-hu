-- ============================================================
-- Migration 003: Baseline capture — flagged tables
--
-- A 001-011 migrációs rés miatt nyolc production tábla soha nem kapott
-- CREATE TABLE-t a migrációs láncban (feltehetően Dashboard/manuális SQL
-- útján jöttek létre): user_credits, ai_usage_logs, trend_candidate_cache,
-- topic_feedback, video_audits, video_packages, source_video_analysis,
-- youtube_search_cache (utóbbi a P0/1F körben azonosítva — egy valódi
-- lokális Supabase rebuild derítette ki, hogy a tábla-szám 38/39 volt).
--
-- Ez a migráció KIZÁRÓLAG ezen nyolc tábla TÖRTÉNETI ALAPÁLLAPOTÁT
-- rekonstruálja — azt az állapotot, amilyenek a 012-es migráció előtt
-- voltak. Minden oszlop/constraint/index/trigger/grant, amit egy későbbi,
-- verziókövetett migráció (012, 013, 021, 030, 031, 036, 037, 038) már
-- létrehoz vagy módosít, itt SZÁNDÉKOSAN KIMARAD — azok tulajdonjoga
-- változatlanul az adott migrációnál marad, és idempotens (IF NOT EXISTS /
-- DROP...ADD) mintájuk miatt biztonságosan lefutnak majd egy friss reset
-- során is, miután ez a migráció létrehozta az alapállapotot.
--
-- Forrás: production pg_catalog/information_schema export (2026-07-22),
-- kizárólag metaadat-lekérdezésből, nulla felhasználói sor olvasásával.
--
-- Explicit kizárva (más migráció tulajdona):
--   user_credits:      subscription_credit_balance, purchased_credit_balance,
--                       a 3 bucket CHECK, user_credits_sync_bucket_balance
--                       trigger, 036-os service_role grant                (037/036)
--   video_packages:    verified_fact_block_json, forbidden_claims,
--                       sources_used, quality_status, content_type,
--                       strict_fact_mode, intensity_original,
--                       intensity_final                                   (012)
--                       fact_strictness_level                             (013)
--                       video_idea_id + FK + idx_video_packages_video_idea (021)
--                       031-es service_role UPDATE grant                  (031)
--   video_audits:      youtube_channel_id + idx_video_audits_user_channel_created (038)
--
-- youtube_search_cache: nincs user_id/FK (globális, nem user-szkópolt cache,
--                       akárcsak trend_candidate_cache) — egyetlen migráció
--                       és egyetlen alkalmazáskód-hivatkozás sem érinti
--                       soha, nincs kizárt objektuma.
--
-- Policy/constraint/index/trigger kezelés: minden objektumnál explicit
-- ellenőrzés — ha hiányzik, létrehozza; ha létezik és a definíciója
-- pontosan egyezik, no-op; ha létezik, de eltér, RAISE EXCEPTION
-- (fail-fast). Sehol nincs DROP POLICY / vak felülírás.
--
-- rls_auto_enable event trigger NEM része ennek a migrációnak (külön kör).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Extensions — idempotens, a 001 stílusát követve (nincs explicit SCHEMA
-- klózul, mert a 001 sem használt ilyet, és a projekt így routolja az
-- "extensions" sémába). A friss rebuild UUID-defaultjai emiatt garantáltan
-- működnek, függetlenül a Supabase bootstrap feltételezésétől.
-- ------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TÁBLÁK (csak oszlopok — constraint/index/policy/trigger külön lent)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_credits (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  balance NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_used NUMERIC(10,2) NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'beta',
  monthly_allowance NUMERIC(10,2) NOT NULL DEFAULT 50.0,
  renews_at TIMESTAMPTZ DEFAULT (now() + interval '30 days'),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'free'
);

CREATE TABLE IF NOT EXISTS public.ai_usage_logs (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  feature_name TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) DEFAULT 0,
  credits_charged NUMERIC(10,2) DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.trend_candidate_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  cache_key TEXT NOT NULL,
  region TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'hu',
  niche TEXT NOT NULL,
  category TEXT NOT NULL,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS public.topic_feedback (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  topic TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  reason TEXT,
  opportunity_score NUMERIC,
  niche_cluster TEXT,
  source_videos JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.video_audits (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  platform TEXT NOT NULL,
  video_url TEXT,
  video_title TEXT,
  topic TEXT,
  input_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  backend_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  claude_interpretation JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  overall_score INTEGER NOT NULL DEFAULT 0,
  overall_label TEXT,
  confidence TEXT,
  diagnosis TEXT,
  recommendations JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- youtube_channel_id: a 038 tulajdona, itt szándékosan kimarad
);

CREATE TABLE IF NOT EXISTS public.video_packages (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  topic TEXT NOT NULL,
  search_keyword TEXT,
  platform TEXT NOT NULL,
  video_length TEXT NOT NULL,
  narration_style TEXT,
  intensity TEXT,
  goal TEXT,
  verified_fact_block TEXT,
  sources JSONB DEFAULT '[]'::jsonb,
  hook TEXT,
  narration TEXT,
  scene_structure JSONB DEFAULT '[]'::jsonb,
  broll_ideas JSONB DEFAULT '[]'::jsonb,
  timestamps JSONB DEFAULT '[]'::jsonb,
  title_variations JSONB DEFAULT '[]'::jsonb,
  thumbnail_texts JSONB DEFAULT '[]'::jsonb,
  caption TEXT,
  description TEXT,
  hashtags JSONB DEFAULT '{}'::jsonb,
  upload_times JSONB DEFAULT '{}'::jsonb,
  cta TEXT,
  estimated_word_count TEXT,
  estimated_duration TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
  -- verified_fact_block_json / forbidden_claims / sources_used /
  -- quality_status / content_type / strict_fact_mode / intensity_original /
  -- intensity_final: a 012 tulajdona.
  -- fact_strictness_level: a 013 tulajdona.
  -- video_idea_id (+ FK video_ideas-ra): a 021 tulajdona — az a migráció
  -- hozza létre magát a video_ideas táblát is, ezért itt korábban még
  -- nem lenne mire hivatkoznia.
);

-- source_video_analysis UTOLJÁRA: FK-ja van video_packages-re.
CREATE TABLE IF NOT EXISTS public.source_video_analysis (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  source_video_id TEXT NOT NULL,
  source_video_url TEXT NOT NULL,
  source_video_title TEXT,
  source_channel TEXT,
  source_context TEXT NOT NULL,
  transcript_available BOOLEAN DEFAULT false,
  transcript_source TEXT DEFAULT 'metadata',
  extracted_structure JSONB DEFAULT '{}'::jsonb,
  verified_fact_block TEXT,
  sources JSONB DEFAULT '[]'::jsonb,
  generated_video_package_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- youtube_search_cache: globális (nem user-szkópolt) cache, akárcsak
-- trend_candidate_cache — nincs FK-ja, sorrendfüggetlen. P0/1F körben
-- azonosítva (8. hiányzó tábla, sosem érintette migráció vagy app-kód).
CREATE TABLE IF NOT EXISTS public.youtube_search_cache (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  cache_key TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + interval '24 hours')
);

-- ============================================================
-- OSZLOPSZINTŰ VALIDÁCIÓ (csak a 003-tulajdonú oszlopokra)
--
-- Ha a tábla az imént jött létre (CREATE TABLE IF NOT EXISTS fentebb),
-- minden oszlopa itt eleve egyezni fog — ez a blokk ARRA az esetre védi
-- meg a rebuildot, amikor a tábla MÁR LÉTEZETT (production), és
-- valamelyik 003-tulajdonú oszlop definíciója (típus, precision/scale,
-- nullability, default) eltér a vártól. Session-lokális (pg_temp) helper
-- function, hogy ne maradjon állandó objektum a public sémában.
--
-- Később (012/013/021/037/038) hozzáadott oszlopokat ez a blokk
-- SZÁNDÉKOSAN NEM ellenőrzi — azon a migrációs ponton még helyesen
-- hiányoznak.
-- ============================================================

CREATE OR REPLACE FUNCTION pg_temp.baseline_003_ensure_column(
  p_table text, p_column text, p_add_type_sql text, p_udt_name text,
  p_num_precision int, p_num_scale int, p_nullable boolean, p_default text
) RETURNS void AS $fn$
DECLARE
  c RECORD;
  add_sql text;
BEGIN
  SELECT udt_name, numeric_precision, numeric_scale, character_maximum_length,
         is_nullable, column_default, is_identity
  INTO c
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_column;

  IF NOT FOUND THEN
    add_sql := format('ALTER TABLE public.%I ADD COLUMN %I %s %s %s',
      p_table, p_column, p_add_type_sql,
      CASE WHEN p_nullable THEN '' ELSE 'NOT NULL' END,
      CASE WHEN p_default IS NULL THEN '' ELSE 'DEFAULT ' || p_default END);
    EXECUTE add_sql;
  ELSE
    IF c.udt_name IS DISTINCT FROM p_udt_name
       OR c.numeric_precision IS DISTINCT FROM p_num_precision
       OR c.numeric_scale IS DISTINCT FROM p_num_scale
       OR c.character_maximum_length IS NOT NULL
       OR c.is_nullable IS DISTINCT FROM (CASE WHEN p_nullable THEN 'YES' ELSE 'NO' END)
       OR c.column_default IS DISTINCT FROM p_default
       OR c.is_identity IS DISTINCT FROM 'NO'
    THEN
      RAISE EXCEPTION 'column %.% unexpected definition (udt=%, precision=%, scale=%, char_len=%, nullable=%, default=%, identity=%)',
        p_table, p_column, c.udt_name, c.numeric_precision, c.numeric_scale,
        c.character_maximum_length, c.is_nullable, c.column_default, c.is_identity;
    END IF;
  END IF;
END;
$fn$ LANGUAGE plpgsql;

-- user_credits (12 oszlop)
SELECT pg_temp.baseline_003_ensure_column('user_credits','id','UUID','uuid',NULL,NULL,false,'uuid_generate_v4()');
SELECT pg_temp.baseline_003_ensure_column('user_credits','user_id','UUID','uuid',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('user_credits','balance','NUMERIC(10,2)','numeric',10,2,false,'0');
SELECT pg_temp.baseline_003_ensure_column('user_credits','total_used','NUMERIC(10,2)','numeric',10,2,false,'0');
SELECT pg_temp.baseline_003_ensure_column('user_credits','plan','TEXT','text',NULL,NULL,false,'''beta''::text');
SELECT pg_temp.baseline_003_ensure_column('user_credits','monthly_allowance','NUMERIC(10,2)','numeric',10,2,false,'50.0');
SELECT pg_temp.baseline_003_ensure_column('user_credits','renews_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'(now() + ''30 days''::interval)');
SELECT pg_temp.baseline_003_ensure_column('user_credits','created_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'now()');
SELECT pg_temp.baseline_003_ensure_column('user_credits','updated_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'now()');
SELECT pg_temp.baseline_003_ensure_column('user_credits','stripe_customer_id','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('user_credits','stripe_subscription_id','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('user_credits','subscription_status','TEXT','text',NULL,NULL,true,'''free''::text');

-- ai_usage_logs (10 oszlop)
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','id','UUID','uuid',NULL,NULL,false,'uuid_generate_v4()');
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','user_id','UUID','uuid',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','feature_name','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','model','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','input_tokens','INTEGER','int4',32,0,true,'0');
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','output_tokens','INTEGER','int4',32,0,true,'0');
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','estimated_cost_usd','NUMERIC(10,6)','numeric',10,6,true,'0');
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','credits_charged','NUMERIC(10,2)','numeric',10,2,true,'0');
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','metadata','JSONB','jsonb',NULL,NULL,true,'''{}''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('ai_usage_logs','created_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'now()');

-- trend_candidate_cache (9 oszlop)
SELECT pg_temp.baseline_003_ensure_column('trend_candidate_cache','id','UUID','uuid',NULL,NULL,false,'gen_random_uuid()');
SELECT pg_temp.baseline_003_ensure_column('trend_candidate_cache','cache_key','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('trend_candidate_cache','region','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('trend_candidate_cache','language','TEXT','text',NULL,NULL,false,'''hu''::text');
SELECT pg_temp.baseline_003_ensure_column('trend_candidate_cache','niche','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('trend_candidate_cache','category','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('trend_candidate_cache','candidates','JSONB','jsonb',NULL,NULL,false,'''[]''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('trend_candidate_cache','generated_at','TIMESTAMPTZ','timestamptz',NULL,NULL,false,'now()');
SELECT pg_temp.baseline_003_ensure_column('trend_candidate_cache','expires_at','TIMESTAMPTZ','timestamptz',NULL,NULL,false,NULL);

-- topic_feedback (9 oszlop)
SELECT pg_temp.baseline_003_ensure_column('topic_feedback','id','UUID','uuid',NULL,NULL,false,'uuid_generate_v4()');
SELECT pg_temp.baseline_003_ensure_column('topic_feedback','user_id','UUID','uuid',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('topic_feedback','topic','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('topic_feedback','feedback_type','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('topic_feedback','reason','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('topic_feedback','opportunity_score','NUMERIC','numeric',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('topic_feedback','niche_cluster','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('topic_feedback','source_videos','JSONB','jsonb',NULL,NULL,true,'''[]''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('topic_feedback','created_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'now()');

-- video_audits (17 oszlop — youtube_channel_id a 038 tulajdona, itt nincs)
SELECT pg_temp.baseline_003_ensure_column('video_audits','id','UUID','uuid',NULL,NULL,false,'gen_random_uuid()');
SELECT pg_temp.baseline_003_ensure_column('video_audits','user_id','UUID','uuid',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_audits','platform','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_audits','video_url','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_audits','video_title','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_audits','topic','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_audits','input_data','JSONB','jsonb',NULL,NULL,false,'''{}''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_audits','backend_scores','JSONB','jsonb',NULL,NULL,false,'''{}''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_audits','claude_interpretation','JSONB','jsonb',NULL,NULL,false,'''{}''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_audits','final_scores','JSONB','jsonb',NULL,NULL,false,'''{}''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_audits','overall_score','INTEGER','int4',32,0,false,'0');
SELECT pg_temp.baseline_003_ensure_column('video_audits','overall_label','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_audits','confidence','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_audits','diagnosis','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_audits','recommendations','JSONB','jsonb',NULL,NULL,false,'''{}''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_audits','decision','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_audits','created_at','TIMESTAMPTZ','timestamptz',NULL,NULL,false,'now()');

-- video_packages (27 oszlop — a 012/013/021 tulajdonú 10 oszlop itt nincs)
SELECT pg_temp.baseline_003_ensure_column('video_packages','id','UUID','uuid',NULL,NULL,false,'uuid_generate_v4()');
SELECT pg_temp.baseline_003_ensure_column('video_packages','user_id','UUID','uuid',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','topic','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','search_keyword','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','platform','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','video_length','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','narration_style','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','intensity','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','goal','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','verified_fact_block','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','sources','JSONB','jsonb',NULL,NULL,true,'''[]''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_packages','hook','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','narration','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','scene_structure','JSONB','jsonb',NULL,NULL,true,'''[]''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_packages','broll_ideas','JSONB','jsonb',NULL,NULL,true,'''[]''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_packages','timestamps','JSONB','jsonb',NULL,NULL,true,'''[]''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_packages','title_variations','JSONB','jsonb',NULL,NULL,true,'''[]''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_packages','thumbnail_texts','JSONB','jsonb',NULL,NULL,true,'''[]''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_packages','caption','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','description','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','hashtags','JSONB','jsonb',NULL,NULL,true,'''{}''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_packages','upload_times','JSONB','jsonb',NULL,NULL,true,'''{}''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('video_packages','cta','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','estimated_word_count','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','estimated_duration','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('video_packages','created_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'now()');
SELECT pg_temp.baseline_003_ensure_column('video_packages','updated_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'now()');

-- source_video_analysis (14 oszlop)
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','id','UUID','uuid',NULL,NULL,false,'uuid_generate_v4()');
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','user_id','UUID','uuid',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','source_video_id','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','source_video_url','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','source_video_title','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','source_channel','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','source_context','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','transcript_available','BOOLEAN','bool',NULL,NULL,true,'false');
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','transcript_source','TEXT','text',NULL,NULL,true,'''metadata''::text');
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','extracted_structure','JSONB','jsonb',NULL,NULL,true,'''{}''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','verified_fact_block','TEXT','text',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','sources','JSONB','jsonb',NULL,NULL,true,'''[]''::jsonb');
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','generated_video_package_id','UUID','uuid',NULL,NULL,true,NULL);
SELECT pg_temp.baseline_003_ensure_column('source_video_analysis','created_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'now()');

-- youtube_search_cache (5 oszlop)
SELECT pg_temp.baseline_003_ensure_column('youtube_search_cache','id','UUID','uuid',NULL,NULL,false,'uuid_generate_v4()');
SELECT pg_temp.baseline_003_ensure_column('youtube_search_cache','cache_key','TEXT','text',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('youtube_search_cache','result','JSONB','jsonb',NULL,NULL,false,NULL);
SELECT pg_temp.baseline_003_ensure_column('youtube_search_cache','created_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'now()');
SELECT pg_temp.baseline_003_ensure_column('youtube_search_cache','expires_at','TIMESTAMPTZ','timestamptz',NULL,NULL,true,'(now() + ''24:00:00''::interval)');

-- ============================================================
-- CONSTRAINT-EK — hiányzó: létrehoz; egyező: no-op; eltérő: fail-fast
-- ============================================================

-- user_credits ------------------------------------------------
DO $$
DECLARE existing_def text; expected_def text := 'PRIMARY KEY (id)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.user_credits'::regclass AND conname = 'user_credits_pkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.user_credits ADD CONSTRAINT user_credits_pkey PRIMARY KEY (id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'user_credits_pkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'UNIQUE (user_id)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.user_credits'::regclass AND conname = 'user_credits_user_id_key';
  IF existing_def IS NULL THEN
    ALTER TABLE public.user_credits ADD CONSTRAINT user_credits_user_id_key UNIQUE (user_id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'user_credits_user_id_key unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.user_credits'::regclass AND conname = 'user_credits_user_id_fkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.user_credits ADD CONSTRAINT user_credits_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'user_credits_user_id_fkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text;
  expected_def text := 'CHECK ((plan = ANY (ARRAY[''free''::text, ''beta''::text, ''starter''::text, ''creator''::text, ''pro''::text])))';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.user_credits'::regclass AND conname = 'user_credits_plan_check';
  IF existing_def IS NULL THEN
    ALTER TABLE public.user_credits ADD CONSTRAINT user_credits_plan_check
      CHECK (plan IN ('free','beta','starter','creator','pro'));
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'user_credits_plan_check unexpected definition: %', existing_def;
  END IF;
END $$;

-- ai_usage_logs -------------------------------------------------
DO $$
DECLARE existing_def text; expected_def text := 'PRIMARY KEY (id)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.ai_usage_logs'::regclass AND conname = 'ai_usage_logs_pkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.ai_usage_logs ADD CONSTRAINT ai_usage_logs_pkey PRIMARY KEY (id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'ai_usage_logs_pkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.ai_usage_logs'::regclass AND conname = 'ai_usage_logs_user_id_fkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.ai_usage_logs ADD CONSTRAINT ai_usage_logs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'ai_usage_logs_user_id_fkey unexpected definition: %', existing_def;
  END IF;
END $$;

-- trend_candidate_cache ------------------------------------------
DO $$
DECLARE existing_def text; expected_def text := 'PRIMARY KEY (id)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.trend_candidate_cache'::regclass AND conname = 'trend_candidate_cache_pkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.trend_candidate_cache ADD CONSTRAINT trend_candidate_cache_pkey PRIMARY KEY (id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'trend_candidate_cache_pkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'UNIQUE (cache_key)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.trend_candidate_cache'::regclass AND conname = 'trend_candidate_cache_cache_key_key';
  IF existing_def IS NULL THEN
    ALTER TABLE public.trend_candidate_cache ADD CONSTRAINT trend_candidate_cache_cache_key_key UNIQUE (cache_key);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'trend_candidate_cache_cache_key_key unexpected definition: %', existing_def;
  END IF;
END $$;

-- topic_feedback --------------------------------------------------
DO $$
DECLARE existing_def text; expected_def text := 'PRIMARY KEY (id)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.topic_feedback'::regclass AND conname = 'topic_feedback_pkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.topic_feedback ADD CONSTRAINT topic_feedback_pkey PRIMARY KEY (id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'topic_feedback_pkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.topic_feedback'::regclass AND conname = 'topic_feedback_user_id_fkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.topic_feedback ADD CONSTRAINT topic_feedback_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'topic_feedback_user_id_fkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text;
  expected_def text := 'CHECK ((feedback_type = ANY (ARRAY[''save''::text, ''reject''::text, ''complete''::text, ''request_similar''::text, ''request_different''::text])))';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.topic_feedback'::regclass AND conname = 'topic_feedback_feedback_type_check';
  IF existing_def IS NULL THEN
    ALTER TABLE public.topic_feedback ADD CONSTRAINT topic_feedback_feedback_type_check
      CHECK (feedback_type IN ('save','reject','complete','request_similar','request_different'));
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'topic_feedback_feedback_type_check unexpected definition: %', existing_def;
  END IF;
END $$;

-- video_audits -------------------------------------------------------
DO $$
DECLARE existing_def text; expected_def text := 'PRIMARY KEY (id)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.video_audits'::regclass AND conname = 'video_audits_pkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.video_audits ADD CONSTRAINT video_audits_pkey PRIMARY KEY (id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'video_audits_pkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.video_audits'::regclass AND conname = 'video_audits_user_id_fkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.video_audits ADD CONSTRAINT video_audits_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'video_audits_user_id_fkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text;
  expected_def text := 'CHECK ((confidence = ANY (ARRAY[''high''::text, ''medium''::text, ''low''::text])))';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.video_audits'::regclass AND conname = 'video_audits_confidence_check';
  IF existing_def IS NULL THEN
    ALTER TABLE public.video_audits ADD CONSTRAINT video_audits_confidence_check
      CHECK (confidence IN ('high','medium','low'));
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'video_audits_confidence_check unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text;
  expected_def text := 'CHECK ((platform = ANY (ARRAY[''youtube_long''::text, ''youtube_shorts''::text, ''tiktok''::text, ''instagram_reels''::text, ''facebook_reels''::text])))';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.video_audits'::regclass AND conname = 'video_audits_platform_check';
  IF existing_def IS NULL THEN
    ALTER TABLE public.video_audits ADD CONSTRAINT video_audits_platform_check
      CHECK (platform IN ('youtube_long','youtube_shorts','tiktok','instagram_reels','facebook_reels'));
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'video_audits_platform_check unexpected definition: %', existing_def;
  END IF;
END $$;

-- video_packages -------------------------------------------------------
DO $$
DECLARE existing_def text; expected_def text := 'PRIMARY KEY (id)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.video_packages'::regclass AND conname = 'video_packages_pkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.video_packages ADD CONSTRAINT video_packages_pkey PRIMARY KEY (id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'video_packages_pkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.video_packages'::regclass AND conname = 'video_packages_user_id_fkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.video_packages ADD CONSTRAINT video_packages_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'video_packages_user_id_fkey unexpected definition: %', existing_def;
  END IF;
END $$;

-- source_video_analysis --------------------------------------------------
DO $$
DECLARE existing_def text; expected_def text := 'PRIMARY KEY (id)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.source_video_analysis'::regclass AND conname = 'source_video_analysis_pkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.source_video_analysis ADD CONSTRAINT source_video_analysis_pkey PRIMARY KEY (id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'source_video_analysis_pkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.source_video_analysis'::regclass AND conname = 'source_video_analysis_user_id_fkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.source_video_analysis ADD CONSTRAINT source_video_analysis_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'source_video_analysis_user_id_fkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'FOREIGN KEY (generated_video_package_id) REFERENCES video_packages(id) ON DELETE SET NULL';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.source_video_analysis'::regclass
    AND conname = 'source_video_analysis_generated_video_package_id_fkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.source_video_analysis ADD CONSTRAINT source_video_analysis_generated_video_package_id_fkey
      FOREIGN KEY (generated_video_package_id) REFERENCES public.video_packages(id) ON DELETE SET NULL;
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'source_video_analysis_generated_video_package_id_fkey unexpected definition: %', existing_def;
  END IF;
END $$;

-- youtube_search_cache ----------------------------------------------------
DO $$
DECLARE existing_def text; expected_def text := 'PRIMARY KEY (id)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.youtube_search_cache'::regclass AND conname = 'youtube_search_cache_pkey';
  IF existing_def IS NULL THEN
    ALTER TABLE public.youtube_search_cache ADD CONSTRAINT youtube_search_cache_pkey PRIMARY KEY (id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'youtube_search_cache_pkey unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'UNIQUE (cache_key)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def FROM pg_constraint
  WHERE conrelid = 'public.youtube_search_cache'::regclass AND conname = 'youtube_search_cache_cache_key_key';
  IF existing_def IS NULL THEN
    ALTER TABLE public.youtube_search_cache ADD CONSTRAINT youtube_search_cache_cache_key_key UNIQUE (cache_key);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'youtube_search_cache_cache_key_key unexpected definition: %', existing_def;
  END IF;
END $$;

-- ============================================================
-- INDEXEK (csak az explicit, PK/UNIQUE-től független indexek —
-- a PK/UNIQUE saját indexét már a fenti ADD CONSTRAINT létrehozta)
-- ============================================================

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_user_credits_user ON public.user_credits USING btree (user_id)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'user_credits' AND indexname = 'idx_user_credits_user';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_user_credits_user ON public.user_credits USING btree (user_id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_user_credits_user unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_ai_usage_created ON public.ai_usage_logs USING btree (created_at)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'ai_usage_logs' AND indexname = 'idx_ai_usage_created';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_ai_usage_created ON public.ai_usage_logs USING btree (created_at);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_ai_usage_created unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_ai_usage_feature ON public.ai_usage_logs USING btree (feature_name)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'ai_usage_logs' AND indexname = 'idx_ai_usage_feature';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_ai_usage_feature ON public.ai_usage_logs USING btree (feature_name);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_ai_usage_feature unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_ai_usage_user ON public.ai_usage_logs USING btree (user_id)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'ai_usage_logs' AND indexname = 'idx_ai_usage_user';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_ai_usage_user ON public.ai_usage_logs USING btree (user_id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_ai_usage_user unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_trend_candidate_cache_expires ON public.trend_candidate_cache USING btree (expires_at)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'trend_candidate_cache' AND indexname = 'idx_trend_candidate_cache_expires';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_trend_candidate_cache_expires ON public.trend_candidate_cache USING btree (expires_at);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_trend_candidate_cache_expires unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_trend_candidate_cache_key ON public.trend_candidate_cache USING btree (cache_key)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'trend_candidate_cache' AND indexname = 'idx_trend_candidate_cache_key';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_trend_candidate_cache_key ON public.trend_candidate_cache USING btree (cache_key);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_trend_candidate_cache_key unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_topic_feedback_cluster ON public.topic_feedback USING btree (niche_cluster)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'topic_feedback' AND indexname = 'idx_topic_feedback_cluster';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_topic_feedback_cluster ON public.topic_feedback USING btree (niche_cluster);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_topic_feedback_cluster unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_topic_feedback_created ON public.topic_feedback USING btree (created_at)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'topic_feedback' AND indexname = 'idx_topic_feedback_created';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_topic_feedback_created ON public.topic_feedback USING btree (created_at);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_topic_feedback_created unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_topic_feedback_type ON public.topic_feedback USING btree (feedback_type)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'topic_feedback' AND indexname = 'idx_topic_feedback_type';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_topic_feedback_type ON public.topic_feedback USING btree (feedback_type);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_topic_feedback_type unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_topic_feedback_user ON public.topic_feedback USING btree (user_id)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'topic_feedback' AND indexname = 'idx_topic_feedback_user';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_topic_feedback_user ON public.topic_feedback USING btree (user_id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_topic_feedback_user unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_video_packages_user ON public.video_packages USING btree (user_id)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'video_packages' AND indexname = 'idx_video_packages_user';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_video_packages_user ON public.video_packages USING btree (user_id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_video_packages_user unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_video_packages_topic ON public.video_packages USING btree (topic)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'video_packages' AND indexname = 'idx_video_packages_topic';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_video_packages_topic ON public.video_packages USING btree (topic);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_video_packages_topic unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_video_packages_created ON public.video_packages USING btree (created_at)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'video_packages' AND indexname = 'idx_video_packages_created';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_video_packages_created ON public.video_packages USING btree (created_at);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_video_packages_created unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_source_video_analysis_context ON public.source_video_analysis USING btree (source_context)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'source_video_analysis' AND indexname = 'idx_source_video_analysis_context';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_source_video_analysis_context ON public.source_video_analysis USING btree (source_context);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_source_video_analysis_context unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_source_video_analysis_user ON public.source_video_analysis USING btree (user_id)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'source_video_analysis' AND indexname = 'idx_source_video_analysis_user';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_source_video_analysis_user ON public.source_video_analysis USING btree (user_id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_source_video_analysis_user unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_source_video_analysis_video ON public.source_video_analysis USING btree (source_video_id)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'source_video_analysis' AND indexname = 'idx_source_video_analysis_video';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_source_video_analysis_video ON public.source_video_analysis USING btree (source_video_id);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_source_video_analysis_video unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_yt_search_cache_expires ON public.youtube_search_cache USING btree (expires_at)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'youtube_search_cache' AND indexname = 'idx_yt_search_cache_expires';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_yt_search_cache_expires ON public.youtube_search_cache USING btree (expires_at);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_yt_search_cache_expires unexpected definition: %', existing_def;
  END IF;
END $$;

DO $$
DECLARE existing_def text; expected_def text := 'CREATE INDEX idx_yt_search_cache_key ON public.youtube_search_cache USING btree (cache_key)';
BEGIN
  SELECT indexdef INTO existing_def FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'youtube_search_cache' AND indexname = 'idx_yt_search_cache_key';
  IF existing_def IS NULL THEN
    CREATE INDEX idx_yt_search_cache_key ON public.youtube_search_cache USING btree (cache_key);
  ELSIF existing_def <> expected_def THEN
    RAISE EXCEPTION 'idx_yt_search_cache_key unexpected definition: %', existing_def;
  END IF;
END $$;

-- ============================================================
-- RLS — explicit engedélyezés mind a 8 táblán (rls_auto_enable NEM
-- helyettesíti ezt itt, mert az event trigger maga sincs ebben a körben
-- rekonstruálva). Idempotens, biztonságos ismételten futtatni.
-- ============================================================

ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trend_candidate_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topic_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_video_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.youtube_search_cache ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- POLICY-K — hiányzó: létrehoz; egyező (permissive/cmd/qual/with_check):
-- no-op; eltérő: fail-fast. Nincs DROP POLICY.
-- ============================================================

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'user_credits' AND policyname = 'credits_select_own';
  IF NOT FOUND THEN
    CREATE POLICY credits_select_own ON public.user_credits FOR SELECT USING (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'SELECT'
     OR p.qual IS DISTINCT FROM '(auth.uid() = user_id)' OR p.with_check IS NOT NULL
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy credits_select_own unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'ai_usage_logs' AND policyname = 'usage_select_own';
  IF NOT FOUND THEN
    CREATE POLICY usage_select_own ON public.ai_usage_logs FOR SELECT USING (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'SELECT'
     OR p.qual IS DISTINCT FROM '(auth.uid() = user_id)' OR p.with_check IS NOT NULL
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy usage_select_own unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'topic_feedback' AND policyname = 'topic_feedback_select_own';
  IF NOT FOUND THEN
    CREATE POLICY topic_feedback_select_own ON public.topic_feedback FOR SELECT USING (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'SELECT'
     OR p.qual IS DISTINCT FROM '(auth.uid() = user_id)' OR p.with_check IS NOT NULL
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy topic_feedback_select_own unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'topic_feedback' AND policyname = 'topic_feedback_insert_own';
  IF NOT FOUND THEN
    CREATE POLICY topic_feedback_insert_own ON public.topic_feedback FOR INSERT WITH CHECK (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'INSERT'
     OR p.qual IS NOT NULL OR p.with_check IS DISTINCT FROM '(auth.uid() = user_id)'
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy topic_feedback_insert_own unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'video_audits' AND policyname = 'Users see own audits';
  IF NOT FOUND THEN
    CREATE POLICY "Users see own audits" ON public.video_audits FOR SELECT USING (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'SELECT'
     OR p.qual IS DISTINCT FROM '(auth.uid() = user_id)' OR p.with_check IS NOT NULL
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy "Users see own audits" unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'video_audits' AND policyname = 'Users insert own audits';
  IF NOT FOUND THEN
    CREATE POLICY "Users insert own audits" ON public.video_audits FOR INSERT WITH CHECK (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'INSERT'
     OR p.qual IS NOT NULL OR p.with_check IS DISTINCT FROM '(auth.uid() = user_id)'
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy "Users insert own audits" unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'video_packages' AND policyname = 'video_packages_select_own';
  IF NOT FOUND THEN
    CREATE POLICY video_packages_select_own ON public.video_packages FOR SELECT USING (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'SELECT'
     OR p.qual IS DISTINCT FROM '(auth.uid() = user_id)' OR p.with_check IS NOT NULL
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy video_packages_select_own unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'video_packages' AND policyname = 'video_packages_insert_own';
  IF NOT FOUND THEN
    CREATE POLICY video_packages_insert_own ON public.video_packages FOR INSERT WITH CHECK (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'INSERT'
     OR p.qual IS NOT NULL OR p.with_check IS DISTINCT FROM '(auth.uid() = user_id)'
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy video_packages_insert_own unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'video_packages' AND policyname = 'video_packages_delete_own';
  IF NOT FOUND THEN
    CREATE POLICY video_packages_delete_own ON public.video_packages FOR DELETE USING (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'DELETE'
     OR p.qual IS DISTINCT FROM '(auth.uid() = user_id)' OR p.with_check IS NOT NULL
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy video_packages_delete_own unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'source_video_analysis' AND policyname = 'source_video_analysis_select_own';
  IF NOT FOUND THEN
    CREATE POLICY source_video_analysis_select_own ON public.source_video_analysis FOR SELECT USING (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'SELECT'
     OR p.qual IS DISTINCT FROM '(auth.uid() = user_id)' OR p.with_check IS NOT NULL
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy source_video_analysis_select_own unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'source_video_analysis' AND policyname = 'source_video_analysis_insert_own';
  IF NOT FOUND THEN
    CREATE POLICY source_video_analysis_insert_own ON public.source_video_analysis FOR INSERT WITH CHECK (auth.uid() = user_id);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'INSERT'
     OR p.qual IS NOT NULL OR p.with_check IS DISTINCT FROM '(auth.uid() = user_id)'
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy source_video_analysis_insert_own unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

-- trend_candidate_cache: nincs policy (kizárólag service_role éri el — nem hiba, szándékos)

DO $$
DECLARE p RECORD;
BEGIN
  SELECT permissive, cmd, qual, with_check, roles INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'youtube_search_cache' AND policyname = 'yt_cache_select_all';
  IF NOT FOUND THEN
    CREATE POLICY yt_cache_select_all ON public.youtube_search_cache FOR SELECT USING (true);
  ELSIF p.permissive <> 'PERMISSIVE' OR p.cmd <> 'SELECT'
     OR p.qual IS DISTINCT FROM 'true' OR p.with_check IS NOT NULL
     OR p.roles <> ARRAY['public']::name[] THEN
    RAISE EXCEPTION 'policy yt_cache_select_all unexpected definition (cmd=%, qual=%, with_check=%)', p.cmd, p.qual, p.with_check;
  END IF;
END $$;

-- ============================================================
-- TRIGGEREK — hiányzó: létrehoz; egyező: no-op; eltérő: fail-fast
-- ============================================================

DO $$
DECLARE existing_def text; enabled_state "char";
  expected_def text := 'CREATE TRIGGER credits_updated_at BEFORE UPDATE ON public.user_credits FOR EACH ROW EXECUTE FUNCTION update_updated_at()';
BEGIN
  SELECT pg_get_triggerdef(t.oid), t.tgenabled INTO existing_def, enabled_state
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'user_credits' AND t.tgname = 'credits_updated_at' AND NOT t.tgisinternal;
  IF existing_def IS NULL THEN
    CREATE TRIGGER credits_updated_at BEFORE UPDATE ON public.user_credits
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  ELSIF existing_def <> expected_def OR enabled_state <> 'O' THEN
    RAISE EXCEPTION 'trigger credits_updated_at unexpected definition (def=%, enabled=%)', existing_def, enabled_state;
  END IF;
END $$;

DO $$
DECLARE existing_def text; enabled_state "char";
  expected_def text := 'CREATE TRIGGER video_packages_updated_at BEFORE UPDATE ON public.video_packages FOR EACH ROW EXECUTE FUNCTION update_updated_at()';
BEGIN
  SELECT pg_get_triggerdef(t.oid), t.tgenabled INTO existing_def, enabled_state
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'video_packages' AND t.tgname = 'video_packages_updated_at' AND NOT t.tgisinternal;
  IF existing_def IS NULL THEN
    CREATE TRIGGER video_packages_updated_at BEFORE UPDATE ON public.video_packages
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  ELSIF existing_def <> expected_def OR enabled_state <> 'O' THEN
    RAISE EXCEPTION 'trigger video_packages_updated_at unexpected definition (def=%, enabled=%)', existing_def, enabled_state;
  END IF;
END $$;

-- ============================================================
-- CREDIT SIGNUP INITIALIZATION — user_credits tulajdona
--
-- handle_new_user_credits() + on_auth_user_created_credits: egyik
-- verziókövetett migrációban sem szerepelt eddig, pedig ez hozza létre
-- automatikusan a user_credits sort minden új auth.users signupkor.
-- Enélkül egy friss rebuild után egyetlen új regisztráció sem kapna
-- kreditsort, és a spend_credits/refund_credit_spend RPC-k
-- 'user credit row not found' hibával elhalnának minden új usernél.
--
-- Ide, a 003 végére tartozik: a function body kizárólag 003-tulajdonú
-- objektumokra hivatkozik (user_credits tábla, user_id oszlop,
-- user_credits_user_id_key UNIQUE constraint az ON CONFLICT célpontjaként)
-- — egyetlen 037-es bucket-mezőt (subscription_credit_balance,
-- purchased_credit_balance) sem használ közvetlenül; azok konzisztenciáját
-- a már meglévő, független user_credits_sync_bucket_balance trigger (037)
-- biztosítja bármely azt követő INSERT/UPDATE-re.
--
-- A PUBLIC EXECUTE grant itt explicit, determinisztikus — nem a Postgres
-- create-function alapértelmezésére hagyatkozva — a production pontos
-- reprodukciójaként. Ennek indokoltságát (kell-e PUBLIC EXECUTE, kell-e
-- rögzített search_path) egy külön, későbbi hardening kör vizsgálja.
-- ============================================================

DO $outer$
DECLARE
  existing_def text;
  has_public_execute boolean;
  expected_def text := 'CREATE OR REPLACE FUNCTION public.handle_new_user_credits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO public.user_credits (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$
';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO existing_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'handle_new_user_credits' AND p.pronargs = 0;

  IF existing_def IS NULL THEN
    EXECUTE $create$
CREATE OR REPLACE FUNCTION public.handle_new_user_credits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO public.user_credits (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$
$create$;

    -- Explicit, determinisztikus grant (nem a CREATE FUNCTION alapértelmezésére hagyatkozva)
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.handle_new_user_credits() TO PUBLIC';
  ELSE
    -- Csak CRLF→LF sortörés-normalizálás — más whitespace/tartalom nem normalizálva.
    IF regexp_replace(existing_def, E'\r\n', E'\n', 'g') <> expected_def THEN
      RAISE EXCEPTION 'function handle_new_user_credits unexpected definition: %', existing_def;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.role_routine_grants
      WHERE specific_schema = 'public' AND routine_name = 'handle_new_user_credits'
        AND grantee = 'PUBLIC' AND privilege_type = 'EXECUTE'
    ) INTO has_public_execute;

    IF NOT has_public_execute THEN
      RAISE EXCEPTION 'function handle_new_user_credits missing expected PUBLIC EXECUTE grant';
    END IF;
  END IF;
END $outer$;

DO $$
DECLARE existing_def text; enabled_state "char";
  expected_def text := 'CREATE TRIGGER on_auth_user_created_credits AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user_credits()';
BEGIN
  SELECT pg_get_triggerdef(t.oid), t.tgenabled INTO existing_def, enabled_state
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'auth' AND c.relname = 'users' AND t.tgname = 'on_auth_user_created_credits' AND NOT t.tgisinternal;
  IF existing_def IS NULL THEN
    CREATE TRIGGER on_auth_user_created_credits AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION handle_new_user_credits();
  ELSIF existing_def <> expected_def OR enabled_state <> 'O' THEN
    RAISE EXCEPTION 'trigger on_auth_user_created_credits unexpected definition (def=%, enabled=%)', existing_def, enabled_state;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
