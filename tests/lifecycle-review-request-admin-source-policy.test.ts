// PFM Lifecycle Operator CLI v1 -- static source-policy regression tests
// for the request-creation CLI. No DOM, no network, no DB, no subprocess.
// Mirrors tests/execute-approved-review-source-policy.test.ts's structure.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIB_FILE = join(process.cwd(), 'lib', 'semantic-topic', 'lifecycle-request-admin-cli-support.ts')
const CLI_FILE = join(process.cwd(), 'scripts', 'lifecycle-review-request-admin.ts')
const SECURITY_FILE = join(process.cwd(), 'lib', 'semantic-topic', 'operator-cli-security.ts')

function codeOnly(src: string): string {
  return src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
}

const libSrc = codeOnly(readFileSync(LIB_FILE, 'utf8'))
const cliSrcRaw = readFileSync(CLI_FILE, 'utf8')
const cliSrc = codeOnly(cliSrcRaw)
const securitySrc = codeOnly(readFileSync(SECURITY_FILE, 'utf8'))

describe('lib/semantic-topic/lifecycle-request-admin-cli-support.ts import-graph boundary', () => {
  it('never imports extraction-service.ts, provider-adapter.ts, supervised-intake-runner.ts/types.ts, or a reviewer-decision module', () => {
    expect(libSrc).not.toMatch(/extraction-service|provider-adapter|supervised-intake-runner|supervised-intake-types|human-review-reviewer|lifecycle-review-actions/)
  })
  it('never references the Anthropic SDK or an Anthropic API host', () => {
    expect(libSrc).not.toMatch(/@anthropic-ai|api\.anthropic\.com/i)
  })
  it('contains no raw INSERT/UPDATE/DELETE SQL text', () => {
    expect(libSrc).not.toMatch(/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i)
  })
  it('every RPC call in this file goes through the single call() boundary -- no scattered direct `.rpc(` call sites', () => {
    const directRpcCallSites = libSrc.match(/\w+\.rpc\(/g) ?? []
    expect(directRpcCallSites).toEqual(['client.rpc('])
  })
  it('never calls execute_approved_semantic_topic_lifecycle_transition or any other write RPC -- the only RPC names passed to call() are the create RPC and the read-only compute_topic_evidence_vector', () => {
    const rpcCalls = [...libSrc.matchAll(/call\(client,\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(rpcCalls.length).toBeGreaterThan(0)
    for (const name of rpcCalls) {
      expect(['create_semantic_topic_lifecycle_review_request', 'compute_topic_evidence_vector']).toContain(name)
    }
  })
  it('the only tables it ever selects from are semantic_topics and semantic_topic_lifecycle_review_requests', () => {
    const tableNames = [...libSrc.matchAll(/\.from\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(tableNames.length).toBeGreaterThan(0)
    for (const name of tableNames) expect(['semantic_topics', 'semantic_topic_lifecycle_review_requests']).toContain(name)
  })
  it('the write RPC is called with a DERIVED idempotency key, never a caller-supplied one', () => {
    expect(libSrc).toMatch(/deriveLifecycleRequestIdempotencyKey/)
    expect(libSrc).not.toMatch(/p_idempotency_key:\s*input\./)
  })
  it('the preview/outcome types never include a reviewer identity field', () => {
    expect(libSrc.toLowerCase()).not.toMatch(/revieweruserid|reviewer_user_id/)
  })
  it('RunCreateLifecycleReviewRequestInput never accepts a raw idempotency key, snapshot, digest, from-status, or expected-status-version field', () => {
    const inputBlockMatch = libSrc.match(/export interface RunCreateLifecycleReviewRequestInput \{[\s\S]*?\}/)
    expect(inputBlockMatch).not.toBeNull()
    if (inputBlockMatch) {
      expect(inputBlockMatch[0]).not.toMatch(/idempotencyKey|snapshot|digest|fromStatus|expectedStatusVersion/i)
    }
  })
})

describe('scripts/lifecycle-review-request-admin.ts CLI boundary', () => {
  it('never imports extraction-service, provider-adapter, supervised-intake-runner, or a reviewer-decision module', () => {
    expect(cliSrc).not.toMatch(/extraction-service|provider-adapter|supervised-intake-runner|human-review-reviewer|lifecycle-review-actions/)
  })
  it('never references the Anthropic SDK', () => {
    expect(cliSrc).not.toMatch(/@anthropic-ai/i)
  })
  it('never reads .env or .env.local', () => {
    expect(cliSrc).not.toMatch(/dotenv/i)
    expect(cliSrc).not.toMatch(/readFile(Sync)?\([^)]*\.env/)
  })
  it('never writes a file', () => {
    expect(cliSrc).not.toMatch(/writeFile/)
  })
  it('never calls .rpc( directly -- all RPC access goes through the support module', () => {
    expect(cliSrc).not.toMatch(/\.rpc\(/)
  })
  it('defaults to dry-run: apply is derived from the parsed --apply boolean, and the RPC-calling wrapper is invoked with dryRun: !cli.apply', () => {
    expect(cliSrc).toMatch(/apply:\s*parsed\.booleans\.has\('--apply'\)/)
    expect(cliSrc).toMatch(/dryRun:\s*!cli\.apply/)
  })
  it('requires --confirm-production-project-ref and resolves it via the shared operator-cli-security guard before constructing the admin client', () => {
    expect(cliSrc).toMatch(/--confirm-production-project-ref/)
    expect(cliSrc).toMatch(/resolveProjectIdentity/)
    expect(cliSrc).toMatch(/projectGuardPasses/)
    const guardIndex = cliSrc.indexOf('projectGuardPasses(')
    const clientIndex = cliSrc.indexOf('createAdminClient()')
    expect(guardIndex).toBeGreaterThan(0)
    expect(clientIndex).toBeGreaterThan(guardIndex)
  })
  it('requires an interactive typed "YES" via node:readline/promises before any apply proceeds, and the guard check precedes the prompt', () => {
    expect(cliSrc).toMatch(/readline\/promises/)
    expect(cliSrc).toMatch(/rl\.question\(/)
    expect(cliSrc).toMatch(/typed\.trim\(\)\s*!==\s*'YES'/)
    const guardIndex = cliSrc.indexOf('projectGuardPasses(')
    const promptIndex = cliSrc.indexOf('rl.question(')
    expect(guardIndex).toBeGreaterThan(0)
    expect(promptIndex).toBeGreaterThan(guardIndex)
  })
  it('imports the guard/redaction primitives from the SHARED operator-cli-security module, not a local reimplementation', () => {
    expect(cliSrc).toMatch(/=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/operator-cli-security['"]\s*\)/)
    expect(cliSrc).not.toMatch(/function\s+redactForDisplay/)
    expect(cliSrc).not.toMatch(/function\s+resolveProjectIdentity/)
  })
  it('never accepts a free-form --idempotency-key flag', () => {
    expect(cliSrc).not.toMatch(/'--idempotency-key'/)
  })
  it('accepts exactly the documented flags -- no more, no fewer (schema keys + the separately-handled --help)', () => {
    const schemaBlockMatch = cliSrc.match(/REQUEST_ADMIN_FLAG_SCHEMA:[\s\S]*?\{([\s\S]*?)\}/)
    expect(schemaBlockMatch).not.toBeNull()
    const schemaFlags = schemaBlockMatch ? [...schemaBlockMatch[1].matchAll(/'(--[a-z-]+)':/g)].map((m) => m[1]) : []
    expect(new Set(schemaFlags)).toEqual(new Set(['--dry-run', '--apply', '--semantic-topic-id', '--target-status', '--operator-reference', '--confirm-production-project-ref']))
    expect(cliSrc).toMatch(/rawArgs\.includes\('--help'\)/)
  })
  it('validates arguments via the shared strict parser, before any environment read, client construction, guard, or prompt', () => {
    expect(cliSrc).toMatch(/=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/strict-cli-args['"]\s*\)/)
    expect(cliSrc).toMatch(/parseStrictArgs</)
    const strictParseIndex = cliSrc.indexOf('parseStrictArgs<')
    const envReadIndex = cliSrc.indexOf('missingEnvVars')
    const guardIndex = cliSrc.indexOf('projectGuardPasses(')
    const promptIndex = cliSrc.indexOf('rl.question(')
    expect(strictParseIndex).toBeGreaterThan(0)
    expect(envReadIndex).toBeGreaterThan(strictParseIndex)
    expect(guardIndex).toBeGreaterThan(strictParseIndex)
    expect(promptIndex).toBeGreaterThan(strictParseIndex)
  })
  it('rejects --dry-run and --apply given together, before any RPC-bound validation', () => {
    expect(cliSrc).toMatch(/parsed\.booleans\.has\('--dry-run'\)\s*&&\s*parsed\.booleans\.has\('--apply'\)/)
  })
  it('never re-implements the parsing loop itself -- no local `while` or `for` scan over argv outside the shared parser module', () => {
    expect(cliSrc).not.toMatch(/for\s*\(\s*let i = 0; i < argv\.length/)
  })
})

describe('scripts/lifecycle-review-request-admin.ts -- single safe-presenter boundary', () => {
  it('imports redactForDisplay from the shared security module and uses it inside the log() closure', () => {
    expect(cliSrc).toMatch(/\{[^}]*redactForDisplay[^}]*\}\s*=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/operator-cli-security['"]\s*\)/)
    expect(cliSrc).toMatch(/redactForDisplay\(fields\)/)
    expect(cliSrc).toMatch(/\.\.\.safeFields/)
  })
  it('the module-resolution-failure fallback redacts via its own self-contained shortener, never printing a raw error object', () => {
    expect(cliSrc).toMatch(/shortenUuidsFallback/)
    expect(cliSrc).toMatch(/error:\s*shortenUuidsFallback\(rawMessage\)/)
  })
  it('the full --confirm-production-project-ref value is never echoed in the apply-guard log lines -- only identity.kind is logged', () => {
    const guardFailBlock = cliSrc.match(/log\('error', '--apply requires[\s\S]*?\}\)/)
    expect(guardFailBlock).not.toBeNull()
    if (guardFailBlock) expect(guardFailBlock[0]).not.toMatch(/confirmProductionProjectRef/)

    const guardPassBlock = cliSrc.match(/log\('info', 'production apply guard passed'[\s\S]*?\}\)/)
    expect(guardPassBlock).not.toBeNull()
    if (guardPassBlock) expect(guardPassBlock[0]).not.toMatch(/confirmProductionProjectRef/)
  })
})

describe('lib/semantic-topic/operator-cli-security.ts -- reused unchanged, no drift', () => {
  it('this CLI imports the shared module directly via dynamic import, never redefining any of its primitives', () => {
    expect(cliSrc).toMatch(/=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/operator-cli-security['"]\s*\)/)
    const definitionPattern = (name: string) => new RegExp(`export\\s+(function|const)\\s+${name}\\b`)
    for (const name of ['redactForDisplay', 'resolveProjectIdentity', 'projectGuardPasses']) {
      expect(securitySrc).toMatch(definitionPattern(name))
      expect(libSrc).not.toMatch(definitionPattern(name))
      expect(cliSrc).not.toMatch(definitionPattern(name))
    }
  })
})
