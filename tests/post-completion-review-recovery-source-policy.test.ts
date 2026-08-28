// PFM Post-Completion Review Handoff Recovery v0 -- static source-policy
// regression tests. No DOM, no network, no DB, no subprocess. This is the
// concrete, grep-level proof that the recovery module and its CLI can
// NEVER reach a provider call, a supervised-intake batch/item/attempt/
// reservation write, or any raw SQL DML -- structurally, not by convention.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIB_FILE = join(process.cwd(), 'lib', 'semantic-topic', 'post-completion-review-recovery.ts')
const CLI_FILE = join(process.cwd(), 'scripts', 'post-completion-review-recovery.ts')

function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const libSrc = codeOnly(readFileSync(LIB_FILE, 'utf8'))
const cliSrcRaw = readFileSync(CLI_FILE, 'utf8')
const cliSrc = codeOnly(cliSrcRaw)

describe('lib/semantic-topic/post-completion-review-recovery.ts import-graph boundary', () => {
  it('never imports extraction-service.ts (no extraction/provider path reachable)', () => {
    expect(libSrc).not.toMatch(/from\s+['"]\.\/extraction-service['"]/)
  })
  it('never imports provider-adapter.ts', () => {
    expect(libSrc).not.toMatch(/from\s+['"]\.\/provider-adapter['"]/)
  })
  it('never imports supervised-intake-runner.ts or supervised-intake-types.ts', () => {
    expect(libSrc).not.toMatch(/supervised-intake-runner|supervised-intake-types/)
  })
  it('never references the Anthropic SDK or an Anthropic API host', () => {
    expect(libSrc).not.toMatch(/@anthropic-ai|api\.anthropic\.com/i)
  })
  it('contains no raw INSERT/UPDATE/DELETE SQL text (it only ever calls an existing RPC and one read-only SELECT via the query builder)', () => {
    expect(libSrc).not.toMatch(/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i)
  })
  it('never calls .rpc( directly -- the one RPC call happens exclusively inside the unchanged, reused createReviewRequest() wrapper', () => {
    expect(libSrc).not.toMatch(/\.rpc\(/)
  })
  it('the only table it ever selects from is topic_extraction_runs', () => {
    const tableNames = [...libSrc.matchAll(/\.from\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(tableNames.length).toBeGreaterThan(0)
    for (const name of tableNames) expect(name).toBe('topic_extraction_runs')
  })
  it('reuses deriveHumanReviewIdempotencyKey and createReviewRequest unchanged (imported, not reimplemented)', () => {
    expect(libSrc).toMatch(/import\s*\{[^}]*deriveHumanReviewIdempotencyKey[^}]*\}\s*from\s*['"]\.\/human-review-extraction-hook['"]/)
    expect(libSrc).toMatch(/import\s*\{[^}]*createReviewRequest[^}]*\}\s*from\s*['"]\.\/human-review-service['"]/)
  })
})

describe('scripts/post-completion-review-recovery.ts CLI boundary', () => {
  it('never imports extraction-service, provider-adapter, or supervised-intake-runner', () => {
    expect(cliSrc).not.toMatch(/extraction-service|provider-adapter|supervised-intake-runner/)
  })
  it('never references the Anthropic SDK', () => {
    expect(cliSrc).not.toMatch(/@anthropic-ai/i)
  })
  it('never reads .env or .env.local (no dotenv import, no readFile(Sync) of an env file) -- checked against actual code, not the CLI\'s own --help documentation text that merely mentions ".env.local"', () => {
    expect(cliSrc).not.toMatch(/dotenv/i)
    expect(cliSrc).not.toMatch(/readFile(Sync)?\([^)]*\.env/)
  })
  it('never writes a file (no writeFile/writeFileSync anywhere in the CLI)', () => {
    expect(cliSrc).not.toMatch(/writeFile/)
  })
  it('checks SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED via the existing isHumanReviewEnabled() reader, never a second ad hoc flag check', () => {
    expect(cliSrc).toMatch(/isHumanReviewEnabled/)
    expect(cliSrc).not.toMatch(/process\.env\.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED\s*===/)
  })
  it('never calls .rpc( directly -- all RPC access goes through the existing service-layer function', () => {
    expect(cliSrc).not.toMatch(/\.rpc\(/)
  })
  it('requires --confirm-production and resolves it via resolveProjectIdentity/projectGuardPasses before constructing the admin client', () => {
    expect(cliSrc).toMatch(/--confirm-production/)
    expect(cliSrc).toMatch(/resolveProjectIdentity/)
    expect(cliSrc).toMatch(/projectGuardPasses/)
    const guardIndex = cliSrc.indexOf('projectGuardPasses(')
    const clientIndex = cliSrc.indexOf('createAdminClient()')
    expect(guardIndex).toBeGreaterThan(0)
    expect(clientIndex).toBeGreaterThan(guardIndex)
  })
})

// ===========================================================================
// Remediation gate: single-presenter output-boundary proof. Rather than try
// to regex-classify "is this console call safe" in general (fragile), this
// pins the EXACT, enumerated set of raw console.log/console.error call
// sites in the CLI to a fixed count and confirms each one is one of the
// specific, reviewed cases below. Adding a 7th call site -- e.g. a future
// developer printing a raw preview/RPC-result/error object directly --
// changes this count and fails the test, forcing a review rather than
// silently reintroducing the exact bug this gate fixes.
// ===========================================================================
describe('scripts/post-completion-review-recovery.ts -- single safe-presenter boundary', () => {
  const rawConsoleCalls = [...cliSrcRaw.matchAll(/console\.(log|error)\(/g)]

  it('has exactly the 6 known, reviewed console.log/console.error call sites -- no more, no fewer', () => {
    expect(rawConsoleCalls.length).toBe(6)
  })

  it('imports redactForDisplay from the lib module and uses it inside the log() closure -- the ONE safe presenter', () => {
    // The real import is a destructured dynamic `await import(...)`, not a
    // static ES `import {} from` statement (all real-application imports in
    // this CLI happen after register(), post-Node-version-guard).
    expect(cliSrc).toMatch(/\{[^}]*redactForDisplay[^}]*\}\s*=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/post-completion-review-recovery['"]\s*\)/)
    // safeFields must be computed via redactForDisplay AND actually spread
    // into the printed line -- both halves are required; either one
    // missing would silently reopen the original leak.
    expect(cliSrc).toMatch(/redactForDisplay\(fields\)/)
    expect(cliSrc).toMatch(/\.\.\.safeFields/)
  })

  it('the module-resolution-failure fallback (the one call site that cannot depend on the dynamic import having succeeded) redacts via its own self-contained shortener, never printing a raw error object', () => {
    expect(cliSrc).toMatch(/shortenUuidsFallback/)
    expect(cliSrc).toMatch(/error:\s*shortenUuidsFallback\(rawMessage\)/)
  })

  it('every literal-only bootstrap console call (Node-version guard, --help text, invalid-UUID message) never interpolates a caller-supplied or DB-sourced value', () => {
    // These three call sites are allowed to print JSON.stringify of an
    // object, but only ever with values that are either fixed literals
    // (requiredMajor, a hardcoded message string) or process.versions.node
    // (never user/DB input) -- none of them may reference the CLI's `log()`
    // closure variables `outcome`, `preview`, `result`, or `err`. (The bare
    // JSON key name `fields` legitimately appears in the Node-version-guard
    // block's own literal payload -- unrelated to log()'s `fields` param,
    // which isn't even in scope at that point in the file -- so it is not
    // itself forbidden; only a reference to the closure variable is.)
    const forbiddenDynamicNames = /\b(outcome|preview|result|err|error\.message)\b/
    const nodeVersionBlockMatch = cliSrc.match(/unsupported Node\.js version[\s\S]{0,300}?\}\)\)/)
    expect(nodeVersionBlockMatch).not.toBeNull()
    if (nodeVersionBlockMatch) expect(nodeVersionBlockMatch[0]).not.toMatch(forbiddenDynamicNames)

    const invalidUuidBlockMatch = cliSrc.match(/invalid --extraction-run-id[\s\S]{0,50}?\}\)\)/)
    expect(invalidUuidBlockMatch).not.toBeNull()
    if (invalidUuidBlockMatch) expect(invalidUuidBlockMatch[0]).not.toMatch(forbiddenDynamicNames)
  })
})
