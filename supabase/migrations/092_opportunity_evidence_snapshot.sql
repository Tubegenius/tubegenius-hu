-- ============================================================
-- Migration 092: Opportunity Evidence Snapshot
--
-- PROBLEM (proven live on staging, 2026-09-27): an Opportunity Engine
-- recommendation's evidence (description, hook, score breakdown, web/video
-- sources) lives ONLY in the browser's sessionStorage for the lifetime of
-- one tab. Saving the recommendation to creator_memory persists only
-- topic/search_keyword/opportunity_score/platform -- the evidence is lost
-- the moment the user reopens the saved idea in a new session or device.
--
-- FIX: a dedicated, versioned, owner-scoped snapshot table, written
-- exclusively through SECURITY DEFINER RPCs that re-derive the evidence
-- from the user's OWN previously-saved paid_results row (never trust
-- client-supplied score/sources/timestamps -- see the two RPCs' callers
-- in the application layer, which resolve paid_result_id+topic_id server-
-- side before ever calling these functions).
--
-- SCOPE, EXPLICITLY STATED:
--   * ONE new table + RLS + 3 functions (1 internal, 2 public RPCs).
--   * Video-idea creation itself (ensureVideoIdea, TS-orchestrated,
--     natural-key dedup + PATCH semantics) is NOT folded into these RPCs'
--     transactions -- it is already idempotent and safely retryable on its
--     own, and a partial state of "idea exists, no snapshot yet" is
--     already a valid, gracefully-handled state in the application (the
--     same UI path as a pre-migration idea with no snapshot at all). This
--     is a deliberate scope decision, not an oversight -- reimplementing
--     ensureVideoIdea's PATCH-semantics dedup logic a second time in SQL
--     would duplicate non-trivial business logic for no added correctness
--     benefit. What IS made atomic (this migration's actual job): the
--     creator_memory + video_idea_events + snapshot write for the
--     save-to-memory path (save_opportunity_recommendation_to_memory), and
--     the snapshot write alone for the direct-create path
--     (ensure_opportunity_evidence_snapshot).
--   * Column list, RLS shape and grant style deliberately mirror
--     067_creator_lane_expand.sql (creator_memory) and the RLS-only tables
--     in 072/062 -- no new conventions introduced.
--   * OUT OF SCOPE (unchanged by this migration): the existing, generic
--     POST /api/memory save path for non-opportunity saves keeps its
--     current, pre-existing multi-step (non-atomic) behaviour -- a known,
--     separate gap, not fixed here.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Table
-- ============================================================

CREATE TABLE IF NOT EXISTS video_idea_opportunity_snapshots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_idea_id         UUID REFERENCES video_ideas(id) ON DELETE CASCADE NOT NULL,
  user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  -- Format version of this row's JSON shape (schema evolution), NOT an
  -- evidence-history counter -- see header. One row per video_idea_id;
  -- ON CONFLICT below refuses to move captured_at backwards.
  schema_version        SMALLINT NOT NULL DEFAULT 1,

  captured_at           TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ,

  title                 TEXT NOT NULL,
  description           TEXT,
  hook_suggestion       TEXT,
  opportunity_score     INTEGER CHECK (opportunity_score BETWEEN 0 AND 100),
  score_breakdown       JSONB,
  confidence            TEXT,
  trend_source_type     TEXT,
  trend_source_label    TEXT,
  risk_flags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  topic_intelligence    JSONB,
  web_sources           JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_videos       JSONB NOT NULL DEFAULT '[]'::jsonb,
  region                TEXT,
  platform              TEXT,
  niche                 TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_opp_evidence_snapshot_video_idea
  ON video_idea_opportunity_snapshots(video_idea_id);

CREATE INDEX IF NOT EXISTS idx_opp_evidence_snapshot_user
  ON video_idea_opportunity_snapshots(user_id);

-- ============================================================
-- 2. Tenant-identity immutability (mirrors enforce_creator_memory_identity)
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_opportunity_evidence_snapshot_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'opportunity_evidence_snapshot_identity_immutable: user_id cannot change';
  END IF;
  IF NEW.video_idea_id IS DISTINCT FROM OLD.video_idea_id THEN
    RAISE EXCEPTION 'opportunity_evidence_snapshot_identity_immutable: video_idea_id cannot change';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS opportunity_evidence_snapshot_identity_immutable ON video_idea_opportunity_snapshots;
CREATE TRIGGER opportunity_evidence_snapshot_identity_immutable
  BEFORE UPDATE ON video_idea_opportunity_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.enforce_opportunity_evidence_snapshot_identity();

CREATE OR REPLACE FUNCTION public.touch_opportunity_evidence_snapshot_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS opportunity_evidence_snapshot_touch_updated_at ON video_idea_opportunity_snapshots;
CREATE TRIGGER opportunity_evidence_snapshot_touch_updated_at
  BEFORE UPDATE ON video_idea_opportunity_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.touch_opportunity_evidence_snapshot_updated_at();

-- ============================================================
-- 3. RLS -- mirrors the RLS-only (no write policy) shape already used in
--    072_semantic_topic_identity_foundation.sql / 062_signal_collection_control.sql.
--    SELECT is scoped to the row's own owner via auth.uid() -- this is the
--    defense-in-depth layer against a DIRECT PostgREST call using a real
--    user JWT (bypassing the application's own route logic entirely).
--    There is deliberately NO insert/update/delete policy: every write
--    goes exclusively through the SECURITY DEFINER RPCs below, which run
--    as the function owner and are the only path with column access.
-- ============================================================

ALTER TABLE video_idea_opportunity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_idea_opportunity_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS opportunity_evidence_snapshot_owner_select ON video_idea_opportunity_snapshots;
CREATE POLICY opportunity_evidence_snapshot_owner_select ON video_idea_opportunity_snapshots
  FOR SELECT
  USING (user_id = auth.uid());

REVOKE ALL ON video_idea_opportunity_snapshots FROM PUBLIC, anon;
GRANT SELECT ON video_idea_opportunity_snapshots TO authenticated, service_role;

-- ============================================================
-- 4. Internal upsert primitive (shared by both public RPCs below).
--    Overwrite-protected: an incoming row with captured_at <= the existing
--    row's captured_at is a silent no-op (never regresses a newer
--    snapshot). Ownership is NOT re-checked here -- both callers already
--    verify it before calling this function; this function is never
--    granted EXECUTE to anything but its own callers (see grants below).
-- ============================================================

CREATE OR REPLACE FUNCTION public._upsert_opportunity_evidence_snapshot(
  p_video_idea_id uuid,
  p_user_id uuid,
  p_schema_version smallint,
  p_captured_at timestamptz,
  p_expires_at timestamptz,
  p_title text,
  p_description text,
  p_hook_suggestion text,
  p_opportunity_score integer,
  p_score_breakdown jsonb,
  p_confidence text,
  p_trend_source_type text,
  p_trend_source_label text,
  p_risk_flags jsonb,
  p_topic_intelligence jsonb,
  p_web_sources jsonb,
  p_evidence_videos jsonb,
  p_region text,
  p_platform text,
  p_niche text
) RETURNS TABLE(out_snapshot_id uuid, out_updated boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing_id uuid;
  v_existing_captured_at timestamptz;
  v_id uuid;
BEGIN
  SELECT id, captured_at INTO v_existing_id, v_existing_captured_at
    FROM video_idea_opportunity_snapshots
    WHERE video_idea_id = p_video_idea_id
    FOR UPDATE;

  IF v_existing_id IS NULL THEN
    INSERT INTO video_idea_opportunity_snapshots (
      video_idea_id, user_id, schema_version, captured_at, expires_at,
      title, description, hook_suggestion, opportunity_score, score_breakdown,
      confidence, trend_source_type, trend_source_label, risk_flags,
      topic_intelligence, web_sources, evidence_videos, region, platform, niche
    ) VALUES (
      p_video_idea_id, p_user_id, coalesce(p_schema_version, 1), p_captured_at, p_expires_at,
      p_title, p_description, p_hook_suggestion, p_opportunity_score, p_score_breakdown,
      p_confidence, p_trend_source_type, p_trend_source_label, coalesce(p_risk_flags, '[]'::jsonb),
      p_topic_intelligence, coalesce(p_web_sources, '[]'::jsonb), coalesce(p_evidence_videos, '[]'::jsonb),
      p_region, p_platform, p_niche
    )
    RETURNING id INTO v_id;
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;

  -- Overwrite protection: a late-arriving, not-newer snapshot is a silent no-op.
  IF p_captured_at <= v_existing_captured_at THEN
    RETURN QUERY SELECT v_existing_id, false;
    RETURN;
  END IF;

  UPDATE video_idea_opportunity_snapshots SET
    schema_version = coalesce(p_schema_version, 1),
    captured_at = p_captured_at,
    expires_at = p_expires_at,
    title = p_title,
    description = p_description,
    hook_suggestion = p_hook_suggestion,
    opportunity_score = p_opportunity_score,
    score_breakdown = p_score_breakdown,
    confidence = p_confidence,
    trend_source_type = p_trend_source_type,
    trend_source_label = p_trend_source_label,
    risk_flags = coalesce(p_risk_flags, '[]'::jsonb),
    topic_intelligence = p_topic_intelligence,
    web_sources = coalesce(p_web_sources, '[]'::jsonb),
    evidence_videos = coalesce(p_evidence_videos, '[]'::jsonb),
    region = p_region,
    platform = p_platform,
    niche = p_niche
  WHERE id = v_existing_id;

  RETURN QUERY SELECT v_existing_id, true;
END;
$$;

-- ============================================================
-- 5. Public RPC A -- direct-create path (no creator_memory/event touch).
--    Ownership check: p_video_idea_id must belong to p_user_id. p_user_id
--    is authoritative ONLY because the caller (the API route) derives it
--    server-side from the authenticated session -- this function does not
--    and cannot verify that on its own; see the application-layer callers.
-- ============================================================

CREATE OR REPLACE FUNCTION public.ensure_opportunity_evidence_snapshot(
  p_user_id uuid,
  p_video_idea_id uuid,
  p_schema_version smallint,
  p_captured_at timestamptz,
  p_expires_at timestamptz,
  p_title text,
  p_description text,
  p_hook_suggestion text,
  p_opportunity_score integer,
  p_score_breakdown jsonb,
  p_confidence text,
  p_trend_source_type text,
  p_trend_source_label text,
  p_risk_flags jsonb,
  p_topic_intelligence jsonb,
  p_web_sources jsonb,
  p_evidence_videos jsonb,
  p_region text,
  p_platform text,
  p_niche text
) RETURNS TABLE(out_snapshot_id uuid, out_updated boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_user_id IS NULL OR p_video_idea_id IS NULL THEN
    RAISE EXCEPTION 'ensure_opportunity_evidence_snapshot: p_user_id and p_video_idea_id are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM video_ideas WHERE id = p_video_idea_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'opportunity_evidence_snapshot_ownership_mismatch' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT * FROM public._upsert_opportunity_evidence_snapshot(
      p_video_idea_id, p_user_id, p_schema_version, p_captured_at, p_expires_at,
      p_title, p_description, p_hook_suggestion, p_opportunity_score, p_score_breakdown,
      p_confidence, p_trend_source_type, p_trend_source_label, p_risk_flags,
      p_topic_intelligence, p_web_sources, p_evidence_videos, p_region, p_platform, p_niche
    );
END;
$$;

-- ============================================================
-- 6. Public RPC B -- save-to-memory path. Atomically: (a) state-guarded
--    creator_memory upsert (never downgrades an existing rejected/completed
--    state back to 'saved' -- see header), (b) idempotent video_idea_events
--    insert (only on first save or an actual state change, never on a
--    same-state snapshot refresh), (c) the same overwrite-protected
--    snapshot upsert as RPC A. Reuses upsert_creator_memory() (067) for
--    the creator_memory write itself, passing it the already-guarded
--    target state, so its existing conflict/exception handling is not
--    duplicated here.
-- ============================================================

CREATE OR REPLACE FUNCTION public.save_opportunity_recommendation_to_memory(
  p_user_id uuid,
  p_video_idea_id uuid,
  p_topic text,
  p_search_keyword text,
  p_platform text,
  p_opportunity_score integer,
  p_schema_version smallint,
  p_captured_at timestamptz,
  p_expires_at timestamptz,
  p_title text,
  p_description text,
  p_hook_suggestion text,
  p_score_breakdown jsonb,
  p_confidence text,
  p_trend_source_type text,
  p_trend_source_label text,
  p_risk_flags jsonb,
  p_topic_intelligence jsonb,
  p_web_sources jsonb,
  p_evidence_videos jsonb,
  p_region text,
  p_niche text
) RETURNS TABLE(out_memory_id uuid, out_snapshot_id uuid, out_snapshot_updated boolean, out_event_logged boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_topic text := btrim(coalesce(p_topic, ''));
  v_old_state text;
  v_new_state text := 'saved';
  v_memory_row creator_memory;
  v_event_logged boolean := false;
  v_snapshot_id uuid;
  v_snapshot_updated boolean;
BEGIN
  IF p_user_id IS NULL OR p_video_idea_id IS NULL THEN
    RAISE EXCEPTION 'save_opportunity_recommendation_to_memory: p_user_id and p_video_idea_id are required';
  END IF;
  IF v_topic = '' THEN
    RAISE EXCEPTION 'save_opportunity_recommendation_to_memory: p_topic required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM video_ideas WHERE id = p_video_idea_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'opportunity_evidence_snapshot_ownership_mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT state INTO v_old_state FROM creator_memory
    WHERE user_id = p_user_id AND topic = v_topic AND content_lane IS NULL;

  -- State-guard: a snapshot-triggered save never downgrades an explicit
  -- prior rejected/completed decision back to 'saved'.
  IF v_old_state IN ('rejected', 'completed') THEN
    v_new_state := v_old_state;
  END IF;

  -- upsert_creator_memory's pending-lane (p_content_lane IS NULL) INSERT
  -- branch does NOT write video_idea_id -- that linkage is a separate step
  -- (link_creator_memory_parent), exactly mirroring the existing app/api/
  -- memory/route.ts POST flow (upsertCreatorMemory then
  -- linkVideoIdeaToLegacyRecord). Discovered and fixed via a real local-DB
  -- test failure (creator_memory.video_idea_id was NULL after this call
  -- without the second step) -- see the 092 db-integration test suite.
  SELECT (upsert_creator_memory(
    p_user_id, v_topic, NULL, p_video_idea_id, p_search_keyword, v_new_state,
    p_opportunity_score, NULL, p_platform, NULL, NULL, NULL, NULL, 'opportunity_engine', NULL
  )).* INTO v_memory_row;

  PERFORM link_creator_memory_parent(p_user_id, v_memory_row.id, p_video_idea_id);
  v_memory_row.video_idea_id := p_video_idea_id;

  -- Idempotent event logging: only on first save or an actual state change
  -- -- never merely because the snapshot content was refreshed.
  IF v_old_state IS NULL OR v_old_state IS DISTINCT FROM v_new_state THEN
    INSERT INTO video_idea_events (user_id, video_idea_id, event_type, source_tool, payload)
    VALUES (
      p_user_id, p_video_idea_id,
      CASE WHEN v_old_state IS NULL THEN 'idea_saved' ELSE 'state_changed' END,
      'opportunity_engine',
      jsonb_build_object('topic', v_topic, 'from', v_old_state, 'to', v_new_state)
    );
    v_event_logged := true;
  END IF;

  -- Table-qualified (s.out_snapshot_id, not the bare column name) -- this
  -- function's OWN RETURNS TABLE(...) also declares an out_snapshot_id
  -- implicit variable in this scope, so the bare name is ambiguous between
  -- that variable and the subquery's column of the same name.
  SELECT s.out_snapshot_id, s.out_updated INTO v_snapshot_id, v_snapshot_updated
    FROM public._upsert_opportunity_evidence_snapshot(
      p_video_idea_id, p_user_id, p_schema_version, p_captured_at, p_expires_at,
      p_title, p_description, p_hook_suggestion, p_opportunity_score, p_score_breakdown,
      p_confidence, p_trend_source_type, p_trend_source_label, p_risk_flags,
      p_topic_intelligence, p_web_sources, p_evidence_videos, p_region, p_platform, p_niche
    ) AS s(out_snapshot_id, out_updated);

  RETURN QUERY SELECT v_memory_row.id, v_snapshot_id, v_snapshot_updated, v_event_logged;
END;
$$;

-- ============================================================
-- 7. Execute grants -- same REVOKE-then-allowlist style as 067.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public._upsert_opportunity_evidence_snapshot(
  uuid, uuid, smallint, timestamptz, timestamptz, text, text, text, integer, jsonb,
  text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
-- Intentionally no GRANT here -- this function is only ever invoked from
-- within the two SECURITY DEFINER RPCs below (function-to-function calls
-- execute with the calling function's own elevated privilege, not the
-- session's), never called directly.

REVOKE EXECUTE ON FUNCTION public.ensure_opportunity_evidence_snapshot(
  uuid, uuid, smallint, timestamptz, timestamptz, text, text, text, integer, jsonb,
  text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_opportunity_evidence_snapshot(
  uuid, uuid, smallint, timestamptz, timestamptz, text, text, text, integer, jsonb,
  text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.save_opportunity_recommendation_to_memory(
  uuid, uuid, text, text, text, integer, smallint, timestamptz, timestamptz, text, text, text,
  jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_opportunity_recommendation_to_memory(
  uuid, uuid, text, text, text, integer, smallint, timestamptz, timestamptz, text, text, text,
  jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.enforce_opportunity_evidence_snapshot_identity() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.touch_opportunity_evidence_snapshot_updated_at() FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- 8. Closing validation -- fail loudly on drift, mirroring the 001-091 convention.
-- ============================================================

DO $validate$
BEGIN
  IF to_regclass('public.video_idea_opportunity_snapshots') IS NULL THEN
    RAISE EXCEPTION '092 validate failed: video_idea_opportunity_snapshots missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = 'video_idea_opportunity_snapshots' AND n.nspname = 'public' AND c.relrowsecurity) THEN
    RAISE EXCEPTION '092 validate failed: RLS not enabled on video_idea_opportunity_snapshots';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = 'video_idea_opportunity_snapshots' AND n.nspname = 'public' AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '092 validate failed: FORCE RLS not set on video_idea_opportunity_snapshots';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'video_idea_opportunity_snapshots' AND policyname = 'opportunity_evidence_snapshot_owner_select') THEN
    RAISE EXCEPTION '092 validate failed: owner-select policy missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='video_idea_opportunity_snapshots' AND grantee IN ('anon') AND privilege_type IN ('INSERT','UPDATE','DELETE','SELECT')) THEN
    RAISE EXCEPTION '092 validate failed: anon has an unexpected grant on video_idea_opportunity_snapshots';
  END IF;
  IF has_function_privilege('service_role', 'public._upsert_opportunity_evidence_snapshot(uuid,uuid,smallint,timestamptz,timestamptz,text,text,text,integer,jsonb,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '092 validate failed: service_role must not have direct EXECUTE on the internal upsert primitive';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.ensure_opportunity_evidence_snapshot(uuid,uuid,smallint,timestamptz,timestamptz,text,text,text,integer,jsonb,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '092 validate failed: service_role missing EXECUTE on ensure_opportunity_evidence_snapshot';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.save_opportunity_recommendation_to_memory(uuid,uuid,text,text,text,integer,smallint,timestamptz,timestamptz,text,text,text,jsonb,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '092 validate failed: service_role missing EXECUTE on save_opportunity_recommendation_to_memory';
  END IF;
END $validate$;

COMMIT;
