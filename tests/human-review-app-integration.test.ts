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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// Live-orchestration section (below) calls the REAL runShadowExtraction()
// end to end -- every layer genuine (quota RPCs, extraction-run RPC, the
// human-review hook, all against the real local Supabase stack) EXCEPT the
// actual AI provider call, which is mocked here so this file never makes a
// real network call to Anthropic (forbidden for this gate). This mirrors
// tests/semantic-topic-s3a-extraction-service.test.ts's own
// callAnthropicForExtraction mock, just keeping every other layer real
// instead of also mocking ai-quota/extraction-writer.
vi.mock('@/lib/semantic-topic/provider-adapter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/semantic-topic/provider-adapter')>('@/lib/semantic-topic/provider-adapter')
  return { ...actual, callAnthropicForExtraction: vi.fn() }
})

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

// For the live-orchestration section: creates ONLY the signal_evidence row
// (not the extraction run itself) -- runShadowExtraction() is what will
// create the topic_extraction_runs row, exactly as it would for a real
// caller. The title MUST exactly match what runOrchestration() passes as
// evidence.title -- reserve_ai_provider_units re-derives the canonical
// normalized input from this DB row itself and rejects any caller-supplied
// text that doesn't match it byte-for-byte (a documented, deliberate
// anti-tampering/stale-snapshot check from the S3A AI-quota gate).
const ORCHESTRATION_EVIDENCE_TITLE = 'Live orchestration fixture'

function createSignalEvidenceOnly(): { evidenceId: string; marker: string } {
  const m = `${MARKER}-orch-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
  const evidenceId = dockerPsql(
    `insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${m}-ev', '${ORCHESTRATION_EVIDENCE_TITLE}', '${runId}') returning id;`,
  ).trim()
  return { evidenceId, marker: m }
}

