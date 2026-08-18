// Creator Lane Architecture v0 -- ROLLOUT GATE S1: 001-066 + 067 (EXPAND
// only, 068 CONTRACT NOT applied) + the OLD, currently-deployed
// application's exact write contract, against the REAL local Supabase
// Docker stack. Same Docker-stack-skip pattern as the other
// -db-integration suites in this project.
//
// This file does NOT import app/api/memory/route.ts or
// app/api/video-audit/route.ts, because those files in the current working
// tree already contain the NEW application's code (RPC-based writes). To
// prove the OLD application (HEAD 48759f7, before this Creator Lane work)
// still works unmodified against the 067-only schema, this file
// reconstructs the OLD application's exact PostgREST call shapes verbatim,
// copied from `git show HEAD:app/api/memory/route.ts` and
// `git show HEAD:app/api/video-audit/route.ts` -- see the inline comments
// on each record literal for the exact source lines they mirror.
//
// video_ideas is the one exception: lib/video-ideas/video-idea-service.ts
// ensureVideoIdea() is BYTE-IDENTICAL between HEAD and the working tree
// (verified via `git diff HEAD -- lib/video-ideas/video-idea-service.ts` --
// this function is untouched by the Creator Lane diff), so importing it
// directly from the current working tree exercises exactly the same code
// the OLD application runs.
//
// SELF-SKIPPING BY DESIGN, in addition to the Docker-stack check: this
// suite is only meaningful against a database that has 067 applied but NOT
// 068 (the intermediate EXPAND-only state). In the repo's normal local dev
// state (a plain `supabase db reset`, which applies every migration file
// present, including 068), this describe block detects that 068 has
// already contracted the schema and skips itself with a clear reason --
// exactly the same "skip when the fixture this suite needs isn't present"
// pattern the existing describeIfLocalDb Docker check already uses, not an
// avoided hard case. To actually EXERCISE this suite, temporarily move
// 068_creator_lane_contract.sql out of supabase/migrations/, run
// `supabase db reset`, run this file, then restore 068 and reset again.
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

const describeIfS1 = stackAvailable && expandOnlyState ? describe : describe.skip
if (stackAvailable && !expandOnlyState) {
  // eslint-disable-next-line no-console
  console.warn(
    'S1 rollout-gate suite skipped: local DB already has 068 (contract) applied. ' +
    'To exercise S1, temporarily remove supabase/migrations/068_creator_lane_contract.sql, ' +
    'run `supabase db reset`, run this file, then restore 068 and reset again.'
  )
}

const TEST_USER = 'e1000000-0000-4000-8000-000000000001'

function cleanup() {
  dockerPsql(`
    delete from creator_memory where user_id='${TEST_USER}';
    delete from video_ideas where user_id='${TEST_USER}';
    delete from auth.users where id='${TEST_USER}';
  `)
}

