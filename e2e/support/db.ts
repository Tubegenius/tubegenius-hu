// PFM Reviewer UI -- Playwright E2E and Runtime Closure gate.
//
// Local-only DB fixture helpers, mirroring the exact pattern already
// established and reviewed in
// tests/semantic-topic-human-review-rpcs-db-integration.test.ts: fixtures
// are created through the real `record_topic_extraction_run` and
// `create_topic_assignment_review_request` DB functions (never raw table
// INSERTs for the review-request rows themselves), scoped under one
// per-run marker, and torn down by that marker only -- no wildcard DELETE,
// no CASCADE relied upon. This file is test-only infrastructure; it is
// never imported by application code.
import { execSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'

const CONTAINER = 'supabase_db_WillViralFinal'

function psql(sql: string): string {
  return execSync(`docker exec -i ${CONTAINER} psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -`, {
    input: sql,
    encoding: 'utf-8',
  })
}

export function assertLocalStackAvailable(): void {
  try {
    psql('select 1;')
  } catch (e) {
    throw new Error('Local Supabase DB stack (supabase_db_WillViralFinal) is not reachable -- refusing to run against a non-local target.')
  }
  // Refuse to run against anything that isn't this exact disposable local
  // container -- belt-and-suspenders alongside the docker exec target name
  // itself being hardcoded above.
  const name = execSync(`docker inspect -f "{{.Name}}" ${CONTAINER}`, { encoding: 'utf-8' }).trim()
  if (!name.includes('supabase_db_WillViralFinal')) {
    throw new Error(`Refusing to run: resolved container name "${name}" does not match the expected local fixture container.`)
  }
}

export const RUN_MARKER = `sti-pw-${Date.now()}`

function m(suffix: string): string {
  return `${RUN_MARKER}-${suffix}`
}

export interface ExtractionFixture {
  evidenceId: string
  extractionRunId: string
}

export function createExtraction(suffix: string, overrides: Record<string, unknown> = {}): ExtractionFixture {
  const tag = m(suffix)
  const sourceId = psql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${tag}-src', '${tag}-src') returning id;`).trim()
  const runId = psql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${tag}-run', 'completed', now()) returning id;`).trim()
  const evidenceId = psql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${tag}-ev', '${tag} fixture evidence for Playwright E2E', '${runId}') returning id;`).trim()

  const structured = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: `${tag} phenomenon`,
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'other',
    confidence: 0.72,
    supporting_spans: [{ source_field: 'title', quoted_text: `${tag} phenomenon quote <script>alert(1)</script>` }],
    ...overrides,
  }
  const structuredEscaped = JSON.stringify(structured).replace(/'/g, "''")

  const extractionJson = psql(
    `select record_topic_extraction_run('${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL, 'norm-${tag}', 1, 'completed', '${structuredEscaped}'::jsonb, 100, 50, 0.001, NULL, '${tag}-ext', now() - interval '1 minute', now());`,
  )
  const extractionRunId = JSON.parse(extractionJson).extraction_run_id as string
  return { evidenceId, extractionRunId }
}

export function createReviewRequest(suffix: string): { reviewRequestId: string; extractionRunId: string } {
  const { extractionRunId } = createExtraction(suffix)
  const tag = m(suffix)
  const body = JSON.parse(psql(`select create_topic_assignment_review_request('${extractionRunId}'::uuid, '${tag}-req');`))
  return { reviewRequestId: body.review_request_id as string, extractionRunId }
}

export function createTargetTopic(suffix: string): string {
  const tag = m(suffix)
  const digest = createHash('sha256').update(`${tag}-attach-target`).digest('hex')
  return psql(`insert into semantic_topics (canonical_label, label_language, creation_request_digest) values ('${tag} attach target topic', 'en', '${digest}') returning id;`).trim()
}

export function reviewRequestStatus(reviewRequestId: string): string {
  return psql(`select status from topic_assignment_review_requests where id='${reviewRequestId}';`).trim()
}

export function decisionIdempotencyKey(reviewRequestId: string): string | null {
  const v = psql(`select coalesce(decision_idempotency_key, '') from topic_assignment_review_requests where id='${reviewRequestId}';`).trim()
  return v === '' ? null : v
}

export function countDecisionsForRequest(reviewRequestId: string): number {
  return Number(psql(`select count(*) from topic_assignment_decisions d join topic_assignment_review_requests r on r.id='${reviewRequestId}' where d.extraction_run_id = r.extraction_run_id;`).trim())
}

export function membershipCountForTopic(topicId: string): number {
  return Number(psql(`select count(*) from semantic_topic_membership where semantic_topic_id='${topicId}';`).trim())
}

export function topicCountByLabel(label: string): number {
  return Number(psql(`select count(*) from semantic_topics where canonical_label = '${label.replace(/'/g, "''")}';`).trim())
}

export function getAiExtractionControlEnabled(): boolean {
  return psql('select enabled from ai_extraction_control limit 1;').trim() === 't'
}

export function setAiExtractionControlEnabled(value: boolean): void {
  psql(`update ai_extraction_control set enabled=${value};`)
}

export function seedReviewerAllowlist(userId: string, note: string): void {
  psql(`insert into semantic_topic_reviewers (user_id, provisioning_note) values ('${userId}', '${note.replace(/'/g, "''")}');`)
}

export function seedProfileOnboarded(userId: string): void {
  psql(`insert into profiles (user_id, onboarding_completed) values ('${userId}', true) on conflict (user_id) do update set onboarding_completed = true;`)
}

// Explicit, marker-scoped cleanup ONLY -- every statement filters on
// RUN_MARKER (or an explicit id list passed in), never a bare table
// truncate/delete. Mirrors the db-integration suite's own cleanupTestData().
export function cleanupRunFixtures(extraUserIds: string[] = []): void {
  const tag = RUN_MARKER
  psql(`
    delete from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${tag}-%')));
    delete from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like '${tag}-%');
    -- Must precede topic_assignment_decisions: a review_request's own
    -- resulting_decision_id FK references it too.
    delete from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${tag}-%'));
    delete from topic_assignment_decisions where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${tag}-%'));
    delete from semantic_topic_membership where semantic_topic_id in (select id from semantic_topics where canonical_label like '${tag}%');
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${tag}-%');
    delete from signal_evidence where external_ref like '${tag}-%';
    delete from signal_sources where external_id like '${tag}-%';
    delete from signal_runs where idempotency_key like '${tag}-%';
    delete from semantic_topics where canonical_label like '${tag}%';
  `)
  if (extraUserIds.length > 0) {
    const idList = extraUserIds.map((id) => `'${id}'`).join(',')
    psql(`
      delete from semantic_topic_reviewer_events where reviewer_user_id in (${idList});
      delete from semantic_topic_reviewers where user_id in (${idList});
      delete from user_credits where user_id in (${idList});
      delete from profiles where user_id in (${idList});
    `)
  }
}

// Server-only supervised execution -- called directly against the RPC here,
// exactly like tests/human-review-ui-e2e-workflow.test.ts already does via
// executeApprovedReview(), because there is deliberately no UI route that
// could do this (see tests/human-review-ui-security.test.ts). This is test
// harness / fixture-verification code, never a substitute for a real
// reviewer UI action.
export function executeApprovedReview(reviewRequestId: string, idempotencyKey: string): { outcome: string; semanticTopicId?: string } {
  const body = JSON.parse(psql(`select execute_approved_topic_assignment_review('${reviewRequestId}'::uuid, '${idempotencyKey}');`))
  return { outcome: body.outcome as string, semanticTopicId: body.semantic_topic_id as string | undefined }
}

export { randomUUID }
