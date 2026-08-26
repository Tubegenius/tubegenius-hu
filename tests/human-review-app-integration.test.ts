// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, REAL
// application-layer end-to-end test. Unlike every other *-db-integration
// test in this repo (which drives the DB via raw psql), this file exercises
// the ACTUAL TypeScript wrapper functions (human-review-service.ts /
// human-review-reviewer.ts / human-review-extraction-hook.ts) against the
// REAL local Supabase stack -- Kong (API gateway) + PostgREST + GoTrue
// (auth) + Postgres, all already running as part of this repo's local `npx
// supabase start` Docker stack -- via @supabase/supabase-js, exactly the way
// production application code would call them. This is the "extraction
// result -> pending review request -> reviewer list/get" local E2E this
// gate requires; the 078 RPC suite already proves the SQL contract
// exhaustively via raw psql, so this file deliberately does not repeat that
// -- it proves the JS wrapper layer's request/response shapes, auth.uid()
// resolution through a REAL authenticated session (not a SET LOCAL
// simulation), and error-mapping all work correctly over the real REST
// transport.
//
// Credentials used: the LOCAL Supabase CLI's well-known, publicly-documented
// default demo JWTs (anon/service_role) for a stock `supabase init` project
// with no custom auth.jwt_secret override (confirmed via
// supabase/config.toml -- no override is set). These are NOT this project's
// secrets: they are the same fixed, publicly published tokens every local
// Supabase CLI stack uses by default (documented in Supabase's own
// self-hosting guide), safe to hardcode for a local-only, disposable Docker
// stack. .env.local was never read to obtain them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

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

const MARKER = 'sti-app'
const REVIEWER_EMAIL = `${MARKER}-reviewer-${Date.now()}@example.test`
const REVIEWER_PASSWORD = `Test-${randomUUID()}-!Aa1`
let reviewerUserId: string

