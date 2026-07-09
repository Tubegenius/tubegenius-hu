-- ============================================================
-- Migration 025: Content Calendar mezok (Phase 2 #7)
-- Cel: a video_ideas.calendar_status mar letezik es frissul (Video Package
--      "Naptarba mentes" gomb), de nincs hozza tartozo publikalasi datum/
--      megjegyzes mezo — a mesterterv explicit keri ezeket a Calendarhoz.
-- ============================================================

ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS scheduled_publish_date DATE,
  ADD COLUMN IF NOT EXISTS calendar_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_video_ideas_scheduled_publish_date
  ON video_ideas(user_id, scheduled_publish_date)
  WHERE scheduled_publish_date IS NOT NULL;

NOTIFY pgrst, 'reload schema';
