// PFM Approved Human Review Executor v0 -- static source-policy regression
// tests. No DOM, no network, no DB, no subprocess. Mirrors
// tests/post-completion-review-recovery-source-policy.test.ts's own
// structure -- see that file's header for the general rationale.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIB_FILE = join(process.cwd(), 'lib', 'semantic-topic', 'execute-approved-review-cli-support.ts')
const CLI_FILE = join(process.cwd(), 'scripts', 'execute-approved-review.ts')
const SECURITY_FILE = join(process.cwd(), 'lib', 'semantic-topic', 'operator-cli-security.ts')

function codeOnly(src: string): string {
  return src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
}

const libSrc = codeOnly(readFileSync(LIB_FILE, 'utf8'))
const cliSrcRaw = readFileSync(CLI_FILE, 'utf8')
const cliSrc = codeOnly(cliSrcRaw)
const securitySrc = codeOnly(readFileSync(SECURITY_FILE, 'utf8'))

describe('lib/semantic-topic/execute-approved-review-cli-support.ts import-graph boundary', () => {
  it('never imports extraction-service.ts, provider-adapter.ts, or supervised-intake-runner.ts/types.ts', () => {
    expect(libSrc).not.toMatch(/extraction-service|provider-adapter|supervised-intake-runner|supervised-intake-types/)
  })
  it('never references the Anthropic SDK or an Anthropic API host', () => {
    expect(libSrc).not.toMatch(/@anthropic-ai|api\.anthropic\.com/i)
  })
  it('contains no raw INSERT/UPDATE/DELETE SQL text -- the only writes happen inside the existing, unchanged executeApprovedReview()/RPC', () => {
    expect(libSrc).not.toMatch(/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i)
  })
  it('never calls .rpc( directly -- the one RPC call happens exclusively inside the unchanged, reused executeApprovedReview() wrapper', () => {
    expect(libSrc).not.toMatch(/\.rpc\(/)
  })
  it('the only tables it ever selects from are topic_assignment_review_requests and topic_extraction_runs', () => {
    const tableNames = [...libSrc.matchAll(/\.from\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(tableNames.length).toBeGreaterThan(0)
    for (const name of tableNames) expect(['topic_assignment_review_requests', 'topic_extraction_runs']).toContain(name)
  })
  it('reuses executeApprovedReview unchanged (imported, not reimplemented)', () => {
    expect(libSrc).toMatch(/import\s*\{[^}]*executeApprovedReview[^}]*\}\s*from\s*['"]\.\/human-review-service['"]/)
  })
  it('executeApprovedReview is called with a DERIVED idempotency key, never a caller-supplied one -- no reviewRequestId/idempotencyKey pair originates from raw CLI argv anywhere in this file', () => {
    expect(libSrc).toMatch(/deriveExecutionIdempotencyKey/)
    expect(libSrc).not.toMatch(/idempotencyKey:\s*input\.idempotencyKey/)
  })
  it('the preview/outcome types never include a reviewer identity field (no reviewerUserId/reviewer_user_id anywhere)', () => {
    expect(libSrc.toLowerCase()).not.toMatch(/revieweruserid|reviewer_user_id/)
  })
  it('never accepts a caller-supplied canonicalTopicLabel/topicDefinition/scope/inclusionCriteria/exclusionCriteria as an INPUT parameter (read-only preview fields only, never part of RunExecuteApprovedReviewInput)', () => {
    const inputBlockMatch = libSrc.match(/export interface RunExecuteApprovedReviewInput \{[\s\S]*?\}/)
    expect(inputBlockMatch).not.toBeNull()
    if (inputBlockMatch) {
      expect(inputBlockMatch[0]).not.toMatch(/canonicalTopicLabel|topicDefinition|scope|inclusionCriteria|exclusionCriteria|approvalDigest|reviewerId/i)
    }
  })
})

describe('scripts/execute-approved-review.ts CLI boundary', () => {
  it('never imports extraction-service, provider-adapter, or supervised-intake-runner', () => {
    expect(cliSrc).not.toMatch(/extraction-service|provider-adapter|supervised-intake-runner/)
  })
  it('never references the Anthropic SDK', () => {
    expect(cliSrc).not.toMatch(/@anthropic-ai/i)
  })
  it('never reads .env or .env.local (no dotenv import, no readFile(Sync) of an env file)', () => {
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
  it('requires --confirm-production and resolves it via the shared operator-cli-security guard before constructing the admin client', () => {
    expect(cliSrc).toMatch(/--confirm-production/)
    expect(cliSrc).toMatch(/resolveProjectIdentity/)
    expect(cliSrc).toMatch(/projectGuardPasses/)
    const guardIndex = cliSrc.indexOf('projectGuardPasses(')
    const clientIndex = cliSrc.indexOf('createAdminClient()')
    expect(guardIndex).toBeGreaterThan(0)
    expect(clientIndex).toBeGreaterThan(guardIndex)
  })
  it('imports the guard/redaction primitives from the SHARED operator-cli-security module, not a local reimplementation', () => {
    expect(cliSrc).toMatch(/=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/operator-cli-security['"]\s*\)/)
    expect(cliSrc).not.toMatch(/function\s+redactForDisplay/)
    expect(cliSrc).not.toMatch(/function\s+resolveProjectIdentity/)
  })
  it('never accepts a canonical-label/summary/criteria/reviewer-id/approval-proof CLI flag -- only --review-request-id, --confirm-production, --dry-run, --help', () => {
    const flagMatches = [...cliSrc.matchAll(/arg === '(--[a-z-]+)'/g)].map((m) => m[1])
    expect(new Set(flagMatches)).toEqual(new Set(['--help', '--dry-run', '--review-request-id', '--confirm-production']))
  })
})

describe('scripts/execute-approved-review.ts -- single safe-presenter boundary', () => {
  const rawConsoleCalls = [...cliSrcRaw.matchAll(/console\.(log|error)\(/g)]

  it('has exactly the 6 known, reviewed console.log/console.error call sites -- no more, no fewer', () => {
    expect(rawConsoleCalls.length).toBe(6)
  })

  it('imports redactForDisplay from the shared security module and uses it inside the log() closure -- the ONE safe presenter', () => {
    expect(cliSrc).toMatch(/\{[^}]*redactForDisplay[^}]*\}\s*=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/operator-cli-security['"]\s*\)/)
    expect(cliSrc).toMatch(/redactForDisplay\(fields\)/)
    expect(cliSrc).toMatch(/\.\.\.safeFields/)
  })

  it('the module-resolution-failure fallback redacts via its own self-contained shortener, never printing a raw error object', () => {
    expect(cliSrc).toMatch(/shortenUuidsFallback/)
    expect(cliSrc).toMatch(/error:\s*shortenUuidsFallback\(rawMessage\)/)
  })

  it('every literal-only bootstrap console call never interpolates a caller-supplied or DB-sourced value', () => {
    const forbiddenDynamicNames = /\b(outcome|preview|result|err|error\.message)\b/
    const nodeVersionBlockMatch = cliSrc.match(/unsupported Node\.js version[\s\S]{0,300}?\}\)\)/)
    expect(nodeVersionBlockMatch).not.toBeNull()
    if (nodeVersionBlockMatch) expect(nodeVersionBlockMatch[0]).not.toMatch(forbiddenDynamicNames)

    const invalidUuidBlockMatch = cliSrc.match(/invalid --review-request-id[\s\S]{0,50}?\}\)\)/)
    expect(invalidUuidBlockMatch).not.toBeNull()
    if (invalidUuidBlockMatch) expect(invalidUuidBlockMatch[0]).not.toMatch(forbiddenDynamicNames)
  })
})

describe('lib/semantic-topic/operator-cli-security.ts -- single shared implementation, no drift', () => {
  it('is imported by BOTH operator CLIs -- post-completion-review-recovery.ts (via re-export) and execute-approved-review.ts (directly via dynamic import)', () => {
    const recoveryLibSrc = readFileSync(join(process.cwd(), 'lib', 'semantic-topic', 'post-completion-review-recovery.ts'), 'utf8')
    expect(recoveryLibSrc).toMatch(/from\s*['"]\.\/operator-cli-security['"]/)
    expect(cliSrc).toMatch(/=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/operator-cli-security['"]\s*\)/)
  })
  it('defines redactForDisplay, resolveProjectIdentity, and projectGuardPasses exactly once each across the whole lib/ tree', () => {
    // Grep-style scan: only operator-cli-security.ts may DEFINE these
    // (export function/export const NAME = ...); every other file may only
    // import or re-export them.
    const definitionPattern = (name: string) => new RegExp(`export\\s+(function|const)\\s+${name}\\b`)
    for (const name of ['redactForDisplay', 'resolveProjectIdentity', 'projectGuardPasses']) {
      expect(securitySrc).toMatch(definitionPattern(name))
      const recoveryLibSrc = codeOnly(readFileSync(join(process.cwd(), 'lib', 'semantic-topic', 'post-completion-review-recovery.ts'), 'utf8'))
      expect(recoveryLibSrc).not.toMatch(definitionPattern(name))
      expect(libSrc).not.toMatch(definitionPattern(name))
    }
  })
})
