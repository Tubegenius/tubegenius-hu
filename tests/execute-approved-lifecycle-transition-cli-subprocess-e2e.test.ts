// PFM Lifecycle Operator CLI v1 -- real subprocess proof for the executor
// CLI's dry-run/apply guards and output redaction. This suite deliberately
// CANNOT exercise a successful --apply run (same documented
// local-target-can-never-pass-the-production-guard limitation as its
// sibling suite). A genuine --apply execution is proven at the RPC layer
// instead (tests/execute-approved-lifecycle-transition-db-integration.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = join(__dirname, '..')
const CLI_ENTRY = join(REPO_ROOT, 'scripts', 'execute-approved-lifecycle-transition.ts')

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const adminClient = createClient(LOCAL_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', { input: sql, encoding: 'utf-8' })
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}
const describeIfLocalDb = stackAvailable ? describe : describe.skip

const MARKER = 'eaLT-subprocess'
function randomHexDigest(): string {
  let s = ''
  while (s.length < 64) s += Math.floor(Math.random() * 16).toString(16)
  return s
}
function insertSource(externalId: string): string {
  return dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${externalId}', '${externalId}') returning id;`).trim()
}
function insertRun(idempotencyKey: string): string {
  return dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${idempotencyKey}', 'completed', now()) returning id;`).trim()
}
function insertEvidence(marker: string, sourceId: string): string {
  const runId = insertRun(`${marker}-run`)
  return dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${marker}-ev', '${MARKER} fixture', '${runId}') returning id;`).trim()
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
function cleanup() {
  dockerPsql(`
    delete from semantic_topic_lifecycle_review_events where review_request_id in (select id from semantic_topic_lifecycle_review_requests where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%'));
    delete from semantic_topic_lifecycle_review_requests where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%');
    delete from semantic_topic_membership where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%') or signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from semantic_topics where canonical_label like '${MARKER}%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
  `)
}

interface CliResult { exitCode: number; stdout: string; stderr: string }

async function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_ENTRY, ...args], { cwd: REPO_ROOT, env, timeout: 30_000 })
    return { exitCode: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    if (typeof e.code !== 'number') throw err
    return { exitCode: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const BASE_ENV = { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY }
const MARKER_EMAIL = `${MARKER}-reviewer-${Date.now()}@example.test`
const MARKER_PASSWORD = `Test-${randomUUID()}-!Aa1`

describeIfLocalDb('PFM Lifecycle Operator CLI v1 -- executor CLI subprocess (guards, redaction)', () => {
  let approvedReviewRequestId: string
  let reviewerUserId: string

  beforeAll(async () => {
    cleanup()
    const { data, error } = await adminClient.auth.admin.createUser({ email: MARKER_EMAIL, password: MARKER_PASSWORD, email_confirm: true })
    if (error || !data.user) throw new Error(`failed to create fixture reviewer: ${error?.message}`)
    reviewerUserId = data.user.id
    dockerPsql(`insert into semantic_topic_reviewers (user_id, provisioning_note) values ('${reviewerUserId}', '${MARKER} fixture -- not a real bootstrap') on conflict do nothing;`)
    const userClient = createClient(LOCAL_URL, LOCAL_ANON_KEY)
    const signIn = await userClient.auth.signInWithPassword({ email: MARKER_EMAIL, password: MARKER_PASSWORD })
    if (signIn.error) throw new Error(`fixture reviewer sign-in failed: ${signIn.error.message}`)

    const topic = makeCorroboratingTopicWithTwoSources(MARKER)
    const created = createRequestAsService(topic, 'coherent', `${MARKER}-req`)
    const { error: decisionError } = await (userClient as any).rpc('record_semantic_topic_lifecycle_review_decision', {
      p_review_request_id: created.reviewRequestId,
      p_decision_idempotency_key: `${MARKER}-dec`,
      p_outcome: 'approved',
      p_reason_code: 'identity_consistency_confirmed',
      p_reviewer_rationale: 'Confirmed for executor subprocess fixture.',
      p_same_semantic_identity_confirmed: true,
      p_no_material_identity_conflict: true,
      p_canonical_definition_scope_fit_confirmed: true,
      p_provenance_relationship_reviewed: true,
      p_review_policy_version: 1,
    })
    if (decisionError) throw decisionError
    approvedReviewRequestId = created.reviewRequestId
  })
  afterAll(async () => {
    cleanup()
    try {
      dockerPsql(`delete from semantic_topic_reviewer_events where reviewer_user_id='${reviewerUserId}'; delete from semantic_topic_reviewers where user_id='${reviewerUserId}';`)
    } finally {
      if (reviewerUserId) await adminClient.auth.admin.deleteUser(reviewerUserId)
    }
  })

  it('--help exits 0 and needs no environment', async () => {
    const result = await runCli(['--help'], {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('PFM Lifecycle Operator CLI v1')
  })

  it('missing --review-request-id: exit 2, no DB touched', async () => {
    const before = dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${approvedReviewRequestId}';`).trim()
    const result = await runCli([], BASE_ENV)
    expect(result.exitCode).toBe(2)
    expect(dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${approvedReviewRequestId}';`).trim()).toBe(before)
  })

  it('malformed --review-request-id: exit 2', async () => {
    const result = await runCli(['--review-request-id', 'not-a-uuid'], BASE_ENV)
    expect(result.exitCode).toBe(2)
  })

  it('default (dry-run) mode against the approved fixture: exit 0, reports executable=true, never mutates the topic', async () => {
    const before = dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${approvedReviewRequestId}';`).trim()
    const result = await runCli(['--review-request-id', approvedReviewRequestId], BASE_ENV)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/dry_run/)
    expect(result.stdout).toMatch(/"executable":true/)
    expect(dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${approvedReviewRequestId}';`).trim()).toBe(before)
  })

  it('--apply without --confirm-production-project-ref: exit 2, RPC never reached', async () => {
    const before = dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${approvedReviewRequestId}';`).trim()
    const result = await runCli(['--review-request-id', approvedReviewRequestId, '--apply'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    expect(dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${approvedReviewRequestId}';`).trim()).toBe(before)
  })

  it('--apply against the real local target can never pass the production guard', async () => {
    const before = dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${approvedReviewRequestId}';`).trim()
    const result = await runCli(['--review-request-id', approvedReviewRequestId, '--apply', '--confirm-production-project-ref', 'abcdefghijklmnop'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    expect(dockerPsql(`select status from semantic_topic_lifecycle_review_requests where id='${approvedReviewRequestId}';`).trim()).toBe(before)
  })

  it('the full --confirm-production-project-ref value never appears in stdout/stderr in the rejected apply-guard path or in dry-run', async () => {
    const distinctiveRef = 'zzzdistinctivetestprojectref999'
    const rejected = await runCli(['--review-request-id', approvedReviewRequestId, '--apply', '--confirm-production-project-ref', distinctiveRef], BASE_ENV)
    expect(rejected.stdout + rejected.stderr).not.toContain(distinctiveRef)
    const dryRun = await runCli(['--review-request-id', approvedReviewRequestId], BASE_ENV)
    expect(dryRun.stdout + dryRun.stderr).not.toContain(distinctiveRef)
  })

  it('dry-run output never contains a full UUID -- only 8-char prefixes', async () => {
    const result = await runCli(['--review-request-id', approvedReviewRequestId], BASE_ENV)
    const combined = result.stdout + result.stderr
    expect(combined).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(combined).toMatch(/reviewRequestIdPrefix/)
  })

  it('missing environment variables: exit 2 before any import of createAdminClient', async () => {
    const result = await runCli(['--review-request-id', approvedReviewRequestId], { NEXT_PUBLIC_SUPABASE_URL: undefined })
    expect(result.exitCode).toBe(2)
    expect(result.stdout + result.stderr).toContain('required environment variable')
  })
})
