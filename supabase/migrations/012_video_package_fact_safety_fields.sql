-- ============================================================
-- Migration 012: Video Package Fact Safety mezők
-- A meglévő verified_fact_block TEXT oszlop változatlan marad
-- (kompatibilitás miatt). Az új Fact Safety Layer strukturált
-- adata külön JSONB/TEXT mezőkbe kerül — nincs kockázatos
-- oszlop-átalakítás.
-- ============================================================

ALTER TABLE video_packages
  ADD COLUMN IF NOT EXISTS verified_fact_block_json JSONB,
  ADD COLUMN IF NOT EXISTS forbidden_claims JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS sources_used JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS quality_status TEXT,
  ADD COLUMN IF NOT EXISTS content_type TEXT,
  ADD COLUMN IF NOT EXISTS strict_fact_mode BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS intensity_original TEXT,
  ADD COLUMN IF NOT EXISTS intensity_final TEXT;

CREATE INDEX IF NOT EXISTS idx_video_packages_quality_status ON video_packages(quality_status);
CREATE INDEX IF NOT EXISTS idx_video_packages_content_type ON video_packages(content_type);

NOTIFY pgrst, 'reload schema';
