-- ============================================================
-- Migration 016: Similar Videos perzisztens eredmény-cache
-- Cél: ha a user már kifizetett egy Similar Videos keresést egy témára,
-- az újranyitás (más session, más nap) ne induljon új fizetős kereséssel —
-- a mentett eredmény jöjjön vissza az adatbázisból, kredit levonás nélkül.
-- Csak az explicit "Frissítés" gomb (force_refresh) indít új, fizetős keresést.
-- ============================================================

CREATE TABLE IF NOT EXISTS similar_video_searches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  normalized_topic      TEXT NOT NULL,
  original_topic        TEXT NOT NULL,
  search_context_hash   TEXT NOT NULL,
  region                TEXT,
  language              TEXT,
  platform              TEXT,

  query_variants        JSONB DEFAULT '[]',
  results               JSONB NOT NULL,
  result_count          INTEGER DEFAULT 0,
  credit_cost           NUMERIC DEFAULT 0,

  status                TEXT DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'expired')),
  source                TEXT DEFAULT 'similar_videos',

  created_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_opened_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_refreshed_at     TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  UNIQUE(user_id, search_context_hash)
);

CREATE INDEX IF NOT EXISTS idx_similar_video_searches_user ON similar_video_searches(user_id);
CREATE INDEX IF NOT EXISTS idx_similar_video_searches_hash ON similar_video_searches(search_context_hash);

ALTER TABLE similar_video_searches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "similar_video_searches_select_own" ON similar_video_searches
  FOR SELECT USING (auth.uid() = user_id);

GRANT ALL ON similar_video_searches TO service_role;

NOTIFY pgrst, 'reload schema';
