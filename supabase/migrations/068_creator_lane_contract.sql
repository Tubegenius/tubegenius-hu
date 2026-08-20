-- ============================================================
-- Migration 068: Creator Lane Architecture v0 -- CONTRACT phase
--
-- This is the CONTRACT half of the two-phase, zero-downtime expand/
-- contract rollout described in 067_creator_lane_expand.sql's header. Read
-- that header first -- it explains why this migration exists as a separate
-- file instead of being merged into 067.
--
-- PRODUCTION GATE: this migration must NEVER be applied to production
-- until the NEW application (the one using upsert_creator_memory /
-- link_creator_memory_parent instead of raw creator_memory upserts) is
-- confirmed live and serving all traffic. Applying it while the OLD
-- application is still live, or still reachable via rollback, breaks the
-- OLD application immediately:
--   * its `creator_memory.upsert(record, {onConflict:'user_id,topic'})`
--     calls lose the plain-column unique object PostgREST's on_conflict
--     inference needs (SQLSTATE 42P10), because this migration drops
--     creator_memory_user_id_topic_key;
--   * its direct `video_idea_id` write inside that same upsert payload is
--     rejected with "permission denied for column video_idea_id", because
--     this migration revokes service_role's direct column-level
--     INSERT/UPDATE on creator_memory.video_idea_id / content_lane.
--
-- SCOPE -- CONTRACT phase, breaking/tightening only:
--   * drop the old creator_memory_user_id_topic_key unique constraint (and
--     the redundant creator_memory_user_topic_unique, if present -- see
--     042_capture_creator_memory_schema_drift.sql), which is what makes
--     the two lane-partitioned partial unique indexes added in 067
--     (idx_creator_memory_user_topic_pending / idx_creator_memory_user_topic_lane)
--     actually load-bearing: a second, different-lane row for an
--     already-occupied topic was structurally blocked by the old
--     constraint until this drop, even though both new indexes already
--     existed after 067.
--   * creator_memory column-level GRANT/REVOKE hardening: table-level
--     REVOKE INSERT/UPDATE from service_role, then re-GRANT only on the
--     mechanically-audited allowlist below (video_idea_id and content_lane
--     excluded -- RPC-only from this point on, matching the pattern
--     already applied to video_ideas in 067).
--
-- Everything else -- the new columns, CHECK constraints, triggers, RPCs,
-- and video_ideas grant hardening -- was already applied by 067 and is left
-- untouched here.
--
-- After this migration, the full three-state creator_memory model
-- (NULL/pending, evidence_led, entertainment_led coexisting for the same
-- user_id+topic) is load-bearing and enforced, and creator_memory.
-- video_idea_id/content_lane are RPC-only for every caller, matching
-- video_ideas' existing lane-identity column protection.
--
-- Follows the same create-XOR-validate-else-exception, fail-fast
-- convention as 067 and 045_harden_function_execution.sql: the drop is
-- preceded by an explicit duplicate precheck and an exact drift check on
-- the old constraint's definition (RAISE EXCEPTION on any mismatch rather
-- than silently dropping something unexpected), and the whole migration is
-- a safe no-op on a byte-identical re-run -- including when re-run against
-- a database that is ALREADY in the post-contract state (every step below
-- is conditioned on the old constraint / old grants still being present).
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Fail-fast precheck -- must hold given 067's uniqueness model, but
--    re-verified explicitly here (defense in depth, cheap) rather than
--    assumed, in case of any out-of-band write between 067 and 068.
-- ============================================================

DO $$
DECLARE
  v_dupe_count int;
BEGIN
  SELECT count(*) INTO v_dupe_count FROM (
    SELECT user_id, topic FROM creator_memory WHERE content_lane IS NULL GROUP BY 1, 2 HAVING count(*) > 1
  ) dupes;
  IF v_dupe_count > 0 THEN
    RAISE EXCEPTION '068 CONTRACT precheck failed: % duplicate (user_id, topic) pending-lane group(s) found in creator_memory', v_dupe_count;
  END IF;

  SELECT count(*) INTO v_dupe_count FROM (
    SELECT user_id, topic, content_lane FROM creator_memory WHERE content_lane IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1
  ) dupes;
  IF v_dupe_count > 0 THEN
    RAISE EXCEPTION '068 CONTRACT precheck failed: % duplicate (user_id, topic, content_lane) group(s) found in creator_memory', v_dupe_count;
  END IF;
END $$;

-- ============================================================
-- 2. Drop the old global (user_id, topic) unique object(s) -- fail-fast on
--    any unexpected drift in their definition before dropping, and a safe
--    no-op if already gone (idempotent re-run / already-contracted DB).
-- ============================================================

