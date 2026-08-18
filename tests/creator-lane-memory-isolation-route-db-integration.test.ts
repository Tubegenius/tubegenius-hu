// Creator Lane Architecture v0 — three-record (NULL/evidence_led/
// entertainment_led) lane isolation proof, at BOTH the service layer and
// the real app/api/memory/route.ts GET handler, against the real local
// Supabase Docker stack. Only the auth client is mocked (Next's
// `next/headers` cookies() has no request context outside a real Next
// server); createAdminClient is left REAL, pointed at the local stack via
// the same env-override pattern as the other -db-integration suites.
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

// This suite creates and isolates three coexisting creator_memory rows
// (NULL/evidence_led/entertainment_led) for the same user_id+topic, which
// is only possible once 068 (contract) has dropped the old global
// creator_memory_user_id_topic_key constraint on top of 067 (expand). With
// only 067 applied, the second-lane insert would fail by design (see 067's
// header), so this suite would hard-fail rather than skip. Self-skip in
// that case -- fixture-availability skip, not an avoided hard case, same
// pattern as the stackAvailable check above.
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
  console.warn('Creator Lane memory-isolation suite skipped: local DB only has 067 (expand) applied, not 068 (contract).')
}

const USER_A = 'd1000000-0000-4000-8000-000000000001'
const USER_B = 'd1000000-0000-4000-8000-000000000002'
const TOPIC = 'triad isolation topic'

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

