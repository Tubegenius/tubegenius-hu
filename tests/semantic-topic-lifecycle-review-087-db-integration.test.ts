// Semantic Topic Lifecycle Review Framework v1 -- migration 087, REAL
// local DB integration tests. Mirrors the established 077/078/086
// pattern: local Docker Supabase stack, real GoTrue reviewer session for
// authenticated-RPC boundary proofs, SET ROLE for grant-boundary checks,
// only synthetic/deterministic fixtures -- no AI/provider call, no
// production data.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const MIGRATION_087_PATH = join(process.cwd(), 'supabase/migrations/087_semantic_topic_lifecycle_review_framework.sql')
const migrationSource = readFileSync(MIGRATION_087_PATH, 'utf8')
const LOCAL_API_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const adminClient = createClient(LOCAL_API_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', { input: sql, encoding: 'utf-8' })
}
function dockerPsqlExpectError(sql: string): string {
  try {
    execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', { input: sql, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return '__NO_ERROR__'
  } catch (e: any) {
    return String(e.stderr || e.stdout || e.message || '')
  }
}
function runMigration(path: string): { out: string; threw: boolean } {
  const migrationSql = readFileSync(path, 'utf8')
  try {
    const out = execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1', { input: migrationSql, encoding: 'utf8' })
    return { out, threw: false }
  } catch (e: any) {
    return { out: String(e.stdout || e.stderr || e.message || ''), threw: true }
  }
}

let stackAvailable = false
try {
  execSync(`curl -sf ${LOCAL_API_URL}/auth/v1/health -H "apikey: ${LOCAL_ANON_KEY}"`, { stdio: 'ignore' })
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}
const describeIfLocalDb = stackAvailable ? describe : describe.skip

const MARKER = 'sti-087'
let fixtureCounter = 0
function nextMarker(): string {
  fixtureCounter += 1
  return `${MARKER}-${Date.now()}-${fixtureCounter}`
}
function randomHexDigest(): string {
  let s = ''
  while (s.length < 64) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

function ensureFullyApplied() {
  const r = runMigration(MIGRATION_087_PATH)
  if (r.threw) throw new Error(`ensureFullyApplied: 087 failed -- ${r.out}`)
}

function cleanupTestData() {
  dockerPsql(`
    delete from semantic_topic_lifecycle_transition_events where review_request_id in (select id from semantic_topic_lifecycle_review_requests where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%'));
    delete from semantic_topic_lifecycle_review_events where review_request_id in (select id from semantic_topic_lifecycle_review_requests where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%'));
    delete from semantic_topic_lifecycle_review_requests where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%');
    delete from semantic_topic_membership where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%') or signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from semantic_topics where canonical_label like '${MARKER}%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
  `)
}

function insertSource(externalId: string): string {
  return dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${externalId}', '${externalId}') returning id;`).trim()
}
function insertRun(idempotencyKey: string): string {
  return dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${idempotencyKey}', 'completed', now()) returning id;`).trim()
}
function insertEvidence(marker: string, sourceId: string): string {
  const runId = insertRun(`${marker}-run`)
  return dockerPsql(`
    insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id)
    values ('${sourceId}', 'youtube_video', '${marker}-ev', '${MARKER} fixture evidence', '${runId}')
    returning id;
  `).trim()
}
function insertTopic(lifecycleStatus: string, overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    canonical_label: `'${MARKER} topic ${Math.random().toString(36).slice(2)}'`,
    label_language: `'en'`,
    creation_request_digest: `'${randomHexDigest()}'`,
    lifecycle_status: `'${lifecycleStatus}'`,
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into semantic_topics (${cols}) values (${vals}) returning id;`).trim()
}
function insertMembership(topicId: string, evidenceId: string, overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    semantic_topic_id: `'${topicId}'`,
    signal_evidence_id: `'${evidenceId}'`,
    assignment_reason: `'manual_review_confirmed'`,
    confidence: '0.9000',
    algorithm_version: '1',
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into semantic_topic_membership (${cols}) values (${vals}) returning id;`).trim()
}

