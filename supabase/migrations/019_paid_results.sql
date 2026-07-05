-- ============================================================
-- Migration 019: paid_results — egységes fizetett eredmény-kezelés
-- Cél: amit a user egyszer lefuttatott / megvett, az később paid_result_id
-- vagy stabil input_hash alapján újranyitható legyen kredit és új API keresés nélkül.
-- ============================================================

CREATE TABLE IF NOT EXISTS paid_results (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  tool_type         TEXT NOT NULL CHECK (tool_type IN (
    'viral_score',
    'similar_videos',
    'opportunity_engine',
    'video_audit',
    'video_package',
    'content_gap',
    'analyzer'
  )),

  input_hash        TEXT NOT NULL,
  normalized_input  TEXT NOT NULL,
  original_input    TEXT NOT NULL,
  main_category     TEXT,
  specific_focus    TEXT,
  region            TEXT,
  language          TEXT,
  platform          TEXT,

  result_json       JSONB NOT NULL,
  summary_json      JSONB DEFAULT '{}'::jsonb,
  credit_cost       NUMERIC DEFAULT 0,
  status            TEXT DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'refreshed', 'archived')),

  created_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_opened_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_refreshed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  fresh_until       TIMESTAMPTZ,
  source_run_id     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_paid_results_user_tool_hash
  ON paid_results(user_id, tool_type, input_hash);

CREATE INDEX IF NOT EXISTS idx_paid_results_user_created
  ON paid_results(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paid_results_tool
  ON paid_results(tool_type);

ALTER TABLE paid_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "paid_results_select_own" ON paid_results
  FOR SELECT USING (auth.uid() = user_id);

GRANT ALL ON paid_results TO service_role;

NOTIFY pgrst, 'reload schema';
