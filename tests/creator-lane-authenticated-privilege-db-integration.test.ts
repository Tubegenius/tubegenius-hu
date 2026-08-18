// Creator Lane Architecture v0 -- authenticated-role creator_memory
// privilege gate. Proves, via REAL SET ROLE authenticated grant-layer
// checks (not RLS-policy simulation -- Postgres checks table/column
// privileges BEFORE RLS policies ever evaluate, so this directly proves
// the grant hardening itself, independent of policy logic), that:
//   - authenticated can never write content_lane/video_idea_id, in either
//     the EXPAND (067-only) or CONTRACT (068) phase;
//   - every legacy write path the OLD/NEW application actually uses
//     (all via service_role) keeps working in both phases;
//   - anon/PUBLIC have no write access at any phase.
// Same Docker-stack-skip pattern as the other -db-integration suites.
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

// Some assertions here deliberately expect psql to FAIL (permission denied)
// -- this helper runs SQL that is expected to error and returns the error
// text instead of throwing, so the test can assert on it.
function dockerPsqlExpectError(sql: string): string {
  try {
    execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
      input: sql,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return '__NO_ERROR__'
  } catch (e: any) {
    return String(e.stderr || e.stdout || e.message || '')
  }
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}

let contractApplied = false
if (stackAvailable) {
  try {
    const out = dockerPsql(`select count(*) from pg_constraint where conname = 'creator_memory_user_id_topic_key';`).trim()
    contractApplied = out === '0'
  } catch {
    contractApplied = false
  }
}

const describeIfS1 = stackAvailable && !contractApplied ? describe : describe.skip
const describeIfS3 = stackAvailable && contractApplied ? describe : describe.skip

const USER_A = 'e5000000-0000-4000-8000-000000000001'
const USER_B = 'e5000000-0000-4000-8000-000000000002'

function seedUsers() {
  dockerPsql(`
    delete from creator_memory where user_id in ('${USER_A}','${USER_B}');
    delete from video_ideas where user_id in ('${USER_A}','${USER_B}');
    delete from auth.users where id in ('${USER_A}','${USER_B}');
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
    values
      ('${USER_A}', 'auth-priv-a@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated'),
      ('${USER_B}', 'auth-priv-b@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated');
  `)
}

function cleanup() {
  dockerPsql(`
    delete from creator_memory where user_id in ('${USER_A}','${USER_B}');
    delete from video_ideas where user_id in ('${USER_A}','${USER_B}');
    delete from auth.users where id in ('${USER_A}','${USER_B}');
  `)
}

