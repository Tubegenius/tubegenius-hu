ALTER TABLE tracked_trend_candidates
  ADD COLUMN IF NOT EXISTS alert_frequency TEXT NOT NULL DEFAULT 'daily'
  CHECK (alert_frequency IN ('daily', 'weekly', 'off'));

NOTIFY pgrst, 'reload schema';
