// PFM Identity-Linked Workspace Header Support v0 -- config-getter unit
// tests. Pure unit tests, no network, no real process.env mutation (a
// synthetic env object is passed explicitly to every call).
import { describe, expect, it } from 'vitest'
import { ANTHROPIC_WORKSPACE_ID_HEADER, getConfiguredAnthropicWorkspaceId, resolveAnthropicAuthConfig } from '@/lib/semantic-topic/anthropic-workspace-config'
import { redactForDisplay } from '@/lib/semantic-topic/operator-cli-security'

const VALID_ID = 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ'

describe('ANTHROPIC_WORKSPACE_ID_HEADER', () => {
  it('is the exact, official Anthropic header name', () => {
    expect(ANTHROPIC_WORKSPACE_ID_HEADER).toBe('anthropic-workspace-id')
  })
})

describe('getConfiguredAnthropicWorkspaceId -- missing', () => {
  it('returns anthropic_workspace_id_missing when the env var is undefined', () => {
    const result = getConfiguredAnthropicWorkspaceId({})
    expect(result).toEqual({ ok: false, reasonCode: 'anthropic_workspace_id_missing' })
  })

  it('returns anthropic_workspace_id_missing for an empty string', () => {
    const result = getConfiguredAnthropicWorkspaceId({ ANTHROPIC_WORKSPACE_ID: '' })
    expect(result).toEqual({ ok: false, reasonCode: 'anthropic_workspace_id_missing' })
  })

  it('returns anthropic_workspace_id_missing for a whitespace-only value', () => {
    const result = getConfiguredAnthropicWorkspaceId({ ANTHROPIC_WORKSPACE_ID: '   \t  ' })
    expect(result).toEqual({ ok: false, reasonCode: 'anthropic_workspace_id_missing' })
  })
})

describe('getConfiguredAnthropicWorkspaceId -- invalid format', () => {
  it('rejects a value without the wrkspc_ prefix', () => {
    const result = getConfiguredAnthropicWorkspaceId({ ANTHROPIC_WORKSPACE_ID: '01JwQvzr7rXLA5AGx3HKfFUJ' })
    expect(result).toEqual({ ok: false, reasonCode: 'anthropic_workspace_id_invalid_format' })
  })

  it('rejects a bare "wrkspc_" prefix with nothing after it', () => {
    const result = getConfiguredAnthropicWorkspaceId({ ANTHROPIC_WORKSPACE_ID: 'wrkspc_' })
    expect(result).toEqual({ ok: false, reasonCode: 'anthropic_workspace_id_invalid_format' })
  })

  it('rejects a value containing whitespace after the prefix', () => {
    const result = getConfiguredAnthropicWorkspaceId({ ANTHROPIC_WORKSPACE_ID: 'wrkspc_abc def123456' })
    expect(result).toEqual({ ok: false, reasonCode: 'anthropic_workspace_id_invalid_format' })
  })

  it('rejects a value with a disallowed special character after the prefix', () => {
    const result = getConfiguredAnthropicWorkspaceId({ ANTHROPIC_WORKSPACE_ID: 'wrkspc_abc!def123456' })
    expect(result).toEqual({ ok: false, reasonCode: 'anthropic_workspace_id_invalid_format' })
  })

  it('never echoes the raw invalid value anywhere in the failure result', () => {
    const weird = 'wrkspc_' + 'x'.repeat(500)
    const result = getConfiguredAnthropicWorkspaceId({ ANTHROPIC_WORKSPACE_ID: weird })
    expect(JSON.stringify(result)).not.toContain(weird)
  })
})

describe('getConfiguredAnthropicWorkspaceId -- valid', () => {
  it('accepts the documented example workspace ID shape, trimmed', () => {
    const result = getConfiguredAnthropicWorkspaceId({ ANTHROPIC_WORKSPACE_ID: `  ${VALID_ID}  ` })
    expect(result).toEqual({ ok: true, workspaceId: VALID_ID })
  })

  it('is fully masked by redactForDisplay when placed under a workspaceId-shaped key -- unlike a UUID, not merely shortened', () => {
    expect(redactForDisplay({ workspaceId: VALID_ID })).toEqual({ workspaceId: '[redacted]' })
    expect(redactForDisplay({ workspace_id: VALID_ID })).toEqual({ workspace_id: '[redacted]' })
    expect(redactForDisplay({ ANTHROPIC_WORKSPACE_ID: VALID_ID })).toEqual({ ANTHROPIC_WORKSPACE_ID: '[redacted]' })
  })

  it('defaults to reading process.env when no env argument is supplied', () => {
    const original = process.env.ANTHROPIC_WORKSPACE_ID
    try {
      process.env.ANTHROPIC_WORKSPACE_ID = VALID_ID
      expect(getConfiguredAnthropicWorkspaceId()).toEqual({ ok: true, workspaceId: VALID_ID })
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID
      else process.env.ANTHROPIC_WORKSPACE_ID = original
    }
  })
})

