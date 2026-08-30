// PFM Anthropic Provider Failure Taxonomy v0 -- pure unit tests. No network,
// no DB, no ANTHROPIC_API_KEY. Constructs real Anthropic.APIError instances
// (not string/message-pattern fakes) so this proves the classifier branches
// on the SDK's own structured `status` field, never on error text.
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import {
  classifyProviderFailure,
  MALFORMED_OUTPUT_CHARGED_CLASSIFICATION,
  COMMIT_FAILED_CLASSIFICATION,
  type ProviderFailureCategory,
} from '@/lib/semantic-topic/provider-error-taxonomy'

function apiError(status: number | undefined, message = 'provider error'): InstanceType<typeof Anthropic.APIError> {
  return new Anthropic.APIError(status, {}, message, undefined)
}

describe('classifyProviderFailure -- every documented HTTP category', () => {
  const cases: Array<{ status: number; category: ProviderFailureCategory; billed: string; retryPolicy: string }> = [
    { status: 400, category: 'invalid_request_unbilled', billed: 'unbilled', retryPolicy: 'batch_stop_required' },
    { status: 401, category: 'authentication_failed', billed: 'unbilled', retryPolicy: 'batch_stop_required' },
    { status: 403, category: 'permission_denied', billed: 'unbilled', retryPolicy: 'batch_stop_required' },
    { status: 404, category: 'model_or_endpoint_not_found', billed: 'unbilled', retryPolicy: 'batch_stop_required' },
    { status: 429, category: 'rate_limited', billed: 'uncertain', retryPolicy: 'conservative_uncertain' },
    { status: 500, category: 'provider_server_error', billed: 'uncertain', retryPolicy: 'conservative_uncertain' },
    { status: 503, category: 'provider_server_error', billed: 'uncertain', retryPolicy: 'conservative_uncertain' },
    { status: 529, category: 'provider_server_error', billed: 'uncertain', retryPolicy: 'conservative_uncertain' },
  ]

  for (const { status, category, billed, retryPolicy } of cases) {
    it(`HTTP ${status} -> category=${category}, billed=${billed}, retryPolicy=${retryPolicy}`, () => {
      const result = classifyProviderFailure(apiError(status))
      expect(result).toEqual({ category, httpStatus: status, billed, retryPolicy })
    })
  }

  it('an unlisted 4xx (e.g. 422) with a real structured status still fails closed as unbilled-unknown, never falls through to network/timeout', () => {
    const result = classifyProviderFailure(apiError(422))
    expect(result).toEqual({ category: 'provider_rejected_unbilled_unknown', httpStatus: 422, billed: 'unbilled', retryPolicy: 'batch_stop_required' })
  })

  it('an unlisted 3xx/other non-4xx/5xx status also falls into the unbilled-unknown fallback (still a real, structured status)', () => {
    const result = classifyProviderFailure(apiError(304))
    expect(result.category).toBe('provider_rejected_unbilled_unknown')
    expect(result.httpStatus).toBe(304)
  })
})

describe('classifyProviderFailure -- no structured HTTP status at all', () => {
  it('a timeout (APIConnectionTimeoutError, status undefined) classifies as network_or_transport_uncertain, uncertain/conservative', () => {
    const err = new Anthropic.APIConnectionTimeoutError()
    const result = classifyProviderFailure(err)
    expect(result).toEqual({ category: 'network_or_transport_uncertain', httpStatus: null, billed: 'uncertain', retryPolicy: 'conservative_uncertain' })
  })

  it('a plain network Error (ECONNRESET-style, not even an APIError instance) also classifies as network_or_transport_uncertain', () => {
    const err = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' })
    const result = classifyProviderFailure(err)
    expect(result).toEqual({ category: 'network_or_transport_uncertain', httpStatus: null, billed: 'uncertain', retryPolicy: 'conservative_uncertain' })
  })

  it('a completely unrecognized thrown value (not even an Error) still fails to the conservative uncertain bucket, never throws itself', () => {
    expect(() => classifyProviderFailure('not even an error object')).not.toThrow()
    expect(classifyProviderFailure(undefined)).toEqual({ category: 'network_or_transport_uncertain', httpStatus: null, billed: 'uncertain', retryPolicy: 'conservative_uncertain' })
  })
})

describe('classifyProviderFailure -- never branches on error text/message', () => {
  it('an APIError whose message happens to contain another status number entirely ignores the text and uses only the real status', () => {
    const err = apiError(401, 'this message mentions 500 and 429 but the real status is 401')
    const result = classifyProviderFailure(err)
    expect(result.category).toBe('authentication_failed')
    expect(result.httpStatus).toBe(401)
  })
})

describe('safe display fields only -- never a raw provider object', () => {
  it('the classification never carries err.error, err.headers, err.message, or err.request_id -- only category/httpStatus/billed/retryPolicy', () => {
    const err = apiError(403, 'permission denied: workspace does not have access to model X')
    const result = classifyProviderFailure(err)
    const keys = Object.keys(result).sort()
    expect(keys).toEqual(['billed', 'category', 'httpStatus', 'retryPolicy'])
  })
})

describe('static classification constants', () => {
  it('MALFORMED_OUTPUT_CHARGED_CLASSIFICATION is billed + never_automatic', () => {
    expect(MALFORMED_OUTPUT_CHARGED_CLASSIFICATION).toEqual({ category: 'malformed_output_charged', httpStatus: null, billed: 'billed', retryPolicy: 'never_automatic' })
  })
  it('COMMIT_FAILED_CLASSIFICATION is uncertain + conservative_uncertain', () => {
    expect(COMMIT_FAILED_CLASSIFICATION).toEqual({ category: 'network_or_transport_uncertain', httpStatus: null, billed: 'uncertain', retryPolicy: 'conservative_uncertain' })
  })
})
