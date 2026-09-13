// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, minimal
// reviewer UI (Local Implementation Phase 4) -- Supervised Local E2E,
// backend half.
//
// This gate's mandated E2E scenarios A-E are proven in TWO complementary
// layers, exactly as the "no browser E2E framework installed" fallback this
// gate's brief explicitly anticipates:
//   1. This file: the REAL local Supabase stack, REAL authenticated reviewer
//      sessions, REAL RPCs -- via the exact same application wrapper
//      functions (human-review-service.ts / human-review-reviewer.ts) the
//      admin API routes call, and that the reviewer UI's fetch() calls
//      ultimately reach. Approved-request execution is always performed by
//      this test harness calling executeApprovedReview() directly (the
//      server-only wrapper), never through a UI route -- there is no UI
//      route that could do that (see tests/human-review-ui-security.test.ts).
//   2. tests/human-review-ui-*.test.ts: the actual React UI's pure
//      validation/idempotency/status logic and its security boundary.
//
// Scenario A (Approve -> CREATE_NEW -> execute -> verify) and Scenario D
// (Unauthorized) are ALREADY proven at this exact wrapper-layer in
// tests/human-review-app-integration.test.ts ("full lifecycle through the
// wrapper layer" and "a non-reviewer authenticated session is rejected") --
// deliberately not duplicated here. This file covers what that one does
// not: B (Reject -> terminal QUARANTINE), C (decision retry/idempotency),
// and E (ATTACH_EXISTING, built on a CREATE_NEW-seeded topic).
//
// A live, interactive browser walkthrough of the actual rendered pages was
// attempted and deliberately abandoned mid-session: the running `npm run
// dev` server's own client-side sign-in rejected the exact same credentials
// that authenticate successfully directly against the confirmed-local Kong
// gateway (verified both via curl and via a fetch() issued from inside the
// browser page itself) -- meaning the dev server's own .env.local-derived
// Supabase configuration could not be confirmed, without reading
// .env.local (forbidden for this gate), to definitely be this same local
// disposable stack. Continuing to drive the live dev server under that
// uncertainty risked exactly the "no production/remote access" rule this
// gate exists to protect -- so the dev server was stopped and this file's
// approach (bypassing the Next.js app's own client entirely, driving Kong
// directly with hardcoded, confirmed-local well-known keys) was used
// instead. See docs/architecture/semantic-topic-identity-v0-contract.md
// SS36 for the full writeup.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
// This file's scenarios each run a full multi-step review lifecycle (seed
// creation, decision, execution, then a second ATTACH_EXISTING pass) through
// the real server-only service layer -- measured duration for the heaviest
// scenario was 5.0s against the tight 5000ms Vitest default -- 20000ms gives
// ~4x headroom while still catching a genuine hang, matching the convention
// other heavy DB-integration/E2E files in this repo already use.
vi.setConfig({ testTimeout: 20000 })
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

const MARKER = 'sti-ui-e2e'
const REVIEWER_EMAIL = `${MARKER}-reviewer-${Date.now()}@example.test`
const REVIEWER_PASSWORD = `Test-${randomUUID()}-!Aa1`
let reviewerUserId: string

