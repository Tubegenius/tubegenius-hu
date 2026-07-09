-- ============================================================
-- Migration 024: creator_memory hianyzo oszlopok
-- Cel: app/api/memory/route.ts POST kezelője regota felteteliesen ir
--      source_context es quality_status mezoket, de ezek sosem leteztek
--      a valos semaban — barmely hivo, amely ezekkel truthy erteket
--      kuldott, 500-as hibat kapott csendben. A Keyword Research modul
--      "Mentes" gombjanak elo tesztje leplezte le.
-- ============================================================

ALTER TABLE creator_memory
  ADD COLUMN IF NOT EXISTS source_context TEXT,
  ADD COLUMN IF NOT EXISTS quality_status TEXT;

NOTIFY pgrst, 'reload schema';