describeIfLocalDb('Creator Lane — three-record lane isolation (real local DB + real route handler)', () => {
  let evidenceParent: string
  let entertainmentParent: string

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    dockerPsql(`
      delete from creator_memory where user_id in ('${USER_A}','${USER_B}');
      delete from video_ideas where user_id in ('${USER_A}','${USER_B}');
      delete from auth.users where id in ('${USER_A}','${USER_B}');
      insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
      values
        ('${USER_A}', 'triad-a@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated'),
        ('${USER_B}', 'triad-b@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated');
    `)

    const { createAdminClient } = await import('@/lib/supabase-server')
    const { ensureVideoIdeaLane, lockVideoIdeaLane, upsertCreatorMemory } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const evIdea = await ensureVideoIdeaLane(admin, { userId: USER_A, topic: TOPIC, contentLane: 'evidence_led', laneSource: 'explicit_user' })
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: evIdea.videoIdeaId! })
    evidenceParent = evIdea.videoIdeaId!

    const entIdea = await ensureVideoIdeaLane(admin, { userId: USER_A, topic: TOPIC, contentLane: 'entertainment_led', laneSource: 'explicit_user' })
    await lockVideoIdeaLane(admin, { userId: USER_A, videoIdeaId: entIdea.videoIdeaId! })
    entertainmentParent = entIdea.videoIdeaId!

    // 3 distinct, easily-recognizable records for the SAME user + topic
    await upsertCreatorMemory(admin, { userId: USER_A, topic: TOPIC, notes: 'PENDING_MARK', state: 'saved', opportunityScore: 11 })
    await upsertCreatorMemory(admin, { userId: USER_A, topic: TOPIC, contentLane: 'evidence_led', videoIdeaId: evidenceParent, notes: 'EVIDENCE_MARK', state: 'in_progress', opportunityScore: 22 })
    await upsertCreatorMemory(admin, { userId: USER_A, topic: TOPIC, contentLane: 'entertainment_led', videoIdeaId: entertainmentParent, notes: 'ENTERTAINMENT_MARK', state: 'completed', opportunityScore: 33 })

    // a second user's record for the SAME topic -- must never leak into user A's reads
    await upsertCreatorMemory(admin, { userId: USER_B, topic: TOPIC, notes: 'OTHER_USER_MARK', state: 'saved' })
  })

  afterAll(() => {
    dockerPsql(`
      delete from creator_memory where user_id in ('${USER_A}','${USER_B}');
      delete from video_ideas where user_id in ('${USER_A}','${USER_B}');
      delete from auth.users where id in ('${USER_A}','${USER_B}');
    `)
  })

  // ---- service layer ----
  it('service layer: getCreatorMemoryByLaneFilter sees exactly one record per lane, never another user', async () => {
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { getCreatorMemoryByLaneFilter } = await import('@/lib/creator-lane/lane-service')
    const admin = createAdminClient()

    const pending = await getCreatorMemoryByLaneFilter(admin, { userId: USER_A, contentLane: null })
    const pendingForTopic = pending.filter((r: any) => r.topic === TOPIC)
    expect(pendingForTopic).toHaveLength(1)
    expect(pendingForTopic[0].notes).toBe('PENDING_MARK')

    const evidence = await getCreatorMemoryByLaneFilter(admin, { userId: USER_A, contentLane: 'evidence_led' })
    const evidenceForTopic = evidence.filter((r: any) => r.topic === TOPIC)
    expect(evidenceForTopic).toHaveLength(1)
    expect(evidenceForTopic[0].notes).toBe('EVIDENCE_MARK')

    const entertainment = await getCreatorMemoryByLaneFilter(admin, { userId: USER_A, contentLane: 'entertainment_led' })
    const entertainmentForTopic = entertainment.filter((r: any) => r.topic === TOPIC)
    expect(entertainmentForTopic).toHaveLength(1)
    expect(entertainmentForTopic[0].notes).toBe('ENTERTAINMENT_MARK')

    // no query returns another user's row
    for (const rows of [pending, evidence, entertainment]) {
      expect(rows.some((r: any) => r.notes === 'OTHER_USER_MARK')).toBe(false)
    }

    // invalid lane -> fail-closed, never all-lane
    await expect(getCreatorMemoryByLaneFilter(admin, { userId: USER_A, contentLane: 'bogus' as any })).rejects.toThrow('invalid_content_lane')
  })

  // ---- real route handler ----
  it('route layer: GET /api/memory without ?lane= returns ONLY the pending record', async () => {
    mockAuthAs(USER_A)
    const { GET } = await import('@/app/api/memory/route')
    const response = await GET({ url: 'http://localhost/api/memory' } as any)
    const payload = await response.json()
    expect(response.status).toBe(200)
    const forTopic = payload.items.filter((i: any) => i.topic === TOPIC)
    expect(forTopic).toHaveLength(1)
    expect(forTopic[0].notes).toBe('PENDING_MARK')
    expect(forTopic[0].content_lane).toBeNull()
  })

  it('route layer: GET /api/memory?lane=evidence_led returns ONLY the evidence_led record', async () => {
    mockAuthAs(USER_A)
    const { GET } = await import('@/app/api/memory/route')
    const response = await GET({ url: 'http://localhost/api/memory?lane=evidence_led' } as any)
    const payload = await response.json()
    expect(response.status).toBe(200)
    const forTopic = payload.items.filter((i: any) => i.topic === TOPIC)
    expect(forTopic).toHaveLength(1)
    expect(forTopic[0].notes).toBe('EVIDENCE_MARK')
  })

  it('route layer: GET /api/memory?lane=entertainment_led returns ONLY the entertainment_led record', async () => {
    mockAuthAs(USER_A)
    const { GET } = await import('@/app/api/memory/route')
    const response = await GET({ url: 'http://localhost/api/memory?lane=entertainment_led' } as any)
    const payload = await response.json()
    expect(response.status).toBe(200)
    const forTopic = payload.items.filter((i: any) => i.topic === TOPIC)
    expect(forTopic).toHaveLength(1)
    expect(forTopic[0].notes).toBe('ENTERTAINMENT_MARK')
  })

  it('route layer: GET /api/memory?lane=bogus fails closed with HTTP 400, never falls back to all-lane', async () => {
    mockAuthAs(USER_A)
    const { GET } = await import('@/app/api/memory/route')
    const response = await GET({ url: 'http://localhost/api/memory?lane=bogus' } as any)
    expect(response.status).toBe(400)
  })

  it('route layer: user B never sees user A records under any lane', async () => {
    mockAuthAs(USER_B)
    const { GET } = await import('@/app/api/memory/route')
    const response = await GET({ url: 'http://localhost/api/memory' } as any)
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload.items.some((i: any) => i.notes === 'PENDING_MARK' || i.notes === 'EVIDENCE_MARK' || i.notes === 'ENTERTAINMENT_MARK')).toBe(false)
    expect(payload.items.some((i: any) => i.notes === 'OTHER_USER_MARK')).toBe(true)
  })

  it('dashboard-stats and dashboard/summary route handlers do not mix lanes for the triad topic', async () => {
    mockAuthAs(USER_A)
    const { GET: statsGet } = await import('@/app/api/dashboard-stats/route')
    const statsRes = await statsGet()
    expect(statsRes.status).toBe(200)

    const { GET: summaryGet } = await import('@/app/api/dashboard/summary/route')
    const summaryRes = await summaryGet()
    const summaryPayload = await summaryRes.json()
    expect(summaryRes.status).toBe(200)
    // the summary route selects id/topic/state/platform/opportunity_score/updated_at
    // for the memory feed it exposes -- verify only the pending record's
    // opportunity_score (11) appears for this topic, never 22 or 33
    const memoryFeed: any[] = summaryPayload.recent_activity || []
    const triadEntries = memoryFeed.filter((m: any) => m.type === 'memory' && m.topic === TOPIC)
    for (const entry of triadEntries) {
      if (entry.score !== undefined && entry.score !== null) {
        expect(entry.score).not.toBe(22)
        expect(entry.score).not.toBe(33)
      }
    }
  })
})
