-- ============================================================
-- Migration 023: Phase 2 modulok alapja
-- Cel: sema-elokeszites a mesterterv Phase 2 (Versenykepes creator
--      platform funkciok) 10 moduljahoz, EGY menetben, hogy ne kelljen
--      tobbszor visszaterni a SQL Editorhoz.
-- ============================================================

-- ── paid_results uj tool_type ertekek (Keyword Research, Competitor
-- Tracker, Outlier Detector, Title Studio, Thumbnail Studio, SEO
-- Optimizer) — 'content_gap' es 'analyzer' mar letezik a 021-es migraciobol.
ALTER TABLE paid_results
  DROP CONSTRAINT IF EXISTS paid_results_tool_type_check;

ALTER TABLE paid_results
  ADD CONSTRAINT paid_results_tool_type_check CHECK (tool_type IN (
    'viral_score',
    'similar_videos',
    'opportunity_engine',
    'video_audit',
    'video_package',
    'script_extract',
    'transcript_extract',
    'content_gap',
    'analyzer',
    'keyword_research',
    'competitor_tracker',
    'outlier_detector',
    'title_studio',
    'thumbnail_studio',
    'seo_optimizer'
  ));

-- ── Competitor Tracker ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tracked_competitors (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  channel_id          TEXT NOT NULL,
  channel_title       TEXT NOT NULL,
  channel_thumbnail   TEXT,
  channel_url         TEXT,
  platform            TEXT DEFAULT 'youtube',
  niche               TEXT,

  -- A csatorna "atlag" alapertek (utolso ismert allapot) — ehhez viszonyitva
  -- szamit outliernek egy uj videoja. Frissul minden ellenorzeskor.
  baseline_video_count   INTEGER,
  baseline_avg_views     BIGINT,
  baseline_subscriber_count BIGINT,

  last_checked_at     TIMESTAMPTZ,
  added_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  UNIQUE(user_id, channel_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_tracked_competitors_user
  ON tracked_competitors(user_id, added_at DESC);

ALTER TABLE tracked_competitors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tracked_competitors_select_own" ON tracked_competitors
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "tracked_competitors_insert_own" ON tracked_competitors
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "tracked_competitors_update_own" ON tracked_competitors
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "tracked_competitors_delete_own" ON tracked_competitors
  FOR DELETE USING (auth.uid() = user_id);

GRANT ALL ON tracked_competitors TO service_role;

CREATE OR REPLACE FUNCTION update_tracked_competitors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tracked_competitors_updated_at ON tracked_competitors;
CREATE TRIGGER tracked_competitors_updated_at
  BEFORE UPDATE ON tracked_competitors
  FOR EACH ROW EXECUTE FUNCTION update_tracked_competitors_updated_at();

-- ── Competitor videok (a tracked csatornakhoz tartozo, latott videok —
-- ebbol szamit az Outlier Detector, es ebbol lehet proof signal-t menteni) ──
CREATE TABLE IF NOT EXISTS tracked_competitor_videos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_competitor_id UUID REFERENCES tracked_competitors(id) ON DELETE CASCADE NOT NULL,
  user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  video_id            TEXT NOT NULL,
  title               TEXT,
  thumbnail_url       TEXT,
  view_count          BIGINT,
  like_count          BIGINT,
  comment_count       BIGINT,
  published_at        TIMESTAMPTZ,

  -- Outlier: hanyszorosa a csatorna sajat atlaganak (pl. 4.2 = "4.2x jobban
  -- teljesit a csatorna atlaganal")
  outlier_ratio        NUMERIC,
  is_outlier            BOOLEAN DEFAULT FALSE,

  first_seen_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  UNIQUE(tracked_competitor_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_tracked_competitor_videos_competitor
  ON tracked_competitor_videos(tracked_competitor_id, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracked_competitor_videos_outlier
  ON tracked_competitor_videos(user_id, is_outlier) WHERE is_outlier = TRUE;

ALTER TABLE tracked_competitor_videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tracked_competitor_videos_select_own" ON tracked_competitor_videos
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "tracked_competitor_videos_insert_own" ON tracked_competitor_videos
  FOR INSERT WITH CHECK (auth.uid() = user_id);

GRANT ALL ON tracked_competitor_videos TO service_role;

-- ── Trend Alerts — "mar lattam/elutasitottam ezt a mozgast" jelzes,
-- hogy a Command Center ne mutassa ujra ugyanazt a mar kezelt jelzest ──
CREATE TABLE IF NOT EXISTS trend_alert_dismissals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  tracked_candidate_id  UUID REFERENCES tracked_trend_candidates(id) ON DELETE CASCADE NOT NULL,
  -- Melyik "jelzes-generacio" lett elutasitva — ha a trend ujra mozog,
  -- uj signature-t kap, es ujra megjelenik az alert.
  alert_signature       TEXT NOT NULL,
  dismissed_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  UNIQUE(user_id, tracked_candidate_id, alert_signature)
);

CREATE INDEX IF NOT EXISTS idx_trend_alert_dismissals_user
  ON trend_alert_dismissals(user_id);

ALTER TABLE trend_alert_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trend_alert_dismissals_select_own" ON trend_alert_dismissals
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "trend_alert_dismissals_insert_own" ON trend_alert_dismissals
  FOR INSERT WITH CHECK (auth.uid() = user_id);

GRANT ALL ON trend_alert_dismissals TO service_role;

NOTIFY pgrst, 'reload schema';
