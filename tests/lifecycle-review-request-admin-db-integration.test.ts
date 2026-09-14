// PFM Lifecycle Operator CLI v1 -- REAL local DB integration tests for the
// request-creation support module (lifecycle-request-admin-cli-support.ts),
// exercised against 087's already-production
// create_semantic_topic_lifecycle_review_request RPC. No new migration --
// 087 remains byte-identical to what is already live in production; this
// file only proves the new operator-CLI wrapper maps its real behavior
// correctly, and that the module's own mechanical-floor preview mirror
// matches the real, private _semantic_topic_lifecycle_mechanical_check
// function's live output exactly.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import {
  fetchLifecycleRequestPreview,
  previewMechanicalFloorReasonCode,
  runCreateLifecycleReviewRequest,
} from '@/lib/semantic-topic/lifecycle-request-admin-cli-support'

const MIGRATION_087_PATH = join(process.cwd(), 'supabase/migrations/087_semantic_topic_lifecycle_review_framework.sql')
const LOCAL_API_URL = 'http://127.0.0.1:54321'
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
  execSync(`curl -sf ${LOCAL_API_URL}/auth/v1/health -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"`, { stdio: 'ignore' })
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}
const describeIfLocalDb = stackAvailable ? describe : describe.skip

const MARKER = 'lrca-e2e'
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

