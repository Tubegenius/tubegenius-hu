// PFM Approved Human Review Executor v0 -- real DB-integration + full local
// E2E, against the REAL local disposable Supabase stack (Kong + PostgREST +
// GoTrue + Postgres), via @supabase/supabase-js, exactly as production
// application code and this CLI's own service module would call it.
//
// Mirrors tests/human-review-app-integration.test.ts's own real-reviewer-
// session pattern for the approval step (a REAL authenticated GoTrue
// session, not a SET LOCAL simulation) -- that file already proves the
// create -> decision(approve) -> executeApprovedReview() chain works at the
// wrapper layer in general; this file adds the SAME chain driven through
// THIS module's own runExecuteApprovedReview() (the CLI-support layer),
// plus the idempotency/concurrency/not-executable/blocked closure this
// gate specifically requires.
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// Real network + docker-exec round trips per test (auth signup/signin,
// multiple RPC calls, several psql invocations) routinely exceed Vitest's
// default 5000ms per-test timeout -- every it() below explicitly passes
// 30_000 as its timeout argument (a beforeAll-scoped vi.setConfig() call
// was tried first but does not retroactively affect timeouts already
// captured at test-collection time).
import {
  EXECUTOR_EXIT_CODE,
  exitCodeForExecutorOutcome,
  runExecuteApprovedReview,
} from '@/lib/semantic-topic/execute-approved-review-cli-support'

const LOCAL_API_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const adminClient = createClient(LOCAL_API_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', { input: sql, encoding: 'utf-8' })
}

let stackAvailable = false
try {
  execSync(`curl -sf ${LOCAL_API_URL}/auth/v1/health -H "apikey: ${LOCAL_ANON_KEY}"`, { stdio: 'ignore' })
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}
const describeIfLocalStack = stackAvailable ? describe : describe.skip

const MARKER = 'earx-e2e'
const REVIEWER_EMAIL = `${MARKER}-reviewer-${Date.now()}@example.test`
const REVIEWER_PASSWORD = `Test-${randomUUID()}-!Aa1`
let reviewerUserId: string
let userClient: ReturnType<typeof createClient>

