// PFM Lifecycle Reviewer Read Surface v1 -- reader.ts mapping tests
// (mocked client.rpc, no DB, no module mocking of the reader itself --
// this file exercises the REAL lifecycle-review-reader.ts implementation).
// Kept in its own file, separate from the API-route tests, because the
// route-level file needs `vi.mock('@/lib/semantic-topic/lifecycle-review-reader', ...)`,
// which -- being hoisted -- would otherwise shadow the real implementation
// tested here for the whole file.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function fakeClient(data: unknown, error: unknown = null) {
  return { rpc: vi.fn(async () => ({ data, error })) }
}

describe('lifecycle-review-reader.ts -- RPC response mapping', () => {
  it('listLifecycleReviews maps every snake_case field to its camelCase contract field', async () => {
    const { listLifecycleReviews } = await import('@/lib/semantic-topic/lifecycle-review-reader')
    const client = fakeClient({
      ok: true,
      requests: [
        {
          review_request_id: 'r1', generation: 2, semantic_topic_id: 't1', topic_canonical_label: 'Label',
          from_status: 'corroborating', target_status: 'coherent', request_status: 'requested',
          requested_at: '2026-09-01T00:00:00Z', expires_at: '2026-09-02T00:00:00Z', decided_at: null, stale_reason_code: null,
        },
      ],
    })
    const result = await listLifecycleReviews(client as any, { statusFilter: 'requested' })
    expect(result.outcome).toBe('success')
    if (result.outcome !== 'success') throw new Error('unreachable')
    expect(result.requests[0]).toEqual({
      reviewRequestId: 'r1', generation: 2, semanticTopicId: 't1', topicCanonicalLabel: 'Label',
      fromStatus: 'corroborating', targetStatus: 'coherent', requestStatus: 'requested',
      requestedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z', decidedAt: null, staleReasonCode: null,
    })
    expect(client.rpc).toHaveBeenCalledWith('list_semantic_topic_lifecycle_review_requests', {
      p_status_filter: 'requested', p_limit: 20, p_after_requested_at: null, p_after_id: null,
    })
  })

  it('listLifecycleReviews defaults statusFilter to actionable and limit to 20 when omitted', async () => {
    const { listLifecycleReviews } = await import('@/lib/semantic-topic/lifecycle-review-reader')
    const client = fakeClient({ ok: true, requests: [] })
    await listLifecycleReviews(client as any)
    expect(client.rpc).toHaveBeenCalledWith('list_semantic_topic_lifecycle_review_requests', {
      p_status_filter: 'actionable', p_limit: 20, p_after_requested_at: null, p_after_id: null,
    })
  })

  it('listLifecycleReviews maps an RPC exception via mapLifecycleReadRpcError', async () => {
    const { listLifecycleReviews } = await import('@/lib/semantic-topic/lifecycle-review-reader')
    const client = fakeClient(null, { message: 'list_semantic_topic_lifecycle_review_requests: caller is not an active reviewer' })
    const result = await listLifecycleReviews(client as any)
    expect(result.outcome).toBe('not_a_reviewer')
  })

  it('listLifecycleReviews treats a malformed body (ok!=true or requests not an array) as invalid_rpc_response', async () => {
    const { listLifecycleReviews } = await import('@/lib/semantic-topic/lifecycle-review-reader')
    const client = fakeClient({ ok: true, requests: 'not-an-array' })
    const result = await listLifecycleReviews(client as any)
    expect(result.outcome).toBe('invalid_rpc_response')
  })

  it('getLifecycleReview maps a NOT_FOUND normal-return body to outcome not_found (not invalid_rpc_response)', async () => {
    const { getLifecycleReview } = await import('@/lib/semantic-topic/lifecycle-review-reader')
    const client = fakeClient({ ok: false, reasonCode: 'NOT_FOUND' })
    const result = await getLifecycleReview(client as any, 'r1')
    expect(result.outcome).toBe('not_found')
  })

  it('getLifecycleReview maps decidedByCurrentReviewer/cancelledByCurrentReviewer booleans without ever exposing a raw uuid field', async () => {
    const { getLifecycleReview } = await import('@/lib/semantic-topic/lifecycle-review-reader')
    const client = fakeClient({
      ok: true,
      request: {
        review_request_id: 'r1', generation: 1, semantic_topic_id: 't1', topic_canonical_label: 'Label',
        from_status: 'corroborating', target_status: 'coherent', request_status: 'approved',
        requested_at: '2026-09-01T00:00:00Z', expires_at: '2026-09-02T00:00:00Z', decided_at: '2026-09-01T01:00:00Z', stale_reason_code: null,
        snapshot: { evidence_vector: {}, digest: 'd1', captured_at: '2026-09-01T00:00:00Z', from_lifecycle_status: 'corroborating', expected_status_version: 1 },
        review_policy_version: 1,
        decision: {
          reviewer_role_snapshot: 'reviewer', decided_at: '2026-09-01T01:00:00Z', reason_code: 'identity_consistency_confirmed',
          reviewer_rationale: 'x', same_semantic_identity_confirmed: true, no_material_identity_conflict: true,
          canonical_definition_scope_fit_confirmed: true, provenance_relationship_reviewed: true, decided_by_current_reviewer: true,
        },
        execution: null,
        cancellation: null,
        transition_history: [],
        live: { lifecycle_status: 'corroborating', status_version: 1, evidence_vector: {}, vector_digest: 'd1', mechanical_requirements_currently_met: true },
        staleness_signals: { topic_status_changed: false, topic_version_changed: false, evidence_vector_changed: false, mechanical_requirements_lost: false },
        is_potentially_stale: false,
      },
    })
    const result = await getLifecycleReview(client as any, 'r1')
    expect(result.outcome).toBe('success')
    if (result.outcome !== 'success') throw new Error('unreachable')
    expect(result.request.decision?.decidedByCurrentReviewer).toBe(true)
    expect(JSON.stringify(result.request)).not.toMatch(/reviewer_user_id|reviewerUserId/)
  })

  it('every RPC call in the reader goes through the single call() boundary -- no scattered direct `.rpc(` call sites', () => {
    const src = readFileSync(join(process.cwd(), 'lib/semantic-topic/lifecycle-review-reader.ts'), 'utf8')
    const directRpcCallSites = src.match(/\w+\.rpc\(/g) ?? []
    expect(directRpcCallSites).toEqual(['client.rpc('])
  })
})
