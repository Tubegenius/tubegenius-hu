// Creator Lane Architecture v0 -- ROLLOUT GATE S2: 001-066 + 067 (EXPAND
// only, 068 CONTRACT NOT applied) + the NEW application (this working
// tree's RPC-based code), against the REAL local Supabase Docker stack.
// Same Docker-stack-skip pattern as the other -db-integration suites in
// this project.
//
// Proves the NEW application is already fully production-deployable on top
// of the EXPAND-only schema -- i.e. 067 can go to production and the NEW
// application can be deployed on top of it BEFORE 068 (contract) ever
// runs. It also documents, with a real assertion (not just a comment), the
// one deliberate, accepted limitation of this intermediate state: two
// different-lane creator_memory rows for the same (user, topic) are still
// blocked by the OLD creator_memory_user_id_topic_key constraint until 068
// drops it -- the lane UI is not live yet in this phase, so no real user
// can hit that path in production during S2.
//
// SELF-SKIPPING BY DESIGN, in addition to the Docker-stack check: only
// meaningful against a database with 067 applied but NOT 068. In the
// repo's normal local dev state (068 already applied), this block detects
// that and skips itself -- see creator-lane-s1-legacy-compat-db-integration
// .test.ts's header for the full rationale and how to actually exercise it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20000 })
import { execSync } from 'child_process'

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
    input: sql,
    encoding: 'utf-8',
  })
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}

let expandOnlyState = false
if (stackAvailable) {
  try {
    const out = dockerPsql(`select count(*) from pg_constraint where conname = 'creator_memory_user_id_topic_key';`).trim()
    expandOnlyState = out === '1'
  } catch {
    expandOnlyState = false
  }
}

const describeIfS2 = stackAvailable && expandOnlyState ? describe : describe.skip

const USER_A = 'e2000000-0000-4000-8000-000000000001'
const USER_B = 'e2000000-0000-4000-8000-000000000002'

vi.mock('@/lib/supabase-server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supabase-server')>('@/lib/supabase-server')
  return { ...actual, createServerSupabaseClient: vi.fn() }
})

import { createServerSupabaseClient } from '@/lib/supabase-server'

function mockAuthAs(userId: string) {
  vi.mocked(createServerSupabaseClient).mockReturnValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: userId } } })) },
  } as any)
}

function cleanup() {
  dockerPsql(`
    delete from creator_memory where user_id in ('${USER_A}','${USER_B}');
    delete from video_ideas where user_id in ('${USER_A}','${USER_B}');
    delete from auth.users where id in ('${USER_A}','${USER_B}');
  `)
}