function structuredOutput(overrides: Record<string, unknown> = {}): string {
  const base = {
    extraction_schema_version: 1, canonical_phenomenon_label: 'executor db-integration fixture', label_language: 'en',
    subject_entities: ['E'], action_or_event: null, location: null, temporal_context: null,
    specificity: 'specific', content_format: 'other', confidence: 0.55,
    supporting_spans: [{ source_field: 'title', quoted_text: 'executor db-integration fixture' }], ...overrides,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

function createExtractionFixture(marker: string): { evidenceId: string; extractionRunId: string } {
  const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${marker}-src', '${marker}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${marker}-run', 'completed', now()) returning id;`).trim()
  const evidenceId = dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${marker}-ev', '${MARKER} fixture', '${runId}') returning id;`).trim()
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
    'norm-${marker}', 1, 'completed', '${structuredOutput()}'::jsonb, 100, 50, 0.001, NULL,
    '${marker}-ext', now() - interval '1 minute', now()
  );`
  const result = JSON.parse(dockerPsql(sql).trim())
  return { evidenceId, extractionRunId: result.extraction_run_id }
}

async function createApprovedRequest(marker: string, proposedOutcome: 'CREATE_NEW' = 'CREATE_NEW'): Promise<{ reviewRequestId: string; extractionRunId: string }> {
  const { createReviewRequest } = await import('@/lib/semantic-topic/human-review-service')
  const { recordDecision } = await import('@/lib/semantic-topic/human-review-reviewer')
  const { extractionRunId } = createExtractionFixture(marker)
  const created = await createReviewRequest({ extractionRunId, idempotencyKey: `${marker}-create` }, adminClient as any)
  if (created.outcome !== 'success') throw new Error(`fixture setup failed: createReviewRequest ${JSON.stringify(created)}`)
  const decision = await recordDecision(userClient as any, created.reviewRequestId, `${marker}-dec`, {
    outcome: 'approved',
    canonicalTopicLabel: `${MARKER} approved topic ${marker}`,
    topicDefinition: 'A definition.',
    scope: 'A scope.',
    inclusionCriteria: 'Incl.',
    exclusionCriteria: 'Excl.',
    laneNeutralConfirmed: true,
    evidenceAdequacy: 'adequate',
    duplicateSearchOutcome: 'no_duplicate_found',
    proposedOutcome,
    targetSemanticTopicId: null,
    uncertaintyClassification: 'low',
    reviewerRationale: 'Clear and well-evidenced.',
    reviewPolicyVersion: 1,
  })
  if (decision.outcome !== 'success') throw new Error(`fixture setup failed: recordDecision ${JSON.stringify(decision)}`)
  return { reviewRequestId: created.reviewRequestId, extractionRunId }
}

function counts() {
  return {
    topics: Number(dockerPsql(`select count(*) from semantic_topics where canonical_label like '${MARKER} %';`).trim()),
    memberships: Number(dockerPsql(`select count(*) from semantic_topic_membership where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');`).trim()),
    membershipEvents: Number(dockerPsql(`select count(*) from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');`).trim()),
    decisions: Number(dockerPsql(`select count(*) from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');`).trim()),
    reviewEvents: Number(dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%')));`).trim()),
    reservations: Number(dockerPsql(`select count(*) from ai_provider_budget_reservations where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));`).trim()),
    intakeBatches: Number(dockerPsql(`select count(*) from supervised_intake_batches;`).trim()),
  }
}

function cleanupFixtures() {
  dockerPsql(`
    delete from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%')));
    delete from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
    delete from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topic_membership where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topics where canonical_label like '${MARKER} %';
    delete from ai_provider_budget_reservations where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
  `)
}

describeIfLocalStack('Approved Human Review Executor v0 -- real DB-integration + full local E2E', () => {
  beforeAll(async () => {
    cleanupFixtures()
    const { data, error } = await adminClient.auth.admin.createUser({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD, email_confirm: true })
    if (error || !data.user) throw new Error(`failed to create fixture reviewer user: ${error?.message}`)
    reviewerUserId = data.user.id
    dockerPsql(`insert into semantic_topic_reviewers (user_id, provisioning_note) values ('${reviewerUserId}', '${MARKER} fixture -- not a real bootstrap') on conflict do nothing;`)
    userClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
    const signIn = await userClient.auth.signInWithPassword({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD })
    if (signIn.error) throw new Error(`fixture reviewer sign-in failed: ${signIn.error.message}`)
  })

  afterAll(async () => {
    try {
      cleanupFixtures()
    } finally {
      try {
        dockerPsql(`delete from semantic_topic_reviewer_events where reviewer_user_id='${reviewerUserId}'; delete from semantic_topic_reviewers where user_id='${reviewerUserId}';`)
      } finally {
        if (reviewerUserId) await adminClient.auth.admin.deleteUser(reviewerUserId)
      }
    }
    // Baseline restoration check -- this suite must never leave the shared
    // controls touched (it never opens them in the first place, but this
    // proves that, not merely assumes it).
    expect(dockerPsql('select enabled from ai_extraction_control where id=1;').trim()).toBe('f')
    expect(dockerPsql('select enabled from supervised_intake_control where id=1;').trim()).toBe('f')
  })

  // ===========================================================================
  // Section I: full local E2E through THIS module's own public API.
  // ===========================================================================
  it('full chain: pending -> approve (real app-layer API, real authenticated reviewer session) -> dry_run -> executed -> candidate_singleton topic + correct membership/decision/audit -> replay, zero duplication', async () => {
    const m = `${MARKER}-full-${Date.now()}`
    const { reviewRequestId, extractionRunId } = await createApprovedRequest(m)
    // Baseline taken AFTER create+approve (both expected, intentional side
    // effects of the fixture setup, not part of what this test measures) --
    // NOT before it, so the dry-run-must-not-write assertion below isn't
    // comparing against a state that predates the approval itself.
    const before = counts()

    const dryRun = await runExecuteApprovedReview(adminClient as any, { reviewRequestId, dryRun: true })
    expect(dryRun.kind).toBe('dry_run')
    if (dryRun.kind === 'dry_run') {
      expect(dryRun.preview.status).toBe('approved')
      expect(dryRun.preview.canonicalTopicLabel).toBe(`${MARKER} approved topic ${m}`)
      expect(dryRun.preview.expectedLifecycle).toBe('candidate_singleton')
      expect(dryRun.preview.expectedSideEffectCount).toEqual({ events: 1, topics: 1, memberships: 1, membershipEvents: 1, decisions: 1 })
    }
    // Dry-run must never write.
    const afterDryRun = counts()
    expect(afterDryRun).toEqual(before)

    const executed = await runExecuteApprovedReview(adminClient as any, { reviewRequestId, dryRun: false })
    expect(executed.kind).toBe('executed')
    expect(exitCodeForExecutorOutcome(executed)).toBe(EXECUTOR_EXIT_CODE.OK)

    const after = counts()
    expect(after.topics).toBe(before.topics + 1)
    expect(after.memberships).toBe(before.memberships + 1)
    expect(after.membershipEvents).toBe(before.membershipEvents + 1)
    expect(after.decisions).toBe(before.decisions + 1)
    expect(after.reviewEvents).toBe(before.reviewEvents + 1) // 'executed' only -- 'approved' already counted in `before`

    const lifecycle = dockerPsql(`select lifecycle_status from semantic_topics where canonical_label = '${MARKER} approved topic ${m}';`).trim()
    expect(lifecycle).toBe('candidate_singleton')

    const requestStatus = dockerPsql(`select status from topic_assignment_review_requests where id='${reviewRequestId}';`).trim()
    expect(requestStatus).toBe('executed')

    const decisionOutcome = dockerPsql(`select outcome, decision_reason from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
    expect(decisionOutcome).toBe('CREATE_NEW|human_review_approved')

    // Replay -- must reproduce the SAME decision id, zero new rows.
    const replayed = await runExecuteApprovedReview(adminClient as any, { reviewRequestId, dryRun: false })
    expect(replayed.kind).toBe('replayed')
    if (replayed.kind === 'replayed' && executed.kind === 'executed') {
      expect(replayed.resultingDecisionIdPrefix).toBe(executed.decisionIdPrefix)
    }
    const afterReplay = counts()
    expect(afterReplay).toEqual(after)

    // Side-effect zero: no provider reservation, no new intake batch.
    expect(after.reservations).toBe(before.reservations)
    expect(afterReplay.intakeBatches).toBe(before.intakeBatches)
  }, 30_000)

  // ===========================================================================
  // Section H.3: concurrency -- two parallel calls against the SAME fresh
  // approved request must produce exactly one execution and one replay,
  // never two executions, never any duplicated row.
  // ===========================================================================
  it('two concurrent executions of the same approved request: exactly one topic/membership/decision, one executed + one replayed', async () => {
    const m = `${MARKER}-conc-${Date.now()}`
    const before = counts()
    const { reviewRequestId } = await createApprovedRequest(m)

    const [a, b] = await Promise.all([
      runExecuteApprovedReview(adminClient as any, { reviewRequestId, dryRun: false }),
      runExecuteApprovedReview(adminClient as any, { reviewRequestId, dryRun: false }),
    ])
    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(['executed', 'replayed'])

    const after = counts()
    expect(after.topics).toBe(before.topics + 1)
    expect(after.memberships).toBe(before.memberships + 1)
    expect(after.decisions).toBe(before.decisions + 1)
  }, 30_000)

  // ===========================================================================
  // Section H.4: not-executable states.
  // ===========================================================================
  it('pending request (never approved): not_executable, zero writes', async () => {
    const m = `${MARKER}-pending-${Date.now()}`
    const { createReviewRequest } = await import('@/lib/semantic-topic/human-review-service')
    const { extractionRunId } = createExtractionFixture(m)
    const created = await createReviewRequest({ extractionRunId, idempotencyKey: `${m}-create` }, adminClient as any)
    expect(created.outcome).toBe('success')
    if (created.outcome !== 'success') return
    const before = counts()

    const outcome = await runExecuteApprovedReview(adminClient as any, { reviewRequestId: created.reviewRequestId, dryRun: false })
    expect(outcome).toEqual({ kind: 'not_executable', status: 'pending' })
    expect(counts()).toEqual(before)
  }, 30_000)

  it('rejected request: not_executable, zero writes', async () => {
    const m = `${MARKER}-rejected-${Date.now()}`
    const { createReviewRequest } = await import('@/lib/semantic-topic/human-review-service')
    const { recordDecision } = await import('@/lib/semantic-topic/human-review-reviewer')
    const { extractionRunId } = createExtractionFixture(m)
    const created = await createReviewRequest({ extractionRunId, idempotencyKey: `${m}-create` }, adminClient as any)
    expect(created.outcome).toBe('success')
    if (created.outcome !== 'success') return
    const decision = await recordDecision(userClient as any, created.reviewRequestId, `${m}-dec`, {
      outcome: 'rejected', rejectionReason: 'insufficient_evidence', reviewerRationale: 'Not enough.', reviewPolicyVersion: 1,
    })
    expect(decision.outcome).toBe('success')
    const before = counts()

    const outcome = await runExecuteApprovedReview(adminClient as any, { reviewRequestId: created.reviewRequestId, dryRun: false })
    expect(outcome).toEqual({ kind: 'not_executable', status: 'rejected' })
    expect(counts()).toEqual(before)
  }, 30_000)

  it('cancelled request (via the real cancel RPC, pending state): not_executable, zero writes', async () => {
    const m = `${MARKER}-cancelled-${Date.now()}`
    const { createReviewRequest } = await import('@/lib/semantic-topic/human-review-service')
    const { extractionRunId } = createExtractionFixture(m)
    const created = await createReviewRequest({ extractionRunId, idempotencyKey: `${m}-create` }, adminClient as any)
    expect(created.outcome).toBe('success')
    if (created.outcome !== 'success') return
    const cancelResult = await (userClient as any).rpc('cancel_topic_assignment_review_request', { p_review_request_id: created.reviewRequestId })
    expect(cancelResult.error).toBeNull()
    const before = counts()

    const outcome = await runExecuteApprovedReview(adminClient as any, { reviewRequestId: created.reviewRequestId, dryRun: false })
    expect(outcome).toEqual({ kind: 'not_executable', status: 'cancelled' })
    expect(counts()).toEqual(before)
  }, 30_000)

  it('revoked approval (via the real revoke RPC): not_executable, zero writes', async () => {
    const m = `${MARKER}-revoked-${Date.now()}`
    const { reviewRequestId } = await createApprovedRequest(m)
    const revokeResult = await (userClient as any).rpc('revoke_topic_assignment_review_approval', { p_review_request_id: reviewRequestId })
    expect(revokeResult.error).toBeNull()
    const before = counts()

    const outcome = await runExecuteApprovedReview(adminClient as any, { reviewRequestId, dryRun: false })
    expect(outcome).toEqual({ kind: 'not_executable', status: 'revoked' })
    expect(counts()).toEqual(before)
  }, 30_000)

  it('expired request (status forced via SQL, matching what the real expiry sweeper would produce): not_executable, zero writes', async () => {
    const m = `${MARKER}-expired-${Date.now()}`
    const { createReviewRequest } = await import('@/lib/semantic-topic/human-review-service')
    const { extractionRunId } = createExtractionFixture(m)
    const created = await createReviewRequest({ extractionRunId, idempotencyKey: `${m}-create` }, adminClient as any)
    expect(created.outcome).toBe('success')
    if (created.outcome !== 'success') return
    dockerPsql(`update topic_assignment_review_requests set status='expired' where id='${created.reviewRequestId}';`)
    const before = counts()

    const outcome = await runExecuteApprovedReview(adminClient as any, { reviewRequestId: created.reviewRequestId, dryRun: false })
    expect(outcome).toEqual({ kind: 'not_executable', status: 'expired' })
    expect(counts()).toEqual(before)
  }, 30_000)

  // ===========================================================================
  // Section H.5: blocked business-rule conditions, driven through the REAL
  // RPC (not simulated at this module's own classifier level -- that's
  // already covered by the mocked unit tests; this proves the actual 078
  // RPC really does raise these exact messages).
  // ===========================================================================
  it('reviewer deactivated between approval and execution: blocked/REVIEWER_NO_LONGER_ACTIVE, zero writes', async () => {
    const m = `${MARKER}-deactivated-${Date.now()}`
    const { reviewRequestId } = await createApprovedRequest(m)
    try {
      dockerPsql(`update semantic_topic_reviewers set active=false, deactivated_at=now(), deactivated_by_user_id='${reviewerUserId}' where user_id='${reviewerUserId}';`)
      const before = counts()
      const outcome = await runExecuteApprovedReview(adminClient as any, { reviewRequestId, dryRun: false })
      expect(outcome).toEqual({ kind: 'blocked', reasonCode: 'REVIEWER_NO_LONGER_ACTIVE' })
      expect(exitCodeForExecutorOutcome(outcome)).toBe(EXECUTOR_EXIT_CODE.BLOCKED)
      expect(counts()).toEqual(before)
    } finally {
      // Restore immediately -- every other test in this file depends on
      // this same fixture reviewer staying active.
      dockerPsql(`update semantic_topic_reviewers set active=true, deactivated_at=NULL, deactivated_by_user_id=NULL where user_id='${reviewerUserId}';`)
    }
  }, 30_000)

  it('extraction_run already has a topic_assignment_decisions row (created by a different path after approval): blocked/EXTRACTION_RUN_ALREADY_DECIDED, zero ADDITIONAL writes', async () => {
    const m = `${MARKER}-alreadydecided-${Date.now()}`
    const { reviewRequestId, extractionRunId } = await createApprovedRequest(m)
    // Simulate a conflicting decision created through some other path
    // (never possible in this exact form through this codebase's own real
    // flows, since 078's create-request RPC already blocks that -- this
    // directly exercises the executor RPC's own defense-in-depth
    // pre-check, independent of how such a row could arise).
    dockerPsql(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, '${m}-conflict', NULL);`)
    const before = counts()

    const outcome = await runExecuteApprovedReview(adminClient as any, { reviewRequestId, dryRun: false })
    expect(outcome).toEqual({ kind: 'blocked', reasonCode: 'EXTRACTION_RUN_ALREADY_DECIDED' })
    expect(counts()).toEqual(before)
  }, 30_000)
})
