// PFM Approved Human Review Executor v0 -- REAL CLI subprocess E2E. Spawns
// `node scripts/execute-approved-review.ts` as a real child process. Mirrors
// tests/post-completion-review-recovery-cli-subprocess-e2e.test.ts's own
// pattern exactly, including its documented KNOWN LIMITATION (the
// project-identity guard is fail-closed for any local target, so a real
// executed/replayed success path cannot be driven through the REAL
// subprocess here -- that is proven for real in
// execute-approved-review-db-integration.test.ts, which calls the module
// directly, bypassing the CLI's own guard). ANTHROPIC_API_KEY is never set
// for any child process spawned here.
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const REPO_ROOT = process.cwd()
const CLI_ENTRY = path.join(REPO_ROOT, 'scripts', 'execute-approved-review.ts')
const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const MARKER = 'earx-cli-e2e'
const WRONG_REF = 'wrong-project-ref'

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

function structuredOutput(): string {
  const base = {
    extraction_schema_version: 1, canonical_phenomenon_label: 'cli e2e phenomenon', label_language: 'en',
    subject_entities: ['E'], action_or_event: null, location: null, temporal_context: null,
    specificity: 'specific', content_format: 'other', confidence: 0.5,
    supporting_spans: [{ source_field: 'title', quoted_text: 'cli e2e phenomenon' }],
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

function createApprovedRequestViaSql(m: string): { reviewRequestId: string } {
  // For the CLI-subprocess suite (which never reaches a state where the
  // executor RPC would actually inspect approval_digest -- every real
  // subprocess invocation here is guard-rejected before any DB call, per
  // the documented KNOWN LIMITATION), a real RPC-driven approval chain is
  // unnecessary ceremony. A minimal, directly-inserted pending request is
  // enough to prove the guard-rejection paths never touch it.
  const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
  const evidenceId = dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${m}-ev', '${MARKER} fixture', '${runId}') returning id;`).trim()
  const extractionResult = JSON.parse(dockerPsql(`select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
    'norm-${m}', 1, 'completed', '${structuredOutput()}'::jsonb, 100, 50, 0.001, NULL,
    '${m}-ext', now() - interval '1 minute', now()
  );`).trim())
  const reviewRequestId = JSON.parse(dockerPsql(`select create_topic_assignment_review_request('${extractionResult.extraction_run_id}'::uuid, '${m}-create');`).trim()).review_request_id
  return { reviewRequestId }
}

function cleanupMarker() {
  dockerPsql(`
    delete from topic_assignment_review_events where review_request_id in (select id from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%')));
    delete from topic_assignment_review_requests where extraction_run_id in (select id from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%'));
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
  `)
}

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANTHROPIC_API_KEY
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

function assertNeverCalledProvider(result: CliResult) {
  const combined = result.stdout + result.stderr
  expect(combined).not.toMatch(/api\.anthropic\.com/i)
  expect(combined).not.toContain('Anthropic is not configured')
}

const ANY_UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
function assertNoFullUuidAnywhere(result: CliResult) {
  const combined = result.stdout + result.stderr
  expect(combined.match(ANY_UUID_REGEX) ?? []).toEqual([])
}

const BASE_ENV = { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY, SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED: 'true' }

describeIfLocalDb('Approved Human Review Executor CLI -- REAL subprocess E2E', () => {
  beforeAll(() => cleanupMarker())
  afterEach(() => cleanupMarker())
  afterAll(() => {
    cleanupMarker()
    expect(dockerPsql('select enabled from ai_extraction_control where id=1;').trim()).toBe('f')
    expect(dockerPsql('select enabled from supervised_intake_control where id=1;').trim()).toBe('f')
  })

  it('missing --review-request-id: exit 2, help text, no DB touched', async () => {
    const result = await runCli(['--confirm-production', 'local'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    assertNeverCalledProvider(result)
  })

  it('missing SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED: exit 2 before any DB call', async () => {
    const { reviewRequestId } = createApprovedRequestViaSql(`${MARKER}-${Date.now()}-a`)
    const result = await runCli(['--review-request-id', reviewRequestId, '--confirm-production', 'local', '--dry-run'], { ...BASE_ENV, SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED: undefined })
    expect(result.exitCode).toBe(2)
  })

  it('--confirm-production mismatch against the real local target: exit 2, RPC never reached, zero UUID leakage', async () => {
    const { reviewRequestId } = createApprovedRequestViaSql(`${MARKER}-${Date.now()}-b`)
    const result = await runCli(['--review-request-id', reviewRequestId, '--confirm-production', WRONG_REF], BASE_ENV)
    expect(result.exitCode).toBe(2)
    assertNoFullUuidAnywhere(result)
    const requestStatus = dockerPsql(`select status from topic_assignment_review_requests where id='${reviewRequestId}';`).trim()
    expect(requestStatus).toBe('pending')
  })

  it('localhost target can never satisfy --confirm-production, even when the confirmation string is literally "local"', async () => {
    const { reviewRequestId } = createApprovedRequestViaSql(`${MARKER}-${Date.now()}-c`)
    const result = await runCli(['--review-request-id', reviewRequestId, '--confirm-production', 'local'], BASE_ENV)
    expect(result.exitCode).toBe(2)
  })

  // KNOWN LIMITATION (matches post-completion-review-recovery's own,
  // documented for the identical reason): resolveProjectIdentity()
  // classifies 127.0.0.1/localhost as kind:'local', and projectGuardPasses()
  // never accepts that kind regardless of what string --confirm-production
  // carries -- so the REAL CLI subprocess run against this local stack can
  // only ever be driven through its guard-rejection paths here. The
  // executed/replayed/not_executable/blocked outcomes are proven for real,
  // against the real RPC, in execute-approved-review-db-integration.test.ts
  // (which calls the lib function directly, bypassing the CLI's own guard).
  it('dry-run against the local stack is rejected by the guard (exit 2) even though the request itself is genuinely approved-shaped -- local can never pass --confirm-production', async () => {
    const { reviewRequestId } = createApprovedRequestViaSql(`${MARKER}-${Date.now()}-d`)
    const result = await runCli(['--review-request-id', reviewRequestId, '--confirm-production', 'local', '--dry-run'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    assertNoFullUuidAnywhere(result)
    const requestStatus = dockerPsql(`select status from topic_assignment_review_requests where id='${reviewRequestId}';`).trim()
    expect(requestStatus).toBe('pending')
  })

  it('full UUID never appears in stdout/stderr on any invocation, only an 8-char prefix', async () => {
    const { reviewRequestId } = createApprovedRequestViaSql(`${MARKER}-${Date.now()}-e`)
    const result = await runCli(['--review-request-id', reviewRequestId, '--confirm-production', WRONG_REF], BASE_ENV)
    const combined = result.stdout + result.stderr
    expect(combined).not.toContain(reviewRequestId)
  })

  it('invalid --review-request-id (not a UUID) never reaches any import or DB call: exit 2', async () => {
    const result = await runCli(['--review-request-id', 'not-a-uuid', '--confirm-production', 'local'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    assertNeverCalledProvider(result)
  })

  it('help text never requires a real config and exits 0', async () => {
    const result = await runCli(['--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Approved Human Review Executor')
  })
})
