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
import { execFile, execSync, spawn } from 'node:child_process'
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

// Signal-testing helper (section 8): spawns the CLI, waits for a specific
// line to appear in its stdout (proving the process has reached exactly
// that point -- e.g. signal handlers are already registered and a batch
// already exists, but no claim has happened yet), sends the requested
// signal(s) at that moment, then waits for the process to exit. Waiting
// for a concrete log line rather than a fixed delay is what makes this
// reliable rather than a timing guess.
function runCliUntilLineThenSignal(
  args: string[],
  envOverrides: Record<string, string | undefined>,
  waitForLineMatching: RegExp,
  signals: NodeJS.Signals[],
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }

  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn('node', [CLI_ENTRY, ...args], { cwd: REPO_ROOT, env })
    let stdout = ''
    let stderr = ''
    let signaled = false
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`runCliUntilLineThenSignal: timed out waiting for ${waitForLineMatching} -- stdout so far: ${stdout}`))
    }, 30_000)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (!signaled && waitForLineMatching.test(stdout)) {
        signaled = true
        for (const sig of signals) child.kill(sig)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ exitCode: code ?? (signal ? -1 : 0), stdout, stderr })
    })
    child.on('error', (err) => { clearTimeout(timeout); reject(err) })
  })
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
    it('single SIGINT before any claim: finishes gracefully, claims nothing new, documented exit code, zero provider calls', async () => {
      enableIntakePolicyForFixture()
      const evidenceId = createEvidence('sigint-single')
      const idempotencyKey = nextMarker('batch-sigint-single')
      const inputPath = path.join(workDir, 'sigint-single-batch.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey, operatorReference: 'cli-e2e-op', signalEvidenceIds: [evidenceId], ...VALID_CONFIG,
      }))
      const claimStatePath = path.join(workDir, 'claim-state.json')

      const result = await runCliUntilLineThenSignal(
        ['--input', inputPath, '--claim-state', claimStatePath],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
        /"batch created"/,
        ['SIGINT'],
      )

      expect(result.exitCode).toBe(3) // BATCH_STOPPED -- "left running, no new item claimed"
      expect(result.stdout).toMatch(/finishing the item in flight, then stopping before claiming a new one/)
      assertNeverCalledProvider(result)
      expect(existsSync(claimStatePath)).toBe(false) // nothing was ever claimed, so nothing was ever written
      const row = dockerPsql(`select status||'|'||coalesce(reason_code,'<null>') from supervised_intake_batches where idempotency_key='${idempotencyKey}';`).trim()
      expect(['batch_created|<null>', 'running|<null>']).toContain(row)
      expect(dockerPsql(`select count(*) from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key='${idempotencyKey}') and status <> 'pending';`).trim()).toBe('0')
    })

    it('double SIGINT (second interrupt while the first is still being handled): immediate hard exit, documented UNEXPECTED_INTERNAL_ERROR code, zero provider calls', async () => {
      enableIntakePolicyForFixture()
      const evidenceId = createEvidence('sigint-double')
      const idempotencyKey = nextMarker('batch-sigint-double')
      const inputPath = path.join(workDir, 'sigint-double-batch.json')
      writeFileSync(inputPath, JSON.stringify({
        idempotencyKey, operatorReference: 'cli-e2e-op', signalEvidenceIds: [evidenceId], ...VALID_CONFIG,
      }))
      const claimStatePath = path.join(workDir, 'claim-state.json')

      const result = await runCliUntilLineThenSignal(
        ['--input', inputPath, '--claim-state', claimStatePath],
        { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY },
        /"batch created"/,
        ['SIGINT', 'SIGINT'],
      )

      expect(result.exitCode).toBe(5) // UNEXPECTED_INTERNAL_ERROR -- documented hard-exit code for a second interrupt
      expect(result.stdout).toMatch(/second interrupt received -- exiting immediately without further DB cleanup/)
      assertNeverCalledProvider(result)
    })
  })
})