DO $$
DECLARE
  v_old_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_old_def FROM pg_constraint WHERE conname = 'creator_memory_user_id_topic_key';
  IF v_old_def IS NOT NULL AND v_old_def <> 'UNIQUE (user_id, topic)' THEN
    RAISE EXCEPTION '068 CONTRACT drift: creator_memory_user_id_topic_key definition does not match expected ("UNIQUE (user_id, topic)"), got: %', v_old_def;
  END IF;
  IF v_old_def IS NOT NULL THEN
    ALTER TABLE creator_memory DROP CONSTRAINT creator_memory_user_id_topic_key;
  END IF;

  -- Production has historically carried a second, redundant UNIQUE
  -- constraint with the identical (user_id, topic) definition (documented
  -- in 042_capture_creator_memory_schema_drift.sql) -- drop it too if
  -- present, same drift-check discipline.
  SELECT pg_get_constraintdef(oid) INTO v_old_def FROM pg_constraint WHERE conname = 'creator_memory_user_topic_unique';
  IF v_old_def IS NOT NULL AND v_old_def <> 'UNIQUE (user_id, topic)' THEN
    RAISE EXCEPTION '068 CONTRACT drift: creator_memory_user_topic_unique definition does not match expected ("UNIQUE (user_id, topic)"), got: %', v_old_def;
  END IF;
  IF v_old_def IS NOT NULL THEN
    ALTER TABLE creator_memory DROP CONSTRAINT creator_memory_user_topic_unique;
  END IF;
END $$;

-- ============================================================
-- 3. Re-affirm the two lane-partitioned partial unique indexes exist and
--    are valid (they were created by 067; this is a defensive, idempotent
--    safety net, not a first creation -- see 067 section 6 for the full
--    rationale and the precheck proof that their creation there could
--    never have collided with the still-present old constraint).
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_memory_user_topic_pending
  ON creator_memory(user_id, topic) WHERE content_lane IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_memory_user_topic_lane
  ON creator_memory(user_id, topic, content_lane) WHERE content_lane IS NOT NULL;

-- ============================================================
-- 4. Column-level GRANT hardening -- creator_memory
--     user_id gets BOTH INSERT and UPDATE (empirically proven required: the
--     real PostgREST merge-duplicates upsert with on_conflict=user_id,topic
--     includes the conflict-key columns in its generated DO UPDATE SET,
--     even though the value never actually changes on a true conflict) --
--     the identity-immutability trigger from 067 is what actually prevents
--     tenant drift, not the absence of a grant. video_idea_id and
--     content_lane are DELIBERATELY EXCLUDED from both allowlists below --
--     from this point on they are writable ONLY through the
--     link_creator_memory_parent / upsert_creator_memory SECURITY DEFINER
--     RPCs added in 067, matching the pattern already applied to
--     video_ideas' lane-identity columns.
-- ============================================================

REVOKE INSERT, UPDATE ON creator_memory FROM service_role;

GRANT INSERT (
  user_id, topic, search_keyword, state, opportunity_score, viral_score, platform, notes,
  updated_at, audit_score, audit_id, video_package_id, source_context, quality_status
) ON creator_memory TO service_role;

GRANT UPDATE (
  user_id, topic, search_keyword, state, opportunity_score, viral_score, platform, notes,
  updated_at, audit_score, audit_id, video_package_id, source_context, quality_status
) ON creator_memory TO service_role;

-- ============================================================
-- 5. Fail-fast end-state validation -- CONTRACT phase
--    Asserts the final, fully-contracted state: old constraint gone, new
--    partial unique indexes valid, creator_memory protected columns no
--    longer directly writable, allowlisted columns still writable. Safe
--    no-op re-run: every assertion below is already satisfied if this
--    migration has run before and nothing regressed it.
-- ============================================================

DO $validate$
DECLARE
  v_missing_indexes int;
  v_bad_grants int;
