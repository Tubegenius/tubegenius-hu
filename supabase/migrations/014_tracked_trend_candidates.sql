-- ============================================================
-- Migration 014: Tracked Trend Candidates — limitált háttérfrissítés
-- Nem teljes crawler. Csak a userek szempontjából fontos candidate-eket
-- (mentett, videócsomaggá vált, magas confidence/score, friss trend)
-- követjük, és a háttérfrissítés is csak a MÁR ISMERT youtube_video_ids
-- statisztikáit kéri le újra (videos.list), nem indít új keresést.
-- ============================================================

CREATE TABLE IF NOT EXISTS tracked_trend_candidates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  candidate_topic   TEXT NOT NULL,
  niche             TEXT,
  region            TEXT,
  language          TEXT,
  trend_source_type TEXT,
  confidence        TEXT,
  opportunity_score INTEGER,

  youtube_video_ids JSONB DEFAULT '[]',
  web_source_ids    JSONB DEFAULT '[]',

  created_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_checked_at   TIMESTAMPTZ,
  next_check_at     TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  refresh_priority  TEXT DEFAULT 'normal' CHECK (refresh_priority IN ('high', 'normal', 'low')),
  status            TEXT DEFAULT 'active' CHECK (status IN ('active', 'stopped')),

  UNIQUE(user_id, candidate_topic)
);

CREATE INDEX IF NOT EXISTS idx_tracked_candidates_next_check ON tracked_trend_candidates(next_check_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tracked_candidates_user ON tracked_trend_candidates(user_id);

CREATE TABLE IF NOT EXISTS trend_candidate_snapshots (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_candidate_id        UUID NOT NULL REFERENCES tracked_trend_candidates(id) ON DELETE CASCADE,

  checked_at                  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  avg_opportunity_score       NUMERIC,
  avg_viral_score             NUMERIC,
  total_views                 BIGINT DEFAULT 0,
  total_likes                 BIGINT DEFAULT 0,
  total_comments              BIGINT DEFAULT 0,
  youtube_relevant_videos_count INTEGER DEFAULT 0,
  serper_evidence_count       INTEGER DEFAULT 0,
  engagement_rate             NUMERIC,
  views_delta                 BIGINT,
  trend_velocity              NUMERIC,
  trend_status                TEXT CHECK (trend_status IN ('rising', 'stable', 'declining'))
);

CREATE INDEX IF NOT EXISTS idx_trend_snapshots_candidate ON trend_candidate_snapshots(tracked_candidate_id);
CREATE INDEX IF NOT EXISTS idx_trend_snapshots_checked ON trend_candidate_snapshots(checked_at);

-- RLS — user csak a saját tracked candidate-jeit láthatja, írás csak service_role-lal (háttérjob)
ALTER TABLE tracked_trend_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE trend_candidate_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tracked_candidates_select_own" ON tracked_trend_candidates
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "trend_snapshots_select_own" ON trend_candidate_snapshots
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM tracked_trend_candidates t
      WHERE t.id = trend_candidate_snapshots.tracked_candidate_id AND t.user_id = auth.uid()
    )
  );

GRANT ALL ON tracked_trend_candidates TO service_role;
GRANT ALL ON trend_candidate_snapshots TO service_role;

NOTIFY pgrst, 'reload schema';
