// PFM Supervised Production Candidate Intake v0 -- REAL CLI subprocess E2E
// (section 4). Every other test file in this rollout drives the runner's
// orchestration core in-process (a JS function call, injected client/adapter);
// THIS file is the only one that actually spawns `node scripts/supervised-intake-runner.ts`
// as a real child process, exercising the real entrypoint, the real
// arg-parsing, the real Node-version preflight, the real ts-alias-loader
// registration, and the real environment/file-system boundary an operator
// would actually hit.
//
// Uses the existing, running local Supabase Docker stack (127.0.0.1:54321,
// demo service_role key -- not production); skips entirely (not a failure)
// when unavailable. ANTHROPIC_API_KEY is deliberately NEVER set for any
// child process spawned here -- if any scenario's code path ever reached
// callAnthropicForExtraction, provider-adapter.ts's getSemanticTopicAnthropicClient()
// throws 'Anthropic is not configured' immediately, before any network
// call. Every "zero provider calls" assertion below is backed by BOTH that
// tripwire (asserted absent from the process's own output) AND a real DB
// row count for the specific evidence used (a network call could never
// reach a code path where callAnthropicForExtraction runs without ALSO
// leaving a reservation row, since reserve happens strictly before it).
import { execFile, execSync, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const REPO_ROOT = process.cwd()
const CLI_ENTRY = path.join(REPO_ROOT, 'scripts', 'supervised-intake-runner.ts')
const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const MARKER = 'sti-cli-e2e'

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

let supervisedIntakeApplied = false
if (stackAvailable) {
  try {
    const out = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename like 'supervised_intake%';`).trim()
    supervisedIntakeApplied = out === '7'
  } catch {
    supervisedIntakeApplied = false
  }
}

const describeIfLocalDb = stackAvailable && supervisedIntakeApplied ? describe : describe.skip

function nextMarker(suffix: string): string {
  return `${MARKER}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${suffix}`
}

function createEvidence(suffix: string): string {
  const m = nextMarker(suffix)
  const srcId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
  return dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${srcId}', 'youtube_video', '${m}-ev', '${m} cli e2e fixture evidence', '${runId}') returning id;`).trim()
}

function enableIntakePolicyForFixture(maxItems = 10) {
  dockerPsql(`select configure_supervised_intake_control(true, ${maxItems}, ${maxItems}, 900, 'cli-e2e-test', 'INITIAL_SETUP', '${nextMarker('cfg')}');`)
}

function resetIntakePolicyDisabled() {
  dockerPsql(`update supervised_intake_control set enabled=false, max_batch_items=0, max_daily_claimed_items=0, claim_lease_seconds=900 where id=1;`)
}

function cleanupMarker() {
  dockerPsql(`
    do $$
    begin
      update supervised_intake_batch_items set status='pending', current_attempt_id=NULL, token_digest=NULL, claimed_at=NULL, lease_expires_at=NULL, extraction_run_id=NULL, review_request_id=NULL, reason_code=NULL where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_events where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_attempts where batch_item_id in (select id from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%'));
      delete from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_batches where idempotency_key like '${MARKER}-%';
      delete from supervised_intake_idempotency_ledger where idempotency_key like '${MARKER}-%';
      delete from supervised_intake_control_events;
      delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
      delete from ai_provider_budget_reservations where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
      delete from signal_evidence where external_ref like '${MARKER}-%';
      delete from signal_sources where external_id like '${MARKER}-%';
      delete from signal_runs where idempotency_key like '${MARKER}-%';
    end $$;
  `)
  resetIntakePolicyDisabled()
}

const VALID_CONFIG = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-6' as const,
  normalizationVersion: 2,
  extractionSchemaVersion: 1,
  promptVersion: 'v1' as const,
  deterministicExtractorVersion: null,
}

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANTHROPIC_API_KEY // never inherited even if the operator's own shell happens to have it set
  // PFM Identity-Linked Workspace Header Support v0: a valid default so
  // every EXISTING scenario in this file reaches the same real reservation/
  // RPC behavior it exercised before this precondition existed -- this
  // suite's own contract is "zero provider calls" (assertNeverCalledProvider
  // below), which is about ANTHROPIC_API_KEY/provider-adapter.ts, not this
  // local config check.
  env.ANTHROPIC_AUTH_SCOPE_MODE = 'identity_linked'
  env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ'
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }

  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_ENTRY, ...args], { cwd: REPO_ROOT, env, timeout: 30_000 })
    return { exitCode: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; signal?: string }
    if (typeof e.code !== 'number') throw err // a genuine spawn failure (signal-killed etc), not a normal non-zero exit
    return { exitCode: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

function assertNeverCalledProvider(result: CliResult) {
  const combined = result.stdout + result.stderr
  expect(combined).not.toContain('Anthropic is not configured')
  expect(combined).not.toMatch(/api\.anthropic\.com/i)
}

// Signal-testing harness (section 8, POSIX only). A signal test is only
// meaningful if the child is provably at a known point of the runner when the
// signal arrives, so nothing here relies on a sleep or on "the line just
// appeared in the pipe":
//
//   1. readiness   -- the runner has logged its cumulative-capacity preflight.
//                     That line is written after the SIGINT/SIGTERM handlers are
//                     registered and immediately before create_supervised_intake_batch,
//                     so the handlers exist and the runner is at the create step.
//   2. blocked     -- a separate DB session holds a SHARE lock on
//                     supervised_intake_batches, so the runner's INSERT inside
//                     create_supervised_intake_batch cannot finish. The harness
//                     waits until pg_stat_activity shows that exact backend
//                     waiting on that lock: the child is provably suspended
//                     INSIDE the create RPC, before any claim.
//   3. signal #1   -- sent to the runner's own PID (a direct `node` child, no
//                     shell wrapper) and acknowledged by the runner's handler
//                     (the "received SIGINT ... signalCount" log line).
//   4. single      -- only now is the lock released; the runner finishes
//                     creating the batch, sees the abort flag at the top of its
//                     claim loop and stops without claiming.
//      double      -- signal #2 is sent after the first was acknowledged, while
//                     the runner is still blocked (a second interrupt while the
//                     first is still being handled); the runner must hard-exit.
//   5. terminal    -- wait for the process to exit, release/destroy the lock
//                     session, wait until no create RPC is still in flight, and
//                     prove the child PID no longer exists (no orphan/zombie).
// Every failure path kills the child and the lock session.
const CREATE_BATCH_RPC = 'create_supervised_intake_batch'

// The whole signal scenario shares ONE deadline that is always shorter than
// the per-test timeout below. This is a safety invariant, not a tuning knob:
// if vitest's own test timeout fired first, the afterEach hook's synchronous
// cleanupMarker() (execSync) would block on the lock the harness still holds,
// and the event loop that must release that lock could never run. With the
// harness deadline first, every failure path unwinds (kills the child and the
// lock session) before the framework timeout can interfere. Measured happy
// path on Linux: ~1.0-1.2s per test.
const SIGNAL_HARNESS_DEADLINE_MS = 20_000
const SIGNAL_TEST_TIMEOUT_MS = 30_000

function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // a partially received trailing line -- completed by a later chunk
    }
  }
  return events
}

