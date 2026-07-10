-- ============================================================
-- Migration 026: paid_results tool_type bovitese
-- Cel: Hotfix Sprint C1 (Opportunity "Mutass mast"/"Mutass hasonlot")
--      es H3 (Channel Audit) - mindkettonek eddig NEM volt sajat
--      tool_type erteke, ezert nem tudtak menteni a paid_results
--      tablaba, es refresh utan elveszett a fizetett eredmeny.
-- ============================================================

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
    'analyzer',
    'keyword_research',
    'competitor_tracker',
    'outlier_detector',
    'title_studio',
    'thumbnail_studio',
    'seo_optimizer',
    'opportunity_explain',
    'channel_audit'
  ));

NOTIFY pgrst, 'reload schema';