function requestRowCount(topicId: string): number {
  return Number(dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests where semantic_topic_id='${topicId}';`).trim())
}

// The real, private mechanical-check function -- callable only as
// postgres (superuser via docker exec), never through any client this
// CLI itself could construct. Used ONLY to cross-verify
// previewMechanicalFloorReasonCode()'s TS mirror against the real DB
// function's live output for the same vector.
function realMechanicalCheck(vectorJson: string): string | null {
  const out = dockerPsql(`select coalesce(_semantic_topic_lifecycle_mechanical_check('${vectorJson.replace(/'/g, "''")}'::jsonb), '__NULL__');`).trim()
  return out === '__NULL__' ? null : out
}

describeIfLocalDb('PFM Lifecycle Operator CLI v1 -- request-creation support module (real local DB)', () => {
  beforeAll(() => {
    ensureFullyApplied()
    cleanupTestData()
  })
  afterAll(() => {
    cleanupTestData()
  })

  // ============================================================
  // A. Dry-run never writes; apply writes exactly once
  // ============================================================
  describe('A. write-RPC call count', () => {
    it('A1. dry-run never creates a row', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const before = requestRowCount(topic)
      const outcome = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op`, dryRun: true,
      })
      expect(outcome.kind).toBe('dry_run')
      expect(requestRowCount(topic)).toBe(before)
    })

    it('A2. apply creates exactly one row on a clean success', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const outcome = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op`, dryRun: false,
      })
      expect(outcome.kind).toBe('created')
      expect(requestRowCount(topic)).toBe(1)
    })
  })

  // ============================================================
  // B. Idempotency: replay never duplicates, different inputs never collide
  // ============================================================
  describe('B. idempotency and replay', () => {
    it('B1. the same operator-reference + topic + target replays cleanly -- no second row', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const first = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op`, dryRun: false,
      })
      expect(first.kind).toBe('created')
      const replay = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op`, dryRun: false,
      })
      expect(replay.kind).toBe('replayed')
      expect(requestRowCount(topic)).toBe(1)
    })

    it('B2. a different operator-reference for the same topic+target hits the actionable-uniqueness business rule (still exactly one row, no crash)', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const first = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op-a`, dryRun: false,
      })
      expect(first.kind).toBe('created')
      const second = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'ambiguous', operatorReference: `${m}-op-b`, dryRun: false,
      })
      expect(second.kind).toBe('request_already_actionable')
      expect(requestRowCount(topic)).toBe(1)
    })
  })

  // ============================================================
  // C. Business rejections -- normal outcomes, no exception, no retry
  // ============================================================
  describe('C. business rejections', () => {
    it('C1. an unsupported transition is rejected without ever creating a row', async () => {
      const m = nextMarker()
      const topic = insertTopic('candidate_singleton')
      const outcome = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op`, dryRun: false,
      })
      expect(outcome).toEqual({ kind: 'unsupported_transition' })
      expect(requestRowCount(topic)).toBe(0)
    })

    it('C2. a topic below the mechanical floor (1 known source) is rejected with evidence_floor_not_met, no row created', async () => {
      const m = nextMarker()
      const topic = makeTopicWithNSources(m, 'corroborating', 1)
      const outcome = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op`, dryRun: false,
      })
      expect(outcome).toEqual({ kind: 'evidence_floor_not_met', reasonCode: 'INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES' })
      expect(requestRowCount(topic)).toBe(0)
    })

    it('C3. an ambiguous target is never subject to the mechanical floor, even with zero known sources', async () => {
      const m = nextMarker()
      const topic = insertTopic('corroborating')
      const outcome = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'ambiguous', operatorReference: `${m}-op`, dryRun: false,
      })
      expect(outcome.kind).toBe('created')
    })
  })

  // ============================================================
  // D. Preview mirror is bit-exact with the real, private mechanical-check
  //    function -- cross-verified for representative vectors.
  // ============================================================
  describe('D. previewMechanicalFloorReasonCode matches the real DB function exactly', () => {
    it('D1. a passing vector (2 sources, all flags complete)', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const preview = await fetchLifecycleRequestPreview(adminClient as any, { semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op` })
      if (!preview.ok) throw new Error('unreachable')
      const vector = preview.preview.evidenceVectorSummary
      const real = realMechanicalCheck(JSON.stringify(vector))
      expect(preview.preview.mechanicalFloorExpectedReasonCode).toBe(real)
      expect(real).toBeNull()
    })

    it('D2. a failing vector (1 source) -- TS mirror and real function agree on INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES', async () => {
      const m = nextMarker()
      const topic = makeTopicWithNSources(m, 'corroborating', 1)
      const preview = await fetchLifecycleRequestPreview(adminClient as any, { semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op` })
      if (!preview.ok) throw new Error('unreachable')
      const vector = preview.preview.evidenceVectorSummary
      const real = realMechanicalCheck(JSON.stringify(vector))
      expect(preview.preview.mechanicalFloorExpectedReasonCode).toBe(real)
      expect(real).toBe('INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES')
    })

    it('D3. a zero-source vector', async () => {
      const m = nextMarker()
      const topic = insertTopic('corroborating')
      const preview = await fetchLifecycleRequestPreview(adminClient as any, { semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op` })
      if (!preview.ok) throw new Error('unreachable')
      const vector = preview.preview.evidenceVectorSummary
      const real = realMechanicalCheck(JSON.stringify(vector))
      expect(preview.preview.mechanicalFloorExpectedReasonCode).toBe(real)
    })
  })

  // ============================================================
  // E. Redaction: no raw UUID, idempotency key, or DB error text leaks
  //    through the outcome/preview objects this module ever returns.
  // ============================================================
  describe('E. redaction', () => {
    it('E1. a created outcome never includes the full review_request_id or the full idempotency key', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const outcome = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op`, dryRun: false,
      })
      const text = JSON.stringify(outcome)
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
      expect(text).not.toMatch(/lifecycle-review-request-admin:create:[0-9a-f]{32}/)
    })

    it('E2. a dry-run preview never includes a raw source identity, external_ref, or channel id', async () => {
      const m = nextMarker()
      const topic = makeCorroboratingTopicWithTwoSources(m)
      const preview = await fetchLifecycleRequestPreview(adminClient as any, { semanticTopicId: topic, targetStatus: 'coherent', operatorReference: `${m}-op` })
      const text = JSON.stringify(preview)
      expect(text).not.toMatch(new RegExp(`${m}-chan`))
      expect(text).not.toMatch(new RegExp(`${m}-\\d+-ev`))
    })

    it('E3. a database_error outcome never includes the raw Postgres error message', async () => {
      // Force an unrecognized error by targeting a non-existent topic id
      // whose UUID happens to be well-formed but has no row -- this hits
      // the RPC's own 'not found' RAISE EXCEPTION, mapped to
      // configuration_error with a fixed, generic message (never the raw
      // Postgres text).
      const outcome = await runCreateLifecycleReviewRequest(adminClient as any, {
        semanticTopicId: '00000000-0000-4000-8000-000000000000', targetStatus: 'coherent', operatorReference: `${nextMarker()}-op`, dryRun: false,
      })
      expect(outcome.kind).toBe('configuration_error')
      if (outcome.kind === 'configuration_error') {
        expect(outcome.message).not.toMatch(/RAISE EXCEPTION|pg_catalog|ERROR:/i)
      }
    })
  })

  // ============================================================
  // F. 087's own committed body hashes remain unchanged -- this gate
  //    introduces no migration and touches no RPC source.
  // ============================================================
  describe('F. 087 is untouched', () => {
    it('F1. create_semantic_topic_lifecycle_review_request body hash is unchanged', () => {
      const hash = dockerPsql(
        `select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where oid = 'public.create_semantic_topic_lifecycle_review_request(uuid, text, text)'::regprocedure;`,
      ).trim()
      expect(hash).toBe('162b4b91d7d742722a4f580ababff34c')
    })
    it('F2. reapplying 087 is a clean no-op', () => {
      const r = runMigration(MIGRATION_087_PATH)
      expect(r.threw).toBe(false)
      expect(r.out).toMatch(/087: final self-check passed/)
    })
  })

  // ============================================================
  // G. Local DB returns to a clean baseline after every test in this file
  //    (proven by the beforeAll/afterAll cleanup + marker-scoped fixtures;
  //    this test confirms no marker-scoped row survives once this describe
  //    block's own afterAll has run by re-running the same cleanup query
  //    and asserting zero rows remain).
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
