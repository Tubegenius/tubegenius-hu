// PFM Anthropic HTTP 400 Remediation Gate -- safe, display-only error
// detail sanitization. Pure unit tests, no network.
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { extractSafeProviderErrorDetail, sanitizeProviderErrorMessage } from '@/lib/semantic-topic/provider-error-diagnostic-detail'

function apiError(status: number, errorBody: object, message: string): InstanceType<typeof Anthropic.APIError> {
  return new Anthropic.APIError(status, errorBody, message, undefined)
}

describe('extractSafeProviderErrorDetail -- providerErrorType', () => {
  it('extracts the provider error.type field from a real APIError', () => {
    const err = apiError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: field required' } }, 'invalid_request_error')
    const detail = extractSafeProviderErrorDetail(err)
    expect(detail.providerErrorType).toBe('invalid_request_error')
  })

  it('returns null providerErrorType for a non-APIError value', () => {
    expect(extractSafeProviderErrorDetail(new Error('plain error')).providerErrorType).toBeNull()
    expect(extractSafeProviderErrorDetail('not an error').providerErrorType).toBeNull()
    expect(extractSafeProviderErrorDetail(undefined).providerErrorType).toBeNull()
  })

  it('returns null providerErrorType when the error body has no type field', () => {
    const err = apiError(400, {}, 'some message')
    expect(extractSafeProviderErrorDetail(err).providerErrorType).toBeNull()
  })
})

describe('sanitizeProviderErrorMessage -- secret masking', () => {
  it('masks an Anthropic API key embedded in the message', () => {
    const msg = sanitizeProviderErrorMessage('request rejected: key sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890 is invalid')
    expect(msg).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890')
    expect(msg).toContain('[redacted]')
  })

  it('masks a Supabase secret key', () => {
    // Built from harmless parts at runtime -- deliberately never a single
    // contiguous `sb_secret_...`-shaped literal anywhere in this file's own
    // source text, so no source-control secret scanner (this repo's own or
    // GitHub's push protection) can ever flag this test file itself, while
    // the actual RUNTIME string is still a fully real, matchable value that
    // genuinely exercises sanitizeProviderErrorMessage's regex.
    const fakeSecretSuffix = Array.from({ length: 40 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(i % 36)).join('')
    const fakeSupabaseSecret = ['sb', 'secret'].join('_') + '_' + fakeSecretSuffix
    const msg = sanitizeProviderErrorMessage(`${fakeSupabaseSecret} leaked in header`)
    expect(msg).not.toContain(fakeSupabaseSecret)
    expect(msg).toContain('[redacted]')
  })

  it('masks a Bearer token', () => {
    const msg = sanitizeProviderErrorMessage('Authorization header was Bearer abcdefghijklmnopqrstuvwxyz123456')
    expect(msg).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
  })

  it('masks a JWT-shaped token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_fake_signature_x'
    const msg = sanitizeProviderErrorMessage(`token was ${jwt}`)
    expect(msg).not.toContain(jwt)
  })

  it('masks a generic key=value-shaped credential pattern', () => {
    const msg = sanitizeProviderErrorMessage('api_key: abcdef0123456789 was rejected')
    expect(msg).not.toContain('abcdef0123456789')
  })
})

describe('sanitizeProviderErrorMessage -- UUID shortening', () => {
  it('shortens a full UUID to an 8-char prefix, never removes it entirely', () => {
    const msg = sanitizeProviderErrorMessage('evidence 978a0bbf-aa11-43dc-996e-e2da873ed2d1 caused this')
    expect(msg).not.toContain('978a0bbf-aa11-43dc-996e-e2da873ed2d1')
    expect(msg).toContain('978a0bbf')
  })
})

describe('sanitizeProviderErrorMessage -- request ID masking', () => {
  it('fully masks a req_ prefixed request ID (not shortened like a UUID)', () => {
    const msg = sanitizeProviderErrorMessage('see request req_011CNsvVzz9CxQK3RS6WvNXo for details')
    expect(msg).not.toContain('req_011CNsvVzz9CxQK3RS6WvNXo')
    expect(msg).toContain('[request-id-redacted]')
  })
})

describe('sanitizeProviderErrorMessage -- control characters and length', () => {
  it('strips CR/LF and other control characters, producing a single printable line', () => {
    const msg = sanitizeProviderErrorMessage('line one\r\nline two\ttabbed\x07bell')
    expect(msg).not.toMatch(/[\r\n]/)
    // eslint-disable-next-line no-control-regex
    expect(msg).not.toMatch(/[\x00-\x1F\x7F-\x9F]/)
  })

  it('truncates to at most 300 characters (plus the ellipsis marker)', () => {
    const longMessage = 'x'.repeat(1000)
    const msg = sanitizeProviderErrorMessage(longMessage)
    expect(msg.length).toBeLessThanOrEqual(301)
    expect(msg.endsWith('…')).toBe(true)
  })

  it('does not add an ellipsis when the message is already within the limit', () => {
    const msg = sanitizeProviderErrorMessage('short message')
    expect(msg).toBe('short message')
    expect(msg.endsWith('…')).toBe(false)
  })
})

describe('sanitizeProviderErrorMessage -- never echoes prompt/request-body/response content by construction', () => {
  it('is a pure function over the message string ONLY -- has no access to the request body, evidence text, or response content at all', () => {
    // Structural guarantee, not a runtime one: the function signature takes
    // a single string and returns a single string, so it CANNOT reach into
    // a request/response object it was never given.
    expect(sanitizeProviderErrorMessage.length).toBe(1)
  })
})

describe('extractSafeProviderErrorDetail -- full pipeline on a realistic 400 error', () => {
  it('sanitizes a realistic invalid_request_error message end-to-end', () => {
    const err = apiError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0.content: field required (request req_011CNsvVzz9CxQK3RS6WvNXo, key sk-ant-api03-fakefakefakefakefake)' } },
      'messages.0.content: field required (request req_011CNsvVzz9CxQK3RS6WvNXo, key sk-ant-api03-fakefakefakefakefake)',
    )
    const detail = extractSafeProviderErrorDetail(err)
    expect(detail.providerErrorType).toBe('invalid_request_error')
    expect(detail.sanitizedMessage).not.toBeNull()
    expect(detail.sanitizedMessage).not.toContain('req_011CNsvVzz9CxQK3RS6WvNXo')
    expect(detail.sanitizedMessage).not.toContain('sk-ant-api03-fakefakefakefakefake')
    expect(detail.sanitizedMessage).toContain('field required')
  })

  it('returns null sanitizedMessage for a non-APIError (network/timeout)', () => {
    const detail = extractSafeProviderErrorDetail(new Error('connect ECONNRESET'))
    expect(detail.sanitizedMessage).toBeNull()
    expect(detail.providerErrorType).toBeNull()
  })
})
