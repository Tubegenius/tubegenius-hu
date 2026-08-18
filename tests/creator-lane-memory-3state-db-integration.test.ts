// Creator Lane Architecture v0 — creator_memory 3-state uniqueness model
// (legacy/pending + evidence_led + entertainment_led), REAL local DB
// integration tests. Same Docker-stack-skip pattern as the other
// -db-integration suites in this project.
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

// This suite proves the 3-state creator_memory model (NULL/pending +
// evidence_led + entertainment_led coexisting for the same user_id+topic),
// which is only true once 068 (contract) has dropped the old global
// creator_memory_user_id_topic_key constraint on top of 067 (expand). If
// only 067 is applied, that constraint still blocks the second-lane row by
// design (see 067's header) and this suite would hard-fail rather than
// skip. Self-skip in that case -- fixture-availability skip, not an
// avoided hard case, same pattern as the stackAvailable check above.
let contractApplied = false
if (stackAvailable) {
  try {
    const out = dockerPsql(`select count(*) from pg_constraint where conname = 'creator_memory_user_id_topic_key';`).trim()
    contractApplied = out === '0'
  } catch {
    contractApplied = false
  }
}

const describeIfLocalDb = stackAvailable && contractApplied ? describe : describe.skip
if (stackAvailable && !contractApplied) {
  // eslint-disable-next-line no-console
  console.warn('Creator Lane 3-state suite skipped: local DB only has 067 (expand) applied, not 068 (contract).')
}

const USER_A = 'c1000000-0000-4000-8000-000000000001'
const USER_B = 'c1000000-0000-4000-8000-000000000002'

function seedUsers() {
  dockerPsql(`
    delete from creator_memory where user_id in ('${USER_A}','${USER_B}');
    delete from video_ideas where user_id in ('${USER_A}','${USER_B}');
    delete from auth.users where id in ('${USER_A}','${USER_B}');
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
    values
      ('${USER_A}', 'lane3-a@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated'),
      ('${USER_B}', 'lane3-b@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated');
  `)
}

function cleanup() {
  dockerPsql(`
    delete from creator_memory where user_id in ('${USER_A}','${USER_B}');
    delete from video_ideas where user_id in ('${USER_A}','${USER_B}');
    delete from auth.users where id in ('${USER_A}','${USER_B}');
  `)
}

// Helper: creates a LOCKED video_idea in the given lane for a user, via the
// real RPCs, so creator_memory rows can be legitimately lane-tagged.
async function lockedParent(admin: any, userId: string, topic: string, lane: 'evidence_led' | 'entertainment_led') {
  const { ensureVideoIdeaLane, lockVideoIdeaLane } = await import('@/lib/creator-lane/lane-service')
  const idea = await ensureVideoIdeaLane(admin, { userId, topic, contentLane: lane, laneSource: 'explicit_user' })
  if (!idea.success) throw new Error(`lockedParent ensure failed: ${idea.error}`)
  const locked = await lockVideoIdeaLane(admin, { userId, videoIdeaId: idea.videoIdeaId! })
  if (!locked.success) throw new Error(`lockedParent lock failed: ${locked.error}`)
  return idea.videoIdeaId!
}

