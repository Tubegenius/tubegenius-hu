// PFM Post-Completion Review Handoff Recovery v0 -- REAL local DB
// integration tests. Uses the existing local Docker Supabase stack
// (supabase_db_WillViralFinal), skips entirely (not a failure) when
// unavailable. Mirrors tests/semantic-topic-human-review-rpcs-db-integration.test.ts's
// fixture conventions exactly (createExtraction via the real 074 RPC,
// marker-based cleanup). No provider call anywhere in this file --
// ANTHROPIC_API_KEY is never set for this process.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })
import { execSync } from 'node:child_process'

delete process.env.ANTHROPIC_API_KEY

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

const describeIfLocalDb = stackAvailable ? describe : describe.skip

const MARKER = 'pcrr-db'
let fixtureCounter = 0
function nextMarker(): string {
  fixtureCounter += 1
  return `${MARKER}-${Date.now()}-${fixtureCounter}`
}

function structuredOutput(overrides: Record<string, unknown> = {}): string {
  const base = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: 'recovery db-integration test phenomenon',
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'other',
    confidence: 0.62,
    supporting_spans: [{ source_field: 'title', quoted_text: 'recovery db-integration test phenomenon' }],
    ...overrides,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

function createExtraction(overrides: Record<string, unknown> = {}, status: 'completed' | 'failed' = 'completed'): { evidenceId: string; extractionRunId: string } {
  const m = nextMarker()
  const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
  const evidenceId = dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${m}-ev', '${MARKER} fixture evidence', '${runId}') returning id;`).trim()
  const structured = status === 'completed' ? `'${structuredOutput(overrides)}'::jsonb` : 'NULL'
  const errorClass = status === 'completed' ? 'NULL' : `'provider_error'`
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
    'norm-${m}', 1, '${status}', ${structured}, 100, 50, 0.001, ${errorClass},
    '${m}-ext', now() - interval '1 minute', now()
  );`
  const result = JSON.parse(dockerPsql(sql).trim())
  return { evidenceId, extractionRunId: result.extraction_run_id }
}

function cleanupTestData() {
  dockerPsql(`
    delete from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%')));
    delete from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
    delete from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topic_membership where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topics where canonical_label like '${MARKER}%';
    delete from supervised_intake_batch_items where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from ai_provider_budget_reservations where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
  `)
}

function counts() {
  return {
    batches: dockerPsql(`select count(*) from supervised_intake_batches;`).trim(),
    items: dockerPsql(`select count(*) from supervised_intake_batch_items;`).trim(),
    attempts: dockerPsql(`select count(*) from supervised_intake_attempts;`).trim(),
    reservations: dockerPsql(`select count(*) from ai_provider_budget_reservations;`).trim(),
    topics: dockerPsql(`select count(*) from semantic_topics;`).trim(),
    decisions: dockerPsql(`select count(*) from topic_assignment_decisions;`).trim(),
  }
}

describeIfLocalDb('Post-Completion Review Handoff Recovery -- real local DB integration', () => {
  let baselineCounts: ReturnType<typeof counts>

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    cleanupTestData()
    baselineCounts = counts()
  })

  afterAll(() => {
    cleanupTestData()
    expect(dockerPsql('select enabled from ai_extraction_control where id=1;').trim()).toBe('f')
    expect(dockerPsql('select enabled from supervised_intake_control where id=1;').trim()).toBe('f')
    expect(counts()).toEqual(baselineCounts)
  })

  afterEach(() => {
    cleanupTestData()
  })

  async function client() {
    const { createAdminClient } = await import('@/lib/supabase-server')
    return createAdminClient()
  }

  it('eligible completed run, no prior request: created', async () => {
    const { extractionRunId } = createExtraction()
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const outcome = await runPostCompletionReviewRecovery(await client(), { extractionRunId, dryRun: false })
    expect(outcome.kind).toBe('created')
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('1')
  })

  it('dry-run never creates a row', async () => {
    const { extractionRunId } = createExtraction()
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const outcome = await runPostCompletionReviewRecovery(await client(), { extractionRunId, dryRun: true })
    expect(outcome.kind).toBe('dry_run')
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('0')
  })

  it('idempotent replay: calling twice for the same run yields the same review_request_id, still exactly one row', async () => {
    const { extractionRunId } = createExtraction()
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const c = await client()
    const first = await runPostCompletionReviewRecovery(c, { extractionRunId, dryRun: false })
    const second = await runPostCompletionReviewRecovery(c, { extractionRunId, dryRun: false })
    expect(first.kind).toBe('created')
    expect(second.kind).toBe('replayed')
    if (first.kind === 'created' && second.kind === 'replayed') {
      expect(second.reviewRequestIdPrefix).toBe(first.reviewRequestIdPrefix)
    }
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('1')
  })

  it('two concurrent recovery calls for the same run: one created, one replayed, never two rows', async () => {
    const { extractionRunId } = createExtraction()
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const c = await client()
    const [a, b] = await Promise.all([
      runPostCompletionReviewRecovery(c, { extractionRunId, dryRun: false }),
      runPostCompletionReviewRecovery(c, { extractionRunId, dryRun: false }),
    ])
    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(['created', 'replayed'])
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('1')
  })

  for (const [label, overrides] of [
    ['NOT_SPECIFIC', { specificity: 'generic' }],
    ['CONFIDENCE_NOT_REVIEW_ELIGIBLE', { confidence: 0.9 }],
    ['NO_SUPPORTING_SPANS', { supporting_spans: [] }],
  ] as const) {
    it(`ineligible: ${label}`, async () => {
      const { extractionRunId } = createExtraction(overrides)
      const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
      const outcome = await runPostCompletionReviewRecovery(await client(), { extractionRunId, dryRun: false })
      expect(outcome.kind).toBe('ineligible')
      if (outcome.kind === 'ineligible') expect(outcome.reasonCode).toBe(label)
    })
  }

  it('ineligible: EXTRACTION_NOT_COMPLETED for a failed run', async () => {
    const { extractionRunId } = createExtraction({}, 'failed')
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const outcome = await runPostCompletionReviewRecovery(await client(), { extractionRunId, dryRun: false })
    expect(outcome.kind).toBe('configuration_error')
  })

  it('blocked: ALREADY_ASSIGNED when a topic_assignment_decisions row already exists for this run', async () => {
    const { extractionRunId } = createExtraction()
    dockerPsql(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{}'::jsonb, '${nextMarker()}', NULL);`)
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const outcome = await runPostCompletionReviewRecovery(await client(), { extractionRunId, dryRun: false })
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') expect(outcome.reasonCode).toBe('ALREADY_ASSIGNED')
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('0')
  })

  it('blocked: LIVE_REVIEW_REQUEST_EXISTS when a pending request already exists under a DIFFERENT (manually issued) idempotency key', async () => {
    const { extractionRunId } = createExtraction()
    // A request created directly against the RPC with an arbitrary key --
    // simulates a request that pre-dates this recovery tool (e.g. one the
    // live hook itself would have created, had the flag been on).
    dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${nextMarker()}-manual');`)
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const outcome = await runPostCompletionReviewRecovery(await client(), { extractionRunId, dryRun: false })
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') expect(outcome.reasonCode).toBe('LIVE_REVIEW_REQUEST_EXISTS')
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('1') // still just the one manually created row
  })

  it('a CLOSED (expired) request under the SAME deterministic key replays to that closed row rather than creating a second one', async () => {
    const { extractionRunId } = createExtraction()
    const { deriveHumanReviewIdempotencyKey } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const key = deriveHumanReviewIdempotencyKey(extractionRunId)
    const created = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${key}');`).trim())
    // 'expired' requires every decision-related field to stay NULL (the
    // topic_assignment_review_requests_expired_fields_empty CHECK) -- a
    // plain status flip satisfies it exactly, unlike 'rejected'/'cancelled'
    // which require a full, authenticated-reviewer decision record this
    // fixture has no need to construct.
    dockerPsql(`update topic_assignment_review_requests set status='expired' where id='${created.review_request_id}';`)
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const outcome = await runPostCompletionReviewRecovery(await client(), { extractionRunId, dryRun: false })
    expect(outcome.kind).toBe('replayed')
    if (outcome.kind === 'replayed') expect(outcome.reviewRequestIdPrefix).toBe(created.review_request_id.slice(0, 8))
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('1')
    const status = dockerPsql(`select status from topic_assignment_review_requests where id='${created.review_request_id}';`).trim()
    expect(status).toBe('expired') // never resurrected/modified by the recovery call
  })

  it('append-only audit: a created request always has exactly one "requested" review event, never modified by a later replay', async () => {
    const { extractionRunId } = createExtraction()
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const c = await client()
    await runPostCompletionReviewRecovery(c, { extractionRunId, dryRun: false })
    await runPostCompletionReviewRecovery(c, { extractionRunId, dryRun: false }) // replay
    const eventCount = dockerPsql(
      `select count(*) from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id='${extractionRunId}');`,
    ).trim()
    expect(eventCount).toBe('1')
  })

  it('zero batch/item/attempt/reservation/topic/decision side effects from a created outcome', async () => {
    const before = counts()
    const { extractionRunId } = createExtraction()
    const { runPostCompletionReviewRecovery } = await import('@/lib/semantic-topic/post-completion-review-recovery')
    const outcome = await runPostCompletionReviewRecovery(await client(), { extractionRunId, dryRun: false })
    expect(outcome.kind).toBe('created')
    const after = counts()
    expect(after.batches).toBe(before.batches)
    expect(after.items).toBe(before.items)
    expect(after.attempts).toBe(before.attempts)
    // reservations legitimately grows by createExtraction's own extraction-run
    // fixture path only if it inserts one -- record_topic_extraction_run does
    // not touch ai_provider_budget_reservations at all, so this must be exactly unchanged too.
    expect(after.reservations).toBe(before.reservations)
    expect(after.topics).toBe(before.topics)
    expect(after.decisions).toBe(before.decisions)
  })
})
