-- ============================================================
-- Migration 029: Csatorna-elso onboarding + channel_usage_mode
-- ============================================================
-- Cel: (A) a Channel Audit oldalon egy publikus "Channel Header Card"
--      jelenjen meg (avatar, cim, feliratkozok, osszes megtekintes,
--      videoszam) OAuth nelkul is, legalabb 24 orara cache-elve
--      (channel_synced_at), hogy ne kelljen minden oldalbetoltesnel
--      ujra hivni a channels.list-et; (B) az onboarding (=
--      app/dashboard/profile/page.tsx) elkerdezze, hogyan hasznalja a
--      WillViral a user YouTube csatornajat (channel_usage_mode), es
--      ezt a tobbi modul (Title Studio, SEO, stb.) egysegesen figyelembe
--      vegye a niche-injektalasnal (lib/creator-profile-context.ts).
--
-- NEM duplikalunk mar letezo fogalmakat: az aktiv niche tovabbra is
-- niche/main_category/specific_focus, a celkozonseg audience, a piac
-- region, a csatorna neve/azonositoja/feliratkozoszama pedig a MAR
-- LETEZO channel_name/youtube_channel_id/subscriber_count oszlopokat
-- hasznalja (ezek migracio 001 ota leteznek, de sosem voltak bekotve
-- semmilyen csatorna-felismeresi folyamatba — ez a migracio ezt oldja
-- fel, uj oszlopok nelkul ismetelve oket).
--
-- channel_synced_at KULON oszlop, nem az youtube_oauth_tokens.updated_at
-- ujrahasznositasa: azt mar orankent irja az OAuth token-refresh utvonal,
-- fuggetlenul attol, hogy a csatorna-snippet ujra le lett-e kerdezve — ha
-- arra tamaszkodnank cache-frissesegi jelzeskent, a cache aktiv usereknel
-- gyakorlatilag sosem ervenytelenedne. last_channel_audit_at pedig egy
-- MASIK fogalom (a Videodiagnozis/audit-history utolso futasa), nem a
-- csatorna-kijelzo-adatok szinkronjaje.
--
-- active_channel_id / channel_connection_type: a public (URL/handle,
-- onboardingban megadott, profiles.youtube_channel_id) es az OAuth
-- (youtube_oauth_tokens.channel_id) csatorna-azonossag ELTERHET. Ha
-- eltero, sosem irjuk felul automatikusan — a user valaszt, a valasztas
-- ezekbe a mezokbe kerul (lasd lib/channel-profile-sync.ts).
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS channel_usage_mode TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS youtube_channel_url TEXT,
  ADD COLUMN IF NOT EXISTS youtube_handle TEXT,
  ADD COLUMN IF NOT EXISTS channel_avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS channel_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_view_count BIGINT,
  ADD COLUMN IF NOT EXISTS video_count INTEGER,
  ADD COLUMN IF NOT EXISTS channel_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_channel_audit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS detected_niche_candidates JSONB,
  ADD COLUMN IF NOT EXISTS niche_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS selected_main_niche TEXT,
  ADD COLUMN IF NOT EXISTS active_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS channel_connection_type TEXT;

-- channel_usage_mode ervenyes ertekei — a profil oldal 4-vlasztos kerdese.
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_channel_usage_mode_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_channel_usage_mode_check
  CHECK (channel_usage_mode IN ('primary_profile', 'stats_only', 'niche_discovery', 'manual'));

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_channel_connection_type_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_channel_connection_type_check
  CHECK (channel_connection_type IS NULL OR channel_connection_type IN ('public', 'oauth', 'mismatch'));

CREATE INDEX IF NOT EXISTS idx_profiles_channel_usage_mode ON profiles(channel_usage_mode);

NOTIFY pgrst, 'reload schema';