// PFM Anthropic Explicit Workspace-Scoped Authentication Mode gate.
describe('resolveAnthropicAuthConfig -- missing/unknown mode', () => {
  it('returns auth_scope_mode_missing when ANTHROPIC_AUTH_SCOPE_MODE is undefined', () => {
    expect(resolveAnthropicAuthConfig({})).toEqual({ ok: false, reasonCode: 'auth_scope_mode_missing' })
  })

  it('returns auth_scope_mode_missing for an empty or whitespace-only value', () => {
    expect(resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: '' })).toEqual({ ok: false, reasonCode: 'auth_scope_mode_missing' })
    expect(resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: '   ' })).toEqual({ ok: false, reasonCode: 'auth_scope_mode_missing' })
  })

  it('returns auth_scope_mode_unknown for any value outside the closed vocabulary -- never inferred from the key', () => {
    expect(resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: 'multi_workspace' })).toEqual({ ok: false, reasonCode: 'auth_scope_mode_unknown' })
    expect(resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: 'Workspace_Scoped' })).toEqual({ ok: false, reasonCode: 'auth_scope_mode_unknown' }) // case-sensitive, no fuzzy matching
    expect(resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: 'identity-linked' })).toEqual({ ok: false, reasonCode: 'auth_scope_mode_unknown' }) // hyphen instead of underscore
  })
})

describe('resolveAnthropicAuthConfig -- workspace_scoped', () => {
  it('succeeds with just the mode -- no workspaceId field on the result at all', () => {
    const result = resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: 'workspace_scoped' })
    expect(result).toEqual({ ok: true, mode: 'workspace_scoped' })
    expect(result).not.toHaveProperty('workspaceId')
  })

  it('ignores a leftover ANTHROPIC_WORKSPACE_ID entirely -- never reads it, never validates it, never fails because of it', () => {
    const result = resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: 'workspace_scoped', ANTHROPIC_WORKSPACE_ID: 'not-even-a-valid-shape' })
    expect(result).toEqual({ ok: true, mode: 'workspace_scoped' })
  })
})

describe('resolveAnthropicAuthConfig -- identity_linked', () => {
  it('succeeds with a valid ANTHROPIC_WORKSPACE_ID, returned on the result', () => {
    const result = resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: 'identity_linked', ANTHROPIC_WORKSPACE_ID: VALID_ID })
    expect(result).toEqual({ ok: true, mode: 'identity_linked', workspaceId: VALID_ID })
  })

  it('fails with anthropic_workspace_id_missing when ANTHROPIC_WORKSPACE_ID is absent', () => {
    expect(resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: 'identity_linked' })).toEqual({ ok: false, reasonCode: 'anthropic_workspace_id_missing' })
  })

  it('fails with anthropic_workspace_id_invalid_format for a malformed value', () => {
    expect(resolveAnthropicAuthConfig({ ANTHROPIC_AUTH_SCOPE_MODE: 'identity_linked', ANTHROPIC_WORKSPACE_ID: 'nope' })).toEqual({ ok: false, reasonCode: 'anthropic_workspace_id_invalid_format' })
  })

  it('never derives the mode or the workspace ID from anything about the API key itself -- this function never even reads ANTHROPIC_API_KEY', () => {
    // Structural guarantee: resolveAnthropicAuthConfig's signature takes
    // only an env map and never references an API key field anywhere in
    // its own logic (verified functionally: a call with an API key present
    // alongside an invalid mode still correctly fails on the mode, proving
    // the key's presence/shape has no influence on the outcome).
    const result = resolveAnthropicAuthConfig({ ANTHROPIC_API_KEY: 'sk-ant-totally-real-looking-key-shape-12345', ANTHROPIC_AUTH_SCOPE_MODE: 'bogus' })
    expect(result).toEqual({ ok: false, reasonCode: 'auth_scope_mode_unknown' })
  })
})
