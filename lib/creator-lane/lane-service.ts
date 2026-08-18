import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeText, buildVideoIdeaInputHash } from '@/lib/video-ideas/video-idea-service'

// ============================================================
// Creator Lane Architecture v0 -- foundation service layer
//
// Thin, typed wrappers around the SECURITY DEFINER RPCs added in
// supabase/migrations/067_creator_lane_foundation.sql. This layer is the
// ONLY supported way for application code to mutate the lane-identity
// columns (video_ideas.content_lane/lane_assignment_source/lane_locked_at/
// reclassified_from_video_idea_id, creator_memory.video_idea_id/
// content_lane) -- those columns have no direct service_role INSERT/UPDATE
// grant (see the migration's column-level GRANT section), so any attempt to
// write them outside these RPC calls fails at the database with
// "permission denied for column ...".
//
// This file intentionally does NOT reimplement TypeScript's own
// normalizeText() in SQL -- normalized_topic is always computed here and
// passed byte-identical into the RPC (see buildNaturalKeyParams below).
// ============================================================

export type ContentLane = 'evidence_led' | 'entertainment_led'

export type LaneAssignmentSource =
  | 'explicit_user'
  | 'profile_default_confirmed'
  | 'project_inherit_confirmed'
  | 'legacy_user_confirmed'
  | 'unconfirmed_quick_save'

export interface NaturalKeyInput {
  userId: string
  topic: string
  platform?: string | null
  language?: string | null
  market?: string | null
}

export interface EnsureVideoIdeaLaneResult {
  success: boolean
  videoIdeaId?: string
  contentLane?: ContentLane | null
  laneAssignmentSource?: LaneAssignmentSource | null
  laneLockedAt?: string | null
  created?: boolean
  error?: string
}

function resolveNaturalKey(input: NaturalKeyInput) {
  const topic = input.topic?.trim()
  const platform = input.platform || 'youtube'
  const language = input.language || 'hu'
  const market = input.market || 'HU'
  const normalizedTopic = normalizeText(topic)
  const inputHash = buildVideoIdeaInputHash({ userId: input.userId, topic: topic || '', platform, language, market })
  return { topic, platform, language, market, normalizedTopic, inputHash }
}

// Creates a new video_ideas row for the given (user, natural key), or --
// if a pending row already exists for the same natural key and a lane is
// requested -- transitions that pending row to assigned_unlocked (CAS-
// protected). Never merges across lane buckets, never creates a duplicate
// for an already-occupied bucket (returns a documented `lane_slot_taken` /
// `stale_lane_assignment` / `already_locked` error instead).
export async function ensureVideoIdeaLane(
  admin: SupabaseClient,
  input: NaturalKeyInput & {
    contentLane?: ContentLane | null
    expectedCurrentLane?: ContentLane | null
    expectedAssignmentSource?: LaneAssignmentSource | null
    laneSource?: LaneAssignmentSource | null
  }
): Promise<EnsureVideoIdeaLaneResult> {
  const { topic, platform, language, market, normalizedTopic, inputHash } = resolveNaturalKey(input)
  if (!topic) return { success: false, error: 'missing_topic' }

  const { data, error } = await admin.rpc('ensure_video_idea_lane', {
    p_user_id: input.userId,
    p_topic: topic,
    p_normalized_topic: normalizedTopic,
    p_platform: platform,
    p_language: language,
    p_market: market,
    p_input_hash: inputHash,
    p_content_lane: input.contentLane ?? null,
    p_expected_current_lane: input.expectedCurrentLane ?? null,
    p_expected_assignment_source: input.expectedAssignmentSource ?? null,
    p_lane_source: input.laneSource ?? null,
  })
  if (error) return { success: false, error: error.message }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { success: false, error: 'ensure_video_idea_lane_no_row' }
  return {
    success: true,
    videoIdeaId: row.video_idea_id,
    contentLane: row.content_lane,
    laneAssignmentSource: row.lane_assignment_source,
    laneLockedAt: row.lane_locked_at,
    created: row.created,
  }
}

export interface LockVideoIdeaLaneResult {
  success: boolean
  videoIdeaId?: string
  contentLane?: ContentLane
  laneLockedAt?: string
  error?: string
}

