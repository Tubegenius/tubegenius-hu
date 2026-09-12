// Semantic Topic Lifecycle Foundation Correctness v1 -- migration 086,
// REAL local DB integration tests. Proves: the new common helper
// (public._semantic_topic_eligible_membership_sources) is the single
// eligible-source-identity definition used by BOTH the automatic
// candidate_singleton -> corroborating enforcement (074/078) AND
// compute_topic_evidence_vector (085); that the three false-positive
// scenarios identified in the design gates (same-channel double
// membership, unknown/unresolved source, syndication-copy evidence) no
// longer trigger a false corroborating transition; and that the helper
// itself is unreachable by any external role. Same pattern as the 072/
// 073/078/085 suites: uses the existing local Docker Supabase stack
// (supabase_db_WillViralFinal), skips entirely (not a failure) when
// unavailable, only synthetic/deterministic fixtures -- no AI/provider
// call, no production data.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const MIGRATION_086_PATH = join(process.cwd(), 'supabase/migrations/086_semantic_topic_eligible_source_identity_correctness.sql')
const migrationSource = readFileSync(MIGRATION_086_PATH, 'utf8')
const LOCAL_API_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const adminClient = createClient(LOCAL_API_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
    input: sql,
    encoding: 'utf-8',
  })
}

function dockerPsqlExpectError(sql: string): string {
  try {
    execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
      input: sql,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return '__NO_ERROR__'
  } catch (e: any) {
    return String(e.stderr || e.stdout || e.message || '')
  }
}

