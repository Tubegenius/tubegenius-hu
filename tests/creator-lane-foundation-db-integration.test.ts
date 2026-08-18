// Creator Lane Architecture v0 — foundation layer, REAL local DB integration
// tests. Ugyanazt a mintat koveti, mint a meglevo emerging-signal-*-db-
// integration suite-ok: a MEGLEVO, futo lokalis Supabase Docker stacket
// hasznalja (127.0.0.1:54321, demo anon/service_role kulcsok — nem
// production). Ha a stack nem elerheto, a teljes describe-blokk
// kontrolláltan KIHAGYODIK, hogy a "teljes vitest" futas Docker nelkuli
// kornyezetben is zold maradjon.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

// This suite asserts CONTRACT (068) end-state facts -- the old global
// creator_memory_user_id_topic_key constraint being gone, and
// creator_memory.video_idea_id/content_lane being RPC-only for
// service_role -- which are only true once 068 has been applied on top of
// 067. If only 067 (expand) is applied (the real, intended intermediate
// production state between the Commit B and Commit C rollout gates -- see
// supabase/migrations/068_creator_lane_contract.sql's header), those facts
// are false by design, and this suite would hard-fail, not because
// anything is broken, but because it is asserting a later phase than the
// one on disk. Self-skip in that case, the same way stackAvailable already
// self-skips when Docker isn't present -- a fixture-availability skip, not
// an avoided hard case (see tests/creator-lane-s1-legacy-compat-db-
// integration.test.ts's header for the equivalent EXPAND-phase check).
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
  console.warn(
    'Creator Lane foundation suite skipped: local DB only has 067 (expand) applied, not 068 (contract). ' +
    'This suite asserts contract-phase facts. Run `supabase db reset` with 068 present to exercise it.'
  )
}

// Egyetlen, a teszt-fajlhoz kotott user_id auth.users-ben — a video_ideas/
// creator_memory FK-k (ON DELETE CASCADE / SET NULL) miatt kell egy valodi
// auth.users sor, kulonben az INSERT idegen kulcs hibaval elbukna.
const TEST_USER_A = 'a0000000-0000-4000-8000-000000000001'
const TEST_USER_B = 'a0000000-0000-4000-8000-000000000002'

function cleanupTestData() {
  dockerPsql(`
    delete from creator_memory where user_id in ('${TEST_USER_A}','${TEST_USER_B}');
    delete from video_ideas where user_id in ('${TEST_USER_A}','${TEST_USER_B}');
    delete from auth.users where id in ('${TEST_USER_A}','${TEST_USER_B}');
  `)
}

function seedTestUsers() {
  dockerPsql(`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
    values
      ('${TEST_USER_A}', 'lane-test-a@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated'),
      ('${TEST_USER_B}', 'lane-test-b@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated')
    on conflict (id) do nothing;
    delete from profiles where user_id in ('${TEST_USER_A}','${TEST_USER_B}');
  `)
}

