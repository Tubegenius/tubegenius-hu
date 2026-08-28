#!/usr/bin/env node
// PFM Post-Completion Review Handoff Recovery v0 -- service-only operator
// CLI. Explicit, manual command-line invocation ONLY -- never imported by
// any Next.js route, page, or component, never part of the client bundle,
// installs no cron/worker/HTTP endpoint of its own.
//
// This CLI is NOT an extraction retry tool and NOT a provider caller. It
// creates (or idempotently replays) exactly one topic_assignment_review_requests
// row for an ALREADY-completed topic_extraction_runs row, via the existing,
// unchanged create_topic_assignment_review_request RPC (078). It never
// touches signal_evidence, never creates a supervised_intake_* row, never
// calls Anthropic, and never writes a semantic_topics/topic_assignment_decisions
// row.
//
// Usage (from the repo root):
//   node scripts/post-completion-review-recovery.ts --extraction-run-id <uuid> --confirm-production <project-ref> [--dry-run]
//
// Required environment (read from the REAL process environment only -- this
// file never reads or loads .env, .env.local, or any other dotenv-style
// file; the operator's shell must already export these before invoking the
// CLI):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED=true   (checked HERE, explicitly,
//     before any DB call -- this CLI's whole reason to exist is to recover
//     from a run where this flag was NOT set at extraction time; running the
//     recovery itself with the flag unset would be a contradiction, so it is
//     required, not merely read-through)
import { register } from 'node:module'

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
  OK: 0,
  VALIDATION_OR_CONFIG_ERROR: 2,
  INELIGIBLE: 3,
  BLOCKED: 4,
  UNEXPECTED_ERROR: 5,
} as const

interface Cli {
  extractionRunId: string | null
  confirmProduction: string | null
  dryRun: boolean
  help: boolean
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { extractionRunId: null, confirmProduction: null, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') cli.help = true
    else if (arg === '--dry-run') cli.dryRun = true
    else if (arg === '--extraction-run-id') cli.extractionRunId = argv[++i] ?? null
    else if (arg === '--confirm-production') cli.confirmProduction = argv[++i] ?? null
  }
  return cli
}

function printHelp() {
  console.log(`PFM Post-Completion Review Handoff Recovery v0

Usage:
  node scripts/post-completion-review-recovery.ts --extraction-run-id <uuid> --confirm-production <project-ref> [--dry-run]

Options:
  --extraction-run-id <uuid>   The completed topic_extraction_runs row to recover a review request for (required).
  --confirm-production <ref>   Must exactly match the Supabase project ref the service client actually targets (required).
  --dry-run                    Read-only preview. Never calls the create-review-request RPC.
  --help                       Show this message.

Required environment (must already be exported in the shell -- this CLI
never reads .env/.env.local itself):
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED=true

This CLI is not an extraction retry tool and never calls a provider.
`)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.help) {
    printHelp()
    return EXIT_CODE.OK
  }
  if (!cli.extractionRunId || !cli.confirmProduction) {
    printHelp()
    return EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }
  if (!UUID_PATTERN.test(cli.extractionRunId)) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: 'invalid --extraction-run-id (not a UUID)' }))
    return EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  // Every real-application import happens here, AFTER register() above.
  const { resolveProjectIdentity, projectGuardPasses, runPostCompletionReviewRecovery, exitCodeForOutcome } =
    await import('../lib/semantic-topic/post-completion-review-recovery')
  const { isHumanReviewEnabled } = await import('../lib/semantic-topic/human-review-flag')

  const log = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields })
    if (level === 'error') console.error(line)
    else console.log(line)
  }

  const missingEnvVars = (['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const)
    .filter((name) => typeof process.env[name] !== 'string' || process.env[name]!.length === 0)
  if (missingEnvVars.length > 0) {
    log('error', 'required environment variable(s) not set', { missing: missingEnvVars })
    return EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  if (!isHumanReviewEnabled()) {
    log('error', 'SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED is not exactly "true" in this process -- refusing to proceed before any DB call')
    return EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  // Section E: project-identity guard, checked BEFORE any DB call. A
  // localhost/127.0.0.1 target can never satisfy this guard no matter what
  // string --confirm-production carries.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const identity = resolveProjectIdentity(supabaseUrl)
  if (!projectGuardPasses(identity, cli.confirmProduction)) {
    log('error', '--confirm-production does not match the project the service client actually targets -- refusing to proceed', {
      identityKind: identity.kind,
      // The project ref itself is not a secret (it is the public subdomain
      // of a Supabase URL), but is still never echoed for an 'unrecognized'
      // host, which could otherwise leak an unexpected internal hostname.
      projectRef: identity.kind === 'remote' ? identity.projectRef : undefined,
    })
    return EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  const { createAdminClient } = await import('../lib/supabase-server')
  const client = createAdminClient()

  log('info', 'preflight', {
    extractionRunIdPrefix: cli.extractionRunId.slice(0, 8),
    projectRef: identity.kind === 'remote' ? identity.projectRef : undefined,
    envVarsPresent: { NEXT_PUBLIC_SUPABASE_URL: true, SUPABASE_SERVICE_ROLE_KEY: true },
    humanReviewFlag: true,
    dryRun: cli.dryRun,
  })

  const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: cli.extractionRunId, dryRun: cli.dryRun })
  log(outcome.kind === 'database_error' ? 'error' : 'info', 'recovery outcome', { outcome })
  return exitCodeForOutcome(outcome)
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: 'unexpected internal error', error: err instanceof Error ? err.message : String(err) }))
    process.exitCode = EXIT_CODE.UNEXPECTED_ERROR
  })
