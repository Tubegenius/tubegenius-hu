#!/usr/bin/env node
// PFM Lifecycle Operator CLI v1 -- service-only operator CLI: executes an
// already-approved semantic-topic lifecycle review request.
// Explicit, manual command-line invocation ONLY -- never imported by any
// Next.js route, page, or component, never part of the client bundle,
// installs no cron/worker/HTTP endpoint of its own, and never calls
// YouTube/Serper/Anthropic.
//
// Executes via the existing, unchanged, already-production
// execute_approved_semantic_topic_lifecycle_transition RPC (087) -- never a
// direct table write.
//
// Usage:
//   node scripts/execute-approved-lifecycle-transition.ts --review-request-id <uuid> [--dry-run | --apply --confirm-production-project-ref <ref>]
//
// Required environment (read from the REAL process environment only -- this
// file never reads or loads .env, .env.local, or any other dotenv-style
// file; the operator's shell must already export these before invoking the
// CLI):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
import { register } from 'node:module'
import { createInterface } from 'node:readline/promises'

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

type ExecutorFlag = '--dry-run' | '--apply' | '--review-request-id' | '--confirm-production-project-ref'

const EXECUTOR_FLAG_SCHEMA: Record<ExecutorFlag, 'boolean' | 'value'> = {
  '--dry-run': 'boolean',
  '--apply': 'boolean',
  '--review-request-id': 'value',
  '--confirm-production-project-ref': 'value',
}

interface Cli {
  reviewRequestId: string | null
  apply: boolean
  confirmProductionProjectRef: string | null
}

function printHelp() {
  console.log(`PFM Lifecycle Operator CLI v1 -- approved transition executor

Usage:
  node scripts/execute-approved-lifecycle-transition.ts --review-request-id <uuid> [--dry-run | --apply --confirm-production-project-ref <ref>]

Default mode is --dry-run (read-only preview, never calls the execute RPC, never writes).
--apply requires --confirm-production-project-ref AND a typed interactive "YES" confirmation.

The idempotency key is derived deterministically from --review-request-id
and the request's own stored decision digest -- there is no free-form
idempotency-key flag. A repeated operator attempt against the same approved
decision always replays cleanly instead of executing twice.

Never reads .env/.env.local -- export NEXT_PUBLIC_SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY in the shell before invoking this CLI.

This CLI cannot decide anything the execute RPC does not itself re-verify --
the dry-run preview (executability, live-vs-snapshot staleness signal) is
advisory only; the RPC's own fixed-priority staleness chain is the sole
authority at execution time. This CLI never creates a new review request
and never retries automatically. It never prints a full UUID, idempotency
key, or credential -- only short, redacted previews.
`)
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2)

  // --help/-h always wins, regardless of anything else on the command
  // line -- checked BEFORE strict argument validation, matching this
  // CLI's established behavior.
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp()
    return 0
  }

  // Every real-application import happens here, AFTER register() above.
  const { redactForDisplay, resolveProjectIdentity, projectGuardPasses } = await import('../lib/semantic-topic/operator-cli-security')
  const support = await import('../lib/semantic-topic/execute-approved-lifecycle-transition-cli-support')
  const { parseStrictArgs } = await import('../lib/semantic-topic/strict-cli-args')

  const log = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => {
    const safeFields = fields ? (redactForDisplay(fields) as Record<string, unknown>) : undefined
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...safeFields })
    if (level === 'error') console.error(line)
    else console.log(line)
  }

  // Strict argument validation -- BEFORE any environment read, Supabase
  // client construction, project guard, interactive prompt, or DB call.
  const parsed = parseStrictArgs<ExecutorFlag>(rawArgs, EXECUTOR_FLAG_SCHEMA)
  if (!parsed.ok) {
    log('error', 'invalid command-line arguments', { reasonCode: parsed.reason })
    return support.LIFECYCLE_EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }
  if (parsed.booleans.has('--dry-run') && parsed.booleans.has('--apply')) {
    log('error', '--dry-run and --apply cannot both be given', { reasonCode: 'INVALID_ARGUMENTS' })
    return support.LIFECYCLE_EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }
  const cli: Cli = {
    reviewRequestId: parsed.values['--review-request-id'] ?? null,
    apply: parsed.booleans.has('--apply'),
    confirmProductionProjectRef: parsed.values['--confirm-production-project-ref'] ?? null,
  }

  if (!support.isValidReviewRequestId(cli.reviewRequestId)) {
    log('error', '--review-request-id is required and must be a valid UUID')
    return support.LIFECYCLE_EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  const missingEnvVars = (['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const)
    .filter((name) => typeof process.env[name] !== 'string' || process.env[name]!.length === 0)
  if (missingEnvVars.length > 0) {
    log('error', 'required environment variable(s) not set', { missing: missingEnvVars })
    return support.LIFECYCLE_EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const identity = resolveProjectIdentity(supabaseUrl)

  if (cli.apply) {
    if (!cli.confirmProductionProjectRef || !projectGuardPasses(identity, cli.confirmProductionProjectRef)) {
      log('error', '--apply requires --confirm-production-project-ref to exactly match the project the service client actually targets', {
        identityKind: identity.kind,
      })
      return support.LIFECYCLE_EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    }
    log('info', 'production apply guard passed', { projectIdentityConfirmed: true, environmentKind: identity.kind })
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let typed: string
    try {
      typed = await rl.question('About to APPLY against the confirmed production project. Type YES to continue: ')
    } finally {
      rl.close()
    }
    if (typed.trim() !== 'YES') {
      log('error', 'interactive confirmation was not exactly "YES" -- aborting, nothing was written')
      return support.LIFECYCLE_EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    }
  }

  const { createAdminClient } = await import('../lib/supabase-server')
  const client = createAdminClient()

  const outcome = await support.runExecuteApprovedLifecycleTransition(client, {
    reviewRequestId: cli.reviewRequestId,
    dryRun: !cli.apply,
  })
  log(outcome.kind === 'database_error' ? 'error' : 'info', 'executor outcome', { outcome })
  return support.exitCodeForLifecycleExecutionOutcome(outcome)
}

// A minimal, self-contained UUID-shortener duplicated here on purpose: this
// catch-all must still redact even if main() threw before ever reaching its
// dynamic import of redactForDisplay() (e.g. a module-resolution failure),
// so it cannot depend on that import having succeeded.
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
