// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, minimal
// reviewer UI (Local Implementation Phase 4). Pure-logic unit tests for
// components/semantic-topic-reviews/decisionLogic.ts -- no DOM, no network,
// no DB. See that file's header for why this logic lives outside the React
// component (this repo has no component-rendering test infrastructure).
import { describe, expect, it } from 'vitest'
import {
  validateApprovalFields,
  validateRejectionFields,
  resolveIdempotencyKey,
  type ApprovalFormFields,
  type RejectionFormFields,
} from '@/components/semantic-topic-reviews/decisionLogic'

const VALID_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

function validApprovalFields(overrides: Partial<ApprovalFormFields> = {}): ApprovalFormFields {
  return {
    canonicalTopicLabel: 'Test topic',
    topicDefinition: 'A clear definition.',
    scope: 'A clear scope.',
    inclusionCriteria: 'Includes X.',
    exclusionCriteria: 'Excludes Y.',
    laneNeutralConfirmed: true,
    evidenceAdequateConfirmed: true,
    duplicateSearchOutcome: 'no_duplicate_found',
    proposedOutcome: 'CREATE_NEW',
    targetSemanticTopicId: '',
    uncertaintyClassification: 'low',
    reviewerRationale: 'Clear rationale.',
    reviewPolicyVersion: 1,
    ...overrides,
  }
}

function validRejectionFields(overrides: Partial<RejectionFormFields> = {}): RejectionFormFields {
  return {
    rejectionReason: 'insufficient_evidence',
    reviewerRationale: 'Not enough evidence.',
    reviewPolicyVersion: 1,
    ...overrides,
  }
}

describe('validateApprovalFields -- CREATE_NEW', () => {
  it('accepts a fully valid CREATE_NEW form and never includes a target id', () => {
    const result = validateApprovalFields(validApprovalFields())
    expect(result.ok).toBe(true)
    if (result.ok && result.payload.outcome === 'approved') {
      expect(result.payload.proposedOutcome).toBe('CREATE_NEW')
      expect(result.payload.targetSemanticTopicId).toBeNull()
    }
  })

  it('rejects when required text fields are empty', () => {
    const result = validateApprovalFields(validApprovalFields({ canonicalTopicLabel: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.canonicalTopicLabel).toBeDefined()
  })

  it('rejects when a text field exceeds its max length', () => {
    const result = validateApprovalFields(validApprovalFields({ canonicalTopicLabel: 'x'.repeat(201) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.canonicalTopicLabel).toBeDefined()
  })

  it('rejects when laneNeutralConfirmed is false', () => {
    const result = validateApprovalFields(validApprovalFields({ laneNeutralConfirmed: false }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.laneNeutralConfirmed).toBeDefined()
  })

  it('rejects when evidenceAdequateConfirmed is false', () => {
    const result = validateApprovalFields(validApprovalFields({ evidenceAdequateConfirmed: false }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.evidenceAdequateConfirmed).toBeDefined()
  })

  it('rejects when duplicateSearchOutcome is not chosen', () => {
    const result = validateApprovalFields(validApprovalFields({ duplicateSearchOutcome: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.duplicateSearchOutcome).toBeDefined()
  })

  it('rejects when uncertaintyClassification is not chosen', () => {
    const result = validateApprovalFields(validApprovalFields({ uncertaintyClassification: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.uncertaintyClassification).toBeDefined()
  })
})

describe('validateApprovalFields -- ATTACH_EXISTING', () => {
  it('accepts a valid ATTACH_EXISTING form with an exact UUID target', () => {
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: VALID_UUID }))
    expect(result.ok).toBe(true)
    if (result.ok && result.payload.outcome === 'approved') {
      expect(result.payload.targetSemanticTopicId).toBe(VALID_UUID)
    }
  })

  it('rejects ATTACH_EXISTING with no target id at all', () => {
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.targetSemanticTopicId).toBeDefined()
  })

  it('rejects an invalid (non-UUID) target id', () => {
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: 'not-a-uuid' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.targetSemanticTopicId).toBeDefined()
  })

  it('rejects a well-formed-looking but structurally invalid UUID (wrong version nibble)', () => {
    // 9th hex group's first char must be 1-5 for a valid UUID version --
    // this is intentionally NOT a valid v1-v5 UUID.
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: '3fa85f64-5717-9562-b3fc-2c963f66afa6' }))
    expect(result.ok).toBe(false)
  })

  it('never requires a target id when proposedOutcome is not yet chosen (no false positive)', () => {
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: '', targetSemanticTopicId: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.proposedOutcome).toBeDefined()
      expect(result.errors.targetSemanticTopicId).toBeUndefined()
    }
  })
})

describe('validateRejectionFields', () => {
  it('accepts a valid rejection', () => {
    const result = validateRejectionFields(validRejectionFields())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.outcome).toBe('rejected')
  })

  it('rejects when no rejectionReason is chosen', () => {
    const result = validateRejectionFields(validRejectionFields({ rejectionReason: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.rejectionReason).toBeDefined()
  })

  it('rejects when reviewerRationale is empty', () => {
    const result = validateRejectionFields(validRejectionFields({ reviewerRationale: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.reviewerRationale).toBeDefined()
  })

  it('rejects when reviewerRationale exceeds the max length', () => {
    const result = validateRejectionFields(validRejectionFields({ reviewerRationale: 'x'.repeat(1001) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.reviewerRationale).toBeDefined()
  })
})

describe('resolveIdempotencyKey -- decision submission idempotency', () => {
  it('generates a fresh key on the first attempt', () => {
    let calls = 0
    const makeKey = () => `key-${++calls}`
    const attempt = resolveIdempotencyKey(null, '{"a":1}', makeKey)
    expect(attempt.key).toBe('key-1')
    expect(calls).toBe(1)
  })

  it('reuses the SAME key when the payload is unchanged (network-timeout retry)', () => {
    let calls = 0
    const makeKey = () => `key-${++calls}`
    const first = resolveIdempotencyKey(null, '{"a":1}', makeKey)
    const retry = resolveIdempotencyKey(first, '{"a":1}', makeKey)
    expect(retry.key).toBe(first.key)
    expect(calls).toBe(1) // makeKey never called a second time
  })

  it('generates a NEW key when the payload changed (explicit modified decision)', () => {
    let calls = 0
    const makeKey = () => `key-${++calls}`
    const first = resolveIdempotencyKey(null, '{"a":1}', makeKey)
    const modified = resolveIdempotencyKey(first, '{"a":2}', makeKey)
    expect(modified.key).not.toBe(first.key)
    expect(calls).toBe(2)
  })
})
