-- ============================================================
-- Migration 021: Video Ideas - Creator OS foundation
-- Cel: a tool-kozpontu eredmenyeket egy kozponti Video Idea objektum kore
--      lehessen fuzni, a meglevo flow-k torlese nelkul.
-- ============================================================

CREATE TABLE IF NOT EXISTS video_ideas (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  title                 TEXT NOT NULL,
  topic                 TEXT NOT NULL,
  short_description     TEXT,
  niche                 TEXT,

  platform              TEXT DEFAULT 'youtube',
  language              TEXT DEFAULT 'hu',
  market                TEXT DEFAULT 'HU',
  country               TEXT,
  currency              TEXT DEFAULT 'HUF',
  timezone              TEXT DEFAULT 'Europe/Budapest',
  content_format        TEXT,

  keywords              JSONB DEFAULT '[]'::jsonb,
  trend_signals         JSONB DEFAULT '[]'::jsonb,
  similar_videos        JSONB DEFAULT '[]'::jsonb,
  competitor_proof      JSONB DEFAULT '[]'::jsonb,
  source_links          JSONB DEFAULT '[]'::jsonb,

  viral_score           INTEGER CHECK (viral_score BETWEEN 0 AND 100),
  opportunity_score     INTEGER CHECK (opportunity_score BETWEEN 0 AND 100),
  competition_score     INTEGER CHECK (competition_score BETWEEN 0 AND 100),
  risk_factors          JSONB DEFAULT '[]'::jsonb,
  proof_summary         TEXT,

  title_ideas           JSONB DEFAULT '[]'::jsonb,
  hook_ideas            JSONB DEFAULT '[]'::jsonb,
  thumbnail_concepts    JSONB DEFAULT '[]'::jsonb,

  video_package_id      UUID,
  audit_result_id       UUID,
  calendar_status       TEXT DEFAULT 'none',
  publish_status        TEXT DEFAULT 'draft',
  workflow_status       TEXT NOT NULL DEFAULT 'new_idea' CHECK (workflow_status IN (
    'new_idea',
    'validating',
    'validated',
    'ready_to_produce',
    'scheduled',
    'published',
    'audited',
    'rejected',
    'archived'
  )),

  paid_result_reference UUID,
  input_hash            TEXT,
  metadata              JSONB DEFAULT '{}'::jsonb,

  created_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_ideas_user_input_hash
  ON video_ideas(user_id, input_hash)
  WHERE input_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_ideas_user_topic_platform
  ON video_ideas(user_id, lower(topic), platform, language, market);

CREATE INDEX IF NOT EXISTS idx_video_ideas_user_updated
  ON video_ideas(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_ideas_workflow_status
  ON video_ideas(user_id, workflow_status);

CREATE TABLE IF NOT EXISTS video_idea_proof_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_idea_id   UUID REFERENCES video_ideas(id) ON DELETE CASCADE NOT NULL,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  signal_type     TEXT NOT NULL CHECK (signal_type IN (
    'similar_video',
    'competitor_video',
    'web_source',
    'trend_signal',
    'keyword_signal',
    'transcript',
    'manual_note'
  )),
  source_tool     TEXT,
  source_id       TEXT,
  title           TEXT,
  url             TEXT,
  channel_title   TEXT,
  published_at    TIMESTAMPTZ,
  view_count      BIGINT,
  relevance_score INTEGER CHECK (relevance_score BETWEEN 0 AND 100),
  strength        TEXT CHECK (strength IN ('strong', 'medium', 'weak', 'rejected')),
  reason          TEXT,
  payload         JSONB DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_video_idea_proof_user
  ON video_idea_proof_signals(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_idea_proof_idea
  ON video_idea_proof_signals(video_idea_id);

CREATE TABLE IF NOT EXISTS video_idea_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_idea_id   UUID REFERENCES video_ideas(id) ON DELETE CASCADE NOT NULL,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  event_type      TEXT NOT NULL,
  source_tool     TEXT,
  payload         JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_video_idea_events_idea
  ON video_idea_events(video_idea_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_idea_events_user
  ON video_idea_events(user_id, created_at DESC);

ALTER TABLE video_ideas ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_idea_proof_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_idea_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "video_ideas_select_own" ON video_ideas
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "video_ideas_insert_own" ON video_ideas
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "video_ideas_update_own" ON video_ideas
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "video_ideas_delete_own" ON video_ideas
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "video_idea_proof_select_own" ON video_idea_proof_signals
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "video_idea_proof_insert_own" ON video_idea_proof_signals
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "video_idea_events_select_own" ON video_idea_events
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "video_idea_events_insert_own" ON video_idea_events
  FOR INSERT WITH CHECK (auth.uid() = user_id);

GRANT ALL ON video_ideas TO service_role;
GRANT ALL ON video_idea_proof_signals TO service_role;
GRANT ALL ON video_idea_events TO service_role;

ALTER TABLE creator_memory
  ADD COLUMN IF NOT EXISTS video_idea_id UUID REFERENCES video_ideas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_creator_memory_video_idea
  ON creator_memory(video_idea_id);

ALTER TABLE paid_results
  ADD COLUMN IF NOT EXISTS linked_video_idea_id UUID REFERENCES video_ideas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS prompt_template_id TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC;

CREATE INDEX IF NOT EXISTS idx_paid_results_video_idea
  ON paid_results(linked_video_idea_id);

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
    'analyzer'
  ));

DO $$
BEGIN
  IF to_regclass('public.video_packages') IS NOT NULL THEN
    ALTER TABLE video_packages
      ADD COLUMN IF NOT EXISTS video_idea_id UUID REFERENCES video_ideas(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_video_packages_video_idea
      ON video_packages(video_idea_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION update_video_ideas_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS video_ideas_updated_at ON video_ideas;
CREATE TRIGGER video_ideas_updated_at
  BEFORE UPDATE ON video_ideas
  FOR EACH ROW EXECUTE FUNCTION update_video_ideas_updated_at();

NOTIFY pgrst, 'reload schema';
