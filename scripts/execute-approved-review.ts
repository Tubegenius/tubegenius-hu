#!/usr/bin/env node
// PFM Approved Human Review Executor v0 -- service-only operator CLI.
// Explicit, manual command-line invocation ONLY -- never imported by any
// Next.js route, page, or component, never part of the client bundle,
// installs no cron/worker/HTTP endpoint of its own.
//
// This CLI does not decide anything a human reviewer hasn't already
// decided. It executes an ALREADY-approved topic_assignment_review_requests
// row via the existing, unchanged execute_approved_topic_assignment_review
// RPC (078) -- the RPC re-reads and re-verifies the reviewer's stored
// canonical_topic_label/topic_definition/scope/inclusion_criteria/
// exclusion_criteria/approval_digest itself; this CLI supplies only a
// review_request_id and can inject no judgment data of its own. It never
// calls Anthropic, never touches supervised_intake_*, and never creates a
// second topic_assignment_decisions row for the same extraction_run_id (the
// RPC's own pre-check blocks that).
//
// Usage (from the repo root):
//   node scripts/execute-approved-review.ts --review-request-id <uuid> --confirm-production <project-ref> [--dry-run]
//
// Required environment (read from the REAL process environment only -- this
// file never reads or loads .env, .env.local, or any other dotenv-style
// file; the operator's shell must already export these before invoking the
// CLI):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED=true   (checked HERE, explicitly,
//     before any DB call, matching post-completion-review-recovery.ts's own
//     fail-closed convention for every operator CLI in this feature area)
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

interface Cli {
  reviewRequestId: string | null
  confirmProduction: string | null
  dryRun: boolean
  help: boolean
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { reviewRequestId: null, confirmProduction: null, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') cli.help = true
    else if (arg === '--dry-run') cli.dryRun = true
    else if (arg === '--review-request-id') cli.reviewRequestId = argv[++i] ?? null
    else if (arg === '--confirm-production') cli.confirmProduction = argv[++i] ?? null
  }
  return cli
}

function printHelp() {
  console.log(`PFM Approved Human Review Executor v0

Usage:
  node scripts/execute-approved-review.ts --review-request-id <uuid> --confirm-production <project-ref> [--dry-run]

Options:
  --review-request-id <uuid>   The already-approved review request to execute (required).
  --confirm-production <ref>   Must exactly match the Supabase project ref the service client actually targets (required).
  --dry-run                    Read-only preview. Never calls the execute RPC.
  --help                       Show this message.

Required environment (must already be exported in the shell -- this CLI
never reads .env/.env.local itself):
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED=true

This CLI cannot approve, reject, or otherwise decide a review request -- it
only executes one a human reviewer has already approved, and injects no
label/summary/criteria/reviewer-identity/approval-proof of its own.
`)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.help) {
    printHelp()
    return 0
  }
  if (!cli.reviewRequestId || !cli.confirmProduction) {
    printHelp()
    return 2
  }
  if (!UUID_PATTERN.test(cli.reviewRequestId)) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: 'invalid --review-request-id (not a UUID)' }))
    return 2
  }

  // Every real-application import happens here, AFTER register() above.
  const { resolveProjectIdentity, projectGuardPasses, redactForDisplay } = await import('../lib/semantic-topic/operator-cli-security')
  const { runExecuteApprovedReview, exitCodeForExecutorOutcome, EXECUTOR_EXIT_CODE } = await import(
    '../lib/semantic-topic/execute-approved-review-cli-support'
  )
  const { isHumanReviewEnabled } = await import('../lib/semantic-topic/human-review-flag')

  // The ONE presenter this CLI ever uses to print anything. `fields` is
  // ALWAYS routed through redactForDisplay() here -- no call site below is
  // permitted to print a field object directly, matching
  // post-completion-review-recovery.ts's own single-presenter contract
  // (see tests/execute-approved-review-source-policy.test.ts for the static
  // proof this remains true here too).
  const log = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => {
    const safeFields = fields ? (redactForDisplay(fields) as Record<string, unknown>) : undefined
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...safeFields })
    if (level === 'error') console.error(line)
    else console.log(line)
  }

  const missingEnvVars = (['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const)
    .filter((name) => typeof process.env[name] !== 'string' || process.env[name]!.length === 0)
  if (missingEnvVars.length > 0) {
    log('error', 'required environment variable(s) not set', { missing: missingEnvVars })
    return EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  if (!isHumanReviewEnabled()) {
    log('error', 'SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED is not exactly "true" in this process -- refusing to proceed before any DB call')
    return EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  // Project-identity guard, checked BEFORE any DB call. A localhost/
  // 127.0.0.1 target can never satisfy this guard no matter what string
  // --confirm-production carries.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const identity = resolveProjectIdentity(supabaseUrl)
  if (!projectGuardPasses(identity, cli.confirmProduction)) {
    log('error', '--confirm-production does not match the project the service client actually targets -- refusing to proceed', {
      identityKind: identity.kind,
      projectRef: identity.kind === 'remote' ? identity.projectRef : undefined,
    })
    return EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  const { createAdminClient } = await import('../lib/supabase-server')
  const client = createAdminClient()

  log('info', 'preflight', {
    reviewRequestIdPrefix: cli.reviewRequestId.slice(0, 8),
    projectRef: identity.kind === 'remote' ? identity.projectRef : undefined,
    envVarsPresent: { NEXT_PUBLIC_SUPABASE_URL: true, SUPABASE_SERVICE_ROLE_KEY: true },
    humanReviewFlag: true,
    dryRun: cli.dryRun,
  })

  const outcome = await runExecuteApprovedReview(client, { reviewRequestId: cli.reviewRequestId, dryRun: cli.dryRun })
  log(outcome.kind === 'database_error' ? 'error' : 'info', 'executor outcome', { outcome })
  return exitCodeForExecutorOutcome(outcome)
}

// A minimal, self-contained UUID-shortener duplicated here on purpose: this
// catch-all must still redact even if main() threw before ever reaching its
// dynamic import of redactForDisplay() (e.g. a module-resolution failure),
// so it cannot depend on that import having succeeded. Deliberately not
// imported from operator-cli-security.ts for the same reason.
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
    process.exitCode = 5
  })
