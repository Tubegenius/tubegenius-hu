// PFM Collector Seed Admin v0 -- real subprocess proof for the CLI's
// dry-run/apply guards and output redaction. This suite deliberately
// CANNOT exercise a successful --apply run: resolveProjectIdentity()
// classifies 127.0.0.1/localhost as kind:'local', and projectGuardPasses()
// never accepts 'local' regardless of what string --confirm-production-
// project-ref carries (operator-cli-security.ts) -- the exact same
// documented limitation execute-approved-review-cli-subprocess-e2e.test.ts
// already lives with. A genuine --apply execution is proven at the RPC
// layer instead (tests/signal-seed-admin-rpc-db-integration.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const execFileAsync = promisify(execFile)
const REPO_ROOT = join(__dirname, '..')
const CLI_ENTRY = join(REPO_ROOT, 'scripts', 'signal-seed-admin.ts')
const MANIFEST_PATH = join(REPO_ROOT, 'config', 'signal-seed-catalog', 'phase1.v1.json')

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

describeIfLocalDb('PFM Collector Seed Admin v0 -- CLI subprocess (guards, redaction)', () => {
  beforeAll(() => {
    dockerPsql(`delete from signal_seed_queue_events where operator_reference like 'cli-subprocess-%';`)
    dockerPsql(`delete from signal_seed_queue where seed_text like 'cli-subprocess-%';`)
  })
  afterAll(() => {
    dockerPsql(`delete from signal_seed_queue_events where operator_reference like 'cli-subprocess-%';`)
    dockerPsql(`delete from signal_seed_queue where seed_text like 'cli-subprocess-%';`)
  })

  it('--help exits 0 and needs no environment', async () => {
    const result = await runCli(['--help'], {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('PFM Collector Seed Admin v0')
  })

  it('no command exits 2 with help text', async () => {
    const result = await runCli([], BASE_ENV)
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('Usage:')
  })

  it('register in default (dry-run) mode: exit 0, previews all 4 Phase 1 seeds, writes nothing to the DB', async () => {
    const before = dockerPsql(`select count(*) from signal_seed_queue;`).trim()
    const result = await runCli(['register', '--manifest', MANIFEST_PATH, '--operator-reference', 'cli-subprocess-op'], BASE_ENV)
    expect(result.exitCode).toBe(0)
    const lines = result.stdout.trim().split('\n').filter((l) => l.includes('dry-run preview'))
    expect(lines).toHaveLength(4)
    const after = dockerPsql(`select count(*) from signal_seed_queue;`).trim()
    expect(after).toBe(before)
  })

  it('register without --operator-reference: exit 2, no DB touched', async () => {
    const before = dockerPsql(`select count(*) from signal_seed_queue;`).trim()
    const result = await runCli(['register', '--manifest', MANIFEST_PATH], BASE_ENV)
    expect(result.exitCode).toBe(2)
    expect(dockerPsql(`select count(*) from signal_seed_queue;`).trim()).toBe(before)
  })

  it('register with a missing manifest path: exit 2, message never leaks the raw filesystem error object', async () => {
    const result = await runCli(['register', '--manifest', '/no/such/file.json', '--operator-reference', 'cli-subprocess-op'], BASE_ENV)
    expect(result.exitCode).toBe(2)
  })

  it('register --apply without --confirm-production-project-ref: exit 2, RPC never reached', async () => {
    const before = dockerPsql(`select count(*) from signal_seed_queue;`).trim()
    const result = await runCli(['register', '--manifest', MANIFEST_PATH, '--operator-reference', 'cli-subprocess-op', '--apply'], BASE_ENV)
    expect(result.exitCode).toBe(2)
    expect(dockerPsql(`select count(*) from signal_seed_queue;`).trim()).toBe(before)
  })

  it('register --apply against the real local target can never pass the production guard, even with a project-ref-shaped value', async () => {
    const before = dockerPsql(`select count(*) from signal_seed_queue;`).trim()
    const result = await runCli(
      ['register', '--manifest', MANIFEST_PATH, '--operator-reference', 'cli-subprocess-op', '--apply', '--confirm-production-project-ref', 'abcdefghijklmnop'],
      BASE_ENV,
    )
    expect(result.exitCode).toBe(2)
    expect(dockerPsql(`select count(*) from signal_seed_queue;`).trim()).toBe(before)
  })

  it('dry-run output never contains a full 64-hex fingerprint or a full UUID -- only 8-char prefixes', async () => {
    const result = await runCli(['register', '--manifest', MANIFEST_PATH, '--operator-reference', 'cli-subprocess-op'], BASE_ENV)
    const combined = result.stdout + result.stderr
    expect(combined).not.toMatch(/\b[0-9a-f]{64}\b/i)
    expect(combined).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(combined).toMatch(/fingerprintPrefix/)
  })

  it('deactivate without --target-fingerprint/--reason-code: exit 2', async () => {
    const result = await runCli(['deactivate', '--operator-reference', 'cli-subprocess-op'], BASE_ENV)
    expect(result.exitCode).toBe(2)
  })

  it('deactivate with an invalid --reason-code: exit 2, allowed list shown, never a raw DB error', async () => {
    const result = await runCli(
      ['deactivate', '--target-fingerprint', 'f'.repeat(64), '--reason-code', 'NOT_A_REAL_REASON', '--operator-reference', 'cli-subprocess-op'],
      BASE_ENV,
    )
    expect(result.exitCode).toBe(2)
    expect(result.stdout + result.stderr).toContain('OPERATOR_REQUESTED')
  })

  it('deactivate in dry-run mode never calls the RPC (no error even for a fingerprint that does not exist)', async () => {
    const result = await runCli(
      ['deactivate', '--target-fingerprint', 'e'.repeat(64), '--reason-code', 'OPERATOR_REQUESTED', '--operator-reference', 'cli-subprocess-op'],
      BASE_ENV,
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('dry-run preview -- deactivate')
  })

  it('missing environment variables: exit 2 before any import of createAdminClient', async () => {
    const result = await runCli(['register', '--manifest', MANIFEST_PATH, '--operator-reference', 'cli-subprocess-op'], { NEXT_PUBLIC_SUPABASE_URL: undefined })
    expect(result.exitCode).toBe(2)
    expect(result.stdout + result.stderr).toContain('required environment variable')
  })
})
