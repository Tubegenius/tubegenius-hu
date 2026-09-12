// Semantic Topic Lifecycle Review Framework v1 -- migration 087
// (Contract Hardening Remediation), REAL local DB integration tests.
// Mirrors the established 077/078/086 pattern: local Docker Supabase
// stack, real GoTrue reviewer session for authenticated-RPC boundary
// proofs, SET ROLE for grant-boundary checks, only synthetic/
// deterministic fixtures -- no AI/provider call, no production data.
//
// No generated Supabase TypeScript Database types are version-
// controlled in this repo (confirmed by repo-wide audit) and there is
// no codegen script/CI step -- so `.rpc()` calls to 087's RPC names
// are not statically typed. Per the hardening gate's instruction, the
// resulting `as any` is narrowed to exactly ONE boundary (callRpc
// below), not scattered per call site.
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

// ── The ONE narrowed `as any` boundary for RPCs with no generated types. ──
// `client` is typed `any` here deliberately -- this function IS the
// single escape hatch from the generated-types gap (see doc comment
// at the top of this file), so its own parameter has nothing further
// to narrow against. Every call site still passes a real, fully-typed
// SupabaseClient; only this one signature widens it.
async function callRpc(client: any, fn: string, params: Record<string, unknown>): Promise<{ data: any; error: any }> {
  return client.rpc(fn, params)
}

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

// A topic with N distinct known sources (N=2 meets the mechanical
// source-diversity floor shared by coherent and corroborating targets).
function makeTopicWithNSources(m: string, lifecycleStatus: string, n: number): { topic: string; membershipIds: string[] } {
  const topic = insertTopic(lifecycleStatus)
  const membershipIds: string[] = []
  for (let i = 0; i < n; i++) {
    const src = insertSource(`${m}-chan${i}`)
    const ev = insertEvidence(`${m}-${i}`, src)
    membershipIds.push(insertMembership(topic, ev))
  }
  return { topic, membershipIds }
}
function makeCorroboratingTopicWithTwoSources(m: string): string {
  return makeTopicWithNSources(m, 'corroborating', 2).topic
}
// Soft-invalidates one membership row (valid_to := now()) -- excludes it
// from the eligible set without violating any schema constraint, the
// only DML-reachable way to drop eligibleDistinctSourceIdentityCount by
// exactly one under the current schema (assignment_reason/evidence_type
// integrity fields are all CHECK-guaranteed-complete for fresh inserts,
// so a source-count-drop is the only mechanical-minimum failure mode
// reachable post-creation via valid DML).
function invalidateMembership(membershipId: string) {
  dockerPsql(`update semantic_topic_membership set valid_to = now() where id='${membershipId}';`)
}

function topicRow(topicId: string): { lifecycle_status: string; status_version: number } {
  const out = dockerPsql(`select lifecycle_status || '|' || status_version from semantic_topics where id='${topicId}';`).trim()
  const [lifecycle_status, sv] = out.split('|')
  return { lifecycle_status, status_version: Number(sv) }
}
function requestRow(reviewRequestId: string): { status: string; stale_reason_code: string | null } {
  const out = dockerPsql(`select status || '|' || coalesce(stale_reason_code, '<null>') from semantic_topic_lifecycle_review_requests where id='${reviewRequestId}';`).trim()
  const [status, staleReasonCode] = out.split('|')
  return { status, stale_reason_code: staleReasonCode === '<null>' ? null : staleReasonCode }
}
function eventCount(reviewRequestId: string, eventType: string): number {
  return Number(dockerPsql(`select count(*) from semantic_topic_lifecycle_review_events where review_request_id='${reviewRequestId}' and event_type='${eventType}';`).trim())
}
function transitionEventCount(reviewRequestId: string): number {
  return Number(dockerPsql(`select count(*) from semantic_topic_lifecycle_transition_events where review_request_id='${reviewRequestId}';`).trim())
}

