// Migration 093 (Video Package atomic charge+save) -- REAL local DB
// integration tests. Same safety gate and helper shape as the existing
// 072-076/s2a DB-integration suites (see tests/lib/db-integration-guard.ts)
// -- zero Docker/DB calls unless PFM_STATEFUL_DB_TARGET +
// PFM_STATEFUL_DB_CONFIRM are both explicitly set to a non-denylisted
// (i.e. renamed, genuinely disposable) container.
//
// This file owns TWO real, non-rolled-back-by-design surfaces, which is
// exactly why it needs this stricter gate rather than the older, simpler
// `stackAvailable` check some pre-076 DB-integration files still use:
//   1. Runs supabase/tests/093_spend_credits_and_save_paid_result.test.sql
//      (written, never-yet-executed SQL assertions) as one psql script.
//   2. A REAL, deterministic two-OS-process concurrency race against the
//      UNMODIFIED, actual public.spend_credits_and_save_paid_result RPC --
//      not a replica of its internal steps. This requires a genuinely new,
//      TEST-ONLY trigger on public.paid_results (created here, dropped in
//      afterAll) -- a real schema object that must never exist outside this
//      one disposable run, which is exactly the kind of mutation
//      db-integration-guard.ts's stricter gate exists to contain.
import { afterAll, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 20000 })
import { execSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isStatefulDbRequired, resolveStatefulDbTarget } from './lib/db-integration-guard'

const STATEFUL_TARGET = resolveStatefulDbTarget()
const DB_CONTAINER = STATEFUL_TARGET.allowed ? STATEFUL_TARGET.container! : null
const STATEFUL_REQUIRED = isStatefulDbRequired()
if (STATEFUL_REQUIRED && !STATEFUL_TARGET.allowed) {
  throw new Error(`PFM_STATEFUL_DB_REQUIRED=1 but the stateful DB target is not authorized: ${STATEFUL_TARGET.reason}`)
}

function requireContainer(): string {
  if (!DB_CONTAINER) throw new Error(`stateful DB-integration call attempted without authorization: ${STATEFUL_TARGET.reason}`)
  return DB_CONTAINER
}

function dockerPsql(sql: string): string {
  return execSync(`docker exec -i ${requireContainer()} psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -`, {
    input: sql,
    encoding: 'utf-8',
  })
}

// Async spawn (not execSync) -- required for two genuinely concurrent OS
// processes, same primitive the existing "separate-OS-process
// representation concurrency" scenario in
// tests/semantic-topic-canonical-input-timestamp-v2-db-integration.test.ts
// already proves out in this repo.
function dockerPsqlAsync(sql: string): Promise<{ ok: boolean; out: string; stderr: string }> {
  const container = requireContainer()
  return new Promise(resolve => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => {
      resolve({ ok: code === 0, out: code === 0 ? stdout.trim() : (stderr || stdout).trim(), stderr })
    })
    child.stdin.write(sql)
    child.stdin.end()
  })
}

function runFile(path: string): { out: string; threw: boolean } {
  const sql = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  try {
    const out = execSync(`docker exec -i ${requireContainer()} psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1`, {
      input: sql,
      encoding: 'utf8',
    })
    return { out, threw: false }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { out: String(err.stdout || err.stderr || err.message || ''), threw: true }
  }
}

const REQUIRED_TABLES = ['paid_results', 'paid_operations', 'user_credits', 'credit_ledger', 'ai_usage_logs']
const REQUIRED_FUNCTIONS = ['spend_credits_and_save_paid_result', 'spend_credits']

function verifyRequiredSchema(): { ok: boolean; missing: string[] } {
  const tablesSql = REQUIRED_TABLES.map(t => `'${t}'`).join(',')
  const fnsSql = REQUIRED_FUNCTIONS.map(f => `'${f}'`).join(',')
  const out = dockerPsql(`
    SELECT 'MISSING_TABLE|' || t FROM unnest(ARRAY[${tablesSql}]) t WHERE to_regclass('public.' || t) IS NULL
    UNION ALL
    SELECT 'MISSING_FUNCTION|' || f FROM unnest(ARRAY[${fnsSql}]) f
      WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = f);
  `).trim()
  const missing = out ? out.split('\n').map(l => l.trim()).filter(Boolean) : []
  return { ok: missing.length === 0, missing }
}

