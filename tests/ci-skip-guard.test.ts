// Unit tests for scripts/ci-skip-guard.ts -- the CI gate that fails on any
// failed test, file-level failure, malformed report, or unknown/stale skip.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateReport, main, parseAllowlist, redact, type AllowEntry, type GuardOptions } from '../scripts/ci-skip-guard'

const ROOT = path.resolve('/repo')
const abs = (rel: string) => path.join(ROOT, rel)

function assertion(fullName: string, status: string, failureMessages: string[] = []) {
  return { fullName, status, failureMessages }
}
function file(rel: string, assertions: ReturnType<typeof assertion>[], status = 'passed', message = '') {
  return { name: abs(rel), status, message, assertionResults: assertions }
}
function report(files: ReturnType<typeof file>[], overrides: Record<string, unknown> = {}) {
  const all = files.flatMap((f) => f.assertionResults)
  return {
    numTotalTests: all.length,
    numPassedTests: all.filter((a) => a.status === 'passed').length,
    numFailedTests: all.filter((a) => a.status === 'failed').length,
    numPendingTests: all.filter((a) => a.status === 'pending').length,
    numFailedTestSuites: files.filter((f) => f.status === 'failed').length,
    testResults: files,
    ...overrides,
  }
}
const entry = (fileRel: string, name: string, extra: Partial<AllowEntry> = {}): AllowEntry => ({
  file: fileRel,
  name,
  reason: 'documented structural skip',
  ...extra,
})
function options(overrides: Partial<GuardOptions> = {}): GuardOptions {
  return {
    mode: 'full',
    allowlist: { version: 1, entries: [] },
    platform: 'linux',
    root: ROOT,
    readFile: () => '',
    ...overrides,
  }
}

describe('full mode', () => {
  it('passes a clean report with no skips', () => {
    const r = evaluateReport(report([file('tests/a.test.ts', [assertion('a > works', 'passed')])]), options())
    expect(r.ok).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.counts).toMatchObject({ passed: 1, failed: 0, skipped: 0 })
  })

  it('passes when every skip is allowlisted and every applicable entry is observed', () => {
    const rep = report([file('tests/a.test.ts', [assertion('a > pre-state', 'pending'), assertion('a > ok', 'passed')])])
    const r = evaluateReport(rep, options({ allowlist: { version: 1, entries: [entry('tests/a.test.ts', 'a > pre-state')] } }))
    expect(r.ok).toBe(true)
    expect(r.skipped.map((s) => s.id)).toEqual(['tests/a.test.ts::a > pre-state'])
  })

  it('fails on any failed test and names it', () => {
    const rep = report([file('tests/a.test.ts', [assertion('a > breaks', 'failed', ['AssertionError: nope\n at x'])])])
    const r = evaluateReport(rep, options())
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('FAILED tests/a.test.ts::a > breaks -- AssertionError: nope')
  })

  it('fails on a file-level (collection) failure even when no assertion failed', () => {
    const rep = report([file('tests/b.test.ts', [], 'failed', 'Node.js 20 detected without native WebSocket support.')])
    const r = evaluateReport(rep, options())
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('FAILED FILE tests/b.test.ts')
  })

  it('fails on an unknown skip', () => {
    const rep = report([file('tests/a.test.ts', [assertion('a > sneaky', 'pending')])])
    const r = evaluateReport(rep, options())
    expect(r.ok).toBe(false)
    expect(r.failures).toContain('UNKNOWN SKIP tests/a.test.ts::a > sneaky')
  })

  it('fails on a todo test that is not allowlisted', () => {
    const rep = report([file('tests/a.test.ts', [assertion('a > later', 'todo')])])
    expect(evaluateReport(rep, options()).ok).toBe(false)
  })

  it('fails on a stale allowlist entry that was not skipped in this run', () => {
    const rep = report([file('tests/a.test.ts', [assertion('a > ok', 'passed')])])
    const r = evaluateReport(rep, options({ allowlist: { version: 1, entries: [entry('tests/a.test.ts', 'a > gone')] } }))
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('STALE ALLOWLIST ENTRY')
  })

  it('platform-scoped entries apply only on their platform', () => {
    const scoped = { version: 1 as const, entries: [entry('tests/a.test.ts', 'a > win-only', { platforms: ['win32'] })] }
    const skipsOnWindows = report([file('tests/a.test.ts', [assertion('a > win-only', 'pending')])])
    expect(evaluateReport(skipsOnWindows, options({ platform: 'win32', allowlist: scoped })).ok).toBe(true)
    // On linux the same skip is NOT allowed (it must run there) ...
    expect(evaluateReport(skipsOnWindows, options({ platform: 'linux', allowlist: scoped })).ok).toBe(false)
    // ... and the win32-only entry is not reported stale when it simply runs.
    const runsOnLinux = report([file('tests/a.test.ts', [assertion('a > win-only', 'passed')])])
    expect(evaluateReport(runsOnLinux, options({ platform: 'linux', allowlist: scoped })).ok).toBe(true)
  })

  it('rejects malformed and empty reports', () => {
    expect(evaluateReport({}, options()).ok).toBe(false)
    expect(evaluateReport(null, options()).ok).toBe(false)
    expect(evaluateReport(report([]), options()).ok).toBe(false)
  })

  it('redacts credential-shaped text in failure lines', () => {
    const jwt = [['eyJhbGci', 'OiJIUzI1NiJ9'].join(''), 'cGF5bG9hZHBhcnQ', 'c2lnbmF0dXJl'].join('.')
    const rep = report([file('tests/a.test.ts', [assertion('a > leaks', 'failed', [`expected ${jwt} to equal 1`])])])
    const r = evaluateReport(rep, options())
    expect(r.failures.join('\n')).not.toContain(jwt)
    expect(r.failures.join('\n')).toContain('[REDACTED]')
  })
})