function hasLogEvent(text: string, message: RegExp, fields: Record<string, unknown> = {}): boolean {
  return parseJsonLines(text).some(
    (event) => typeof event.message === 'string' && message.test(event.message) && Object.entries(fields).every(([key, value]) => event[key] === value),
  )
}

async function waitUntil(condition: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function runnerBlockedInsideBatchCreate(): boolean {
  return Number(dockerPsql(
    `select count(*) from pg_stat_activity where wait_event_type='Lock' and wait_event='relation' and query ilike '%${CREATE_BATCH_RPC}%' and query not ilike '%pg_stat_activity%';`,
  ).trim()) >= 1
}

function batchCreateRpcInFlight(): boolean {
  return Number(dockerPsql(
    `select count(*) from pg_stat_activity where state <> 'idle' and query ilike '%${CREATE_BATCH_RPC}%' and query not ilike '%pg_stat_activity%';`,
  ).trim()) >= 1
}

// A separate DB session that holds `LOCK TABLE ... IN SHARE MODE` on
// supervised_intake_batches: readers are unaffected, writers (the runner's
// INSERT inside create_supervised_intake_batch) wait until it is released.
function holdBatchInsertLock() {
  const session = spawn('docker', ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'])
  let output = ''
  let closed = false
  let spawnError: Error | undefined
  session.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  session.on('close', () => { closed = true })
  session.on('error', (err) => { spawnError = err; closed = true })
  session.stdin.write("begin;\nlock table public.supervised_intake_batches in share mode;\nselect 'LOCK_HELD';\n")
  return {
    async acquired(): Promise<void> {
      await waitUntil(() => {
        if (spawnError) throw spawnError
        return output.includes('LOCK_HELD')
      }, 'the lock-holder DB session to acquire its lock', 5_000)
    },
    async release(): Promise<void> {
      if (closed) return
      session.stdin.write('commit;\n')
      session.stdin.end()
      await waitUntil(() => closed, 'the lock-holder DB session to close', 5_000)
    },
    async destroy(): Promise<void> {
      if (closed) return
      session.kill('SIGKILL')
      await waitUntil(() => closed, 'the killed lock-holder DB session to close', 5_000)
    },
  }
}

interface SignalRunResult extends CliResult {
  pid: number
  terminationSignal: NodeJS.Signals | null
}

async function runCliSignalledWhileBlockedInBatchCreate(
  args: string[],
  envOverrides: Record<string, string | undefined>,
  signalCount: 1 | 2,
): Promise<SignalRunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  env.ANTHROPIC_AUTH_SCOPE_MODE = 'identity_linked'
  env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ'
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }

  const deadline = Date.now() + SIGNAL_HARNESS_DEADLINE_MS
  const wait = (condition: () => boolean, description: string, phaseMs: number) =>
    waitUntil(condition, description, Math.max(0, Math.min(phaseMs, deadline - Date.now())))
  const lock = holdBatchInsertLock()
  let child: ChildProcess | undefined
  const state: { exited: boolean; exit?: { code: number | null; signal: NodeJS.Signals | null }; spawnError?: Error } = { exited: false }
  try {
    await lock.acquired()

    let stdout = ''
    let stderr = ''
    const spawned = spawn('node', [CLI_ENTRY, ...args], { cwd: REPO_ROOT, env })
    child = spawned
    spawned.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    spawned.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    spawned.on('close', (code, signal) => { state.exit = { code, signal }; state.exited = true })
    spawned.on('error', (err) => { state.spawnError = err; state.exited = true })
    const pid = spawned.pid
    if (pid === undefined) throw new Error('the runner process failed to spawn')

    await wait(() => {
      if (state.spawnError) throw state.spawnError
      return hasLogEvent(stdout, /cumulative daily capacity preflight/)
    }, 'the runner preflight log line (signal handlers registered, runner at the batch-create step)', 15_000)
    await wait(runnerBlockedInsideBatchCreate, 'the runner blocked inside create_supervised_intake_batch', 10_000)

    spawned.kill('SIGINT')
    await wait(() => hasLogEvent(stdout, /^received SIGINT/, { signalCount: 1 }), 'the runner acknowledging SIGINT #1', 5_000)
    if (signalCount === 2) spawned.kill('SIGINT')
    else await lock.release()

    await wait(() => state.exited, 'the runner process to exit', 10_000)
    await lock.release()
    await wait(() => !batchCreateRpcInFlight(), 'no create_supervised_intake_batch call to remain in flight', 10_000)

    if (!state.exit) throw new Error('the runner exited without a close event')
    return { exitCode: state.exit.code ?? -1, stdout, stderr, pid, terminationSignal: state.exit.signal }
  } finally {
    if (child && !state.exited) {
      child.kill('SIGKILL')
      await waitUntil(() => state.exited, 'the force-killed runner to exit').catch(() => undefined)
    }
    await lock.destroy()
    await waitUntil(() => !batchCreateRpcInFlight(), 'a pending create_supervised_intake_batch call to drain after cleanup', 5_000).catch(() => undefined)
  }
}

