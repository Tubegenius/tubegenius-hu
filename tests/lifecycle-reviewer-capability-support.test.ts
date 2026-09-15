// PFM Lifecycle Reviewer Self-Capability v1 -- support-unit tests for
// lib/semantic-topic/lifecycle-reviewer-capability.ts. Mocked client, no
// DB/network.
import { describe, expect, it, vi } from 'vitest'
import {
  getLifecycleReviewerCapability,
  lifecycleReviewerCapabilityFailureToResponse,
  type LifecycleReviewerCapabilityResult,
} from '@/lib/semantic-topic/lifecycle-reviewer-capability'

function mockClient(rpcImpl: (fn: string, params?: unknown) => Promise<{ data: unknown; error: unknown }>) {
  return { rpc: vi.fn(rpcImpl) } as any
}

describe('getLifecycleReviewerCapability', () => {
  it('active reviewer -- RPC returns true -- maps to success:true', async () => {
    const client = mockClient(async () => ({ data: true, error: null }))
    const result = await getLifecycleReviewerCapability(client)
    expect(result).toEqual({ outcome: 'success', canReviewSemanticTopicLifecycle: true })
  })

  it('inactive reviewer / non-reviewer -- RPC returns false -- maps to success:false, indistinguishable from each other at this layer', async () => {
    const client = mockClient(async () => ({ data: false, error: null }))
    const result = await getLifecycleReviewerCapability(client)
    expect(result).toEqual({ outcome: 'success', canReviewSemanticTopicLifecycle: false })
  })

  it('calls exactly the expected RPC name, with no params', async () => {
    const client = mockClient(async () => ({ data: true, error: null }))
    await getLifecycleReviewerCapability(client)
    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(client.rpc).toHaveBeenCalledWith('get_semantic_topic_lifecycle_reviewer_capability')
  })

  it('a Postgres/RPC error becomes database_error -- NEVER silently coerced to false', async () => {
    const client = mockClient(async () => ({ data: null, error: { code: '42501', message: 'permission denied for function get_semantic_topic_lifecycle_reviewer_capability' } }))
    const result = await getLifecycleReviewerCapability(client)
    expect(result.outcome).toBe('database_error')
    if (result.outcome === 'database_error') {
      expect(result.error.code).toBe('42501')
      expect(result.operation).toBe('get_semantic_topic_lifecycle_reviewer_capability')
    }
  })

  it('the RPC\'s own fail-closed "authentication required" exception also becomes database_error, never false', async () => {
    const client = mockClient(async () => ({ data: null, error: { message: 'get_semantic_topic_lifecycle_reviewer_capability: authentication required' } }))
    const result = await getLifecycleReviewerCapability(client)
    expect(result.outcome).toBe('database_error')
  })

  it('a non-boolean RPC response (e.g. null with no error) becomes invalid_rpc_response, never false', async () => {
    const client = mockClient(async () => ({ data: null, error: null }))
    const result = await getLifecycleReviewerCapability(client)
    expect(result).toEqual({ outcome: 'invalid_rpc_response', operation: 'get_semantic_topic_lifecycle_reviewer_capability' })
  })

  it('never returns any field besides outcome/canReviewSemanticTopicLifecycle on success -- no reviewer id/role/email', async () => {
    const client = mockClient(async () => ({ data: true, error: null }))
    const result = await getLifecycleReviewerCapability(client)
    expect(Object.keys(result).sort()).toEqual(['canReviewSemanticTopicLifecycle', 'outcome'])
  })
})

describe('lifecycleReviewerCapabilityFailureToResponse', () => {
  async function bodyAndStatus(failure: Exclude<LifecycleReviewerCapabilityResult, { outcome: 'success' }>) {
    const response = lifecycleReviewerCapabilityFailureToResponse(failure)
    return { status: response.status, cacheControl: response.headers.get('Cache-Control'), body: await response.json() }
  }

  it('database_error maps to a redacted 500, Cache-Control: no-store, generic message only', async () => {
    const { status, cacheControl, body } = await bodyAndStatus({
      outcome: 'database_error',
      operation: 'get_semantic_topic_lifecycle_reviewer_capability',
      error: { code: '08006', message: 'connection to server was lost', details: 'internal detail', hint: 'internal hint' },
    })
    expect(status).toBe(500)
    expect(cacheControl).toBe('no-store')
    expect(body).toEqual({ error: expect.any(String) })
    const bodyText = JSON.stringify(body)
    expect(bodyText).not.toMatch(/08006|connection to server was lost|internal detail|internal hint/)
  })

  it('invalid_rpc_response also maps to a redacted 500, never a silent false', async () => {
    const { status, cacheControl, body } = await bodyAndStatus({ outcome: 'invalid_rpc_response', operation: 'get_semantic_topic_lifecycle_reviewer_capability' })
    expect(status).toBe(500)
    expect(cacheControl).toBe('no-store')
    expect(body).not.toEqual({ canReviewSemanticTopicLifecycle: false })
  })
})