// A corroborating topic with 2 distinct known sources (meets the coherent floor).
function makeCorroboratingTopicWithTwoSources(m: string): string {
  const srcA = insertSource(`${m}-chanA`)
  const srcB = insertSource(`${m}-chanB`)
  const topic = insertTopic('corroborating')
  const evA = insertEvidence(`${m}-a`, srcA)
  const evB = insertEvidence(`${m}-b`, srcB)
  insertMembership(topic, evA)
  insertMembership(topic, evB)
  return topic
}

function topicRow(topicId: string): { lifecycle_status: string; status_version: number } {
  const out = dockerPsql(`select lifecycle_status || '|' || status_version from semantic_topics where id='${topicId}';`).trim()
  const [lifecycle_status, sv] = out.split('|')
  return { lifecycle_status, status_version: Number(sv) }
}

function createRequestAsService(topicId: string, targetStatus: string, idemKey: string): any {
  return JSON.parse(dockerPsql(`select create_semantic_topic_lifecycle_review_request('${topicId}'::uuid, '${targetStatus}', '${idemKey}');`).trim())
}

// ── Real GoTrue reviewer session, established pattern (mirrors 086's own). ──
const REVIEWER_EMAIL = `${MARKER}-reviewer-${Date.now()}@example.test`
const REVIEWER_PASSWORD = `Test-${randomUUID()}-!Aa1`
let reviewerUserId: string
let userClient: ReturnType<typeof createClient>

async function recordDecisionAsReviewer(params: {
  reviewRequestId: string
  decisionKey: string
  outcome: 'approved' | 'rejected'
  reasonCode: string | null
  rationale: string
  checklist?: { a: boolean; b: boolean; c: boolean; d: boolean }
  policyVersion?: number
}) {
  const c = params.checklist
  const { data, error } = await (userClient as any).rpc('record_semantic_topic_lifecycle_review_decision', {
    p_review_request_id: params.reviewRequestId,
    p_decision_idempotency_key: params.decisionKey,
    p_outcome: params.outcome,
    p_reason_code: params.reasonCode,
    p_reviewer_rationale: params.rationale,
    p_same_semantic_identity_confirmed: c ? c.a : null,
    p_no_material_identity_conflict: c ? c.b : null,
    p_canonical_definition_scope_fit_confirmed: c ? c.c : null,
    p_provenance_relationship_reviewed: c ? c.d : null,
    p_review_policy_version: params.policyVersion ?? 1,
  })
  if (error) throw error
  return data
}

function executeAsService(reviewRequestId: string, idemKey: string): any {
  return JSON.parse(dockerPsql(`select execute_approved_semantic_topic_lifecycle_transition('${reviewRequestId}'::uuid, '${idemKey}');`).trim())
}

