-- ============================================================
-- Migration 017: Trend Feed napi snapshot
-- Cél: a napi (ingyenes vagy fizetett) Trend Feed ajánlás eredménye
-- megmaradjon per nap, hogy a user vissza tudja nézni a tegnapi (vagy
-- korábbi) ajánlást is — jelenleg az opportunity_cache felülíródik
-- niche+platform+region+language kulcs szerint, nincs napi történet.
-- ============================================================

CREATE TABLE IF NOT EXISTS trend_feed_daily_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  snapshot_date DATE NOT NULL,
  niche       TEXT,
  topics      JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  UNIQUE(user_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_trend_feed_daily_snapshots_user ON trend_feed_daily_snapshots(user_id, snapshot_date);

ALTER TABLE trend_feed_daily_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trend_feed_daily_snapshots_select_own" ON trend_feed_daily_snapshots
  FOR SELECT USING (auth.uid() = user_id);

GRANT ALL ON trend_feed_daily_snapshots TO service_role;

NOTIFY pgrst, 'reload schema';
