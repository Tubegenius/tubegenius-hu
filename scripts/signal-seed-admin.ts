#!/usr/bin/env node
// PFM Collector Seed Admin v0 -- service-only operator CLI.
// Explicit, manual command-line invocation ONLY -- never imported by any
// Next.js route, page, or component, never part of the client bundle,
// installs no cron/worker/HTTP endpoint of its own, and never calls
// YouTube/Serper/Anthropic or triggers the collector itself.
//
// Registers or deactivates rows in signal_seed_queue through the audited,
// idempotent register_signal_seed / deactivate_signal_seed RPCs (083) --
// never a direct table write. The seed fingerprint is ALWAYS computed via
// the real computeFingerprint() (lib/emerging-signal/fingerprint.ts),
// never re-implemented or hand-typed here.
//
// Usage:
//   node scripts/signal-seed-admin.ts register --manifest <path> --operator-reference <ref> [--dry-run | --apply --confirm-production-project-ref <ref>]
//   node scripts/signal-seed-admin.ts deactivate --target-fingerprint <hex64> --reason-code <code> --operator-reference <ref> [--dry-run | --apply --confirm-production-project-ref <ref>]
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

interface Cli {
  command: 'register' | 'deactivate' | null
  manifestPath: string | null
  targetFingerprint: string | null
  reasonCode: string | null
  operatorReference: string | null
  apply: boolean
  confirmProductionProjectRef: string | null
  help: boolean
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    command: null, manifestPath: null, targetFingerprint: null, reasonCode: null,
    operatorReference: null, apply: false, confirmProductionProjectRef: null, help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === 'register' || arg === 'deactivate') { if (!cli.command) cli.command = arg }
    else if (arg === '--help' || arg === '-h') cli.help = true
    else if (arg === '--dry-run') cli.apply = false
    else if (arg === '--apply') cli.apply = true
    else if (arg === '--manifest') cli.manifestPath = argv[++i] ?? null
    else if (arg === '--target-fingerprint') cli.targetFingerprint = argv[++i] ?? null
    else if (arg === '--reason-code') cli.reasonCode = argv[++i] ?? null
    else if (arg === '--operator-reference') cli.operatorReference = argv[++i] ?? null
    else if (arg === '--confirm-production-project-ref') cli.confirmProductionProjectRef = argv[++i] ?? null
  }
  return cli
}