// ============================================================
// S1 (067-only) -- self-skips once 068 is applied
// ============================================================
describeIfS1('Creator Lane -- authenticated privilege gate, S1 (067-only)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    seedUsers()
  })
  afterAll(() => cleanup())

  it('authenticated cannot set content_lane via direct SET ROLE INSERT', () => {
    const err = dockerPsqlExpectError(`
      SET ROLE authenticated;
      INSERT INTO creator_memory (user_id, topic, content_lane) VALUES ('${USER_A}', 'auth priv insert topic', 'evidence_led');
      RESET ROLE;
    `)
    expect(err).not.toBe('__NO_ERROR__')
    expect(err).toMatch(/permission denied/i)
  })

  it('authenticated cannot set content_lane via direct SET ROLE UPDATE', () => {
    dockerPsql(`INSERT INTO creator_memory (user_id, topic) VALUES ('${USER_A}', 'auth priv update topic');`)
    const err = dockerPsqlExpectError(`
      SET ROLE authenticated;
      UPDATE creator_memory SET content_lane = 'evidence_led' WHERE user_id = '${USER_A}' AND topic = 'auth priv update topic';
      RESET ROLE;
    `)
    expect(err).not.toBe('__NO_ERROR__')
    expect(err).toMatch(/permission denied/i)
  })

  it('authenticated cannot INSERT/UPDATE creator_memory at all (full table-level revoke, not just content_lane)', () => {
    const insertErr = dockerPsqlExpectError(`
      SET ROLE authenticated;
      INSERT INTO creator_memory (user_id, topic) VALUES ('${USER_A}', 'auth priv table-level topic');
      RESET ROLE;
    `)
    expect(insertErr).toMatch(/permission denied/i)

    dockerPsql(`INSERT INTO creator_memory (user_id, topic, notes) VALUES ('${USER_A}', 'auth priv table-level topic 2', 'v1');`)
    const updateErr = dockerPsqlExpectError(`
      SET ROLE authenticated;
      UPDATE creator_memory SET notes = 'v2' WHERE user_id = '${USER_A}' AND topic = 'auth priv table-level topic 2';
      RESET ROLE;
    `)
    expect(updateErr).toMatch(/permission denied/i)
  })

  it('authenticated retains SELECT (proven used by app/dashboard/page.tsx), sees only own rows via RLS', () => {
    dockerPsql(`INSERT INTO creator_memory (user_id, topic) VALUES ('${USER_A}', 'auth priv select topic');`)
    const out = dockerPsql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claims = '{"sub":"${USER_A}","role":"authenticated"}';
      SELECT count(*) FROM creator_memory WHERE topic = 'auth priv select topic';
      COMMIT;
    `).trim()
    expect(out).toBe('1')

    const otherUserSees = dockerPsql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claims = '{"sub":"${USER_B}","role":"authenticated"}';
      SELECT count(*) FROM creator_memory WHERE topic = 'auth priv select topic';
      COMMIT;
    `).trim()
    expect(otherUserSees).toBe('0')
  })

  it('legacy service_role writer (real onConflict upsert) still works unaffected by the authenticated revoke', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const admin = createAdminClient()
    const { error } = await admin
      .from('creator_memory')
      .upsert({ user_id: USER_A, topic: 'auth priv legacy service_role topic', notes: 'legacy', updated_at: new Date().toISOString() }, { onConflict: 'user_id,topic' })
    expect(error).toBeNull()
  })

  it('pending/NULL-lane public flow (upsert_creator_memory RPC via service_role) still works', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()
    const result = await upsertCreatorMemory(admin, { userId: USER_A, topic: 'auth priv pending flow topic' })
    expect(result.success).toBe(true)
    expect(result.row?.content_lane).toBeNull()
  })

  it('video_idea_id legacy compatibility: service_role can still write it directly in S1 (documented, RPC-only restriction deferred to 068)', () => {
    const canInsert = dockerPsql(`select has_column_privilege('service_role','creator_memory','video_idea_id','INSERT');`).trim()
    const canUpdate = dockerPsql(`select has_column_privilege('service_role','creator_memory','video_idea_id','UPDATE');`).trim()
    expect(canInsert).toBe('t')
    expect(canUpdate).toBe('t')
    // authenticated, in contrast, can do neither -- confirmed via the
    // table-level revoke tests above (no column can be writable if the
    // table-level grant is gone entirely).
    const authInsert = dockerPsql(`select has_column_privilege('authenticated','creator_memory','video_idea_id','INSERT');`).trim()
    const authUpdate = dockerPsql(`select has_column_privilege('authenticated','creator_memory','video_idea_id','UPDATE');`).trim()
    expect(authInsert).toBe('f')
    expect(authUpdate).toBe('f')
  })
})

