-- Proof/event rows must belong to the same tenant as their parent Video Idea.

DROP POLICY IF EXISTS "video_idea_proof_insert_own" ON public.video_idea_proof_signals;
CREATE POLICY "video_idea_proof_insert_own" ON public.video_idea_proof_signals
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND EXISTS (
      SELECT 1 FROM public.video_ideas vi
      WHERE vi.id = video_idea_id AND vi.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "video_idea_events_insert_own" ON public.video_idea_events;
CREATE POLICY "video_idea_events_insert_own" ON public.video_idea_events
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND EXISTS (
      SELECT 1 FROM public.video_ideas vi
      WHERE vi.id = video_idea_id AND vi.user_id = auth.uid()
    )
  );

-- Remove historical duplicates before enforcing stable proof identity.
DELETE FROM public.video_idea_proof_signals a
USING public.video_idea_proof_signals b
WHERE a.id > b.id
  AND a.video_idea_id = b.video_idea_id
  AND a.signal_type = b.signal_type
  AND COALESCE(a.source_tool, '') = COALESCE(b.source_tool, '')
  AND COALESCE(a.source_id, '') = COALESCE(b.source_id, '')
  AND COALESCE(a.url, '') = COALESCE(b.url, '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_idea_proof_identity
  ON public.video_idea_proof_signals (video_idea_id, signal_type, source_tool, source_id, url)
  NULLS NOT DISTINCT;

NOTIFY pgrst, 'reload schema';
