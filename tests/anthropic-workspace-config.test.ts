// PFM Identity-Linked Workspace Header Support v0 -- config-getter unit
// tests. Pure unit tests, no network, no real process.env mutation (a
// synthetic env object is passed explicitly to every call).
import { describe, expect, it } from 'vitest'
import { ANTHROPIC_WORKSPACE_ID_HEADER, getConfiguredAnthropicWorkspaceId } from '@/lib/semantic-topic/anthropic-workspace-config'
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