let stackAvailable = false
if (DB_CONTAINER) {
  try {
    dockerPsql('select 1;')
    const schema = verifyRequiredSchema()
    stackAvailable = schema.ok
    if (!schema.ok && STATEFUL_REQUIRED) {
      throw new Error(`PFM_STATEFUL_DB_REQUIRED=1 but the target's schema is incomplete -- missing: ${schema.missing.join(', ')}. Zero writes will be attempted.`)
    }
  } catch (e) {
    if (STATEFUL_REQUIRED) throw e
    stackAvailable = false
  }
}
const describeIfLocalDb = stackAvailable ? describe : describe.skip

// ============================================================
// 1. The written-but-never-run 093 SQL test file, executed for real.
// ============================================================
describeIfLocalDb('093 SQL test file (supabase/tests/093_spend_credits_and_save_paid_result.test.sql) -- executed for real', () => {
  it('every scenario in the file passes: psql exits 0 and the output contains no "TEST FAILED" line', () => {
    const path = join(process.cwd(), 'supabase', 'tests', '093_spend_credits_and_save_paid_result.test.sql')
    const { out, threw } = runFile(path)
    expect(threw, `psql reported an error -- output:\n${out.slice(0, 4000)}`).toBe(false)
    expect(out, `a scenario reported failure -- output:\n${out.slice(0, 4000)}`).not.toMatch(/TEST FAILED/)
    expect(out).toContain('All migration 093 RPC-level assertions in this file passed.')
  })
})