describeIfS1('Creator Lane rollout gate S1 -- 001-066+067 schema + OLD application write contract', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    cleanup()
    dockerPsql(`
      insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
      values ('${TEST_USER}', 's1-legacy@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated');
    `)
  })

  afterAll(() => cleanup())

  it('sanity: creator_memory_user_id_topic_key is present (068 not applied) -- this suite is only meaningful in that state', () => {
    const out = dockerPsql(`select conname from pg_constraint where conname = 'creator_memory_user_id_topic_key';`).trim()
    expect(out).toBe('creator_memory_user_id_topic_key')
  })

  // ------------------------------------------------------------
  // OLD app/api/memory/route.ts POST -- exact record shape + exact
  // onConflict target, copied verbatim from git HEAD.
  // ------------------------------------------------------------
  it('OLD memory route POST upsert (onConflict=user_id,topic, includes video_idea_id) succeeds, no 42P10, no permission denied', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdea } = await import('@/lib/video-ideas/video-idea-service')
    const admin = createAdminClient()

    const topic = 's1 legacy memory topic'
    const ideaResult = await ensureVideoIdea(admin, {
      userId: TEST_USER,
      title: topic,
      topic,
      platform: 'youtube',
      opportunityScore: 55,
      viralScore: 60,
      workflowStatus: 'new_idea',
      metadata: { source_context: 'creator_memory', search_keyword: null, quality_status: null },
    })
    expect(ideaResult.success).toBe(true)
    expect(ideaResult.idea?.id).toBeTruthy()

    // Verbatim shape of the `record` object from git HEAD app/api/memory/route.ts POST.
    const record: Record<string, unknown> = {
      user_id: TEST_USER,
      topic,
      search_keyword: 'legacy keyword',
      state: 'saved',
      opportunity_score: 55,
      viral_score: 60,
      platform: 'youtube',
      notes: 'legacy note',
      updated_at: new Date().toISOString(),
      video_idea_id: ideaResult.idea!.id,
    }

    const { data, error } = await admin
      .from('creator_memory')
      .upsert(record, { onConflict: 'user_id,topic' })
      .select()
      .single()

    expect(error).toBeNull()
    expect(error && (error as { code?: string }).code).not.toBe('42P10')
    expect(data?.id).toBeTruthy()
    expect(data?.video_idea_id).toBe(ideaResult.idea!.id)
    expect(data?.content_lane).toBeNull()

    // Re-upsert (the real "second save" case) -- same row, updates in place,
    // not a duplicate, still no error.
    const { data: again, error: againError } = await admin
      .from('creator_memory')
      .upsert({ ...record, notes: 'legacy note v2', updated_at: new Date().toISOString() }, { onConflict: 'user_id,topic' })
      .select()
      .single()
    expect(againError).toBeNull()
    expect(again?.id).toBe(data?.id)
    expect(again?.notes).toBe('legacy note v2')

    const count = dockerPsql(`select count(*) from creator_memory where user_id='${TEST_USER}' and topic='${topic}';`).trim()
    expect(count).toBe('1')
  })

  // ------------------------------------------------------------
  // OLD app/api/video-audit/route.ts creator_memory auto-save -- exact
  // record shape + exact onConflict target, copied verbatim from git HEAD.
  // ------------------------------------------------------------
  it('OLD video-audit route creator_memory auto-save upsert (onConflict=user_id,topic) succeeds, no 42P10, no permission denied', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const admin = createAdminClient()

    const topic = 's1 legacy video-audit topic'
    const auditId = crypto.randomUUID()

    // Verbatim shape from git HEAD app/api/video-audit/route.ts.
    const { error } = await admin.from('creator_memory').upsert({
      user_id: TEST_USER,
      topic,
      search_keyword: topic,
      state: 'saved',
      platform: 'youtube',
      audit_score: 77,
      audit_id: auditId,
    }, { onConflict: 'user_id,topic' })

    expect(error).toBeNull()
    expect(error && (error as { code?: string }).code).not.toBe('42P10')

    const row = dockerPsql(`select audit_score, coalesce(content_lane,'NULL') from creator_memory where user_id='${TEST_USER}' and topic='${topic}';`).trim()
    expect(row).toBe('77|NULL')
  })

  // ------------------------------------------------------------
  // OLD video_ideas writer (ensureVideoIdea) -- byte-identical function
  // between HEAD and the working tree; validates the video_ideas grant
  // hardening applied in 067 doesn't touch anything the old app needs.
  // ------------------------------------------------------------
  it('OLD video_ideas writer (ensureVideoIdea select-then-insert-or-update) still works, no permission denied', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdea } = await import('@/lib/video-ideas/video-idea-service')
    const admin = createAdminClient()

    const topic = 's1 legacy video idea topic'
    const created = await ensureVideoIdea(admin, { userId: TEST_USER, title: topic, topic, platform: 'youtube' })
    expect(created.success).toBe(true)
    expect(created.idea?.id).toBeTruthy()
    const createdLane = dockerPsql(`select coalesce(content_lane,'NULL') from video_ideas where id='${created.idea!.id}';`).trim()
    expect(createdLane).toBe('NULL')

    // patch semantics: a second, partial call must not null out prior fields
    const patched = await ensureVideoIdea(admin, { userId: TEST_USER, topic, platform: 'youtube', viralScore: 42 })
    expect(patched.success).toBe(true)
    expect(patched.idea?.id).toBe(created.idea?.id)
    expect(patched.idea?.viral_score).toBe(42)

    const count = dockerPsql(`select count(*) from video_ideas where user_id='${TEST_USER}' and topic='${topic}';`).trim()
    expect(count).toBe('1')
  })

  // ------------------------------------------------------------
  // Full legacy writer matrix -- every OTHER byte-identical (HEAD ==
  // working tree) write path that touches video_ideas/creator_memory
  // columns, beyond the two POST/upsert flows above. This is what caught a
  // real gap during authoring: markVideoIdeaReadyToProduce() (called from
  // the unmodified POST /api/video-packages route) writes
  // video_ideas.video_package_id directly, but 067's original column-grant
  // allowlist omitted it (an earlier audit pass incorrectly classified it
  // as dead code) -- this would have broken video package creation the
  // moment 067 landed, for both the OLD and the NEW app equally, with no
  // Creator Lane feature even in play. Fixed in 067 section 11; this test
  // pins the fix so it can never silently regress.
  // ------------------------------------------------------------
  it('OLD/unchanged video_ideas writers: setVideoIdeaWorkflowStatus, markVideoIdeaReadyToProduce (video_package_id), PATCH-style field updates', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const {
      ensureVideoIdea,
      setVideoIdeaWorkflowStatus,
      markVideoIdeaReadyToProduce,
    } = await import('@/lib/video-ideas/video-idea-service')
    const admin = createAdminClient()

    const topic = 's1 legacy writer matrix topic'
    const created = await ensureVideoIdea(admin, { userId: TEST_USER, title: topic, topic, platform: 'youtube' })
    expect(created.success).toBe(true)
    const videoIdeaId = created.idea!.id

    // setVideoIdeaWorkflowStatus -- workflow_status + updated_at only
    const statusResult = await setVideoIdeaWorkflowStatus(admin, { userId: TEST_USER, videoIdeaId, workflowStatus: 'validating' })
    expect(statusResult.success).toBe(true)

    // markVideoIdeaReadyToProduce -- video_package_id + workflow_status + updated_at
    // (the exact path POST /api/video-packages calls; the regression this pins)
    const fakePackageId = crypto.randomUUID()
    const readyResult = await markVideoIdeaReadyToProduce(admin, { userId: TEST_USER, videoIdeaId, videoPackageId: fakePackageId })
    expect(readyResult.success).toBe(true)
    expect(readyResult.error).toBeUndefined()

    const row = dockerPsql(`select workflow_status || '|' || video_package_id::text from video_ideas where id='${videoIdeaId}';`).trim()
    expect(row).toBe(`ready_to_produce|${fakePackageId}`)

    // PATCH-style direct video_ideas field update (app/api/video-ideas/route.ts PATCH shape)
    const { error: patchErr } = await admin
      .from('video_ideas')
      .update({ calendar_status: 'scheduled', publish_status: 'draft', calendar_notes: 'legacy calendar note', updated_at: new Date().toISOString() })
      .eq('id', videoIdeaId)
      .eq('user_id', TEST_USER)
    expect(patchErr).toBeNull()

    // PATCH-style direct creator_memory field update (app/api/memory/route.ts PATCH shape)
    const { data: mem } = await admin.from('creator_memory').insert({ user_id: TEST_USER, topic: 's1 legacy memory patch topic', notes: 'v1', state: 'saved' }).select().single()
    const { error: memPatchErr } = await admin
      .from('creator_memory')
      .update({ state: 'in_progress', notes: 'patched note', updated_at: new Date().toISOString() })
      .eq('id', mem!.id)
      .eq('user_id', TEST_USER)
    expect(memPatchErr).toBeNull()

    // DELETE on creator_memory (app/api/memory/route.ts DELETE shape) -- table-level
    // privilege, untouched by either migration's column-grant hardening.
    const { error: memDeleteErr } = await admin.from('creator_memory').delete().eq('id', mem!.id).eq('user_id', TEST_USER)
    expect(memDeleteErr).toBeNull()
    const afterDelete = dockerPsql(`select count(*) from creator_memory where id='${mem!.id}';`).trim()
    expect(afterDelete).toBe('0')
  })

  // ------------------------------------------------------------
  // New lane columns stay NULL on every legacy write path -- no implicit
  // backfill, no accidental lane assignment from the old app.
  // ------------------------------------------------------------
  it('every row created by the OLD write paths has NULL lane columns', () => {
    const rows = dockerPsql(`
      select coalesce(content_lane,'NULL') || '|' || coalesce(lane_assignment_source,'NULL')
      from video_ideas where user_id='${TEST_USER}'
      union all
      select coalesce(content_lane,'NULL') || '|NA' from creator_memory where user_id='${TEST_USER}';
    `).trim().split('\n')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.startsWith('NULL|')).toBe(true)
    }
  })
})