BEGIN
  -- old global unique object(s) must be GONE
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('creator_memory_user_id_topic_key', 'creator_memory_user_topic_unique')) THEN
    RAISE EXCEPTION '068 CONTRACT validation failed: old global creator_memory (user_id,topic) unique constraint still present';
  END IF;

  -- lane-partitioned partial unique indexes must be valid + ready
  SELECT count(*) INTO v_missing_indexes FROM (VALUES
    ('idx_creator_memory_user_topic_pending'),
    ('idx_creator_memory_user_topic_lane')
  ) AS expected(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = expected.name)
     OR NOT EXISTS (
       SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = expected.name AND i.indisvalid AND i.indisready
     );
  IF v_missing_indexes > 0 THEN
    RAISE EXCEPTION '068 CONTRACT validation failed: % expected index(es) missing or invalid', v_missing_indexes;
  END IF;

  -- protected columns: must be absent for service_role
  SELECT count(*) INTO v_bad_grants FROM (VALUES
    ('creator_memory','video_idea_id'), ('creator_memory','content_lane')
  ) AS protected(tbl, col)
  WHERE has_column_privilege('service_role', protected.tbl, protected.col, 'INSERT')
     OR has_column_privilege('service_role', protected.tbl, protected.col, 'UPDATE');
  IF v_bad_grants > 0 THEN
    RAISE EXCEPTION '068 CONTRACT validation failed: % protected creator_memory column(s) unexpectedly writable by service_role', v_bad_grants;
  END IF;

  -- allowlisted columns: must be present for service_role
  SELECT count(*) INTO v_bad_grants FROM (VALUES
    ('creator_memory','user_id','INSERT'), ('creator_memory','user_id','UPDATE'),
    ('creator_memory','topic','INSERT'), ('creator_memory','topic','UPDATE'),
    ('creator_memory','notes','UPDATE'),
    ('creator_memory','state','INSERT'), ('creator_memory','state','UPDATE'),
    ('creator_memory','search_keyword','INSERT'), ('creator_memory','search_keyword','UPDATE'),
    ('creator_memory','opportunity_score','INSERT'), ('creator_memory','opportunity_score','UPDATE'),
    ('creator_memory','viral_score','INSERT'), ('creator_memory','viral_score','UPDATE'),
    ('creator_memory','platform','INSERT'), ('creator_memory','platform','UPDATE'),
    ('creator_memory','audit_score','INSERT'), ('creator_memory','audit_score','UPDATE'),
    ('creator_memory','audit_id','INSERT'), ('creator_memory','audit_id','UPDATE'),
    ('creator_memory','video_package_id','INSERT'), ('creator_memory','video_package_id','UPDATE'),
    ('creator_memory','source_context','INSERT'), ('creator_memory','source_context','UPDATE'),
    ('creator_memory','quality_status','INSERT'), ('creator_memory','quality_status','UPDATE'),
    ('creator_memory','updated_at','INSERT'), ('creator_memory','updated_at','UPDATE')
  ) AS allowlisted(tbl, col, priv)
  WHERE NOT has_column_privilege('service_role', allowlisted.tbl, allowlisted.col, allowlisted.priv);
  IF v_bad_grants > 0 THEN
    RAISE EXCEPTION '068 CONTRACT validation failed: % allowlisted creator_memory column privilege(s) missing for service_role', v_bad_grants;
  END IF;

  -- CONTRACT-end-state grant check for EVERY relevant grantee, not just
  -- service_role -- authenticated's table-level INSERT/UPDATE/DELETE was
  -- already revoked in 067 (section 11a, proven unused by any real code
  -- path); this is a defensive re-affirmation that it is STILL revoked
  -- after 068, and that SELECT (proven used) is still present. anon/PUBLIC
  -- must have none of INSERT/UPDATE/DELETE either, at any phase.
  IF has_table_privilege('authenticated', 'creator_memory', 'INSERT')
     OR has_table_privilege('authenticated', 'creator_memory', 'UPDATE')
     OR has_table_privilege('authenticated', 'creator_memory', 'DELETE')
  THEN
    RAISE EXCEPTION '068 CONTRACT validation failed: authenticated unexpectedly has INSERT/UPDATE/DELETE on creator_memory';
  END IF;
  IF NOT has_table_privilege('authenticated', 'creator_memory', 'SELECT') THEN
    RAISE EXCEPTION '068 CONTRACT validation failed: authenticated unexpectedly lost SELECT on creator_memory';
  END IF;
  IF has_table_privilege('anon', 'creator_memory', 'INSERT')
     OR has_table_privilege('anon', 'creator_memory', 'UPDATE')
     OR has_table_privilege('anon', 'creator_memory', 'DELETE')
     OR has_table_privilege('public', 'creator_memory', 'INSERT')
     OR has_table_privilege('public', 'creator_memory', 'UPDATE')
     OR has_table_privilege('public', 'creator_memory', 'DELETE')
  THEN
    RAISE EXCEPTION '068 CONTRACT validation failed: anon/PUBLIC unexpectedly has DML on creator_memory';
  END IF;

  -- content_lane/video_idea_id must be non-writable for EVERY grantee, not
  -- just service_role -- authenticated already has no table-level DML at
  -- all (checked above), so this is a defense-in-depth column-level
  -- re-confirmation, not a new restriction.
  IF has_column_privilege('authenticated', 'creator_memory', 'content_lane', 'INSERT')
     OR has_column_privilege('authenticated', 'creator_memory', 'content_lane', 'UPDATE')
     OR has_column_privilege('authenticated', 'creator_memory', 'video_idea_id', 'INSERT')
     OR has_column_privilege('authenticated', 'creator_memory', 'video_idea_id', 'UPDATE')
  THEN
    RAISE EXCEPTION '068 CONTRACT validation failed: authenticated unexpectedly has content_lane/video_idea_id column privilege on creator_memory';
  END IF;
END;
$validate$;

NOTIFY pgrst, 'reload schema';

COMMIT;
