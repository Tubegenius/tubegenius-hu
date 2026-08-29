#!/usr/bin/env node
// PFM Supervised Production Candidate Intake v0 -- service-only operator
// CLI. Explicit, manual command-line invocation ONLY: this file is never
// imported by any Next.js route, page, or component, is never part of the
// client bundle (Next.js only bundles what app/ actually imports, and
// nothing under app/ imports anything in scripts/), and does not install a
// cron, worker, or HTTP endpoint of its own. Running it is the only way it
// ever runs.
//
// Usage (from the repo root):
//   node scripts/supervised-intake-runner.ts --input path/to/batch.json [--dry-run] [--claim-state path/to/state.json]
//
// Required environment (read from the REAL process environment only -- this
// file never reads or loads .env, .env.local, or any other dotenv-style
// file; the operator's shell must already export these before invoking the
// CLI):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED=true   (passed straight through to
//     the existing human-review-flag.ts reader -- this CLI never sets,
//     overrides, or inspects it beyond what runShadowExtraction() already
//     does on its own)
//
// BOOTSTRAP NOTE: this file's own top-level body must stay import-minimal
// (node: builtins only) and defer every real-application import to a
// dynamic import() AFTER module.register() below. ESM resolves a module's
// own static imports before running its body -- registering the custom
// resolution hook (scripts/ts-alias-loader.mjs) from inside this same
// file's top-level `import` statements would be too late to affect them.
import { register } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Node-version preflight (section 9): this CLI relies on this Node
// version's native TypeScript support to even parse this file at all, so a
// version old enough to lack it entirely (pre-22.6) fails at Node's own
// module-load stage before a single line here ever runs -- already fail-
// closed (zero DB writes, zero provider calls), just with Node's own
// generic error instead of ours. What THIS check catches is the narrower,
// silent-risk range: a Node new enough to parse the file (TS stripping
// available, possibly only experimental/inconsistent) but older than the
// version this CLI is actually validated against. Checked as the very
// first executable statement, before register() and before any real-
// application import, so an unsupported version never reaches the DB/
// provider boundary either.
const MINIMUM_NODE_MAJOR_VERSION = 24
{
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR_VERSION) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      message: `unsupported Node.js version -- this CLI requires Node.js >= ${MINIMUM_NODE_MAJOR_VERSION} for its native TypeScript support`,
      fields: { detectedNodeVersion: process.versions.node, requiredMajor: MINIMUM_NODE_MAJOR_VERSION },
    }))
    process.exit(2)
  }
}

register('./ts-alias-loader.mjs', import.meta.url)

const EXIT_CODE = {
  COMPLETED: 0,
  VALIDATION_OR_CONFIG_ERROR: 2,
  BATCH_STOPPED: 3,
  RECONCILIATION_REQUIRED: 4,
  UNEXPECTED_INTERNAL_ERROR: 5,
} as const

interface Cli {
  inputPath: string | null
  dryRun: boolean
  claimStatePath: string
  help: boolean
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    inputPath: null,
    dryRun: false,
    claimStatePath: path.join(process.cwd(), '.supervised-intake', 'claim-state.json'),
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') cli.help = true
    else if (arg === '--dry-run') cli.dryRun = true
    else if (arg === '--input') cli.inputPath = argv[++i] ?? null
    else if (arg === '--claim-state') cli.claimStatePath = argv[++i] ?? cli.claimStatePath
  }
  return cli
}