function cleanupFixtures() {
  dockerPsql(`
    delete from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%')));
    delete from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
    delete from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topic_membership where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topics where canonical_label = 'App-layer E2E topic';
    delete from ai_provider_budget_reservations where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
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
    expect(result.outcome).toBe('disabled')
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

  // ------------------------------------------------------------
  // Live orchestration: runShadowExtraction() itself now calls the hook
  // (Application Integration Closure gate) -- these tests call the REAL
  // orchestration entry point, not the hook directly. Only the AI provider
  // call is mocked (see the vi.mock at the top of this file); the quota
  // RPCs, the extraction-run RPC, and the human-review RPCs are all real,
  // against the real local Supabase stack.
  // ------------------------------------------------------------
  describe('live orchestration: runShadowExtraction() -> maybeRequestHumanReview()', () => {
    const SUBTHRESHOLD_OUTPUT = {
      extraction_schema_version: 1,
      canonical_phenomenon_label: 'Live orchestration phenomenon',
      label_language: 'en',
      subject_entities: ['Entity A'],
      action_or_event: null,
      location: null,
      temporal_context: null,
      specificity: 'specific' as const,
      content_format: 'other' as const,
      confidence: 0.7,
      supporting_spans: [{ source_field: 'title', quoted_text: 'Live orchestration phenomenon' }],
    }
    const HIGH_CONFIDENCE_OUTPUT = { ...SUBTHRESHOLD_OUTPUT, confidence: 0.9 }

    // runShadowExtraction()'s quota-reservation step (reserve_ai_provider_units)
    // is gated by the SEPARATE, DB-side ai_extraction_control kill-switch --
    // unrelated to SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED. This local/disposable
    // DB currently has it enabled=false (an unrelated prior gate's own
    // documented end-state), so these tests would otherwise universally see
    // 'disabled_or_rejected' regardless of the human-review flag. Save the
    // real original value and restore it exactly (not hardcoded back to
    // false) -- this control is shared with other test files.
    let originalControlEnabled: boolean
    // Same reasoning for the daily request/spend counters
    // (ai_provider_daily_budgets, limit_requests=10/day per S3A's pinned
    // AI_QUOTA_MAX_REQUESTS_PER_UTC_DAY) -- this local/disposable DB's
    // today's-UTC-date row had already reached its request cap from this
    // session's own earlier test runs, which would otherwise make every
    // orchestration test below see 'budget_exhausted' regardless of the
    // human-review flag. Save the exact prior counters (not just "reset to
    // zero") and restore them exactly -- this row is shared with other test
    // files/real usage on the same UTC day.
    let savedBudgetCounters: Record<string, string> | null = null
    beforeAll(() => {
      originalControlEnabled = dockerPsql(`select enabled from ai_extraction_control where id=1;`).trim() === 't'
      dockerPsql(`update ai_extraction_control set enabled=true, updated_at=now() where id=1;`)
      // PFM Identity-Linked Workspace Header Support v0: runShadowExtraction
      // (the REAL module, not mocked here -- only provider-adapter.ts's
      // callAnthropicForExtraction is mocked, per runOrchestration below)
      // now fails closed on a missing ANTHROPIC_WORKSPACE_ID before this
      // suite's own reservation/provider-mock flow is ever reached.
      process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ'

      const row = dockerPsql(
        `select reserved_requests, committed_requests, released_requests_total, reserved_micro_usd, committed_micro_usd, released_micro_usd_total from ai_provider_daily_budgets where provider='anthropic' and usage_type='semantic_topic_extraction' and model='claude-sonnet-4-6' and quota_date=current_date;`,
      ).trim()
      if (row) {
        const [reservedRequests, committedRequests, releasedRequestsTotal, reservedMicroUsd, committedMicroUsd, releasedMicroUsdTotal] = row.split('|')
        savedBudgetCounters = { reservedRequests, committedRequests, releasedRequestsTotal, reservedMicroUsd, committedMicroUsd, releasedMicroUsdTotal }
        dockerPsql(
          `update ai_provider_daily_budgets set reserved_requests=0, committed_requests=0, released_requests_total=0, reserved_micro_usd=0, committed_micro_usd=0, released_micro_usd_total=0, updated_at=now() where provider='anthropic' and usage_type='semantic_topic_extraction' and model='claude-sonnet-4-6' and quota_date=current_date;`,
        )
      }
    })
    afterAll(() => {
      dockerPsql(`update ai_extraction_control set enabled=${originalControlEnabled}, updated_at=now() where id=1;`)
      delete process.env.ANTHROPIC_WORKSPACE_ID
      // This inner afterAll runs BEFORE the outer describe's own afterAll
      // (which calls cleanupFixtures()) -- vitest/jest run nested afterAll
      // hooks innermost-first. If the row didn't exist before this suite
      // (savedBudgetCounters is null) and we try to DELETE it here, it
      // still has live ai_provider_budget_reservations rows pointing at it
      // (this suite's own reservations, not yet removed by the outer
      // cleanup) -- violating the FK. Clean up this suite's own
      // reservations FIRST (idempotent -- the outer cleanupFixtures() call
      // later finds nothing left to do).
      cleanupFixtures()
      if (savedBudgetCounters) {
        const c = savedBudgetCounters as Record<string, string>
        dockerPsql(
          `update ai_provider_daily_budgets set reserved_requests=${c.reservedRequests}, committed_requests=${c.committedRequests}, released_requests_total=${c.releasedRequestsTotal}, reserved_micro_usd=${c.reservedMicroUsd}, committed_micro_usd=${c.committedMicroUsd}, released_micro_usd_total=${c.releasedMicroUsdTotal}, updated_at=now() where provider='anthropic' and usage_type='semantic_topic_extraction' and model='claude-sonnet-4-6' and quota_date=current_date;`,
        )
      } else {
        // The row didn't exist before this suite ran (it was created fresh
        // by these tests' own reservations) -- remove it entirely rather
        // than leaving a partially-used, artificially-existing row behind.
        dockerPsql(`delete from ai_provider_daily_budgets where provider='anthropic' and usage_type='semantic_topic_extraction' and model='claude-sonnet-4-6' and quota_date=current_date;`)
      }
    })

    async function runOrchestration(parsedJson: unknown, idempotencyKey: string) {
      const { callAnthropicForExtraction } = await import('@/lib/semantic-topic/provider-adapter')
      ;(callAnthropicForExtraction as any).mockResolvedValueOnce({ rawText: JSON.stringify(parsedJson), parsedJson, inputTokens: 100, outputTokens: 50 })
      const { runShadowExtraction } = await import('@/lib/semantic-topic/extraction-service')
      const { evidenceId } = createSignalEvidenceOnly()
      return runShadowExtraction({
        signalEvidenceId: evidenceId,
        evidence: { title: ORCHESTRATION_EVIDENCE_TITLE, snippet: null, canonicalUrl: null, publishedAt: null },
        idempotencyKey,
        client: adminClient as any,
      })
    }

    it('1. flag=false: canonical extraction completes, human review RPC never called, provider called exactly once, old behavior byte-identical', async () => {
      delete process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
      const { callAnthropicForExtraction } = await import('@/lib/semantic-topic/provider-adapter')
      const before = (callAnthropicForExtraction as any).mock.calls.length
      const result = await runOrchestration(SUBTHRESHOLD_OUTPUT, `${MARKER}-orch-flagoff-${Date.now()}`)
      expect(result.outcome).toBe('completed')
      if (result.outcome !== 'completed') return
      expect(result.humanReview).toEqual({ outcome: 'disabled' })
      expect((callAnthropicForExtraction as any).mock.calls.length - before).toBe(1)
      const reqCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${result.extractionRunId}';`).trim()
      expect(reqCount).toBe('0')
    })

    it('2. flag=true, eligible sub-threshold extraction: live orchestration auto-creates a pending request; requested event exists; no decision/topic/membership; reviewer list/get sees it', async () => {
      process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED = 'true'
      try {
        const result = await runOrchestration(SUBTHRESHOLD_OUTPUT, `${MARKER}-orch-eligible-${Date.now()}`)
        expect(result.outcome).toBe('completed')
        if (result.outcome !== 'completed') return
        expect(result.humanReview.outcome).toBe('created')
        if (result.humanReview.outcome !== 'created') return

        const eventCount = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${result.humanReview.reviewRequestId}' and event_type='requested';`).trim()
        expect(eventCount).toBe('1')
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${result.extractionRunId}';`).trim()
        expect(decisionCount).toBe('0')
        const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where signal_evidence_id in (select signal_evidence_id from topic_extraction_runs where id='${result.extractionRunId}');`).trim()
        expect(membershipCount).toBe('0')

        const userClient = createClient(LOCAL_API_URL, LOCAL_ANON_KEY)
        await userClient.auth.signInWithPassword({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD })
        const { getReview } = await import('@/lib/semantic-topic/human-review-reviewer')
        const seen = await getReview(userClient as any, result.humanReview.reviewRequestId)
        expect(seen.outcome).toBe('success')
        if (seen.outcome === 'success') expect(seen.request.status).toBe('pending')
      } finally {
        delete process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
      }
    })

    it('3. same orchestration retried (identical idempotency key): no second request, no second requested event, replay result', async () => {
      process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED = 'true'
      try {
        const key = `${MARKER}-orch-retry-${Date.now()}`
        const { callAnthropicForExtraction } = await import('@/lib/semantic-topic/provider-adapter')
        ;(callAnthropicForExtraction as any).mockResolvedValue({ rawText: JSON.stringify(SUBTHRESHOLD_OUTPUT), parsedJson: SUBTHRESHOLD_OUTPUT, inputTokens: 100, outputTokens: 50 })
        const { runShadowExtraction } = await import('@/lib/semantic-topic/extraction-service')
        const { evidenceId } = createSignalEvidenceOnly()
        const evidenceInput = { title: ORCHESTRATION_EVIDENCE_TITLE, snippet: null, canonicalUrl: null, publishedAt: null }

        const first = await runShadowExtraction({ signalEvidenceId: evidenceId, evidence: evidenceInput, idempotencyKey: key, client: adminClient as any })
        // The SECOND call, with identical evidence content AND config, hits
        // runShadowExtraction()'s own completed-cache pre-check (step 1,
        // BEFORE any provider/quota work) and returns 'cache_hit', not
        // 'completed' -- a real, pre-existing behavior of this function,
        // not something this gate introduced. cache_hit also carries
        // humanReview (fixed during this gate -- see extraction-service.ts),
        // so the orchestration retry contract is proven either way.
        const second = await runShadowExtraction({ signalEvidenceId: evidenceId, evidence: evidenceInput, idempotencyKey: key, client: adminClient as any })
        expect(first.outcome).toBe('completed')
        expect(['completed', 'cache_hit']).toContain(second.outcome)
        if (first.outcome !== 'completed' || (second.outcome !== 'completed' && second.outcome !== 'cache_hit')) return
        expect(first.extractionRunId).toBe(second.extractionRunId)
        expect(first.humanReview.outcome).toBe('created')
        expect(second.humanReview.outcome).toBe('replayed')

        const reqCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${first.extractionRunId}';`).trim()
        expect(reqCount).toBe('1')
        if (first.humanReview.outcome === 'created') {
          const eventCount = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${first.humanReview.reviewRequestId}' and event_type='requested';`).trim()
          expect(eventCount).toBe('1')
        }
      } finally {
        delete process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
      }
    })

    it('4. ineligible (high-confidence) extraction: no review request is created; nothing else happens automatically (matches today\'s actual lack of an automatic assignment path)', async () => {
      process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED = 'true'
      try {
        const result = await runOrchestration(HIGH_CONFIDENCE_OUTPUT, `${MARKER}-orch-ineligible-${Date.now()}`)
        expect(result.outcome).toBe('completed')
        if (result.outcome !== 'completed') return
        expect(result.humanReview.outcome).toBe('not_eligible')
        const reqCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${result.extractionRunId}';`).trim()
        expect(reqCount).toBe('0')
        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${result.extractionRunId}';`).trim()
        expect(decisionCount).toBe('0')
      } finally {
        delete process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
      }
    })

    it('5. transient review-RPC failure: fail-closed, no QUARANTINE fallback, no assignment decision; the completed extraction remains safely retryable', async () => {
      // Extraction itself created FIRST, flag OFF -- guarantees a clean
      // starting point with zero review requests before the transient
      // failure is simulated (runOrchestration() with the flag already on
      // would itself create the request via its own internal hook call,
      // contaminating this test's "starting from nothing" precondition --
      // found and fixed during this gate).
      const result = await runOrchestration(SUBTHRESHOLD_OUTPUT, `${MARKER}-orch-transient-${Date.now()}`)
      expect(result.outcome).toBe('completed')
      if (result.outcome !== 'completed') return
      expect(result.humanReview).toEqual({ outcome: 'disabled' })

      process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED = 'true'
      try {
        // Simulate a transient failure calling the review RPC specifically,
        // using a client with a genuinely broken connection (bad URL) --
        // never a fabricated business-rule rejection.
        const brokenClient = createClient('http://127.0.0.1:1', LOCAL_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
        const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
        const failed = await maybeRequestHumanReview({ extractionRunId: result.extractionRunId, client: brokenClient as any })
        expect(failed.outcome).toBe('retryable_failure')

        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${result.extractionRunId}';`).trim()
        expect(decisionCount).toBe('0')
        const reqCountAfterFailure = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${result.extractionRunId}';`).trim()
        expect(reqCountAfterFailure).toBe('0')

        // Retry with the REAL client (extraction itself was never lost or
        // re-attempted -- same extractionRunId, fresh review-request attempt).
        const recovered = await maybeRequestHumanReview({ extractionRunId: result.extractionRunId, client: adminClient as any })
        expect(recovered.outcome).toBe('created')
      } finally {
        delete process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
      }
    }, 15000)

    it('6. already-assigned run: no second decision, no review request', async () => {
      // Same fix as test 5: extraction created with the flag OFF first, so
      // no review request exists before the direct QUARANTINE decision is
      // added below.
      const result = await runOrchestration(SUBTHRESHOLD_OUTPUT, `${MARKER}-orch-assigned-${Date.now()}`)
      expect(result.outcome).toBe('completed')
      if (result.outcome !== 'completed') return
      expect(result.humanReview).toEqual({ outcome: 'disabled' })

      dockerPsql(
        `select record_topic_assignment_decision('${result.extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, '${MARKER}-orch-assigned-dec-${Date.now()}', NULL);`,
      )

      process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED = 'true'
      try {
        const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
        const afterAssignment = await maybeRequestHumanReview({ extractionRunId: result.extractionRunId, client: adminClient as any })
        expect(afterAssignment.outcome).toBe('already_assigned')

        const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${result.extractionRunId}';`).trim()
        expect(decisionCount).toBe('1')
        const reqCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${result.extractionRunId}';`).trim()
        expect(reqCount).toBe('0')
      } finally {
        delete process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
      }
    })
  })
})
