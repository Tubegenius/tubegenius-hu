// CI test-report guard. Reads a vitest JSON report and fails the build on:
//   - any failed test, any file-level (collection) failure, a malformed or
//     empty report;
//   - any skipped/todo test that is not explicitly allowed.
//
// A skip is identified by a stable id: "<repo-relative file>::<full test name>".
//   --mode full       every skip must match an entry in the closed allowlist
//                     (.github/ci/skip-allowlist.json), and every allowlist
//                     entry that applies to this platform must actually be
//                     observed (a stale entry fails too).
//   --mode stackless  DB-free job: a skip is accepted only when its file is
//                     gated on the local Supabase stack (the file source
//                     contains the `stackAvailable` gate). Everything else
//                     that skips fails.
// Only erasable TypeScript syntax and node: builtins are used so it runs
// directly under `node scripts/ci-skip-guard.ts` (Node >= 24).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface AllowEntry {
  file: string
  name: string
  reason: string
  platforms?: string[]
}
export interface Allowlist {
  version: 1
  entries: AllowEntry[]
}
export type GuardMode = 'full' | 'stackless'
export interface GuardOptions {
  mode: GuardMode
  allowlist: Allowlist
  platform: string
  root: string
  readFile: (absolutePath: string) => string
}
export interface SkippedTest {
  id: string
  file: string
  name: string
}
export interface GuardResult {
  ok: boolean
  failures: string[]
  counts: { passed: number; failed: number; skipped: number; failedSuites: number }
  skipped: SkippedTest[]
}

const SKIP_STATUSES = new Set(['pending', 'skipped', 'todo'])
const STACK_GATE_MARKER = 'stackAvailable'

// Secret-shaped substrings are assembled from pieces so this file never
// contains a contiguous credential-looking literal.
const REDACTIONS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}/g,
  new RegExp(`\\b(?:${['sk', 'rk'].join('|')})_(?:test|live)_[A-Za-z0-9]+`, 'g'),
  new RegExp(`\\b${['whsec'].join('')}_[A-Za-z0-9]+`, 'g'),
  /\b(?:Bearer|apikey:?)\s+[A-Za-z0-9._-]{16,}/gi,
]

export function redact(text: string): string {
  let out = text
  for (const pattern of REDACTIONS) out = out.replace(pattern, '[REDACTED]')
  return out
}

function firstLine(message: unknown, limit = 200): string {
  const raw = Array.isArray(message) ? String(message[0] ?? '') : String(message ?? '')
  return redact(raw.split('\n')[0] ?? '').slice(0, limit)
}

function relativePosix(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/')
}

export function parseAllowlist(raw: unknown): Allowlist {
  const data = raw as { version?: unknown; entries?: unknown }
  if (!data || data.version !== 1 || !Array.isArray(data.entries)) {
    throw new Error('allowlist must be { "version": 1, "entries": [...] }')
  }
  const seen = new Set<string>()
  for (const entry of data.entries as AllowEntry[]) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.name !== 'string' || !entry.file || !entry.name) {
      throw new Error('allowlist entry needs non-empty "file" and "name"')
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`allowlist entry has no reason: ${entry.file}::${entry.name}`)
    }
    if (entry.platforms !== undefined && (!Array.isArray(entry.platforms) || entry.platforms.length === 0)) {
      throw new Error(`allowlist "platforms" must be a non-empty array: ${entry.file}::${entry.name}`)
    }
    const id = `${entry.file}::${entry.name}`
    if (seen.has(id)) throw new Error(`duplicate allowlist entry: ${id}`)
    seen.add(id)
  }
  return data as Allowlist
}

interface VitestAssertion {
  fullName?: string
  title?: string
  status?: string
  failureMessages?: string[]
}
interface VitestFile {
  name?: string
  status?: string
  message?: string
  assertionResults?: VitestAssertion[]
}
interface VitestReport {
  numPassedTests?: number
  numFailedTests?: number
  numPendingTests?: number
  numTodoTests?: number
  numTotalTests?: number
  numFailedTestSuites?: number
  testResults?: VitestFile[]
}

