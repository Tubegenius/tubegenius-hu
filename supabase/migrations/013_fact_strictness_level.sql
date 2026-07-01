-- ============================================================
-- Migration 013: Fact Strictness Level (standard_news / high_risk)
-- A strict_fact_mode mostantól két szinten triggerelhet:
-- - standard_news: általános hír/esemény/gazdasági-tech-tudományos-
--   politikai fejlemény — enyhébb tiltások
-- - high_risk: konkrét személy/botrány/vád/politikai konfliktus/
--   egészség/jog/pénzügy/bűnügy/családi kapcsolat/tisztség/idézet —
--   szigorúbb tiltások, több forrás szükséges
-- ============================================================

ALTER TABLE video_packages
  ADD COLUMN IF NOT EXISTS fact_strictness_level TEXT;

CREATE INDEX IF NOT EXISTS idx_video_packages_fact_strictness_level ON video_packages(fact_strictness_level);

NOTIFY pgrst, 'reload schema';
