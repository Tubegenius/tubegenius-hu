// DB-free contract: who owns tests/093-video-package-atomic-charge-save-db-integration.test.ts
// in CI. Pure text checks on the workflow files -- nothing is executed, no
// Docker, no DB. It exists so that the regression exclusion, the opt-in
// preflight job's target/count/env, and the strict skip-guard stay in
// agreement; it never weakens the guard.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { main } from '../scripts/ci-skip-guard'

const TEST_FILE = 'tests/093-video-package-atomic-charge-save-db-integration.test.ts'
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')

const quality = read('.github/workflows/quality.yml')
const preflight = read('.github/workflows/093-video-package-preflight.yml')
const testSource = read(TEST_FILE)

// The regression job's "Full test suite" step: from its `name:` line to the next step.
function regressionVitestCommand(): string {
  const start = quality.indexOf('- name: Full test suite')
  expect(start, 'regression "Full test suite" step not found').toBeGreaterThan(-1)
  const next = quality.indexOf('\n      - name:', start + 1)
  return quality.slice(start, next === -1 ? undefined : next)
}

describe('093 DB-integration test ownership (DB-free contract)', () => {
  it('the normal regression run explicitly EXCLUDES the 093 DB-integration file', () => {
    expect(regressionVitestCommand()).toContain(`--exclude ${TEST_FILE}`)
  })

  it('the file is not claimed by any other quality.yml leg (not in the stateful-tests matrix, not a positional vitest target)', () => {
    const mentions = quality.split('\n').filter(l => l.includes('093-video-package-atomic-charge-save-db-integration'))
    // only the --exclude line plus the ownership comment lines may mention it
    for (const line of mentions) {
      expect(line.trim().startsWith('--exclude') || line.trim().startsWith('#'), `unexpected reference: ${line}`).toBe(true)
    }
    expect(quality).not.toMatch(/file:\s*tests\/093-video-package/)
  })

  it('the strict skip-guard is not weakened: no 093 entry in either allowlist and the regression keeps --mode full with the allowlist', () => {
    for (const rel of ['.github/ci/skip-allowlist.json', '.github/ci/stateful-tests-allowlist.json', '.github/ci/preflight-093-allowlist.json']) {
      expect(read(rel), `${rel} must not allowlist the 093 file`).not.toMatch(/093-video-package/)
    }
    // The regression guard step still runs the full (strict) mode on the full report.
    expect(quality).toMatch(/ci-skip-guard\.ts --report "\$RUNNER_TEMP\/vitest-full\.json" \\\n\s+--mode full --summary-dir/)
  })

  it('the file carries the stackAvailable gate (so the DB-free unit job accepts its stackless skips)', () => {
    expect(testSource).toContain('stackAvailable')
  })

  it('the opt-in preflight workflow runs exactly this file, with the disposable-target env contract', () => {
    expect(preflight).toContain(`npx vitest run ${TEST_FILE}`)
    expect(preflight).toContain('PFM_STATEFUL_DB_TARGET:')
    expect(preflight).toContain('PFM_STATEFUL_DB_CONFIRM: yes-mutate-disposable-target')
    expect(preflight).toContain("PFM_STATEFUL_DB_REQUIRED: '1'")
    expect(preflight).toContain('preflight093_disposable_')
  })

  it('the preflight EXPECTED_TOTAL equals the number of static it( declarations in the file, and zero skips are tolerated', () => {
    const declared = (testSource.match(/^\s*it\(/gm) || []).length
    const expected = Number((preflight.match(/const EXPECTED_TOTAL = (\d+);/) || [])[1])
    expect(declared).toBeGreaterThan(0)
    expect(expected).toBe(declared)
    expect(preflight).toMatch(/pending > 0 \|\| todo > 0/)
  })

  it('the preflight is approval-gated: dispatch or the exact label on a same-repo PR; never push, never plain pull_request activity', () => {
    const onBlock = preflight.slice(preflight.indexOf('\non:\n'), preflight.indexOf('\npermissions:'))
    expect(onBlock).toContain('workflow_dispatch')
    expect(onBlock).toMatch(/pull_request:\s*\n\s+types:\s*\[labeled\]/)
    expect(onBlock).not.toMatch(/^\s+push:/m)
    expect(onBlock).not.toMatch(/opened|synchronize|reopened/)
    expect(preflight).toContain("github.event.label.name == 'run-093-preflight'")
    expect(preflight).toContain('github.event.pull_request.head.repo.full_name == github.repository')
  })


  it('the preflight tests the EXACT PR head (not the synthetic merge commit), verifies it, and records both SHAs', () => {
    // checkout pinned to the PR head (dispatch: github.sha)
    expect(preflight).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}')
    expect(preflight).toMatch(/actions\/checkout@[0-9a-f]{40}\n\s+with:\n\s+ref: /)
    // expressions go through env, with both SHAs available
    expect(preflight).toContain('TESTED_SHA_EXPECTED: ${{ github.event.pull_request.head.sha || github.sha }}')
    expect(preflight).toContain('EVENT_SHA: ${{ github.sha }}')
    // a verification step fails the run if HEAD differs, or if a pull_request run tested the merge commit
    expect(preflight).toContain('git rev-parse HEAD')
    expect(preflight).toContain('[ "$actual" != "$TESTED_SHA_EXPECTED" ]')
    expect(preflight).toContain('[ "$actual" = "$EVENT_SHA" ]')
    // the result states both and is uploaded
    expect(preflight).toContain('| TESTED ($kind) | $actual |')
    expect(preflight).toMatch(/event SHA .*NOT tested/)
    expect(preflight).toContain('${{ runner.temp }}/ci-summary-sha')
    // the verification runs before any build/test step
    expect(preflight.indexOf('git rev-parse HEAD')).toBeLessThan(preflight.indexOf('npm ci'))
    // no github.* expression is interpolated directly into a run script for the SHAs
    const runLines = preflight.split('\n').filter(l => /^\s*run:/.test(l))
    for (const l of runLines) expect(l).not.toContain('${{')
  })
})

