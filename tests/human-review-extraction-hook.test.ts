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
  ] as const)('every ineligible reasonCode (%s) maps to not_eligible, WITH the reasonCode threaded through', async (reasonCode) => {
    process.env[ENV_KEY] = 'true'
    createReviewRequest.mockResolvedValue({ outcome: 'ineligible', reasonCode, message: `some diagnostic text for ${reasonCode}` })
    const { maybeRequestHumanReview } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const result = await maybeRequestHumanReview({ extractionRunId: 'x' })
    expect(result.outcome).toBe('not_eligible')
    // PFM Supervised Intake Human-Review Observability Closure gate: the
    // closed reasonCode must now survive the mapping (previously only
    // `message` did) so the runner's safe log summary can report WHY.
    if (result.outcome === 'not_eligible') expect(result.reasonCode).toBe(reasonCode)
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

// ===========================================================================
// PFM Supervised Intake Human-Review Observability Closure gate --
// summarizeHumanReviewForLog(). Pure function, no mocks needed -- every
// current HumanReviewOrchestrationResult outcome gets its own case, plus a
// fail-closed case for a value outside the current closed union.
// ===========================================================================
describe('summarizeHumanReviewForLog', () => {
  it('disabled -> { outcome: "disabled" }, no other fields', async () => {
    const { summarizeHumanReviewForLog } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const summary = summarizeHumanReviewForLog({ outcome: 'disabled' })
    expect(summary).toEqual({ outcome: 'disabled' })
    expect(Object.keys(summary)).toEqual(['outcome'])
  })

  it('created -> only { outcome: "created" }, reviewRequestId/generation/expiresAt NEVER survive the summary', async () => {
    const { summarizeHumanReviewForLog } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const summary = summarizeHumanReviewForLog({ outcome: 'created', reviewRequestId: 'real-review-request-id', generation: 3, expiresAt: '2026-01-01T00:00:00Z' })
    expect(summary).toEqual({ outcome: 'created' })
    expect(JSON.stringify(summary)).not.toContain('real-review-request-id')
  })

  it('replayed -> only { outcome: "replayed" }, same field-stripping guarantee', async () => {
    const { summarizeHumanReviewForLog } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const summary = summarizeHumanReviewForLog({ outcome: 'replayed', reviewRequestId: 'another-real-id', generation: 1, expiresAt: '2026-01-01T00:00:00Z' })
    expect(summary).toEqual({ outcome: 'replayed' })
  })

  it('pending -> { outcome: "pending" }', async () => {
    const { summarizeHumanReviewForLog } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    expect(summarizeHumanReviewForLog({ outcome: 'pending' })).toEqual({ outcome: 'pending' })
  })

  it('already_assigned -> { outcome: "already_assigned" }', async () => {
    const { summarizeHumanReviewForLog } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    expect(summarizeHumanReviewForLog({ outcome: 'already_assigned' })).toEqual({ outcome: 'already_assigned' })
  })

  it.each([
    ['EXTRACTION_NOT_COMPLETED'],
    ['NOT_SPECIFIC'],
    ['CONFIDENCE_NOT_REVIEW_ELIGIBLE'],
    ['NO_SUPPORTING_SPANS'],
    ['INVALID_STRUCTURED_OUTPUT'],
  ] as const)('not_eligible (%s) -> { outcome: "not_eligible", reasonCode }, the free-text message is NEVER included', async (reasonCode) => {
    const { summarizeHumanReviewForLog } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const summary = summarizeHumanReviewForLog({ outcome: 'not_eligible', reasonCode, message: 'this diagnostic sentence must never reach a log line' })
    expect(summary).toEqual({ outcome: 'not_eligible', reasonCode })
    expect(JSON.stringify(summary)).not.toContain('diagnostic sentence')
  })

  it('retryable_failure -> only { outcome: "retryable_failure" }, the free-text message is NEVER included', async () => {
    const { summarizeHumanReviewForLog } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const summary = summarizeHumanReviewForLog({ outcome: 'retryable_failure', message: 'raw db error text that could contain anything' })
    expect(summary).toEqual({ outcome: 'retryable_failure' })
    expect(JSON.stringify(summary)).not.toContain('raw db error text')
  })

  it('an unrecognized future outcome value fails closed to a safe, generic category -- never throws, never passes the unknown shape through', async () => {
    const { summarizeHumanReviewForLog } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const bogus = { outcome: 'some_future_outcome_nobody_added_a_case_for', secretPayload: 'should never appear anywhere' } as never
    const summary = summarizeHumanReviewForLog(bogus)
    expect(summary).toEqual({ outcome: 'unrecognized_outcome' })
    expect(JSON.stringify(summary)).not.toContain('secretPayload')
    expect(JSON.stringify(summary)).not.toContain('should never appear')
  })

  it('every summary is JSON-serializable and contains only the closed outcome/reasonCode keys -- no extra fields for any branch', async () => {
    const { summarizeHumanReviewForLog } = await import('@/lib/semantic-topic/human-review-extraction-hook')
    const cases: unknown[] = [
      { outcome: 'disabled' },
      { outcome: 'created', reviewRequestId: 'x', generation: 1, expiresAt: 'x' },
      { outcome: 'replayed', reviewRequestId: 'x', generation: 1, expiresAt: 'x' },
      { outcome: 'pending' },
      { outcome: 'already_assigned' },
      { outcome: 'not_eligible', reasonCode: 'NOT_SPECIFIC', message: 'x' },
      { outcome: 'retryable_failure', message: 'x' },
    ]
    for (const c of cases) {
      const summary = summarizeHumanReviewForLog(c as never)
      for (const key of Object.keys(summary)) {
        expect(['outcome', 'reasonCode']).toContain(key)
      }
    }
  })
})
