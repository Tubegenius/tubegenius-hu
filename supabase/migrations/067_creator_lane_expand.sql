-- ============================================================
-- Migration 067: Creator Lane Architecture v0 -- EXPAND phase
--
-- Adds the evidence_led / entertainment_led creator-lane data model on top
-- of the existing video_ideas / creator_memory / profiles tables, per the
-- multi-round PFM Creator Lane Architecture v0 specification closure
-- (data model, DB concurrency/security, and SQL correctness gates) and the
-- two local preflight closure-proof rounds that empirically validated the
-- privilege model, dual advisory-lock contract, identity-immutability
-- trigger, and normalized-topic golden fixtures against a real local
-- Supabase instance before this migration was written.
--
-- THIS IS THE EXPAND HALF of a two-phase, zero-downtime expand/contract
-- rollout. It was originally written and locally validated as a single
-- combined migration; it was split into 067 (expand, this file) + 068
-- (contract, supabase/migrations/068_creator_lane_contract.sql) before
-- either file was ever committed or applied to production, once a rollout
-- gate review found the combined version was NOT zero-downtime:
--   * the OLD (currently deployed) application's PostgREST calls --
--     `creator_memory.upsert(record, {onConflict:'user_id,topic'})` in the
--     legacy app/api/memory/route.ts and app/api/video-audit/route.ts --
--     require the plain-column `creator_memory_user_id_topic_key` unique
--     constraint to exist, for PostgREST's on_conflict inference;
--   * the OLD application also writes `creator_memory.video_idea_id`
--     directly inside that same upsert payload;
--   * the NEW application (this codebase) instead calls the
--     `upsert_creator_memory` / `link_creator_memory_parent` RPCs added
--     below, and requires the OLD global constraint to be GONE (replaced by
--     the lane-partitioned partial unique indexes below) before two
--     different-lane rows can ever coexist for the same (user_id, topic).
-- Applying both "drop old constraint" and "revoke direct
-- creator_memory.video_idea_id/content_lane writability" in the same
-- migration as the new schema would break whichever application (old or
-- new) is not yet deployed at the moment this migration runs -- there is no
-- safe DB-first-then-app-first, or app-first-then-DB-first, ordering for a
-- single combined migration. Splitting into expand (backward-compatible
-- only, this file) + contract (breaking, deferred to 068, applied only
-- after the new application is confirmed live in production) removes that
-- ordering hazard entirely: this file's end-state keeps the OLD
-- application's full write path working, byte-for-byte, while also making
-- the NEW application's RPC-based write path already fully functional and
-- production-deployable.
--
-- SCOPE -- EXPAND phase ONLY, additive/backward-compatible:
--   * profiles.primary_creator_lane (nullable, UI-preselect only)
--   * video_ideas: content_lane, lane_assignment_source, lane_locked_at,
--     reclassified_from_video_idea_id, linked_signal_cluster_id,
--     normalized_topic (all nullable, NO legacy backfill)
--   * creator_memory: content_lane (nullable, NO legacy backfill)
--   * lane-state CHECK constraints (4 mutually exclusive states)
--   * lane-aware composite unique indexes on video_ideas (x2), replacing
--     the pre-lane plain-column unique enforcers there -- legacy
--     input_hash values are NOT recomputed; the existing legacy uniqueness
--     guarantee is preserved as a strict subset of the new, lane-widened
--     key. video_ideas has NO onConflict-based PostgREST upsert call
--     anywhere in the codebase (old or new -- verified by reading every
--     `.from('video_ideas')` write site; all of them do an explicit
--     select-then-insert-or-update, never `.upsert(..., {onConflict})`),
--     so replacing these indexes carries none of the creator_memory hazard
--     above and is safe to do directly in the expand phase.
--   * creator_memory: two NEW lane-partitioned partial unique indexes
--     (idx_creator_memory_user_topic_pending, idx_creator_memory_user_topic_lane)
--     added ALONGSIDE the pre-existing global creator_memory_user_id_topic_key
--     constraint, which this migration deliberately does NOT touch. The
--     two are structurally independent index objects (different column
--     lists / WHERE predicates) and coexist without any DDL conflict; the
--     new indexes exist and are valid from this migration onward, but the
--     old global constraint still fully governs uniqueness until 068 drops
--     it, so a second (different-lane) row for an already-occupied topic
--     remains blocked until then -- see 068's header for the exact
--     contract this hands off.
--   * BEFORE UPDATE lock-immutability trigger on video_ideas
--   * BEFORE INSERT/UPDATE identity-immutability trigger on creator_memory
--     (user_id/topic) -- independent of the lane-consistency trigger. Only
--     checks user_id/topic drift, so it does not interfere with the OLD
--     application's direct `video_idea_id` write in its upsert payload.
--   * BEFORE INSERT/UPDATE lane-consistency trigger on creator_memory
--     (video_idea_id/content_lane parent-link validation). Every branch is
--     conditioned on `content_lane IS NOT NULL` somewhere in OLD or NEW --
--     the OLD application only ever writes content_lane-NULL rows, so none
--     of its branches fire for that write path either.
--   * 5 SECURITY DEFINER RPCs: ensure_video_idea_lane, lock_video_idea_lane,
--     reclassify_video_idea, link_creator_memory_parent, upsert_creator_memory
--   * column-level GRANT/REVOKE hardening on video_ideas (table-level
--     REVOKE + allowlisted column re-GRANT), matching the write-path audit
--     proven against a real local PostgREST instance (SET ROLE service_role
--     + real merge-duplicates upsert calls). Safe to apply now (not
--     deferred) because no video_ideas write site, old or new, touches a
--     column outside the allowlist below.
--
-- EXPLICITLY DEFERRED TO 068 (the contract phase, applied only after the
-- new application is confirmed live in production):
--   * dropping creator_memory_user_id_topic_key (and the redundant
--     creator_memory_user_topic_unique, if present)
--   * creator_memory column-level GRANT/REVOKE hardening (table-level
--     REVOKE INSERT/UPDATE + allowlisted column re-GRANT) -- the OLD
--     application writes creator_memory.video_idea_id directly, which is
--     NOT on 068's allowlist (RPC-only going forward), so revoking it here
--     would break the OLD application immediately.
--
-- EXPLICITLY OUT OF SCOPE for both 067 and 068 (deferred to later,
-- separately approved phases per the accepted rollout plan):
--   * legacy-row backfill of any kind (content_lane stays NULL on every
--     existing row until a user or an approved RPC explicitly classifies it)
--   * legacy-score (viral_score/opportunity_score/competition_score)
--     Phase-B freeze trigger -- Phase A (unchanged writability) remains in
--     effect until the dual-lane user-facing flag is approved for launch
--   * any change to the signal_* schema, the collector, or
--     signal_collection_control
--   * lane-score computation, Creative DNA, or Shadow Topic
--   * application-code route changes (handled outside this SQL file)
--
-- Follows the project's established create-XOR-validate-else-exception,
-- fail-fast migration convention (see 045_harden_function_execution.sql):
-- additive DDL uses IF NOT EXISTS / OR REPLACE so a byte-identical re-run is
-- a safe no-op; the closing DO $validate$ block asserts the complete
-- expected EXPAND end-state (columns, constraints, indexes, grants,
-- triggers, functions) and RAISEs on any drift, whether from a partial
-- prior run or from unexpected manual tampering. It also explicitly asserts
-- the things that must NOT yet be true in this phase (old creator_memory
-- constraint still present, creator_memory.video_idea_id/content_lane still
-- directly writable by service_role) so an accidental merge of 068's
-- contract steps into this file fails loudly instead of silently breaking
-- the old application.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. profiles.primary_creator_lane
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS primary_creator_lane TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_primary_creator_lane_valid'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_primary_creator_lane_valid CHECK (
      primary_creator_lane IS NULL OR primary_creator_lane IN ('evidence_led', 'entertainment_led')
    );
  ELSIF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'profiles_primary_creator_lane_valid'))
        <> 'CHECK (((primary_creator_lane IS NULL) OR (primary_creator_lane = ANY (ARRAY[''evidence_led''::text, ''entertainment_led''::text]))))'
  THEN
    RAISE EXCEPTION '067 EXPAND drift: profiles_primary_creator_lane_valid definition does not match expected';
  END IF;
END $$;

