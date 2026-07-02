-- ============================================================
-- Migration 015: Strukturált niche input (fő kategória + specifikus fókusz)
-- A régi `niche` TEXT mező megmarad kompatibilitás miatt (legacy_niche-ként
-- töltjük fel: "{kategória}: {fókusz}"), de az új modulok a strukturált
-- mezőkből épített search contextet használják.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS main_category TEXT,
  ADD COLUMN IF NOT EXISTS specific_focus TEXT,
  ADD COLUMN IF NOT EXISTS audience TEXT,
  ADD COLUMN IF NOT EXISTS avoid_topics TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_main_category ON profiles(main_category);

NOTIFY pgrst, 'reload schema';
