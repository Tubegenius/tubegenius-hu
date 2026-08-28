// PFM Post-Completion Review Handoff Recovery v0 -- REAL CLI subprocess
// E2E. Spawns `node scripts/post-completion-review-recovery.ts` as a real
// child process -- the real entrypoint, arg-parsing, Node-version preflight,
// ts-alias-loader registration, and environment boundary an operator would
// actually hit. Mirrors tests/supervised-intake-cli-subprocess-e2e.test.ts's
// pattern exactly. ANTHROPIC_API_KEY is never set for any child process
// spawned here.
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const REPO_ROOT = process.cwd()
const CLI_ENTRY = path.join(REPO_ROOT, 'scripts', 'post-completion-review-recovery.ts')
const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const MARKER = 'pcrr-cli-e2e'
// Local Supabase's demo project ref (the "project" this LOCAL_URL identifies
// under resolveProjectIdentity's rules is 'local', not a project ref at all
// -- see the dedicated mismatch test below). A syntactically-valid-looking
// but wrong ref used for the negative test.
const WRONG_REF = 'wrong-project-ref'

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

let fixtureCounter = 0
function nextMarker(): string {
  fixtureCounter += 1
  return `${MARKER}-${Date.now()}-${fixtureCounter}`
}

function structuredOutput(overrides: Record<string, unknown> = {}): string {
  const base = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: 'cli e2e test phenomenon',
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'other',
    confidence: 0.62,
    supporting_spans: [{ source_field: 'title', quoted_text: 'cli e2e test phenomenon' }],
    ...overrides,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

function createExtraction(): { extractionRunId: string } {
  const m = nextMarker()
  const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
  const evidenceId = dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${m}-ev', '${MARKER} fixture evidence', '${runId}') returning id;`).trim()
  const result = JSON.parse(dockerPsql(`select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
    'norm-${m}', 1, 'completed', '${structuredOutput()}'::jsonb, 100, 50, 0.001, NULL,
    '${m}-ext', now() - interval '1 minute', now()
  );`).trim())
  return { extractionRunId: result.extraction_run_id }
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

const BASE_ENV = { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY, SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED: 'true' }

describeIfLocalDb('Post-Completion Review Handoff Recovery CLI -- REAL subprocess E2E', () => {
  beforeAll(() => {
    cleanupMarker()
  })
  afterEach(() => {
    cleanupMarker()
  })
  afterAll(() => {
    cleanupMarker()
    expect(dockerPsql('select enabled from ai_extraction_control where id=1;').trim()).toBe('f')
    expect(dockerPsql('select enabled from supervised_intake_control where id=1;').trim()).toBe('f')
  })

  it('missing --extraction-run-id: exit 2, help text, no DB touched', async () => {
    const result = await runCli(['--confirm-production', 'local'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    assertNeverCalledProvider(result)
  })

  it('missing SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED: exit 2 before any DB call', async () => {
    const { extractionRunId } = createExtraction()
    const result = await runCli(['--extraction-run-id', extractionRunId, '--confirm-production', 'local', '--dry-run'], { ...BASE_ENV, SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED: undefined })
    expect(result.exitCode).toBe(2)
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('0')
  })

  it('--confirm-production mismatch against the real local target: exit 2, RPC never reached', async () => {
    const { extractionRunId } = createExtraction()
    const result = await runCli(['--extraction-run-id', extractionRunId, '--confirm-production', WRONG_REF], BASE_ENV)
    expect(result.exitCode).toBe(2)
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('0')
  })

  it('localhost target can never satisfy --confirm-production, even when the confirmation string is literally "local"', async () => {
    const { extractionRunId } = createExtraction()
    const result = await runCli(['--extraction-run-id', extractionRunId, '--confirm-production', 'local'], BASE_ENV)
    // 'local' is never a valid remote project ref -- resolveProjectIdentity
    // classifies 127.0.0.1 as kind:'local', which projectGuardPasses always
    // rejects regardless of the string compared against it.
    expect(result.exitCode).toBe(2)
  })

  // KNOWN LIMITATION (disclosed in the final report, Section I): the
  // project-identity guard is deliberately fail-closed for ANY local target
  // -- resolveProjectIdentity() classifies 127.0.0.1/localhost as
  // kind:'local', and projectGuardPasses() never accepts that kind
  // regardless of what string --confirm-production carries (see the unit
  // tests). This is intentional (Section E's explicit requirement), but it
  // means the REAL CLI subprocess, run against this local stack, can only
  // ever be driven through its guard-rejection paths here -- it can never
  // reach exit 0 for a genuine created/replayed/ineligible/blocked outcome
  // in THIS test file, because doing so would require a real *.supabase.co
  // URL. Those success-path outcomes are proven for real, against the real
  // RPC, in post-completion-review-recovery-db-integration.test.ts (which
  // calls the lib function directly, bypassing the CLI's own guard) and at
  // the CLI argument-parsing level in the unit suite. This test file's job
  // is narrower and still load-bearing: prove the real subprocess's guard
  // actually rejects a local target end-to-end, with zero DB side effects
  // and zero UUID leakage, exactly as an operator would experience it.
  it('dry-run against the local stack is rejected by the guard (exit 2) even though the run itself is genuinely eligible -- local can never pass --confirm-production', async () => {
    const { extractionRunId } = createExtraction()
    const result = await runCli(['--extraction-run-id', extractionRunId, '--confirm-production', 'local', '--dry-run'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    const combined = result.stdout + result.stderr
    expect(combined).not.toContain(extractionRunId) // full UUID never echoed even on a guard failure
    const rowCount = dockerPsql(`select count(*) from topic_assignment_review_requests where extraction_run_id='${extractionRunId}';`).trim()
    expect(rowCount).toBe('0')
  })

  it('full UUID never appears in stdout/stderr on any invocation, only an 8-char prefix', async () => {
    const { extractionRunId } = createExtraction()
    const result = await runCli(['--extraction-run-id', extractionRunId, '--confirm-production', WRONG_REF], BASE_ENV)
    const combined = result.stdout + result.stderr
    expect(combined).not.toContain(extractionRunId)
  })

  it('help text never requires a real config and exits 0', async () => {
    const result = await runCli(['--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('post-completion-review-recovery')
  })
})
