#!/usr/bin/env node
// PFM Anthropic Provider Failure Taxonomy v0 -- secure single-call
// diagnostic CLI. Explicit, manual command-line invocation ONLY: this file
// is never imported by any Next.js route, page, or component, is never
// part of the client bundle, and does not install a cron, worker, or HTTP
// endpoint of its own. Running it is the only way it ever runs.
//
// PURPOSE: after a production provider rejection whose exact HTTP status
// (401 vs 403 vs 404 vs something else) cannot be determined from stored,
// redacted logs alone (see docs/architecture/provider-failure-taxonomy.md),
// this CLI makes exactly ONE minimal, harmless Anthropic Messages API call
// with the SAME model identifier production extraction uses, and prints
// only the structured, redacted classification -- never the response text,
// never a raw provider error body, never any evidence data.
//
// Usage (from the repo root):
//   node scripts/anthropic-provider-diagnostic.ts --confirm-diagnostic
//
// Required environment (read from the REAL process environment only --
// this file never reads or loads .env, .env.local, or any other
// dotenv-style file; the operator's shell must already export this before
// invoking the CLI, and the PowerShell wrapper next to this file makes that
// value available ONLY for the lifetime of this one child process):
//   ANTHROPIC_API_KEY
//
// BOOTSTRAP NOTE: this file's own top-level body must stay import-minimal
// (node: builtins only) and defer every real-application import to a
// dynamic import() AFTER module.register() below -- same reasoning as
// scripts/supervised-intake-runner.ts's own header.
import { register } from 'node:module'

// Documented, stable exit codes -- one per outcome class, never overloaded.
// Declared before the Node-version preflight below (which references it)
// -- a `const` after that block would be in the temporal dead zone.
const EXIT_CODE = {
  SUCCESS: 0, // the single call completed -- provider/model/key are all working
  CONFIG_ERROR: 1, // missing --confirm-diagnostic, missing/empty ANTHROPIC_API_KEY, or any precondition failure BEFORE the call
  PROVIDER_FAILURE_CLASSIFIED: 2, // the call failed with a structured, classified taxonomy category (see stdout)
  TIMEOUT_OR_UNCERTAIN: 3, // no structured classification available -- network/timeout/unknown, fail-closed
  UNEXPECTED_INTERNAL_ERROR: 4,
} as const

// Node-version preflight, identical rationale to supervised-intake-runner.ts's
// own: checked as the very first executable statement, before register()
// and before any real-application import, so an unsupported version never
// reaches the provider-call boundary.
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
    process.exit(EXIT_CODE.CONFIG_ERROR)
  }
}

register('./ts-alias-loader.mjs', import.meta.url)

const HELP_TEXT = `Anthropic Provider Failure Taxonomy v0 -- secure single-call diagnostic CLI

Usage:
  node scripts/anthropic-provider-diagnostic.ts --confirm-diagnostic [--production-parity]

Makes EXACTLY ONE minimal Anthropic Messages API call (fixed harmless
prompt, the same model identifier production extraction uses) and prints
only the structured, redacted classification plus a separately sanitized
provider error type/message (display-only, never used for branching, never
written to a DB or runtime log -- see provider-error-diagnostic-detail.ts).
Never prints the response text, never any evidence data, never retries.

Two request modes:
  (default)              max_tokens=1, no system parameter -- the smallest
                          possible request, cheapest and fastest.
  --production-parity     max_tokens and the presence of a system parameter
                          match provider-adapter.ts's real production
                          request shape exactly (imported from the SAME
                          shared constants, not a hand-duplicated literal) --
                          use this when a --confirm-diagnostic-only run's
                          result might be confounded by a request-shape
                          difference from the real extraction call.

Required environment (must already be exported in the shell -- this CLI
never reads .env/.env.local itself, and never accepts either value as a
command-line argument):
  ANTHROPIC_API_KEY
  ANTHROPIC_WORKSPACE_ID   Required for every call (default AND
                            --production-parity): the production key is a
                            confirmed identity-linked (multi-workspace) key,
                            so every Messages API call must carry the
                            anthropic-workspace-id header. See
                            lib/semantic-topic/anthropic-workspace-config.ts.

Options:
  --confirm-diagnostic   Required. Without it, the CLI prints this help
                          and exits before doing anything else.
  --production-parity    Optional. See above.
  --help                  Show this message.

Output never includes the workspace ID value, a prefix of it, its length,
or any fingerprint of it -- only whether it was configured at all (see
provider-error-diagnostic-detail.ts and operator-cli-security.ts's
redaction contract, which fully masks any field named workspaceId).

Exit codes:
  0  success -- the call completed (key/model/permissions all working)
  1  config error -- missing confirmation flag or missing/empty API key
  2  provider failure, classified -- see the printed category/httpStatus
  3  timeout or uncertain -- no structured classification available
  4  unexpected internal error
`

