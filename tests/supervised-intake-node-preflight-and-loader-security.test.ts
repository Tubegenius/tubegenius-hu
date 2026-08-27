// PFM Supervised Production Candidate Intake v0 -- Node/runtime preflight
// (section 9): the CLI (scripts/supervised-intake-runner.ts) uses this
// Node version's native TypeScript support directly, with a custom ESM
// resolution hook (scripts/ts-alias-loader.mjs) layered on top to restore
// the `@/` path alias and extension-less relative-import resolution
// Next.js's bundler normally provides. This file is pure static-source and
// direct-loader-function testing -- no Docker, no network, no subprocess.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const cliSource = readFileSync(join(process.cwd(), 'scripts/supervised-intake-runner.ts'), 'utf8')

describe('CLI entrypoint -- production-boundary and version-preflight guarantees', () => {
  it('no file under scripts/ (the CLI entry or its alias loader) is imported by anything under app/ or lib/ -- never bundled into the client, never a route, never a shared server module', () => {
    let anyReferencesScripts = false
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        const text = readFileSync(full, 'utf8')
        if (/from ['"].*scripts\/(supervised-intake-runner|ts-alias-loader)/.test(text)) anyReferencesScripts = true
      }
    }
    walk(join(process.cwd(), 'app'))
    walk(join(process.cwd(), 'lib'))
    expect(anyReferencesScripts).toBe(false)
  })

  it('the Node-version preflight check runs before register() is ever called, and requires exactly Node >= 24 (native TypeScript support)', () => {
    const registerIndex = cliSource.indexOf("register('./ts-alias-loader.mjs'")
    const preflightIndex = cliSource.indexOf('MINIMUM_NODE_MAJOR_VERSION')
    expect(preflightIndex).toBeGreaterThan(-1)
    expect(registerIndex).toBeGreaterThan(-1)
    expect(preflightIndex).toBeLessThan(registerIndex)
    expect(cliSource).toMatch(/MINIMUM_NODE_MAJOR_VERSION\s*=\s*24/)
  })

  it('required-environment-variable check runs before createAdminClient() is ever constructed', () => {
    const envCheckIndex = cliSource.indexOf('missingEnvVars')
    const adminClientIndex = cliSource.indexOf('const client = createAdminClient()')
    expect(envCheckIndex).toBeGreaterThan(-1)
    expect(adminClientIndex).toBeGreaterThan(-1)
    expect(envCheckIndex).toBeLessThan(adminClientIndex)
  })
})

describe('ts-alias-loader.mjs -- @/ path-traversal guard', () => {
  it('refuses to resolve an @/ specifier that would escape the project root, even though every real call site in this closed source tree only ever writes a traversal-free specifier', async () => {
    const { resolve } = await import('../scripts/ts-alias-loader.mjs')
    await expect(
      resolve('@/../../../../outside-the-project', {}, async () => ({ url: 'should-never-be-reached' })),
    ).rejects.toThrow(/refusing to resolve/)
  })

  it('still resolves a normal, traversal-free @/ specifier via the real Node resolver', async () => {
    const { resolve } = await import('../scripts/ts-alias-loader.mjs')
    let nextResolveCalledWith: string | null = null
    await resolve('@/lib/semantic-topic/quota-types', {}, async (target: string) => {
      nextResolveCalledWith = target
      return { url: 'file:///fake' }
    })
    expect(nextResolveCalledWith).toMatch(/lib\/semantic-topic\/quota-types$/)
  })

  it('passes a bare package specifier straight through, untouched', async () => {
    const { resolve } = await import('../scripts/ts-alias-loader.mjs')
    let nextResolveCalledWith: string | null = null
    await resolve('node:crypto', {}, async (target: string) => {
      nextResolveCalledWith = target
      return { url: 'node:crypto' }
    })
    expect(nextResolveCalledWith).toBe('node:crypto')
  })
})
