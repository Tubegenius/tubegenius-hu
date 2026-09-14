// PFM Lifecycle Operator CLI v1 -- real subprocess proof for the
// request-creation CLI's dry-run/apply guards and output redaction. This
// suite deliberately CANNOT exercise a successful --apply run:
// resolveProjectIdentity() classifies 127.0.0.1/localhost as kind:'local',
// and projectGuardPasses() never accepts 'local' regardless of what string
// --confirm-production-project-ref carries -- the exact same documented
// limitation execute-approved-review-cli-subprocess-e2e.test.ts and
// signal-seed-admin-cli-subprocess.test.ts already live with. A genuine
// --apply execution is proven at the RPC layer instead
// (tests/lifecycle-review-request-admin-db-integration.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
const REPO_ROOT = join(__dirname, '..')
const CLI_ENTRY = join(REPO_ROOT, 'scripts', 'lifecycle-review-request-admin.ts')

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

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

const MARKER = 'lrca-subprocess'
function randomHexDigest(): string {
  let s = ''
  while (s.length < 64) s += Math.floor(Math.random() * 16).toString(16)
  return s
}
function insertTopic(lifecycleStatus: string): string {
  return dockerPsql(
    `insert into semantic_topics (canonical_label, label_language, creation_request_digest, lifecycle_status) values ('${MARKER} topic ${Math.random().toString(36).slice(2)}', 'en', '${randomHexDigest()}', '${lifecycleStatus}') returning id;`,
  ).trim()
}
function cleanup() {
  dockerPsql(`
    delete from semantic_topic_lifecycle_review_requests where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER}%');
    delete from semantic_topics where canonical_label like '${MARKER}%';
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

describeIfLocalDb('PFM Lifecycle Operator CLI v1 -- request-creation CLI subprocess (guards, redaction)', () => {
  let topicId: string

  beforeAll(() => {
    cleanup()
    topicId = insertTopic('corroborating')
  })
  afterAll(() => {
    cleanup()
  })

  it('--help exits 0 and needs no environment', async () => {
    const result = await runCli(['--help'], {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('PFM Lifecycle Operator CLI v1')
  })

  it('missing --semantic-topic-id: exit 2, no DB touched', async () => {
    const before = dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests;`).trim()
    const result = await runCli(['--target-status', 'coherent', '--operator-reference', 'op-1'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    expect(dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests;`).trim()).toBe(before)
  })

  it('invalid --target-status: exit 2, allowed values shown', async () => {
    const result = await runCli(['--semantic-topic-id', topicId, '--target-status', 'made-up', '--operator-reference', 'op-1'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    expect(result.stdout + result.stderr).toMatch(/coherent/)
  })

  it('missing --operator-reference: exit 2', async () => {
    const result = await runCli(['--semantic-topic-id', topicId, '--target-status', 'coherent'], BASE_ENV)
    expect(result.exitCode).toBe(2)
  })

  it('default (dry-run) mode: exit 0, previews without writing to the DB', async () => {
    const before = dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests;`).trim()
    const result = await runCli(['--semantic-topic-id', topicId, '--target-status', 'coherent', '--operator-reference', 'op-cli-subprocess'], BASE_ENV)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/dry_run/)
    expect(dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests;`).trim()).toBe(before)
  })

  it('--apply without --confirm-production-project-ref: exit 2, RPC never reached', async () => {
    const before = dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests;`).trim()
    const result = await runCli(['--semantic-topic-id', topicId, '--target-status', 'coherent', '--operator-reference', 'op-cli-subprocess', '--apply'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    expect(dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests;`).trim()).toBe(before)
  })

  it('--apply against the real local target can never pass the production guard, even with a project-ref-shaped value', async () => {
    const before = dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests;`).trim()
    const result = await runCli(
      ['--semantic-topic-id', topicId, '--target-status', 'coherent', '--operator-reference', 'op-cli-subprocess', '--apply', '--confirm-production-project-ref', 'abcdefghijklmnop'],
      BASE_ENV,
    )
    expect(result.exitCode).toBe(2)
    expect(dockerPsql(`select count(*) from semantic_topic_lifecycle_review_requests;`).trim()).toBe(before)
  })

  it('the full --confirm-production-project-ref value never appears in stdout/stderr in the rejected apply-guard path or in dry-run', async () => {
    const distinctiveRef = 'zzzdistinctivetestprojectref999'
    const rejected = await runCli(
      ['--semantic-topic-id', topicId, '--target-status', 'coherent', '--operator-reference', 'op-cli-subprocess', '--apply', '--confirm-production-project-ref', distinctiveRef],
      BASE_ENV,
    )
    expect(rejected.stdout + rejected.stderr).not.toContain(distinctiveRef)

    const dryRun = await runCli(['--semantic-topic-id', topicId, '--target-status', 'coherent', '--operator-reference', 'op-cli-subprocess'], BASE_ENV)
    expect(dryRun.stdout + dryRun.stderr).not.toContain(distinctiveRef)
  })

  it('dry-run output never contains a full UUID -- only 8-char prefixes', async () => {
    const result = await runCli(['--semantic-topic-id', topicId, '--target-status', 'coherent', '--operator-reference', 'op-cli-subprocess'], BASE_ENV)
    const combined = result.stdout + result.stderr
    expect(combined).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(combined).toMatch(/semanticTopicIdPrefix/)
  })

  it('missing environment variables: exit 2 before any import of createAdminClient', async () => {
    const result = await runCli(['--semantic-topic-id', topicId, '--target-status', 'coherent', '--operator-reference', 'op-cli-subprocess'], { NEXT_PUBLIC_SUPABASE_URL: undefined })
    expect(result.exitCode).toBe(2)
    expect(result.stdout + result.stderr).toContain('required environment variable')
  })
})