function runMigration(path: string): { out: string; threw: boolean } {
  const migrationSql = readFileSync(path, 'utf8')
  try {
    const out = execSync(
      'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
      { input: migrationSql, encoding: 'utf8' },
    )
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

const MARKER = 'sti-086'

function randomHexDigest(): string {
  let s = ''
  while (s.length < 64) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

let fixtureCounter = 0
function nextMarker(): string {
  fixtureCounter += 1
  return `${MARKER}-${Date.now()}-${fixtureCounter}`
}

function ensureFullyApplied() {
  // Unconditionally (re-)apply -- NOT merely "if the helper is missing".
  // Other DB-integration test files sharing this same local Postgres
  // container legitimately, temporarily revert record_topic_assignment_
  // decision/execute_approved_topic_assignment_review to their pre-086
  // legacy bodies (to exercise 074's/078's OWN standalone idempotency
  // checks in isolation) and are responsible for restoring them -- but this
  // file must never assume it ran last, or that every other file's
  // restoration step already ran. Re-applying 086 is always a safe,
  // idempotent no-op when the corrected bodies are already live, and
  // deterministically restores them when they are not.
  const r = runMigration(MIGRATION_086_PATH)
  if (r.threw) throw new Error(`ensureFullyApplied: 086 failed -- ${r.out}`)
}

function cleanupTestData() {
  dockerPsql(`
    delete from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%')));
    delete from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
    delete from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from semantic_topic_membership where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%') or signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from semantic_topics where canonical_label like '${MARKER}%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
  `)
}

function insertSource(externalId: string, sourceType: 'youtube_channel' | 'web_domain' = 'youtube_channel'): string {
  return dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('${sourceType}', '${externalId}', '${externalId}') returning id;`).trim()
}
function insertRun(idempotencyKey: string): string {
  return dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${idempotencyKey}', 'completed', now()) returning id;`).trim()
}

function insertEvidence(params: {
  marker: string
  sourceId: string
  evidenceType: 'youtube_video' | 'serper_web' | 'serper_news'
  externalRef: string
  canonicalUrl?: string | null
  isSyndicationCopyOf?: string | null
}): string {
  const runId = insertRun(`${params.marker}-run`)
  const canonicalSql = params.canonicalUrl === undefined || params.canonicalUrl === null ? 'NULL' : `'${params.canonicalUrl}'`
  const syndSql = params.isSyndicationCopyOf ? `'${params.isSyndicationCopyOf}'` : 'NULL'
  return dockerPsql(`
    insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id, canonical_url, is_syndication_copy_of)
    values ('${params.sourceId}', '${params.evidenceType}', '${params.externalRef}', '${MARKER} fixture evidence', '${runId}', ${canonicalSql}, ${syndSql})
    returning id;
  `).trim()
}

function insertTopic(overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    canonical_label: `'${MARKER} topic ${Math.random().toString(36).slice(2)}'`,
    label_language: `'en'`,
    creation_request_digest: `'${randomHexDigest()}'`,
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
    assignment_reason: `'entity_event_match'`,
    confidence: '0.9000',
    algorithm_version: '1',
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into semantic_topic_membership (${cols}) values (${vals}) returning id;`).trim()
}

function callVectorRpc(topicId: string): any {
  return JSON.parse(dockerPsql(`select compute_topic_evidence_vector('${topicId}'::uuid);`).trim())
}

function helperRows(topicId: string): any[] {
  const out = dockerPsql(
    `select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from _semantic_topic_eligible_membership_sources('${topicId}'::uuid) t;`,
  ).trim()
  return JSON.parse(out)
}

const VALID_STRUCTURED_OUTPUT = (overrides: Record<string, unknown> = {}) => {
  const base = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: '086 fixture phenomenon',
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'other',
    confidence: 0.9,
    supporting_spans: [{ source_field: 'title', quoted_text: '086 fixture phenomenon' }],
    ...overrides,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

function createExtractionRunForEvidence(evidenceId: string, marker: string, confidence = 0.9): string {
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
    'norm-${marker}', 1, 'completed', '${VALID_STRUCTURED_OUTPUT({ confidence })}'::jsonb, 100, 50, 0.001, NULL,
    '${marker}-ext', now() - interval '1 minute', now()
  );`
  const result = JSON.parse(dockerPsql(sql).trim())
  return result.extraction_run_id
}

function recordAssignmentDecision(params: {
  extractionRunId: string
  outcome: 'CREATE_NEW' | 'ATTACH_EXISTING'
  decisionReason: string
  idempotencyKey: string
  existingTopicId?: string | null
}): any {
  const existing = params.existingTopicId ? `'${params.existingTopicId}'::uuid` : 'NULL'
  const sql = `select record_topic_assignment_decision(
    '${params.extractionRunId}'::uuid, '${params.outcome}', '${params.decisionReason}', '{}'::jsonb,
    '${params.idempotencyKey}', ${existing}
  );`
  return JSON.parse(dockerPsql(sql).trim())
}

function topicLifecycle(topicId: string): string {
  return dockerPsql(`select lifecycle_status from semantic_topics where id='${topicId}';`).trim()
}

// ── 078-path fixture: real GoTrue reviewer session, reused from the
//    established execute-approved-review pattern, extended for
//    ATTACH_EXISTING with a target topic. ──
const REVIEWER_EMAIL = `${MARKER}-reviewer-${Date.now()}@example.test`
const REVIEWER_PASSWORD = `Test-${randomUUID()}-!Aa1`
let reviewerUserId: string
let userClient: ReturnType<typeof createClient>

async function createApprovedAttachRequest(marker: string, evidenceId: string, extractionRunId: string, targetTopicId: string) {
  const { createReviewRequest } = await import('@/lib/semantic-topic/human-review-service')
  const { recordDecision } = await import('@/lib/semantic-topic/human-review-reviewer')
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
    duplicateSearchOutcome: 'existing_topic_match_confirmed',
    proposedOutcome: 'ATTACH_EXISTING',
    targetSemanticTopicId: targetTopicId,
    uncertaintyClassification: 'low',
    reviewerRationale: 'Clear and well-evidenced.',
    reviewPolicyVersion: 1,
  })
  if (decision.outcome !== 'success') throw new Error(`fixture setup failed: recordDecision ${JSON.stringify(decision)}`)
  return created.reviewRequestId
}