// ============================================================
// S3 (068 applied) -- self-skips unless 068 is applied
// ============================================================
describeIfS3('Creator Lane -- authenticated privilege gate, S3 (068 contract)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    seedUsers()
  })
  afterAll(() => cleanup())

  it('neither authenticated nor service_role can write content_lane/video_idea_id directly (grant-level, table already exists so no INSERT test needed for pre-existing rows -- UPDATE proves it)', () => {
    dockerPsql(`INSERT INTO creator_memory (user_id, topic) VALUES ('${USER_A}', 's3 auth priv direct-write topic');`)

    const authErr = dockerPsqlExpectError(`
      SET ROLE authenticated;
      UPDATE creator_memory SET content_lane = 'evidence_led' WHERE user_id = '${USER_A}' AND topic = 's3 auth priv direct-write topic';
      RESET ROLE;
    `)
    expect(authErr).toMatch(/permission denied/i)

    const serviceErr = dockerPsqlExpectError(`
      SET ROLE service_role;
      UPDATE creator_memory SET content_lane = 'evidence_led' WHERE user_id = '${USER_A}' AND topic = 's3 auth priv direct-write topic';
      RESET ROLE;
    `)
    expect(serviceErr).toMatch(/permission denied/i)

    const serviceVideoIdeaErr = dockerPsqlExpectError(`
      SET ROLE service_role;
      UPDATE creator_memory SET video_idea_id = gen_random_uuid() WHERE user_id = '${USER_A}' AND topic = 's3 auth priv direct-write topic';
      RESET ROLE;
    `)
    expect(serviceVideoIdeaErr).toMatch(/permission denied/i)
  })

  it('the correct service_role RPC path works for lane-tagged writes', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdeaLane, lockVideoIdeaLane, upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()
    const parent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic: 's3 auth priv rpc path topic', contentLane: 'evidence_led', laneSource: 'explicit_user' })
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: parent.videoIdeaId! })
    const result = await upsertCreatorMemory(admin, { userId: USER_A, topic: 's3 auth priv rpc path topic', contentLane: 'evidence_led', videoIdeaId: parent.videoIdeaId! })
    expect(result.success).toBe(true)
    expect(result.row?.content_lane).toBe('evidence_led')
  })

  it('anon/PUBLIC cannot write creator_memory at all', () => {
    const anonErr = dockerPsqlExpectError(`
      SET ROLE anon;
      INSERT INTO creator_memory (user_id, topic) VALUES ('${USER_A}', 's3 anon write attempt topic');
      RESET ROLE;
    `)
    expect(anonErr).toMatch(/permission denied/i)
  })

  it('SELECT/DELETE product behavior unaffected: service_role DELETE (real API route shape) still works', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const admin = createAdminClient()
    const { data: created } = await admin.from('creator_memory').insert({ user_id: USER_A, topic: 's3 delete behavior topic' }).select().single()
    const { error: deleteErr } = await admin.from('creator_memory').delete().eq('id', created!.id).eq('user_id', USER_A)
    expect(deleteErr).toBeNull()
    const remaining = dockerPsql(`select count(*) from creator_memory where id='${created!.id}';`).trim()
    expect(remaining).toBe('0')
  })

  it('authenticated SELECT still works, own-row-only via RLS (product read path unaffected)', () => {
    dockerPsql(`INSERT INTO creator_memory (user_id, topic) VALUES ('${USER_A}', 's3 auth select topic');`)
    const out = dockerPsql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claims = '{"sub":"${USER_A}","role":"authenticated"}';
      SELECT count(*) FROM creator_memory WHERE topic = 's3 auth select topic';
      COMMIT;
    `).trim()
    expect(out).toBe('1')
  })

  it('same topic, three separate lanes (pending/evidence_led/entertainment_led) coexist without cross-lane or cross-tenant mixing', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdeaLane, lockVideoIdeaLane, upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()
    const topic = 's3 tri-lane no-mixing topic'

    const evidenceParent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic, contentLane: 'evidence_led', laneSource: 'explicit_user' })
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: evidenceParent.videoIdeaId! })
    const entertainmentParent = await ensureVideoIdeaLane(admin, { userId: USER_A, topic, contentLane: 'entertainment_led', laneSource: 'explicit_user' })
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: entertainmentParent.videoIdeaId! })

    const pending = await upsertCreatorMemory(admin, { userId: USER_A, topic, notes: 'PENDING' })
    const evidence = await upsertCreatorMemory(admin, { userId: USER_A, topic, contentLane: 'evidence_led', videoIdeaId: evidenceParent.videoIdeaId!, notes: 'EVIDENCE' })
    const entertainment = await upsertCreatorMemory(admin, { userId: USER_A, topic, contentLane: 'entertainment_led', videoIdeaId: entertainmentParent.videoIdeaId!, notes: 'ENTERTAINMENT' })
    expect(pending.success && evidence.success && entertainment.success).toBe(true)
    expect(new Set([pending.row?.id, evidence.row?.id, entertainment.row?.id]).size).toBe(3)

    // cross-tenant: user B creating the same topic must be entirely independent
    const bPending = await upsertCreatorMemory(admin, { userId: USER_B, topic, notes: 'USER_B_PENDING' })
    expect(bPending.success).toBe(true)
    expect(bPending.row?.id).not.toBe(pending.row?.id)

    const rows = dockerPsql(`select user_id || '|' || coalesce(content_lane,'NULL') || '|' || notes from creator_memory where topic='${topic}' order by user_id, content_lane nulls first;`).trim().split('\n')
    expect(rows.length).toBe(4)
    for (const row of rows) {
      const [uid] = row.split('|')
      expect([USER_A, USER_B]).toContain(uid)
    }
  })
})
