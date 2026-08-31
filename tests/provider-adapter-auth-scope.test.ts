// PFM Anthropic Explicit Workspace-Scoped Authentication Mode gate --
// buildAnthropicClientOptions() unit tests. Pure function, no network, no
// SDK mocking needed (it never constructs the Anthropic client itself,
// only returns the options object provider-adapter.ts then passes to it).
import { describe, expect, it } from 'vitest'
import { buildAnthropicClientOptions } from '@/lib/semantic-topic/provider-adapter'
import { ANTHROPIC_WORKSPACE_ID_HEADER } from '@/lib/semantic-topic/anthropic-workspace-config'

const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

describe('buildAnthropicClientOptions -- the shared request-builder both auth-scope branches route through', () => {
  it('workspace_scoped: the returned options object has NO defaultHeaders key at all -- not empty, not undefined, absent', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-key-not-real'
    try {
      const options = buildAnthropicClientOptions({ ok: true, mode: 'workspace_scoped' })
      expect(options).not.toHaveProperty('defaultHeaders')
      expect(Object.keys(options)).toEqual(['apiKey', 'timeout', 'maxRetries'])
      expect(options.timeout).toBe(60_000)
      expect(options.maxRetries).toBe(0)
    } finally {
      if (ORIGINAL_ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY
    }
  })

  it('identity_linked: the returned options object carries defaultHeaders with EXACTLY the anthropic-workspace-id header and the configured value', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-key-not-real'
    try {
      const workspaceId = 'wrkspc_testFixedValueForAdapterAssertion'
      const options = buildAnthropicClientOptions({ ok: true, mode: 'identity_linked', workspaceId })
      expect(options.defaultHeaders).toEqual({ [ANTHROPIC_WORKSPACE_ID_HEADER]: workspaceId })
      expect(Object.keys(options.defaultHeaders as object)).toEqual(['anthropic-workspace-id'])
      expect(options.timeout).toBe(60_000)
      expect(options.maxRetries).toBe(0)
    } finally {
      if (ORIGINAL_ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY
    }
  })

  it('there is structurally no way for a workspace_scoped call to carry a workspaceId anywhere -- the input type itself has no such field in that branch', () => {
    // TypeScript-level guarantee, exercised at runtime: constructing a
    // workspace_scoped authConfig literal with an extra field would be a
    // compile error, so this call only compiles because the type is
    // exactly { ok: true; mode: 'workspace_scoped' } -- no workspaceId
    // possible. This test's only job is to confirm the RUNTIME output
    // never accidentally introduces one either.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-key-not-real'
    try {
      const options = buildAnthropicClientOptions({ ok: true, mode: 'workspace_scoped' })
      expect(JSON.stringify(options)).not.toMatch(/wrkspc_/)
      expect(JSON.stringify(options)).not.toContain('workspace')
    } finally {
      if (ORIGINAL_ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY
    }
  })
})
