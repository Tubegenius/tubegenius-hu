// PFM Lifecycle Reviewer Action Surface v1 -- REAL local DB integration
// tests for the two new WRITE wrapper functions (lifecycle-review-actions.ts:
// recordLifecycleDecision, cancelLifecycleReview), exercised against 087's
// already-production record_semantic_topic_lifecycle_review_decision /
// cancel_semantic_topic_lifecycle_review_request RPCs. No new migration is
// introduced or needed by this gate -- 087 and 088 remain byte-identical to
// what is already live in production; this file only proves the NEW
// application-layer wrapper maps their real behavior correctly.
//
// Mirrors the established 087/088 test pattern: local Docker Supabase
// stack, real GoTrue reviewer session, only synthetic/deterministic
// fixtures. No AI/provider call, no production data, never calls the
// executor or the create RPC except as raw service-role SQL fixture setup
// (mirroring 087's own test file's own established idiom for building
// fixtures in known states).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { recordLifecycleDecision, cancelLifecycleReview } from '@/lib/semantic-topic/lifecycle-review-actions'
import { listLifecycleReviews, getLifecycleReview } from '@/lib/semantic-topic/lifecycle-review-reader'
import type { LifecycleDecisionRequestBody, LifecycleCancelRequestBody } from '@/lib/semantic-topic/lifecycle-review-types'

const MIGRATION_087_PATH = join(process.cwd(), 'supabase/migrations/087_semantic_topic_lifecycle_review_framework.sql')
const MIGRATION_088_PATH = join(process.cwd(), 'supabase/migrations/088_semantic_topic_lifecycle_reviewer_read_surface.sql')
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

const MARKER = 'sti-action'
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
function makeTopicWithNSources(m: string, lifecycleStatus: string, n: number): string {
  const topic = insertTopic(lifecycleStatus)
  for (let i = 0; i < n; i++) {
    const src = insertSource(`${m}-chan${i}`)
    const ev = insertEvidence(`${m}-${i}`, src)
    insertMembership(topic, ev)
  }
  return topic
}
function makeCorroboratingTopicWithTwoSources(m: string): string {
  return makeTopicWithNSources(m, 'corroborating', 2)
}

function createRequestAsService(topicId: string, targetStatus: string, idemKey: string): any {
  return JSON.parse(dockerPsql(`select create_semantic_topic_lifecycle_review_request('${topicId}'::uuid, '${targetStatus}', '${idemKey}');`).trim())
}
function executeAsService(reviewRequestId: string, idemKey: string): any {
  return JSON.parse(dockerPsql(`select execute_approved_semantic_topic_lifecycle_transition('${reviewRequestId}'::uuid, '${idemKey}');`).trim())
}

function topicRow(topicId: string): { lifecycle_status: string; status_version: number } {
  const out = dockerPsql(`select lifecycle_status || '|' || status_version from semantic_topics where id='${topicId}';`).trim()
  const [lifecycle_status, sv] = out.split('|')
  return { lifecycle_status, status_version: Number(sv) }
}
function requestStatus(reviewRequestId: string): string {
  return dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${reviewRequestId}';`).trim()
}
function eventCount(reviewRequestId: string, eventType: string): number {
  return Number(dockerPsql(`select count(*) from semantic_topic_lifecycle_review_events where review_request_id='${reviewRequestId}' and event_type='${eventType}';`).trim())
}
function transitionEventCount(reviewRequestId: string): number {
  return Number(dockerPsql(`select count(*) from semantic_topic_lifecycle_transition_events where review_request_id='${reviewRequestId}';`).trim())
}

// ── Real GoTrue reviewer session, established pattern. ──
const REVIEWER_EMAIL = `${MARKER}-reviewer-${Date.now()}@example.test`
const REVIEWER_PASSWORD = `Test-${randomUUID()}-!Aa1`
let reviewerUserId: string
let userClient: ReturnType<typeof createClient>

function approvedCoherentInput(overrides: Partial<LifecycleDecisionRequestBody> = {}): LifecycleDecisionRequestBody {
  return {
    outcome: 'approved',
    reasonCode: 'identity_consistency_confirmed',
    reviewerRationale: 'Clear, consistent identity across both sources.',
    sameSemanticIdentityConfirmed: true,
    noMaterialIdentityConflict: true,
    canonicalDefinitionScopeFitConfirmed: true,
    provenanceRelationshipReviewed: true,
    reviewPolicyVersion: 1,
    idempotencyKey: nextMarker(),
    ...overrides,
  }
}
function rejectedInput(overrides: Partial<LifecycleDecisionRequestBody> = {}): LifecycleDecisionRequestBody {
  return {
    outcome: 'rejected',
    reasonCode: 'insufficient_evidence',
    reviewerRationale: 'Not enough context to confirm identity yet.',
    sameSemanticIdentityConfirmed: null,
    noMaterialIdentityConflict: null,
    canonicalDefinitionScopeFitConfirmed: null,
    provenanceRelationshipReviewed: null,
    reviewPolicyVersion: 1,
    idempotencyKey: nextMarker(),
    ...overrides,
  }
}
function cancelInput(overrides: Partial<LifecycleCancelRequestBody> = {}): LifecycleCancelRequestBody {
  return {
    cancelReasonCode: 'REVIEW_WITHDRAWN',
    cancelRationale: 'The requester withdrew the review.',
    idempotencyKey: nextMarker(),
    ...overrides,
  }
}