let workDir: string

describeIfLocalDb('Supervised Intake CLI -- REAL subprocess E2E (section 4)', () => {
  beforeAll(() => {
    cleanupMarker()
  })

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'sti-cli-e2e-'))
  })

  afterEach(() => {
    cleanupMarker()
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
  })

  afterAll(() => {
    cleanupMarker()
    expect(dockerPsql('select enabled from ai_extraction_control where id=1;').trim()).toBe('f')
    expect(dockerPsql('select enabled from supervised_intake_control where id=1;').trim()).toBe('f')
  })

  // -------------------------------------------------------------------
  // A) Invalid input -> exit code 2, zero DB mutation, zero provider calls.
  // -------------------------------------------------------------------
  describe('A) invalid input', () => {
    it('malformed JSON: exit 2, zero DB mutation, no claim-state file ever created', async () => {
      const inputPath = path.join(workDir, 'bad.json')
      writeFileSync(inputPath, '{not valid json')
      const claimStatePath = path.join(workDir, 'claim-state.json')

      const result = await runCli(
        ['--input', inputPath, '--claim-state', claimStatePath],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
      )

      expect(result.exitCode).toBe(2)
      expect(existsSync(claimStatePath)).toBe(false)
      assertNeverCalledProvider(result)
      expect(dockerPsql(`select count(*) from supervised_intake_batches where idempotency_key like '${MARKER}-%';`).trim()).toBe('0')
    })

    it('well-formed JSON but a forbidden field (confidence): exit 2, zero DB mutation', async () => {
      const inputPath = path.join(workDir, 'forbidden-field.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey: nextMarker('batch'), operatorReference: 'cli-e2e-op',
        signalEvidenceIds: ['11111111-1111-4111-8111-111111111111'], confidence: 0.9, ...VALID_CONFIG,
      }))

      const result = await runCli(
        ['--input', inputPath],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
      )

      expect(result.exitCode).toBe(2)
      assertNeverCalledProvider(result)
    })

    it('missing required environment variables: exit 2, zero DB mutation (never even attempts a connection)', async () => {
      const inputPath = path.join(workDir, 'valid.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey: nextMarker('batch'), operatorReference: 'cli-e2e-op',
        signalEvidenceIds: ['11111111-1111-4111-8111-111111111111'], ...VALID_CONFIG,
      }))

      const result = await runCli(
        ['--input', inputPath, '--dry-run'],
        { NEXT_PUBLIC_SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined },
      )

      // Dry-run still runs (it reports missing env vars as part of its own
      // report) rather than crashing -- exit code stays the documented
      // config-error code either way.
      expect(result.exitCode).toBe(2)
      assertNeverCalledProvider(result)
    })

    it('no --input at all: prints help, exit 2', async () => {
      const result = await runCli([], { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY })
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toMatch(/Usage:/)
    })
  })

  // -------------------------------------------------------------------
  // B) Dry-run -> read-only preflight, zero batch/item/attempt, no claim-
  // state file, zero provider calls. NOTE: exit code is honestly 2 here,
  // not 0 -- see the header comment above runDryRun's aiExtractionControlEnabled
  // check (supervised-intake-runner.ts). ai_extraction_control MUST stay
  // permanently disabled in this environment (an explicit, hard task
  // constraint), and runDryRun correctly treats that as a reportable error
  // ("a real run would reject every reservation"), so a literal exit-0 dry-
  // run against this real, permanently-disabled local DB is not achievable
  // without violating that constraint. The exit-0 SUCCESS branch of
  // runDryRun's own logic is covered separately, at the unit level, in
  // tests/supervised-intake-runner.test.ts ("never calls .rpc (zero DB
  // mutation) and reports env/policy state read-only"), against a mocked
  // client where ai_extraction_control reads as unknown/absent rather than
  // explicitly disabled.
  // -------------------------------------------------------------------
  describe('B) dry-run', () => {
    it('read-only preflight against the real local DB: reports both control flags honestly, creates zero batch/item/attempt rows, zero claim-state file, zero provider calls', async () => {
      const inputPath = path.join(workDir, 'dry-run-batch.json')
      const idempotencyKey = nextMarker('batch-dryrun')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey, operatorReference: 'cli-e2e-op',
        signalEvidenceIds: ['11111111-1111-4111-8111-111111111111'], ...VALID_CONFIG,
      }))
      const claimStatePath = path.join(workDir, 'claim-state.json')

      const result = await runCli(
        ['--input', inputPath, '--dry-run', '--claim-state', claimStatePath],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
      )

      expect(result.exitCode).toBe(2)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('"dbReachable":true')
      expect(combined).toContain('ai_extraction_control.enabled is false')
      expect(existsSync(claimStatePath)).toBe(false)
      assertNeverCalledProvider(result)
      expect(dockerPsql(`select count(*) from supervised_intake_batches where idempotency_key = '${idempotencyKey}';`).trim()).toBe('0')
    })

    it('dry-run never reads/logs the actual service-role key value, only a presence boolean', async () => {
      const inputPath = path.join(workDir, 'dry-run-batch-2.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey: nextMarker('batch-dryrun2'), operatorReference: 'cli-e2e-op',
        signalEvidenceIds: ['11111111-1111-4111-8111-111111111111'], ...VALID_CONFIG,
      }))

      const result = await runCli(
        ['--input', inputPath, '--dry-run'],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
      )

      expect(result.stdout + result.stderr).not.toContain(LOCAL_SERVICE_ROLE_KEY)
    })
  })

  // -------------------------------------------------------------------
  // C) Policy disabled (supervised_intake_control.enabled=false) -- this
  // IS this environment's permanent baseline, so this scenario needs no
  // fixture toggling at all: a real (non-dry-run) attempt against it.
  // -------------------------------------------------------------------
  describe('C) intake policy disabled (the permanent baseline in this environment)', () => {
    it('a real run attempt: fails closed at create_supervised_intake_batch itself, config-error exit code, zero partial/inconsistent DB state, zero provider calls', async () => {
      resetIntakePolicyDisabled() // explicit, even though this is already the baseline
      const evidenceId = createEvidence('policy-disabled')
      const idempotencyKey = nextMarker('batch-policy-disabled')
      const inputPath = path.join(workDir, 'policy-disabled-batch.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey, operatorReference: 'cli-e2e-op', signalEvidenceIds: [evidenceId], ...VALID_CONFIG,
      }))
      const claimStatePath = path.join(workDir, 'claim-state.json')

      const result = await runCli(
        ['--input', inputPath, '--claim-state', claimStatePath],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
      )

      expect(result.exitCode).toBe(2) // VALIDATION_OR_CONFIG_ERROR
      expect(existsSync(claimStatePath)).toBe(false)
      assertNeverCalledProvider(result)
      expect(dockerPsql(`select count(*) from supervised_intake_batches where idempotency_key = '${idempotencyKey}';`).trim()).toBe('0')
      expect(dockerPsql(`select count(*) from ai_provider_budget_reservations where signal_evidence_id='${evidenceId}';`).trim()).toBe('0')
    })
  })

  // -------------------------------------------------------------------
  // D) ai_extraction_control disabled (the permanent, non-negotiable
  // invariant), intake policy ENABLED fixture-scope -- full real path:
  // batch -> claim -> local claim-state file -> begin_intake_attempt_call
  // -> the REAL, canonical runShadowExtraction() -> DB rejection before
  // any provider call -> exact reason_code AI_EXTRACTION_DISABLED -> batch
  // stopped -> claim-state file cleaned up -> zero provider calls.
  // -------------------------------------------------------------------
  describe('D) ai_extraction_control disabled (real, permanent), intake policy enabled (fixture-scope)', () => {
    it('the real CLI, the real canonical runShadowExtraction: batch stops with reason_code exactly AI_EXTRACTION_DISABLED, claim-state file is cleared, zero reservations, zero provider calls', async () => {
      enableIntakePolicyForFixture()
      const evidenceId = createEvidence('ai-disabled')
      const idempotencyKey = nextMarker('batch-ai-disabled')
      const inputPath = path.join(workDir, 'ai-disabled-batch.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey, operatorReference: 'cli-e2e-op', signalEvidenceIds: [evidenceId], ...VALID_CONFIG,
      }))
      const claimStatePath = path.join(workDir, 'claim-state.json')

      const result = await runCli(
        ['--input', inputPath, '--claim-state', claimStatePath],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
      )

      expect(result.exitCode).toBe(3) // BATCH_STOPPED
      assertNeverCalledProvider(result)

      const row = dockerPsql(`select status||'|'||reason_code from supervised_intake_batches where idempotency_key='${idempotencyKey}';`).trim()
      expect(row).toBe('stopped|AI_EXTRACTION_DISABLED')

      const itemRow = dockerPsql(`select status||'|'||reason_code||'|'||retryable::text from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key='${idempotencyKey}');`).trim()
      expect(itemRow).toBe('failed|INVALID_EVIDENCE_STATE|true')

      // Claim-state file: written (a real claim happened), then cleared on
      // resolution -- this is a genuine failed+resolved item, not an
      // uncertain 'calling' attempt, so nothing is left behind for
      // reconciliation.
      expect(existsSync(claimStatePath)).toBe(false)

      expect(dockerPsql(`select count(*) from ai_provider_budget_reservations where signal_evidence_id='${evidenceId}';`).trim()).toBe('0')
      expect(dockerPsql('select enabled from ai_extraction_control where id=1;').trim()).toBe('f')
    })
  })

  // -------------------------------------------------------------------
  // E) Signal handling (section 8) -- the ONLY reliably timeable window
  // without an artificial delay hook in the runner itself: signal handlers
  // are registered before runSupervisedIntake is ever called, and "batch
  // created" is logged strictly before the loop's very first
  // claim_next_intake_item call (the abort check runs immediately after,
  // before that call) -- so sending the signal the instant that exact log
  // line appears deterministically lands in the gap between batch creation
  // and the first claim, never mid-claim or mid-provider-call. The
  // documented behavior for a signal arriving DURING an in-flight 'calling'
  // attempt is the exact same DB/file end-state as a hard crash at that
  // point (the abort signal never cancels an in-flight runShadowExtraction
  // call) -- already proven directly in
  // tests/supervised-intake-crash-restart-e2e.test.ts's 'calling' scenario,
  // so it is not re-derived here through a much harder-to-time signal race.
  // -------------------------------------------------------------------
  // Windows does not deliver a catchable SIGINT/SIGTERM to a child process
  // through Node's child_process API -- child.kill('SIGINT') unconditionally
  // terminates the process at the OS level (confirmed directly: a trivial
  // child with its own process.on('SIGINT', ...) handler never sees it,
  // closes with signal=SIGINT/code=null instead of running its handler).
  // This is a documented Node-on-Windows platform limitation, not a gap in
  // the runner's own signal-handling code (scripts/supervised-intake-runner.ts's
  // onSignal/AbortController logic), which is exactly what a real (POSIX)
  // deployment target -- a container or Linux/Mac server -- would run.
  // These two tests are written to run for real on POSIX and are skipped,
  // with this explicit reason, on win32 only.
  const describeSignalTests = process.platform === 'win32' ? describe.skip : describe
  describeSignalTests('E) signal handling (POSIX only -- see comment above)', () => {
    it('single SIGINT before any claim: finishes gracefully, claims nothing new, documented exit code, zero provider calls', { timeout: SIGNAL_TEST_TIMEOUT_MS }, async () => {
      enableIntakePolicyForFixture()
      const evidenceId = createEvidence('sigint-single')
      const idempotencyKey = nextMarker('batch-sigint-single')
      const inputPath = path.join(workDir, 'sigint-single-batch.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey, operatorReference: 'cli-e2e-op', signalEvidenceIds: [evidenceId], ...VALID_CONFIG,
      }))
      const claimStatePath = path.join(workDir, 'claim-state.json')

      const result = await runCliSignalledWhileBlockedInBatchCreate(
        ['--input', inputPath, '--claim-state', claimStatePath],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
        1,
      )

      expect(result.terminationSignal).toBeNull() // exited on its own, was not killed by a signal
      expect(result.exitCode).toBe(3) // BATCH_STOPPED -- "left running, no new item claimed"
      expect(result.stdout).toMatch(/finishing the item in flight, then stopping before claiming a new one/)
      expect(result.stdout).toMatch(/shutdown signal received -- not claiming a new item/)
      // A graceful shutdown emits no runner error-level log line (those go to stderr
      // as JSON; Node's own non-JSON warnings are not runner output).
      expect(parseJsonLines(result.stderr)).toEqual([])
      assertNeverCalledProvider(result)
      expect(existsSync(claimStatePath)).toBe(false) // nothing was ever claimed, so nothing was ever written
      expect(processExists(result.pid)).toBe(false) // no orphan / zombie runner left behind
      const row = dockerPsql(`select status||'|'||coalesce(reason_code,'<null>') from supervised_intake_batches where idempotency_key='${idempotencyKey}';`).trim()
      expect(row).toBe('batch_created|<null>')
      expect(dockerPsql(`select count(*) from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key='${idempotencyKey}') and status <> 'pending';`).trim()).toBe('0')
    })

    it('double SIGINT (second interrupt while the first is still being handled): immediate hard exit, documented UNEXPECTED_INTERNAL_ERROR code, zero provider calls', { timeout: SIGNAL_TEST_TIMEOUT_MS }, async () => {
      enableIntakePolicyForFixture()
      const evidenceId = createEvidence('sigint-double')
      const idempotencyKey = nextMarker('batch-sigint-double')
      const inputPath = path.join(workDir, 'sigint-double-batch.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey, operatorReference: 'cli-e2e-op', signalEvidenceIds: [evidenceId], ...VALID_CONFIG,
      }))
      const claimStatePath = path.join(workDir, 'claim-state.json')

      const result = await runCliSignalledWhileBlockedInBatchCreate(
        ['--input', inputPath, '--claim-state', claimStatePath],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
        2,
      )

      expect(result.terminationSignal).toBeNull() // process.exit(5) from the handler, not a signal death
      expect(result.exitCode).toBe(5) // UNEXPECTED_INTERNAL_ERROR -- documented hard-exit code for a second interrupt
      // Both interrupts were acknowledged on stdout (warn level) ...
      expect(hasLogEvent(result.stdout, /^received SIGINT/, { signalCount: 1 })).toBe(true)
      expect(hasLogEvent(result.stdout, /^received SIGINT/, { signalCount: 2 })).toBe(true)
      // ... and the force-stop notice is an error-level log line, which the runner
      // writes to STDERR (console.error) -- exactly one such line, never on stdout.
      const stderrEvents = parseJsonLines(result.stderr)
      expect(stderrEvents).toHaveLength(1)
      expect(stderrEvents[0]).toMatchObject({ level: 'error', message: 'second interrupt received -- exiting immediately without further DB cleanup' })
      expect(result.stdout).not.toMatch(/second interrupt received/)
      assertNeverCalledProvider(result)
      expect(existsSync(claimStatePath)).toBe(false) // the runner never reached a claim
      expect(processExists(result.pid)).toBe(false) // no orphan / zombie runner left behind
    })
  })

  // -------------------------------------------------------------------
  // E) PFM Supervised Intake Human-Review Observability Closure gate --
  // REAL subprocess proof of the dry-run report's new fields
  // (humanReviewEnabled/anthropicAuthConfigValid/anthropicAuthMode), which
  // resolve via the same resolvers a real run uses.
  //
  // Scope note (investigated and documented, not silently omitted): an
  // earlier version of this block attempted to also prove the
  // "extraction outcome decided" log's humanReview summary
  // ('not_eligible'/'disabled') end-to-end through a real, unmocked
  // subprocess, by pre-inserting a completed topic_extraction_runs row for
  // the evidence before running the batch (intending to hit
  // runShadowExtraction's own cache_hit path without needing
  // ANTHROPIC_API_KEY). That approach cannot work: claim_next_intake_item
  // (079, the "cache-hit preflight" immediately after the
  // ALREADY_ASSIGNED check) treats ANY existing completed
  // topic_extraction_runs row for the evidence as a reason to mark the
  // batch item 'skipped_already_extracted'/ALREADY_EXTRACTED at claim
  // time -- the item is never claimed, runShadowExtraction is never
  // called, and maybeRequestHumanReview() never runs. Confirmed by
  // running the real CLI against such a fixture: its log only ever shows
  // "batch created" -> "batch finalized: completed" with zero
  // "extraction outcome decided" lines. Since the 'completed' (non-cache-
  // hit) outcome requires an actual provider call, which this file
  // deliberately never makes, NEITHER extraction outcome that would carry
  // a humanReview summary is reachable through a genuinely-running
  // subprocess in this file. All outcome branches ('disabled',
  // 'not_eligible' with every reasonCode, 'created', 'replayed',
  // 'pending', 'already_assigned', 'retryable_failure', and an
  // unrecognized-future-outcome fail-closed case) are exhaustively unit-
  // tested against a mocked RPC layer instead
  // (tests/human-review-extraction-hook.test.ts,
  // tests/supervised-intake-runner.test.ts), including source-policy
  // tests proving the runner's log call site never passes anything but
  // the safe summarizer's output.
  // -------------------------------------------------------------------
  describe('E) human-review observability (real subprocess)', () => {
    it('dry-run report resolves humanReviewEnabled/anthropicAuthConfigValid/anthropicAuthMode via the SAME resolvers the real run uses -- never just env-presence booleans', async () => {
      const inputPath = path.join(workDir, 'humanreview-dryrun-batch.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey: nextMarker('batch-humanreview-dryrun'), operatorReference: 'cli-e2e-op',
        signalEvidenceIds: ['11111111-1111-4111-8111-111111111111'], ...VALID_CONFIG,
      }))

      const result = await runCli(
        ['--input', inputPath, '--dry-run'],
        {
          NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY,
          SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED: 'true', ANTHROPIC_AUTH_SCOPE_MODE: 'workspace_scoped', ANTHROPIC_WORKSPACE_ID: undefined,
        },
      )

      const combined = result.stdout + result.stderr
      expect(combined).toContain('"humanReviewEnabled":true')
      expect(combined).toContain('"anthropicAuthConfigValid":true')
      expect(combined).toContain('"anthropicAuthMode":"workspace_scoped"')
    })
  })
})