export function evaluateReport(report: unknown, options: GuardOptions): GuardResult {
  const failures: string[] = []
  const skipped: SkippedTest[] = []
  const data = report as VitestReport
  const counts = { passed: 0, failed: 0, skipped: 0, failedSuites: 0 }

  if (
    !data ||
    !Array.isArray(data.testResults) ||
    typeof data.numPassedTests !== 'number' ||
    typeof data.numFailedTests !== 'number'
  ) {
    return { ok: false, failures: ['malformed vitest report (missing testResults or totals)'], counts, skipped }
  }

  counts.passed = data.numPassedTests
  counts.failed = data.numFailedTests
  counts.failedSuites = data.numFailedTestSuites ?? 0
  if ((data.numTotalTests ?? counts.passed + counts.failed) === 0 || data.testResults.length === 0) {
    failures.push('report contains no tests')
  }
  if (counts.failed > 0) failures.push(`${counts.failed} failed test(s)`)
  if (counts.failedSuites > 0) failures.push(`${counts.failedSuites} failed test suite(s)`)

  for (const file of data.testResults) {
    const rel = relativePosix(options.root, file.name ?? '')
    const assertions = file.assertionResults ?? []
    const failedAssertions = assertions.filter((a) => a.status === 'failed')
    for (const a of failedAssertions) {
      failures.push(`FAILED ${rel}::${a.fullName ?? a.title ?? '?'} -- ${firstLine(a.failureMessages)}`)
    }
    if (file.status === 'failed' && failedAssertions.length === 0) {
      failures.push(`FAILED FILE ${rel} -- ${firstLine(file.message) || 'suite-level failure'}`)
    }
    for (const a of assertions) {
      if (SKIP_STATUSES.has(a.status ?? '')) {
        const name = a.fullName ?? a.title ?? '?'
        skipped.push({ id: `${rel}::${name}`, file: rel, name })
      }
    }
  }
  counts.skipped = skipped.length

  if (options.mode === 'full') {
    const applicable = new Map<string, AllowEntry>()
    for (const entry of options.allowlist.entries) {
      if (entry.platforms === undefined || entry.platforms.includes(options.platform)) {
        applicable.set(`${entry.file}::${entry.name}`, entry)
      }
    }
    const observed = new Set<string>()
    for (const s of skipped) {
      if (applicable.has(s.id)) observed.add(s.id)
      else failures.push(`UNKNOWN SKIP ${s.id}`)
    }
    for (const id of applicable.keys()) {
      if (!observed.has(id)) failures.push(`STALE ALLOWLIST ENTRY (not skipped in this run) ${id}`)
    }
  } else {
    const gateCache = new Map<string, boolean>()
    for (const s of skipped) {
      let gated = gateCache.get(s.file)
      if (gated === undefined) {
        try {
          gated = options.readFile(path.join(options.root, s.file)).includes(STACK_GATE_MARKER)
        } catch {
          gated = false
        }
        gateCache.set(s.file, gated)
      }
      if (!gated) failures.push(`UNKNOWN SKIP (file is not stack-gated) ${s.id}`)
    }
  }

  return { ok: failures.length === 0, failures, counts, skipped }
}

export function renderSummary(result: GuardResult, mode: GuardMode, platform: string): string {
  const lines = [
    `# CI test guard (${mode}, ${platform}, node ${process.versions.node})`,
    '',
    `- passed: ${result.counts.passed}`,
    `- failed: ${result.counts.failed}`,
    `- skipped: ${result.counts.skipped}`,
    `- failed suites: ${result.counts.failedSuites}`,
    `- verdict: ${result.ok ? 'PASS' : 'FAIL'}`,
    '',
  ]
  if (result.failures.length > 0) {
    lines.push('## Failures', ...result.failures.slice(0, 100).map((f) => `- ${redact(f)}`), '')
  }
  if (result.skipped.length > 0) {
    lines.push('## Skipped tests', ...result.skipped.slice(0, 200).map((s) => `- ${redact(s.id)}`), '')
  }
  return lines.join('\n')
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

export function main(argv: string[]): number {
  const reportPath = argValue(argv, '--report')
  const mode = argValue(argv, '--mode') as GuardMode | undefined
  if (!reportPath || (mode !== 'full' && mode !== 'stackless')) {
    console.error('usage: node scripts/ci-skip-guard.ts --report <vitest.json> --mode full|stackless [--allowlist <file>] [--summary-dir <dir>]')
    return 2
  }
  const root = path.resolve(argValue(argv, '--root') ?? process.cwd())
  const allowlistPath = argValue(argv, '--allowlist') ?? path.join(root, '.github', 'ci', 'skip-allowlist.json')
  let report: unknown
  let allowlist: Allowlist
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
    allowlist = mode === 'full' ? parseAllowlist(JSON.parse(readFileSync(allowlistPath, 'utf8'))) : { version: 1, entries: [] }
  } catch (error) {
    console.error(`ci-skip-guard: cannot load inputs: ${redact(error instanceof Error ? error.message : String(error))}`)
    return 2
  }

  const result = evaluateReport(report, {
    mode,
    allowlist,
    platform: process.platform,
    root,
    readFile: (p) => readFileSync(p, 'utf8'),
  })
  const summary = renderSummary(result, mode, process.platform)
  console.log(summary)

  const summaryDir = argValue(argv, '--summary-dir')
  if (summaryDir) {
    mkdirSync(summaryDir, { recursive: true })
    writeFileSync(path.join(summaryDir, `summary-${mode}.md`), summary)
    writeFileSync(
      path.join(summaryDir, `summary-${mode}.json`),
      JSON.stringify({ ok: result.ok, counts: result.counts, failures: result.failures.map(redact), skipped: result.skipped.map((s) => s.id) }, null, 2),
    )
  }
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
