CREATE TABLE IF NOT EXISTS competitor_performance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_competitor_id UUID REFERENCES tracked_competitors(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  video_id TEXT,
  view_count BIGINT NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  subscriber_count BIGINT CHECK (subscriber_count IS NULL OR subscriber_count >= 0),
  channel_total_views BIGINT CHECK (channel_total_views IS NULL OR channel_total_views >= 0),
  channel_video_count INTEGER CHECK (channel_video_count IS NULL OR channel_video_count >= 0),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_channel_time
  ON competitor_performance_snapshots(tracked_competitor_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_video_time
  ON competitor_performance_snapshots(tracked_competitor_id, video_id, checked_at DESC)
  WHERE video_id IS NOT NULL;

ALTER TABLE competitor_performance_snapshots ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "competitor_snapshots_select_own" ON competitor_performance_snapshots
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "competitor_snapshots_insert_own" ON competitor_performance_snapshots
    FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT ALL ON competitor_performance_snapshots TO service_role;
