// PFM Lifecycle Operator CLI v1 -- REAL local DB integration tests for the
// executor support module (execute-approved-lifecycle-transition-cli-support.ts),
// exercised against 087's already-production
// execute_approved_semantic_topic_lifecycle_transition RPC. No new
// migration -- 087 remains byte-identical to what is already live in
// production.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import {
  fetchLifecycleExecutionPreview,
  runExecuteApprovedLifecycleTransition,
} from '@/lib/semantic-topic/execute-approved-lifecycle-transition-cli-support'

const MIGRATION_087_PATH = join(process.cwd(), 'supabase/migrations/087_semantic_topic_lifecycle_review_framework.sql')
const LOCAL_API_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const adminClient = createClient(LOCAL_API_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', { input: sql, encoding: 'utf-8' })
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

const MARKER = 'eaLT-e2e'
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
function insertTopic(lifecycleStatus: string): string {
  return dockerPsql(
    `insert into semantic_topics (canonical_label, label_language, creation_request_digest, lifecycle_status) values ('${MARKER} topic ${Math.random().toString(36).slice(2)}', 'en', '${randomHexDigest()}', '${lifecycleStatus}') returning id;`,
  ).trim()
}
function insertMembership(topicId: string, evidenceId: string): string {
  return dockerPsql(
    `insert into semantic_topic_membership (semantic_topic_id, signal_evidence_id, assignment_reason, confidence, algorithm_version) values ('${topicId}', '${evidenceId}', 'manual_review_confirmed', 0.9000, 1) returning id;`,
  ).trim()
}
function makeCorroboratingTopicWithTwoSources(m: string): string {
  const topic = insertTopic('corroborating')
  for (let i = 0; i < 2; i++) {
    const src = insertSource(`${m}-chan${i}`)
    const ev = insertEvidence(`${m}-${i}`, src)
    insertMembership(topic, ev)
  }
  return topic
}

function createRequestAsService(topicId: string, targetStatus: string, idemKey: string): any {
  return JSON.parse(dockerPsql(`select create_semantic_topic_lifecycle_review_request('${topicId}'::uuid, '${targetStatus}', '${idemKey}');`).trim())
}
function topicRow(topicId: string): { lifecycle_status: string; status_version: number } {
  const out = dockerPsql(`select lifecycle_status || '|' || status_version from semantic_topics where id='${topicId}';`).trim()
  const [lifecycle_status, sv] = out.split('|')
  return { lifecycle_status, status_version: Number(sv) }
}
function transitionEventCount(reviewRequestId: string): number {
  return Number(dockerPsql(`select count(*) from semantic_topic_lifecycle_transition_events where review_request_id='${reviewRequestId}';`).trim())
}
function requestStatus(reviewRequestId: string): string {
  return dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${reviewRequestId}';`).trim()
}

// ── Real GoTrue reviewer session, established pattern. ──
const REVIEWER_EMAIL = `${MARKER}-reviewer-${Date.now()}@example.test`
const REVIEWER_PASSWORD = `Test-${randomUUID()}-!Aa1`
let reviewerUserId: string
let userClient: ReturnType<typeof createClient>

async function approveRequest(reviewRequestId: string, decisionKey: string): Promise<void> {
  const { error } = await (userClient as any).rpc('record_semantic_topic_lifecycle_review_decision', {
    p_review_request_id: reviewRequestId,
    p_decision_idempotency_key: decisionKey,
    p_outcome: 'approved',
    p_reason_code: 'identity_consistency_confirmed',
    p_reviewer_rationale: 'Confirmed for executor db-integration fixture.',
    p_same_semantic_identity_confirmed: true,
    p_no_material_identity_conflict: true,
    p_canonical_definition_scope_fit_confirmed: true,
    p_provenance_relationship_reviewed: true,
    p_review_policy_version: 1,
  })
  if (error) throw error
}

async function makeApprovedRequest(m: string): Promise<{ topic: string; reviewRequestId: string }> {
  const topic = makeCorroboratingTopicWithTwoSources(m)
  const created = createRequestAsService(topic, 'coherent', `${m}-req`)
  await approveRequest(created.reviewRequestId, `${m}-dec`)
  return { topic, reviewRequestId: created.reviewRequestId }
}

describeIfLocalDb('PFM Lifecycle Operator CLI v1 -- executor support module (real local DB)', () => {
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
  // A. Write-RPC call count
  // ============================================================
  describe('A. write-RPC call count', () => {
    it('A1. dry-run never executes a transition', async () => {
      const m = nextMarker()
      const { topic, reviewRequestId } = await makeApprovedRequest(m)
      const before = topicRow(topic)
      const outcome = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: true })
      expect(outcome.kind).toBe('dry_run')
      expect(topicRow(topic)).toEqual(before)
      expect(transitionEventCount(reviewRequestId)).toBe(0)
    })

    it('A2. apply executes exactly one transition on a clean success -- lifecycle/version/transition-event postcondition matches the preview', async () => {
      const m = nextMarker()
      const { topic, reviewRequestId } = await makeApprovedRequest(m)
      const before = topicRow(topic)
      const outcome = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: false })
      expect(outcome).toEqual({ kind: 'executed', reviewRequestIdPrefix: reviewRequestId.slice(0, 8), fromStatus: 'corroborating', targetStatus: 'coherent' })
      const after = topicRow(topic)
      expect(after.lifecycle_status).toBe('coherent')
      expect(after.status_version).toBe(before.status_version + 1)
      expect(transitionEventCount(reviewRequestId)).toBe(1)
      expect(requestStatus(reviewRequestId)).toBe('executed')
    })
  })

  // ============================================================
  // B. Idempotency and replay
  // ============================================================
  describe('B. idempotency and replay', () => {
    it('B1. a repeated apply against the same approved decision replays cleanly -- exactly one transition event total', async () => {
      const m = nextMarker()
      const { topic, reviewRequestId } = await makeApprovedRequest(m)
      const first = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: false })
      expect(first.kind).toBe('executed')
      const replay = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: false })
      expect(replay).toEqual({ kind: 'replayed', reviewRequestIdPrefix: reviewRequestId.slice(0, 8) })
      expect(transitionEventCount(reviewRequestId)).toBe(1)
      const finalTopic = topicRow(topic)
      expect(finalTopic.lifecycle_status).toBe('coherent')
    })

    it('B2. the derived key is stable across two independent preview reads for the same request', async () => {
      const m = nextMarker()
      const { reviewRequestId } = await makeApprovedRequest(m)
      const p1 = await fetchLifecycleExecutionPreview(adminClient as any, reviewRequestId)
      const p2 = await fetchLifecycleExecutionPreview(adminClient as any, reviewRequestId)
      if (!p1.ok || !p2.ok) throw new Error('unreachable')
      expect(p1.preview.idempotencyKeyPrefix).toBe(p2.preview.idempotencyKeyPrefix)
    })
  })

  // ============================================================
  // C. Staleness -- never a transition, always persisted
  // ============================================================
  describe('C. stale requests never execute a transition', () => {
    it('C1. TOPIC_STATE_CHANGED: the stale branch never mutates the topic or creates a transition event', async () => {
      const m = nextMarker()
      const { topic, reviewRequestId } = await makeApprovedRequest(m)
      const before = topicRow(topic)
      dockerPsql(`update semantic_topics set lifecycle_status='ambiguous' where id='${topic}';`)

      const outcome = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: false })
      expect(outcome).toEqual({ kind: 'stale', reviewRequestIdPrefix: reviewRequestId.slice(0, 8), staleReasonCode: 'TOPIC_STATE_CHANGED' })
      expect(requestStatus(reviewRequestId)).toBe('stale')
      expect(transitionEventCount(reviewRequestId)).toBe(0)
      const after = topicRow(topic)
      expect(after.lifecycle_status).toBe('ambiguous')
      expect(after.status_version).toBe(before.status_version)
    })

    it('C2. TOPIC_VERSION_CHANGED: same guarantee', async () => {
      const m = nextMarker()
      const { topic, reviewRequestId } = await makeApprovedRequest(m)
      dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${topic}';`)

      const outcome = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: false })
      expect(outcome).toEqual({ kind: 'stale', reviewRequestIdPrefix: reviewRequestId.slice(0, 8), staleReasonCode: 'TOPIC_VERSION_CHANGED' })
      expect(transitionEventCount(reviewRequestId)).toBe(0)
    })

    it('C3. a stale outcome is advisory-flagged in the PRIOR preview read too (staleSignal present before apply)', async () => {
      const m = nextMarker()
      const { topic, reviewRequestId } = await makeApprovedRequest(m)
      dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${topic}';`)
      const preview = await fetchLifecycleExecutionPreview(adminClient as any, reviewRequestId)
      if (!preview.ok) throw new Error('unreachable')
      expect(preview.preview.advisoryStaleSignal).toBe('topic_version_changed')
    })

    it('C4. a repeated apply against an already-stale request replays the SAME stale outcome, never a second attempt at transition', async () => {
      const m = nextMarker()
      const { topic, reviewRequestId } = await makeApprovedRequest(m)
      dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${topic}';`)
      const first = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: false })
      expect(first.kind).toBe('stale')
      const second = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: false })
      expect(second).toEqual(first)
      expect(transitionEventCount(reviewRequestId)).toBe(0)
    })
  })

  // ============================================================
  // D. Not-executable and not-found
  // ============================================================
  describe('D. not-executable and not-found', () => {
    it('D1. a REQUESTED (not yet approved) request is refused locally, RPC never called', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const outcome = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId: created.reviewRequestId, dryRun: false })
      expect(outcome).toEqual({ kind: 'not_executable', status: 'requested' })
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('D2. a non-existent review request id maps to configuration_error', async () => {
      const outcome = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId: randomUUID(), dryRun: false })
      expect(outcome.kind).toBe('configuration_error')
    })
  })

  // ============================================================
  // E. Redaction
  // ============================================================
  describe('E. redaction', () => {
    it('E1. an executed outcome never includes the full review_request_id or the full idempotency key', async () => {
      const m = nextMarker()
      const { reviewRequestId } = await makeApprovedRequest(m)
      const outcome = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: false })
      const text = JSON.stringify(outcome)
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
      expect(text).not.toMatch(/execute-approved-lifecycle-transition:[0-9a-f]{32}/)
    })
    it('E2. a stale outcome never includes a raw Postgres error message', async () => {
      const m = nextMarker()
      const { topic, reviewRequestId } = await makeApprovedRequest(m)
      dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${topic}';`)
      const outcome = await runExecuteApprovedLifecycleTransition(adminClient as any, { reviewRequestId, dryRun: false })
      expect(JSON.stringify(outcome)).not.toMatch(/RAISE EXCEPTION|pg_catalog|ERROR:/i)
    })
  })

  // ============================================================
  // F. 087 is untouched
  // ============================================================
  describe('F. 087 is untouched', () => {
    it('F1. execute_approved_semantic_topic_lifecycle_transition body hash is unchanged', () => {
      const hash = dockerPsql(
        `select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public.execute_approved_semantic_topic_lifecycle_transition(uuid, text)'::regprocedure;`,
      ).trim()
      expect(hash).toBe('6c12de4cef728e046490645c0ce3b057')
    })
    it('F2. reapplying 087 is a clean no-op', () => {
      const r = runMigration(MIGRATION_087_PATH)
      expect(r.threw).toBe(false)
      expect(r.out).toMatch(/087: final self-check passed/)
    })
  })

  // ============================================================
  // G. Clean baseline restoration
  // ============================================================
  describe('G. clean baseline restoration', () => {
    it('G1. after cleanup, no marker-scoped topic or request row remains', () => {
      cleanupTestData()
      const remainingTopics = Number(dockerPsql(`select count(*) from semantic_topics where canonical_label like '${MARKER}%';`).trim())
      const remainingRequests = Number(
        dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%');`).trim(),
      )
      expect(remainingTopics).toBe(0)
      expect(remainingRequests).toBe(0)
    })
  })
})