describeIfLocalDb('Semantic Topic Lifecycle Review Framework v1 -- 087 (real local DB)', () => {
  beforeAll(async () => {
    ensureFullyApplied()
    cleanupTestData()
    const { data, error } = await adminClient.auth.admin.createUser({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD, email_confirm: true })
    if (error || !data.user) throw new Error(`failed to create fixture reviewer user: ${error?.message}`)
    reviewerUserId = data.user.id
    dockerPsql(`insert into semantic_topic_reviewers (user_id, provisioning_note) values ('${reviewerUserId}', '${MARKER} fixture -- not a real bootstrap') on conflict do nothing;`)
    userClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
    const signIn = await userClient.auth.signInWithPassword({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD })
    if (signIn.error) throw new Error(`fixture reviewer sign-in failed: ${signIn.error.message}`)
  })

  afterAll(async () => {
    cleanupTestData()
    try {
      dockerPsql(`delete from semantic_topic_reviewer_events where reviewer_user_id='${reviewerUserId}'; delete from semantic_topic_reviewers where user_id='${reviewerUserId}';`)
    } finally {
      if (reviewerUserId) await adminClient.auth.admin.deleteUser(reviewerUserId)
    }
  })

  // ============================================================
  // A. The four allowed transitions -- full success path
  // ============================================================
  describe('A. four v1-supported transitions, full request -> decision -> execute path', () => {
    it('A1. corroborating -> coherent, full success path', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      expect(created.ok).toBe(true)
      expect(created.status).toBe('requested')

      const decision = await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId,
        decisionKey: `${m}-dec`,
        outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed',
        rationale: 'Clear, consistent identity across both sources.',
        checklist: { a: true, b: true, c: true, d: true },
      })
      expect(decision.ok).toBe(true)
      expect(decision.status).toBe('approved')
      // Approval alone must not have touched the topic's lifecycle_status yet.
      expect(topicRow(topic).lifecycle_status).toBe('corroborating')

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(true)
      expect(executed.newLifecycleStatus).toBe('coherent')
      const row = topicRow(topic)
      expect(row.lifecycle_status).toBe('coherent')
      expect(row.status_version).toBe(2)
    })

    it('A2. corroborating -> ambiguous, full success path (vector floor NOT required for ambiguous)', async () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic('corroborating')
      const ev = insertEvidence(m, src)
      insertMembership(topic, ev)
      // Only ONE known source -- would fail the coherent floor, but ambiguous has no such floor.
      const created = createRequestAsService(topic, 'ambiguous', `${m}-req`)
      expect(created.ok).toBe(true)

      const decision = await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'conflicting_identity_signal', rationale: 'A later source appears to contradict the original identity.',
      })
      expect(decision.ok).toBe(true)

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(true)
      expect(executed.newLifecycleStatus).toBe('ambiguous')
    })

    it('A3. ambiguous -> corroborating, full success path', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      dockerPsql(`update semantic_topics set lifecycle_status='ambiguous' where id='${topic}';`)
      const created = createRequestAsService(topic, 'corroborating', `${m}-req`)
      expect(created.ok).toBe(true)

      const decision = await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'suspicion_unfounded', rationale: 'On closer review the suspicion does not hold up.',
      })
      expect(decision.ok).toBe(true)

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(true)
      expect(executed.newLifecycleStatus).toBe('corroborating')
    })

    it('A4. ambiguous -> coherent, full success path', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      dockerPsql(`update semantic_topics set lifecycle_status='ambiguous' where id='${topic}';`)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      expect(created.ok).toBe(true)

      const decision = await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'The ambiguity is resolved; identity is confirmed.',
        checklist: { a: true, b: true, c: true, d: true },
      })
      expect(decision.ok).toBe(true)

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(true)
      expect(executed.newLifecycleStatus).toBe('coherent')
    })
  })

  // ============================================================
  // B. Every other from->target combination is rejected
  // ============================================================
  describe('B. unsupported transitions rejected', () => {
    it('B1. candidate_singleton topic cannot get a lifecycle review request at all', () => {
      const topic = insertTopic('candidate_singleton')
      const err = dockerPsqlExpectError(`select create_semantic_topic_lifecycle_review_request('${topic}'::uuid, 'coherent', '${nextMarker()}');`)
      expect(err).toMatch(/UNSUPPORTED_TRANSITION/)
    })

    it('B2. corroborating -> corroborating rejected', () => {
      const topic = makeCorroboratingTopicWithTwoSources(nextMarker())
      const err = dockerPsqlExpectError(`select create_semantic_topic_lifecycle_review_request('${topic}'::uuid, 'corroborating', '${nextMarker()}');`)
      expect(err).toMatch(/UNSUPPORTED_TRANSITION/)
    })

    it('B3. target_status outside the closed set rejected at the SQL layer', () => {
      const topic = makeCorroboratingTopicWithTwoSources(nextMarker())
      const err = dockerPsqlExpectError(`select create_semantic_topic_lifecycle_review_request('${topic}'::uuid, 'split_required', '${nextMarker()}');`)
      expect(err).toMatch(/p_target_status must be one of/)
    })
  })

  // ============================================================
  // C. Coherent mechanical minimums + structured checklist enforcement
  // ============================================================
  describe('C. coherent mechanical minimums and checklist enforcement', () => {
    it('C1. request creation for coherent target fails closed when eligibleDistinctSourceIdentityCount < 2', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic('corroborating')
      const ev = insertEvidence(m, src)
      insertMembership(topic, ev)
      const err = dockerPsqlExpectError(`select create_semantic_topic_lifecycle_review_request('${topic}'::uuid, 'coherent', '${nextMarker()}');`)
      expect(err).toMatch(/COHERENT_MINIMUM_NOT_MET/)
    })

    it('C2. decision RPC rejects a coherent approval missing any one of the four checklist fields', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await expect(
        recordDecisionAsReviewer({
          reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
          reasonCode: 'identity_consistency_confirmed', rationale: 'Missing one checklist field.',
          checklist: { a: true, b: true, c: true, d: false },
        }),
      ).rejects.toThrow(/all four structured checklist fields/)
    })

    it('C3. rationale alone (without the four checklist booleans) never substitutes for them', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await expect(
        recordDecisionAsReviewer({
          reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
          reasonCode: 'identity_consistency_confirmed', rationale: 'A very long, thorough, convincing rationale text that says everything is fine.',
        }),
      ).rejects.toThrow(/all four structured checklist fields/)
    })

    it('C4. ambiguous approval requires a reason_code from its own closed set, not the coherent one', async () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic('corroborating')
      const ev = insertEvidence(m, src)
      insertMembership(topic, ev)
      const created = createRequestAsService(topic, 'ambiguous', `${m}-req`)
      await expect(
        recordDecisionAsReviewer({
          reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
          reasonCode: 'identity_consistency_confirmed', rationale: 'Wrong reason code for this target.',
        }),
      ).rejects.toThrow(/ambiguous approval requires reason_code/)
    })
  })

  // ============================================================
  // D. Approval alone never transitions; executor transitions exactly once
  // ============================================================
  describe('D. approval-vs-execution separation, exactly-once execution', () => {
    it('D1. rejection never produces a transition event', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const decision = await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'rejected',
        reasonCode: 'insufficient_evidence', rationale: 'Not enough context to confirm identity yet.',
      })
      expect(decision.status).toBe('rejected')
      const err = dockerPsqlExpectError(`select execute_approved_semantic_topic_lifecycle_transition('${created.reviewRequestId}'::uuid, '${m}-exec');`)
      expect(err).toMatch(/REVIEW_REQUEST_NOT_EXECUTABLE/)
      expect(topicRow(topic).lifecycle_status).toBe('corroborating')
    })

    it('D2. executor status_version increments by exactly 1, replay returns the same result without a second transition event', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      const before = topicRow(topic)
      const first = executeAsService(created.reviewRequestId, `${m}-exec`)
      const after = topicRow(topic)
      expect(after.status_version).toBe(before.status_version + 1)

      const replay = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(replay.outcomeKind).toBe('replayed')
      const afterReplay = topicRow(topic)
      expect(afterReplay.status_version).toBe(after.status_version)
      const transitionCount = dockerPsql(`select count(*) from semantic_topic_lifecycle_transition_events where review_request_id='${created.reviewRequestId}';`).trim()
      expect(transitionCount).toBe('1')
    })
  })

  // ============================================================
  // E. Snapshot staleness and stale status_version
  // ============================================================
  describe('E. snapshot staleness and stale status_version', () => {
    it('E1. a new membership after request creation makes the snapshot stale, executor returns STALE_REVIEW_REQUEST', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      // A new membership arrives before execution -- changes the vector.
      const srcC = insertSource(`${m}-chanC`)
      const evC = insertEvidence(`${m}-c`, srcC)
      insertMembership(topic, evC)

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(false)
      expect(executed.reasonCode).toBe('STALE_REVIEW_REQUEST')
      expect(topicRow(topic).lifecycle_status).toBe('corroborating')
    })

    it('E2. an independently-advanced status_version (topic changed elsewhere) makes the executor fail closed with STALE_TOPIC_VERSION', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      // Bump status_version out from under the request (simulates an
      // independent concurrent write) without changing lifecycle_status.
      dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${topic}';`)
      const err = dockerPsqlExpectError(`select execute_approved_semantic_topic_lifecycle_transition('${created.reviewRequestId}'::uuid, '${m}-exec');`)
      expect(err).toMatch(/STALE_TOPIC_VERSION/)
    })
  })

  // ============================================================
  // F. Expiry -- persisted, no rollback-causing exception
  // ============================================================
  describe('F. expiry persists cleanly, no UPDATE-then-RAISE rollback bug', () => {
    it('F1. an expired request is persisted as expired and returns a normal {ok:false} on decision attempt', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      dockerPsql(`update semantic_topic_lifecycle_review_requests set expires_at = now() - interval '1 minute' where id='${created.reviewRequestId}';`)

      const decision = await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      expect(decision.ok).toBe(false)
      expect(decision.reasonCode).toBe('REQUEST_EXPIRED')

      // Persisted, not rolled back.
      const status = dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${created.reviewRequestId}';`).trim()
      expect(status).toBe('expired')
      const eventType = dockerPsql(`select event_type from semantic_topic_lifecycle_review_events where review_request_id='${created.reviewRequestId}' and event_type='expired';`).trim()
      expect(eventType).toBe('expired')
    })
  })

  // ============================================================
  // G. Idempotency and conflict
  // ============================================================
  describe('G. idempotent replay and same-key/different-payload conflict', () => {
    it('G1. create: same key + same payload replays; same key + different payload conflicts', () => {
      const m = nextMarker()
      const topicA = makeCorroboratingTopicWithTwoSources(m)
      const first = createRequestAsService(topicA, 'coherent', `${m}-req`)
      const replay = createRequestAsService(topicA, 'coherent', `${m}-req`)
      expect(replay.outcomeKind).toBe('replayed')
      expect(replay.reviewRequestId).toBe(first.reviewRequestId)

      const topicB = makeCorroboratingTopicWithTwoSources(`${m}-b`)
      const err = dockerPsqlExpectError(`select create_semantic_topic_lifecycle_review_request('${topicB}'::uuid, 'coherent', '${m}-req');`)
      expect(err).toMatch(/idempotency_key .* already used with different parameters/)
    })

    it('G2. only one requested request allowed per topic at a time', () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      createRequestAsService(topic, 'coherent', `${m}-req1`)
      const err = dockerPsqlExpectError(`select create_semantic_topic_lifecycle_review_request('${topic}'::uuid, 'ambiguous', '${m}-req2');`)
      expect(err).toMatch(/REQUEST_ALREADY_PENDING_FOR_TOPIC/)
    })

    it('G3. generation increments across successive requests for the same topic', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const first = createRequestAsService(topic, 'coherent', `${m}-req1`)
      expect(first.generation).toBe(1)
      await recordDecisionAsReviewer({
        reviewRequestId: first.reviewRequestId, decisionKey: `${m}-dec1`, outcome: 'rejected',
        reasonCode: 'not_ready_for_decision', rationale: 'Need more context first.',
      })
      const second = createRequestAsService(topic, 'coherent', `${m}-req2`)
      expect(second.generation).toBe(2)
    })

    it('G4. executor: same key + same payload replays; same key + different payload conflicts', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      executeAsService(created.reviewRequestId, `${m}-exec`)
      const replay = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(replay.outcomeKind).toBe('replayed')
      const err = dockerPsqlExpectError(`select execute_approved_semantic_topic_lifecycle_transition('${created.reviewRequestId}'::uuid, '${m}-exec-DIFFERENT');`)
      expect(err).toMatch(/already used with a different execution/)
    })
  })

  // ============================================================
  // H. Permission boundary
  // ============================================================
  describe('H. permission boundary', () => {
    it('H1. anon cannot call create_semantic_topic_lifecycle_review_request', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select create_semantic_topic_lifecycle_review_request('${randomUUID()}'::uuid, 'coherent', 'x'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('H2. authenticated cannot call create_semantic_topic_lifecycle_review_request', () => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; select create_semantic_topic_lifecycle_review_request('${randomUUID()}'::uuid, 'coherent', 'x'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('H3. authenticated cannot call execute_approved_semantic_topic_lifecycle_transition', () => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; select execute_approved_semantic_topic_lifecycle_transition('${randomUUID()}'::uuid, 'x'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('H4. anon cannot call execute_approved_semantic_topic_lifecycle_transition', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select execute_approved_semantic_topic_lifecycle_transition('${randomUUID()}'::uuid, 'x'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('H5. service_role cannot call record_semantic_topic_lifecycle_review_decision (reviewer-decision RPC requires an authenticated reviewer session, not raw service_role)', () => {
      const err = dockerPsqlExpectError(`SET ROLE service_role; select record_semantic_topic_lifecycle_review_decision('${randomUUID()}'::uuid, 'x', 'approved', 'identity_consistency_confirmed', 'r', true, true, true, true, 1); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('H6. anon cannot call record_semantic_topic_lifecycle_review_decision', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select record_semantic_topic_lifecycle_review_decision('${randomUUID()}'::uuid, 'x', 'approved', 'identity_consistency_confirmed', 'r', true, true, true, true, 1); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('H7. a non-reviewer authenticated user cannot record a decision', async () => {
      const email = `${nextMarker()}-nonreviewer@example.test`
      const password = `Test-${randomUUID()}-!Aa1`
      const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true })
      if (error || !data.user) throw new Error('failed to create non-reviewer fixture user')
      const nonReviewerClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
      await nonReviewerClient.auth.signInWithPassword({ email, password })
      try {
        const m = nextMarker()
        const topic = makeCorroboratingTopicWithTwoSources(m)
        const created = createRequestAsService(topic, 'coherent', `${m}-req`)
        const { error: rpcError } = await (nonReviewerClient as any).rpc('record_semantic_topic_lifecycle_review_decision', {
          p_review_request_id: created.reviewRequestId, p_decision_idempotency_key: `${m}-dec`, p_outcome: 'approved',
          p_reason_code: 'identity_consistency_confirmed', p_reviewer_rationale: 'x',
          p_same_semantic_identity_confirmed: true, p_no_material_identity_conflict: true,
          p_canonical_definition_scope_fit_confirmed: true, p_provenance_relationship_reviewed: true, p_review_policy_version: 1,
        })
        expect(rpcError).toBeTruthy()
        expect(rpcError!.message).toMatch(/not an active reviewer/)
      } finally {
        await adminClient.auth.admin.deleteUser(data.user.id)
      }
    })
    it('H8. no raw source identity, URL, external_ref, or credential appears in an RPC response', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const text = JSON.stringify(created)
      expect(text).not.toMatch(/example\.test/)
      expect(text).not.toMatch(/UC[0-9A-Za-z_-]{10,}/)
    })
  })

  // ============================================================
  // I. Cancel RPC
  // ============================================================
  describe('I. cancel_semantic_topic_lifecycle_review_request', () => {
    it('I1. a reviewer can cancel a requested request; a new request may then be created for the same topic', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const { data, error } = await (userClient as any).rpc('cancel_semantic_topic_lifecycle_review_request', {
        p_review_request_id: created.reviewRequestId, p_idempotency_key: `${m}-cancel`,
      })
      if (error) throw error
      expect(data.status).toBe('cancelled')
      const second = createRequestAsService(topic, 'ambiguous', `${m}-req2`)
      expect(second.ok).toBe(true)
    })

    it('I2. cancel does not silently overwrite/delete -- an approved request cannot be cancelled', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      const { error } = await (userClient as any).rpc('cancel_semantic_topic_lifecycle_review_request', {
        p_review_request_id: created.reviewRequestId, p_idempotency_key: `${m}-cancel`,
      })
      expect(error).toBeTruthy()
      expect(error!.message).toMatch(/REVIEW_REQUEST_NOT_CANCELLABLE/)
    })
  })

  // ============================================================
  // J. Static/structural + migration reapply/drift
  // ============================================================
  describe('J. static source guarantees and migration idempotency', () => {
    it('J1. 086 eligible-source helper and compute_topic_evidence_vector are untouched by 087', () => {
      const hash = dockerPsql(`select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public.compute_topic_evidence_vector(uuid)'::regprocedure;`).trim()
      expect(hash).toBe('73aeb37846bcc80fd42a4e2c8862dc7c')
      const helperHash = dockerPsql(`select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public._semantic_topic_eligible_membership_sources(uuid)'::regprocedure;`).trim()
      expect(helperHash).toBe('fba8af744970df7f93ba96fd71d2a939')
    })

    it('J2. reapplying 087 against an already-migrated DB is a clean no-op', () => {
      const r = runMigration(MIGRATION_087_PATH)
      expect(r.threw).toBe(false)
      expect(r.out).toMatch(/087: semantic_topic_lifecycle_review_requests already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: semantic_topic_lifecycle_review_events already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: semantic_topic_lifecycle_transition_events already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: create_semantic_topic_lifecycle_review_request already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: record_semantic_topic_lifecycle_review_decision already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: cancel_semantic_topic_lifecycle_review_request already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: execute_approved_semantic_topic_lifecycle_transition already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: final self-check passed/)
    })

    it('J3. an unrecognized executor body hash fails closed with no DDL, and is cleanly restorable', () => {
      const correctedStatement =
        'CREATE OR REPLACE FUNCTION public.execute_approved_semantic_topic_lifecycle_transition' +
        migrationSource.split('CREATE FUNCTION public.execute_approved_semantic_topic_lifecycle_transition')[1].split('$rpc$;')[0] +
        '$rpc$;'
      dockerPsql(`
        BEGIN;
        CREATE OR REPLACE FUNCTION public.execute_approved_semantic_topic_lifecycle_transition(
          p_review_request_id UUID, p_idempotency_key TEXT
        ) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $rpc$
        BEGIN
          RETURN jsonb_build_object('ok', true, 'tampered', true);
        END;
        $rpc$;
        COMMIT;
      `)
      const r = runMigration(MIGRATION_087_PATH)
      expect(r.threw).toBe(true)
      expect(r.out).toMatch(/087 fail-closed: execute_approved_semantic_topic_lifecycle_transition has 1 overloads|087 drift: execute_approved_semantic_topic_lifecycle_transition body hash does not match exactly/)

      dockerPsql(`BEGIN; ${correctedStatement} COMMIT;`)
      const restoredHash = dockerPsql(`select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public.execute_approved_semantic_topic_lifecycle_transition(uuid, text)'::regprocedure;`).trim()
      expect(restoredHash).toBe('a5edcd761ee5a9f7becdbab118d9b87d')
      const r2 = runMigration(MIGRATION_087_PATH)
      expect(r2.threw).toBe(false)
    })

    it('J4. no raw active-membership count(*) lifecycle trigger exists anywhere in 087 -- transitions are always human-review-gated, never mechanical', () => {
      expect(migrationSource).not.toMatch(/count\(\*\)\s+INTO\s+\w+\s+FROM\s+public\.semantic_topic_membership/i)
    })
  })
})
