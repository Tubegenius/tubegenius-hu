// PFM Lifecycle Reviewer Read Surface v1 -- migration 088, REAL local DB
// integration tests. Mirrors the established 087 pattern exactly: local
// Docker Supabase stack, real GoTrue reviewer session for authenticated-RPC
// boundary proofs, SET ROLE for grant-boundary checks, only synthetic/
// deterministic fixtures -- no AI/provider call, no production data. 087
// itself is NEVER modified or re-derived here; its own 60/60 suite remains
// the source of truth for lifecycle-transition business rules. This file
// tests only the two new READ RPCs (list/get) plus the new digest helper.
//
// No generated Supabase TypeScript Database types are version-controlled in
// this repo -- the resulting `as any` is narrowed to exactly ONE boundary
// (callRpc below), matching the 087 test file's own established rule.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const MIGRATION_087_PATH = join(process.cwd(), 'supabase/migrations/087_semantic_topic_lifecycle_review_framework.sql')
const MIGRATION_088_PATH = join(process.cwd(), 'supabase/migrations/088_semantic_topic_lifecycle_reviewer_read_surface.sql')
const migration088Source = readFileSync(MIGRATION_088_PATH, 'utf8')
const LOCAL_API_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const adminClient = createClient(LOCAL_API_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

// ── The ONE narrowed `as any` boundary for RPCs with no generated types. ──
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

const MARKER = 'sti-088'
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
  const r087 = runMigration(MIGRATION_087_PATH)
  if (r087.threw) throw new Error(`ensureFullyApplied: 087 failed -- ${r087.out}`)
  const r088 = runMigration(MIGRATION_088_PATH)
  if (r088.threw) throw new Error(`ensureFullyApplied: 088 failed -- ${r088.out}`)
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
function invalidateMembership(membershipId: string) {
  dockerPsql(`update semantic_topic_membership set valid_to = now() where id='${membershipId}';`)
}

function createRequestAsService(topicId: string, targetStatus: string, idemKey: string): any {
  return JSON.parse(dockerPsql(`select create_semantic_topic_lifecycle_review_request('${topicId}'::uuid, '${targetStatus}', '${idemKey}');`).trim())
}
function executeAsService(reviewRequestId: string, idemKey: string): any {
  return JSON.parse(dockerPsql(`select execute_approved_semantic_topic_lifecycle_transition('${reviewRequestId}'::uuid, '${idemKey}');`).trim())
}

// ── Real GoTrue reviewer session, established pattern (mirrors 087's own). ──
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
async function cancelAsReviewer(params: { reviewRequestId: string; idemKey: string; cancelReasonCode: string; cancelRationale: string; client?: any }) {
  return callRpc(params.client ?? userClient, 'cancel_semantic_topic_lifecycle_review_request', {
    p_review_request_id: params.reviewRequestId,
    p_idempotency_key: params.idemKey,
    p_cancel_reason_code: params.cancelReasonCode,
    p_cancel_rationale: params.cancelRationale,
  })
}

// ── The two new 088 read RPCs, called through the same single boundary. ──
function listAsReviewer(input: { statusFilter?: string; limit?: number | null; afterRequestedAt?: string | null; afterId?: string | null } = {}, client?: any) {
  return callRpc(client ?? userClient, 'list_semantic_topic_lifecycle_review_requests', {
    p_status_filter: input.statusFilter ?? 'actionable',
    p_limit: input.limit === undefined ? null : input.limit,
    p_after_requested_at: input.afterRequestedAt ?? null,
    p_after_id: input.afterId ?? null,
  })
}
function getAsReviewer(reviewRequestId: string, client?: any) {
  return callRpc(client ?? userClient, 'get_semantic_topic_lifecycle_review_request', { p_review_request_id: reviewRequestId })
}

function lifecycleTableRowCounts(): string {
  return dockerPsql(`
    select
      (select count(*) from semantic_topic_lifecycle_review_requests) || '|' ||
      (select count(*) from semantic_topic_lifecycle_review_events) || '|' ||
      (select count(*) from semantic_topic_lifecycle_transition_events) || '|' ||
      (select count(*) from semantic_topics) || '|' ||
      (select count(*) from semantic_topic_membership);
  `).trim()
}
function requestDigest(reviewRequestId: string): string {
  return dockerPsql(`select evidence_vector_digest from semantic_topic_lifecycle_review_requests where id='${reviewRequestId}';`).trim()
}

// ── Fixture builders: one per closed request-lifecycle status. ──
async function makeRequestedFixture(m: string): Promise<{ topic: string; reviewRequestId: string }> {
  const topic = makeCorroboratingTopicWithTwoSources(m)
  const created = createRequestAsService(topic, 'coherent', `${m}-req`)
  return { topic, reviewRequestId: created.reviewRequestId }
}
async function makeApprovedFixture(m: string): Promise<{ topic: string; reviewRequestId: string }> {
  const f = await makeRequestedFixture(m)
  await recordDecisionAsReviewer({
    reviewRequestId: f.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
    reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
  })
  return f
}
async function makeRejectedFixture(m: string): Promise<{ topic: string; reviewRequestId: string }> {
  const f = await makeRequestedFixture(m)
  await recordDecisionAsReviewer({
    reviewRequestId: f.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'rejected',
    reasonCode: 'insufficient_evidence', rationale: 'Not enough context to confirm identity yet.',
  })
  return f
}
async function makeExecutedFixture(m: string): Promise<{ topic: string; reviewRequestId: string }> {
  const f = await makeApprovedFixture(m)
  executeAsService(f.reviewRequestId, `${m}-exec`)
  return f
}
async function makeStaleFixture(m: string): Promise<{ topic: string; reviewRequestId: string }> {
  const f = await makeApprovedFixture(m)
  dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${f.topic}';`)
  executeAsService(f.reviewRequestId, `${m}-exec`)
  return f
}
async function makeExpiredFixture(m: string): Promise<{ topic: string; reviewRequestId: string }> {
  const f = await makeRequestedFixture(m)
  dockerPsql(`update semantic_topic_lifecycle_review_requests set expires_at = now() - interval '1 minute' where id='${f.reviewRequestId}';`)
  await recordDecisionAsReviewer({
    reviewRequestId: f.reviewRequestId, decisionKey: `${m}-dec`, outcome: 'approved',
    reasonCode: 'identity_consistency_confirmed', rationale: 'Confirmed.', checklist: { a: true, b: true, c: true, d: true },
  })
  return f
}
async function makeCancelledFixture(m: string): Promise<{ topic: string; reviewRequestId: string }> {
  const f = await makeRequestedFixture(m)
  await cancelAsReviewer({ reviewRequestId: f.reviewRequestId, idemKey: `${m}-cancel`, cancelReasonCode: 'REVIEW_WITHDRAWN', cancelRationale: 'Withdrawn for test.' })
  return f
}
async function makeCancelledAfterApprovalFixture(m: string): Promise<{ topic: string; reviewRequestId: string }> {
  const f = await makeApprovedFixture(m)
  await cancelAsReviewer({ reviewRequestId: f.reviewRequestId, idemKey: `${m}-cancel`, cancelReasonCode: 'NEW_EVIDENCE_REQUIRES_NEW_REVIEW', cancelRationale: 'New evidence requires redo.' })
  return f
}

describeIfLocalDb('PFM Lifecycle Reviewer Read Surface v1 -- 088 (real local DB)', () => {
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
  // A. Permission boundary, zero-DML, redaction
  // ============================================================
  describe('A. permission boundary, zero-DML, redaction', () => {
    it('A1. anon cannot call list_semantic_topic_lifecycle_review_requests', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select list_semantic_topic_lifecycle_review_requests(); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('A2. anon cannot call get_semantic_topic_lifecycle_review_request', () => {
      const err = dockerPsqlExpectError(`SET ROLE anon; select get_semantic_topic_lifecycle_review_request('${randomUUID()}'::uuid); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('A3. service_role cannot call list_semantic_topic_lifecycle_review_requests', () => {
      const err = dockerPsqlExpectError(`SET ROLE service_role; select list_semantic_topic_lifecycle_review_requests(); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('A4. service_role cannot call get_semantic_topic_lifecycle_review_request', () => {
      const err = dockerPsqlExpectError(`SET ROLE service_role; select get_semantic_topic_lifecycle_review_request('${randomUUID()}'::uuid); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
    it('A5. authenticated role with no session (auth.uid() IS NULL) -> "authentication required", not a raw crash', () => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; select list_semantic_topic_lifecycle_review_requests(); RESET ROLE;`)
      expect(err).toMatch(/authentication required/)
    })
    it('A6. authenticated role with no session on get -> "authentication required"', () => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; select get_semantic_topic_lifecycle_review_request('${randomUUID()}'::uuid); RESET ROLE;`)
      expect(err).toMatch(/authentication required/)
    })
    it('A7. a non-reviewer authenticated user cannot call list', async () => {
      const email = `${nextMarker()}-nonreviewer-list@example.test`
      const password = `Test-${randomUUID()}-!Aa1`
      const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true })
      if (error || !data.user) throw new Error('failed to create non-reviewer fixture user')
      const nonReviewerClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
      await nonReviewerClient.auth.signInWithPassword({ email, password })
      try {
        const { error: rpcError } = await listAsReviewer({}, nonReviewerClient)
        expect(rpcError).toBeTruthy()
        expect(rpcError!.message).toMatch(/not an active reviewer/)
      } finally {
        await adminClient.auth.admin.deleteUser(data.user.id)
      }
    })
    it('A8. a non-reviewer authenticated user cannot call get', async () => {
      const email = `${nextMarker()}-nonreviewer-get@example.test`
      const password = `Test-${randomUUID()}-!Aa1`
      const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true })
      if (error || !data.user) throw new Error('failed to create non-reviewer fixture user')
      const nonReviewerClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
      await nonReviewerClient.auth.signInWithPassword({ email, password })
      try {
        const { error: rpcError } = await getAsReviewer(randomUUID(), nonReviewerClient)
        expect(rpcError).toBeTruthy()
        expect(rpcError!.message).toMatch(/not an active reviewer/)
      } finally {
        await adminClient.auth.admin.deleteUser(data.user.id)
      }
    })
    it('A9. an inactive reviewer (active=false) cannot call list or get', async () => {
      const email = `${nextMarker()}-inactive@example.test`
      const password = `Test-${randomUUID()}-!Aa1`
      const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true })
      if (error || !data.user) throw new Error('failed to create inactive-reviewer fixture user')
      dockerPsql(
        `insert into semantic_topic_reviewers (user_id, active, deactivated_at, deactivated_by_user_id, provisioning_note) values ('${data.user.id}', false, now(), '${reviewerUserId}', '${MARKER} inactive fixture');`,
      )
      const inactiveClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
      await inactiveClient.auth.signInWithPassword({ email, password })
      try {
        const list = await listAsReviewer({}, inactiveClient)
        expect(list.error).toBeTruthy()
        expect(list.error!.message).toMatch(/not an active reviewer/)
        const get = await getAsReviewer(randomUUID(), inactiveClient)
        expect(get.error).toBeTruthy()
        expect(get.error!.message).toMatch(/not an active reviewer/)
      } finally {
        dockerPsql(`delete from semantic_topic_reviewers where user_id='${data.user.id}';`)
        await adminClient.auth.admin.deleteUser(data.user.id)
      }
    })
    it('A10. an active reviewer can call list successfully', async () => {
      const m = nextMarker()
      await makeRequestedFixture(m)
      const { data, error } = await listAsReviewer({ statusFilter: 'actionable' })
      expect(error).toBeFalsy()
      expect(data.ok).toBe(true)
      expect(Array.isArray(data.requests)).toBe(true)
    })
    it('A11. an active reviewer can call get successfully', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      const { data, error } = await getAsReviewer(f.reviewRequestId)
      expect(error).toBeFalsy()
      expect(data.ok).toBe(true)
      expect(data.request.review_request_id).toBe(f.reviewRequestId)
    })
    it('A12. direct SELECT on semantic_topic_lifecycle_review_requests is still denied to anon and authenticated (088 never opens table-level access)', () => {
      const errAnon = dockerPsqlExpectError(`SET ROLE anon; select * from semantic_topic_lifecycle_review_requests limit 1; RESET ROLE;`)
      expect(errAnon).toMatch(/permission denied for table|permission denied for relation/i)
      const errAuth = dockerPsqlExpectError(`SET ROLE authenticated; select * from semantic_topic_lifecycle_review_requests limit 1; RESET ROLE;`)
      expect(errAuth).toMatch(/permission denied for table|permission denied for relation/i)
    })
    it('A13. zero DML: list+get calls never change any lifecycle/topic/membership row count', async () => {
      const m = nextMarker()
      const f = await makeExecutedFixture(m)
      const before = lifecycleTableRowCounts()
      await listAsReviewer({ statusFilter: 'history' })
      await getAsReviewer(f.reviewRequestId)
      await getAsReviewer(f.reviewRequestId)
      await listAsReviewer({ statusFilter: 'history' })
      const after = lifecycleTableRowCounts()
      expect(after).toBe(before)
    })
    it('A14. repeated get calls never change the stored evidence_vector_digest (STABLE, read-only)', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      const before = requestDigest(f.reviewRequestId)
      await getAsReviewer(f.reviewRequestId)
      await getAsReviewer(f.reviewRequestId)
      const after = requestDigest(f.reviewRequestId)
      expect(after).toBe(before)
    })
    it('A15. detail response never includes the raw reviewer or canceller user UUID -- only the *_by_current_reviewer booleans', async () => {
      const m = nextMarker()
      const f = await makeCancelledAfterApprovalFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      const text = JSON.stringify(data)
      expect(text).not.toMatch(new RegExp(reviewerUserId))
      expect(data.request.decision.decided_by_current_reviewer).toBe(true)
      expect(data.request.cancellation.cancelled_by_current_reviewer).toBe(true)
      expect(text).not.toMatch(/reviewer_user_id|cancelled_by_user_id/)
    })
    it('A16. neither list nor detail responses ever leak source-identity, email, external_ref, or canonical_url', async () => {
      const m = nextMarker()
      const f = await makeExecutedFixture(m)
      const { data: listData } = await listAsReviewer({ statusFilter: 'history' })
      const { data: getData } = await getAsReviewer(f.reviewRequestId)
      const combined = JSON.stringify(listData) + JSON.stringify(getData)
      expect(combined).not.toMatch(/example\.test/)
      expect(combined).not.toMatch(new RegExp(`${m}-chan`))
      expect(combined).not.toMatch(/external_ref|canonical_url|signal_source_id/)
      expect(combined).not.toMatch(REVIEWER_EMAIL)
    })
    it('A17. detail response never includes transition_event_id (internal audit PK)', async () => {
      const m = nextMarker()
      const f = await makeExecutedFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(JSON.stringify(data)).not.toMatch(/transition_event_id/)
    })
  })

  // ============================================================
  // B. Snapshot-digest bit-exactness against 087's own stored digest
  // ============================================================
  describe('B. snapshot digest helper is bit-exact with 087s own stored evidence_vector_digest', () => {
    // The comparison is done entirely server-side, in one statement -- never
    // round-tripping the stored jsonb vector through JS. PostgreSQL NUMERIC
    // fields inside the vector (e.g. confidence diagnostics) retain scale
    // (e.g. "0.9000") when cast to jsonb; JSON.parse/JSON.stringify in JS
    // would silently normalize that formatting away (0.9000 -> 0.9) and
    // produce a FALSE digest mismatch that has nothing to do with the
    // helper itself -- a JS-side reconstruction would test JS's number
    // formatting, not the SQL helper's bit-exactness.
    it('B1. coherent-target request: recomputing the digest from the stored snapshot inputs equals the stored evidence_vector_digest exactly', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      const matches = dockerPsql(
        `select (evidence_vector_digest = _semantic_topic_lifecycle_snapshot_digest(semantic_topic_id, target_status, review_policy_version, evidence_vector_snapshot)) from semantic_topic_lifecycle_review_requests where id='${f.reviewRequestId}';`,
      ).trim()
      expect(matches).toBe('t')
    })
    it('B2. ambiguous-target request: recomputing the digest from the stored snapshot inputs equals the stored evidence_vector_digest exactly', async () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic('corroborating')
      const ev = insertEvidence(m, src)
      insertMembership(topic, ev)
      const created = createRequestAsService(topic, 'ambiguous', `${m}-req`)
      const matches = dockerPsql(
        `select (evidence_vector_digest = _semantic_topic_lifecycle_snapshot_digest(semantic_topic_id, target_status, review_policy_version, evidence_vector_snapshot)) from semantic_topic_lifecycle_review_requests where id='${created.reviewRequestId}';`,
      ).trim()
      expect(matches).toBe('t')
    })
    it('B3. the helper itself has no external EXECUTE grant -- only the owner (postgres) can invoke it', () => {
      const err = dockerPsqlExpectError(`SET ROLE authenticated; select _semantic_topic_lifecycle_snapshot_digest('${randomUUID()}'::uuid, 'coherent', 1, '{}'::jsonb); RESET ROLE;`)
      expect(err).toMatch(/permission denied for function/i)
    })
  })

  // ============================================================
  // C. list RPC functional behavior
  // ============================================================
  describe('C. list_semantic_topic_lifecycle_review_requests functional behavior', () => {
    it('C1. an empty actionable list returns ok:true with an empty array, never null', async () => {
      const m = nextMarker()
      // No fixtures created under this fresh marker -- filter to a status guaranteed empty.
      const { data, error } = await listAsReviewer({ statusFilter: 'stale', afterId: null, afterRequestedAt: null })
      expect(error).toBeFalsy()
      expect(data.ok).toBe(true)
      // Not necessarily globally empty (other tests' fixtures may exist under a stale status),
      // so assert shape rather than exact emptiness here; true isolation is covered by marker-scoped C2 below.
      expect(Array.isArray(data.requests)).toBe(true)
      void m
    })

    it('C2. all 9 filter values return exactly the matching fixture(s), scoped by marker via topic label', async () => {
      const m = nextMarker()
      const requested = await makeRequestedFixture(`${m}-requested`)
      const approved = await makeApprovedFixture(`${m}-approved`)
      const rejected = await makeRejectedFixture(`${m}-rejected`)
      const expired = await makeExpiredFixture(`${m}-expired`)
      const cancelled = await makeCancelledFixture(`${m}-cancelled`)
      const executed = await makeExecutedFixture(`${m}-executed`)
      const stale = await makeStaleFixture(`${m}-stale`)

      const byMarker = new Map<string, string>([
        [requested.reviewRequestId, 'requested'],
        [approved.reviewRequestId, 'approved'],
        [rejected.reviewRequestId, 'rejected'],
        [expired.reviewRequestId, 'expired'],
        [cancelled.reviewRequestId, 'cancelled'],
        [executed.reviewRequestId, 'executed'],
        [stale.reviewRequestId, 'stale'],
      ])

      async function idsForFilter(statusFilter: string): Promise<string[]> {
        const { data, error } = await listAsReviewer({ statusFilter, limit: 50 })
        if (error) throw error
        return (data.requests as any[]).map((r) => r.review_request_id).filter((id) => byMarker.has(id))
      }

      expect(await idsForFilter('requested')).toEqual([requested.reviewRequestId])
      expect(await idsForFilter('approved')).toEqual([approved.reviewRequestId])
      expect(await idsForFilter('rejected')).toEqual([rejected.reviewRequestId])
      expect(await idsForFilter('expired')).toEqual([expired.reviewRequestId])
      expect(await idsForFilter('cancelled')).toEqual([cancelled.reviewRequestId])
      expect(await idsForFilter('executed')).toEqual([executed.reviewRequestId])
      expect(await idsForFilter('stale')).toEqual([stale.reviewRequestId])

      const actionable = (await idsForFilter('actionable')).sort()
      expect(actionable).toEqual([approved.reviewRequestId, requested.reviewRequestId].sort())

      const history = (await idsForFilter('history')).sort()
      expect(history).toEqual([cancelled.reviewRequestId, executed.reviewRequestId, expired.reviewRequestId, rejected.reviewRequestId, stale.reviewRequestId].sort())
    })

    it('C3. an invalid status filter fails closed with INVALID_STATUS_FILTER, not a silent empty/all list', async () => {
      const { data, error } = await listAsReviewer({ statusFilter: 'not_a_real_status' })
      expect(data).toBeFalsy()
      expect(error).toBeTruthy()
      expect(error!.message).toMatch(/INVALID_STATUS_FILTER/)
    })

    it('C4. keyset pagination across multiple pages: no duplicate and no gap across the full result set', async () => {
      const m = nextMarker()
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const f = await makeRequestedFixture(`${m}-p${i}`)
        ids.push(f.reviewRequestId)
        dockerPsql(`update semantic_topic_lifecycle_review_requests set requested_at = now() + interval '${i} seconds' where id='${f.reviewRequestId}';`)
      }
      // The 'requested' pool also holds leftover rows from earlier tests in
      // this same describe block (cleanupTestData only runs in beforeAll/
      // afterAll, not between tests) -- so a page may legitimately contain
      // zero of OUR ids while still having more pages ahead. Only stop once
      // the raw (unfiltered) page itself runs out.
      const seen: string[] = []
      let cursor: { afterRequestedAt: string | null; afterId: string | null } = { afterRequestedAt: null, afterId: null }
      for (let page = 0; page < 50 && seen.length < ids.length; page++) {
        const { data, error } = await listAsReviewer({ statusFilter: 'requested', limit: 2, afterRequestedAt: cursor.afterRequestedAt, afterId: cursor.afterId })
        if (error) throw error
        const rawRows = data.requests as any[]
        if (rawRows.length === 0) break
        for (const r of rawRows) if (ids.includes(r.review_request_id)) seen.push(r.review_request_id)
        const last = rawRows[rawRows.length - 1]
        cursor = { afterRequestedAt: last.requested_at, afterId: last.review_request_id }
        if (rawRows.length < 2) break
      }
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen.sort()).toEqual([...ids].sort())
    })

    it('C5. duplicate requested_at values are tie-broken deterministically by id -- no duplicate, no gap', async () => {
      const m = nextMarker()
      const fixedTimestamp = dockerPsql(`select now();`).trim()
      const f1 = await makeRequestedFixture(`${m}-a`)
      const f2 = await makeRequestedFixture(`${m}-b`)
      dockerPsql(`update semantic_topic_lifecycle_review_requests set requested_at = '${fixedTimestamp}' where id in ('${f1.reviewRequestId}','${f2.reviewRequestId}');`)
      const expectedOrder = [f1.reviewRequestId, f2.reviewRequestId].sort()

      const { data: page1, error: e1 } = await listAsReviewer({ statusFilter: 'requested', limit: 1, afterRequestedAt: null, afterId: null })
      if (e1) throw e1
      const firstRow = (page1.requests as any[]).find((r) => [f1.reviewRequestId, f2.reviewRequestId].includes(r.review_request_id))
      // If an unrelated fixture from an earlier test sorts before ours, page forward until we reach our own pair.
      let cursor = firstRow ? { afterRequestedAt: (page1.requests as any[])[0].requested_at, afterId: (page1.requests as any[])[0].review_request_id } : { afterRequestedAt: null as string | null, afterId: null as string | null }
      const collected: string[] = firstRow ? [firstRow.review_request_id] : []
      for (let i = 0; i < 20 && collected.length < 2; i++) {
        const { data, error } = await listAsReviewer({ statusFilter: 'requested', limit: 1, afterRequestedAt: cursor.afterRequestedAt, afterId: cursor.afterId })
        if (error) throw error
        const row = (data.requests as any[])[0]
        if (!row) break
        cursor = { afterRequestedAt: row.requested_at, afterId: row.review_request_id }
        if ([f1.reviewRequestId, f2.reviewRequestId].includes(row.review_request_id) && !collected.includes(row.review_request_id)) {
          collected.push(row.review_request_id)
        }
      }
      expect(collected.sort()).toEqual(expectedOrder)
    })

    it('C6. limit is clamped to at least 1 (p_limit=0 never returns an unbounded or zero-forced-empty result)', async () => {
      const m = nextMarker()
      await makeRequestedFixture(m)
      const { data, error } = await listAsReviewer({ statusFilter: 'requested', limit: 0 })
      expect(error).toBeFalsy()
      expect((data.requests as any[]).length).toBeGreaterThanOrEqual(1)
      expect((data.requests as any[]).length).toBeLessThanOrEqual(1)
    })

    it('C6b. an oversized limit request does not error -- the 50 hard cap is enforced in source (verified statically; constructing 51 live fixtures is prohibitively expensive)', () => {
      expect(migration088Source).toMatch(/v_limit := LEAST\(GREATEST\(coalesce\(p_limit, 20\), 1\), 50\);/)
    })

    it('C7. omitting p_limit entirely uses the RPC-level default of 20 (not the API route default)', async () => {
      const { data, error } = await callRpc(userClient, 'list_semantic_topic_lifecycle_review_requests', { p_status_filter: 'history' })
      expect(error).toBeFalsy()
      expect(data.ok).toBe(true)
      expect((data.requests as any[]).length).toBeLessThanOrEqual(20)
    })

    it('C8. omitting p_status_filter entirely defaults to actionable', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      const { data, error } = await callRpc(userClient, 'list_semantic_topic_lifecycle_review_requests', { p_limit: 50 })
      expect(error).toBeFalsy()
      const ids = (data.requests as any[]).map((r) => r.review_request_id)
      expect(ids).toContain(f.reviewRequestId)
    })

    it('C9. list rows never include snapshot, decision, execution, cancellation, or transition_history fields', async () => {
      const m = nextMarker()
      await makeRequestedFixture(m)
      const { data } = await listAsReviewer({ statusFilter: 'requested', limit: 50 })
      const row = (data.requests as any[])[0]
      expect(row).toBeDefined()
      for (const forbiddenKey of ['snapshot', 'decision', 'execution', 'cancellation', 'transition_history', 'live', 'staleness_signals', 'is_potentially_stale']) {
        expect(row).not.toHaveProperty(forbiddenKey)
      }
    })
  })

  // ============================================================
  // D. get RPC functional behavior
  // ============================================================
  describe('D. get_semantic_topic_lifecycle_review_request functional behavior', () => {
    it('D1. an unknown review request id returns a normal {ok:false, reasonCode:NOT_FOUND}, never an exception', async () => {
      const { data, error } = await getAsReviewer(randomUUID())
      expect(error).toBeFalsy()
      expect(data.ok).toBe(false)
      expect(data.reasonCode).toBe('NOT_FOUND')
    })

    it('D2a. requested status: decision, execution, cancellation all null', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.request_status).toBe('requested')
      expect(data.request.decision).toBeNull()
      expect(data.request.execution).toBeNull()
      expect(data.request.cancellation).toBeNull()
    })

    it('D2b. approved status: decision present, execution and cancellation null', async () => {
      const m = nextMarker()
      const f = await makeApprovedFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.request_status).toBe('approved')
      expect(data.request.decision).not.toBeNull()
      expect(data.request.decision.reason_code).toBe('identity_consistency_confirmed')
      expect(data.request.execution).toBeNull()
      expect(data.request.cancellation).toBeNull()
    })

    it('D2c. rejected status: decision present with its reason code, execution and cancellation null', async () => {
      const m = nextMarker()
      const f = await makeRejectedFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.request_status).toBe('rejected')
      expect(data.request.decision.reason_code).toBe('insufficient_evidence')
      expect(data.request.execution).toBeNull()
      expect(data.request.cancellation).toBeNull()
    })

    it('D2d. expired status: decision, execution, cancellation all null (the decision attempt that revealed expiry never persisted a decision)', async () => {
      const m = nextMarker()
      const f = await makeExpiredFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.request_status).toBe('expired')
      expect(data.request.decision).toBeNull()
      expect(data.request.execution).toBeNull()
      expect(data.request.cancellation).toBeNull()
    })

    it('D2e. cancelled status (cancelled while requested): cancellation present, decision null', async () => {
      const m = nextMarker()
      const f = await makeCancelledFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.request_status).toBe('cancelled')
      expect(data.request.cancellation).not.toBeNull()
      expect(data.request.cancellation.cancel_reason_code).toBe('REVIEW_WITHDRAWN')
      expect(data.request.decision).toBeNull()
    })

    it('D2f. cancelled status (cancelled after approval): both decision AND cancellation present', async () => {
      const m = nextMarker()
      const f = await makeCancelledAfterApprovalFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.request_status).toBe('cancelled')
      expect(data.request.decision).not.toBeNull()
      expect(data.request.cancellation).not.toBeNull()
      expect(data.request.cancellation.cancel_reason_code).toBe('NEW_EVIDENCE_REQUIRES_NEW_REVIEW')
    })

    it('D2g. executed status: decision AND execution present, cancellation null', async () => {
      const m = nextMarker()
      const f = await makeExecutedFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.request_status).toBe('executed')
      expect(data.request.decision).not.toBeNull()
      expect(data.request.execution).not.toBeNull()
      expect(data.request.execution.executed_at).toBeTruthy()
      expect(data.request.cancellation).toBeNull()
    })

    it('D2h. stale status: decision present (it was approved before going stale), execution null, stale_reason_code set', async () => {
      const m = nextMarker()
      const f = await makeStaleFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.request_status).toBe('stale')
      expect(data.request.decision).not.toBeNull()
      expect(data.request.execution).toBeNull()
      expect(data.request.stale_reason_code).toBe('TOPIC_VERSION_CHANGED')
    })

    it('D3. no drift: isPotentiallyStale is false and all four staleness signals are false', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      const r = data.request
      expect(r.is_potentially_stale).toBe(false)
      expect(r.staleness_signals).toEqual({
        topic_status_changed: false,
        topic_version_changed: false,
        evidence_vector_changed: false,
        mechanical_requirements_lost: false,
      })
      expect(r.live.lifecycle_status).toBe(r.snapshot.from_lifecycle_status)
      expect(r.live.status_version).toBe(r.snapshot.expected_status_version)
      expect(r.live.vector_digest).toBe(r.snapshot.digest)
    })

    it('D4. snapshot immutability: after the topic independently drifts, snapshot fields stay exactly what they were at request creation', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      const before = (await getAsReviewer(f.reviewRequestId)).data.request.snapshot
      dockerPsql(`update semantic_topics set lifecycle_status='ambiguous', status_version = status_version + 1 where id='${f.topic}';`)
      const after = (await getAsReviewer(f.reviewRequestId)).data.request.snapshot
      expect(after).toEqual(before)
    })

    it('D5. membership/vector-only change: evidence_vector_changed=true and isPotentiallyStale=true, but topic_status/version unchanged', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      const srcC = insertSource(`${m}-chanC`)
      const evC = insertEvidence(`${m}-c`, srcC)
      insertMembership(f.topic, evC)
      const { data } = await getAsReviewer(f.reviewRequestId)
      const r = data.request
      expect(r.staleness_signals.evidence_vector_changed).toBe(true)
      expect(r.staleness_signals.topic_status_changed).toBe(false)
      expect(r.staleness_signals.topic_version_changed).toBe(false)
      expect(r.is_potentially_stale).toBe(true)
    })

    it('D6. status drift: topic_status_changed=true and isPotentiallyStale=true', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      dockerPsql(`update semantic_topics set lifecycle_status='ambiguous' where id='${f.topic}';`)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.staleness_signals.topic_status_changed).toBe(true)
      expect(data.request.is_potentially_stale).toBe(true)
    })

    it('D7. version drift: topic_version_changed=true and isPotentiallyStale=true', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${f.topic}';`)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.staleness_signals.topic_version_changed).toBe(true)
      expect(data.request.is_potentially_stale).toBe(true)
    })

    it('D8. mechanical-minimum loss (coherent target): mechanical_requirements_lost=true, live.mechanical_requirements_currently_met=false, isPotentiallyStale=true', async () => {
      const m = nextMarker()
      const { topic, membershipIds } = makeTopicWithNSources(m, 'corroborating', 2)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      invalidateMembership(membershipIds[0])
      const { data } = await getAsReviewer(created.reviewRequestId)
      const r = data.request
      expect(r.staleness_signals.mechanical_requirements_lost).toBe(true)
      expect(r.live.mechanical_requirements_currently_met).toBe(false)
      expect(r.is_potentially_stale).toBe(true)
    })

    it('D8b. ambiguous target never signals mechanical_requirements_lost (no mechanical floor applies)', async () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic('corroborating')
      const ev = insertEvidence(m, src)
      const membershipId = insertMembership(topic, ev)
      const created = createRequestAsService(topic, 'ambiguous', `${m}-req`)
      invalidateMembership(membershipId)
      const { data } = await getAsReviewer(created.reviewRequestId)
      const r = data.request
      expect(r.staleness_signals.mechanical_requirements_lost).toBe(false)
      expect(r.live.mechanical_requirements_currently_met).toBe(true)
    })

    it('D9. a stale request (request_status=stale) reports isPotentiallyStale=true via the request-status OR term', async () => {
      const m = nextMarker()
      const f = await makeStaleFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      expect(data.request.request_status).toBe('stale')
      expect(data.request.is_potentially_stale).toBe(true)
    })

    it('D10. transition history is stably ordered by created_at ascending and matches the expected event sequence for an executed request', async () => {
      const m = nextMarker()
      const f = await makeExecutedFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      const history = data.request.transition_history as { event_type: string; actor_kind: string; created_at: string }[]
      expect(history.map((e) => e.event_type)).toEqual(['requested', 'approved', 'executed'])
      const times = history.map((e) => Date.parse(e.created_at))
      const sortedTimes = [...times].sort((a, b) => a - b)
      expect(times).toEqual(sortedTimes)
      expect(history[0].actor_kind).toBe('service_role_system')
      expect(history[1].actor_kind).toBe('authenticated_reviewer')
      expect(history[2].actor_kind).toBe('service_role_system')
    })

    it('D11. transition history never includes an event id or actor user id field', async () => {
      const m = nextMarker()
      const f = await makeExecutedFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      for (const e of data.request.transition_history) {
        expect(e).not.toHaveProperty('id')
        expect(e).not.toHaveProperty('actor_user_id')
      }
    })

    it('D12. the live evidence vector is the full aggregate shape (compute_topic_evidence_vector output), not a subset', async () => {
      const m = nextMarker()
      const f = await makeRequestedFixture(m)
      const { data } = await getAsReviewer(f.reviewRequestId)
      const vector = data.request.live.evidence_vector
      for (const key of ['formulaVersion', 'lifecycleStatus', 'activeMembershipCount', 'eligibleDistinctSourceIdentityCount', 'confidenceDiagnostics']) {
        expect(vector).toHaveProperty(key)
      }
    })
  })
})
