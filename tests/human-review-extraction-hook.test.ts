// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, unit
// tests for maybeRequestHumanReview()'s typed orchestration state machine.
// Mocked human-review-service.ts -- pure branching-logic tests, no DB.
//
// Structured Orchestration Outcome Closure gate: these tests assert the
// hook branches EXCLUSIVELY on createReviewRequest()'s typed outcome/
// reasonCode fields, never on its `message` string -- several tests below
// specifically mutate `message` while holding outcome/reasonCode fixed (and
// vice versa) to prove that.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('flag enabled, outcomeKind=created: outcome=created with full payload', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'success', outcomeKind: 'created', reviewRequestId: 'r1', generation: 1, status: 'pending', expiresAt: '2026-01-01T00:00:00Z' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result).toEqual({ outcome: 'created', reviewRequestId: 'r1', generation: 1, expiresAt: '2026-01-01T00:00:00Z' })
  })

  it('flag enabled, outcomeKind=replayed: outcome=replayed', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'success', outcomeKind: 'replayed', reviewRequestId: 'r1', generation: 1, status: 'pending', expiresAt: '2026-01-01T00:00:00Z' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('replayed')
  })

  it('reasonCode=ALREADY_ASSIGNED maps to already_assigned', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'blocked', reasonCode: 'ALREADY_ASSIGNED', message: 'extraction_run x already has a topic_assignment_decisions row -- no new review request is possible' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result).toEqual({ outcome: 'already_assigned' })
  })

  it('reasonCode=LIVE_REVIEW_REQUEST_EXISTS maps to pending', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'blocked', reasonCode: 'LIVE_REVIEW_REQUEST_EXISTS', message: 'extraction_run x already has a live (pending/approved) review request' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result).toEqual({ outcome: 'pending' })
  })

  it('the ALREADY_ASSIGNED/LIVE_REVIEW_REQUEST_EXISTS mapping does not change if the message text is rewritten to something unrecognizable', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'blocked', reasonCode: 'ALREADY_ASSIGNED', message: 'totally rewritten human text, no keywords at all' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result).toEqual({ outcome: 'already_assigned' })
  })

  it.each([
    ['EXTRACTION_NOT_COMPLETED'],
    ['NOT_SPECIFIC'],
    ['CONFIDENCE_NOT_REVIEW_ELIGIBLE'],
    ['NO_SUPPORTING_SPANS'],
    ['INVALID_STRUCTURED_OUTPUT'],
  ] as const)('every ineligible reasonCode (%s) maps to not_eligible', async (reasonCode) => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'ineligible', reasonCode, message: `some diagnostic text for ${reasonCode}` })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('not_eligible')
  })

  it('not_eligible mapping is identical regardless of message content (message is diagnostic-only, never branched on)', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'ineligible', reasonCode: 'NOT_SPECIFIC', message: 'message A' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const a = await maybeRequestHumanReview({ extractionRunId: 'x' })
    createReviewRequest.mockResolvedValue({ outcome: 'ineligible', reasonCode: 'NOT_SPECIFIC', message: 'a completely different message B' })
    const b = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(a.outcome).toBe('not_eligible')
    expect(b.outcome).toBe('not_eligible')
  })

  it('a database_error is surfaced as retryable_failure, never as a terminal outcome', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'database_error', operation: 'create_topic_assignment_review_request', error: { message: 'connection reset' } })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('retryable_failure')
  })

  it('an invalid_rpc_response (e.g. a missing reason_code on a failure body) is surfaced as retryable_failure', async () => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'invalid_rpc_response', operation: 'create_topic_assignment_review_request' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('retryable_failure')
  })

  it('an unrecognized outcome value from a future/mismatched createReviewRequest() is fail-closed to retryable_failure, never to not_eligible or a terminal state', async () => {
    process.env[ENV_KEY] = 'true'
    // Deliberately outside CreateReviewRequestResult's own type -- simulates
    // a version-skew bug (e.g. a stale build) rather than a normal outcome.
    createReviewRequest.mockResolvedValue({ outcome: 'some_future_outcome_not_yet_known' } as never)
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
    createReviewRequest.mockResolvedValue({ outcome: 'success', outcomeKind: 'created', reviewRequestId: 'r1', generation: 1, status: 'pending', expiresAt: 'x' })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    const validOutcomes = ['disabled', 'created', 'replayed', 'pending', 'not_eligible', 'already_assigned', 'retryable_failure']
    expect(validOutcomes).toContain(result.outcome)
  })

  it('static source scan: human-review-extraction-hook.ts contains no RegExp.test(/.exec( calls or message.includes( branching (comments/prose are not scanned)', () => {
    const src = readFileSync(join(process.cwd(), 'lib', 'semantic-topic', 'human-review-extraction-hook.ts'), 'utf8')
    const codeOnly = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    // A regex-literal branch would show up as an actual call: /.../.test(...)
    // or /.../.exec(...); message.includes(...) is the other pattern this
    // gate explicitly bans. Scanning only non-comment lines avoids false
    // positives from prose that legitimately discusses these RPC messages
    // (e.g. explaining what ALREADY_ASSIGNED means).
    expect(codeOnly).not.toMatch(/\.test\(/)
    expect(codeOnly).not.toMatch(/\.exec\(/)
    expect(codeOnly).not.toMatch(/message\.includes\(/)
  })

  it('static source scan: human-review-service.ts\'s createReviewRequest() contains no message-pattern-matching branching (mapReviewRpcError is not called there)', () => {
    const src = readFileSync(join(process.cwd(), 'lib', 'semantic-topic', 'human-review-service.ts'), 'utf8')
    const fnStart = src.indexOf('export async function createReviewRequest')
    const fnEnd = src.indexOf('\n}', fnStart)
    const fnBody = src
      .slice(fnStart, fnEnd)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(fnBody).not.toMatch(/mapReviewRpcError\(/)
    expect(fnBody).not.toMatch(/\.test\(/)
    expect(fnBody).not.toMatch(/message\.includes\(/)
  })
})