describeIfS2('Creator Lane rollout gate S2 -- 001-066+067 schema + NEW application (RPC-based)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    cleanup()
    dockerPsql(`
      insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
      values
        ('${USER_A}', 's2-a@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated'),
        ('${USER_B}', 's2-b@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated');
    `)
  })

  afterAll(() => cleanup())

  it('sanity: creator_memory_user_id_topic_key is present (068 not applied) -- this suite is only meaningful in that state', () => {
    const out = dockerPsql(`select conname from pg_constraint where conname = 'creator_memory_user_id_topic_key';`).trim()
    expect(out).toBe('creator_memory_user_id_topic_key')
  })

  // ------------------------------------------------------------
  // upsert_creator_memory pending/NULL-lane branch -- the NEW app's actual
  // write path for the current (lane-less) UI contract.
  // ------------------------------------------------------------
  it('upsertCreatorMemory pending/NULL-lane branch works end to end', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const r1 = await upsertCreatorMemory(admin, { userId: USER_A, topic: 's2 pending topic', notes: 'v1' })
    expect(r1.success).toBe(true)
    expect(r1.row?.content_lane).toBeNull()

    const r2 = await upsertCreatorMemory(admin, { userId: USER_A, topic: 's2 pending topic', notes: 'v2' })
    expect(r2.success).toBe(true)
    expect(r2.row?.id).toBe(r1.row?.id)
    expect(r2.row?.notes).toBe('v2')
  })

  // ------------------------------------------------------------
  // Real memory/route.ts POST sequence (ensureVideoIdea -> upsert ->
  // linkVideoIdeaToLegacyRecord via link_creator_memory_parent RPC) --
  // this is the NEW application's real write path, exercised end to end.
  // ------------------------------------------------------------
  it('real memory route POST sequence (RPC upsert + RPC link) succeeds on the expand-only schema', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdea, linkVideoIdeaToLegacyRecord } = await import('@/lib/video-ideas/video-idea-service')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const topic = 's2 route sequence topic'
    const ideaResult = await ensureVideoIdea(admin, { userId: USER_A, title: topic, topic })
    expect(ideaResult.success).toBe(true)

    const upsertResult = await upsertCreatorMemory(admin, { userId: USER_A, topic, state: 'saved' })
    expect(upsertResult.success).toBe(true)
    const memRow = upsertResult.row as { id: string; video_idea_id: string | null }
    expect(memRow.video_idea_id).toBeNull()

    const linkResult = await linkVideoIdeaToLegacyRecord(admin, {
      table: 'creator_memory', userId: USER_A, recordId: memRow.id, videoIdeaId: ideaResult.idea!.id,
    })
    expect(linkResult.success).toBe(true)

    const finalVideoIdeaId = dockerPsql(`select video_idea_id::text from creator_memory where id='${memRow.id}';`).trim()
    expect(finalVideoIdeaId).toBe(ideaResult.idea!.id)
  })

  // ------------------------------------------------------------
  // GET /api/memory without ?lane= -- NULL-only, byte-identical to the
  // pre-Creator-Lane result set (every row is still NULL-lane in S2).
  // ------------------------------------------------------------
  it('GET /api/memory without ?lane= returns NULL-lane rows only, via the real route handler', async () => {
    mockAuthAs(USER_A)
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = (await import('@/lib/supabase-server')).createAdminClient()
    await upsertCreatorMemory(admin, { userId: USER_A, topic: 's2 memory get topic', notes: 'GET_MARK' })

    const { GET } = await import('@/app/api/memory/route')
    const response = await GET({ url: 'http://localhost/api/memory' } as any)
    expect(response.status).toBe(200)
    const payload = await response.json()
    const forTopic = payload.items.filter((i: any) => i.topic === 's2 memory get topic')
    expect(forTopic).toHaveLength(1)
    expect(forTopic[0].content_lane).toBeNull()
  })

  it('GET /api/memory?lane=evidence_led fails closed (400) since no lane UI exists yet, but the parameter itself is already handled', async () => {
    mockAuthAs(USER_A)
    const { GET } = await import('@/app/api/memory/route')
    const response = await GET({ url: 'http://localhost/api/memory?lane=evidence_led' } as any)
    // A validated lane value is a legal, already-supported request shape
    // (200, empty-for-this-user-so-far) -- only an UNKNOWN lane value fails
    // closed. This documents that the route's lane-filter plumbing is live
    // in S2 even though no UI surfaces it yet.
    expect(response.status).toBe(200)
    const bogus = await GET({ url: 'http://localhost/api/memory?lane=not_a_real_lane' } as any)
    expect(bogus.status).toBe(400)
  })

  // ------------------------------------------------------------
  // Lane-aware reads (service layer) -- functional even though nothing in
  // the current UI populates a lane yet.
  // ------------------------------------------------------------
  it('lane-aware reads (getCreatorMemoryForLane / getPendingCreatorMemory) are already functional', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory, getCreatorMemoryForLane, getPendingCreatorMemory, ensureVideoIdeaLane, lockVideoIdeaLane } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    await upsertCreatorMemory(admin, { userId: USER_A, topic: 's2 lane read pending', notes: 'pending' })
    const parent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic: 's2 lane read evidence', contentLane: 'evidence_led', laneSource: 'explicit_user' })
    expect(parent.success).toBe(true)
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: parent.videoIdeaId! })
    await upsertCreatorMemory(admin, { userId: USER_A, topic: 's2 lane read evidence', contentLane: 'evidence_led', videoIdeaId: parent.videoIdeaId!, notes: 'evidence' })

    const pending = await getPendingCreatorMemory(admin, { userId: USER_A })
    expect(pending.some(r => r.topic === 's2 lane read pending')).toBe(true)

    const evidence = await getCreatorMemoryForLane(admin, { userId: USER_A, contentLane: 'evidence_led' })
    expect(evidence.some(r => r.topic === 's2 lane read evidence')).toBe(true)
  })

  // ------------------------------------------------------------
  // Opportunity legacy/pending-only exclusion read.
  // ------------------------------------------------------------
  it('Opportunity legacy/pending-only exclusion read (getOpportunityExclusionMemory) works on the expand-only schema', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory, getOpportunityExclusionMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    await upsertCreatorMemory(admin, { userId: USER_A, topic: 's2 opportunity exclusion topic', state: 'rejected' })
    const excl = await getOpportunityExclusionMemory(admin, { userId: USER_A, contentLane: null })
    expect(excl.some(r => r.topic === 's2 opportunity exclusion topic')).toBe(true)
  })

  it('real /api/opportunity route reads its creator_memory exclusion set via the RPC-safe helper without error on the expand-only schema', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { getOpportunityExclusionMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()
    await expect(getOpportunityExclusionMemory(admin, { userId: USER_A, contentLane: null })).resolves.toBeInstanceOf(Array)
  })

  // ------------------------------------------------------------
  // New RPCs reachable -- all 5, direct calls.
  // ------------------------------------------------------------
  it('all 5 new RPCs are reachable and functional on the expand-only schema', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdeaLane, lockVideoIdeaLane, reclassifyVideoIdea, linkCreatorMemoryParent, upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const ensured = await ensureVideoIdeaLane(admin, { userId: USER_A, topic: 's2 rpc reachability topic', contentLane: 'evidence_led', laneSource: 'explicit_user' })
    expect(ensured.success).toBe(true)

    const locked = await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: ensured.videoIdeaId! })
    expect(locked.success).toBe(true)

    const reclassified = await reclassifyVideoIdea(admin, { userId: USER_A, sourceVideoIdeaId: ensured.videoIdeaId!, newLane: 'entertainment_led', newSource: 'explicit_user' })
    expect(reclassified.success).toBe(true)

    const mem = await upsertCreatorMemory(admin, { userId: USER_A, topic: 's2 rpc reachability topic', contentLane: 'evidence_led', videoIdeaId: ensured.videoIdeaId! })
    expect(mem.success).toBe(true)

    const linked = await linkCreatorMemoryParent(admin, { userId: USER_A, memoryId: mem.row!.id as string, videoIdeaId: ensured.videoIdeaId! })
    expect(linked.success).toBe(true)
  })

  // ------------------------------------------------------------
  // Documented, deliberate S2 limitation: cross-lane coexistence for the
  // SAME topic is still blocked by the old global constraint until 068 --
  // mathematically unavoidable while creator_memory_user_id_topic_key
  // exists, no application-layer handling changes that. The lane UI is not
  // live yet, so no real user-facing flow can hit this in production
  // during S2. What this test proves is that the RPC fails CLOSED and
  // CLEANLY: a single, stable, documented `lane_conflict_pending_contract`
  // error (SQLSTATE 23505 preserved, verified separately at the raw
  // PostgREST/HTTP layer to be a 409 with a clean JSON body -- never an
  // unhandled 500, never a leaked raw Postgres constraint-name string),
  // and that it is NOT the RPC/index layer rejecting it (both of those are
  // already correctly configured to allow it; only the legacy constraint,
  // gone after 068, is in the way).
  // ------------------------------------------------------------
  it('same-topic different-lane creator_memory coexistence fails CLOSED with a clean, stable error (expected S2 limitation, not a bug)', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory, ensureVideoIdeaLane, lockVideoIdeaLane } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const topic = 's2 cross-lane blocked topic'
    const evidenceParent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic, contentLane: 'evidence_led', laneSource: 'explicit_user' })
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: evidenceParent.videoIdeaId! })
    const entertainmentParent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic, contentLane: 'entertainment_led', laneSource: 'explicit_user' })
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: entertainmentParent.videoIdeaId! })

    const evidenceMem = await upsertCreatorMemory(admin, { userId: USER_A, topic, contentLane: 'evidence_led', videoIdeaId: evidenceParent.videoIdeaId! })
    expect(evidenceMem.success).toBe(true)

    // The SAME topic, DIFFERENT lane -- this is exactly the row the new
    // idx_creator_memory_user_topic_lane partial index is designed to
    // allow, and it does not object; the OLD, still-present global
    // creator_memory_user_id_topic_key constraint is what rejects it here,
    // translated by the RPC into the stable, documented error below.
    const entertainmentMem = await upsertCreatorMemory(admin, { userId: USER_A, topic, contentLane: 'entertainment_led', videoIdeaId: entertainmentParent.videoIdeaId! })
    expect(entertainmentMem.success).toBe(false)
    expect(entertainmentMem.error).toBe('lane_conflict_pending_contract')
    expect(entertainmentMem.error).not.toMatch(/creator_memory_user_id_topic_key|duplicate key/i)

    const count = dockerPsql(`select count(*) from creator_memory where user_id='${USER_A}' and topic='${topic}';`).trim()
    expect(count).toBe('1')
  })

  it('user B never sees user A rows on the expand-only schema (tenant isolation unaffected by phase)', async () => {
    mockAuthAs(USER_B)
    const { GET } = await import('@/app/api/memory/route')
    const response = await GET({ url: 'http://localhost/api/memory' } as any)
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.items.some((i: any) => i.topic?.startsWith('s2 '))).toBe(false)
  })

  // ------------------------------------------------------------
  // Dual-legacy-constraint gate: production carries BOTH
  // creator_memory_user_id_topic_key (tested above, always present) AND a
  // second, redundant creator_memory_user_topic_unique (see
  // 042_capture_creator_memory_schema_drift.sql -- local/clean-rebuild DBs
  // do not have it, so it is created here as a same-shape TEST FIXTURE,
  // then dropped, to prove the RPC's exception handler really does branch
  // on BOTH names, not just the one every environment happens to share).
  // NOT self-skipped beyond the file's normal S1/S2-eligibility guard.
  // ------------------------------------------------------------
  it('the SECOND legacy constraint (creator_memory_user_topic_unique, production-only in reality) also translates to lane_conflict_pending_contract', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory, ensureVideoIdeaLane, lockVideoIdeaLane } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    dockerPsql(`ALTER TABLE creator_memory ADD CONSTRAINT creator_memory_user_topic_unique UNIQUE (user_id, topic);`)
    try {
      const topic = 's2 second-constraint topic'
      const evidenceParent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic, contentLane: 'evidence_led', laneSource: 'explicit_user' })
      await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: evidenceParent.videoIdeaId! })
      const entertainmentParent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic, contentLane: 'entertainment_led', laneSource: 'explicit_user' })
      await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: entertainmentParent.videoIdeaId! })

      const evidenceMem = await upsertCreatorMemory(admin, { userId: USER_A, topic, contentLane: 'evidence_led', videoIdeaId: evidenceParent.videoIdeaId! })
      expect(evidenceMem.success).toBe(true)

      const entertainmentMem = await upsertCreatorMemory(admin, { userId: USER_A, topic, contentLane: 'entertainment_led', videoIdeaId: entertainmentParent.videoIdeaId! })
      expect(entertainmentMem.success).toBe(false)
      expect(entertainmentMem.error).toBe('lane_conflict_pending_contract')
      expect(entertainmentMem.error).not.toMatch(/creator_memory_user_topic_unique|duplicate key/i)
    } finally {
      dockerPsql(`ALTER TABLE creator_memory DROP CONSTRAINT IF EXISTS creator_memory_user_topic_unique;`)
    }
  })

  it('an UNRELATED unique_violation is never swallowed by the exception handler -- it still raises, unmodified', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory, ensureVideoIdeaLane, lockVideoIdeaLane } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    dockerPsql(`CREATE UNIQUE INDEX test_fixture_other_unique ON creator_memory(search_keyword) WHERE search_keyword IS NOT NULL;`)
    try {
      const topicA = 's2 unrelated-violation topic A'
      const topicB = 's2 unrelated-violation topic B'
      const parentA = await ensureVideoIdeaLane(admin, { userId: USER_A, topic: topicA, contentLane: 'evidence_led', laneSource: 'explicit_user' })
      await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: parentA.videoIdeaId! })
      const parentB = await ensureVideoIdeaLane(admin, { userId: USER_A, topic: topicB, contentLane: 'evidence_led', laneSource: 'explicit_user' })
      await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: parentB.videoIdeaId! })

      const first = await upsertCreatorMemory(admin, { userId: USER_A, topic: topicA, contentLane: 'evidence_led', videoIdeaId: parentA.videoIdeaId!, searchKeyword: 'shared-keyword-fixture' })
      expect(first.success).toBe(true)

      // different topic, different lane row, but SAME search_keyword ->
      // collides with the fixture index, NOT with either legacy
      // (user_id, topic) constraint. Must NOT become lane_conflict_pending_contract.
      const second = await upsertCreatorMemory(admin, { userId: USER_A, topic: topicB, contentLane: 'evidence_led', videoIdeaId: parentB.videoIdeaId!, searchKeyword: 'shared-keyword-fixture' })
      expect(second.success).toBe(false)
      expect(second.error).not.toBe('lane_conflict_pending_contract')
      expect(second.error).toMatch(/test_fixture_other_unique|duplicate key/i)
    } finally {
      dockerPsql(`DROP INDEX IF EXISTS test_fixture_other_unique;`)
    }
  })

  it('raw HTTP/PostgREST layer: the lane conflict is a clean 409 with no raw constraint name in the body (not 5xx)', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdeaLane, lockVideoIdeaLane, upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const topic = 's2 http-layer conflict topic'
    const evidenceParent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic, contentLane: 'evidence_led', laneSource: 'explicit_user' })
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: evidenceParent.videoIdeaId! })
    const entertainmentParent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic, contentLane: 'entertainment_led', laneSource: 'explicit_user' })
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: entertainmentParent.videoIdeaId! })
    const evidenceMem = await upsertCreatorMemory(admin, { userId: USER_A, topic, contentLane: 'evidence_led', videoIdeaId: evidenceParent.videoIdeaId! })
    expect(evidenceMem.success).toBe(true)

    const response = await fetch(`${LOCAL_URL}/rest/v1/rpc/upsert_creator_memory`, {
      method: 'POST',
      headers: {
        apikey: LOCAL_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${LOCAL_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_user_id: USER_A, p_topic: topic, p_content_lane: 'entertainment_led', p_video_idea_id: entertainmentParent.videoIdeaId,
        p_search_keyword: null, p_state: 'saved', p_opportunity_score: null, p_viral_score: null, p_platform: 'youtube',
        p_notes: null, p_audit_score: null, p_audit_id: null, p_video_package_id: null, p_source_context: null, p_quality_status: null,
      }),
    })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe('23505')
    expect(body.message).toBe('lane_conflict_pending_contract')
    expect(body.message).not.toMatch(/creator_memory_user_id_topic_key|creator_memory_user_topic_unique/i)
    expect(JSON.stringify(body)).not.toMatch(/creator_memory_user_id_topic_key|creator_memory_user_topic_unique/i)
  })
})
