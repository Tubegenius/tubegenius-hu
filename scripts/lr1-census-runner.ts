#!/usr/bin/env node
// LR-1 census runner CLI -- operator tooling, explicit manual invocation ONLY.
// Never imported by any route, page or component. It sends exactly two kinds of
// SQL to a database: the one approved census file (hash-pinned, sent to psql on
// STDIN from the very bytes that were hashed) and the fixed system-identifier
// probe, both over psql.
//
// THIS FILE HAS NEVER BEEN RUN against any database. Running it against staging
// or production needs a separate, explicit, phase-by-phase approval.
//
// Usage:
//   node scripts/lr1-census-runner.ts --approval <approval.json> --phase staging_dryrun|production [--execute]
//
// Without --execute only the gates run (approval record, SQL hash, target and
// role fingerprints): no connection is opened, no psql process is started and
// the approval is not consumed.
//
// The connection target (project ref, host, port, database) and the executing
// role are NEVER read from a flag, the shell environment or a file: they are
// typed into hidden prompts, bound to the approval by fingerprints, and handed
// to the psql child process only through that child's private environment. The
// password is typed into psql's own prompt (-W); this CLI never sees it and
// never sets PGPASSWORD.
//
// The single use of an approval is decided by the atomic EXCLUSIVE CREATION of
// "<approval.json>.claim" (see lib/lr1-census/approval-claim.ts); the approval
// JSON itself is never rewritten.
import { register } from 'node:module'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Writable } from 'node:stream'

const MINIMUM_NODE_MAJOR_VERSION = 24
{
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR_VERSION) {
    console.error(`unsupported Node.js version -- this CLI requires Node.js >= ${MINIMUM_NODE_MAJOR_VERSION}`)
    process.exit(2)
  }
}

register('./ts-alias-loader.mjs', import.meta.url)

const FLAG_SCHEMA: Record<string, 'boolean' | 'value'> = {
  '--approval': 'value',
  '--phase': 'value',
  '--execute': 'boolean',
  '--help': 'boolean',
}

function printHelp() {
  console.log(`LR-1 census runner

Usage:
  node scripts/lr1-census-runner.ts --approval <approval.json> --phase staging_dryrun|production [--execute]

Default is gate-only: approval record, SQL hash, target and role fingerprints
are checked; nothing connects and the approval is not consumed.
--execute additionally asks for a typed confirmation, consumes the approval
(exclusive claim file) BEFORE connecting, runs the second factor and then the
census (the verified bytes are sent to psql on stdin).

Connection details and the role are typed into hidden prompts; there are no
host, port, database, role or password flags and the shell environment is not
read for them. Exit codes: 0 ok, 1 aborted or failed, 2 bad arguments,
3 a mismatch could not be burned (revoke the approval manually).
`)
}

function parseArgs(argv: string[]): { approval: string | null; phase: string | null; execute: boolean; help: boolean } | null {
  const out = { approval: null as string | null, phase: null as string | null, execute: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const kind = FLAG_SCHEMA[flag]
    if (!kind) return null
    if (kind === 'boolean') {
      if (flag === '--execute') out.execute = true
      if (flag === '--help') out.help = true
    } else {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return null
      if (flag === '--approval') out.approval = value
      if (flag === '--phase') out.phase = value
      i += 1
    }
  }
  return out
}

function promptHiddenLine(question: string): Promise<string> {
  return new Promise((resolveLine) => {
    const muted = new Writable({ write: (_chunk, _encoding, callback) => callback() })
    process.stderr.write(question)
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true })
    rl.question('', (answer) => {
      rl.close()
      process.stderr.write('\n')
      resolveLine(answer)
    })
  })
}

function promptVisibleLine(question: string): Promise<string> {
  return new Promise((resolveLine) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    rl.question(question, (answer) => {
      rl.close()
      resolveLine(answer)
    })
  })
}

const FIELD_QUESTION = {
  project_ref: 'project ref (hidden): ',
  host: 'host (hidden): ',
  port: 'port (hidden, empty = 5432): ',
  database: 'database (hidden): ',
  role: 'role (hidden): ',
} as const

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error('invalid arguments (see --help)')
    process.exit(2)
  }
  if (args.help) {
    printHelp()
    return
  }
  if (!args.approval || (args.phase !== 'staging_dryrun' && args.phase !== 'production')) {
    console.error('--approval and --phase (staging_dryrun|production) are required')
    process.exit(2)
  }
  const core = await import('../lib/lr1-census/runner-core')
  const claims = await import('../lib/lr1-census/approval-claim')
  const psql = await import('../lib/lr1-census/psql-process')
  const approvalPath = resolve(args.approval)
  const claimPath = claims.claimPathFor(approvalPath)
  const sqlPath = resolve(process.cwd(), core.CENSUS_SQL_RELATIVE_PATH)

  const evidence = await core.runCensus(
    {
      now: () => new Date(),
      // read exactly once by the core; the same bytes are hashed and then sent to psql on stdin
      readSqlBytes: () => readFileSync(sqlPath),
      readApproval: () => JSON.parse(readFileSync(approvalPath, 'utf8')) as unknown,
      readClaim: () => claims.readClaimFile(claimPath),
      claim: (state, info) => claims.claimExclusive(claimPath, state, info),
      promptHidden: (field) => promptHiddenLine(FIELD_QUESTION[field]),
      confirmExecute: async (label, prefix) => {
        const expected = `RUN ${label} ${prefix}`
        const typed = await promptVisibleLine(`type exactly "${expected}" to run: `)
        return typed.trim() === expected
      },
      probeSecondFactor: async (target, role) => {
        const run = await psql.runProbePsql(target, role, core.SYSTEM_IDENTIFIER_PROBE_SQL, { timeoutMs: 30_000 })
        const value = run.stdout.trim()
        return run.exitCode === 0 && /^[0-9a-f]{64}$/.test(value) ? { ok: true, value } : { ok: false }
      },
      runPsql: (target, role, sqlBytes) => psql.runCensusPsql(target, role, sqlBytes, { timeoutMs: 90_000 }),
      emit: (line) => console.log(line),
    },
    { phase: args.phase, execute: args.execute },
  )
  if (evidence.code === 'burn_failed') process.exit(3)
  process.exit(evidence.status === 'ok' || evidence.status === 'gate_passed_no_run' ? 0 : 1)
}

void main()
