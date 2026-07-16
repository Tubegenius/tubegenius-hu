ALTER TABLE tracked_competitors
  ADD COLUMN IF NOT EXISTS alert_frequency TEXT NOT NULL DEFAULT 'daily'
  CHECK (alert_frequency IN ('daily', 'weekly', 'off')),
  ADD COLUMN IF NOT EXISTS vph_alert_threshold NUMERIC NOT NULL DEFAULT 100
  CHECK (vph_alert_threshold >= 1 AND vph_alert_threshold <= 1000000000);

CREATE TABLE IF NOT EXISTS competitor_alert_dismissals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  tracked_competitor_id UUID REFERENCES tracked_competitors(id) ON DELETE CASCADE NOT NULL,
  video_id TEXT NOT NULL,
  alert_signature TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, tracked_competitor_id, video_id, alert_signature)
);
ALTER TABLE competitor_alert_dismissals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "competitor_alert_dismissals_select_own" ON competitor_alert_dismissals FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "competitor_alert_dismissals_insert_own" ON competitor_alert_dismissals FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT ALL ON competitor_alert_dismissals TO service_role;
NOTIFY pgrst, 'reload schema';