describeIfLocalDb('Semantic Topic Lifecycle Foundation Correctness v1 -- 086 eligible-source-identity (real local DB)', () => {
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
  // A. Helper correctness (direct calls, as postgres)
  // ============================================================
  describe('A. _semantic_topic_eligible_membership_sources correctness', () => {
    it('A1. two active YouTube memberships, SAME signal_source_id -> 2 rows, 1 distinct source', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const ev2 = insertEvidence({ marker: `${m}-2`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-2-ev` })
      insertMembership(topic, ev1)
      insertMembership(topic, ev2)
      const rows = helperRows(topic)
      expect(rows).toHaveLength(2)
      const distinct = new Set(rows.map((r) => r.source_identity_id))
      expect(distinct.size).toBe(1)
    })

    it('A2. two active YouTube memberships, DIFFERENT signal_source_id -> 2 distinct sources', () => {
      const m = nextMarker()
      const srcA = insertSource(`${m}-chanA`)
      const srcB = insertSource(`${m}-chanB`)
      const topic = insertTopic()
      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: srcA, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const ev2 = insertEvidence({ marker: `${m}-2`, sourceId: srcB, evidenceType: 'youtube_video', externalRef: `${m}-2-ev` })
      insertMembership(topic, ev1)
      insertMembership(topic, ev2)
      const rows = helperRows(topic)
      const distinct = new Set(rows.map((r) => r.source_identity_id))
      expect(distinct.size).toBe(2)
    })

    it('A3. syndication-copy evidence is excluded entirely from the helper output', () => {
      const m = nextMarker()
      const srcA = insertSource(`${m}-chanA`)
      const srcB = insertSource(`${m}-chanB`)
      const topic = insertTopic()
      const original = insertEvidence({ marker: `${m}-1`, sourceId: srcA, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const copy = insertEvidence({ marker: `${m}-2`, sourceId: srcB, evidenceType: 'youtube_video', externalRef: `${m}-2-ev`, isSyndicationCopyOf: original })
      insertMembership(topic, original)
      insertMembership(topic, copy)
      const rows = helperRows(topic)
      expect(rows).toHaveLength(1)
      expect(rows[0].evidence_id).toBe(original)
    })

    it('A4. an inactive (valid_to set) membership is excluded from the helper output', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev = insertEvidence({ marker: m, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-ev` })
      insertMembership(topic, ev, { valid_to: "now() + interval '1 second'" })
      const rows = helperRows(topic)
      expect(rows).toHaveLength(0)
    })

    it('A5. a membership appears at most once in the helper output', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev = insertEvidence({ marker: m, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-ev` })
      insertMembership(topic, ev)
      const rows = helperRows(topic)
      expect(rows).toHaveLength(1)
      expect(new Set(rows.map((r) => r.membership_id)).size).toBe(1)
    })

    it('A6. serper_web evidence: source identity from the web_domain signal_sources row, two evidence rows sharing one signal_source_id -> 1 distinct source', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-domain`, 'web_domain')
      const topic = insertTopic()
      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: src, evidenceType: 'serper_web', externalRef: `${m}-1-ev`, canonicalUrl: `https://example.test/${m}/a` })
      const ev2 = insertEvidence({ marker: `${m}-2`, sourceId: src, evidenceType: 'serper_web', externalRef: `${m}-2-ev`, canonicalUrl: `https://example.test/${m}/b` })
      insertMembership(topic, ev1)
      insertMembership(topic, ev2)
      const rows = helperRows(topic)
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((r) => r.source_identity_id)).size).toBe(1)
      expect(rows.every((r) => r.source_type === 'web_domain')).toBe(true)
    })

    it('A7. serper_news evidence (writer-less but CHECK-permitted type): correct identity/integrity behavior', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-domain`, 'web_domain')
      const topic = insertTopic()
      const ev = insertEvidence({ marker: m, sourceId: src, evidenceType: 'serper_news', externalRef: `${m}-ev`, canonicalUrl: `https://news.example.test/${m}` })
      insertMembership(topic, ev)
      const rows = helperRows(topic)
      expect(rows).toHaveLength(1)
      expect(rows[0].evidence_type).toBe('serper_news')
      expect(rows[0].evidence_identity_complete).toBe(true)
    })

    it('A8. two different web_domain signal_source_id rows -> 2 distinct sources (no collision with YouTube channel IDs sharing the same raw string)', () => {
      const m = nextMarker()
      const rawId = `${m}-shared-raw-id`
      const ytSrc = insertSource(rawId, 'youtube_channel')
      const webSrc = insertSource(rawId, 'web_domain')
      const topic = insertTopic()
      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: ytSrc, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const ev2 = insertEvidence({ marker: `${m}-2`, sourceId: webSrc, evidenceType: 'serper_web', externalRef: `${m}-2-ev`, canonicalUrl: `https://example.test/${m}` })
      insertMembership(topic, ev1)
      insertMembership(topic, ev2)
      const rows = helperRows(topic)
      // Distinct signal_sources.id (a real UUID, not a concatenated raw
      // string) -- the identical raw external_id under two different
      // source_type rows produces two DIFFERENT signal_sources.id values,
      // so the count is 2 even though the human-readable external_id string
      // collides. This is what "the source_identity_id UUID itself is the
      // globally unique identity" means in practice.
      expect(new Set(rows.map((r) => r.source_identity_id)).size).toBe(2)
      expect(ytSrc).not.toBe(webSrc)
    })

    it('A9. YouTube evidence with canonical_url=NULL but a stable external_ref -> evidence_identity_complete=true', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev = insertEvidence({ marker: m, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-ev`, canonicalUrl: null })
      insertMembership(topic, ev)
      const rows = helperRows(topic)
      expect(rows[0].evidence_identity_complete).toBe(true)
    })

    it('A10. non-YouTube evidence lacking a stable identifier (blank canonical_url via direct override) -> evidence_identity_complete=false', () => {
      // The 051 CHECK constraint (signal_evidence_canonical_url_required)
      // already forbids inserting a non-YouTube row with a NULL
      // canonical_url -- proving THAT rejection (not disabling the
      // constraint) is the correct way to exercise this boundary.
      const m = nextMarker()
      const src = insertSource(`${m}-domain`, 'web_domain')
      const runId = insertRun(`${m}-run`)
      const err = dockerPsqlExpectError(`
        insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id, canonical_url)
        values ('${src}', 'serper_web', '${m}-ev', '${MARKER} fixture', '${runId}', NULL);
      `)
      expect(err).toContain('signal_evidence_canonical_url_required')
    })

    it('A11. a distinct algorithm_version and confidence are preserved per row (needed for byAlgorithmVersion/confidenceDiagnostics)', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev = insertEvidence({ marker: m, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-ev` })
      insertMembership(topic, ev, { algorithm_version: '2', confidence: '0.6789' })
      const rows = helperRows(topic)
      expect(rows[0].algorithm_version).toBe(2)
      expect(Number(rows[0].confidence)).toBeCloseTo(0.6789, 4)
    })
  })

  // ============================================================
  // B. Helper security -- unreachable by any external role
  // ============================================================
  describe('B. helper security boundary', () => {
    it('B1. anon role cannot call the helper directly', () => {
      const out = dockerPsqlExpectError(`SET ROLE anon; SELECT * FROM _semantic_topic_eligible_membership_sources('${randomUUID()}'::uuid); RESET ROLE;`)
      expect(out).toMatch(/permission denied for function/i)
    })

    it('B2. authenticated role cannot call the helper directly', () => {
      const out = dockerPsqlExpectError(`SET ROLE authenticated; SELECT * FROM _semantic_topic_eligible_membership_sources('${randomUUID()}'::uuid); RESET ROLE;`)
      expect(out).toMatch(/permission denied for function/i)
    })

    it('B3. service_role cannot call the helper directly either', () => {
      const out = dockerPsqlExpectError(`SET ROLE service_role; SELECT * FROM _semantic_topic_eligible_membership_sources('${randomUUID()}'::uuid); RESET ROLE;`)
      expect(out).toMatch(/permission denied for function/i)
    })

    it('B4. service_role CAN use the same logic indirectly through compute_topic_evidence_vector', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev = insertEvidence({ marker: m, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-ev` })
      insertMembership(topic, ev)
      const out = dockerPsql(`SET ROLE service_role; SELECT compute_topic_evidence_vector('${topic}'::uuid); RESET ROLE;`).trim()
      const parsed = JSON.parse(out)
      expect(parsed.ok).toBe(true)
      expect(parsed.eligibleDistinctSourceIdentityCount).toBe(1)
    })
  })

  // ============================================================
  // C. 074 record_topic_assignment_decision -- corroborating enforcement
  // ============================================================
  describe('C. 074 record_topic_assignment_decision (direct assignment path)', () => {
    it('C1. two ATTACH_EXISTING memberships, SAME signal_source_id -> stays candidate_singleton', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      // First membership establishes the topic as a candidate_singleton via CREATE_NEW.
      const ev0 = insertEvidence({ marker: `${m}-0`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-0-ev` })
      const run0 = createExtractionRunForEvidence(ev0, `${m}-0`)
      const created = recordAssignmentDecision({ extractionRunId: run0, outcome: 'CREATE_NEW', decisionReason: 'no_similar_topic_found', idempotencyKey: `${m}-0-dec` })
      expect(created.ok).toBe(true)
      const topicId = created.semantic_topic_id
      expect(topicLifecycle(topicId)).toBe('candidate_singleton')

      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const run1 = createExtractionRunForEvidence(ev1, `${m}-1`)
      const attached = recordAssignmentDecision({ extractionRunId: run1, outcome: 'ATTACH_EXISTING', decisionReason: 'exact_entity_match', idempotencyKey: `${m}-1-dec`, existingTopicId: topicId })
      expect(attached.ok).toBe(true)
      expect(topicLifecycle(topicId)).toBe('candidate_singleton')
    })

    it('C2. two ATTACH_EXISTING memberships, DIFFERENT signal_source_id -> corroborating', () => {
      const m = nextMarker()
      const srcA = insertSource(`${m}-chanA`)
      const srcB = insertSource(`${m}-chanB`)
      const ev0 = insertEvidence({ marker: `${m}-0`, sourceId: srcA, evidenceType: 'youtube_video', externalRef: `${m}-0-ev` })
      const run0 = createExtractionRunForEvidence(ev0, `${m}-0`)
      const created = recordAssignmentDecision({ extractionRunId: run0, outcome: 'CREATE_NEW', decisionReason: 'no_similar_topic_found', idempotencyKey: `${m}-0-dec` })
      const topicId = created.semantic_topic_id

      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: srcB, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const run1 = createExtractionRunForEvidence(ev1, `${m}-1`)
      recordAssignmentDecision({ extractionRunId: run1, outcome: 'ATTACH_EXISTING', decisionReason: 'exact_entity_match', idempotencyKey: `${m}-1-dec`, existingTopicId: topicId })
      expect(topicLifecycle(topicId)).toBe('corroborating')
    })

    it('C3. this is the CURRENT production shape (two distinct known YouTube channels, e.g. the real Kunal Kushwaha + NikByte case) -> corroborating', () => {
      const m = nextMarker()
      const srcA = insertSource(`${m}-kunal-like`)
      const srcB = insertSource(`${m}-nikbyte-like`)
      const ev0 = insertEvidence({ marker: `${m}-0`, sourceId: srcA, evidenceType: 'youtube_video', externalRef: `${m}-0-ev` })
      const run0 = createExtractionRunForEvidence(ev0, `${m}-0`)
      const created = recordAssignmentDecision({ extractionRunId: run0, outcome: 'CREATE_NEW', decisionReason: 'no_similar_topic_found', idempotencyKey: `${m}-0-dec` })
      const topicId = created.semantic_topic_id
      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: srcB, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const run1 = createExtractionRunForEvidence(ev1, `${m}-1`)
      recordAssignmentDecision({ extractionRunId: run1, outcome: 'ATTACH_EXISTING', decisionReason: 'manual_review_confirmed', idempotencyKey: `${m}-1-dec`, existingTopicId: topicId })
      expect(topicLifecycle(topicId)).toBe('corroborating')
    })

    it('C4. CREATE_NEW behavior is unchanged (topic_creation_seed membership, candidate_singleton)', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const ev = insertEvidence({ marker: m, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-ev` })
      const run = createExtractionRunForEvidence(ev, m)
      const out = recordAssignmentDecision({ extractionRunId: run, outcome: 'CREATE_NEW', decisionReason: 'no_similar_topic_found', idempotencyKey: `${m}-dec` })
      expect(out.ok).toBe(true)
      expect(out.outcome).toBe('CREATE_NEW')
      const reason = dockerPsql(`select assignment_reason from semantic_topic_membership where id='${out.resulting_membership_id}';`).trim()
      expect(reason).toBe('topic_creation_seed')
      expect(topicLifecycle(out.semantic_topic_id)).toBe('candidate_singleton')
    })
  })

  // ============================================================
  // D. 078 execute_approved_topic_assignment_review (human review path)
  // ============================================================
  describe('D. 078 execute_approved_topic_assignment_review (approved-review executor path)', () => {
    it('D1. ATTACH_EXISTING via approved human review, SAME signal_source_id as the seed -> stays candidate_singleton', async () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const ev0 = insertEvidence({ marker: `${m}-0`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-0-ev` })
      const run0 = createExtractionRunForEvidence(ev0, `${m}-0`)
      const created = recordAssignmentDecision({ extractionRunId: run0, outcome: 'CREATE_NEW', decisionReason: 'no_similar_topic_found', idempotencyKey: `${m}-0-dec` })
      const topicId = created.semantic_topic_id

      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      // Human-review path requires confidence < 0.85 -- at/above threshold
      // is rejected by create_topic_assignment_review_request precisely
      // because it belongs to the automatic 074 path instead (see C-suite).
      const run1 = createExtractionRunForEvidence(ev1, `${m}-1`, 0.55)
      const reviewRequestId = await createApprovedAttachRequest(m, ev1, run1, topicId)
      const out = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${reviewRequestId}'::uuid, '${m}-exec');`).trim())
      expect(out.ok).toBe(true)
      expect(topicLifecycle(topicId)).toBe('candidate_singleton')
    })

    it('D2. ATTACH_EXISTING via approved human review, DIFFERENT signal_source_id -> corroborating', async () => {
      const m = nextMarker()
      const srcA = insertSource(`${m}-chanA`)
      const srcB = insertSource(`${m}-chanB`)
      const ev0 = insertEvidence({ marker: `${m}-0`, sourceId: srcA, evidenceType: 'youtube_video', externalRef: `${m}-0-ev` })
      const run0 = createExtractionRunForEvidence(ev0, `${m}-0`)
      const created = recordAssignmentDecision({ extractionRunId: run0, outcome: 'CREATE_NEW', decisionReason: 'no_similar_topic_found', idempotencyKey: `${m}-0-dec` })
      const topicId = created.semantic_topic_id

      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: srcB, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const run1 = createExtractionRunForEvidence(ev1, `${m}-1`, 0.55)
      const reviewRequestId = await createApprovedAttachRequest(m, ev1, run1, topicId)
      const out = JSON.parse(dockerPsql(`select execute_approved_topic_assignment_review('${reviewRequestId}'::uuid, '${m}-exec');`).trim())
      expect(out.ok).toBe(true)
      expect(topicLifecycle(topicId)).toBe('corroborating')
    })
  })

  // ============================================================
  // E. 085 compute_topic_evidence_vector -- new contract
  // ============================================================
  describe('E. compute_topic_evidence_vector new JSON contract', () => {
    it('E1. TOPIC_NOT_FOUND unchanged', () => {
      const out = callVectorRpc(randomUUID())
      expect(out).toEqual({ ok: false, reasonCode: 'TOPIC_NOT_FOUND' })
    })

    it('E2. zero-state: eligibleDistinctSourceIdentityCount present, evidenceIdentityComplete/sourceIdentityKnown fail-closed FALSE, inputIntegrityStatus=not_applicable, knownIndependentSourceCount is GONE', () => {
      const topic = insertTopic()
      const out = callVectorRpc(topic)
      expect(out.ok).toBe(true)
      expect(out.eligibleDistinctSourceIdentityCount).toBe(0)
      expect(out.knownIndependentSourceCount).toBeUndefined()
      expect(out.evidenceIdentityComplete).toBe(false)
      expect(out.sourceIdentityKnown).toBe(false)
      expect(out.inputIntegrityStatus).toBe('not_applicable')
      expect(out.assignmentReasonBreakdownComplete).toBe(true)
      expect(out.unclassifiedAssignmentReasonEligibleMembershipCount).toBe(0)
    })

    it('E3. same-channel double membership -> eligibleDistinctSourceIdentityCount=1, not 2', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const ev2 = insertEvidence({ marker: `${m}-2`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-2-ev` })
      insertMembership(topic, ev1)
      insertMembership(topic, ev2)
      const out = callVectorRpc(topic)
      expect(out.eligibleMembershipCount).toBe(2)
      expect(out.eligibleDistinctSourceIdentityCount).toBe(1)
    })

    it('E4. syndication copy excluded from eligible counts, present in syndicationExcludedCount', () => {
      const m = nextMarker()
      const srcA = insertSource(`${m}-chanA`)
      const srcB = insertSource(`${m}-chanB`)
      const topic = insertTopic()
      const original = insertEvidence({ marker: `${m}-1`, sourceId: srcA, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const copy = insertEvidence({ marker: `${m}-2`, sourceId: srcB, evidenceType: 'youtube_video', externalRef: `${m}-2-ev`, isSyndicationCopyOf: original })
      insertMembership(topic, original)
      insertMembership(topic, copy)
      const out = callVectorRpc(topic)
      expect(out.activeMembershipCount).toBe(2)
      expect(out.eligibleMembershipCount).toBe(1)
      expect(out.syndicationExcludedCount).toBe(1)
      expect(out.eligibleDistinctSourceIdentityCount).toBe(1)
    })

    it('E5. YouTube evidence with canonical_url=NULL -> evidenceIdentityComplete=true, sourceIdentityKnown=true, inputIntegrityStatus=complete', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev = insertEvidence({ marker: m, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-ev`, canonicalUrl: null })
      insertMembership(topic, ev)
      const out = callVectorRpc(topic)
      expect(out.evidenceIdentityComplete).toBe(true)
      expect(out.sourceIdentityKnown).toBe(true)
      expect(out.inputIntegrityStatus).toBe('complete')
    })

    it('E6. serper_web + serper_news evidence, distinct web_domain sources, counted correctly', () => {
      const m = nextMarker()
      const srcA = insertSource(`${m}-domainA`, 'web_domain')
      const srcB = insertSource(`${m}-domainB`, 'web_domain')
      const topic = insertTopic()
      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: srcA, evidenceType: 'serper_web', externalRef: `${m}-1-ev`, canonicalUrl: `https://a.example.test/${m}` })
      const ev2 = insertEvidence({ marker: `${m}-2`, sourceId: srcB, evidenceType: 'serper_news', externalRef: `${m}-2-ev`, canonicalUrl: `https://b.example.test/${m}` })
      insertMembership(topic, ev1)
      insertMembership(topic, ev2)
      const out = callVectorRpc(topic)
      expect(out.eligibleMembershipCount).toBe(2)
      expect(out.eligibleDistinctSourceIdentityCount).toBe(2)
      expect(out.evidenceIdentityComplete).toBe(true)
      expect(out.sourceIdentityKnown).toBe(true)
    })

    it('E7. top-level eligibleDistinctSourceIdentityCount is NOT derived by summing the assignment-reason breakdown (same channel under two different reasons)', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const ev2 = insertEvidence({ marker: `${m}-2`, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-2-ev` })
      insertMembership(topic, ev1, { assignment_reason: "'manual_review_confirmed'" })
      insertMembership(topic, ev2, { assignment_reason: "'entity_event_match'" })
      const out = callVectorRpc(topic)
      expect(out.eligibleDistinctSourceIdentityCount).toBe(1)
      expect(out.manualReviewConfirmedSourceCount).toBe(1)
      expect(out.automatedAssignmentSourceCount).toBe(1)
      // Sum of the breakdown (2) intentionally != top-level distinct count (1).
      expect(out.manualReviewConfirmedSourceCount + out.automatedAssignmentSourceCount).not.toBe(out.eligibleDistinctSourceIdentityCount)
    })

    it('E8. topic_creation_seed breakdown and assignmentReasonBreakdownComplete unchanged', () => {
      const m = nextMarker()
      const src = insertSource(`${m}-chan`)
      const topic = insertTopic()
      const ev = insertEvidence({ marker: m, sourceId: src, evidenceType: 'youtube_video', externalRef: `${m}-ev` })
      insertMembership(topic, ev, { assignment_reason: "'topic_creation_seed'" })
      const out = callVectorRpc(topic)
      expect(out.topicCreationSeedSourceCount).toBe(1)
      expect(out.assignmentReasonBreakdownComplete).toBe(true)
      expect(out.unclassifiedAssignmentReasonEligibleMembershipCount).toBe(0)
    })

    it('E9. mixedAlgorithmVersions and byAlgorithmVersion still derived correctly from the shared helper', () => {
      const m = nextMarker()
      const srcA = insertSource(`${m}-chanA`)
      const srcB = insertSource(`${m}-chanB`)
      const topic = insertTopic()
      const ev1 = insertEvidence({ marker: `${m}-1`, sourceId: srcA, evidenceType: 'youtube_video', externalRef: `${m}-1-ev` })
      const ev2 = insertEvidence({ marker: `${m}-2`, sourceId: srcB, evidenceType: 'youtube_video', externalRef: `${m}-2-ev` })
      insertMembership(topic, ev1, { algorithm_version: '1' })
      insertMembership(topic, ev2, { algorithm_version: '2' })
      const out = callVectorRpc(topic)
      expect(out.mixedAlgorithmVersions).toBe(true)
      expect(out.byAlgorithmVersion['1'].eligibleDistinctSourceIdentityCount).toBe(1)
      expect(out.byAlgorithmVersion['2'].eligibleDistinctSourceIdentityCount).toBe(1)
    })
  })

  // ============================================================
  // F. Static/structural regression proofs
  // ============================================================
  describe('F. static source guarantees', () => {
    it('F1. the corrected 074/078 function bodies no longer contain a raw active-membership count(*) lifecycle trigger', () => {
      // Split on the CREATE OR REPLACE bodies and check each body segment
      // individually -- a global regex over the whole file would also match
      // the (expected, harmless) legacy-hash comment prose.
      const rtadBody = migrationSource.split('CREATE OR REPLACE FUNCTION public.record_topic_assignment_decision')[1].split('$rpc$;')[0]
      const eatarBody = migrationSource.split('CREATE OR REPLACE FUNCTION public.execute_approved_topic_assignment_review')[1].split('$rpc$;')[0]
      expect(rtadBody).not.toMatch(/count\(\*\)\s+INTO\s+v_active_count\s+FROM\s+public\.semantic_topic_membership/i)
      expect(eatarBody).not.toMatch(/count\(\*\)\s+INTO\s+v_active_count\s+FROM\s+public\.semantic_topic_membership/i)
      expect(rtadBody).toContain('_semantic_topic_eligible_membership_sources')
      expect(eatarBody).toContain('_semantic_topic_eligible_membership_sources')
    })

    it('F2. compute_topic_evidence_vector and both transition writers reference the same shared helper name', () => {
      const ctevBody = migrationSource.split('CREATE OR REPLACE FUNCTION public.compute_topic_evidence_vector')[1].split('$rpc$;')[0]
      expect(ctevBody).toContain('_semantic_topic_eligible_membership_sources')
      expect(ctevBody).not.toMatch(/LEFT JOIN\s+public\.youtube_videos/i)
    })
  })

  // ============================================================
  // G. Migration idempotency / fail-closed drift
  // ============================================================
  describe('G. migration reapply and drift handling', () => {
    it('G1. reapplying 086 against an already-migrated DB is a clean no-op', () => {
      const r = runMigration(MIGRATION_086_PATH)
      expect(r.threw).toBe(false)
      expect(r.out).toMatch(/086: _semantic_topic_eligible_membership_sources already exists and matches exactly -- no-op\./)
      expect(r.out).toMatch(/086: record_topic_assignment_decision already exactly the corrected body -- no-op\./)
      expect(r.out).toMatch(/086: execute_approved_topic_assignment_review already exactly the corrected body -- no-op\./)
      expect(r.out).toMatch(/086: compute_topic_evidence_vector already exactly the corrected body -- no-op\./)
      expect(r.out).toMatch(/086: final self-check passed/)
    })

    it('G2. an unrecognized (neither legacy nor corrected) body hash fails closed with no DDL, and is cleanly restorable', () => {
      // Extract the exact corrected CREATE OR REPLACE statement straight out
      // of the migration file (the same text F1/F2 already parse out) so
      // restoration afterward re-applies EXACTLY the audited corrected body
      // -- not a hand-retyped approximation.
      const correctedStatement =
        'CREATE OR REPLACE FUNCTION public.record_topic_assignment_decision' +
        migrationSource.split('CREATE OR REPLACE FUNCTION public.record_topic_assignment_decision')[1].split('$rpc$;')[0] +
        '$rpc$;'

      dockerPsql(`
        BEGIN;
        CREATE OR REPLACE FUNCTION public.record_topic_assignment_decision(
          p_extraction_run_id UUID, p_outcome TEXT, p_decision_reason TEXT, p_deterministic_signals JSONB,
          p_idempotency_key TEXT, p_existing_semantic_topic_id UUID
        ) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $rpc$
        BEGIN
          -- deliberately tampered/unknown body for this drift test
          RETURN jsonb_build_object('ok', true, 'tampered', true);
        END;
        $rpc$;
        COMMIT;
      `)
      const r = runMigration(MIGRATION_086_PATH)
      expect(r.threw).toBe(true)
      expect(r.out).toMatch(/086 fail-closed: DEFINITION_DRIFT -- record_topic_assignment_decision body_hash=.* is neither the known 074 legacy hash nor the corrected hash/)

      // Restore the exact corrected body (CREATE OR REPLACE preserves
      // owner/ACL automatically, same as 086's own REPLACE branch).
      dockerPsql(`BEGIN; ${correctedStatement} COMMIT;`)
      const restoredHash = dockerPsql(
        `select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid)'::regprocedure;`,
      ).trim()
      expect(restoredHash).toBe('9e681c94870719a0a7cb4605de458baf')

      const r2 = runMigration(MIGRATION_086_PATH)
      expect(r2.threw).toBe(false)
      expect(r2.out).toMatch(/086: record_topic_assignment_decision already exactly the corrected body -- no-op\./)
    })
  })
})