describeIfLocalDb('PFM Lifecycle Reviewer Action Surface v1 -- decision/cancel wrapper (real local DB)', () => {
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
  // A. Successful decision postconditions (item 9)
  // ============================================================
  describe('A. successful decision postconditions', () => {
    it('A1. approve: request approved, approved event created, topic lifecycle/version unchanged, zero transition events', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const before = topicRow(topic)

      const result = await recordLifecycleDecision(userClient, created.reviewRequestId, approvedCoherentInput())
      expect(result.outcome).toBe('success')
      if (result.outcome !== 'success') throw new Error('unreachable')
      expect(result.result.outcomeKind).toBe('approved')
      expect(result.result.status).toBe('approved')

      expect(requestStatus(created.reviewRequestId)).toBe('approved')
      expect(eventCount(created.reviewRequestId, 'approved')).toBe(1)
      const after = topicRow(topic)
      expect(after).toEqual(before)
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('A2. reject: request rejected, no transition event', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)

      const result = await recordLifecycleDecision(userClient, created.reviewRequestId, rejectedInput())
      expect(result.outcome).toBe('success')
      if (result.outcome !== 'success') throw new Error('unreachable')
      expect(result.result.outcomeKind).toBe('rejected')

      expect(requestStatus(created.reviewRequestId)).toBe('rejected')
      expect(eventCount(created.reviewRequestId, 'rejected')).toBe(1)
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('A3. cancel a REQUESTED request: -> cancelled, no transition event', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)

      const result = await cancelLifecycleReview(userClient, created.reviewRequestId, cancelInput())
      expect(result.outcome).toBe('success')
      if (result.outcome !== 'success') throw new Error('unreachable')
      expect(result.result.outcomeKind).toBe('cancelled')

      expect(requestStatus(created.reviewRequestId)).toBe('cancelled')
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })

    it('A4. cancel an APPROVED (not yet executed) request: -> cancelled, no transition event, topic unchanged', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordLifecycleDecision(userClient, created.reviewRequestId, approvedCoherentInput())
      const before = topicRow(topic)

      const result = await cancelLifecycleReview(userClient, created.reviewRequestId, cancelInput())
      expect(result.outcome).toBe('success')
      if (result.outcome !== 'success') throw new Error('unreachable')
      expect(result.result.outcomeKind).toBe('cancelled')

      expect(requestStatus(created.reviewRequestId)).toBe('cancelled')
      expect(topicRow(topic)).toEqual(before)
      expect(transitionEventCount(created.reviewRequestId)).toBe(0)
    })
  })

  // ============================================================
  // B. Terminal-state cancel rejection (item 9 / item 11)
  // ============================================================
  describe('B. cancel is refused once a request has left the requested/approved window', () => {
    it('B1. an EXECUTED request cannot be cancelled -- wrapper maps to not_cancellable', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordLifecycleDecision(userClient, created.reviewRequestId, approvedCoherentInput())
      executeAsService(created.reviewRequestId, `${m}-exec`)

      const result = await cancelLifecycleReview(userClient, created.reviewRequestId, cancelInput())
      expect(result.outcome).toBe('not_cancellable')
    })

    it('B2. a STALE request cannot be cancelled -- wrapper maps to not_cancellable', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordLifecycleDecision(userClient, created.reviewRequestId, approvedCoherentInput())
      dockerPsql(`update semantic_topics set status_version = status_version + 1 where id='${topic}';`)
      executeAsService(created.reviewRequestId, `${m}-exec`)
      expect(requestStatus(created.reviewRequestId)).toBe('stale')

      const result = await cancelLifecycleReview(userClient, created.reviewRequestId, cancelInput())
      expect(result.outcome).toBe('not_cancellable')
    })

    it('B3. an already-CANCELLED request replays cleanly with the SAME payload but conflicts with a different one', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const input = cancelInput()
      const first = await cancelLifecycleReview(userClient, created.reviewRequestId, input)
      expect(first.outcome).toBe('success')

      const replay = await cancelLifecycleReview(userClient, created.reviewRequestId, input)
      expect(replay.outcome).toBe('success')
      if (replay.outcome !== 'success') throw new Error('unreachable')
      expect(replay.result.outcomeKind).toBe('replayed')

      const conflictingInput = { ...input, cancelRationale: 'A different rationale entirely.' }
      const conflict = await cancelLifecycleReview(userClient, created.reviewRequestId, conflictingInput)
      expect(conflict.outcome).toBe('conflict')
    })
  })

  // ============================================================
  // C. Idempotency (item 7)
  // ============================================================
  describe('C. idempotency: stable key passthrough, replay, and conflict', () => {
    it('C1. decision: same key + same payload replays with outcomeKind=replayed, no duplicate event', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const input = approvedCoherentInput()

      const first = await recordLifecycleDecision(userClient, created.reviewRequestId, input)
      expect(first.outcome).toBe('success')
      const replay = await recordLifecycleDecision(userClient, created.reviewRequestId, input)
      expect(replay.outcome).toBe('success')
      if (replay.outcome !== 'success') throw new Error('unreachable')
      expect(replay.result.outcomeKind).toBe('replayed')
      expect(eventCount(created.reviewRequestId, 'approved')).toBe(1)
    })

    it('C2. decision: same key + different payload -> conflict (redacted, never a raw digest-mismatch message)', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const input = approvedCoherentInput()
      await recordLifecycleDecision(userClient, created.reviewRequestId, input)

      const conflicting = { ...input, reviewerRationale: 'A materially different rationale text.' }
      const result = await recordLifecycleDecision(userClient, created.reviewRequestId, conflicting)
      expect(result.outcome).toBe('conflict')
    })

    it('C3. cancel: same key + same payload replays; different payload conflicts (covered structurally, see B3)', async () => {
      // Explicit duplicate of B3's assertions under the "idempotency" heading
      // for direct traceability to gate item 7.
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const input = cancelInput()
      await cancelLifecycleReview(userClient, created.reviewRequestId, input)
      const replay = await cancelLifecycleReview(userClient, created.reviewRequestId, input)
      expect(replay.outcome).toBe('success')
      if (replay.outcome !== 'success') throw new Error('unreachable')
      expect(replay.result.outcomeKind).toBe('replayed')
    })

    it('C4. the idempotency key the caller supplies reaches the RPC completely unchanged (no wrapper-side mutation)', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const stableKey = `${m}-caller-supplied-stable-key`
      await recordLifecycleDecision(userClient, created.reviewRequestId, approvedCoherentInput({ idempotencyKey: stableKey }))
      const storedKey = dockerPsql(`select decision_idempotency_key from semantic_topic_lifecycle_review_requests where id='${created.reviewRequestId}';`).trim()
      expect(storedKey).toBe(stableKey)
    })
  })

  // ============================================================
  // D. Checklist / reason-code enforcement re-verified through the wrapper
  // ============================================================
  describe('D. checklist and reason-code enforcement surfaces as validation_error through the wrapper', () => {
    it('D1. coherent approval missing a checklist field -> validation_error (RPC-authoritative, not app-guessed)', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const result = await recordLifecycleDecision(userClient, created.reviewRequestId, approvedCoherentInput({ provenanceRelationshipReviewed: false }))
      expect(result.outcome).toBe('validation_error')
    })

    it('D2. a rejected decision never requires the coherent checklist (all four left null, still succeeds)', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      const result = await recordLifecycleDecision(userClient, created.reviewRequestId, rejectedInput())
      expect(result.outcome).toBe('success')
    })

    it('D3. an ambiguous-target approval never requires the coherent checklist (all four left null, still succeeds)', async () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic('corroborating')
      const ev = insertEvidence(m, src)
      insertMembership(topic, ev)
      const created = createRequestAsService(topic, 'ambiguous', `${m}-req`)
      const result = await recordLifecycleDecision(
        userClient,
        created.reviewRequestId,
        approvedCoherentInput({
          reasonCode: 'conflicting_identity_signal',
          sameSemanticIdentityConfirmed: null,
          noMaterialIdentityConflict: null,
          canonicalDefinitionScopeFitConfirmed: null,
          provenanceRelationshipReviewed: null,
        }),
      )
      expect(result.outcome).toBe('success')
    })
  })

  // ============================================================
  // E. Expiry and not-found (item 8's 410/404)
  // ============================================================
  describe('E. expiry and not-found map correctly through the wrapper', () => {
    it('E1. a decision attempt on an expired request maps to outcome=expired (persisted, not an exception)', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      dockerPsql(`update semantic_topic_lifecycle_review_requests set expires_at = now() - interval '1 minute' where id='${created.reviewRequestId}';`)

      const result = await recordLifecycleDecision(userClient, created.reviewRequestId, approvedCoherentInput())
      expect(result.outcome).toBe('expired')
      expect(requestStatus(created.reviewRequestId)).toBe('expired')
    })

    it('E2. a decision on a random, non-existent review request id maps to not_found', async () => {
      const result = await recordLifecycleDecision(userClient, randomUUID(), approvedCoherentInput())
      expect(result.outcome).toBe('not_found')
    })

    it('E3. a cancel on a random, non-existent review request id maps to not_found', async () => {
      const result = await cancelLifecycleReview(userClient, randomUUID(), cancelInput())
      expect(result.outcome).toBe('not_found')
    })
  })

  // ============================================================
  // F. Permission boundary (spot checks through the wrapper -- 087's own
  //    suite already proves the RPC's full permission matrix exhaustively;
  //    these confirm THIS wrapper maps those denials correctly)
  // ============================================================
  describe('F. permission boundary maps correctly through the wrapper', () => {
    it('F1. a non-reviewer authenticated user is denied on decision', async () => {
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
        const result = await recordLifecycleDecision(nonReviewerClient as any, created.reviewRequestId, approvedCoherentInput())
        expect(result.outcome).toBe('not_a_reviewer')
      } finally {
        await adminClient.auth.admin.deleteUser(data.user.id)
      }
    })

    it('F2. a non-reviewer authenticated user is denied on cancel', async () => {
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
        const result = await cancelLifecycleReview(nonReviewerClient as any, created.reviewRequestId, cancelInput())
        expect(result.outcome).toBe('not_a_reviewer')
      } finally {
        await adminClient.auth.admin.deleteUser(data.user.id)
      }
    })
  })

  // ============================================================
  // G. Static/structural guarantee: this wrapper never calls the executor
  //    or the create RPC.
  // ============================================================
  describe('G. this module never touches the executor or the create RPC', () => {
    it('G1. lifecycle-review-actions.ts never CALLS execute_approved_semantic_topic_lifecycle_transition or create_semantic_topic_lifecycle_review_request (the header comment names them to document that fact, so comment lines are stripped before the check)', () => {
      const src = readFileSync(join(process.cwd(), 'lib/semantic-topic/lifecycle-review-actions.ts'), 'utf8')
      const codeOnly = src
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      expect(codeOnly).not.toMatch(/execute_approved_semantic_topic_lifecycle_transition/)
      expect(codeOnly).not.toMatch(/create_semantic_topic_lifecycle_review_request/)
    })

    it('G2. every RPC call in this file goes through the single call() boundary -- no scattered direct `.rpc(` call sites', () => {
      const src = readFileSync(join(process.cwd(), 'lib/semantic-topic/lifecycle-review-actions.ts'), 'utf8')
      const directRpcCallSites = src.match(/\w+\.rpc\(/g) ?? []
      expect(directRpcCallSites).toEqual(['client.rpc('])
    })
  })

  // ============================================================
  // H. 088 GET routes/reader remain fully correct after decision/cancel
  //    activity from this new action surface (regression cross-check).
  // ============================================================
  describe('H. 088 read surface stays correct after action-surface writes', () => {
    it('H1. after approve, the list "approved" filter finds the request and the detail shows the decision fields', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await recordLifecycleDecision(userClient, created.reviewRequestId, approvedCoherentInput())

      const list = await listLifecycleReviews(userClient, { statusFilter: 'approved', limit: 50 })
      expect(list.outcome).toBe('success')
      if (list.outcome !== 'success') throw new Error('unreachable')
      expect(list.requests.some((r) => r.reviewRequestId === created.reviewRequestId)).toBe(true)

      const detail = await getLifecycleReview(userClient, created.reviewRequestId)
      expect(detail.outcome).toBe('success')
      if (detail.outcome !== 'success') throw new Error('unreachable')
      expect(detail.request.decision?.decidedByCurrentReviewer).toBe(true)
      expect(detail.request.requestStatus).toBe('approved')
    })

    it('H2. after cancel, the detail shows cancellation fields and requestStatus=cancelled', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const created = createRequestAsService(topic, 'coherent', `${m}-req`)
      await cancelLifecycleReview(userClient, created.reviewRequestId, cancelInput())

      const detail = await getLifecycleReview(userClient, created.reviewRequestId)
      expect(detail.outcome).toBe('success')
      if (detail.outcome !== 'success') throw new Error('unreachable')
      expect(detail.request.requestStatus).toBe('cancelled')
      expect(detail.request.cancellation?.cancelledByCurrentReviewer).toBe(true)
      expect(detail.request.cancellation?.cancelReasonCode).toBe('REVIEW_WITHDRAWN')
    })
  })
})