describeIfLocalDb('Creator Lane — creator_memory 3-state uniqueness (real local DB)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    seedUsers()
  })
  afterAll(() => cleanup())

  it('legacy NULL-lane memory insert then update via upsert_creator_memory', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const r1 = await upsertCreatorMemory(admin, { userId: USER_A, topic: '3state topic', notes: 'v1' })
    expect(r1.success).toBe(true)
    expect(r1.row?.content_lane).toBeNull()

    const r2 = await upsertCreatorMemory(admin, { userId: USER_A, topic: '3state topic', notes: 'v2' })
    expect(r2.success).toBe(true)
    expect(r2.row?.id).toBe(r1.row?.id)
    expect(r2.row?.notes).toBe('v2')

    const count = dockerPsql(`select count(*) from creator_memory where user_id='${USER_A}' and topic='3state topic';`).trim()
    expect(count).toBe('1')
  })

  it('same topic can have separate evidence_led and entertainment_led memory rows, both coexisting with the pending row', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const evidenceParent = await lockedParent(admin, USER_A, 'tri-state topic', 'evidence_led')
    const entertainmentParent = await lockedParent(admin, USER_A, 'tri-state topic', 'entertainment_led')

    const pending = await upsertCreatorMemory(admin, { userId: USER_A, topic: 'tri-state topic', notes: 'pending' })
    expect(pending.success).toBe(true)
    expect(pending.row?.content_lane).toBeNull()

    const evidence = await upsertCreatorMemory(admin, {
      userId: USER_A, topic: 'tri-state topic', contentLane: 'evidence_led', videoIdeaId: evidenceParent, notes: 'evidence',
    })
    expect(evidence.success).toBe(true)
    expect(evidence.row?.content_lane).toBe('evidence_led')
    expect(evidence.row?.id).not.toBe(pending.row?.id)

    const entertainment = await upsertCreatorMemory(admin, {
      userId: USER_A, topic: 'tri-state topic', contentLane: 'entertainment_led', videoIdeaId: entertainmentParent, notes: 'entertainment',
    })
    expect(entertainment.success).toBe(true)
    expect(entertainment.row?.content_lane).toBe('entertainment_led')
    expect(entertainment.row?.id).not.toBe(pending.row?.id)
    expect(entertainment.row?.id).not.toBe(evidence.row?.id)

    // all three coexist simultaneously
    const rows = dockerPsql(`select coalesce(content_lane,'NULL') from creator_memory where user_id='${USER_A}' and topic='tri-state topic' order by 1;`).trim().split('\n')
    expect(rows.sort()).toEqual(['NULL', 'entertainment_led', 'evidence_led'])
  })

  it('same topic+lane duplicate is rejected (idempotent update, not a second row); different user with same topic+lane is allowed', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const parentA = await lockedParent(admin, USER_A, 'dup topic', 'evidence_led')
    const r1 = await upsertCreatorMemory(admin, { userId: USER_A, topic: 'dup topic', contentLane: 'evidence_led', videoIdeaId: parentA, notes: 'first' })
    const r2 = await upsertCreatorMemory(admin, { userId: USER_A, topic: 'dup topic', contentLane: 'evidence_led', videoIdeaId: parentA, notes: 'second' })
    expect(r1.success && r2.success).toBe(true)
    expect(r2.row?.id).toBe(r1.row?.id)
    expect(r2.row?.notes).toBe('second')
    const countA = dockerPsql(`select count(*) from creator_memory where user_id='${USER_A}' and topic='dup topic';`).trim()
    expect(countA).toBe('1')

    // different user, same topic+lane -> independent row, fully allowed
    const parentB = await lockedParent(admin, USER_B, 'dup topic', 'evidence_led')
    const rB = await upsertCreatorMemory(admin, { userId: USER_B, topic: 'dup topic', contentLane: 'evidence_led', videoIdeaId: parentB, notes: 'other user' })
    expect(rB.success).toBe(true)
    expect(rB.row?.id).not.toBe(r1.row?.id)
  })

  it('concurrent upserts to the SAME lane never create a duplicate row', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()
    const parent = await lockedParent(admin, USER_A, 'concurrent same-lane topic', 'evidence_led')

    const [a, b] = await Promise.all([
      upsertCreatorMemory(admin, { userId: USER_A, topic: 'concurrent same-lane topic', contentLane: 'evidence_led', videoIdeaId: parent, notes: 'race-a' }),
      upsertCreatorMemory(admin, { userId: USER_A, topic: 'concurrent same-lane topic', contentLane: 'evidence_led', videoIdeaId: parent, notes: 'race-b' }),
    ])
    expect(a.success && b.success).toBe(true)
    expect(a.row?.id).toBe(b.row?.id)
    const count = dockerPsql(`select count(*) from creator_memory where user_id='${USER_A}' and topic='concurrent same-lane topic';`).trim()
    expect(count).toBe('1')
  })

  it('concurrent upserts to DIFFERENT lanes both succeed as two distinct rows', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()
    const evidenceParent = await lockedParent(admin, USER_A, 'concurrent diff-lane topic', 'evidence_led')
    const entertainmentParent = await lockedParent(admin, USER_A, 'concurrent diff-lane topic', 'entertainment_led')

    const [a, b] = await Promise.all([
      upsertCreatorMemory(admin, { userId: USER_A, topic: 'concurrent diff-lane topic', contentLane: 'evidence_led', videoIdeaId: evidenceParent }),
      upsertCreatorMemory(admin, { userId: USER_A, topic: 'concurrent diff-lane topic', contentLane: 'entertainment_led', videoIdeaId: entertainmentParent }),
    ])
    expect(a.success && b.success).toBe(true)
    expect(a.row?.id).not.toBe(b.row?.id)
    const count = dockerPsql(`select count(*) from creator_memory where user_id='${USER_A}' and topic='concurrent diff-lane topic';`).trim()
    expect(count).toBe('2')
  })

  it('lane-isolated reads: pending/evidence/entertainment queries never see each other', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory, getCreatorMemoryForLane, getPendingCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const evidenceParent = await lockedParent(admin, USER_A, 'isolation read topic', 'evidence_led')
    const entertainmentParent = await lockedParent(admin, USER_A, 'isolation read topic', 'entertainment_led')
    await upsertCreatorMemory(admin, { userId: USER_A, topic: 'isolation read topic', notes: 'pending' })
    await upsertCreatorMemory(admin, { userId: USER_A, topic: 'isolation read topic', contentLane: 'evidence_led', videoIdeaId: evidenceParent })
    await upsertCreatorMemory(admin, { userId: USER_A, topic: 'isolation read topic', contentLane: 'entertainment_led', videoIdeaId: entertainmentParent })

    const pendingRows = await getPendingCreatorMemory(admin, { userId: USER_A })
    const pendingForTopic = pendingRows.filter(r => r.topic === 'isolation read topic')
    expect(pendingForTopic.length).toBe(1)
    expect(pendingForTopic.every(r => r.content_lane === null)).toBe(true)

    const evidenceRows = await getCreatorMemoryForLane(admin, { userId: USER_A, contentLane: 'evidence_led' })
    const evidenceForTopic = evidenceRows.filter(r => r.topic === 'isolation read topic')
    expect(evidenceForTopic.length).toBe(1)
    expect(evidenceForTopic.every(r => r.content_lane === 'evidence_led')).toBe(true)

    const entertainmentRows = await getCreatorMemoryForLane(admin, { userId: USER_A, contentLane: 'entertainment_led' })
    const entertainmentForTopic = entertainmentRows.filter(r => r.topic === 'isolation read topic')
    expect(entertainmentForTopic.length).toBe(1)
    expect(entertainmentForTopic.every(r => r.content_lane === 'entertainment_led')).toBe(true)
  })

  it('Opportunity exclusion memory: includes pending + evidence_led, never entertainment_led', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory, getOpportunityExclusionMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const evidenceParent = await lockedParent(admin, USER_A, 'opp exclusion topic evidence', 'evidence_led')
    const entertainmentParent = await lockedParent(admin, USER_A, 'opp exclusion topic entertainment', 'entertainment_led')
    await upsertCreatorMemory(admin, { userId: USER_A, topic: 'opp exclusion topic pending', state: 'rejected' })
    await upsertCreatorMemory(admin, { userId: USER_A, topic: 'opp exclusion topic evidence', contentLane: 'evidence_led', videoIdeaId: evidenceParent, state: 'rejected' })
    await upsertCreatorMemory(admin, { userId: USER_A, topic: 'opp exclusion topic entertainment', contentLane: 'entertainment_led', videoIdeaId: entertainmentParent, state: 'rejected' })

    // legacy/pending caller (contentLane: null) -> EXACT match, sees ONLY
    // the pending row, never evidence_led or entertainment_led
    const pendingExcl = await getOpportunityExclusionMemory(admin, { userId: USER_A, contentLane: null })
    const pendingTopics = pendingExcl.map(r => r.topic)
    expect(pendingTopics).toContain('opp exclusion topic pending')
    expect(pendingTopics).not.toContain('opp exclusion topic evidence')
    expect(pendingTopics).not.toContain('opp exclusion topic entertainment')

    // evidence_led caller -> EXACT match, sees ONLY the evidence_led row
    const evidenceExcl = await getOpportunityExclusionMemory(admin, { userId: USER_A, contentLane: 'evidence_led' })
    const evidenceTopics = evidenceExcl.map(r => r.topic)
    expect(evidenceTopics).toContain('opp exclusion topic evidence')
    expect(evidenceTopics).not.toContain('opp exclusion topic pending')
    expect(evidenceTopics).not.toContain('opp exclusion topic entertainment')

    // entertainment_led caller -> EXACT match, sees ONLY the entertainment_led row
    const entertainmentExcl = await getOpportunityExclusionMemory(admin, { userId: USER_A, contentLane: 'entertainment_led' })
    const entertainmentTopics = entertainmentExcl.map(r => r.topic)
    expect(entertainmentTopics).toContain('opp exclusion topic entertainment')
    expect(entertainmentTopics).not.toContain('opp exclusion topic pending')
    expect(entertainmentTopics).not.toContain('opp exclusion topic evidence')

    // invalid lane value -> fail-closed, never silently treated as "all lanes"
    await expect(getOpportunityExclusionMemory(admin, { userId: USER_A, contentLane: 'made_up_lane' as any })).rejects.toThrow('invalid_content_lane')
  })

  it('link_creator_memory_parent: same topic links to two independent parents, one per lane, without cross-contamination', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory, linkCreatorMemoryParent } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const evidenceParent = await lockedParent(admin, USER_A, 'dual parent link topic', 'evidence_led')
    const entertainmentParent = await lockedParent(admin, USER_A, 'dual parent link topic', 'entertainment_led')

    const evidenceMem = await upsertCreatorMemory(admin, { userId: USER_A, topic: 'dual parent link topic', contentLane: 'evidence_led', videoIdeaId: evidenceParent })
    const entertainmentMem = await upsertCreatorMemory(admin, { userId: USER_A, topic: 'dual parent link topic', contentLane: 'entertainment_led', videoIdeaId: entertainmentParent })

    const linkEvidence = await linkCreatorMemoryParent(admin, { userId: USER_A, memoryId: evidenceMem.row!.id as string, videoIdeaId: evidenceParent })
    const linkEntertainment = await linkCreatorMemoryParent(admin, { userId: USER_A, memoryId: entertainmentMem.row!.id as string, videoIdeaId: entertainmentParent })

    expect(linkEvidence.success && linkEntertainment.success).toBe(true)
    expect(linkEvidence.contentLane).toBe('evidence_led')
    expect(linkEntertainment.contentLane).toBe('entertainment_led')
    expect(linkEvidence.videoIdeaId).toBe(evidenceParent)
    expect(linkEntertainment.videoIdeaId).toBe(entertainmentParent)

    // cross-attempt: linking the evidence memory row to the entertainment parent must fail (reparent forbidden)
    const crossAttempt = await linkCreatorMemoryParent(admin, { userId: USER_A, memoryId: evidenceMem.row!.id as string, videoIdeaId: entertainmentParent })
    expect(crossAttempt.success).toBe(false)
    expect(crossAttempt.error).toContain('memory_reparent_forbidden')
  })

  it('content_lane cannot be changed directly by service_role even via the RPC-adjacent write path (defense in depth)', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()
    const parent = await lockedParent(admin, USER_A, 'direct lane change topic', 'evidence_led')
    const mem = await upsertCreatorMemory(admin, { userId: USER_A, topic: 'direct lane change topic', contentLane: 'evidence_led', videoIdeaId: parent })

    const { error } = await admin.from('creator_memory').update({ content_lane: 'entertainment_led' }).eq('id', mem.row!.id as string)
    expect(error).not.toBeNull()
  })
})