// A short, structurally-realistic but entirely harmless system prompt for
// --production-parity mode -- deliberately NOT the real extraction system
// prompt text (no reason to expose that, and it isn't needed to test
// whether the mere PRESENCE of a system parameter matters), just present
// with comparable rough length.
const PARITY_SYSTEM_PROMPT = 'You are a diagnostic assistant. Reply with the single word: ok. Ignore everything else in this message; there is no real task here.'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const help = args.includes('--help') || args.includes('-h')
  const confirmed = args.includes('--confirm-diagnostic')
  const productionParity = args.includes('--production-parity')

  if (help || !confirmed) {
    console.log(HELP_TEXT)
    return help ? EXIT_CODE.SUCCESS : EXIT_CODE.CONFIG_ERROR
  }

  // Every real-application import happens here, AFTER register() above.
  const { redactForDisplay } = await import('../lib/semantic-topic/operator-cli-security')
  const { classifyProviderFailure } = await import('../lib/semantic-topic/provider-error-taxonomy')
  const { extractSafeProviderErrorDetail } = await import('../lib/semantic-topic/provider-error-diagnostic-detail')
  const { ANTHROPIC_WORKSPACE_ID_HEADER, getConfiguredAnthropicWorkspaceId } = await import('../lib/semantic-topic/anthropic-workspace-config')
  // AI_QUOTA_MAX_OUTPUT_TOKENS is the SAME constant provider-adapter.ts's
  // real extraction call is invoked with (via extraction-service.ts) --
  // imported here rather than re-typed as a literal so --production-parity
  // can never silently drift from the real value again. See
  // tests/anthropic-provider-diagnostic.test.ts's own static parity check.
  const { SEMANTIC_TOPIC_EXTRACTION_MODEL, AI_QUOTA_MAX_OUTPUT_TOKENS } = await import('../lib/semantic-topic/extraction-config')
  const Anthropic = (await import('@anthropic-ai/sdk')).default

  // The ONE presenter this CLI ever uses to print anything -- fields always
  // routed through redactForDisplay() first, matching every other operator
  // CLI's single-presenter contract (see tests/*-source-policy.test.ts for
  // the established pattern this mirrors).
  const log = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => {
    const safeFields = fields ? (redactForDisplay(fields) as Record<string, unknown>) : undefined
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...safeFields })
    if (level === 'error') console.error(line)
    else console.log(line)
  }

  if (typeof process.env.ANTHROPIC_API_KEY !== 'string' || process.env.ANTHROPIC_API_KEY.length === 0) {
    log('error', 'ANTHROPIC_API_KEY is not set in this process environment -- refusing to proceed before any provider call')
    return EXIT_CODE.CONFIG_ERROR
  }

  // PFM Identity-Linked Workspace Header Support v0: required for every
  // call (default AND --production-parity), same fail-closed-before-any-
  // call contract as the API key check just above -- see
  // anthropic-workspace-config.ts for the full official contract. Never
  // logs the reasonCode's underlying raw value (there isn't one on a
  // failure branch by construction) and never logs the value on success
  // either -- only the boolean fact that it was configured, below.
  const workspaceConfig = getConfiguredAnthropicWorkspaceId()
  if (!workspaceConfig.ok) {
    log('error', 'ANTHROPIC_WORKSPACE_ID is not configured -- refusing to proceed before any provider call', {
      reasonCode: workspaceConfig.reasonCode,
    })
    return EXIT_CODE.CONFIG_ERROR
  }

  // No DB, no Supabase, no Vercel, no control table -- this client is
  // constructed with ONLY the key, timeout, and maxRetries:0, identical to
  // provider-adapter.ts's own narrow-adapter contract (see that file's
  // header for why maxRetries must never be anything but 0 here). The
  // workspace header is added via defaultHeaders exactly like provider-
  // adapter.ts's own production client -- applies to the one call this CLI
  // ever makes, in both default and --production-parity modes (the header
  // is an authentication concern, not a request-shape parity concern, so it
  // does not vary with productionParity).
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 15_000,
    maxRetries: 0,
    defaultHeaders: { [ANTHROPIC_WORKSPACE_ID_HEADER]: workspaceConfig.workspaceId },
  })

  const maxOutputTokens = productionParity ? AI_QUOTA_MAX_OUTPUT_TOKENS : 1

  log('info', 'starting single diagnostic call', {
    model: SEMANTIC_TOPIC_EXTRACTION_MODEL,
    maxOutputTokens,
    timeoutMs: 15_000,
    productionParity,
    // Boolean fact only -- never the value, prefix, length, or fingerprint
    // (Section D's own explicit requirement). Always true at this point in
    // the function (the config-error branch above already returned), kept
    // here purely so a saved log line self-documents that the header was
    // sent, without needing to cross-reference source code to know.
    workspaceHeaderConfigured: true,
  })

  try {
    // Fixed, harmless prompt -- no evidence data, no caller-supplied
    // content of any kind. Default mode: max_tokens=1, no system parameter
    // -- the smallest possible request. --production-parity: max_tokens
    // and system-parameter PRESENCE match the real extraction request
    // shape (see PARITY_SYSTEM_PROMPT's own comment for why its CONTENT is
    // still a harmless placeholder, not the real prompt).
    await client.messages.create({
      model: SEMANTIC_TOPIC_EXTRACTION_MODEL,
      max_tokens: maxOutputTokens,
      ...(productionParity ? { system: PARITY_SYSTEM_PROMPT } : {}),
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    })
    // Success: the response text/content is NEVER printed, by design --
    // this CLI's only job is to confirm the call completed, not to surface
    // any model output.
    log('info', 'diagnostic call completed successfully -- key, model, and permissions are all working', {
      model: SEMANTIC_TOPIC_EXTRACTION_MODEL,
      productionParity,
    })
    return EXIT_CODE.SUCCESS
  } catch (err) {
    const classification = classifyProviderFailure(err)
    // Display-only, never used for the branching below -- see provider-
    // error-diagnostic-detail.ts's own header for the boundary this
    // enforces. sanitizedMessage is truncated to 300 chars, secret-masked,
    // UUID-shortened, request-ID-masked, and control-character-stripped.
    const safeDetail = extractSafeProviderErrorDetail(err)
    if (classification.httpStatus !== null) {
      log('error', 'diagnostic call failed with a classified provider error', {
        category: classification.category,
        httpStatus: classification.httpStatus,
        billed: classification.billed,
        retryPolicy: classification.retryPolicy,
        providerErrorType: safeDetail.providerErrorType,
        sanitizedProviderMessage: safeDetail.sanitizedMessage,
      })
      return EXIT_CODE.PROVIDER_FAILURE_CLASSIFIED
    }
    // No structured HTTP status -- timeout/network/unknown. Fail-closed:
    // never retried, never treated as a confirmed classification.
    log('error', 'diagnostic call did not complete with a structured provider status -- timeout or uncertain, fail-closed', {
      category: classification.category,
      providerErrorType: safeDetail.providerErrorType,
      sanitizedProviderMessage: safeDetail.sanitizedMessage,
    })
    return EXIT_CODE.TIMEOUT_OR_UNCERTAIN
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((err) => {
    // A minimal, self-contained fallback redactor -- this catch-all must
    // still redact even if main() threw before ever reaching its dynamic
    // import of redactForDisplay() (e.g. a module-resolution failure), so
    // it cannot depend on that import having succeeded. Matches every
    // other operator CLI's own identical fallback (see operator-cli-
    // security.ts's header comment for why this stays duplicated here
    // rather than imported).
    function shortenUuidsFallback(text: string): string {
      return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `${m.slice(0, 8)}…`)
    }
    const rawMessage = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: 'unexpected internal error', error: shortenUuidsFallback(rawMessage) }))
    process.exitCode = EXIT_CODE.UNEXPECTED_INTERNAL_ERROR
  })