function printHelp() {
  console.log(`Supervised Production Candidate Intake v0 -- service-only runner

Usage:
  node scripts/supervised-intake-runner.ts --input <batch.json> [--dry-run] [--claim-state <path>]

Options:
  --input <path>         Path to a JSON batch input file (required).
  --dry-run               Validate + report only. Creates no batch, claims
                           nothing, never calls a provider, never writes.
  --claim-state <path>    Override the local claim-state file location
                           (default: .supervised-intake/claim-state.json).
  --help                  Show this message.

Required environment (must already be exported in the shell -- this CLI
never reads .env/.env.local itself):
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
`)
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.help || !cli.inputPath) {
    printHelp()
    return cli.help ? EXIT_CODE.COMPLETED : EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  // Every real-application import happens here, AFTER register() above.
  const { parseSupervisedIntakeBatchInputJson } = await import('../lib/semantic-topic/supervised-intake-types')
  const {
    createConsoleLogger,
    createFileClaimStateStore,
    runDryRun,
    runSupervisedIntake,
  } = await import('../lib/semantic-topic/supervised-intake-runner')
  const { runShadowExtraction } = await import('../lib/semantic-topic/extraction-service')
  const { createAdminClient } = await import('../lib/supabase-server')

  const logger = createConsoleLogger()

  let raw: string
  try {
    raw = await readFile(cli.inputPath, 'utf8')
  } catch (err) {
    logger.log({ level: 'error', message: 'could not read input file', fields: { path: cli.inputPath, error: err instanceof Error ? err.message : String(err) } })
    return EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  const parsed = parseSupervisedIntakeBatchInputJson(raw)
  if (!parsed.ok) {
    logger.log({ level: 'error', message: 'batch input validation failed', fields: { errors: parsed.errors } })
    return EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  // Checked explicitly, BEFORE constructing the admin client: createAdminClient()
  // (lib/supabase-server.ts, shared across the whole app) throws immediately
  // on an empty/missing URL, which would otherwise surface as the generic
  // UNEXPECTED_INTERNAL_ERROR (5) catch-all at the bottom of this file --
  // correct in the sense of never proceeding, but not the documented,
  // secret-free VALIDATION_OR_CONFIG_ERROR (2) this exact, foreseeable
  // operator misconfiguration should produce.
  const missingEnvVars = (['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const)
    .filter((name) => typeof process.env[name] !== 'string' || process.env[name]!.length === 0)
  if (missingEnvVars.length > 0) {
    logger.log({ level: 'error', message: 'required environment variable(s) not set', fields: { missing: missingEnvVars } })
    return EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  const client = createAdminClient()

  if (cli.dryRun) {
    const { result } = await runDryRun({ client, logger }, parsed.value)
    return result.exitCode
  }

  const claimStateStore = await createFileClaimStateStore(cli.claimStatePath)

  const controller = new AbortController()
  let signalCount = 0
  const onSignal = (signal: string) => {
    signalCount += 1
    logger.log({ level: 'warn', message: `received ${signal} -- finishing the item in flight, then stopping before claiming a new one`, fields: { signalCount } })
    controller.abort()
    if (signalCount >= 2) {
      logger.log({ level: 'error', message: 'second interrupt received -- exiting immediately without further DB cleanup', fields: {} })
      process.exit(EXIT_CODE.UNEXPECTED_INTERNAL_ERROR)
    }
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  const result = await runSupervisedIntake(
    { client, runShadowExtraction, claimStateStore, logger },
    parsed.value,
    controller.signal,
  )
  logger.log({ level: 'info', message: 'runner finished', fields: { exitCode: result.exitCode, summary: result.summary } })
  return result.exitCode
}

// A minimal, self-contained UUID-shortener duplicated here on purpose (see
// lib/semantic-topic/operator-cli-security.ts's own header comment): this
// catch-all must still redact even if main() threw before ever reaching its
// dynamic import of createConsoleLogger()/redactForDisplay (e.g. a module-
// resolution failure), so it cannot depend on that import having succeeded.
// Deliberately not imported from operator-cli-security.ts for the same
// reason -- matches scripts/execute-approved-review.ts and
// scripts/post-completion-review-recovery.ts's own identical fallback.
function shortenUuidsFallback(text: string): string {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `${m.slice(0, 8)}…`)
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((err) => {
    const rawMessage = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: 'unexpected internal error', error: shortenUuidsFallback(rawMessage) }))
    process.exitCode = EXIT_CODE.UNEXPECTED_INTERNAL_ERROR
  })
