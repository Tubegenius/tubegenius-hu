// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, pure unit
// tests for the RPC-error -> closed-outcome mapping. No DB, no network --
// exercises mapReviewRpcError against every RAISE EXCEPTION message text
// pattern the actual 078 RPCs are known (from the 078 migration source and
// its own test suite) to produce.
import { describe, expect, it } from 'vitest'
import { mapReviewRpcError, toDatabaseErrorShape, isUuid, REJECTION_REASONS } from '@/lib/semantic-topic/human-review-types'

function pgErr(message: string, code?: string) {
  return { message, code }
}

describe('toDatabaseErrorShape', () => {
  it('extracts code/message/details/hint from a Postgres-shaped error object', () => {
    const shaped = toDatabaseErrorShape({ code: '23505', message: 'duplicate key', details: 'Key already exists.', hint: 'try again' })
    expect(shaped).toEqual({ code: '23505', message: 'duplicate key', details: 'Key already exists.', hint: 'try again' })
  })

  it('falls back to a generic message for a non-object error', () => {
    expect(toDatabaseErrorShape('boom').message).toBe('boom')
    expect(toDatabaseErrorShape(new Error('oops')).message).toBe('oops')
  })
})

describe('mapReviewRpcError', () => {
  it('maps "permission denied" (direct DML/grant rejection) to not_a_reviewer', () => {
    expect(mapReviewRpcError('op', pgErr('permission denied for function list_pending_topic_assignment_review_requests'))).toEqual({ outcome: 'not_a_reviewer' })
  })

  it('maps "caller is not an active reviewer" to not_a_reviewer', () => {
    expect(mapReviewRpcError('op', pgErr('cancel_topic_assignment_review_request: caller is not an active reviewer'))).toEqual({ outcome: 'not_a_reviewer' })
  })

  it('maps "authentication required" to unauthenticated', () => {
    expect(mapReviewRpcError('op', pgErr('list_pending_topic_assignment_review_requests: authentication required'))).toEqual({ outcome: 'unauthenticated' })
  })

  it('maps "not found" to not_found', () => {
    expect(mapReviewRpcError('op', pgErr('get_topic_assignment_review_request: review_request 00000000-0000-0000-0000-000000000000 not found'))).toEqual({ outcome: 'not_found' })
  })

  it('maps REVIEW_REQUEST_EXPIRED to expired', () => {
    expect(mapReviewRpcError('op', pgErr('record_topic_assignment_review_decision: REVIEW_REQUEST_EXPIRED -- review_request x expired at y'))).toEqual({ outcome: 'expired' })
  })

  it('maps ALREADY_DECIDED / ALREADY_EXECUTED / IDEMPOTENCY_KEY_REUSE to their own outcomes', () => {
    expect(mapReviewRpcError('op', pgErr('... ALREADY_DECIDED -- review_request x already decided'))).toEqual({ outcome: 'already_decided' })
    expect(mapReviewRpcError('op', pgErr('... ALREADY_EXECUTED -- review_request x already executed'))).toEqual({ outcome: 'already_executed' })
    expect(mapReviewRpcError('op', pgErr('... IDEMPOTENCY_KEY_REUSE -- key already used'))).toEqual({ outcome: 'idempotency_key_reuse' })
  })

  it('maps REVIEW_REQUEST_NOT_CANCELLABLE / NOT_REVOCABLE / NOT_DECIDABLE / NOT_EXECUTABLE', () => {
    expect(mapReviewRpcError('op', pgErr('... REVIEW_REQUEST_NOT_CANCELLABLE -- status=approved'))).toEqual({ outcome: 'not_cancellable' })
    expect(mapReviewRpcError('op', pgErr('... REVIEW_APPROVAL_NOT_REVOCABLE -- status=executed'))).toEqual({ outcome: 'not_revocable' })
    expect(mapReviewRpcError('op', pgErr('... REVIEW_REQUEST_NOT_DECIDABLE -- status=expired'))).toEqual({ outcome: 'not_decidable' })
    expect(mapReviewRpcError('op', pgErr('... REVIEW_REQUEST_NOT_EXECUTABLE -- status=pending'))).toEqual({ outcome: 'not_executable' })
  })

  it('maps eligibility-gate messages to not_eligible (not an error the caller should see as a 500)', () => {
    expect(mapReviewRpcError('op', pgErr('create_topic_assignment_review_request: requires confidence < 0.8500 (got 0.90)')).outcome).toBe('not_eligible')
    expect(mapReviewRpcError('op', pgErr('create_topic_assignment_review_request: requires structured_output.specificity=specific (got generic)')).outcome).toBe('not_eligible')
    expect(mapReviewRpcError('op', pgErr('create_topic_assignment_review_request: requires at least one supporting_spans entry')).outcome).toBe('not_eligible')
    expect(mapReviewRpcError('op', pgErr('create_topic_assignment_review_request: extraction_run x already has a topic_assignment_decisions row -- no new review request is possible')).outcome).toBe('not_eligible')
    expect(mapReviewRpcError('op', pgErr('create_topic_assignment_review_request: extraction_run x already has a live (pending/approved) review request')).outcome).toBe('not_eligible')
  })

  it('maps structured-snapshot validation failures to validation_error, never to database_error', () => {
    expect(mapReviewRpcError('op', pgErr('record_topic_assignment_review_decision: approved requires the full structured review snapshot')).outcome).toBe('validation_error')
    expect(mapReviewRpcError('op', pgErr('record_topic_assignment_review_decision: approved requires lane_neutral_confirmed=true')).outcome).toBe('validation_error')
    expect(mapReviewRpcError('op', pgErr('record_topic_assignment_review_decision: rejected requires a valid rejection_reason (got x)')).outcome).toBe('validation_error')
  })

  it('falls back to database_error for an unrecognized message, preserving the raw shape for server-side logging only', () => {
    const result = mapReviewRpcError('some_op', pgErr('relation "xyz" does not exist', '42P01'))
    expect(result).toEqual({ outcome: 'database_error', operation: 'some_op', error: { code: '42P01', message: 'relation "xyz" does not exist', details: undefined, hint: undefined } })
  })
})

describe('isUuid', () => {
  it('accepts a canonical lowercase v4 UUID', () => {
    expect(isUuid('c5e4da64-7e23-4e56-9620-6cdcafb395d5')).toBe(true)
  })
  it('rejects non-UUID strings and non-strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid(123)).toBe(false)
    expect(isUuid(null)).toBe(false)
    expect(isUuid(undefined)).toBe(false)
  })
})

describe('REJECTION_REASONS', () => {
  it('matches the exact closed enum enforced by 077s CHECK constraint', () => {
    expect(REJECTION_REASONS).toEqual([
      'insufficient_evidence',
      'invalid_topic_identity',
      'not_lane_neutral',
      'malformed_candidate',
      'duplicate_without_valid_target',
      'other_review_rejection',
    ])
  })
})