function structuredOutput(overrides: Record<string, unknown> = {}): string {
  const base = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: 'UI E2E phenomenon',
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'other',
    confidence: 0.71,
    supporting_spans: [{ source_field: 'title', quoted_text: 'UI E2E phenomenon' }],
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
    delete from semantic_topics where canonical_label like '${MARKER}%';
    delete from ai_provider_budget_reservations where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
  `)
}

describeIfLocalStack('Human-Reviewed Candidate Workflow -- minimal reviewer UI backend E2E (real local Supabase stack)', () => {
  let userClient: ReturnType<typeof createClient>

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
  })

  // ------------------------------------------------------------
  // B. Reject -> terminal QUARANTINE
  // ------------------------------------------------------------
  it('scenario B: structured rejection creates a terminal QUARANTINE decision, no semantic topic or membership', async () => {
    const { createReviewRequest } = await import('@/lib/semantic-topic/human-review-service')
    const { recordDecision, getReview } = await import('@/lib/semantic-topic/human-review-reviewer')
    const { extractionRunId } = createExtractionFixture()

    // Baseline BEFORE this test's own action -- other scenarios in this
    // file (e.g. scenario E) legitimately create their own MARKER-prefixed
    // topics as fixtures, so this test's own assertion must be "no NEW
    // topic from this decision" (a before/after delta), not "zero topics
    // globally," which would spuriously fail whenever those other
    // scenarios happen to run first (e.g. under --sequence.shuffle.tests).
    const topicCountBefore = Number(dockerPsql(`select count(*) from semantic_topics where canonical_label like '${MARKER}%';`).trim())

    const created = await createReviewRequest({ extractionRunId, idempotencyKey: `${MARKER}-b-create-${extractionRunId}` }, adminClient as any)
    expect(created.outcome).toBe('success')
    if (created.outcome !== 'success') return

    const decision = await recordDecision(userClient as any, created.reviewRequestId, `${MARKER}-b-dec-${extractionRunId}`, {
      outcome: 'rejected',
      rejectionReason: 'insufficient_evidence',
      reviewerRationale: 'Not enough evidence to confirm this is a real, distinct topic.',
      reviewPolicyVersion: 1,
    })
    expect(decision.outcome).toBe('success')
    if (decision.outcome !== 'success') return
    expect(decision.result).toBe('rejected')

    const detail = await getReview(userClient as any, created.reviewRequestId)
    expect(detail.outcome).toBe('success')
    if (detail.outcome !== 'success') return
    expect(detail.request.status).toBe('rejected')
    expect(detail.request.decision?.rejectionReason).toBe('insufficient_evidence')

    const topicCountAfter = Number(dockerPsql(`select count(*) from semantic_topics where canonical_label like '${MARKER}%';`).trim())
    const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where signal_evidence_id in (select signal_evidence_id from topic_extraction_runs where id='${extractionRunId}');`).trim()
    const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
    expect(topicCountAfter).toBe(topicCountBefore) // no NEW topic from this rejection
    expect(membershipCount).toBe('0')
    expect(decisionCount).toBe('1') // exactly the QUARANTINE decision, never zero, never two

    // A rejected (terminal) request can never receive a second decision --
    // this is the DB's own contract, re-verified here at the wrapper layer.
    const secondAttempt = await recordDecision(userClient as any, created.reviewRequestId, `${MARKER}-b-dec2-${extractionRunId}`, {
      outcome: 'rejected',
      rejectionReason: 'other_review_rejection',
      reviewerRationale: 'Attempting a second decision on an already-decided request.',
      reviewPolicyVersion: 1,
    })
    expect(secondAttempt.outcome).toBe('already_decided')
  })

  // ------------------------------------------------------------
  // C. Retry -- same idempotency key + identical payload replays, never a
  //    second decision/event
  // ------------------------------------------------------------
  it('scenario C: a decision submitted twice with the SAME idempotency key and payload (simulated unknown-network-result retry) replays -- no second decision/event', async () => {
    const { createReviewRequest } = await import('@/lib/semantic-topic/human-review-service')
    const { recordDecision } = await import('@/lib/semantic-topic/human-review-reviewer')
    const { extractionRunId } = createExtractionFixture()

    const created = await createReviewRequest({ extractionRunId, idempotencyKey: `${MARKER}-c-create-${extractionRunId}` }, adminClient as any)
    expect(created.outcome).toBe('success')
    if (created.outcome !== 'success') return

    const decisionKey = `${MARKER}-c-dec-${extractionRunId}`
    const decisionInput = {
      outcome: 'rejected' as const,
      rejectionReason: 'malformed_candidate' as const,
      reviewerRationale: 'Retry-idempotency scenario fixture.',
      reviewPolicyVersion: 1,
    }

    const first = await recordDecision(userClient as any, created.reviewRequestId, decisionKey, decisionInput)
    expect(first.outcome).toBe('success')
    if (first.outcome !== 'success') return
    expect(first.result).toBe('rejected')

    // Retry: EXACT same key, EXACT same payload -- simulates a client that
    // never received the first response (e.g. a dropped connection) and
    // retries the identical request, exactly as the UI's DecisionForm does
    // (see decisionLogic.ts:resolveIdempotencyKey and its own unit tests).
    const retry = await recordDecision(userClient as any, created.reviewRequestId, decisionKey, decisionInput)
    expect(retry.outcome).toBe('success')
    if (retry.outcome !== 'success') return
    expect(retry.result).toBe('replayed')
    expect(retry.reviewRequestId).toBe(first.reviewRequestId)

    const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
    const eventCount = dockerPsql(`select count(*) from topic_assignment_review_events where review_request_id='${created.reviewRequestId}' and event_type='rejected';`).trim()
    expect(decisionCount).toBe('1')
    expect(eventCount).toBe('1')
  })

  // ------------------------------------------------------------
  // E. ATTACH_EXISTING supervised pilot -- exact target UUID, execution
  //    re-verifies target lifecycle, exactly one new membership/decision/event
  // ------------------------------------------------------------
  it('scenario E: approve with ATTACH_EXISTING to a seeded topic (exact UUID) -> harness executes via the server-only wrapper -> exactly one new membership, no new semantic topic', async () => {
    const { createReviewRequest, executeApprovedReview } = await import('@/lib/semantic-topic/human-review-service')
    const { recordDecision } = await import('@/lib/semantic-topic/human-review-reviewer')

    // Seed a real topic via the SAME CREATE_NEW -> execute path already
    // proven end-to-end in tests/human-review-app-integration.test.ts's
    // "full lifecycle" test -- reused here only as ATTACH_EXISTING's target,
    // not re-asserted.
    const seed = createExtractionFixture()
    const seedRequest = await createReviewRequest({ extractionRunId: seed.extractionRunId, idempotencyKey: `${MARKER}-e-seed-create-${seed.extractionRunId}` }, adminClient as any)
    expect(seedRequest.outcome).toBe('success')
    if (seedRequest.outcome !== 'success') return
    const seedDecision = await recordDecision(userClient as any, seedRequest.reviewRequestId, `${MARKER}-e-seed-dec-${seed.extractionRunId}`, {
      outcome: 'approved',
      canonicalTopicLabel: `${MARKER} seed topic`,
      topicDefinition: 'Seed topic for ATTACH_EXISTING scenario E.',
      scope: 'Seed scope.',
      inclusionCriteria: 'Incl.',
      exclusionCriteria: 'Excl.',
      laneNeutralConfirmed: true,
      evidenceAdequacy: 'adequate',
      duplicateSearchOutcome: 'no_duplicate_found',
      proposedOutcome: 'CREATE_NEW',
      targetSemanticTopicId: null,
      uncertaintyClassification: 'low',
      reviewerRationale: 'Seed for ATTACH_EXISTING.',
      reviewPolicyVersion: 1,
    })
    expect(seedDecision.outcome).toBe('success')
    if (seedDecision.outcome !== 'success') return
    const seedExecuted = await executeApprovedReview({ reviewRequestId: seedRequest.reviewRequestId, idempotencyKey: `${MARKER}-e-seed-exec-${seed.extractionRunId}` }, adminClient as any)
    expect(seedExecuted.outcome).toBe('success')
    if (seedExecuted.outcome !== 'success') return
    const targetTopicId = seedExecuted.semanticTopicId!
    expect(targetTopicId).toBeTruthy()

    // The actual ATTACH_EXISTING scenario: a second, independent extraction,
    // approved with the seed topic's EXACT UUID as the supervised-pilot
    // target (matching the UI's own strict-UUID-only ATTACH_EXISTING input).
    const attach = createExtractionFixture()
    const attachRequest = await createReviewRequest({ extractionRunId: attach.extractionRunId, idempotencyKey: `${MARKER}-e-attach-create-${attach.extractionRunId}` }, adminClient as any)
    expect(attachRequest.outcome).toBe('success')
    if (attachRequest.outcome !== 'success') return

    const attachDecision = await recordDecision(userClient as any, attachRequest.reviewRequestId, `${MARKER}-e-attach-dec-${attach.extractionRunId}`, {
      outcome: 'approved',
      canonicalTopicLabel: `${MARKER} seed topic`,
      topicDefinition: 'Seed topic for ATTACH_EXISTING scenario E.',
      scope: 'Seed scope.',
      inclusionCriteria: 'Incl.',
      exclusionCriteria: 'Excl.',
      laneNeutralConfirmed: true,
      evidenceAdequacy: 'adequate',
      // Migration 084: ATTACH_EXISTING requires existing_topic_match_confirmed
      // -- no_duplicate_found/possible_duplicate_reviewed_and_distinct are
      // both factually wrong for an attach decision (see the contract doc).
      duplicateSearchOutcome: 'existing_topic_match_confirmed',
      proposedOutcome: 'ATTACH_EXISTING',
      targetSemanticTopicId: targetTopicId,
      uncertaintyClassification: 'low',
      reviewerRationale: 'Matches the seeded topic exactly -- ATTACH_EXISTING scenario.',
      reviewPolicyVersion: 1,
    })
    expect(attachDecision.outcome).toBe('success')
    if (attachDecision.outcome !== 'success') return
    expect(attachDecision.result).toBe('approved')

    const membershipCountBefore = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id='${targetTopicId}';`).trim()
    expect(membershipCountBefore).toBe('1') // only the seed membership so far -- approval alone never writes membership

    // The test harness -- NOT a UI route -- performs the execution, exactly
    // as this gate's Section 7 execution boundary requires.
    const attachExecuted = await executeApprovedReview({ reviewRequestId: attachRequest.reviewRequestId, idempotencyKey: `${MARKER}-e-attach-exec-${attach.extractionRunId}` }, adminClient as any)
    expect(attachExecuted.outcome).toBe('success')
    if (attachExecuted.outcome !== 'success') return
    expect(attachExecuted.result).toBe('executed')
    expect(attachExecuted.proposedOutcome).toBe('ATTACH_EXISTING')
    expect(attachExecuted.semanticTopicId).toBe(targetTopicId)

    const membershipCountAfter = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id='${targetTopicId}';`).trim()
    const topicCount = dockerPsql(`select count(*) from semantic_topics where id='${targetTopicId}';`).trim()
    const allTopicsWithSeedLabel = dockerPsql(`select count(*) from semantic_topics where canonical_label='${MARKER} seed topic';`).trim()
    expect(membershipCountAfter).toBe('2') // seed + the newly attached evidence
    expect(topicCount).toBe('1')
    expect(allTopicsWithSeedLabel).toBe('1') // no second semantic topic was ever created
  })
})
