// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, unit
// tests for maybeRequestHumanReview()'s typed orchestration state machine.
// Mocked human-review-service.ts -- pure branching-logic tests, no DB.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createReviewRequest = vi.fn()
vi.mock('@/lib/semantic-topic/human-review-service', () => ({
  createReviewRequest: (...args: unknown[]) => createReviewRequest(...args),
}))

const ENV_KEY = 'SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED'
const originalValue = process.env[ENV_KEY]

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalValue
})

describe('maybeRequestHumanReview state machine', () => {
  it('flag disabled (default): outcome=disabled, RPC never called', async () => {
    delete process.env[ENV_KEY]
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result).toEqual({ outcome: 'disabled' })
    expect(createReviewRequest).not.toHaveBeenCalled()
  })

  it('flag enabled, RPC created: outcome=created with full payload', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'success', result: 'created', reviewRequestId: 'r1', generation: 1, status: 'pending', expiresAt: '2026-01-01T00:00:00Z' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result).toEqual({ outcome: 'created', reviewRequestId: 'r1', generation: 1, expiresAt: '2026-01-01T00:00:00Z' })
  })

  it('flag enabled, RPC replayed: outcome=replayed', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'success', result: 'replayed', reviewRequestId: 'r1', generation: 1, status: 'pending', expiresAt: '2026-01-01T00:00:00Z' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('replayed')
  })

  it('re-classifies "already has a topic_assignment_decisions row" as already_assigned, not not_eligible', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'not_eligible', message: 'create_topic_assignment_review_request: extraction_run x already has a topic_assignment_decisions row -- no new review request is possible' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result).toEqual({ outcome: 'already_assigned' })
  })

  it('re-classifies "already has a live (pending/approved) review request" as pending, not not_eligible', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'not_eligible', message: 'create_topic_assignment_review_request: extraction_run x already has a live (pending/approved) review request' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result).toEqual({ outcome: 'pending' })
  })

  it('a genuine ineligibility (confidence too high) stays not_eligible', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'not_eligible', message: 'create_topic_assignment_review_request: requires confidence < 0.8500 (got 0.90)' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('not_eligible')
  })

  it('a genuine ineligibility (non-specific) stays not_eligible', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'not_eligible', message: 'create_topic_assignment_review_request: requires structured_output.specificity=specific (got generic)' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('not_eligible')
  })

  it('a database_error is surfaced as retryable_failure, never as a terminal outcome', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'database_error', operation: 'create_topic_assignment_review_request', error: { message: 'connection reset' } })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('retryable_failure')
  })

  it('an invalid_rpc_response is surfaced as retryable_failure', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'invalid_rpc_response', operation: 'create_topic_assignment_review_request' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('retryable_failure')
  })

  it('the idempotency key is deterministic and namespace-disjoint from other domains', async () => {
    const { deriveHumanReviewIdempotencyKey } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const key1 = deriveHumanReviewIdempotencyKey('run-abc')
    const key2 = deriveHumanReviewIdempotencyKey('run-abc')
    expect(key1).toBe(key2)
    expect(key1).toBe('human-review-request:run-abc')
    expect(key1).not.toMatch(/:quota$|:extraction-run$|^review-reject:/)
  })

  it('the outcome vocabulary is closed and exhaustive (no free-text branching)', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'success', result: 'created', reviewRequestId: 'r1', generation: 1, status: 'pending', expiresAt: 'x' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    const validOutcomes = ['disabled', 'created', 'replayed', 'pending', 'not_eligible', 'already_assigned', 'retryable_failure']
    expect(validOutcomes).toContain(result.outcome)
  })
})