function structuredOutput(overrides: Record<string, unknown> = {}): string {
  const base = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: 'App-layer E2E phenomenon',
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'other',
    confidence: 0.71,
    supporting_spans: [{ source_field: 'title', quoted_text: 'App-layer E2E phenomenon' }],
    ...overrides,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

function createExtractionFixture(): { evidenceId: string; extractionRunId: string } {
  const m = `${MARKER}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
  const evidenceId = dockerPsql(
    `insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${m}-ev', '${MARKER} fixture evidence', '${runId}') returning id;`,
  ).trim()
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
    'norm-${m}', 1, 'completed', '${structuredOutput()}'::jsonb, 100, 50, 0.001, NULL,
    '${m}-ext', now() - interval '1 minute', now()
  );`
  const result = JSON.parse(dockerPsql(sql).trim())
  return { evidenceId, extractionRunId: result.extraction_run_id }
}

function cleanupFixtures() {
  dockerPsql(`
    delete from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%')));
    delete from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
    delete from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topic_membership where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topics where canonical_label = 'App-layer E2E topic';
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
  `)
}

describeIfLocalStack('Human-Reviewed Candidate Workflow -- real application-layer E2E (local Supabase stack)', () => {
  beforeAll(async () => {
    cleanupFixtures()
    const { data, error } = await adminClient.auth.admin.createUser({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD, email_confirm: true })
    if (error || !data.user) throw new Error(`failed to create fixture reviewer user: ${error?.message}`)
    reviewerUserId = data.user.id
    dockerPsql(`insert into semantic_topic_reviewers (user_id, provisioning_note) values ('${reviewerUserId}', '${MARKER} fixture -- not a real bootstrap') on conflict do nothing;`)
  })

  afterAll(async () => {
    // finally-guaranteed: a failure in one cleanup step (e.g. a FK-ordering
    // gap in cleanupFixtures) must never orphan the fixture reviewer
    // user/row -- learned the hard way when an earlier version of
    // cleanupFixtures() threw here and left both stranded until the next
    // manual audit found them.
    try {
      cleanupFixtures()
    } finally {
      try {
        dockerPsql(`delete from semantic_topic_reviewer_events where reviewer_user_id='${reviewerUserId}'; delete from semantic_topic_reviewers where user_id='${reviewerUserId}';`)
      } finally {
        if (reviewerUserId) await adminClient.auth.admin.deleteUser(reviewerUserId)
      }
    }
  })

  it('extraction result -> createReviewRequest (service wrapper, real REST) -> pending row', async () => {
    const { createReviewRequest } = await import('@/lib/semantic-topic/human-review-service')
    const { extractionRunId } = createExtractionFixture()

    const result = await createReviewRequest({ extractionRunId, idempotencyKey: `${MARKER}-create-${extractionRunId}` }, adminClient as any)
    expect(result.outcome).toBe('success')
    if (result.outcome !== 'success') return
    expect(result.status).toBe('pending')
    expect(result.generation).toBe(1)

    // Real, authenticated (not SET LOCAL-simulated) reviewer session.
    const userClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
    const signIn = await userClient.auth.signInWithPassword({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD })
    expect(signIn.error).toBeNull()

    const { listPendingReviews, getReview } = await import('@/lib/semantic-topic/human-review-reviewer')
    const listResult = await listPendingReviews(userClient as any, { limit: 20 })
    expect(listResult.outcome).toBe('success')
    if (listResult.outcome !== 'success') return
    const match = listResult.requests.find((r) => r.reviewRequestId === result.reviewRequestId)
    expect(match).toBeTruthy()
    expect(match?.candidateLabel).toBe('App-layer E2E phenomenon')

    const getResult = await getReview(userClient as any, result.reviewRequestId)
    expect(getResult.outcome).toBe('success')
    if (getResult.outcome !== 'success') return
    expect(getResult.request.status).toBe('pending')
    expect(getResult.request.decision).toBeNull()
  })

  it('a non-reviewer authenticated session is rejected by the real RPC (not_a_reviewer)', async () => {
    const { data, error } = await adminClient.auth.admin.createUser({ email: `${MARKER}-nonreviewer-${Date.now()}@example.test`, password: REVIEWER_PASSWORD, email_confirm: true })
    expect(error).toBeNull()
    const nonReviewerId = data!.user!.id
    try {
      const userClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
      await userClient.auth.signInWithPassword({ email: data!.user!.email!, password: REVIEWER_PASSWORD })
      const { listPendingReviews } = await import('@/lib/semantic-topic/human-review-reviewer')
      const result = await listPendingReviews(userClient as any, {})
      expect(result.outcome).toBe('not_a_reviewer')
    } finally {
      await adminClient.auth.admin.deleteUser(nonReviewerId)
    }
  })

  it('full lifecycle through the wrapper layer: create -> decision (approve, CREATE_NEW) -> execute -> verify', async () => {
    const { createReviewRequest, executeApprovedReview } = await import('@/lib/semantic-topic/human-review-service')
    const { recordDecision } = await import('@/lib/semantic-topic/human-review-reviewer')
    const { extractionRunId } = createExtractionFixture()

    const created = await createReviewRequest({ extractionRunId, idempotencyKey: `${MARKER}-lc-create-${extractionRunId}` }, adminClient as any)
    expect(created.outcome).toBe('success')
    if (created.outcome !== 'success') return

    const userClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
    await userClient.auth.signInWithPassword({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD })

    const decision = await recordDecision(userClient as any, created.reviewRequestId, `${MARKER}-lc-dec-${extractionRunId}`, {
      outcome: 'approved',
      canonicalTopicLabel: 'App-layer E2E topic',
      topicDefinition: 'A definition.',
      scope: 'A scope.',
      inclusionCriteria: 'Incl.',
      exclusionCriteria: 'Excl.',
      laneNeutralConfirmed: true,
      evidenceAdequacy: 'adequate',
      duplicateSearchOutcome: 'no_duplicate_found',
      proposedOutcome: 'CREATE_NEW',
      targetSemanticTopicId: null,
      uncertaintyClassification: 'low',
      reviewerRationale: 'Clear and well-evidenced.',
      reviewPolicyVersion: 1,
    })
    expect(decision.outcome).toBe('success')
    if (decision.outcome !== 'success') return
    expect(decision.result).toBe('approved')
    expect(decision.approvalDigest).toMatch(/^[0-9a-f]{64}$/)

    const executed = await executeApprovedReview({ reviewRequestId: created.reviewRequestId, idempotencyKey: `${MARKER}-lc-exec-${extractionRunId}` }, adminClient as any)
    expect(executed.outcome).toBe('success')
    if (executed.outcome !== 'success') return
    expect(executed.result).toBe('executed')
    expect(executed.proposedOutcome).toBe('CREATE_NEW')
    expect(executed.semanticTopicId).toBeTruthy()
  })

  it('maybeRequestHumanReview: flag disabled is a true no-op (no RPC call at all)', async () => {
    delete process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const { extractionRunId } = createExtractionFixture()
    const result = await maybeRequestHumanReview({ extractionRunId, client: adminClient as any })
    expect(result.outcome).toBe('flag_disabled')
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('0')
  })

  it('maybeRequestHumanReview: flag enabled creates a request for an eligible extraction, with a stable retry key', async () => {
    process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED = 'true'
    try {
      const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
      const { extractionRunId } = createExtractionFixture()
      const first = await maybeRequestHumanReview({ extractionRunId, client: adminClient as any })
      expect(first.outcome).toBe('created')
      const second = await maybeRequestHumanReview({ extractionRunId, client: adminClient as any })
      expect(second.outcome).toBe('replayed')
      if (first.outcome === 'created' && second.outcome === 'replayed') {
        expect(second.reviewRequestId).toBe(first.reviewRequestId)
      }
      const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
      expect(rowCount).toBe('1')
    } finally {
      delete process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
    }
  })

  it('maybeRequestHumanReview: an ineligible (high-confidence) extraction is a controlled not_eligible, not an error', async () => {
    process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED = 'true'
    try {
      const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
      const { extractionRunId } = createExtractionFixture()
      dockerPsql(`update topic_extraction_runs set structured_output = jsonb_set(structured_output, '{confidence}', '0.9') where id='${extractionRunId}';`)
      const result = await maybeRequestHumanReview({ extractionRunId, client: adminClient as any })
      expect(result.outcome).toBe('not_eligible')
    } finally {
      delete process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
    }
  })
})
