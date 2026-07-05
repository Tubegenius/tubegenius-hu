-- Migration 020: paid_results tool_type bovitese Script Extractorral
-- A Script Extractor is kredites, ezert kulon tool_type-kent kell latszodnia.

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
    'content_gap',
    'analyzer'
  ));

NOTIFY pgrst, 'reload schema';