// ============================================================
// 2. REAL two-OS-process concurrency race against the UNMODIFIED RPC.
// ============================================================
// The production RPC is called as ONE opaque statement and not changed by a
// byte. The only instrumentation is a TEST-ONLY BEFORE INSERT trigger on
// public.paid_results, created here and dropped in afterAll -- it exists
// only in this disposable instance, never in the 093 migration. It is a
// no-op for every row except an INSERT that (a) carries the marker
// input_hash AND (b) comes from a session that explicitly opted in via the
// custom setting `app.test093_barrier = 'on'` (only session A does -- an
// earlier draft let session B's own conflicting INSERT fire the barrier
// too, which only worked by accident).
//
// WHY the earlier handshake was wrong: it used release-as-signal (A
// unlocked K_GO, then locked K_DONE). If A reached the trigger before B had
// acquired K_DONE, A would take K_DONE itself, sail through, and the
// planned collision would never happen. A signal that is only an EVENT (a
// release) can be missed; the fix is to use LEVEL signals -- lock states
// that stay true and can be OBSERVED -- and to make each side refuse to
// proceed until it has OBSERVED the other side's state in pg_locks:
//
//   K_B_HOLD      (930002) held by B from its very first statement until
//                 after B's conflicting row is COMMITTED.
//   K_A_AT_INSERT (930001) acquired by A's trigger, and never released
//                 before A's session ends -- a level signal "A is at its
//                 paid_results INSERT, after its debit".
//
//   B: lock(K_B_HOLD)                      -- B's readiness (level)
//   A: WAIT until pg_locks shows K_B_HOLD granted to ANOTHER backend
//      (deadline-bounded) -- ONLY THEN call the real RPC   [A confirms B]
//   A (inside the RPC, at the INSERT): the trigger first proves the debit
//      is already visible inside A's own transaction (ledger row + reduced
//      balance, else it raises), then lock(K_A_AT_INSERT) [level signal],
//      then lock(K_B_HOLD)                  -- blocks: B still holds it
//   B: WAIT until pg_locks shows K_A_AT_INSERT granted to ANOTHER backend
//      (deadline-bounded)                                  [B confirms A]
//   B: INSERT the conflicting row (autocommit -> committed on return),
//      THEN unlock(K_B_HOLD)                -- releases A's trigger
//   A: the trigger returns, the real INSERT runs, collides with B's
//      committed row -> unique_violation -> whole transaction rolls back.
//
// Order-independence: if A starts first it simply waits for B's lock; if B
// starts first it simply waits for A's. A cannot pass the trigger early
// because B demonstrably holds K_B_HOLD (A observed that before starting),
// and B cannot insert early because A demonstrably is at the INSERT (B
// observed that). The polling loops use pg_sleep only as a poll CADENCE --
// the condition they wait for is an observed DB state, bounded by a
// deadline; they are not timing assumptions. Each session also records
// NOTICE markers so the test asserts that every confirmation step really
// executed, not just that the final outcome looks right.
describeIfLocalDb('spend_credits_and_save_paid_result -- REAL two-process race: collision happens AFTER the debit, at the paid_results INSERT, calling the unmodified RPC', () => {
  const TEST_USER_ID = randomUUID()
  const BARRIER_HASH = '__test093_concurrency_barrier__'
  const K_A_AT_INSERT = 930001
  const K_B_HOLD = 930002
  const START_BALANCE = 100
  const COST = 6
  const MAX_POLLS = 300 // x 50ms cadence = 15s deadline; statement_timeout is a second, independent backstop

  function waitForLockHeldByOther(key: number, notice: string): string {
    return `
DO $poll$
DECLARE i int := 0;
BEGIN
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND classid = 0 AND objid = ${key} AND objsubid = 1
        AND granted AND pid <> pg_backend_pid()
    ) THEN
      RAISE NOTICE '${notice}';
      RETURN;
    END IF;
    i := i + 1;
    IF i > ${MAX_POLLS} THEN
      RAISE EXCEPTION 'handshake deadline exceeded: ${notice} never confirmed';
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$poll$;`
  }

  function setupFixtureAndTrigger() {
    dockerPsql(`
      INSERT INTO auth.users (id, email) VALUES ('${TEST_USER_ID}'::uuid, '${TEST_USER_ID}@test.local');
      INSERT INTO public.user_credits (user_id, balance, purchased_credit_balance, subscription_credit_balance)
        VALUES ('${TEST_USER_ID}'::uuid, ${START_BALANCE}, ${START_BALANCE}, 0)
        ON CONFLICT (user_id) DO UPDATE SET balance = ${START_BALANCE}, purchased_credit_balance = ${START_BALANCE}, subscription_credit_balance = 0;

      CREATE OR REPLACE FUNCTION public._test093_race_barrier() RETURNS trigger
      LANGUAGE plpgsql AS $barrier$
      BEGIN
        IF NEW.input_hash = '${BARRIER_HASH}' AND current_setting('app.test093_barrier', true) = 'on' THEN
          -- Prove, from inside A's own still-open transaction, that the
          -- debit has ALREADY happened by the time the INSERT is reached.
          IF NOT EXISTS (
            SELECT 1 FROM public.credit_ledger
            WHERE user_id = NEW.user_id AND reason = 'credit_spend' AND external_ref LIKE 'op:%'
          ) THEN
            RAISE EXCEPTION 'test093 barrier reached BEFORE the credit_ledger debit row existed';
          END IF;
          IF (SELECT balance FROM public.user_credits WHERE user_id = NEW.user_id) <> ${START_BALANCE - COST} THEN
            RAISE EXCEPTION 'test093 barrier reached BEFORE user_credits was debited';
          END IF;
          RAISE NOTICE 'A_AT_INSERT_AFTER_DEBIT';
          PERFORM pg_advisory_lock(${K_A_AT_INSERT});   -- level signal to B
          PERFORM pg_advisory_lock(${K_B_HOLD});        -- blocks until B has committed and released
          RAISE NOTICE 'A_RELEASED_BY_B_AFTER_COMMIT';
        END IF;
        RETURN NEW;
      END;
      $barrier$;

      DROP TRIGGER IF EXISTS _test093_race_barrier_trigger ON public.paid_results;
      CREATE TRIGGER _test093_race_barrier_trigger
        BEFORE INSERT ON public.paid_results
        FOR EACH ROW EXECUTE FUNCTION public._test093_race_barrier();
    `)
  }

  function dropTriggerAndFixture() {
    dockerPsql(`
      DROP TRIGGER IF EXISTS _test093_race_barrier_trigger ON public.paid_results;
      DROP FUNCTION IF EXISTS public._test093_race_barrier();
      DELETE FROM public.paid_operations WHERE user_id = '${TEST_USER_ID}'::uuid;
      DELETE FROM public.paid_results WHERE user_id = '${TEST_USER_ID}'::uuid;
      DELETE FROM public.credit_ledger WHERE user_id = '${TEST_USER_ID}'::uuid;
      DELETE FROM public.ai_usage_logs WHERE user_id = '${TEST_USER_ID}'::uuid;
      DELETE FROM public.user_credits WHERE user_id = '${TEST_USER_ID}'::uuid;
      DELETE FROM auth.users WHERE id = '${TEST_USER_ID}'::uuid;
    `)
  }

  afterAll(() => dropTriggerAndFixture())

  it('A (real RPC) refuses to start until B\'s lock is observed, collides AFTER its debit with B\'s committed row, fully rolls back, and left no ledger/audit/usage rows behind', async () => {
    setupFixtureAndTrigger()

    const balanceBefore = dockerPsql(`SELECT balance FROM public.user_credits WHERE user_id = '${TEST_USER_ID}'::uuid;`).trim()

    const sessionA = () => dockerPsqlAsync(`
      SET statement_timeout = '30s';
      SET app.test093_barrier = 'on';
      ${waitForLockHeldByOther(K_B_HOLD, 'A_CONFIRMED_B_READY')}
      SELECT public.spend_credits_and_save_paid_result(
        '${TEST_USER_ID}'::uuid, 'video_package_long', ${COST}, '{"topic":"race"}'::jsonb,
        'video_package', '${BARRIER_HASH}', 'norm', 'orig-A',
        NULL, NULL, 'youtube', '{"hook":"A should never win"}'::jsonb, '{}'::jsonb, ${COST}, now() + interval '24 hours',
        'anthropic', 'combined', 'video_package', 'v1', 0.15
      );
    `)

    const sessionB = () => dockerPsqlAsync(`
      SET statement_timeout = '30s';
      SELECT pg_advisory_lock(${K_B_HOLD});
      ${waitForLockHeldByOther(K_A_AT_INSERT, 'B_CONFIRMED_A_AT_INSERT')}
      INSERT INTO public.paid_results(user_id, tool_type, input_hash, normalized_input, original_input, result_json, status)
        VALUES ('${TEST_USER_ID}'::uuid, 'video_package', '${BARRIER_HASH}', 'norm', 'orig-B', '{"hook":"B won the race"}'::jsonb, 'completed');
      SELECT pg_advisory_unlock(${K_B_HOLD});
    `)

    const [resultA, resultB] = await Promise.all([sessionA(), sessionB()])

    // Every confirmation step actually executed, in both sessions.
    expect(resultB.ok, `session B failed unexpectedly -- stderr:\n${resultB.stderr}\nout:\n${resultB.out}`).toBe(true)
    expect(resultB.stderr).toContain('B_CONFIRMED_A_AT_INSERT')
    expect(resultA.stderr).toContain('A_CONFIRMED_B_READY')
    expect(resultA.stderr).toContain('A_AT_INSERT_AFTER_DEBIT')
    expect(resultA.stderr).toContain('A_RELEASED_BY_B_AFTER_COMMIT')

    // A: the real RPC call must fail with the unique-constraint collision.
    expect(resultA.ok, `session A unexpectedly succeeded -- the collision never happened: ${resultA.stderr}`).toBe(false)
    expect(resultA.stderr).toMatch(/idx_paid_results_user_tool_hash|duplicate key value violates unique constraint/i)

    // The debit (and ledger/audit inserts) from A's attempt are fully
    // rolled back -- the user is fresh, created only for this test, so any
    // row below is unambiguously from A's rolled-back attempt.
    const balanceAfter = dockerPsql(`SELECT balance FROM public.user_credits WHERE user_id = '${TEST_USER_ID}'::uuid;`).trim()
    expect(balanceAfter).toBe(balanceBefore)

    const ledgerCount = dockerPsql(`SELECT count(*) FROM public.credit_ledger WHERE user_id = '${TEST_USER_ID}'::uuid;`).trim()
    expect(ledgerCount, 'A\'s debit must leave NO credit_ledger row -- the whole transaction rolled back').toBe('0')

    const usageCount = dockerPsql(`SELECT count(*) FROM public.ai_usage_logs WHERE user_id = '${TEST_USER_ID}'::uuid;`).trim()
    expect(usageCount, 'A\'s charge-audit row must NOT exist -- it was inside the same rolled-back transaction').toBe('0')

    const opCount = dockerPsql(`SELECT count(*) FROM public.paid_operations WHERE user_id = '${TEST_USER_ID}'::uuid;`).trim()
    expect(opCount, 'A never committed, so it must have written NO paid_operations audit row either').toBe('0')

    const resultsRow = dockerPsql(`
      SELECT count(*) || '|' || string_agg(result_json->>'hook', ',')
      FROM public.paid_results WHERE user_id = '${TEST_USER_ID}'::uuid AND input_hash = '${BARRIER_HASH}';
    `).trim()
    expect(resultsRow).toBe('1|B won the race')
  }, 60000)
})
