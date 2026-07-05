-- ============================================================
-- Migration 018: Viral Score perzisztens, user-szintű eredmény-cache
-- Cél: a korábbi viral_score_cache tábla NEM volt user-hez kötve (bárki
-- ugyanazt a cache-elt eredményt kapta vissza ugyanarra a topic/platform/
-- region kombinációra, kredit nélkül) ÉS csak 6 órás lejárattal működött —
-- utána a user, aki már fizetett érte, újra fizetni kényszerült.
-- Ez a tábla a Similar Videos perzisztens cache-ét (016_similar_video_searches)
-- követi: user_id + search_context_hash kulcs, lejárat nélküli megőrzés —
-- a "friss vs. korábbi mentett" állapotot a hívó oldal (app kód) dönti el
-- last_refreshed_at alapján, nem a tábla törli/rejti el az adatot.
-- ============================================================

CREATE TABLE IF NOT EXISTS viral_score_searches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  normalized_topic      TEXT NOT NULL,
  original_topic        TEXT NOT NULL,
  search_context_hash   TEXT NOT NULL,
  region                TEXT,
  platform              TEXT,

  result                JSONB NOT NULL,
  score                 INTEGER,
  credit_cost           NUMERIC DEFAULT 0,

  status                TEXT DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),

  created_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_opened_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_refreshed_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  UNIQUE(user_id, search_context_hash)
);

CREATE INDEX IF NOT EXISTS idx_viral_score_searches_user ON viral_score_searches(user_id);
CREATE INDEX IF NOT EXISTS idx_viral_score_searches_hash ON viral_score_searches(search_context_hash);

ALTER TABLE viral_score_searches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "viral_score_searches_select_own" ON viral_score_searches
  FOR SELECT USING (auth.uid() = user_id);

GRANT ALL ON viral_score_searches TO service_role;

NOTIFY pgrst, 'reload schema';
