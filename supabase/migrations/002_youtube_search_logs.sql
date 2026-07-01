-- YouTube search usage logging tábla
CREATE TABLE IF NOT EXISTS youtube_search_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  feature_name TEXT NOT NULL,
  query TEXT,
  search_count INTEGER DEFAULT 1,
  was_cached BOOLEAN DEFAULT false,
  plan_type TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_youtube_search_logs_user_date
  ON youtube_search_logs(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_youtube_search_logs_feature_date
  ON youtube_search_logs(feature_name, created_at);

ALTER TABLE youtube_search_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own search logs"
  ON youtube_search_logs FOR SELECT
  USING (auth.uid() = user_id);