// Standalone lock commit -- deliberately decoupled from any score/generation
// step (none exist yet in this foundation layer). A locked-but-scoreless
// brief is a valid, expected state; a later score/generation failure never
// implies the lock itself should be undone.
export async function lockVideoIdeaLane(
  admin: SupabaseClient,
  input: { userId: string; videoIdeaId: string }
): Promise<LockVideoIdeaLaneResult> {
  const { data, error } = await admin.rpc('lock_video_idea_lane', {
    p_user_id: input.userId,
    p_video_idea_id: input.videoIdeaId,
  })
  if (error) return { success: false, error: error.message }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { success: false, error: 'lock_video_idea_lane_no_row' }
  return { success: true, videoIdeaId: row.video_idea_id, contentLane: row.content_lane, laneLockedAt: row.lane_locked_at }
}

export interface ReclassifyVideoIdeaResult {
  success: boolean
  newVideoIdeaId?: string
  reclassifiedFromVideoIdeaId?: string
  error?: string
}

// Creates a new clone row with a lineage pointer back to the source; the
// source row is never mutated. Lane-specific results are never carried
// over -- the clone starts with a clean slate in every lane-specific
// dimension (legacy scores, proof signals, memory, packages,
// linked_signal_cluster_id all stay unset on the clone).
export async function reclassifyVideoIdea(
  admin: SupabaseClient,
  input: { userId: string; sourceVideoIdeaId: string; newLane: ContentLane; newSource: LaneAssignmentSource }
): Promise<ReclassifyVideoIdeaResult> {
  const { data, error } = await admin.rpc('reclassify_video_idea', {
    p_user_id: input.userId,
    p_source_video_idea_id: input.sourceVideoIdeaId,
    p_new_lane: input.newLane,
    p_new_source: input.newSource,
  })
  if (error) return { success: false, error: error.message }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { success: false, error: 'reclassify_video_idea_no_row' }
  return { success: true, newVideoIdeaId: row.new_video_idea_id, reclassifiedFromVideoIdeaId: row.reclassified_from_video_idea_id }
}

export interface LinkCreatorMemoryParentResult {
  success: boolean
  memoryId?: string
  videoIdeaId?: string
  contentLane?: ContentLane | null
  error?: string
}

// The ONLY app-reachable path that may write creator_memory.video_idea_id /
// content_lane -- see lib/video-ideas/video-idea-service.ts
// linkVideoIdeaToLegacyRecord(), which calls this RPC internally for the
// 'creator_memory' table target.
export async function linkCreatorMemoryParent(
  admin: SupabaseClient,
  input: { userId: string; memoryId: string; videoIdeaId: string }
): Promise<LinkCreatorMemoryParentResult> {
  const { data, error } = await admin.rpc('link_creator_memory_parent', {
    p_user_id: input.userId,
    p_memory_id: input.memoryId,
    p_video_idea_id: input.videoIdeaId,
  })
  if (error) return { success: false, error: error.message }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { success: false, error: 'link_creator_memory_parent_no_row' }
  return { success: true, memoryId: row.memory_id, videoIdeaId: row.video_idea_id, contentLane: row.content_lane }
}

export interface UpsertCreatorMemoryInput {
  userId: string
  topic: string
  contentLane?: ContentLane | null
  videoIdeaId?: string | null
  searchKeyword?: string | null
  state?: string | null
  opportunityScore?: number | null
  viralScore?: number | null
  platform?: string | null
  notes?: string | null
  auditScore?: number | null
  auditId?: string | null
  videoPackageId?: string | null
  sourceContext?: string | null
  qualityStatus?: string | null
}

export interface UpsertCreatorMemoryResult {
  success: boolean
  row?: Record<string, unknown>
  error?: string
}