-- ============================================================
-- 2. video_ideas: new lane columns (all nullable, no backfill)
-- ============================================================

ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS content_lane TEXT,
  ADD COLUMN IF NOT EXISTS lane_assignment_source TEXT,
  ADD COLUMN IF NOT EXISTS lane_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reclassified_from_video_idea_id UUID,
  ADD COLUMN IF NOT EXISTS linked_signal_cluster_id UUID,
  ADD COLUMN IF NOT EXISTS normalized_topic TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_ideas_reclassified_from_fkey') THEN
    ALTER TABLE video_ideas
      ADD CONSTRAINT video_ideas_reclassified_from_fkey
      FOREIGN KEY (reclassified_from_video_idea_id) REFERENCES video_ideas(id) ON DELETE SET NULL;
  END IF;

  -- Optional inbound reference to the signal_* pipeline. Does NOT alter the
  -- signal_clusters table, its RLS, its grants, or the collector in any way
  -- -- purely a new outbound FK column on video_ideas.
  IF to_regclass('public.signal_clusters') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_ideas_linked_signal_cluster_fkey')
  THEN
    ALTER TABLE video_ideas
      ADD CONSTRAINT video_ideas_linked_signal_cluster_fkey
      FOREIGN KEY (linked_signal_cluster_id) REFERENCES signal_clusters(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================
-- 3. video_ideas: lane-state CHECK constraints
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_ideas_lane_state_valid') THEN
    -- NOTE: every membership test below is written as
    -- "x IS NOT NULL AND x IN (...)" rather than a bare "x IN (...)".
    -- A bare "NULL IN (...)" evaluates to NULL (not FALSE) in SQL's
    -- three-valued logic, and a CHECK only REJECTS a row when its
    -- expression evaluates to FALSE -- NULL is treated as "not proven
    -- false" and silently PASSES. Without the explicit IS NOT NULL guard,
    -- a row with content_lane='evidence_led' and lane_assignment_source
    -- left NULL would incorrectly be accepted (verified empirically while
    -- implementing this migration -- the bare-IN version let exactly that
    -- illegal combination through).
    ALTER TABLE video_ideas ADD CONSTRAINT video_ideas_lane_state_valid CHECK (
      (content_lane IS NULL AND lane_assignment_source IS NULL AND lane_locked_at IS NULL)
      OR (content_lane IS NULL AND lane_assignment_source = 'unconfirmed_quick_save' AND lane_locked_at IS NULL)
      OR (content_lane IS NOT NULL AND content_lane IN ('evidence_led', 'entertainment_led')
          AND lane_assignment_source IS NOT NULL AND lane_assignment_source IN ('explicit_user', 'profile_default_confirmed', 'project_inherit_confirmed', 'legacy_user_confirmed')
          AND lane_locked_at IS NULL)
      OR (content_lane IS NOT NULL AND content_lane IN ('evidence_led', 'entertainment_led')
          AND lane_assignment_source IS NOT NULL AND lane_assignment_source IN ('explicit_user', 'profile_default_confirmed', 'project_inherit_confirmed', 'legacy_user_confirmed')
          AND lane_locked_at IS NOT NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_ideas_signal_cluster_requires_evidence_lock') THEN
    ALTER TABLE video_ideas ADD CONSTRAINT video_ideas_signal_cluster_requires_evidence_lock CHECK (
      linked_signal_cluster_id IS NULL OR (content_lane = 'evidence_led' AND lane_locked_at IS NOT NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_ideas_reclassify_no_self_reference') THEN
    ALTER TABLE video_ideas ADD CONSTRAINT video_ideas_reclassify_no_self_reference CHECK (
      reclassified_from_video_idea_id IS NULL OR reclassified_from_video_idea_id <> id
    );
  END IF;

  -- Cheap, non-authoritative sanity check only -- the DB does NOT
  -- reimplement TypeScript normalizeText(); it only asserts the shape a
  -- correctly-normalized value must have (lowercase, trimmed, no
  -- double-spaces). NULL is allowed (legacy rows / not-yet-normalized rows).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_ideas_normalized_topic_sane') THEN
    ALTER TABLE video_ideas ADD CONSTRAINT video_ideas_normalized_topic_sane CHECK (
      normalized_topic IS NULL OR (
        normalized_topic <> ''
        AND normalized_topic = lower(btrim(normalized_topic))
        AND normalized_topic !~ '  '
      )
    );
  END IF;
END $$;

-- ============================================================
-- 4. video_ideas: lane-aware uniqueness (replaces the pre-lane enforcers)
--
-- Safe to do directly in the expand phase: video_ideas has no
-- onConflict-based PostgREST upsert call anywhere in the codebase (see this
-- file's header). Both replaced objects are plain unique INDEXES (not
-- pg_constraint-backed -- they were originally created via CREATE UNIQUE
-- INDEX because they use expressions, which a table-level ADD CONSTRAINT
-- UNIQUE cannot express), so they are removed with DROP INDEX, not ALTER
-- TABLE DROP CONSTRAINT.
--
-- Precheck proof that this widening cannot introduce a NEW collision on
-- existing data: content_lane is a brand-new column, so on every row it
-- currently evaluates to NULL, and every occurrence of
-- coalesce(content_lane, '__pending__') therefore currently collapses to
-- the SAME literal constant across all rows. Appending a column that is
-- constant across 100% of existing rows to a UNIQUE key can only ever be
-- equally or more permissive than the original key -- it cannot create a
-- collision where none existed under the narrower original key. No backfill
-- or data migration is required or performed.
-- ============================================================

DO $$
DECLARE
  v_dupe_count int;
BEGIN
  -- Explicit proof of the claim above, executed every run (cheap, and it
  -- keeps this migration self-verifying rather than trusting the comment).
  SELECT count(*) INTO v_dupe_count FROM (
    SELECT user_id, input_hash, coalesce(content_lane, '__pending__') AS bucket, count(*) AS c
    FROM video_ideas WHERE input_hash IS NOT NULL
    GROUP BY 1, 2, 3 HAVING count(*) > 1
  ) dupes;
  IF v_dupe_count > 0 THEN
    RAISE EXCEPTION '067 EXPAND precheck failed: % duplicate (user_id, input_hash, lane-bucket) group(s) found -- widened index would violate uniqueness', v_dupe_count;
  END IF;

  SELECT count(*) INTO v_dupe_count FROM (
    SELECT user_id, lower(topic) AS t, platform, language, market, coalesce(content_lane, '__pending__') AS bucket, count(*) AS c
    FROM video_ideas
    GROUP BY 1, 2, 3, 4, 5, 6 HAVING count(*) > 1
  ) dupes;
  IF v_dupe_count > 0 THEN
    RAISE EXCEPTION '067 EXPAND precheck failed: % duplicate (user_id, topic, platform, language, market, lane-bucket) group(s) found -- widened index would violate uniqueness', v_dupe_count;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_video_ideas_user_input_hash;
DROP INDEX IF EXISTS idx_video_ideas_user_topic_platform;

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_ideas_user_input_hash_lane
  ON video_ideas(user_id, input_hash, (coalesce(content_lane, '__pending__')))
  WHERE input_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_ideas_user_topic_platform_lane
  ON video_ideas(user_id, lower(topic), platform, language, market, (coalesce(content_lane, '__pending__')));

-- ============================================================
-- 5. video_ideas: lock-immutability trigger
--    Covers content_lane, lane_assignment_source, lane_locked_at (once
--    locked) and reclassified_from_video_idea_id (immutable from INSERT,
--    lock-state independent). linked_signal_cluster_id and any future
--    lane-specific score columns are explicitly OUT of this trigger's
--    scope -- they remain updatable via their own dedicated, controlled
--    RPCs (not part of this foundation migration).
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_video_idea_lane_lock_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.lane_locked_at IS NOT NULL THEN
    IF NEW.content_lane IS DISTINCT FROM OLD.content_lane THEN
      RAISE EXCEPTION 'lane_locked_content_lane_immutable';
    END IF;
    IF NEW.lane_assignment_source IS DISTINCT FROM OLD.lane_assignment_source THEN
      RAISE EXCEPTION 'lane_locked_assignment_source_immutable';
    END IF;
    IF NEW.lane_locked_at IS DISTINCT FROM OLD.lane_locked_at THEN
      RAISE EXCEPTION 'lane_locked_timestamp_immutable';
    END IF;
  END IF;

  IF NEW.reclassified_from_video_idea_id IS DISTINCT FROM OLD.reclassified_from_video_idea_id THEN
    RAISE EXCEPTION 'reclassify_lineage_immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS video_ideas_lane_lock_immutable ON video_ideas;
CREATE TRIGGER video_ideas_lane_lock_immutable
  BEFORE UPDATE ON video_ideas
  FOR EACH ROW EXECUTE FUNCTION public.enforce_video_idea_lane_lock_immutable();

-- ============================================================
-- 6. creator_memory: content_lane column + lane-aware, 3-state uniqueness
--    (indexes ADDED alongside the OLD global constraint -- NOT replacing it
--    yet; see this file's header and 068 for why the drop is deferred)
--
-- Per the Creator Lane contract (mandatory): the same topic must eventually
-- be able to exist as up to three DISTINCT creator_memory rows per user --
-- one legacy/pending (content_lane IS NULL), one evidence_led, one
-- entertainment_led -- and the two lanes must never merge. The existing
-- global UNIQUE(user_id, topic) constraint is structurally incompatible
-- with that end-state: it allows only one row per topic, period, regardless
-- of lane. This migration adds the two indexes that will enforce the new,
-- widened uniqueness model once 068 drops the old constraint; until then,
-- the old constraint continues to fully govern uniqueness (a second,
-- different-lane row for an already-occupied topic is still blocked, since
-- it would violate the old constraint first) -- see 068 for the drop.
--
--   idx_creator_memory_user_topic_pending: (user_id, topic) WHERE content_lane IS NULL
--   idx_creator_memory_user_topic_lane:    (user_id, topic, content_lane) WHERE content_lane IS NOT NULL
-- These are non-overlapping by construction (a row matches exactly one, by
-- its own content_lane IS/IS NOT NULL state), so "at most one pending" and
-- "at most one per lane" hold independently and can never collide with
-- each other, and neither's column list / WHERE predicate matches the old
-- constraint's plain (user_id, topic) definition -- so CREATE UNIQUE INDEX
-- for both succeeds today without any DDL conflict against the still-present
-- old constraint.
--
-- Identity component is `topic` AS-IS -- not lower(topic), not a
-- normalized_topic column. video_ideas.normalized_topic is a video_ideas-
-- only concept from the accepted spec; creator_memory never had a
-- normalized_topic column, and its original constraint was plain
-- (user_id, topic), case-sensitive, matching exactly what
-- app/api/memory/route.ts has always sent (topic.trim(), no case-folding).
-- This preserves that exact prior identity semantics -- no new contract
-- invented.
--
-- These are plain-column partial unique INDEXES, not pg_constraint-backed
-- UNIQUE constraints (a table-level ADD CONSTRAINT UNIQUE cannot carry a
-- WHERE clause), so they are created with CREATE UNIQUE INDEX, matching the
-- video_ideas pattern elsewhere in this migration.
--
-- The upsert_creator_memory() RPC added below (section 9e) already targets
-- these new indexes via a WHERE-qualified ON CONFLICT, which Postgres
-- supports natively in a function body even though PostgREST's on_conflict
-- query parameter cannot express one -- so the NEW application's write path
-- is already fully functional against this EXPAND state, for both the
-- pending branch and (once a locked, lane-tagged parent exists) the
-- lane-tagged branch.
-- ============================================================

ALTER TABLE creator_memory ADD COLUMN IF NOT EXISTS content_lane TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_memory_content_lane_valid') THEN
    ALTER TABLE creator_memory ADD CONSTRAINT creator_memory_content_lane_valid CHECK (
      content_lane IS NULL OR content_lane IN ('evidence_led', 'entertainment_led')
    );
  END IF;
END $$;

-- ------------------------------------------------------------
-- 6c. Dual-legacy-constraint drift check (READ-ONLY -- neither is dropped
--     or created here, that remains 068's job for the mandatory one; this
--     block only PROVES, at migration-apply time, that the exact hardcoded
--     constraint names the upsert_creator_memory() exception handler below
--     (section 9e) matches by name really do carry the expected
--     `UNIQUE (user_id, topic)` definition -- so that name-based matching
--     is provably safe, not a guess).
--
--     creator_memory_user_id_topic_key: MANDATORY presence (already
--     asserted elsewhere in this file too) -- this is the constraint every
--     environment, local or production, has always had.
--
--     creator_memory_user_topic_unique: OPTIONAL presence. Local/clean-
--     rebuild databases do NOT have it (042_capture_creator_memory_schema_
--     drift.sql explicitly declined to reproduce it, since it is a
--     production-only redundant duplicate with zero functional difference
--     from creator_memory_user_id_topic_key -- see that migration's
--     header). Production DOES have it. Both are handled identically by
--     the exception handler below; this block only fails fast if EITHER
--     one, when present, has drifted from the exact expected definition.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'creator_memory_user_id_topic_key';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '067 EXPAND precheck failed: creator_memory_user_id_topic_key is missing -- mandatory in every environment';
  ELSIF v_def <> 'UNIQUE (user_id, topic)' THEN
    RAISE EXCEPTION '067 EXPAND drift: creator_memory_user_id_topic_key definition does not match expected ("UNIQUE (user_id, topic)"), got: %', v_def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'creator_memory_user_topic_unique';
  IF v_def IS NOT NULL AND v_def <> 'UNIQUE (user_id, topic)' THEN
    RAISE EXCEPTION '067 EXPAND drift: creator_memory_user_topic_unique definition does not match expected ("UNIQUE (user_id, topic)"), got: %', v_def;
  END IF;
  -- v_def IS NULL here (constraint absent, e.g. local/clean-rebuild) is
  -- NOT an error -- this constraint is optional by design.
END $$;

-- No precheck is needed before creating these two indexes: the pre-existing
-- global creator_memory_user_id_topic_key constraint (untouched by this
-- migration) already guarantees at most one row per (user_id, topic)
-- regardless of content_lane, which is strictly narrower than either new
-- partial index's own uniqueness requirement -- so neither CREATE UNIQUE
-- INDEX can ever encounter a pre-existing violation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_memory_user_topic_pending
  ON creator_memory(user_id, topic) WHERE content_lane IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_memory_user_topic_lane
  ON creator_memory(user_id, topic, content_lane) WHERE content_lane IS NOT NULL;

-- ============================================================
-- 7. creator_memory: tenant-identity immutability trigger
--    (user_id / topic cannot drift on UPDATE, regardless of column-grant
--    state -- proven locally in the closure-proof rounds against a real
--    PostgREST merge-duplicates upsert call, which remains compatible
--    because it never actually changes the conflict-key values.) Only
--    inspects user_id/topic, so it does not interfere with the OLD
--    application's direct write of video_idea_id in its upsert payload.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_creator_memory_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'memory_identity_immutable: user_id cannot change';
  END IF;
  IF NEW.topic IS DISTINCT FROM OLD.topic THEN
    RAISE EXCEPTION 'memory_identity_immutable: topic cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS creator_memory_identity_immutable ON creator_memory;
CREATE TRIGGER creator_memory_identity_immutable
  BEFORE UPDATE ON creator_memory
  FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_memory_identity();

-- ============================================================
-- 8. creator_memory: lane-consistency trigger for the parent link
--    (video_idea_id / content_lane). Distinguishes the legitimate FK
--    ON DELETE SET NULL passthrough from any other transition; first-time
--    lane assignment requires an existing, same-tenant, same-lane, LOCKED
--    parent; content_lane is immutable once first set; re-parenting
--    (active or orphaned) is forbidden. Every branch is gated on
--    content_lane being (or having been) NOT NULL somewhere in OLD/NEW, so
--    the OLD application's content_lane-NULL write path never triggers any
--    of these checks.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_creator_memory_lane_consistency() RETURNS trigger AS $$
DECLARE v_parent RECORD;
BEGIN
  -- (1) FK ON DELETE SET NULL passthrough -- always allowed, no further checks.
  IF TG_OP = 'UPDATE'
     AND OLD.content_lane IS NOT NULL
     AND OLD.video_idea_id IS NOT NULL AND NEW.video_idea_id IS NULL
     AND NEW.content_lane IS NOT DISTINCT FROM OLD.content_lane
     AND NEW.user_id = OLD.user_id
  THEN
    RETURN NEW;
  END IF;

  -- (2) First-time lane assignment: INSERT with a lane, or UPDATE where
  --     OLD.content_lane was still NULL.
  IF NEW.content_lane IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.content_lane IS NULL) THEN
    IF NEW.video_idea_id IS NULL THEN
      RAISE EXCEPTION 'lane_memory_requires_parent';
    END IF;
    SELECT user_id, content_lane, lane_locked_at INTO v_parent FROM video_ideas WHERE id = NEW.video_idea_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'lane_memory_parent_not_found';
    END IF;
    IF v_parent.user_id <> NEW.user_id THEN
      RAISE EXCEPTION 'lane_memory_parent_tenant_mismatch';
    END IF;
    IF v_parent.content_lane IS DISTINCT FROM NEW.content_lane THEN
      RAISE EXCEPTION 'lane_memory_parent_mismatch';
    END IF;
    IF v_parent.lane_locked_at IS NULL THEN
      RAISE EXCEPTION 'lane_memory_requires_locked_parent';
    END IF;
    RETURN NEW;
  END IF;

  -- (3) content_lane immutable once set.
  IF TG_OP = 'UPDATE' AND OLD.content_lane IS NOT NULL AND NEW.content_lane IS DISTINCT FROM OLD.content_lane THEN
    RAISE EXCEPTION 'lane_memory_snapshot_immutable';
  END IF;

  -- (4) Re-parenting forbidden once lane-tagged (active or orphaned row).
  IF TG_OP = 'UPDATE' AND OLD.content_lane IS NOT NULL AND NEW.video_idea_id IS DISTINCT FROM OLD.video_idea_id THEN
    RAISE EXCEPTION 'lane_memory_reparent_forbidden';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS creator_memory_lane_consistency ON creator_memory;
CREATE TRIGGER creator_memory_lane_consistency
  BEFORE INSERT OR UPDATE ON creator_memory
  FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_memory_lane_consistency();

-- ============================================================
-- 9. SECURITY DEFINER RPCs
-- ============================================================

-- 9a. ensure_video_idea_lane -- dual-advisory-lock-protected create/find/
--     pending-to-assigned-transition for a (user, natural key) pair.
--     Serialization key derivation: raw component = lower(btrim(p_topic));
--     normalized component = p_normalized_topic (computed by the caller via
--     TypeScript normalizeText(), NOT recomputed here). Both components are
--     serialized via jsonb_build_array(...)::text before hashing --
--     unambiguous field boundaries by construction (JSON escaping), not a
--     delimiter-joined string. The two resulting bigint keys are acquired
--     in ascending order (equal keys locked exactly once) so this remains
--     deadlock-free even if a future refactor merges multiple ensure calls
--     into one transaction. A hash collision between two DIFFERENT natural
--     keys is theoretically possible (hashtextextended is a 64-bit hash,
--     not a cryptographic identity guarantee) -- such a collision could at
--     worst force two unrelated operations to serialize unnecessarily; it
--     can NEVER merge two identities, because the actual correctness
--     guarantee is the UNIQUE index + exact-value WHERE clauses below, both
--     independent of the hash.
-- NOTE ON IDENTIFIER STYLE: every table reference below uses an explicit
-- alias (vi for video_ideas, cm for creator_memory) and every column read
-- is written as alias.column, even where the bare name would usually be
-- unambiguous -- because RETURNS TABLE(...) output columns become
-- PL/pgSQL variables in scope for the WHOLE function body, and several of
-- them (content_lane, lane_assignment_source, lane_locked_at,
-- video_idea_id) intentionally share their name with real table columns.
-- Without the alias, PL/pgSQL raises "column reference ... is ambiguous"
-- (discovered empirically while implementing and testing this migration).
CREATE OR REPLACE FUNCTION public.ensure_video_idea_lane(
  p_user_id uuid,
  p_topic text,
  p_normalized_topic text,
  p_platform text,
  p_language text,
  p_market text,
  p_input_hash text,
  p_content_lane text,
  p_expected_current_lane text,
  p_expected_assignment_source text,
  p_lane_source text
) RETURNS TABLE(video_idea_id uuid, content_lane text, lane_assignment_source text, lane_locked_at timestamptz, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_raw_topic text := lower(btrim(coalesce(p_topic, '')));
  v_norm_topic text := coalesce(p_normalized_topic, '');
  v_raw_key bigint;
  v_norm_key bigint;
  v_target RECORD;
  v_pending RECORD;
  v_updated RECORD;
  v_new_id uuid;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'ensure_video_idea_lane: p_user_id required'; END IF;
  IF v_raw_topic = '' THEN RAISE EXCEPTION 'ensure_video_idea_lane: p_topic required'; END IF;
  IF v_norm_topic = '' THEN RAISE EXCEPTION 'ensure_video_idea_lane: p_normalized_topic required'; END IF;
  IF coalesce(p_platform, '') = '' THEN RAISE EXCEPTION 'ensure_video_idea_lane: p_platform required'; END IF;
  IF coalesce(p_language, '') = '' THEN RAISE EXCEPTION 'ensure_video_idea_lane: p_language required'; END IF;
  IF coalesce(p_market, '') = '' THEN RAISE EXCEPTION 'ensure_video_idea_lane: p_market required'; END IF;
  IF coalesce(p_input_hash, '') = '' THEN RAISE EXCEPTION 'ensure_video_idea_lane: p_input_hash required'; END IF;
  IF p_content_lane IS NOT NULL AND p_content_lane NOT IN ('evidence_led', 'entertainment_led') THEN
    RAISE EXCEPTION 'ensure_video_idea_lane: invalid p_content_lane %', p_content_lane;
  END IF;
  IF p_content_lane IS NOT NULL AND coalesce(p_lane_source, '') NOT IN ('explicit_user', 'profile_default_confirmed', 'project_inherit_confirmed', 'legacy_user_confirmed') THEN
    RAISE EXCEPTION 'ensure_video_idea_lane: invalid p_lane_source %', p_lane_source;
  END IF;

  v_raw_key := hashtextextended(jsonb_build_array(p_user_id::text, v_raw_topic, p_platform, p_language, p_market)::text, 0);
  v_norm_key := hashtextextended(jsonb_build_array(p_user_id::text, v_norm_topic, p_platform, p_language, p_market)::text, 0);

  IF v_raw_key = v_norm_key THEN
    PERFORM pg_advisory_xact_lock(v_raw_key);
  ELSIF v_raw_key < v_norm_key THEN
    PERFORM pg_advisory_xact_lock(v_raw_key);
    PERFORM pg_advisory_xact_lock(v_norm_key);
  ELSE
    PERFORM pg_advisory_xact_lock(v_norm_key);
    PERFORM pg_advisory_xact_lock(v_raw_key);
  END IF;

  -- Exact target bucket already exists?
  SELECT * INTO v_target FROM video_ideas vi
    WHERE vi.user_id = p_user_id
      AND vi.platform = p_platform AND vi.language = p_language AND vi.market = p_market
      AND (vi.input_hash = p_input_hash OR (vi.normalized_topic IS NOT NULL AND vi.normalized_topic = v_norm_topic))
      AND coalesce(vi.content_lane, '__pending__') = coalesce(p_content_lane, '__pending__')
    LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT v_target.id, v_target.content_lane, v_target.lane_assignment_source, v_target.lane_locked_at, false;
    RETURN;
  END IF;

  IF p_content_lane IS NOT NULL THEN
    -- No exact bucket. Is there a pending row for this natural key to transition?
    SELECT * INTO v_pending FROM video_ideas vi
      WHERE vi.user_id = p_user_id
        AND vi.platform = p_platform AND vi.language = p_language AND vi.market = p_market
        AND (vi.input_hash = p_input_hash OR (vi.normalized_topic IS NOT NULL AND vi.normalized_topic = v_norm_topic))
        AND vi.content_lane IS NULL
      LIMIT 1;

    IF FOUND THEN
      UPDATE video_ideas vi
        SET content_lane = p_content_lane, lane_assignment_source = p_lane_source,
            normalized_topic = coalesce(vi.normalized_topic, v_norm_topic), updated_at = now()
        WHERE vi.id = v_pending.id AND vi.user_id = p_user_id
          AND vi.lane_locked_at IS NULL
          AND vi.content_lane IS NOT DISTINCT FROM p_expected_current_lane
          AND vi.lane_assignment_source IS NOT DISTINCT FROM p_expected_assignment_source
        RETURNING vi.id, vi.content_lane, vi.lane_assignment_source, vi.lane_locked_at INTO v_updated;

      IF NOT FOUND THEN
        IF EXISTS (SELECT 1 FROM video_ideas vi WHERE vi.id = v_pending.id AND vi.lane_locked_at IS NOT NULL) THEN
          RAISE EXCEPTION 'already_locked';
        END IF;
        RAISE EXCEPTION 'stale_lane_assignment';
      END IF;

      RETURN QUERY SELECT v_updated.id, v_updated.content_lane, v_updated.lane_assignment_source, v_updated.lane_locked_at, false;
      RETURN;
    END IF;
    -- No pending row either: fall through to INSERT a fresh (possibly
    -- second-lane-variant) row below.
  ELSE
    -- p_content_lane IS NULL (pending request): invariant B -- if ANY
    -- assigned/locked row exists for this natural key, refuse.
    IF EXISTS (
      SELECT 1 FROM video_ideas vi
      WHERE vi.user_id = p_user_id
        AND vi.platform = p_platform AND vi.language = p_language AND vi.market = p_market
        AND (vi.input_hash = p_input_hash OR (vi.normalized_topic IS NOT NULL AND vi.normalized_topic = v_norm_topic))
        AND vi.content_lane IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'lane_slot_taken';
    END IF;
  END IF;

  INSERT INTO video_ideas (
    user_id, title, topic, platform, language, market, currency, timezone,
    input_hash, normalized_topic, content_lane, lane_assignment_source, workflow_status
  ) VALUES (
    p_user_id, p_topic, p_topic, p_platform, p_language, p_market,
    CASE WHEN p_market = 'HU' THEN 'HUF' ELSE 'USD' END,
    CASE WHEN p_market = 'HU' THEN 'Europe/Budapest' ELSE 'UTC' END,
    p_input_hash, v_norm_topic, p_content_lane, p_lane_source, 'new_idea'
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, p_content_lane, p_lane_source, NULL::timestamptz, true;
END;
$$;

-- 9b. lock_video_idea_lane -- standalone, minimal lock commit. Decoupled
--     from any score/generation RPC on purpose (none exist yet in this
--     foundation layer); a locked-but-scoreless brief is a valid, expected
--     state, and a later score/generation failure never implies the lock
--     itself should roll back.
CREATE OR REPLACE FUNCTION public.lock_video_idea_lane(
  p_user_id uuid, p_video_idea_id uuid
) RETURNS TABLE(video_idea_id uuid, content_lane text, lane_locked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row RECORD;
BEGIN
  IF p_user_id IS NULL OR p_video_idea_id IS NULL THEN
    RAISE EXCEPTION 'lock_video_idea_lane: p_user_id/p_video_idea_id required';
  END IF;

  UPDATE video_ideas vi SET lane_locked_at = now()
    WHERE vi.id = p_video_idea_id AND vi.user_id = p_user_id
      AND vi.content_lane IS NOT NULL AND vi.lane_locked_at IS NULL
    RETURNING vi.id, vi.content_lane, vi.lane_locked_at INTO v_row;

  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM video_ideas vi WHERE vi.id = p_video_idea_id AND vi.user_id = p_user_id) THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF EXISTS (SELECT 1 FROM video_ideas vi WHERE vi.id = p_video_idea_id AND vi.user_id = p_user_id AND vi.lane_locked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'already_locked';
    END IF;
    RAISE EXCEPTION 'lane_pending';
  END IF;

  RETURN QUERY SELECT v_row.id, v_row.content_lane, v_row.lane_locked_at;
END;
$$;

-- 9c. reclassify_video_idea -- creates a new clone row with a lineage
--     pointer; the source row is never mutated. Lane-specific results
--     (legacy scores, proof signals, memory, packages, linked_signal_cluster_id)
--     are deliberately NOT copied -- the clone starts with a clean slate in
--     every lane-specific dimension, per the accepted "never auto-transfer
--     lane-specific results across lanes" principle. The clone starts
--     assigned_unlocked (NOT locked), so it goes through the same
--     confirmation window as any other brief.
CREATE OR REPLACE FUNCTION public.reclassify_video_idea(
  p_user_id uuid, p_source_video_idea_id uuid, p_new_lane text, p_new_source text
) RETURNS TABLE(new_video_idea_id uuid, reclassified_from_video_idea_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_src RECORD; v_new_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_source_video_idea_id IS NULL THEN
    RAISE EXCEPTION 'reclassify_video_idea: p_user_id/p_source_video_idea_id required';
  END IF;
  IF p_new_lane NOT IN ('evidence_led', 'entertainment_led') THEN
    RAISE EXCEPTION 'reclassify_video_idea: invalid p_new_lane %', p_new_lane;
  END IF;
  IF coalesce(p_new_source, '') NOT IN ('explicit_user', 'profile_default_confirmed', 'project_inherit_confirmed', 'legacy_user_confirmed') THEN
    RAISE EXCEPTION 'reclassify_video_idea: invalid p_new_source %', p_new_source;
  END IF;

  SELECT * INTO v_src FROM video_ideas WHERE id = p_source_video_idea_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  INSERT INTO video_ideas (
    user_id, title, topic, short_description, niche, platform, language, market,
    country, currency, timezone, content_format, keywords,
    input_hash, normalized_topic, content_lane, lane_assignment_source,
    reclassified_from_video_idea_id, workflow_status
  ) VALUES (
    v_src.user_id, v_src.title, v_src.topic, v_src.short_description, v_src.niche,
    v_src.platform, v_src.language, v_src.market, v_src.country, v_src.currency, v_src.timezone,
    v_src.content_format, v_src.keywords,
    v_src.input_hash, v_src.normalized_topic, p_new_lane, p_new_source,
    v_src.id, 'new_idea'
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, v_src.id;
END;
$$;

-- 9d. link_creator_memory_parent -- the intended ONLY app-reachable path
--     for writing creator_memory.video_idea_id / content_lane going
--     forward (see the NEW application's linkVideoIdeaToLegacyRecord()).
--     During this EXPAND phase, service_role still ALSO has raw table-level
--     INSERT/UPDATE on creator_memory (see this file's header -- the
--     column-level REVOKE that makes this RPC the ONLY path is deferred to
--     068), which is exactly what keeps the OLD application's direct
--     `video_idea_id` write in its upsert payload working unmodified.
CREATE OR REPLACE FUNCTION public.link_creator_memory_parent(
  p_user_id uuid, p_memory_id uuid, p_video_idea_id uuid
) RETURNS TABLE(memory_id uuid, video_idea_id uuid, content_lane text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_parent RECORD; v_mem RECORD; v_result RECORD;
BEGIN
  IF p_user_id IS NULL OR p_memory_id IS NULL OR p_video_idea_id IS NULL THEN
    RAISE EXCEPTION 'link_creator_memory_parent: all parameters required';
  END IF;

  SELECT * INTO v_mem FROM creator_memory WHERE id = p_memory_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF v_mem.video_idea_id IS NOT NULL AND v_mem.video_idea_id IS DISTINCT FROM p_video_idea_id THEN
    RAISE EXCEPTION 'memory_reparent_forbidden';
  END IF;
  IF v_mem.video_idea_id IS NULL AND v_mem.content_lane IS NOT NULL THEN
    RAISE EXCEPTION 'memory_reparent_forbidden_orphan';
  END IF;

  SELECT * INTO v_parent FROM video_ideas vi WHERE vi.id = p_video_idea_id AND vi.user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'parent_not_found'; END IF;

  UPDATE creator_memory cm
    SET video_idea_id = p_video_idea_id,
        content_lane = CASE WHEN v_parent.lane_locked_at IS NOT NULL THEN v_parent.content_lane ELSE cm.content_lane END
    WHERE cm.id = p_memory_id AND cm.user_id = p_user_id
    RETURNING cm.id, cm.video_idea_id, cm.content_lane INTO v_result;

  RETURN QUERY SELECT v_result.id, v_result.video_idea_id, v_result.content_lane;
END;
$$;

-- 9e. upsert_creator_memory -- the intended ONLY app-reachable path for
--     writing creator_memory rows going forward (replaces the raw
--     `.upsert(record, {onConflict:'user_id,topic'})` PostgREST call the
--     NEW application no longer uses). The OLD application's raw
--     `.upsert(..., {onConflict:'user_id,topic'})` calls in
--     app/api/memory/route.ts and app/api/video-audit/route.ts remain
--     fully unmodified and fully functional during this EXPAND phase, since
--     creator_memory_user_id_topic_key (the plain-column unique object
--     PostgREST's on_conflict inference needs -- and, in production,
--     also the redundant creator_memory_user_topic_unique, see section 6c)
--     is deliberately left in place -- see this file's header.
--
--     p_content_lane = NULL targets ONLY the pending-lane row for
--     (p_user_id, p_topic) via `ON CONFLICT (user_id, topic)
--     WHERE content_lane IS NULL` -- this is a WHERE-qualified ON CONFLICT
--     target, which Postgres supports natively in a function body even
--     though PostgREST's on_conflict query parameter cannot express one.
--     p_content_lane = 'evidence_led'/'entertainment_led' targets ONLY
--     that lane's row via `ON CONFLICT (user_id, topic, content_lane)
--     WHERE content_lane IS NOT NULL`. Neither branch ever reads or writes
--     the other lane's row -- there is no code path in this function that
--     can merge or cross-touch two different content_lane buckets.
--
--     Creating (INSERT) a row with p_content_lane NOT NULL requires
--     p_video_idea_id (the row's content_lane and video_idea_id are set
--     together, atomically, in the same INSERT), because the
--     creator_memory_lane_consistency trigger (section 8) requires a
--     locked, tenant-matched, lane-matched parent for ANY first-time
--     content_lane assignment -- this function does not weaken or bypass
--     that trigger, it satisfies its precondition up front. A legacy/
--     pending upsert (p_content_lane NULL) never needs p_video_idea_id.
--
--     EXPAND-PHASE FAIL-CLOSED BEHAVIOR (see the p_content_lane NOT NULL
--     branch below for the full mechanism): during EXPAND (067 applied,
--     068 not yet), a lane-tagged upsert for a topic that already has a
--     legacy/pending row OR a different lane's row still collides with
--     whichever legacy constraint(s) are present --
--     creator_memory_user_id_topic_key everywhere, and in production also
--     creator_memory_user_topic_unique -- this is a real, mathematically
--     unavoidable limitation of this phase
--     (true multi-lane coexistence for an already-occupied topic is
--     impossible until 068 drops that constraint), not a bug this function
--     can paper over. Rather than let a raw
--     "duplicate key value violates unique constraint ..." Postgres error
--     leak to the caller, this branch narrows on that exact constraint via
--     GET STACKED DIAGNOSTICS and raises a single, stable, documented
--     `lane_conflict_pending_contract` error instead (SQLSTATE 23505
--     preserved, so callers already branching on unique-violation class
--     still see a conflict, not a generic failure). No current application
--     code path can trigger this (the lane UI does not exist yet -- every
--     real caller passes p_content_lane = NULL), but the RPC layer itself
--     must not depend on that being true to fail safely.
--
--     An advisory lock scoped to (user_id, topic, lane-bucket) is held for
--     the duration of the upsert as an explicit, redundant concurrency
--     guard alongside the native ON CONFLICT atomicity -- belt-and-braces,
--     consistent with the advisory-lock style already used by
--     ensure_video_idea_lane.
CREATE OR REPLACE FUNCTION public.upsert_creator_memory(
  p_user_id uuid,
  p_topic text,
  p_content_lane text,
  p_video_idea_id uuid,
  p_search_keyword text,
  p_state text,
  p_opportunity_score integer,
  p_viral_score integer,
  p_platform text,
  p_notes text,
  p_audit_score integer,
  p_audit_id uuid,
  p_video_package_id uuid,
  p_source_context text,
  p_quality_status text
) RETURNS creator_memory
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_topic text := btrim(coalesce(p_topic, ''));
  v_lock_key bigint;
  v_row creator_memory;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'upsert_creator_memory: p_user_id required'; END IF;
  IF v_topic = '' THEN RAISE EXCEPTION 'upsert_creator_memory: p_topic required'; END IF;
  IF p_content_lane IS NOT NULL AND p_content_lane NOT IN ('evidence_led', 'entertainment_led') THEN
    RAISE EXCEPTION 'upsert_creator_memory: invalid p_content_lane %', p_content_lane;
  END IF;
  IF p_content_lane IS NOT NULL AND p_video_idea_id IS NULL THEN
    RAISE EXCEPTION 'upsert_creator_memory: p_video_idea_id required when p_content_lane is set';
  END IF;

  v_lock_key := hashtextextended(
    jsonb_build_array(p_user_id::text, v_topic, coalesce(p_content_lane, '__pending__'))::text, 0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF p_content_lane IS NULL THEN
    INSERT INTO creator_memory (
      user_id, topic, search_keyword, state, opportunity_score, viral_score,
      platform, notes, audit_score, audit_id, video_package_id, source_context, quality_status, updated_at
    ) VALUES (
      p_user_id, v_topic, p_search_keyword, coalesce(p_state, 'saved'), p_opportunity_score, p_viral_score,
      coalesce(p_platform, 'youtube'), p_notes, p_audit_score, p_audit_id, p_video_package_id, p_source_context, p_quality_status, now()
    )
    ON CONFLICT (user_id, topic) WHERE content_lane IS NULL
    DO UPDATE SET
      search_keyword = excluded.search_keyword,
      state = excluded.state,
      opportunity_score = excluded.opportunity_score,
      viral_score = excluded.viral_score,
      platform = excluded.platform,
      notes = excluded.notes,
      audit_score = coalesce(excluded.audit_score, creator_memory.audit_score),
      audit_id = coalesce(excluded.audit_id, creator_memory.audit_id),
      video_package_id = coalesce(excluded.video_package_id, creator_memory.video_package_id),
      source_context = coalesce(excluded.source_context, creator_memory.source_context),
      quality_status = coalesce(excluded.quality_status, creator_memory.quality_status),
      updated_at = now()
    RETURNING * INTO v_row;
  ELSE
    -- EXPAND-PHASE ONLY: while EITHER legacy global (user_id, topic)
    -- constraint -- creator_memory_user_id_topic_key (present in every
    -- environment) and, in production specifically,
    -- creator_memory_user_topic_unique (a redundant duplicate, see
    -- 042_capture_creator_memory_schema_drift.sql and the drift-check
    -- precheck in section 6c above) -- remains present until 068 drops
    -- them, they coexist with this branch's own ON CONFLICT target
    -- (idx_creator_memory_user_topic_lane), but the two are NOT the same
    -- object -- ON CONFLICT only suppresses a conflict against the target
    -- it names. If a legacy/pending (content_lane IS NULL) row, or a
    -- DIFFERENT lane's row, already exists for this (user_id, topic), the
    -- INSERT below still collides with whichever legacy constraint(s) are
    -- present and Postgres raises a genuine, uncaught unique_violation --
    -- true dual/triple-lane coexistence for an already-occupied topic is
    -- mathematically impossible to guarantee while either legacy
    -- constraint remains, and no amount of application-layer handling
    -- changes that; only 068's drop of both actually fixes it. What IS
    -- this migration's job: make that expected-during-EXPAND failure fail
    -- closed and legible instead of leaking a raw constraint name to the
    -- caller. Every other unique_violation (there are none expected in
    -- practice here, since the ON CONFLICT target above already absorbs
    -- the one this branch legitimately owns) is re-raised completely
    -- unchanged -- this handler narrows on the two exact legacy constraint
    -- names via GET STACKED DIAGNOSTICS, it does not blanket-swallow
    -- unique_violation.
    BEGIN
      INSERT INTO creator_memory (
        user_id, topic, content_lane, video_idea_id, search_keyword, state, opportunity_score, viral_score,
        platform, notes, audit_score, audit_id, video_package_id, source_context, quality_status, updated_at
      ) VALUES (
        p_user_id, v_topic, p_content_lane, p_video_idea_id, p_search_keyword, coalesce(p_state, 'saved'), p_opportunity_score, p_viral_score,
        coalesce(p_platform, 'youtube'), p_notes, p_audit_score, p_audit_id, p_video_package_id, p_source_context, p_quality_status, now()
      )
      ON CONFLICT (user_id, topic, content_lane) WHERE content_lane IS NOT NULL
      DO UPDATE SET
        search_keyword = excluded.search_keyword,
        state = excluded.state,
        opportunity_score = excluded.opportunity_score,
        viral_score = excluded.viral_score,
        platform = excluded.platform,
        notes = excluded.notes,
        audit_score = coalesce(excluded.audit_score, creator_memory.audit_score),
        audit_id = coalesce(excluded.audit_id, creator_memory.audit_id),
        video_package_id = coalesce(excluded.video_package_id, creator_memory.video_package_id),
        source_context = coalesce(excluded.source_context, creator_memory.source_context),
        quality_status = coalesce(excluded.quality_status, creator_memory.quality_status),
        updated_at = now()
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      DECLARE
        v_violated_constraint text;
      BEGIN
        GET STACKED DIAGNOSTICS v_violated_constraint = CONSTRAINT_NAME;
        IF v_violated_constraint IN ('creator_memory_user_id_topic_key', 'creator_memory_user_topic_unique') THEN
          RAISE EXCEPTION 'lane_conflict_pending_contract' USING ERRCODE = '23505';
        END IF;
        RAISE;
      END;
    END;
  END IF;

  RETURN v_row;
END;
$$;

-- ============================================================
-- 10. ACL hardening -- functions (trigger functions: no direct EXECUTE for
--     anyone; RPCs: EXECUTE only for service_role). Mirrors the explicit,
--     all-four-grantee pattern from 045_harden_function_execution.sql. All
--     5 functions are brand-new in this migration, so this section carries
--     no compatibility hazard for either application.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.enforce_video_idea_lane_lock_immutable() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.enforce_creator_memory_identity() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.enforce_creator_memory_lane_consistency() FROM PUBLIC, anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.ensure_video_idea_lane(uuid,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_video_idea_lane(uuid,text,text,text,text,text,text,text,text,text,text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.lock_video_idea_lane(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lock_video_idea_lane(uuid,uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.reclassify_video_idea(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reclassify_video_idea(uuid,uuid,text,text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.link_creator_memory_parent(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_creator_memory_parent(uuid,uuid,uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.upsert_creator_memory(uuid,text,text,uuid,text,text,integer,integer,text,text,integer,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_creator_memory(uuid,text,text,uuid,text,text,integer,integer,text,text,integer,uuid,uuid,text,text) TO service_role;

-- ============================================================
-- 11. Column-level GRANT hardening -- video_ideas
--     Table-level INSERT/UPDATE is revoked from service_role, then
--     re-granted ONLY on the mechanically-audited, PostgREST-proven column
--     lists. The 6 lane-identity columns get no INSERT/UPDATE grant at all
--     (RPC-only, enforced by SECURITY DEFINER function ownership). The
--     write-orphaned JSONB columns (trend_signals, similar_videos,
--     competitor_proof, source_links, hook_ideas, risk_factors) and the
--     genuinely dead audit_result_id column (searched: only ever appears in
--     type definitions and the migration that created it, no .insert()/
--     .update() call anywhere references it) get no pre-emptive grant
--     either. video_package_id is NOT dead code -- an earlier audit pass
--     incorrectly classified it that way; markVideoIdeaReadyToProduce()
--     (lib/video-ideas/video-idea-service.ts), called from the unmodified
--     (both OLD and NEW app, byte-identical since before this migration)
--     POST /api/video-packages route, writes it directly on every video
--     package creation. It is therefore included in the UPDATE allowlist
--     below (never in INSERT -- no insert path sets it at creation time).
--     Safe to apply now, unlike the equivalent creator_memory hardening
--     (deferred to 068): every video_ideas write site in both the OLD and
--     the NEW application (lib/video-ideas/video-idea-service.ts
--     ensureVideoIdea/setVideoIdeaWorkflowStatus/markVideoIdeaReadyToProduce,
--     app/api/title-studio/route.ts, app/api/thumbnail-studio/route.ts,
--     app/api/video-ideas/route.ts PATCH) was individually verified to only
--     ever touch columns on the allowlist below.
-- ============================================================

REVOKE INSERT, UPDATE ON video_ideas FROM service_role;

GRANT INSERT (
  user_id, input_hash, title, topic, short_description, niche, platform, language, market,
  country, currency, timezone, content_format, keywords, proof_summary, workflow_status,
  paid_result_reference, metadata, updated_at, viral_score, opportunity_score, competition_score
) ON video_ideas TO service_role;

GRANT UPDATE (
  title, topic, short_description, niche, platform, language, market,
  country, currency, timezone, content_format, keywords, proof_summary, workflow_status,
  paid_result_reference, metadata, updated_at, title_ideas, thumbnail_concepts,
  calendar_status, publish_status, scheduled_publish_date, calendar_notes,
  viral_score, opportunity_score, competition_score, video_package_id
) ON video_ideas TO service_role;

-- ============================================================
-- 11a. authenticated-role table-level DML hardening -- creator_memory
--
--     A read-only, whole-codebase audit (every `.from('creator_memory')`
--     call site, `app/api/*/route.ts` and every `.tsx` page/component) found
--     ZERO current or legacy client-authenticated (i.e. RLS-scoped,
--     `createServerSupabaseClient()`/browser-client) writes to
--     creator_memory anywhere -- every INSERT/UPDATE/DELETE in the entire
--     codebase (app/api/memory/route.ts POST/PATCH/DELETE,
--     app/api/video-audit/route.ts) goes through `createAdminClient()`
--     (service_role), never the authenticated-role client. The ONLY
--     authenticated-role creator_memory access anywhere is a single
--     read-only SELECT (app/dashboard/page.tsx). This was independently
--     confirmed against real production catalog metadata: `authenticated`
--     currently holds table-level INSERT/UPDATE/DELETE/SELECT on
--     creator_memory in production, but nothing in the application ever
--     exercises the write privileges.
--
--     Consequence this migration must close, THIS PHASE not 068: the
--     moment content_lane is added as a column (above, this same
--     migration), `authenticated`'s pre-existing, unrestricted table-level
--     INSERT/UPDATE grant would automatically extend to it too -- a
--     lane-identity column becoming authenticated-writable is a direct
--     contradiction of the documented RPC-only lane-identity contract, and
--     waiting for 068 to fix it would leave that hole open for this
--     migration's entire EXPAND-phase production lifetime. Since the write
--     privilege is proven completely unused, the fix is a full revoke, not
--     a column-by-column allowlist: `authenticated` loses INSERT/UPDATE/
--     DELETE on creator_memory ENTIRELY here. SELECT (proven used, and
--     backed by the pre-existing, untouched `memory_select_own` RLS
--     policy) is deliberately excluded from this REVOKE and remains
--     exactly as it was. The four RLS policies themselves
--     (memory_insert_own/update_own/delete_own/select_own) are not
--     touched by this migration either -- revoking the underlying grant
--     they'd otherwise gate makes the effective security posture strictly
--     MORE conservative, never weaker: a policy with no grant beneath it
--     simply has nothing left to ever allow.
--
--     PUBLIC and anon already have zero creator_memory DML grants in
--     production today (independently confirmed via the same metadata
--     read) -- no action needed for either, only defensive validation
--     below that this remains true.
-- ============================================================

REVOKE INSERT, UPDATE, DELETE ON creator_memory FROM authenticated;

-- ============================================================
-- 12. Fail-fast end-state validation -- EXPAND phase
--     Asserts both what MUST already be true (new schema fully present and
--     functional) and what must NOT yet be true (the old creator_memory
--     constraint still present; creator_memory.video_idea_id/content_lane
--     still directly writable by service_role) -- the latter guards against
--     068's contract steps ever being accidentally merged into this file.
-- ============================================================

DO $validate$
DECLARE
  v_missing_cols int;
  v_missing_constraints int;
  v_missing_indexes int;
  v_bad_grants int;
  v_missing_triggers int;
  v_missing_functions int;
BEGIN
  -- columns
  SELECT count(*) INTO v_missing_cols FROM (VALUES
    ('profiles','primary_creator_lane'),
    ('video_ideas','content_lane'), ('video_ideas','lane_assignment_source'),
    ('video_ideas','lane_locked_at'), ('video_ideas','reclassified_from_video_idea_id'),
    ('video_ideas','linked_signal_cluster_id'), ('video_ideas','normalized_topic'),
    ('creator_memory','content_lane')
  ) AS expected(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=expected.tbl AND c.column_name=expected.col
  );
  IF v_missing_cols > 0 THEN
    RAISE EXCEPTION '067 EXPAND validation failed: % expected column(s) missing', v_missing_cols;
  END IF;

  -- constraints
  SELECT count(*) INTO v_missing_constraints FROM (VALUES
    ('profiles_primary_creator_lane_valid'),
    ('video_ideas_reclassified_from_fkey'),
    ('video_ideas_lane_state_valid'),
    ('video_ideas_signal_cluster_requires_evidence_lock'),
    ('video_ideas_reclassify_no_self_reference'),
    ('video_ideas_normalized_topic_sane'),
    ('creator_memory_content_lane_valid')
  ) AS expected(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = expected.name);
  IF v_missing_constraints > 0 THEN
    RAISE EXCEPTION '067 EXPAND validation failed: % expected constraint(s) missing', v_missing_constraints;
  END IF;

  -- EXPAND-SPECIFIC: creator_memory's OLD global (user_id, topic) unique
  -- constraint MUST STILL BE PRESENT -- this is the whole point of the
  -- expand/contract split (see this file's header). If it is missing here,
  -- the OLD application's onConflict='user_id,topic' upsert calls would
  -- already be broken.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_memory_user_id_topic_key') THEN
    RAISE EXCEPTION '067 EXPAND validation failed: creator_memory_user_id_topic_key must still be present in the expand phase (dropped only in 068)';
  END IF;

  -- indexes
  SELECT count(*) INTO v_missing_indexes FROM (VALUES
    ('idx_video_ideas_user_input_hash_lane'),
    ('idx_video_ideas_user_topic_platform_lane'),
    ('idx_creator_memory_user_topic_pending'),
    ('idx_creator_memory_user_topic_lane')
  ) AS expected(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = expected.name)
     OR NOT EXISTS (
       SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = expected.name AND i.indisvalid AND i.indisready
     );
  IF v_missing_indexes > 0 THEN
    RAISE EXCEPTION '067 EXPAND validation failed: % expected index(es) missing or invalid', v_missing_indexes;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname IN ('idx_video_ideas_user_input_hash','idx_video_ideas_user_topic_platform')) THEN
    RAISE EXCEPTION '067 EXPAND validation failed: old pre-lane video_ideas index(es) still present';
  END IF;

  -- triggers
  SELECT count(*) INTO v_missing_triggers FROM (VALUES
    ('video_ideas','video_ideas_lane_lock_immutable'),
    ('creator_memory','creator_memory_identity_immutable'),
    ('creator_memory','creator_memory_lane_consistency')
  ) AS expected(tbl, trg)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = expected.tbl AND t.tgname = expected.trg AND NOT t.tgisinternal
  );
  IF v_missing_triggers > 0 THEN
    RAISE EXCEPTION '067 EXPAND validation failed: % expected trigger(s) missing', v_missing_triggers;
  END IF;

  -- functions exist with correct owner
  SELECT count(*) INTO v_missing_functions FROM (VALUES
    ('public.ensure_video_idea_lane(uuid,text,text,text,text,text,text,text,text,text,text)'),
    ('public.lock_video_idea_lane(uuid,uuid)'),
    ('public.reclassify_video_idea(uuid,uuid,text,text)'),
    ('public.link_creator_memory_parent(uuid,uuid,uuid)'),
    ('public.upsert_creator_memory(uuid,text,text,uuid,text,text,integer,integer,text,text,integer,uuid,uuid,text,text)')
  ) AS expected(sig)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid = expected.sig::regprocedure
      AND (SELECT rolname FROM pg_roles WHERE oid = p.proowner) = 'postgres'
      AND p.prosecdef = true
  );
  IF v_missing_functions > 0 THEN
    RAISE EXCEPTION '067 EXPAND validation failed: % expected SECURITY DEFINER function(s) missing or misowned', v_missing_functions;
  END IF;

  -- RPC EXECUTE ACL
  SELECT count(*) INTO v_bad_grants FROM (VALUES
    ('public.ensure_video_idea_lane(uuid,text,text,text,text,text,text,text,text,text,text)','anon',false),
    ('public.ensure_video_idea_lane(uuid,text,text,text,text,text,text,text,text,text,text)','authenticated',false),
    ('public.ensure_video_idea_lane(uuid,text,text,text,text,text,text,text,text,text,text)','service_role',true),
    ('public.lock_video_idea_lane(uuid,uuid)','anon',false),
    ('public.lock_video_idea_lane(uuid,uuid)','authenticated',false),
    ('public.lock_video_idea_lane(uuid,uuid)','service_role',true),
    ('public.reclassify_video_idea(uuid,uuid,text,text)','anon',false),
    ('public.reclassify_video_idea(uuid,uuid,text,text)','authenticated',false),
    ('public.reclassify_video_idea(uuid,uuid,text,text)','service_role',true),
    ('public.link_creator_memory_parent(uuid,uuid,uuid)','anon',false),
    ('public.link_creator_memory_parent(uuid,uuid,uuid)','authenticated',false),
    ('public.link_creator_memory_parent(uuid,uuid,uuid)','service_role',true),
    ('public.upsert_creator_memory(uuid,text,text,uuid,text,text,integer,integer,text,text,integer,uuid,uuid,text,text)','anon',false),
    ('public.upsert_creator_memory(uuid,text,text,uuid,text,text,integer,integer,text,text,integer,uuid,uuid,text,text)','authenticated',false),
    ('public.upsert_creator_memory(uuid,text,text,uuid,text,text,integer,integer,text,text,integer,uuid,uuid,text,text)','service_role',true),
    ('public.enforce_video_idea_lane_lock_immutable()','service_role',false),
    ('public.enforce_creator_memory_identity()','service_role',false),
    ('public.enforce_creator_memory_lane_consistency()','service_role',false)
  ) AS expected(sig, grantee, expected)
  WHERE has_function_privilege(expected.grantee, expected.sig::regprocedure, 'EXECUTE') IS DISTINCT FROM expected.expected;
  IF v_bad_grants > 0 THEN
    RAISE EXCEPTION '067 EXPAND validation failed: % function EXECUTE privilege mismatch(es)', v_bad_grants;
  END IF;

  -- video_ideas protected column grants: must be absent for service_role
  SELECT count(*) INTO v_bad_grants FROM (VALUES
    ('video_ideas','content_lane'), ('video_ideas','lane_assignment_source'),
    ('video_ideas','lane_locked_at'), ('video_ideas','reclassified_from_video_idea_id'),
    ('video_ideas','linked_signal_cluster_id'), ('video_ideas','normalized_topic')
  ) AS protected(tbl, col)
  WHERE has_column_privilege('service_role', protected.tbl, protected.col, 'INSERT')
     OR has_column_privilege('service_role', protected.tbl, protected.col, 'UPDATE');
  IF v_bad_grants > 0 THEN
    RAISE EXCEPTION '067 EXPAND validation failed: % protected video_ideas column(s) unexpectedly writable by service_role', v_bad_grants;
  END IF;

  -- video_ideas allowlisted column grants: must be present for service_role
  SELECT count(*) INTO v_bad_grants FROM (VALUES
    ('video_ideas','title','INSERT'), ('video_ideas','title','UPDATE'),
    ('video_ideas','topic','INSERT'), ('video_ideas','topic','UPDATE'),
    ('video_ideas','user_id','INSERT'),
    ('video_ideas','input_hash','INSERT'),
    ('video_ideas','title_ideas','UPDATE'), ('video_ideas','thumbnail_concepts','UPDATE'),
    ('video_ideas','calendar_status','UPDATE'), ('video_ideas','publish_status','UPDATE'),
    ('video_ideas','scheduled_publish_date','UPDATE'), ('video_ideas','calendar_notes','UPDATE'),
    ('video_ideas','viral_score','INSERT'), ('video_ideas','viral_score','UPDATE'),
    ('video_ideas','opportunity_score','INSERT'), ('video_ideas','competition_score','INSERT'),
    ('video_ideas','video_package_id','UPDATE')
  ) AS allowlisted(tbl, col, priv)
  WHERE NOT has_column_privilege('service_role', allowlisted.tbl, allowlisted.col, allowlisted.priv);
  IF v_bad_grants > 0 THEN
    RAISE EXCEPTION '067 EXPAND validation failed: % allowlisted video_ideas column privilege(s) missing for service_role', v_bad_grants;
  END IF;

  -- video_ideas.user_id / input_hash must NOT be UPDATE-able
  IF has_column_privilege('service_role', 'video_ideas', 'user_id', 'UPDATE')
     OR has_column_privilege('service_role', 'video_ideas', 'input_hash', 'UPDATE') THEN
    RAISE EXCEPTION '067 EXPAND validation failed: video_ideas.user_id/input_hash unexpectedly UPDATE-able by service_role';
  END IF;

  -- EXPAND-SPECIFIC: creator_memory.video_idea_id and content_lane MUST
  -- STILL be directly writable by service_role in this phase (table-level
  -- INSERT/UPDATE was never revoked on creator_memory) -- this is exactly
  -- what keeps the OLD application's direct video_idea_id write compatible.
  -- The RPC-only restriction is applied in 068, after the new application
  -- is live.
  IF NOT has_column_privilege('service_role', 'creator_memory', 'video_idea_id', 'INSERT')
     OR NOT has_column_privilege('service_role', 'creator_memory', 'video_idea_id', 'UPDATE')
     OR NOT has_column_privilege('service_role', 'creator_memory', 'content_lane', 'INSERT')
     OR NOT has_column_privilege('service_role', 'creator_memory', 'content_lane', 'UPDATE')
  THEN
    RAISE EXCEPTION '067 EXPAND validation failed: creator_memory.video_idea_id/content_lane must still be directly writable by service_role in the expand phase (restricted only in 068)';
  END IF;

  -- authenticated: table-level INSERT/UPDATE/DELETE on creator_memory must
  -- be GONE (section 11a) -- proven unused by any real code path, revoked
  -- here rather than left open for 068. SELECT must remain (proven used
  -- by app/dashboard/page.tsx, backed by the untouched memory_select_own
  -- RLS policy).
  IF has_table_privilege('authenticated', 'creator_memory', 'INSERT')
     OR has_table_privilege('authenticated', 'creator_memory', 'UPDATE')
     OR has_table_privilege('authenticated', 'creator_memory', 'DELETE')
  THEN
    RAISE EXCEPTION '067 EXPAND validation failed: authenticated unexpectedly still has INSERT/UPDATE/DELETE on creator_memory';
  END IF;
  IF NOT has_table_privilege('authenticated', 'creator_memory', 'SELECT') THEN
    RAISE EXCEPTION '067 EXPAND validation failed: authenticated unexpectedly lost SELECT on creator_memory (must remain -- app/dashboard/page.tsx reads it)';
  END IF;

  -- PUBLIC and anon: defensive re-affirmation that neither has ever had
  -- creator_memory DML (confirmed against real production metadata before
  -- this migration was written) -- this migration grants nothing to
  -- either, so this only guards against some other, unrelated drift.
  IF has_table_privilege('anon', 'creator_memory', 'INSERT')
     OR has_table_privilege('anon', 'creator_memory', 'UPDATE')
     OR has_table_privilege('anon', 'creator_memory', 'DELETE')
     OR has_table_privilege('public', 'creator_memory', 'INSERT')
     OR has_table_privilege('public', 'creator_memory', 'UPDATE')
     OR has_table_privilege('public', 'creator_memory', 'DELETE')
  THEN
    RAISE EXCEPTION '067 EXPAND validation failed: anon/PUBLIC unexpectedly has DML on creator_memory';
  END IF;

  -- authenticated: video_ideas parity check -- authenticated must never
  -- have had table-level DML on video_ideas either (this migration does
  -- not grant it any; confirmed against production metadata: authenticated
  -- has only REFERENCES/TRIGGER/TRUNCATE there today, matching anon).
  IF has_table_privilege('authenticated', 'video_ideas', 'INSERT')
     OR has_table_privilege('authenticated', 'video_ideas', 'UPDATE')
     OR has_table_privilege('authenticated', 'video_ideas', 'DELETE')
  THEN
    RAISE EXCEPTION '067 EXPAND validation failed: authenticated unexpectedly has DML on video_ideas';
  END IF;
END;
$validate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
