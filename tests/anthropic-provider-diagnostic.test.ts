// PFM Anthropic Provider Failure Taxonomy v0 -- diagnostic CLI tests.
// Every network call in this file is mocked via a local HTTP server the
// Anthropic SDK is redirected to with ANTHROPIC_BASE_URL -- no real
// network/provider call anywhere. Real subprocess spawn of the actual CLI
// entrypoint (same pattern as supervised-intake-cli-subprocess-e2e.test.ts),
// so this exercises the real arg-parsing, the real Node-version preflight,
// and the real env-variable boundary an operator would actually hit.
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const REPO_ROOT = process.cwd()
const CLI_ENTRY = join(REPO_ROOT, 'scripts', 'anthropic-provider-diagnostic.ts')
// Normalized to LF regardless of the checkout's line-ending convention --
// this file's own \n-anchored regex assertions below must not depend on
// whether the working tree has CRLF (e.g. a Windows checkout with
// core.autocrlf=true) or LF line endings.
const cliSourceRaw = readFileSync(CLI_ENTRY, 'utf8').replace(/\r\n/g, '\n')
// Comment-stripped view for source-policy assertions -- this file's own
// explanatory comments legitimately mention "dotenv-style file" and
// "supervised-intake-runner.ts" (as prose, not an import), which would
// otherwise false-positive a substring check meant to catch a REAL import.
function codeOnly(src: string): string {
  return src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
}
const cliSource = codeOnly(cliSourceRaw)

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANTHROPIC_BASE_URL
  // PFM Anthropic Explicit Workspace-Scoped Authentication Mode gate:
  // ANTHROPIC_AUTH_SCOPE_MODE (+ ANTHROPIC_WORKSPACE_ID when identity_linked)
  // is now a required precondition, same as ANTHROPIC_API_KEY -- default to
  // identity_linked + a valid synthetic workspace ID here so every EXISTING
  // test in this file (written before this mode existed) keeps reaching the
  // mock server unchanged; dedicated describe blocks below override these
  // via envOverrides to exercise every config-error path AND workspace_scoped
  // mode.
  env.ANTHROPIC_AUTH_SCOPE_MODE = 'identity_linked'
  env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ'
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_ENTRY, ...args], { cwd: REPO_ROOT, env, timeout: 30_000 })
    return { exitCode: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    if (typeof e.code !== 'number') throw err
    return { exitCode: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

// ===========================================================================
// Source-policy: static checks, no process spawn.
// ===========================================================================
describe('anthropic-provider-diagnostic.ts -- source policy', () => {
  it('never reads .env or .env.local, never imports dotenv', () => {
    expect(cliSource).not.toMatch(/dotenv/i)
    expect(cliSource).not.toMatch(/readFile(Sync)?\([^)]*\.env/)
  })

  it('never accepts the API key as a command-line argument -- only reads process.env.ANTHROPIC_API_KEY', () => {
    expect(cliSource).not.toMatch(/--api-key/)
    expect(cliSource).toMatch(/process\.env\.ANTHROPIC_API_KEY/)
  })

  it('PFM auth-scope-mode: never accepts the workspace ID or the auth scope mode as command-line arguments -- only reads them via resolveAnthropicAuthConfig()', () => {
    expect(cliSource).not.toMatch(/--workspace-id/)
    expect(cliSource).not.toMatch(/--auth-scope-mode/)
    expect(cliSource).toMatch(/resolveAnthropicAuthConfig/)
  })

  it('PFM auth-scope-mode: sends the header via defaultHeaders ONLY in identity_linked mode, applied identically regardless of --production-parity', () => {
    expect(cliSource).toMatch(/defaultHeaders:\s*\{\s*\[ANTHROPIC_WORKSPACE_ID_HEADER\]/)
    expect(cliSource).toMatch(/authConfig\.mode === 'identity_linked'\s*\?\s*\{\s*defaultHeaders/)
  })

  it('never imports any DB/Supabase/Vercel client or the supervised-intake runner', () => {
    expect(cliSource).not.toMatch(/supabase-server|createAdminClient|supervised-intake-runner|supervised-intake-types/)
  })

  it('never imports evidence-related modules (normalize.ts, extraction-writer.ts, human-review-*)', () => {
    expect(cliSource).not.toMatch(/normalize['"]|extraction-writer|human-review/)
  })

  it('defaults maxOutputTokens to the literal 1 (only --production-parity switches it), and never sets maxRetries to anything but 0', () => {
    expect(cliSource).toMatch(/const maxOutputTokens = productionParity \? AI_QUOTA_MAX_OUTPUT_TOKENS : 1\b/)
    expect(cliSource).toMatch(/maxRetries:\s*0\b/)
    expect(cliSource).not.toMatch(/maxRetries:\s*[1-9]/)
  })

  it('--production-parity mode reuses the SAME AI_QUOTA_MAX_OUTPUT_TOKENS constant provider-adapter.ts/extraction-service.ts use for the real call -- never a hand-duplicated 1024 literal', () => {
    expect(cliSource).toMatch(/AI_QUOTA_MAX_OUTPUT_TOKENS\s*}\s*=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/extraction-config['"]\s*\)/)
    expect(cliSource).not.toMatch(/max_tokens:\s*1024\b/) // never hardcoded -- always the imported constant
  })

  it('PFM production-parity: --production-parity mode also matches provider-adapter.ts\'s 60_000ms client timeout (default mode keeps the cheaper 15_000ms)', () => {
    expect(cliSource).toMatch(/const timeoutMs = productionParity \? 60_000 : 15_000\b/)
    const providerAdapterSource = readFileSync(join(REPO_ROOT, 'lib', 'semantic-topic', 'provider-adapter.ts'), 'utf8')
    expect(providerAdapterSource).toMatch(/timeout:\s*60_000\b/)
  })

  it('never logs the response text/content, request body, or any raw provider object -- only the structured classification fields', () => {
    // The success branch must never reference message.content/text at all.
    const successBranch = cliSource.match(/await client\.messages\.create\(\{[\s\S]*?return EXIT_CODE\.SUCCESS/)
    expect(successBranch).not.toBeNull()
    if (successBranch) {
      expect(successBranch[0]).not.toMatch(/\.content\b/)
      expect(successBranch[0]).not.toMatch(/\.text\b/)
    }
  })

  it('imports redactForDisplay from the shared security module -- the ONE safe presenter, not a local reimplementation', () => {
    expect(cliSource).toMatch(/=\s*await\s+import\(\s*['"]\.\.\/lib\/semantic-topic\/operator-cli-security['"]\s*\)/)
    expect(cliSource).not.toMatch(/function\s+redactForDisplay/)
  })

  it('has a documented, closed set of exit codes (0-4), never an ad hoc numeric literal exit elsewhere', () => {
    expect(cliSource).toMatch(/SUCCESS:\s*0/)
    expect(cliSource).toMatch(/CONFIG_ERROR:\s*1/)
    expect(cliSource).toMatch(/PROVIDER_FAILURE_CLASSIFIED:\s*2/)
    expect(cliSource).toMatch(/TIMEOUT_OR_UNCERTAIN:\s*3/)
    expect(cliSource).toMatch(/UNEXPECTED_INTERNAL_ERROR:\s*4/)
  })

  it('never retries -- exactly one client.messages.create call site in the whole file', () => {
    const matches = cliSource.match(/client\.messages\.create\(/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('the safe error-detail import is only ever passed to log() fields, never used inside the branching condition (classification.httpStatus stays the only decision input)', () => {
    const catchBlock = cliSource.match(/} catch \(err\) \{[\s\S]*?\n  \}\n\}/)
    expect(catchBlock).not.toBeNull()
    if (catchBlock) {
      // The if/else branching must reference only classification.*, never safeDetail.*
      const ifConditions = [...catchBlock[0].matchAll(/if \(([^)]+)\)/g)].map((m) => m[1])
      for (const cond of ifConditions) {
        expect(cond).not.toMatch(/safeDetail/)
      }
    }
  })
})

describe('provider-error-diagnostic-detail.ts -- boundary from production code', () => {
  const extractionServiceSource = readFileSync(join(REPO_ROOT, 'lib', 'semantic-topic', 'extraction-service.ts'), 'utf8')
  const runnerSource = readFileSync(join(REPO_ROOT, 'lib', 'semantic-topic', 'supervised-intake-runner.ts'), 'utf8')

  it('extraction-service.ts never imports provider-error-diagnostic-detail.ts', () => {
    expect(extractionServiceSource).not.toMatch(/provider-error-diagnostic-detail/)
  })
  it('supervised-intake-runner.ts never imports provider-error-diagnostic-detail.ts', () => {
    expect(runnerSource).not.toMatch(/provider-error-diagnostic-detail/)
  })
  it('the diagnostic CLI is the only file under scripts/ or lib/ that imports provider-error-diagnostic-detail.ts (besides its own definition)', () => {
    // Plain filesystem scan (not git grep -- must hold true even for an
    // uncommitted, untracked new file, not only once it's staged/committed).
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    const matches: string[] = []
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue
        const full = join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (/\.tsx?$/.test(entry)) {
          const text = readFileSync(full, 'utf8')
          if (text.includes('provider-error-diagnostic-detail')) matches.push(full.slice(REPO_ROOT.length + 1).replace(/\\/g, '/'))
        }
      }
    }
    walk(join(REPO_ROOT, 'lib'))
    walk(join(REPO_ROOT, 'scripts'))
    // The module's own definition file never references its own filename
    // in its source text -- only files that IMPORT it do. So the only
    // expected match is the CLI's own import line.
    expect(matches.sort()).toEqual(['scripts/anthropic-provider-diagnostic.ts'])
  })
})

describe('anthropic-workspace-config.ts -- never reaches the client bundle', () => {
  it('is never imported anywhere under app/ or components/ (server-only: provider-adapter.ts, extraction-service.ts, and the diagnostic CLI)', () => {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    const matches: string[] = []
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue
        const full = join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (/\.tsx?$/.test(entry)) {
          const text = readFileSync(full, 'utf8')
          if (text.includes('anthropic-workspace-config')) matches.push(full.slice(REPO_ROOT.length + 1).replace(/\\/g, '/'))
        }
      }
    }
    walk(join(REPO_ROOT, 'app'))
    walk(join(REPO_ROOT, 'components'))
    expect(matches).toEqual([])
  })
})

describe('anthropic-provider-diagnostic.ps1 -- source policy', () => {
  const psSource = readFileSync(join(REPO_ROOT, 'scripts', 'anthropic-provider-diagnostic.ps1'), 'utf8')

  it('uses Read-Host -AsSecureString for the key, never a plain string prompt', () => {
    expect(psSource).toMatch(/Read-Host -AsSecureString/)
  })
  it('never writes the key to a file (no Set-Content/Out-File/Add-Content of the key)', () => {
    expect(psSource).not.toMatch(/Set-Content|Out-File|Add-Content/)
  })
  it('clears ANTHROPIC_API_KEY in a finally block (Ctrl+C/error-safe cleanup)', () => {
    expect(psSource).toMatch(/finally\s*\{[\s\S]*?Remove-Item Env:\\ANTHROPIC_API_KEY/)
  })
  it('does not run the diagnostic call without an explicit typed confirmation', () => {
    expect(psSource).toMatch(/Type YES/)
    expect(psSource).toMatch(/-cne 'YES'/)
  })
  it('PFM workspace header: prompts for ANTHROPIC_WORKSPACE_ID via its OWN separate Read-Host -AsSecureString call, not reused from the API key prompt', () => {
    const secureStringPrompts = psSource.match(/Read-Host -AsSecureString/g) ?? []
    expect(secureStringPrompts.length).toBeGreaterThanOrEqual(2)
    expect(psSource).toMatch(/Read-Host -AsSecureString 'ANTHROPIC_WORKSPACE_ID'/)
  })
  it('PFM workspace header: clears ANTHROPIC_WORKSPACE_ID in the same finally block as the API key', () => {
    expect(psSource).toMatch(/finally\s*\{[\s\S]*?Remove-Item Env:\\ANTHROPIC_WORKSPACE_ID/)
  })
  it('PFM workspace header: never writes the workspace ID to a file either', () => {
    expect(psSource).not.toMatch(/Set-Content|Out-File|Add-Content/)
  })

  it('PFM auth-scope-mode: offers a closed, validated choice (1/2) -- never a free-text mode prompt', () => {
    expect(psSource).toMatch(/\[1\] workspace_scoped/)
    expect(psSource).toMatch(/\[2\] identity_linked/)
    expect(psSource).toMatch(/while\s*\(\$true\)/) // validation loop -- only 1 or 2 accepted
    expect(psSource).toMatch(/authScopeMode = 'workspace_scoped'/)
    expect(psSource).toMatch(/authScopeMode = 'identity_linked'/)
  })

  it('PFM auth-scope-mode: the workspace ID prompt is conditionally guarded on identity_linked mode, not unconditional', () => {
    expect(psSource).toMatch(/if \(\$authScopeMode -eq 'identity_linked'\)\s*\{[\s\S]*?Read-Host -AsSecureString 'ANTHROPIC_WORKSPACE_ID'/)
  })

  it('PFM auth-scope-mode: workspace_scoped mode unconditionally clears any leftover ANTHROPIC_WORKSPACE_ID before the child process starts', () => {
    expect(psSource).toMatch(/else\s*\{[\s\S]*?Remove-Item Env:\\ANTHROPIC_WORKSPACE_ID -ErrorAction SilentlyContinue/)
  })

  it('PFM auth-scope-mode: sets ANTHROPIC_AUTH_SCOPE_MODE for the child process and clears it in the finally block too', () => {
    expect(psSource).toMatch(/\$env:ANTHROPIC_AUTH_SCOPE_MODE = \$authScopeMode/)
    expect(psSource).toMatch(/finally\s*\{[\s\S]*?Remove-Item Env:\\ANTHROPIC_AUTH_SCOPE_MODE/)
  })

  it('PFM auth-scope-mode: reminds the operator to close the PowerShell window after use', () => {
    expect(psSource).toMatch(/Zard be ezt a PowerShell-ablakot/)
  })
})

// ===========================================================================
// Functional: real subprocess, config-error paths (no network needed).
// ===========================================================================
describe('anthropic-provider-diagnostic.ts -- config-error preconditions (real subprocess, no network)', () => {
  it('without --confirm-diagnostic: prints help, exits 1, never touches ANTHROPIC_API_KEY', async () => {
    const result = await runCli([], { ANTHROPIC_API_KEY: undefined })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('Usage:')
  })

  it('--help: prints help, exits 0, never makes a call even with a confirmation flag also present', async () => {
    const result = await runCli(['--confirm-diagnostic', '--help'], { ANTHROPIC_API_KEY: undefined })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage:')
  })

  it('--confirm-diagnostic with NO ANTHROPIC_API_KEY set: exits 1 before any network attempt', async () => {
    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: undefined })
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toMatch(/ANTHROPIC_API_KEY is not set/)
  })

  it('--confirm-diagnostic with an EMPTY ANTHROPIC_API_KEY: exits 1 before any network attempt', async () => {
    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: '' })
    expect(result.exitCode).toBe(1)
  })

  it('--confirm-diagnostic in identity_linked mode with NO ANTHROPIC_WORKSPACE_ID set: exits 1 before any network attempt', async () => {
    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_WORKSPACE_ID: undefined })
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toMatch(/auth scope mode\/workspace is not configured/)
    expect(result.stdout + result.stderr).toMatch(/anthropic_workspace_id_missing/)
  })

  it('--confirm-diagnostic with NO ANTHROPIC_AUTH_SCOPE_MODE set at all: exits 1 before any network attempt', async () => {
    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_AUTH_SCOPE_MODE: undefined })
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toMatch(/auth_scope_mode_missing/)
  })

  it('--confirm-diagnostic with an UNKNOWN ANTHROPIC_AUTH_SCOPE_MODE: exits 1 before any network attempt', async () => {
    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_AUTH_SCOPE_MODE: 'multi_workspace' })
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toMatch(/auth_scope_mode_unknown/)
  })


  it('--confirm-diagnostic with a WHITESPACE-ONLY ANTHROPIC_WORKSPACE_ID: exits 1 before any network attempt', async () => {
    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_WORKSPACE_ID: '   ' })
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toMatch(/anthropic_workspace_id_missing/)
  })

  it('--confirm-diagnostic with a MALFORMED ANTHROPIC_WORKSPACE_ID (no wrkspc_ prefix): exits 1 before any network attempt', async () => {
    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_WORKSPACE_ID: 'not-a-workspace-id' })
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toMatch(/anthropic_workspace_id_invalid_format/)
  })

  it('a config-error exit for a missing/invalid workspace ID never echoes the raw configured value', async () => {
    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_WORKSPACE_ID: 'totally-bogus-value-should-never-appear' })
    expect(result.stdout + result.stderr).not.toContain('totally-bogus-value-should-never-appear')
  })
})

