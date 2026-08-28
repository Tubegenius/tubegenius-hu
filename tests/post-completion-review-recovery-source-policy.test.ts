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