// The ONLY supported way to create/update a creator_memory row going
// forward. contentLane omitted/null targets ONLY the pending-lane row for
// (userId, topic); a specific contentLane targets ONLY that lane's row --
// the two branches never read or write each other's row. See
// upsert_creator_memory() in supabase/migrations/067_creator_lane_expand.sql
// for why a raw `.upsert(..., {onConflict:'user_id,topic'})` PostgREST call
// can no longer be used for a lane-tagged write (there is no plain-column
// unique object a WHERE-qualified target like this RPC uses could be
// expressed as via PostgREST's on_conflict parameter). During the EXPAND
// phase (067 applied, 068 not yet), the two new lane-partitioned partial
// unique indexes exist ALONGSIDE the legacy global
// creator_memory_user_id_topic_key constraint, not in place of it -- that
// constraint is deliberately kept so the OLD application's
// onConflict:'user_id,topic' upsert calls keep working. The current public
// routes only ever call this function with contentLane omitted/null
// (pending), so none of this is reachable from real traffic yet.
//
// EXPAND-PHASE (067 applied, 068 not yet) error value: a lane-tagged call
// for a topic that already has a legacy/pending row or a different lane's
// row still collides with that legacy constraint and returns
// `error: 'lane_conflict_pending_contract'` -- a stable, documented,
// fail-closed result (never a raw Postgres constraint-name leak, never an
// unhandled exception). No current caller can trigger this (no route sends
// a non-null contentLane yet), but any future lane-UI code calling this
// before 068 lands should treat this exact string as "not yet supported on
// this schema phase," not a generic failure. Only 068 (CONTRACT) dropping
// the legacy constraint makes true same-topic, cross-lane coexistence
// actually possible.
export async function upsertCreatorMemory(
  admin: SupabaseClient,
  input: UpsertCreatorMemoryInput
): Promise<UpsertCreatorMemoryResult> {
  const topic = input.topic?.trim()
  if (!topic) return { success: false, error: 'missing_topic' }

  const { data, error } = await admin.rpc('upsert_creator_memory', {
    p_user_id: input.userId,
    p_topic: topic,
    p_content_lane: input.contentLane ?? null,
    p_video_idea_id: input.videoIdeaId ?? null,
    p_search_keyword: input.searchKeyword ?? null,
    p_state: input.state ?? null,
    p_opportunity_score: input.opportunityScore ?? null,
    p_viral_score: input.viralScore ?? null,
    p_platform: input.platform ?? null,
    p_notes: input.notes ?? null,
    p_audit_score: input.auditScore ?? null,
    p_audit_id: input.auditId ?? null,
    p_video_package_id: input.videoPackageId ?? null,
    p_source_context: input.sourceContext ?? null,
    p_quality_status: input.qualityStatus ?? null,
  })
  if (error) return { success: false, error: error.message }
  if (!data) return { success: false, error: 'upsert_creator_memory_no_row' }
  return { success: true, row: data as Record<string, unknown> }
}

// ============================================================
// Lane-aware creator_memory reads. `contentLane` is a REQUIRED parameter on
// purpose -- there is no default and no overload that omits it, so a lane-
// specific ranking/exclusion code path (e.g. a future evidence_led-only
// Opportunity Engine exclusion set) cannot accidentally read across lanes.
// content_lane=NULL rows (legacy/pending) are never included here; use
// getPendingCreatorMemory() explicitly for that separate, deliberately-
// named case.
// ============================================================

export interface CreatorMemoryLaneRow {
  id: string
  user_id: string
  topic: string
  state: string
  content_lane: ContentLane
  video_idea_id: string | null
  updated_at: string
  [key: string]: unknown
}

export async function getCreatorMemoryForLane(
  admin: SupabaseClient,
  input: { userId: string; contentLane: ContentLane; limit?: number }
): Promise<CreatorMemoryLaneRow[]> {
  const { data, error } = await admin
    .from('creator_memory')
    .select('*')
    .eq('user_id', input.userId)
    .eq('content_lane', input.contentLane)
    .order('updated_at', { ascending: false })
    .limit(Math.min(Math.max(input.limit || 200, 1), 500))
  if (error) throw new Error(`creator_memory_lane_read_failed:${error.message}`)
  return (data as CreatorMemoryLaneRow[] | null) || []
}

export async function getPendingCreatorMemory(
  admin: SupabaseClient,
  input: { userId: string; limit?: number }
): Promise<CreatorMemoryLaneRow[]> {
  const { data, error } = await admin
    .from('creator_memory')
    .select('*')
    .eq('user_id', input.userId)
    .is('content_lane', null)
    .order('updated_at', { ascending: false })
    .limit(Math.min(Math.max(input.limit || 200, 1), 500))
  if (error) throw new Error(`creator_memory_pending_read_failed:${error.message}`)
  return (data as CreatorMemoryLaneRow[] | null) || []
}