// ===========================================================================
// Functional: real subprocess against a LOCAL mock HTTP server (the SDK
// reads ANTHROPIC_BASE_URL itself, confirmed against node_modules/@anthropic-ai/sdk/index.js).
// Zero real network/provider call.
// ===========================================================================
describe('anthropic-provider-diagnostic.ts -- classified outcomes (real subprocess, mocked HTTP)', () => {
  let server: Server | null = null
  let baseUrl = ''
  let requestCount = 0
  let lastRequestBody: unknown = null
  let lastRequestHeaders: import('node:http').IncomingHttpHeaders | null = null

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
    requestCount = 0
    lastRequestBody = null
    lastRequestHeaders = null
  })

  function startMockServer(respond: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        requestCount += 1
        lastRequestHeaders = req.headers
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          try {
            lastRequestBody = JSON.parse(body)
          } catch {
            lastRequestBody = body
          }
          respond(req, res)
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address()
        if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
  }

  it('success (mocked 200): exits 0, response text is NEVER printed, exactly one request, max_tokens=1', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'this exact secret response text must never be printed by the CLI' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      }))
    })

    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('this exact secret response text must never be printed')
    expect(requestCount).toBe(1)
    expect((lastRequestBody as { max_tokens: number }).max_tokens).toBe(1)
  })

  it('PFM workspace header: the exact configured ANTHROPIC_WORKSPACE_ID is sent as the anthropic-workspace-id header, in BOTH default and --production-parity modes', async () => {
    const respond = (_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      }))
    }
    const workspaceId = 'wrkspc_testFixedValueForHeaderAssertion'

    await startMockServer(respond)
    const defaultResult = await runCli(['--confirm-diagnostic'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_WORKSPACE_ID: workspaceId,
    })
    expect(defaultResult.exitCode).toBe(0)
    expect(lastRequestHeaders?.['anthropic-workspace-id']).toBe(workspaceId)

    await startMockServer(respond)
    const parityResult = await runCli(['--confirm-diagnostic', '--production-parity'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_WORKSPACE_ID: workspaceId,
    })
    expect(parityResult.exitCode).toBe(0)
    expect(lastRequestHeaders?.['anthropic-workspace-id']).toBe(workspaceId)
  })

  it('PFM workspace header: the configured workspace ID never appears in stdout/stderr, not even a prefix or its length', async () => {
    const workspaceId = 'wrkspc_shouldNeverBePrintedAnywhereInOutput'
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      }))
    })

    const result = await runCli(['--confirm-diagnostic'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_WORKSPACE_ID: workspaceId,
    })

    const combined = result.stdout + result.stderr
    expect(combined).not.toContain(workspaceId)
    expect(combined).not.toContain('shouldNeverBePrintedAnywhereInOutput')
    expect(combined).not.toContain(workspaceId.slice(0, 8)) // not even a shortened prefix
  })

  it('PFM workspace header: a missing ANTHROPIC_WORKSPACE_ID makes ZERO HTTP requests to the provider (mock server confirms 0, not just exit code)', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
    })

    const result = await runCli(['--confirm-diagnostic'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_WORKSPACE_ID: undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(requestCount).toBe(0)
  })

  it('PFM workspace header: an INVALID-FORMAT ANTHROPIC_WORKSPACE_ID makes ZERO HTTP requests to the provider', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
    })

    const result = await runCli(['--confirm-diagnostic'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_WORKSPACE_ID: 'nope',
    })

    expect(result.exitCode).toBe(1)
    expect(requestCount).toBe(0)
  })

  it('PFM auth-scope-mode: workspace_scoped mode succeeds with exactly one call and NO anthropic-workspace-id header at all -- not even an empty one', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 },
      }))
    })

    const result = await runCli(['--confirm-diagnostic'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_SCOPE_MODE: 'workspace_scoped', ANTHROPIC_WORKSPACE_ID: undefined,
    })

    expect(result.exitCode).toBe(0)
    expect(requestCount).toBe(1)
    expect(lastRequestHeaders).not.toHaveProperty('anthropic-workspace-id')
  })

  it('PFM auth-scope-mode: workspace_scoped mode never sends the header even if a leftover ANTHROPIC_WORKSPACE_ID is present in the environment', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 },
      }))
    })
    const leftoverId = 'wrkspc_shouldNeverBeSentInWorkspaceScopedMode'

    const result = await runCli(['--confirm-diagnostic'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_SCOPE_MODE: 'workspace_scoped', ANTHROPIC_WORKSPACE_ID: leftoverId,
    })

    expect(result.exitCode).toBe(0)
    expect(requestCount).toBe(1)
    expect(lastRequestHeaders).not.toHaveProperty('anthropic-workspace-id')
    expect(result.stdout + result.stderr).not.toContain(leftoverId)
  })

  it('PFM auth-scope-mode: missing ANTHROPIC_AUTH_SCOPE_MODE makes ZERO HTTP requests to the provider', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
    })

    const result = await runCli(['--confirm-diagnostic'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_SCOPE_MODE: undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(requestCount).toBe(0)
  })

  it('PFM auth-scope-mode: an unknown ANTHROPIC_AUTH_SCOPE_MODE makes ZERO HTTP requests to the provider', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
    })

    const result = await runCli(['--confirm-diagnostic'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_SCOPE_MODE: 'multi_workspace',
    })

    expect(result.exitCode).toBe(1)
    expect(requestCount).toBe(0)
  })

  it('mocked 401: exits 2, classified authentication_failed, httpStatus 401, no retry (exactly one request), sanitized providerErrorType/message visible', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_test123456789' }))
    })

    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl })

    expect(result.exitCode).toBe(2)
    expect(result.stdout + result.stderr).toMatch(/"category":"authentication_failed"/)
    expect(result.stdout + result.stderr).toMatch(/"httpStatus":401/)
    expect(result.stdout + result.stderr).toMatch(/"providerErrorType":"authentication_error"/)
    expect(result.stdout + result.stderr).toMatch(/"sanitizedProviderMessage":"invalid x-api-key"/)
    expect(requestCount).toBe(1)
  })

  it('mocked 400 with a spend-limit-shaped message: category invalid_request_unbilled, sanitized message readable, no secrets leaked', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your organization has reached its configured spend limit. Contact your workspace admin. (key sk-ant-api03-fakefakefakefakefake, req_abcdefghijklmnop)' },
        request_id: 'req_abcdefghijklmnop',
      }))
    })

    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl })
    const combined = result.stdout + result.stderr

    expect(result.exitCode).toBe(2)
    expect(combined).toMatch(/"category":"invalid_request_unbilled"/)
    expect(combined).toMatch(/"providerErrorType":"invalid_request_error"/)
    expect(combined).toMatch(/spend limit/)
    expect(combined).not.toContain('sk-ant-api03-fakefakefakefakefake')
    expect(combined).not.toContain('req_abcdefghijklmnop')
  })

  it('mocked 403: exits 2, classified permission_denied, httpStatus 403', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'no access to this model' } }))
    })

    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl })

    expect(result.exitCode).toBe(2)
    expect(result.stdout + result.stderr).toMatch(/"category":"permission_denied"/)
    expect(result.stdout + result.stderr).toMatch(/"httpStatus":403/)
  })

  it('mocked 404: exits 2, classified model_or_endpoint_not_found, httpStatus 404', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model not found' } }))
    })

    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl })

    expect(result.exitCode).toBe(2)
    expect(result.stdout + result.stderr).toMatch(/"category":"model_or_endpoint_not_found"/)
    expect(result.stdout + result.stderr).toMatch(/"httpStatus":404/)
  })

  it('--production-parity: sends max_tokens matching AI_QUOTA_MAX_OUTPUT_TOKENS (1024) AND a system parameter, unlike the default minimal mode', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      }))
    })

    const result = await runCli(['--confirm-diagnostic', '--production-parity'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl })

    expect(result.exitCode).toBe(0)
    expect(requestCount).toBe(1)
    const body = lastRequestBody as { max_tokens: number; system?: string }
    expect(body.max_tokens).toBe(1024)
    expect(typeof body.system).toBe('string')
    expect(body.system!.length).toBeGreaterThan(0)
    // PFM Workspace-Scoped Production-Parity Diagnostic gate: the logged
    // timeoutMs must also reflect the parity-mode value (60000), not the
    // cheaper default-mode value (15000).
    expect(result.stdout + result.stderr).toMatch(/"timeoutMs":60000/)
  })

  it('default mode (no --production-parity): max_tokens=1, no system parameter at all', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      }))
    })

    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl })

    expect(result.exitCode).toBe(0)
    const body = lastRequestBody as { max_tokens: number; system?: string }
    expect(body.max_tokens).toBe(1)
    expect(body.system).toBeUndefined()
    expect(result.stdout + result.stderr).toMatch(/"timeoutMs":15000/)
  })

  it('mocked timeout (server never responds): exits 3, timeout/uncertain, fail-closed, no crash', async () => {
    await startMockServer(() => {
      // Deliberately never calls res.end() -- the client's own 15s timeout
      // (set in the CLI itself) will fire well within this test's own
      // vitest timeout.
    })

    const result = await runCli(['--confirm-diagnostic'], { ANTHROPIC_API_KEY: 'sk-ant-test-fake-key-not-real', ANTHROPIC_BASE_URL: baseUrl })

    expect(result.exitCode).toBe(3)
    expect(requestCount).toBe(1) // exactly one attempt, no retry after the timeout either
  }, 25_000)
})