describeIfLocalDb('Creator Lane Architecture v0 — foundation (real local DB)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    cleanupTestData()
    seedTestUsers()
  })

  afterAll(() => {
    cleanupTestData()
  })

  beforeEach(() => {
    dockerPsql(`
      delete from creator_memory where user_id in ('${TEST_USER_A}','${TEST_USER_B}');
      delete from video_ideas where user_id in ('${TEST_USER_A}','${TEST_USER_B}');
    `)
  })

  // ------------------------------------------------------------
  // 1. Migration state / idempotency (schema-level, via docker exec — the
  //    actual re-run + drift proofs already ran manually during
  //    implementation; here we assert the resulting end-state is exactly
  //    what the migration's own closing DO $validate$ block asserts).
  // ------------------------------------------------------------
  it('067 columns exist on profiles/video_ideas/creator_memory', () => {
    const out = dockerPsql(`
      select table_name || '.' || column_name from information_schema.columns
      where (table_name='profiles' and column_name='primary_creator_lane')
         or (table_name='video_ideas' and column_name in ('content_lane','lane_assignment_source','lane_locked_at','reclassified_from_video_idea_id','linked_signal_cluster_id','normalized_topic'))
         or (table_name='creator_memory' and column_name='content_lane')
      order by 1;
    `).trim().split('\n')
    expect(out).toEqual([
      'creator_memory.content_lane',
      'profiles.primary_creator_lane',
      'video_ideas.content_lane',
      'video_ideas.lane_assignment_source',
      'video_ideas.lane_locked_at',
      'video_ideas.linked_signal_cluster_id',
      'video_ideas.normalized_topic',
      'video_ideas.reclassified_from_video_idea_id',
    ])
  })

  it('old pre-lane video_ideas unique indexes are gone; new lane-aware video_ideas indexes are valid', () => {
    const oldIndexes = dockerPsql(`select indexname from pg_indexes where indexname in ('idx_video_ideas_user_input_hash','idx_video_ideas_user_topic_platform');`).trim()
    expect(oldIndexes).toBe('')
    const newValid = dockerPsql(`
      select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid
      where c.relname in ('idx_video_ideas_user_input_hash_lane','idx_video_ideas_user_topic_platform_lane')
        and i.indisvalid and i.indisready;
    `).trim()
    expect(newValid).toBe('2')
  })

  it('creator_memory old global (user_id,topic) unique constraint is gone; new 3-state partial unique indexes are valid', () => {
    const oldConstraint = dockerPsql(`select conname from pg_constraint where conname in ('creator_memory_user_id_topic_key','creator_memory_user_topic_unique');`).trim()
    expect(oldConstraint).toBe('')
    const newValid = dockerPsql(`
      select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid
      where c.relname in ('idx_creator_memory_user_topic_pending','idx_creator_memory_user_topic_lane')
        and i.indisvalid and i.indisready;
    `).trim()
    expect(newValid).toBe('2')
  })

  // ------------------------------------------------------------
  // 2. Lane-state CHECK constraint — all 4 legal states + illegal combos
  // ------------------------------------------------------------
  it('accepts the 4 legal lane states, rejects everything else', () => {
    const legal = [
      `(content_lane, lane_assignment_source, lane_locked_at) = (NULL, NULL, NULL)`,
      `(content_lane, lane_assignment_source, lane_locked_at) = (NULL, 'unconfirmed_quick_save', NULL)`,
      `(content_lane, lane_assignment_source, lane_locked_at) = ('evidence_led', 'explicit_user', NULL)`,
      `(content_lane, lane_assignment_source, lane_locked_at) = ('evidence_led', 'explicit_user', now())`,
    ]
    for (const [i, combo] of legal.entries()) {
      const topic = `lane state legal ${i}`
      const out = dockerPsql(`
        insert into video_ideas (user_id, title, topic, input_hash)
        select '${TEST_USER_A}', '${topic}', '${topic}', 'lsh-${i}'
        returning id;
      `).trim()
      expect(out).not.toBe('')
      const [lane, source, locked] = combo.includes('now()')
        ? ["'evidence_led'", "'explicit_user'", 'now()']
        : combo.match(/\(([^)]*)\)$/)![1].split(', ')
      dockerPsql(`update video_ideas set content_lane=${lane}, lane_assignment_source=${source}, lane_locked_at=${locked} where id='${out}';`)
    }
    const count = dockerPsql(`select count(*) from video_ideas where user_id='${TEST_USER_A}';`).trim()
    expect(count).toBe('4')

    // Illegal: lane set but source NULL
    expect(() => dockerPsql(`
      insert into video_ideas (user_id, title, topic, input_hash, content_lane)
      values ('${TEST_USER_A}', 'illegal', 'illegal combo topic', 'illegal-1', 'evidence_led');
    `)).toThrow()

    // Illegal: locked but lane NULL
    expect(() => dockerPsql(`
      insert into video_ideas (user_id, title, topic, input_hash, lane_locked_at)
      values ('${TEST_USER_A}', 'illegal2', 'illegal combo topic 2', 'illegal-2', now());
    `)).toThrow()

    // Illegal: unknown lane value
    expect(() => dockerPsql(`
      insert into video_ideas (user_id, title, topic, input_hash, content_lane, lane_assignment_source)
      values ('${TEST_USER_A}', 'illegal3', 'illegal combo topic 3', 'illegal-3', 'made_up_lane', 'explicit_user');
    `)).toThrow()
  })

  it('linked_signal_cluster_id requires evidence_led + locked', () => {
    const out = dockerPsql(`
      insert into video_ideas (user_id, title, topic, input_hash, content_lane, lane_assignment_source)
      values ('${TEST_USER_A}', 'sig', 'signal cluster topic', 'sig-1', 'entertainment_led', 'explicit_user')
      returning id;
    `).trim()
    expect(() => dockerPsql(`update video_ideas set linked_signal_cluster_id = gen_random_uuid() where id='${out}';`)).toThrow()
  })

  it('reclassified_from_video_idea_id cannot self-reference', () => {
    const out = dockerPsql(`
      insert into video_ideas (user_id, title, topic, input_hash)
      values ('${TEST_USER_A}', 'selfref', 'selfref topic', 'selfref-1')
      returning id;
    `).trim()
    expect(() => dockerPsql(`update video_ideas set reclassified_from_video_idea_id='${out}' where id='${out}';`)).toThrow()
  })

  // ------------------------------------------------------------
  // 3. Uniqueness model: same-topic different-lane allowed, same-topic
  //    same-lane duplicate blocked, legacy NULL-lane rows stay unique.
  // ------------------------------------------------------------
  it('same natural key can exist once per lane bucket, never twice in the same bucket', async () => {
    const { ensureVideoIdeaLane } = await import('@/lib/creator-lane/lane-service')
    const { createAdminClient } = await import('@/lib/supabase-server')
    const admin = createAdminClient()

    const evidence = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'dual lane topic', contentLane: 'evidence_led', laneSource: 'explicit_user',
    })
    expect(evidence.success).toBe(true)
    expect(evidence.created).toBe(true)

    const entertainment = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'dual lane topic', contentLane: 'entertainment_led', laneSource: 'explicit_user',
    })
    expect(entertainment.success).toBe(true)
    expect(entertainment.created).toBe(true)
    expect(entertainment.videoIdeaId).not.toBe(evidence.videoIdeaId)

    const count = dockerPsql(`select count(*) from video_ideas where user_id='${TEST_USER_A}' and lower(topic)='dual lane topic';`).trim()
    expect(count).toBe('2')

    // Re-ensuring the SAME lane again must be idempotent, not a duplicate.
    // laneSource is required whenever contentLane is asserted -- an
    // "exact bucket already exists" idempotent re-confirm still validates it.
    const evidenceAgain = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'dual lane topic', contentLane: 'evidence_led', laneSource: 'explicit_user',
    })
    expect(evidenceAgain.success).toBe(true)
    expect(evidenceAgain.videoIdeaId).toBe(evidence.videoIdeaId)
    expect(evidenceAgain.created).toBe(false)
    const countAfter = dockerPsql(`select count(*) from video_ideas where user_id='${TEST_USER_A}' and lower(topic)='dual lane topic';`).trim()
    expect(countAfter).toBe('2')
  })

  it('pending request is refused once ANY assigned/locked row exists for the natural key (invariant B)', async () => {
    const { ensureVideoIdeaLane } = await import('@/lib/creator-lane/lane-service')
    const { createAdminClient } = await import('@/lib/supabase-server')
    const admin = createAdminClient()

    const assigned = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'invariant b topic', contentLane: 'evidence_led', laneSource: 'explicit_user',
    })
    expect(assigned.success).toBe(true)

    const pendingAttempt = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'invariant b topic', contentLane: null,
    })
    expect(pendingAttempt.success).toBe(false)
    expect(pendingAttempt.error).toContain('lane_slot_taken')
  })

  it('legacy input_hash values are preserved byte-exact (no recompute, no backfill)', () => {
    const legacyHash = 'legacy-hash-value-untouched-1234567890'
    const out = dockerPsql(`
      insert into video_ideas (user_id, title, topic, input_hash)
      values ('${TEST_USER_A}', 'legacy', 'legacy hash preserve topic', '${legacyHash}')
      returning id;
    `).trim()
    dockerPsql(`update video_ideas set title='renamed but same identity' where id='${out}';`)
    const stored = dockerPsql(`select input_hash from video_ideas where id='${out}';`).trim()
    expect(stored).toBe(legacyHash)
    const laneCols = dockerPsql(`select coalesce(content_lane,'NULL') || '|' || coalesce(lane_assignment_source,'NULL') from video_ideas where id='${out}';`).trim()
    expect(laneCols).toBe('NULL|NULL')
  })

  // ------------------------------------------------------------
  // 4. creator_memory identity-immutability trigger
  // ------------------------------------------------------------
  it('creator_memory identity trigger: user_id/topic immutable, notes/state updatable, real upsert compatible', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const admin = createAdminClient()

    const { data: inserted, error: insertError } = await admin
      .from('creator_memory')
      .insert({ user_id: TEST_USER_A, topic: 'identity trigger topic', notes: 'v1' })
      .select()
      .single()
    expect(insertError).toBeNull()
    expect(inserted?.id).toBeTruthy()

    // direct user_id change -> denied
    const { error: userIdErr } = await admin.from('creator_memory').update({ user_id: TEST_USER_B }).eq('id', inserted!.id)
    expect(userIdErr).not.toBeNull()
    expect(userIdErr!.message).toContain('memory_identity_immutable')

    // direct topic change -> denied
    const { error: topicErr } = await admin.from('creator_memory').update({ topic: 'renamed topic' }).eq('id', inserted!.id)
    expect(topicErr).not.toBeNull()
    expect(topicErr!.message).toContain('memory_identity_immutable')

    // notes-only update -> allowed
    const { error: notesErr } = await admin.from('creator_memory').update({ notes: 'v2' }).eq('id', inserted!.id)
    expect(notesErr).toBeNull()

    // real upsert_creator_memory RPC call, identity unchanged -> still works
    // (the raw PostgREST .upsert({onConflict:'user_id,topic'}) call this
    // replaced no longer has a matching plain-column unique object -- see
    // migration section 6 -- so the RPC is now the only supported path)
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const upsertResult = await upsertCreatorMemory(admin, { userId: TEST_USER_A, topic: 'identity trigger topic', notes: 'v3' })
    expect(upsertResult.success).toBe(true)
    expect(upsertResult.row?.id).toBe(inserted!.id)
    expect(upsertResult.row?.notes).toBe('v3')

    // different tenant, same topic -> new row, not a merge
    const { data: otherTenant, error: otherErr } = await admin
      .from('creator_memory')
      .insert({ user_id: TEST_USER_B, topic: 'identity trigger topic', notes: 'other tenant' })
      .select()
      .single()
    expect(otherErr).toBeNull()
    expect(otherTenant?.id).not.toBe(inserted!.id)
  })

  // ------------------------------------------------------------
  // 5. creator_memory lane-consistency + video_idea_id RPC-only
  // ------------------------------------------------------------
  it('creator_memory.video_idea_id and content_lane are not directly writable by service_role', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const admin = createAdminClient()
    const { data: mem } = await admin.from('creator_memory').insert({ user_id: TEST_USER_A, topic: 'protected col topic' }).select().single()

    const { error: e1 } = await admin.from('creator_memory').update({ video_idea_id: crypto.randomUUID() }).eq('id', mem!.id)
    expect(e1).not.toBeNull()

    const { error: e2 } = await admin.from('creator_memory').update({ content_lane: 'evidence_led' }).eq('id', mem!.id)
    expect(e2).not.toBeNull()
  })

  it('link_creator_memory_parent: requires locked parent for lane snapshot, blocks reparenting, preserves orphan snapshot on parent delete', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdeaLane, lockVideoIdeaLane, linkCreatorMemoryParent } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const pendingParent = await ensureVideoIdeaLane(admin, { userId: TEST_USER_A, topic: 'link parent topic' })
    expect(pendingParent.success).toBe(true)

    const { data: mem } = await admin.from('creator_memory').insert({ user_id: TEST_USER_A, topic: 'link memory topic' }).select().single()

    // link to a PENDING (unlocked, lane-less) parent -> allowed, content_lane stays NULL
    const linkPending = await linkCreatorMemoryParent(admin, { userId: TEST_USER_A, memoryId: mem!.id, videoIdeaId: pendingParent.videoIdeaId! })
    expect(linkPending.success).toBe(true)
    expect(linkPending.contentLane).toBeNull()

    // now assign + lock the parent
    const assigned = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'link parent topic', contentLane: 'evidence_led', laneSource: 'explicit_user',
    })
    expect(assigned.videoIdeaId).toBe(pendingParent.videoIdeaId)
    const locked = await lockVideoIdeaLane(admin, { userId: TEST_USER_A, videoIdeaId: pendingParent.videoIdeaId! })
    expect(locked.success).toBe(true)

    // re-link (idempotent, same parent) -> now snapshots the locked lane
    const linkLocked = await linkCreatorMemoryParent(admin, { userId: TEST_USER_A, memoryId: mem!.id, videoIdeaId: pendingParent.videoIdeaId! })
    expect(linkLocked.success).toBe(true)
    expect(linkLocked.contentLane).toBe('evidence_led')

    // reparent attempt -> forbidden
    const otherParent = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'other parent topic', contentLane: 'evidence_led', laneSource: 'explicit_user',
    })
    const reparent = await linkCreatorMemoryParent(admin, { userId: TEST_USER_A, memoryId: mem!.id, videoIdeaId: otherParent.videoIdeaId! })
    expect(reparent.success).toBe(false)
    expect(reparent.error).toContain('memory_reparent_forbidden')

    // parent delete -> video_idea_id NULL, content_lane snapshot PRESERVED (audit trail)
    dockerPsql(`delete from video_ideas where id='${pendingParent.videoIdeaId}';`)
    const after = dockerPsql(`select coalesce(video_idea_id::text,'NULL') || '|' || coalesce(content_lane,'NULL') from creator_memory where id='${mem!.id}';`).trim()
    expect(after).toBe('NULL|evidence_led')

    // orphaned lane-memory cannot be re-linked to a NEW parent
    const newParent = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'new parent for orphan', contentLane: 'evidence_led', laneSource: 'explicit_user',
    })
    const relinkOrphan = await linkCreatorMemoryParent(admin, { userId: TEST_USER_A, memoryId: mem!.id, videoIdeaId: newParent.videoIdeaId! })
    expect(relinkOrphan.success).toBe(false)
    expect(relinkOrphan.error).toContain('memory_reparent_forbidden_orphan')
  })

  // ------------------------------------------------------------
  // 6. RPC tenant ownership
  // ------------------------------------------------------------
  it('RPCs enforce tenant ownership: foreign user_id never touches another tenant row', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdeaLane, lockVideoIdeaLane, reclassifyVideoIdea } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const ownedByA = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'tenant owned topic', contentLane: 'evidence_led', laneSource: 'explicit_user',
    })
    expect(ownedByA.success).toBe(true)

    const lockAsB = await lockVideoIdeaLane(admin, { userId: TEST_USER_B, videoIdeaId: ownedByA.videoIdeaId! })
    expect(lockAsB.success).toBe(false)
    expect(lockAsB.error).toContain('not_found')

    const reclassifyAsB = await reclassifyVideoIdea(admin, {
      userId: TEST_USER_B, sourceVideoIdeaId: ownedByA.videoIdeaId!, newLane: 'entertainment_led', newSource: 'explicit_user',
    })
    expect(reclassifyAsB.success).toBe(false)
    expect(reclassifyAsB.error).toContain('not_found')

    // and a random non-existent id gives the SAME error (no existence leak)
    const lockRandom = await lockVideoIdeaLane(admin, { userId: TEST_USER_A, videoIdeaId: crypto.randomUUID() })
    expect(lockRandom.error).toContain('not_found')
  })

  // ------------------------------------------------------------
  // 7. RPC ACL / search_path / owner
  // ------------------------------------------------------------
  it('all 4 RPCs and 3 trigger functions are postgres-owned with pinned search_path', () => {
    const out = dockerPsql(`
      select proname || '|' || (select rolname from pg_roles where oid=proowner) || '|' ||
             coalesce((select string_agg(x,',') from unnest(proconfig) x where x like 'search_path=%'), 'NONE')
      from pg_proc where pronamespace='public'::regnamespace
        and proname in ('ensure_video_idea_lane','lock_video_idea_lane','reclassify_video_idea','link_creator_memory_parent',
                         'enforce_video_idea_lane_lock_immutable','enforce_creator_memory_identity','enforce_creator_memory_lane_consistency')
      order by proname;
    `).trim().split('\n')
    for (const line of out) {
      const [, owner, searchPath] = line.split('|')
      expect(owner).toBe('postgres')
      expect(searchPath).toBe('search_path=public, pg_temp')
    }
    expect(out.length).toBe(7)
  })

  it('RPC EXECUTE is granted only to service_role, never PUBLIC/anon/authenticated', () => {
    const rpcs = [
      'public.ensure_video_idea_lane(uuid,text,text,text,text,text,text,text,text,text,text)',
      'public.lock_video_idea_lane(uuid,uuid)',
      'public.reclassify_video_idea(uuid,uuid,text,text)',
      'public.link_creator_memory_parent(uuid,uuid,uuid)',
    ]
    for (const sig of rpcs) {
      const anon = dockerPsql(`select has_function_privilege('anon', '${sig}'::regprocedure, 'EXECUTE');`).trim()
      const authenticated = dockerPsql(`select has_function_privilege('authenticated', '${sig}'::regprocedure, 'EXECUTE');`).trim()
      const serviceRole = dockerPsql(`select has_function_privilege('service_role', '${sig}'::regprocedure, 'EXECUTE');`).trim()
      expect({ sig, anon, authenticated, serviceRole }).toEqual({ sig, anon: 'f', authenticated: 'f', serviceRole: 't' })
    }
    const triggers = [
      'public.enforce_video_idea_lane_lock_immutable()',
      'public.enforce_creator_memory_identity()',
      'public.enforce_creator_memory_lane_consistency()',
    ]
    for (const sig of triggers) {
      const serviceRole = dockerPsql(`select has_function_privilege('service_role', '${sig}'::regprocedure, 'EXECUTE');`).trim()
      expect(serviceRole).toBe('f')
    }
  })

  // ------------------------------------------------------------
  // 8. Lane lock immutability
  // ------------------------------------------------------------
  it('locked lane is fully immutable: content_lane, source, timestamp, and lineage all reject change', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdeaLane, lockVideoIdeaLane } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const idea = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'lock immutable topic', contentLane: 'evidence_led', laneSource: 'explicit_user',
    })
    const locked = await lockVideoIdeaLane(admin, { userId: TEST_USER_A, videoIdeaId: idea.videoIdeaId! })
    expect(locked.success).toBe(true)

    // second lock attempt -> already_locked
    const relock = await lockVideoIdeaLane(admin, { userId: TEST_USER_A, videoIdeaId: idea.videoIdeaId! })
    expect(relock.success).toBe(false)
    expect(relock.error).toContain('already_locked')

    expect(() => dockerPsql(`update video_ideas set content_lane='entertainment_led' where id='${idea.videoIdeaId}';`)).toThrow()
    expect(() => dockerPsql(`update video_ideas set lane_assignment_source='legacy_user_confirmed' where id='${idea.videoIdeaId}';`)).toThrow()
    expect(() => dockerPsql(`update video_ideas set lane_locked_at=NULL where id='${idea.videoIdeaId}';`)).toThrow()
    expect(() => dockerPsql(`update video_ideas set lane_locked_at=now() where id='${idea.videoIdeaId}';`)).toThrow()
  })

  // ------------------------------------------------------------
  // 9. Reclassification: clone + lineage, original unchanged, no carryover
  // ------------------------------------------------------------
  it('reclassify_video_idea creates a locked-independent clone with lineage, never mutates the source, never copies lane-specific results', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdeaLane, lockVideoIdeaLane, reclassifyVideoIdea } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const src = await ensureVideoIdeaLane(admin, {
      userId: TEST_USER_A, topic: 'reclassify source topic', contentLane: 'evidence_led', laneSource: 'explicit_user',
    })
    await lockVideoIdeaLane(admin, { userId: TEST_USER_A, videoIdeaId: src.videoIdeaId! })
    dockerPsql(`update video_ideas set viral_score=77, opportunity_score=88 where id='${src.videoIdeaId}';`)

    const beforeSrc = dockerPsql(`select content_lane || '|' || lane_locked_at::text from video_ideas where id='${src.videoIdeaId}';`).trim()

    const clone = await reclassifyVideoIdea(admin, {
      userId: TEST_USER_A, sourceVideoIdeaId: src.videoIdeaId!, newLane: 'entertainment_led', newSource: 'explicit_user',
    })
    expect(clone.success).toBe(true)
    expect(clone.newVideoIdeaId).not.toBe(src.videoIdeaId)
    expect(clone.reclassifiedFromVideoIdeaId).toBe(src.videoIdeaId)

    // source row completely unchanged
    const afterSrc = dockerPsql(`select content_lane || '|' || lane_locked_at::text from video_ideas where id='${src.videoIdeaId}';`).trim()
    expect(afterSrc).toBe(beforeSrc)

    // clone starts assigned_unlocked (NOT locked), with clean legacy scores,
    // no linked_signal_cluster_id, correct lineage
    const cloneRow = dockerPsql(`
      select content_lane || '|' || coalesce(lane_locked_at::text,'NULL') || '|' ||
             coalesce(viral_score::text,'NULL') || '|' || coalesce(opportunity_score::text,'NULL') || '|' ||
             coalesce(linked_signal_cluster_id::text,'NULL') || '|' || reclassified_from_video_idea_id::text
      from video_ideas where id='${clone.newVideoIdeaId}';
    `).trim()
    expect(cloneRow).toBe(`entertainment_led|NULL|NULL|NULL|NULL|${src.videoIdeaId}`)

    // lineage is immutable after insert
    const otherIdea = await ensureVideoIdeaLane(admin, { userId: TEST_USER_A, topic: 'lineage immutable other topic' })
    expect(() => dockerPsql(`update video_ideas set reclassified_from_video_idea_id='${otherIdea.videoIdeaId}' where id='${clone.newVideoIdeaId}';`)).toThrow()
  })

  // ------------------------------------------------------------
  // 10. Column-level grants — positive/negative, real tables (not scratch)
  // ------------------------------------------------------------
  it('service_role: allowlisted columns writable, protected columns rejected (real video_ideas/creator_memory)', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const admin = createAdminClient()

    const { data: idea, error: insErr } = await admin
      .from('video_ideas')
      .insert({ user_id: TEST_USER_A, title: 'grant test', topic: 'grant test topic', input_hash: 'grant-hash-1' })
      .select()
      .single()
    expect(insErr).toBeNull()

    const { error: okUpdate } = await admin.from('video_ideas').update({ title: 'renamed', workflow_status: 'validating' }).eq('id', idea!.id)
    expect(okUpdate).toBeNull()

    for (const col of ['content_lane', 'lane_assignment_source', 'lane_locked_at', 'reclassified_from_video_idea_id', 'linked_signal_cluster_id', 'normalized_topic']) {
      const value = col === 'lane_locked_at' ? new Date().toISOString() : col.includes('_id') ? crypto.randomUUID() : 'evidence_led'
      const { error } = await admin.from('video_ideas').update({ [col]: value }).eq('id', idea!.id)
      expect(error, `expected DENY for video_ideas.${col}`).not.toBeNull()
    }

    const { error: userIdUpdateErr } = await admin.from('video_ideas').update({ user_id: TEST_USER_B }).eq('id', idea!.id)
    expect(userIdUpdateErr).not.toBeNull()
    const { error: inputHashUpdateErr } = await admin.from('video_ideas').update({ input_hash: 'changed' }).eq('id', idea!.id)
    expect(inputHashUpdateErr).not.toBeNull()
  })

  // ------------------------------------------------------------
  // 11. Route regression: app/api/memory/route.ts POST was edited to stop
  //     writing video_idea_id directly and call linkVideoIdeaToLegacyRecord
  //     (which now routes creator_memory targets through the RPC) instead.
  //     This exercises exactly that modified function, plus the full
  //     upsert-then-link sequence the route performs, end to end against
  //     the real local DB.
  // ------------------------------------------------------------
  it('linkVideoIdeaToLegacyRecord(table:creator_memory) routes through the RPC and survives the exact memory/route.ts POST sequence', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdea, linkVideoIdeaToLegacyRecord } = await import('@/lib/video-ideas/video-idea-service')
    const { upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    // mirrors app/api/memory/route.ts POST exactly: ensureVideoIdea first,
    // then upsert_creator_memory (pending/NULL-lane branch, no video_idea_id
    // in the payload), then link via linkVideoIdeaToLegacyRecord
    const ideaResult = await ensureVideoIdea(admin, { userId: TEST_USER_A, title: 'route regression topic', topic: 'route regression topic' })
    expect(ideaResult.success).toBe(true)

    const upsertResult = await upsertCreatorMemory(admin, { userId: TEST_USER_A, topic: 'route regression topic', state: 'saved' })
    expect(upsertResult.success).toBe(true)
    const memRow = upsertResult.row as { id: string; video_idea_id: string | null }
    expect(memRow?.video_idea_id).toBeNull() // not yet linked -- payload never included it

    const linkResult = await linkVideoIdeaToLegacyRecord(admin, {
      table: 'creator_memory', userId: TEST_USER_A, recordId: memRow!.id, videoIdeaId: ideaResult.idea!.id,
    })
    expect(linkResult.success).toBe(true)

    const finalRow = dockerPsql(`select video_idea_id::text from creator_memory where id='${memRow!.id}';`).trim()
    expect(finalRow).toBe(ideaResult.idea!.id)
  })
})