// ---------------------------------------------------------------------------
// The preflight's two PARTIAL (single-file) guard runs must use a dedicated
// allowlist, not the repo-wide skip-allowlist.json (39 entries of OTHER files
// -> all stale on a partial run). The guard stays strict.
// ---------------------------------------------------------------------------
const DEDICATED = '.github/ci/preflight-093-allowlist.json'
const REPO_WIDE = '.github/ci/skip-allowlist.json'

describe('093 preflight guard allowlist (DB-free contract)', () => {
  it('both preflight guard steps (090 run, 093 run) use the dedicated allowlist, strict --mode full, and never the repo-wide skip-allowlist', () => {
    const guardCalls = preflight.split('\n').filter(l => l.trim().startsWith('--mode full'))
    expect(guardCalls.length).toBe(2)
    for (const l of guardCalls) {
      expect(l).toContain(`--allowlist ${DEDICATED}`)
      expect(l).not.toContain('skip-allowlist.json')
    }
    for (const n of ['090', '093']) {
      expect(preflight).toContain(`vitest-${n}.json" \\\n            --mode full --allowlist ${DEDICATED} --summary-dir`)
    }
    expect(preflight).not.toMatch(/--mode stackless/)
  })

  it('the dedicated allowlist is exactly empty ({version:1, entries:[]}) -- nothing is excused on these partial runs', () => {
    expect(JSON.parse(read(DEDICATED))).toEqual({ version: 1, entries: [] })
  })

  describe('behaviour of the real guard with the real files, on synthetic single-file reports', () => {
    const ROOT = path.resolve('/repo')
    let dir = ''
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
      dir = ''
      vi.restoreAllMocks()
    })

    const as = (fullName: string, status: string, failureMessages: string[] = []) => ({ fullName, status, failureMessages })
    function run(fileRel: string, assertions: ReturnType<typeof as>[], allowlistRel: string, fileStatus = 'passed'): number {
      dir = mkdtempSync(path.join(tmpdir(), 'preflight-guard-'))
      const rep = {
        numTotalTests: assertions.length,
        numPassedTests: assertions.filter(a => a.status === 'passed').length,
        numFailedTests: assertions.filter(a => a.status === 'failed').length,
        numPendingTests: assertions.filter(a => a.status === 'pending').length,
        numFailedTestSuites: fileStatus === 'failed' ? 1 : 0,
        testResults: [{ name: path.join(ROOT, fileRel), status: fileStatus, message: '', assertionResults: assertions }],
      }
      const reportPath = path.join(dir, 'report.json')
      writeFileSync(reportPath, JSON.stringify(rep))
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      return main(['--report', reportPath, '--mode', 'full', '--root', ROOT, '--allowlist', join(process.cwd(), allowlistRel)])
    }
    const F090 = 'tests/090-public-schema-privilege-hardening-db-integration.test.ts'
    const F093 = 'tests/093-video-package-atomic-charge-save-db-integration.test.ts'

    it('REGRESSION PROOF of the defect: a clean 090-only run FAILS against the repo-wide allowlist (all its entries stale)', () => {
      expect(run(F090, [as('090 > ok', 'passed')], REPO_WIDE)).toBe(1)
    })

    it('a clean 090-only run and a clean 093-only run PASS with the dedicated allowlist', () => {
      expect(run(F090, [as('090 > ok', 'passed')], DEDICATED)).toBe(0)
      expect(run(F093, [as('093 > a', 'passed'), as('093 > b', 'passed')], DEDICATED)).toBe(0)
    })

    it('stays strict: an unknown skip, a test failure and a file-level failure are each REJECTED with the dedicated allowlist', () => {
      expect(run(F090, [as('090 > ok', 'passed'), as('090 > sneaky skip', 'pending')], DEDICATED), 'unknown skip').toBe(1)
      expect(run(F093, [as('093 > race', 'failed', ['boom'])], DEDICATED), 'test failure').toBe(1)
      expect(run(F090, [], DEDICATED, 'failed'), 'file-level failure').toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// UUIDv5 dependency + pinned function-body hash (DB-free). The first
// disposable-stack preflight showed the unqualified uuid_generate_v5 call does
// not resolve under the RPC's pinned search_path. These checks keep the
// qualified call, the 090 pin and the next disposable run's real-RPC coverage
// in agreement without touching a database.
// ---------------------------------------------------------------------------
describe('093 RPC UUIDv5 qualification, 090 body pin and real-RPC coverage (DB-free contract)', () => {
  const migration = read('supabase/migrations/093_video_package_atomic_charge_save.sql')
  const test090 = read('tests/090-public-schema-privilege-hardening-db-integration.test.ts')
  const runbook = read('docs/operations/video-package-uncertain-outcome-reconciliation.md')

  // The RPC's own source (prosrc): text between its dollar-quote delimiters.
  // Same extraction as used to pin the live-confirmed md5 in the 090 test.
  function rpcBody(): string {
    const start = migration.indexOf('AS $$\n') + 'AS $$'.length
    const end = migration.indexOf('\n$$;', start) + 1
    expect(start).toBeGreaterThan('AS $$'.length)
    expect(end).toBeGreaterThan(start)
    return migration.slice(start, end)
  }

  it('the RPC body calls uuid_generate_v5 only schema-qualified (extensions.), once, with the unchanged namespace and concatenation', () => {
    const body = rpcBody()
    const calls = body.match(/[A-Za-z_.]*uuid_generate_v5\(/g) || []
    expect(calls).toEqual(['extensions.uuid_generate_v5('])
    expect(body).toContain("v_namespace CONSTANT UUID := '7d9e9b1a-f3c4-4b8e-9a2d-6c1f0e5d8a3b';")
    expect(body).toContain("v_operation_id := extensions.uuid_generate_v5(v_namespace, p_user_id::text || ':' || p_tool_type || ':' || p_input_hash);")
    expect(body).toContain('v_lock_key := hashtext(v_operation_id::text);')
    expect(body).toContain('PERFORM pg_advisory_xact_lock(v_lock_key);')
    // search_path stays pinned as before (the fix is the qualification, not a wider path)
    expect(migration).toContain('LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp\nAS $$')
  })

  it('the migration fails closed at apply time if extensions.uuid_generate_v5(uuid,text) is missing or not executable', () => {
    const closing = migration.slice(migration.indexOf('-- ── Closing self-check'))
    expect(closing).toContain("to_regprocedure('extensions.uuid_generate_v5(uuid,text)') IS NULL")
    expect(closing).toContain("has_function_privilege(current_user, 'extensions.uuid_generate_v5(uuid,text)', 'EXECUTE')")
  })

  it('the 090 pin for the 093 function equals the md5 of the CURRENT RPC body (same method the live catalog confirmed), with no stale hash left behind', () => {
    const md5 = createHash('md5').update(rpcBody(), 'utf8').digest('hex')
    const pinned = (/spend_credits_and_save_paid_result\(p_user_id uuid[^']*\|body=([0-9a-f]{32})'/.exec(test090) || [])[1]
    expect(pinned).toBe(md5)
    // the previous (unqualified-call) revision's hash must be gone
    expect(test090).not.toContain('fa94a807a3ef5df8fdba211c89f3cf92')
  })

  it('the runbook uses the same qualified formula (and states no unqualified variant)', () => {
    expect(runbook).toContain("operation_id = extensions.uuid_generate_v5('7d9e9b1a-f3c4-4b8e-9a2d-6c1f0e5d8a3b', user_id::text || ':video_package:' || input_hash)")
    expect(runbook).not.toMatch(/(^|[^.])uuid_generate_v5\(/m)
    expect(runbook).not.toContain('telepítésenként eltérhet')
  })

  it('the next disposable run exercises the REAL RPC: the integration file checks the qualified UUIDv5 dependency, makes a real service_role call, and races the unmodified RPC; the SQL file calls it too', () => {
    expect(testSource).toContain("to_regprocedure('extensions.uuid_generate_v5(uuid,text)')")
    expect(testSource).toContain('SET LOCAL ROLE service_role;')
    // direct, positional call of the real function in BOTH the smoke call and the race (no re-implemented steps)
    const rpcCalls = testSource.match(/SELECT public\.spend_credits_and_save_paid_result\(/g) || []
    expect(rpcCalls.length).toBeGreaterThanOrEqual(2)
    // the trigger instrumentation never redefines or wraps the production function
    expect(testSource).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.spend_credits_and_save_paid_result/)
    expect(read('supabase/tests/093_spend_credits_and_save_paid_result.test.sql')).toContain('spend_credits_and_save_paid_result(')
    // and the preflight really runs that file with an exact, matching count (checked above) and no skips tolerated
    expect(preflight).toContain(`npx vitest run ${TEST_FILE}`)
  })
})