function printHelp() {
  console.log(`PFM Collector Seed Admin v0

Usage:
  node scripts/signal-seed-admin.ts register --manifest <path> --operator-reference <ref> [--dry-run | --apply --confirm-production-project-ref <ref>]
  node scripts/signal-seed-admin.ts deactivate --target-fingerprint <hex64> --reason-code <code> --operator-reference <ref> [--dry-run | --apply --confirm-production-project-ref <ref>]

Default mode is --dry-run (read-only preview, never calls an RPC, never writes).
--apply requires --confirm-production-project-ref AND a typed interactive "YES" confirmation.

Never reads .env/.env.local -- export NEXT_PUBLIC_SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY in the shell before invoking this CLI.

This CLI never prints a full fingerprint, UUID, project ref, or credential --
only short, redacted previews.
`)
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.help || !cli.command) {
    printHelp()
    return cli.help ? 0 : 2
  }

  // Every real-application import happens here, AFTER register() above.
  const { redactForDisplay, resolveProjectIdentity, projectGuardPasses } = await import('../lib/semantic-topic/operator-cli-security')
  const support = await import('../lib/emerging-signal/seed-admin-cli-support')

  const log = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => {
    const safeFields = fields ? (redactForDisplay(fields) as Record<string, unknown>) : undefined
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...safeFields })
    if (level === 'error') console.error(line)
    else console.log(line)
  }

  if (!cli.operatorReference) {
    log('error', '--operator-reference is required')
    return support.SEED_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  const missingEnvVars = (['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const)
    .filter((name) => typeof process.env[name] !== 'string' || process.env[name]!.length === 0)
  if (missingEnvVars.length > 0) {
    log('error', 'required environment variable(s) not set', { missing: missingEnvVars })
    return support.SEED_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const identity = resolveProjectIdentity(supabaseUrl)

  if (cli.apply) {
    if (!cli.confirmProductionProjectRef || !projectGuardPasses(identity, cli.confirmProductionProjectRef)) {
      log('error', '--apply requires --confirm-production-project-ref to exactly match the project the service client actually targets', {
        identityKind: identity.kind,
      })
      return support.SEED_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let typed: string
    try {
      typed = await rl.question(`About to APPLY against project ref ${cli.confirmProductionProjectRef}. Type YES to continue: `)
    } finally {
      rl.close()
    }
    if (typed.trim() !== 'YES') {
      log('error', 'interactive confirmation was not exactly "YES" -- aborting, nothing was written')
      return support.SEED_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    }
  }

  const { createAdminClient } = await import('../lib/supabase-server')
  const client = createAdminClient()

  if (cli.command === 'register') {
    if (!cli.manifestPath) {
      log('error', '--manifest is required for register')
      return support.SEED_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    }
    const loaded = support.loadManifestFromPath(cli.manifestPath)
    if (!loaded.ok) {
      log('error', 'manifest load failed', { message: loaded.message })
      return support.SEED_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
    }

    let exitCode: number = support.SEED_ADMIN_EXIT_CODE.COMPLETED
    for (const entry of loaded.manifest.seeds) {
      const prepared = support.prepareSeed(entry)
      if (!prepared.ok) {
        log('error', 'fingerprint computation failed', { seedId: entry.id, message: prepared.message })
        exitCode = support.SEED_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
        continue
      }
      const idempotencyKey = support.deriveRegisterIdempotencyKey(loaded.manifest.manifestVersion, entry.id)
      const preview = {
        seedId: entry.id, category: entry.category, region: entry.region, language: entry.language,
        fingerprintPrefix: prepared.seed.fingerprint.slice(0, 8), idempotencyKeyPrefix: idempotencyKey.slice(0, 24),
      }
      if (!cli.apply) {
        log('info', 'dry-run preview -- register', preview)
        continue
      }
      const outcome = await support.callRegisterSignalSeed(client, {
        seed: prepared.seed, operatorReference: cli.operatorReference, idempotencyKey,
      })
      if (outcome.kind === 'created' || outcome.kind === 'already_exists') {
        log('info', 'register outcome', { seedId: entry.id, outcome: outcome.kind })
      } else {
        log('error', 'register outcome', { seedId: entry.id, outcome: outcome.kind, message: outcome.errorMessage })
        exitCode = outcome.kind === 'rejected' ? support.SEED_ADMIN_EXIT_CODE.RPC_REJECTED : support.SEED_ADMIN_EXIT_CODE.DATABASE_ERROR
      }
    }
    return exitCode
  }

  // deactivate
  if (!cli.targetFingerprint || !cli.reasonCode) {
    log('error', '--target-fingerprint and --reason-code are required for deactivate')
    return support.SEED_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }
  if (!(support.DEACTIVATE_REASON_CODES as readonly string[]).includes(cli.reasonCode)) {
    log('error', 'invalid --reason-code', { allowed: support.DEACTIVATE_REASON_CODES })
    return support.SEED_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR
  }
  const idempotencyKey = support.deriveDeactivateIdempotencyKey(cli.targetFingerprint, cli.reasonCode, cli.operatorReference)
  const preview = {
    fingerprintPrefix: cli.targetFingerprint.slice(0, 8), reasonCode: cli.reasonCode,
    idempotencyKeyPrefix: idempotencyKey.slice(0, 24),
  }
  if (!cli.apply) {
    log('info', 'dry-run preview -- deactivate', preview)
    return support.SEED_ADMIN_EXIT_CODE.COMPLETED
  }
  const outcome = await support.callDeactivateSignalSeed(client, {
    targetFingerprint: cli.targetFingerprint, reasonCode: cli.reasonCode as (typeof support.DEACTIVATE_REASON_CODES)[number],
    operatorReference: cli.operatorReference, idempotencyKey,
  })
  if (outcome.kind === 'deactivated' || outcome.kind === 'already_inactive_replay') {
    log('info', 'deactivate outcome', { outcome: outcome.kind })
    return support.SEED_ADMIN_EXIT_CODE.COMPLETED
  }
  log('error', 'deactivate outcome', { outcome: outcome.kind, message: outcome.errorMessage })
  return outcome.kind === 'rejected' ? support.SEED_ADMIN_EXIT_CODE.RPC_REJECTED : support.SEED_ADMIN_EXIT_CODE.DATABASE_ERROR
}

// A minimal, self-contained UUID/fingerprint-shortener duplicated here on
// purpose: this catch-all must still redact even if main() threw before
// ever reaching its dynamic import of redactForDisplay() (e.g. a module-
// resolution failure), so it cannot depend on that import having succeeded.
function shortenSecretsFallback(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `${m.slice(0, 8)}…`)
    .replace(/\b[0-9a-f]{64}\b/gi, (m) => `${m.slice(0, 8)}…`)
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((err) => {
    const rawMessage = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: 'unexpected internal error', error: shortenSecretsFallback(rawMessage) }))
    process.exitCode = 5
  })