// Runtime lane-filter validation shared by every strict read below.
// `undefined`/`null` both mean "legacy/pending" (content_lane IS NULL) --
// there is no third value that means "all lanes". Anything else is
// rejected fail-closed (never silently coerced to a guessed lane).
export function assertValidLaneFilter(contentLane: unknown): ContentLane | null {
  if (contentLane === undefined || contentLane === null) return null
  if (contentLane === 'evidence_led' || contentLane === 'entertainment_led') return contentLane
  throw new Error('invalid_content_lane')
}

// Named, single-purpose business rule for the Opportunity Engine's
// completed/rejected-topic exclusion set. `contentLane` is a REQUIRED,
// validated parameter -- omitted/null means "legacy/pending", matched with
// an EXACT `content_lane IS NULL` (never widened to also include
// evidence_led memory: a NULL row's lane is genuinely unknown and must not
// influence any single lane's decision logic). A specific lane is matched
// with an EXACT `content_lane = <lane>`, never merged with NULL or the
// other lane. The Opportunity route has no lane input in its request
// contract today (confirmed by reading app/api/opportunity/route.ts --
// no content_lane/contentLane field exists anywhere in its body), so its
// only currently-correct call is contentLane: null (legacy/pending),
// which exactly preserves today's real-world behavior (every existing row
// is still NULL-lane). A future lane-aware Opportunity flow would pass an
// explicit 'evidence_led'/'entertainment_led' once it has a real lane
// input to validate against -- fail-closed via assertValidLaneFilter if
// it ever passes anything else.
export async function getOpportunityExclusionMemory(
  admin: SupabaseClient,
  input: { userId: string; contentLane: ContentLane | null }
): Promise<{ topic: string; state: string }[]> {
  const lane = assertValidLaneFilter(input.contentLane)
  let query = admin.from('creator_memory').select('topic, state').eq('user_id', input.userId)
  query = lane === null ? query.is('content_lane', null) : query.eq('content_lane', lane)
  const { data, error } = await query
  if (error) throw new Error(`creator_memory_opportunity_exclusion_read_failed:${error.message}`)
  return (data as { topic: string; state: string }[] | null) || []
}

// Strict, single-lane-or-legacy read for passive display surfaces (the
// user's own Memory list, dashboard stat tiles). There is NO "all lanes"
// mode in this foundation layer -- lane isolation is a product/display
// requirement here, not just a scoring concern. `contentLane` omitted/null
// means legacy/pending ONLY (content_lane IS NULL, exact), matching what
// every current caller actually needs (no UI sends a lane yet, and every
// existing row is still NULL-lane, so this is byte-for-byte the same
// result set today as before this function existed). A validated
// 'evidence_led'/'entertainment_led' returns ONLY that lane's rows. Any
// other value throws 'invalid_content_lane' (callers must translate this
// to HTTP 400). A future "show me everything across all lanes, grouped
// and labeled" view needs its own, separately-designed, explicitly-named
// function and UI contract -- not a default mode of this one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- caller
// supplies an arbitrary select() string, so the row shape isn't staticaly
// knowable here any more than it would be for a raw dynamic-select
// PostgREST call; downstream callers narrow/cast as needed.
export async function getCreatorMemoryByLaneFilter(
  admin: SupabaseClient,
  input: { userId: string; contentLane?: ContentLane | null; state?: string; limit?: number; select?: string }
): Promise<any[]> {
  const lane = assertValidLaneFilter(input.contentLane)
  let query = admin
    .from('creator_memory')
    .select(input.select || '*')
    .eq('user_id', input.userId)
    .order('updated_at', { ascending: false })
  query = lane === null ? query.is('content_lane', null) : query.eq('content_lane', lane)
  if (input.state) query = query.eq('state', input.state)
  if (input.limit) query = query.limit(input.limit)
  const { data, error } = await query
  if (error) throw new Error(`creator_memory_display_read_failed:${error.message}`)
  return data || []
}
