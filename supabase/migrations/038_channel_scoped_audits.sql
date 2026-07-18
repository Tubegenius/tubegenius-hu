-- ============================================================
-- Migration 038: Channel-scoped audits + explicit niche review
-- ============================================================
-- Existing audits intentionally remain unassigned. Their source channel
-- cannot be proven safely, so no automatic backfill is performed.

ALTER TABLE video_audits
  ADD COLUMN IF NOT EXISTS youtube_channel_id TEXT;

CREATE INDEX IF NOT EXISTS idx_video_audits_user_channel_created
  ON video_audits(user_id, youtube_channel_id, created_at DESC);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS niche_validated_for_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS niche_needs_review BOOLEAN NOT NULL DEFAULT FALSE;

NOTIFY pgrst, 'reload schema';
