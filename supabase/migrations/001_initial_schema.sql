-- ============================================================
-- WILLVIRAL — Supabase Database Schema
-- Migration: 001_initial_schema
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- fuzzy search

-- ============================================================
-- PROFILES — Creator profilok
-- ============================================================

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  
  -- Creator Identity
  channel_name TEXT,
  platform TEXT NOT NULL DEFAULT 'youtube' 
    CHECK (platform IN ('youtube', 'tiktok', 'instagram', 'facebook')),
  language TEXT NOT NULL DEFAULT 'hu' 
    CHECK (language IN ('hu', 'en')),
  niche TEXT NOT NULL DEFAULT '',
  video_length TEXT NOT NULL DEFAULT 'medium'
    CHECK (video_length IN ('short', 'medium', 'long')),
  creator_level TEXT NOT NULL DEFAULT 'growing'
    CHECK (creator_level IN ('beginner', 'growing', 'advanced', 'professional')),
  
  -- YouTube specifikus
  youtube_channel_id TEXT,
  subscriber_count INTEGER,
  
  -- Regionális beállítás
  region TEXT NOT NULL DEFAULT 'HU'
    CHECK (region IN ('HU', 'US', 'BOTH')),
  
  -- Onboarding állapot
  onboarding_completed BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- OPPORTUNITY_CACHE — 24 órás Opportunity Engine cache
-- ============================================================

CREATE TABLE opportunity_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Cache key: niche + platform + region + language
  cache_key TEXT NOT NULL UNIQUE,
  
  -- Generált témák (JSON array)
  topics JSONB NOT NULL DEFAULT '[]',
  
  -- Cache metadata
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
  
  -- Ki generálta (opcionális, debug céljából)
  generated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Index a lejárt cache-ek gyors törléséhez
CREATE INDEX idx_opportunity_cache_expires ON opportunity_cache(expires_at);
CREATE INDEX idx_opportunity_cache_key ON opportunity_cache(cache_key);

-- ============================================================
-- CREATOR_MEMORY — Téma állapotok nyilvántartása
-- ============================================================

CREATE TABLE creator_memory (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  
  -- Téma adatok
  topic TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'saved'
    CHECK (state IN ('saved', 'in_progress', 'completed', 'rejected')),
  
  -- Score adatok (opcionális)
  opportunity_score INTEGER CHECK (opportunity_score BETWEEN 0 AND 100),
  viral_score INTEGER CHECK (viral_score BETWEEN 0 AND 100),
  
  -- Platform
  platform TEXT DEFAULT 'youtube',
  
  -- Felhasználói jegyzetek
  notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Egy user-nek egy témája egyedi
  UNIQUE(user_id, topic)
);

CREATE INDEX idx_creator_memory_user ON creator_memory(user_id);
CREATE INDEX idx_creator_memory_state ON creator_memory(state);

-- ============================================================
-- VIRAL_SCORE_CACHE — Viral score eredmények cache-elése
-- ============================================================

CREATE TABLE viral_score_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Cache key: topic + platform + region
  cache_key TEXT NOT NULL UNIQUE,
  
  -- Eredmény
  result JSONB NOT NULL,
  
  -- Cache időtartam: 6 óra
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '6 hours')
);

CREATE INDEX idx_viral_score_cache_expires ON viral_score_cache(expires_at);
CREATE INDEX idx_viral_score_cache_key ON viral_score_cache(cache_key);

-- ============================================================
-- USAGE_LOGS — Használat naplózása (MVP után analytics)
-- ============================================================

CREATE TABLE usage_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  
  action TEXT NOT NULL, -- 'opportunity_engine', 'viral_score', 'script_extract', etc.
  metadata JSONB DEFAULT '{}',
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_usage_logs_user ON usage_logs(user_id);
CREATE INDEX idx_usage_logs_action ON usage_logs(action);
CREATE INDEX idx_usage_logs_created ON usage_logs(created_at);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- Profiles: csak saját profil olvasható/írható
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "profiles_insert_own" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (auth.uid() = user_id);

-- Creator Memory: csak saját témák
ALTER TABLE creator_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memory_select_own" ON creator_memory
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "memory_insert_own" ON creator_memory
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "memory_update_own" ON creator_memory
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "memory_delete_own" ON creator_memory
  FOR DELETE USING (auth.uid() = user_id);

-- Opportunity Cache: mindenki olvashatja, csak szerver írhatja
ALTER TABLE opportunity_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "opportunity_cache_select_all" ON opportunity_cache
  FOR SELECT USING (true);

-- Viral Score Cache: mindenki olvashatja
ALTER TABLE viral_score_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "viral_cache_select_all" ON viral_score_cache
  FOR SELECT USING (true);

-- Usage Logs: csak saját logok
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_logs_select_own" ON usage_logs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "usage_logs_insert_own" ON usage_logs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER memory_updated_at
  BEFORE UPDATE ON creator_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-create profile on user registration
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Cleanup lejárt cache-ek (hívható periodikusan)
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS void AS $$
BEGIN
  DELETE FROM opportunity_cache WHERE expires_at < NOW();
  DELETE FROM viral_score_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