function createRequestAsService(topicId: string, targetStatus: string, idemKey: string): any {
  return JSON.parse(dockerPsql(`select create_semantic_topic_lifecycle_review_request('${topicId}'::uuid, '${targetStatus}', '${idemKey}');`).trim())
}
function executeAsService(reviewRequestId: string, idemKey: string): any {
  return JSON.parse(dockerPsql(`select execute_approved_semantic_topic_lifecycle_transition('${reviewRequestId}'::uuid, '${idemKey}');`).trim())
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
  client?: any
}) {
  const c = params.checklist
  const { data, error } = await callRpc(params.client ?? userClient, 'record_semantic_topic_lifecycle_review_decision', {
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

async function cancelAsReviewer(params: {
  reviewRequestId: string
  idemKey: string
  cancelReasonCode: string
  cancelRationale: string
  client?: any
}) {
  return callRpc(params.client ?? userClient, 'cancel_semantic_topic_lifecycle_review_request', {
    p_review_request_id: params.reviewRequestId,
    p_idempotency_key: params.idemKey,
    p_cancel_reason_code: params.cancelReasonCode,
    p_cancel_rationale: params.cancelRationale,
  })
}

describeIfLocalDb('Semantic Topic Lifecycle Review Framework v1 -- 087 (real local DB, post-hardening-remediation)', () => {
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

    it('A3. ambiguous -> corroborating, full success path (mechanical floor now ALSO enforced for corroborating)', async () => {
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
  // C. Mechanical source-diversity minimum at request-creation time --
  //    now enforced for BOTH coherent and corroborating targets, via
  //    the single shared _semantic_topic_lifecycle_mechanical_check
  //    helper. Failures are normal {ok:false,reasonCode} returns, not
  //    exceptions -- these are closed business outcomes, not errors.
  // ============================================================
  describe('C. mechanical source-diversity minimum -- coherent AND corroborating targets', () => {
    it('C1. coherent target: 1 known source fails closed with INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES (normal return, not an exception)', () => {
      const m = nextMarker()
      const { topic } = makeTopicWithNSources(m, 'corroborating', 1)
      const result = createRequestAsService(topic, 'coherent', `${m}-req`)
      expect(result.ok).toBe(false)
      expect(result.reasonCode).toBe('INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES')
    })
    it('C2. coherent target: 2 known sources passes the mechanical minimum', () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const result = createRequestAsService(topic, 'coherent', `${m}-req`)
      expect(result.ok).toBe(true)
    })
    it('C3. corroborating target (ambiguous->corroborating): 0 known sources fails closed with INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES', () => {
      const m = nextMarker()
      const topic = insertTopic('ambiguous')
      const result = createRequestAsService(topic, 'corroborating', `${m}-req`)
      expect(result.ok).toBe(false)
      expect(result.reasonCode).toBe('INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES')
    })
    it('C4. corroborating target (ambiguous->corroborating): 1 known source fails closed with INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES', () => {
      const m = nextMarker()
      const { topic } = makeTopicWithNSources(m, 'ambiguous', 1)
      const result = createRequestAsService(topic, 'corroborating', `${m}-req`)
      expect(result.ok).toBe(false)
      expect(result.reasonCode).toBe('INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES')
    })
    it('C5. corroborating target (ambiguous->corroborating): 2 known sources passes the mechanical minimum', () => {
      const m = nextMarker()
      const { topic } = makeTopicWithNSources(m, 'ambiguous', 2)
      const result = createRequestAsService(topic, 'corroborating', `${m}-req`)
      expect(result.ok).toBe(true)
    })
    it('C6. ambiguous target has NO mechanical floor even with 0 known sources', () => {
      const m = nextMarker()
      const topic = insertTopic('corroborating')
      const result = createRequestAsService(topic, 'ambiguous', `${m}-req`)
      expect(result.ok).toBe(true)
    })
  })

  // ============================================================
  // D. Coherent structured checklist enforcement (decision RPC)
  // ============================================================
  describe('D. coherent structured checklist enforcement', () => {
    it('D1. decision RPC rejects a coherent approval missing any one of the four checklist fields', async () => {
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
    it('D2. rationale alone (without the four checklist booleans) never substitutes for them', async () => {
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
    it('D3. ambiguous approval requires a reason_code from its own closed set, not the coherent one', async () => {
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
  // E. Approval alone never transitions; executor transitions exactly once
  // ============================================================
  describe('E. approval-vs-execution separation, exactly-once execution', () => {
    it('E1. rejection never produces a transition event', async () => {
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
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('E2. executor status_version increments by exactly 1, replay returns the same result without a second transition event', async () => {
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
      expect(transitionEventCount(created.reviewRequestId)).toBe(1)
    })
  })

  // ============================================================
  // F. Staleness detection -- fixed-priority chain, PERSISTED (never
  //    UPDATE-then-RAISE), replayable, never mutates the topic.
  // ============================================================
  describe('F. staleness detection: persisted, prioritized, replayable, never mutates the topic', () => {
    it('F1. TOPIC_STATE_CHANGED has top priority -- an independently-changed lifecycle_status makes the executor persist stale (not throw)', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      // Simulates an independent concurrent transition having already
      // changed the topic's lifecycle_status out from under this request.
      dockerPsql(`update semantic_topics set lifecycle_status='ambiguous' where id='${topic}';`)

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(false)
      expect(executed.reasonCode).toBe('STALE_REVIEW_REQUEST')
      expect(executed.staleReasonCode).toBe('TOPIC_STATE_CHANGED')
      const row = requestRow(created.reviewRequestId)
      expect(row.status).toBe('stale')
      expect(row.stale_reason_code).toBe('TOPIC_STATE_CHANGED')
      expect(eventCount(created.reviewRequestId, 'stale')).toBe(1)
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('F2. TOPIC_VERSION_CHANGED -- an independently-advanced status_version (same lifecycle_status) makes the executor persist stale', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${topic}';`)

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(false)
      expect(executed.reasonCode).toBe('STALE_REVIEW_REQUEST')
      expect(executed.staleReasonCode).toBe('TOPIC_VERSION_CHANGED')
      expect(requestRow(created.reviewRequestId).status).toBe('stale')
      expect(eventCount(created.reviewRequestId, 'stale')).toBe(1)
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('F3. a new membership after request creation changes the digest but still passes the mechanical minimum -- generic EVIDENCE_VECTOR_CHANGED stale', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      const srcC = insertSource(`${m}-chanC`)
      const evC = insertEvidence(`${m}-c`, srcC)
      insertMembership(topic, evC)

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(false)
      expect(executed.reasonCode).toBe('STALE_REVIEW_REQUEST')
      expect(executed.staleReasonCode).toBe('EVIDENCE_VECTOR_CHANGED')
      expect(topicRow(topic).lifecycle_status).toBe('corroborating')
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('F4. request-time-OK, executor-time source-count-drop (coherent target) -- persisted stale with INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES', async () => {
      const m = nextMarker()
      const { topic, membershipIds } = makeTopicWithNSources(m, 'corroborating', 2)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      expect(created.ok).toBe(true)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      // Drops the topic from 2 to 1 known source AFTER approval, before execution.
      invalidateMembership(membershipIds[0])

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(false)
      expect(executed.reasonCode).toBe('STALE_REVIEW_REQUEST')
      expect(executed.staleReasonCode).toBe('INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES')
      expect(topicRow(topic).lifecycle_status).toBe('corroborating')
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('F5. request-time-OK, executor-time source-count-drop (corroborating target) -- persisted stale with INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES', async () => {
      const m = nextMarker()
      const { topic, membershipIds } = makeTopicWithNSources(m, 'ambiguous', 2)
      const created = createRequestAsService(topic, 'corroborating', `${m}-req`)
      expect(created.ok).toBe(true)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'suspicion_unfounded', rationale: 'Confirmed unfounded.',
      })
      invalidateMembership(membershipIds[0])

      const executed = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(executed.ok).toBe(false)
      expect(executed.reasonCode).toBe('STALE_REVIEW_REQUEST')
      expect(executed.staleReasonCode).toBe('INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES')
      expect(topicRow(topic).lifecycle_status).toBe('ambiguous')
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('F6. stale replay (same execution idempotency key) returns the same closed stale result WITHOUT creating a second stale event or re-mutating anything', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${topic}';`)

      const first = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(first.ok).toBe(false)
      expect(first.reasonCode).toBe('STALE_REVIEW_REQUEST')
      expect(eventCount(created.reviewRequestId, 'stale')).toBe(1)

      const replay = executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(replay.ok).toBe(false)
      expect(replay.outcomeKind).toBe('replayed')
      expect(replay.reasonCode).toBe('STALE_REVIEW_REQUEST')
      expect(replay.staleReasonCode).toBe('TOPIC_VERSION_CHANGED')
      expect(eventCount(created.reviewRequestId, 'stale')).toBe(1)
      expect(requestRow(created.reviewRequestId).status).toBe('stale')

      const err = dockerPsqlExpectError(`select execute_approved_semantic_topic_lifecycle_transition('${created.reviewRequestId}'::uuid, '${m}-exec-DIFFERENT');`)
      expect(err).toMatch(/already used with a different execution attempt/)
    })
  })

  // ============================================================
  // G. Expiry -- persisted, no rollback-causing exception
  // ============================================================
  describe('G. expiry persists cleanly, no UPDATE-then-RAISE rollback bug', () => {
    it('G1. an expired request is persisted as expired and returns a normal {ok:false} on decision attempt; no transition event ever', async () => {
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

      const status = dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${created.reviewRequestId}';`).trim()
      expect(status).toBe('expired')
      expect(eventCount(created.reviewRequestId, 'expired')).toBe(1)
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })
  })

  // ============================================================
  // H. Idempotency and actionable-uniqueness (widened to requested+approved)
  // ============================================================
  describe('H. idempotent replay, same-key/different-payload conflict, and actionable uniqueness', () => {
    it('H1. create: same key + same payload replays; same key + different payload conflicts', () => {
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

    it('H2. only one ACTIONABLE (requested OR approved) request allowed per topic at a time -- normal {ok:false} return, not an exception', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      createRequestAsService(topic, 'coherent', `${m}-req1`)
      const whileRequested = createRequestAsService(topic, 'ambiguous', `${m}-req2`)
      expect(whileRequested.ok).toBe(false)
      expect(whileRequested.reasonCode).toBe('REQUEST_ALREADY_ACTIONABLE_FOR_TOPIC')
    })

    it('H3. a request that has been APPROVED (not yet executed) also blocks a new request for the same topic', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req1`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      const whileApproved = createRequestAsService(topic, 'ambiguous', `${m}-req2`)
      expect(whileApproved.ok).toBe(false)
      expect(whileApproved.reasonCode).toBe('REQUEST_ALREADY_ACTIONABLE_FOR_TOPIC')
    })

    it('H4. generation increments across successive requests for the same topic', async () => {
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

    it('H5. executor: same key + same payload replays; same key + different payload conflicts', async () => {
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

    it('H6. the "one actionable per topic" partial unique index applies EXACTLY to (requested, approved) and to no other status', () => {
      const idxDef = dockerPsql(
        `select indexdef from pg_indexes where schemaname='public' and tablename='semantic_topic_lifecycle_review_requests' and indexname='idx_sltrr_one_actionable_per_topic';`,
      ).trim()
      expect(idxDef).toMatch(/UNIQUE INDEX idx_sltrr_one_actionable_per_topic ON public\.semantic_topic_lifecycle_review_requests USING btree \(semantic_topic_id\) WHERE \(status = ANY \(ARRAY\['requested'::text, 'approved'::text\]\)\)/)
    })

    it('H7. two genuinely concurrent create calls for the same topic (different idempotency keys) -- exactly one is created, the other is REQUEST_ALREADY_ACTIONABLE_FOR_TOPIC', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const [r1, r2] = await Promise.all([
        callRpc(adminClient, 'create_semantic_topic_lifecycle_review_request', { p_semantic_topic_id: topic, p_target_status: 'coherent', p_idempotency_key: `${m}-reqA` }),
        callRpc(adminClient, 'create_semantic_topic_lifecycle_review_request', { p_semantic_topic_id: topic, p_target_status: 'ambiguous', p_idempotency_key: `${m}-reqB` }),
      ])
      expect(r1.error).toBeFalsy()
      expect(r2.error).toBeFalsy()
      const outcomes = [r1.data.ok, r2.data.ok].sort()
      expect(outcomes).toEqual([false, true])
      const rejected = r1.data.ok ? r2.data : r1.data
      expect(rejected.reasonCode).toBe('REQUEST_ALREADY_ACTIONABLE_FOR_TOPIC')
      const liveCount = dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests where semantic_topic_id='${topic}' and status IN ('requested','approved');`).trim()
      expect(liveCount).toBe('1')
    })
  })

  // ============================================================
  // I. Permission boundary
  // ============================================================
  describe('I. permission boundary', () => {
    it('I1. anon cannot call create_semantic_topic_lifecycle_review_request', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select create_semantic_topic_lifecycle_review_request('${randomUUID()}'::uuid, 'coherent', 'x'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('I2. authenticated cannot call create_semantic_topic_lifecycle_review_request', () => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; select create_semantic_topic_lifecycle_review_request('${randomUUID()}'::uuid, 'coherent', 'x'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('I3. authenticated cannot call execute_approved_semantic_topic_lifecycle_transition', () => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; select execute_approved_semantic_topic_lifecycle_transition('${randomUUID()}'::uuid, 'x'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('I4. anon cannot call execute_approved_semantic_topic_lifecycle_transition', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select execute_approved_semantic_topic_lifecycle_transition('${randomUUID()}'::uuid, 'x'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('I5. service_role cannot call record_semantic_topic_lifecycle_review_decision (reviewer-decision RPC requires an authenticated reviewer session, not raw service_role)', () => {
      const err = dockerPsqlExpectError(`SET ROLE service_role; select record_semantic_topic_lifecycle_review_decision('${randomUUID()}'::uuid, 'x', 'approved', 'identity_consistency_confirmed', 'r', true, true, true, true, 1); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('I6. anon cannot call record_semantic_topic_lifecycle_review_decision', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select record_semantic_topic_lifecycle_review_decision('${randomUUID()}'::uuid, 'x', 'approved', 'identity_consistency_confirmed', 'r', true, true, true, true, 1); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('I7. anon cannot call cancel_semantic_topic_lifecycle_review_request', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select cancel_semantic_topic_lifecycle_review_request('${randomUUID()}'::uuid, 'x', 'REVIEW_WITHDRAWN', 'r'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('I8. service_role cannot call cancel_semantic_topic_lifecycle_review_request', () => {
      const err = dockerPsqlExpectError(`SET ROLE service_role; select cancel_semantic_topic_lifecycle_review_request('${randomUUID()}'::uuid, 'x', 'REVIEW_WITHDRAWN', 'r'); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('I9. a non-reviewer authenticated user cannot record a decision', async () => {
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
        const { error: rpcError } = await callRpc(nonReviewerClient, 'record_semantic_topic_lifecycle_review_decision', {
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
    it('I10. a non-reviewer authenticated user cannot cancel a request', async () => {
      const email = `${nextMarker()}-nonreviewer2@example.test`
      const password = `Test-${randomUUID()}-!Aa1`
      const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true })
      if (error || !data.user) throw new Error('failed to create non-reviewer fixture user')
      const nonReviewerClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
      await nonReviewerClient.auth.signInWithPassword({ email, password })
      try {
        const m = nextMarker()
        const topic = makeCorroboratingTopicWithTwoSources(m)
        const created = createRequestAsService(topic, 'coherent', `${m}-req`)
        const { error: rpcError } = await cancelAsReviewer({
          reviewRequestId: created.reviewRequestId, idemKey: `${m}-cancel`,
          cancelReasonCode: 'REVIEW_WITHDRAWN', cancelRationale: 'x', client: nonReviewerClient,
        })
        expect(rpcError).toBeTruthy()
        expect(rpcError!.message).toMatch(/not an active reviewer/)
      } finally {
        await adminClient.auth.admin.deleteUser(data.user.id)
      }
    })
    it('I11. no raw source identity, URL, external_ref, or credential appears in an RPC response', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const text = JSON.stringify(created)
      expect(text).not.toMatch(/example\.test/)
      expect(text).not.toMatch(/UC[0-9A-Za-z_-]{10,}/)
    })
  })

  // ============================================================
  // J. cancel_semantic_topic_lifecycle_review_request -- now reachable
  //    from BOTH requested and approved, requires a closed reason code
  //    plus mandatory rationale.
  // ============================================================
  describe('J. cancel_semantic_topic_lifecycle_review_request (requested OR approved, audited)', () => {
    it('J1. a reviewer can cancel a REQUESTED request; a new request may then be created for the same topic', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const { data, error } = await cancelAsReviewer({
        reviewRequestId: created.reviewRequestId, idemKey: `${m}-cancel`,
        cancelReasonCode: 'REVIEW_WITHDRAWN', cancelRationale: 'The requester withdrew the review.',
      })
      if (error) throw error
      expect(data.status).toBe('cancelled')
      const second = createRequestAsService(topic, 'ambiguous', `${m}-req2`)
      expect(second.ok).toBe(true)
    })

    it('J2. a reviewer can cancel an APPROVED (not yet executed) request; a new request may then be created for the same topic', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      const { data, error } = await cancelAsReviewer({
        reviewRequestId: created.reviewRequestId, idemKey: `${m}-cancel`,
        cancelReasonCode: 'NEW_EVIDENCE_REQUIRES_NEW_REVIEW', cancelRationale: 'New evidence arrived; this decision needs to be redone.',
      })
      if (error) throw error
      expect(data.status).toBe('cancelled')
      expect(topicRow(topic).lifecycle_status).toBe('corroborating')
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)

      const second = createRequestAsService(topic, 'ambiguous', `${m}-req2`)
      expect(second.ok).toBe(true)
      expect(second.generation).toBe(2)
    })

    it('J3. an EXECUTED request can never be cancelled', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      executeAsService(created.reviewRequestId, `${m}-exec`)
      const { error } = await cancelAsReviewer({
        reviewRequestId: created.reviewRequestId, idemKey: `${m}-cancel`,
        cancelReasonCode: 'REVIEW_WITHDRAWN', cancelRationale: 'Too late.',
      })
      expect(error).toBeTruthy()
      expect(error!.message).toMatch(/REVIEW_REQUEST_NOT_CANCELLABLE/)
    })

    it('J4. cancel_reason_code must be one of the closed dictionary values', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const { error } = await cancelAsReviewer({
        reviewRequestId: created.reviewRequestId, idemKey: `${m}-cancel`,
        cancelReasonCode: 'NOT_A_REAL_REASON', cancelRationale: 'x',
      })
      expect(error).toBeTruthy()
      expect(error!.message).toMatch(/p_cancel_reason_code must be a closed cancel reason/)
    })

    it('J5. cancel_rationale is mandatory (empty rationale rejected)', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const { error } = await cancelAsReviewer({
        reviewRequestId: created.reviewRequestId, idemKey: `${m}-cancel`,
        cancelReasonCode: 'REVIEW_WITHDRAWN', cancelRationale: '',
      })
      expect(error).toBeTruthy()
      expect(error!.message).toMatch(/p_cancel_rationale is required/)
    })

    it('J6. cancel is idempotent: same key replays; same key with different parameters conflicts', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const first = await cancelAsReviewer({
        reviewRequestId: created.reviewRequestId, idemKey: `${m}-cancel`,
        cancelReasonCode: 'REVIEW_WITHDRAWN', cancelRationale: 'Withdrawn.',
      })
      expect(first.error).toBeFalsy()
      const replay = await cancelAsReviewer({
        reviewRequestId: created.reviewRequestId, idemKey: `${m}-cancel`,
        cancelReasonCode: 'REVIEW_WITHDRAWN', cancelRationale: 'Withdrawn.',
      })
      expect(replay.error).toBeFalsy()
      expect(replay.data.outcomeKind).toBe('replayed')
      const conflict = await cancelAsReviewer({
        reviewRequestId: created.reviewRequestId, idemKey: `${m}-cancel`,
        cancelReasonCode: 'REQUEST_CREATED_IN_ERROR', cancelRationale: 'Different reason.',
      })
      expect(conflict.error).toBeTruthy()
      expect(conflict.error!.message).toMatch(/already used with different parameters/)
    })
  })

  // ============================================================
  // K. Genuine concurrency -- exactly one winner, deterministic loser
  // ============================================================
  describe('K. genuine concurrency (real parallel HTTP requests, not merely sequential calls)', () => {
    it('K1. two concurrent decisions on the same review request -- exactly one succeeds, the other is rejected as already-decided', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const [r1, r2] = await Promise.allSettled([
        recordDecisionAsReviewer({
          reviewRequestId: created.reviewRequestId, decisionKey: `${m}-decA`, outcome: 'approved',
          reasonCode: 'identity_consistency_confirmed', rationale: 'First caller.', checklist: { a: true, b: true, c: true, d: true },
        }),
        recordDecisionAsReviewer({
          reviewRequestId: created.reviewRequestId, decisionKey: `${m}-decB`, outcome: 'rejected',
          reasonCode: 'not_ready_for_decision', rationale: 'Second caller.',
        }),
      ])
      const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled')
      const rejected = [r1, r2].filter((r) => r.status === 'rejected')
      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already decided with different parameters/)
      const decisionCount = dockerPsql(
        `select count(*) from semantic_topic_lifecycle_review_events where review_request_id='${created.reviewRequestId}' and event_type IN ('approved','rejected');`,
      ).trim()
      expect(decisionCount).toBe('1')
    })

    it('K2. two concurrent executions of the same approved request -- exactly one executes, the other is rejected as already-used-with-different-execution', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordDecisionAsReviewer({
        reviewRequestId: created.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
        reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
      })
      const [r1, r2] = await Promise.all([
        callRpc(adminClient, 'execute_approved_semantic_topic_lifecycle_transition', { p_review_request_id: created.reviewRequestId, p_idempotency_key: `${m}-execA` }),
        callRpc(adminClient, 'execute_approved_semantic_topic_lifecycle_transition', { p_review_request_id: created.reviewRequestId, p_idempotency_key: `${m}-execB` }),
      ])
      const errors = [r1.error, r2.error].filter(Boolean)
      const successes = [r1.data, r2.data].filter((d) => d && d.ok)
      expect(errors.length).toBe(1)
      expect(successes.length).toBe(1)
      expect(errors[0]!.message).toMatch(/already used with a different execution attempt/)
      expect(transitionEventCount(created.reviewRequestId)).toBe(1)
      expect(topicRow(topic).status_version).toBe(2)
    })
  })

  // ============================================================
  // L. Static/structural + migration reapply/drift (schema fingerprint
  //    and RPC grant/body-hash fail-closed catalog comparison)
  // ============================================================
  describe('L. static source guarantees and migration idempotency', () => {
    it('L1. 086 eligible-source helper and compute_topic_evidence_vector are untouched by 087', () => {
      const hash = dockerPsql(`select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public.compute_topic_evidence_vector(uuid)'::regprocedure;`).trim()
      expect(hash).toBe('73aeb37846bcc80fd42a4e2c8862dc7c')
      const helperHash = dockerPsql(`select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public._semantic_topic_eligible_membership_sources(uuid)'::regprocedure;`).trim()
      expect(helperHash).toBe('fba8af744970df7f93ba96fd71d2a939')
    })

    it('L2. reapplying 087 against an already-migrated DB is a clean no-op', () => {
      const r = runMigration(MIGRATION_087_PATH)
      expect(r.threw).toBe(false)
      expect(r.out).toMatch(/087: semantic_topic_lifecycle_review_requests already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: semantic_topic_lifecycle_review_events already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: semantic_topic_lifecycle_transition_events already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: _semantic_topic_lifecycle_mechanical_check already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: create_semantic_topic_lifecycle_review_request already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: record_semantic_topic_lifecycle_review_decision already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: cancel_semantic_topic_lifecycle_review_request already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: execute_approved_semantic_topic_lifecycle_transition already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/087: final self-check passed/)
    })

    it('L3. an unrecognized executor body hash fails closed with no DDL, and is cleanly restorable', () => {
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
      expect(r.out).toMatch(/087 drift: execute_approved_semantic_topic_lifecycle_transition body hash does not match exactly/)

      dockerPsql(`BEGIN; ${correctedStatement} COMMIT;`)
      const restoredHash = dockerPsql(`select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public.execute_approved_semantic_topic_lifecycle_transition(uuid, text)'::regprocedure;`).trim()
      expect(restoredHash).toBe('6c12de4cef728e046490645c0ce3b057')
      const r2 = runMigration(MIGRATION_087_PATH)
      expect(r2.threw).toBe(false)
    })

    it('L4. an unauthorized column addition to semantic_topic_lifecycle_review_requests fails closed on reapply (column fingerprint), and reverting restores a clean idempotent reapply', () => {
      dockerPsql(`ALTER TABLE public.semantic_topic_lifecycle_review_requests ADD COLUMN drift_probe TEXT;`)
      const r = runMigration(MIGRATION_087_PATH)
      expect(r.threw).toBe(true)
      expect(r.out).toMatch(/087 drift: semantic_topic_lifecycle_review_requests column fingerprint mismatch/)

      dockerPsql(`ALTER TABLE public.semantic_topic_lifecycle_review_requests DROP COLUMN drift_probe;`)
      const r2 = runMigration(MIGRATION_087_PATH)
      expect(r2.threw).toBe(false)
      expect(r2.out).toMatch(/087: final self-check passed/)
    })

    it('L5. dropping a CHECK constraint on semantic_topic_lifecycle_review_events fails closed on reapply (constraint fingerprint), and restoring the exact original definition heals it', () => {
      dockerPsql(`ALTER TABLE public.semantic_topic_lifecycle_review_events DROP CONSTRAINT sltre_policy_version_positive;`)
      const r = runMigration(MIGRATION_087_PATH)
      expect(r.threw).toBe(true)
      expect(r.out).toMatch(/087 drift: semantic_topic_lifecycle_review_events constraint fingerprint mismatch/)

      dockerPsql(`ALTER TABLE public.semantic_topic_lifecycle_review_events ADD CONSTRAINT sltre_policy_version_positive CHECK (policy_version >= 1);`)
      const r2 = runMigration(MIGRATION_087_PATH)
      expect(r2.threw).toBe(false)
      expect(r2.out).toMatch(/087: final self-check passed/)
    })

    it('L6. dropping an index on semantic_topic_lifecycle_transition_events fails closed on reapply (index fingerprint), and recreating the exact original definition heals it', () => {
      dockerPsql(`DROP INDEX public.idx_sltte_topic;`)
      const r = runMigration(MIGRATION_087_PATH)
      expect(r.threw).toBe(true)
      expect(r.out).toMatch(/087 drift: semantic_topic_lifecycle_transition_events index fingerprint mismatch/)

      dockerPsql(`CREATE INDEX idx_sltte_topic ON public.semantic_topic_lifecycle_transition_events (semantic_topic_id);`)
      const r2 = runMigration(MIGRATION_087_PATH)
      expect(r2.threw).toBe(false)
      expect(r2.out).toMatch(/087: final self-check passed/)
    })

    it('L7. revoking the authenticated EXECUTE grant on cancel_semantic_topic_lifecycle_review_request fails closed on reapply (ACL drift), and re-granting heals it', () => {
      dockerPsql(`REVOKE EXECUTE ON FUNCTION public.cancel_semantic_topic_lifecycle_review_request(UUID, TEXT, TEXT, TEXT) FROM authenticated;`)
      const r = runMigration(MIGRATION_087_PATH)
      expect(r.threw).toBe(true)
      expect(r.out).toMatch(/087 drift: cancel_semantic_topic_lifecycle_review_request ACL does not match exactly/)

      dockerPsql(`GRANT EXECUTE ON FUNCTION public.cancel_semantic_topic_lifecycle_review_request(UUID, TEXT, TEXT, TEXT) TO authenticated;`)
      const r2 = runMigration(MIGRATION_087_PATH)
      expect(r2.threw).toBe(false)
      expect(r2.out).toMatch(/087: final self-check passed/)
    })

    it('L8. no raw active-membership count(*) lifecycle trigger exists anywhere in 087 -- transitions are always human-review-gated, never mechanical', () => {
      expect(migrationSource).not.toMatch(/count\(\*\)\s+INTO\s+\w+\s+FROM\s+public\.semantic_topic_membership/i)
    })

    it('L9. every RPC call in this file goes through the single callRpc() boundary -- no scattered direct `.rpc(` call sites', () => {
      const thisFileSource = readFileSync(__filename, 'utf8')
      // Sliced to exclude this very test's own source (its comment and
      // string-literal assertion below would otherwise self-match).
      const sourceBeforeThisTest = thisFileSource.slice(0, thisFileSource.indexOf("it('L9."))
      const directRpcCallSites = sourceBeforeThisTest.match(/\w+\.rpc\(/g) ?? []
      expect(directRpcCallSites).toEqual(['client.rpc('])
    })
  })
})