describe('stackless mode', () => {
  const gatedSource = 'const describeIfLocalDb = stackAvailable ? describe : describe.skip'
  it('accepts skips in stack-gated files only', () => {
    const rep = report([
      file('tests/db.test.ts', [assertion('db > x', 'pending')]),
      file('tests/plain.test.ts', [assertion('plain > y', 'pending')]),
    ])
    const r = evaluateReport(rep, options({ mode: 'stackless', readFile: (p) => (p.endsWith('db.test.ts') ? gatedSource : 'no gate here') }))
    expect(r.ok).toBe(false)
    expect(r.failures).toEqual(['UNKNOWN SKIP (file is not stack-gated) tests/plain.test.ts::plain > y'])
  })
  it('passes when all skips are stack-gated and nothing failed', () => {
    const rep = report([file('tests/db.test.ts', [assertion('db > x', 'pending'), assertion('db > z', 'pending')])])
    expect(evaluateReport(rep, options({ mode: 'stackless', readFile: () => gatedSource })).ok).toBe(true)
  })
  it('still fails on failed tests', () => {
    const rep = report([file('tests/a.test.ts', [assertion('a > bad', 'failed')])])
    expect(evaluateReport(rep, options({ mode: 'stackless' })).ok).toBe(false)
  })
})

describe('parseAllowlist / redact', () => {
  it('requires a reason, unique entries and a non-empty platforms array', () => {
    expect(() => parseAllowlist({ version: 1, entries: [{ file: 'f', name: 'n', reason: ' ' }] })).toThrow(/no reason/)
    expect(() => parseAllowlist({ version: 1, entries: [entry('f', 'n'), entry('f', 'n')] })).toThrow(/duplicate/)
    expect(() => parseAllowlist({ version: 1, entries: [entry('f', 'n', { platforms: [] })] })).toThrow(/platforms/)
    expect(() => parseAllowlist({ version: 2, entries: [] })).toThrow()
    expect(parseAllowlist({ version: 1, entries: [entry('f', 'n', { platforms: ['win32'] })] }).entries).toHaveLength(1)
  })
  it('redacts JWT-, Stripe- and bearer-shaped text', () => {
    const jwt = [['eyJhbGci', 'OiJIUzI1NiJ9'].join(''), 'cGF5bG9hZHBhcnQ', 'c2lnbmF0dXJl'].join('.')
    const stripeLike = ['sk', 'test', 'abcdefghijklmnop'].join('_')
    const hook = ['whsec', 'abcdefghijklmnop'].join('_')
    const out = redact(`a ${jwt} b ${stripeLike} c ${hook} d Bearer abcdefghijklmnopqrstuvwx`)
    expect(out).toBe('a [REDACTED] b [REDACTED] c [REDACTED] d [REDACTED]')
  })
})

describe('main() CLI entry', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
    vi.restoreAllMocks()
  })

  function setup(rep: unknown, allowlist: unknown) {
    dir = mkdtempSync(path.join(tmpdir(), 'ci-skip-guard-'))
    mkdirSync(path.join(dir, '.github', 'ci'), { recursive: true })
    const reportPath = path.join(dir, 'report.json')
    writeFileSync(reportPath, JSON.stringify(rep))
    writeFileSync(path.join(dir, '.github', 'ci', 'skip-allowlist.json'), JSON.stringify(allowlist))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    return reportPath
  }

  it('exit 0 and writes a redacted summary for a clean full run', () => {
    const rep = report([file('tests/a.test.ts', [assertion('a > ok', 'passed')])])
    const reportPath = setup(rep, { version: 1, entries: [] })
    const rootArgs = ['--root', ROOT]
    // main() resolves report paths as absolute test names relative to --root
    const code = main(['--report', reportPath, '--mode', 'full', ...rootArgs, '--allowlist', path.join(dir, '.github', 'ci', 'skip-allowlist.json'), '--summary-dir', path.join(dir, 'out')])
    expect(code).toBe(0)
    const summary = readFileSync(path.join(dir, 'out', 'summary-full.md'), 'utf8')
    expect(summary).toContain('verdict: PASS')
  })

  it('exit 1 on an unknown skip, exit 2 on unusable arguments/inputs', () => {
    const rep = report([file('tests/a.test.ts', [assertion('a > sneaky', 'pending')])])
    const reportPath = setup(rep, { version: 1, entries: [] })
    const allowlist = path.join(dir, '.github', 'ci', 'skip-allowlist.json')
    expect(main(['--report', reportPath, '--mode', 'full', '--root', ROOT, '--allowlist', allowlist])).toBe(1)
    expect(main(['--mode', 'full'])).toBe(2)
    expect(main(['--report', path.join(dir, 'missing.json'), '--mode', 'full', '--allowlist', allowlist])).toBe(2)
  })
})
