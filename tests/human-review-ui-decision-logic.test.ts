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
  resolveDuplicateSearchOutcomeOnProposedOutcomeChange,
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
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: VALID_UUID, duplicateSearchOutcome: 'existing_topic_match_confirmed' }))
    expect(result.ok).toBe(true)
    if (result.ok && result.payload.outcome === 'approved') {
      expect(result.payload.targetSemanticTopicId).toBe(VALID_UUID)
    }
  })

  it('rejects ATTACH_EXISTING with no target id at all', () => {
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: '', duplicateSearchOutcome: 'existing_topic_match_confirmed' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.targetSemanticTopicId).toBeDefined()
  })

  it('rejects an invalid (non-UUID) target id', () => {
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: 'not-a-uuid', duplicateSearchOutcome: 'existing_topic_match_confirmed' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.targetSemanticTopicId).toBeDefined()
  })

  it('rejects a well-formed-looking but structurally invalid UUID (wrong version nibble)', () => {
    // 9th hex group's first char must be 1-5 for a valid UUID version --
    // this is intentionally NOT a valid v1-v5 UUID.
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: '3fa85f64-5717-9562-b3fc-2c963f66afa6', duplicateSearchOutcome: 'existing_topic_match_confirmed' }))
    expect(result.ok).toBe(false)
  })

  // Migration 084 fail-closed pairing rule -- client-side mirror.
  it('rejects ATTACH_EXISTING paired with no_duplicate_found (the default CREATE_NEW value)', () => {
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: VALID_UUID, duplicateSearchOutcome: 'no_duplicate_found' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.duplicateSearchOutcome).toBeDefined()
  })

  it('rejects ATTACH_EXISTING paired with possible_duplicate_reviewed_and_distinct', () => {
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'ATTACH_EXISTING', targetSemanticTopicId: VALID_UUID, duplicateSearchOutcome: 'possible_duplicate_reviewed_and_distinct' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.duplicateSearchOutcome).toBeDefined()
  })

  it('rejects CREATE_NEW paired with existing_topic_match_confirmed', () => {
    const result = validateApprovalFields(validApprovalFields({ proposedOutcome: 'CREATE_NEW', duplicateSearchOutcome: 'existing_topic_match_confirmed' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.duplicateSearchOutcome).toBeDefined()
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
    const attempt = resolveIdempotencyKey(null, 'req-1', '{"a":1}', makeKey)
    expect(attempt.key).toBe('key-1')
    expect(calls).toBe(1)
  })

  it('reuses the SAME key when the payload is unchanged (network-timeout retry)', () => {
    let calls = 0
    const makeKey = () => `key-${++calls}`
    const first = resolveIdempotencyKey(null, 'req-1', '{"a":1}', makeKey)
    const retry = resolveIdempotencyKey(first, 'req-1', '{"a":1}', makeKey)
    expect(retry.key).toBe(first.key)
    expect(calls).toBe(1) // makeKey never called a second time
  })

  it('generates a NEW key when the payload changed (explicit modified decision)', () => {
    let calls = 0
    const makeKey = () => `key-${++calls}`
    const first = resolveIdempotencyKey(null, 'req-1', '{"a":1}', makeKey)
    const modified = resolveIdempotencyKey(first, 'req-1', '{"a":2}', makeKey)
    expect(modified.key).not.toBe(first.key)
    expect(calls).toBe(2)
  })

  it('generates a NEW key for a DIFFERENT review request even with an identical payload (cross-request isolation)', () => {
    let calls = 0
    const makeKey = () => `key-${++calls}`
    const first = resolveIdempotencyKey(null, 'req-1', '{"a":1}', makeKey)
    const otherRequestSamePayload = resolveIdempotencyKey(first, 'req-2', '{"a":1}', makeKey)
    expect(otherRequestSamePayload.key).not.toBe(first.key)
    expect(otherRequestSamePayload.reviewRequestId).toBe('req-2')
    expect(calls).toBe(2)
  })

  it('never lets a stale attempt leak back in after switching requests and switching back', () => {
    let calls = 0
    const makeKey = () => `key-${++calls}`
    const first = resolveIdempotencyKey(null, 'req-1', '{"a":1}', makeKey)
    const switched = resolveIdempotencyKey(first, 'req-2', '{"a":1}', makeKey)
    const backToOriginalRequest = resolveIdempotencyKey(switched, 'req-1', '{"a":1}', makeKey)
    expect(backToOriginalRequest.key).not.toBe(first.key)
    expect(backToOriginalRequest.key).not.toBe(switched.key)
    expect(calls).toBe(3)
  })

  it('a successful decision is never reused by a subsequent, new decision attempt on the same request', () => {
    // Models DecisionForm's real lifecycle: after a successful submit, the
    // component either unmounts (navigates back to the list) or the caller
    // resets its attempt ref to null before allowing a brand-new decision --
    // it must never hand the old IdempotencyAttempt back into
    // resolveIdempotencyKey for a fresh submission.
    let calls = 0
    const makeKey = () => `key-${++calls}`
    const first = resolveIdempotencyKey(null, 'req-1', '{"a":1}', makeKey)
    const afterSuccessReset = resolveIdempotencyKey(null, 'req-1', '{"a":1}', makeKey)
    expect(afterSuccessReset.key).not.toBe(first.key)
    expect(calls).toBe(2)
  })
})

// Migration 084 -- F.9: switching proposedOutcome must never leave a
// stale/incompatible duplicateSearchOutcome selected. This is the pure,
// DOM-free logic DecisionForm.tsx's selectProposedOutcome calls on every
// switch (see that file and decisionLogic.ts's own header for why this
// lives outside the React component).
describe('resolveDuplicateSearchOutcomeOnProposedOutcomeChange', () => {
  it('auto-selects the single valid option when switching to ATTACH_EXISTING from an empty selection', () => {
    expect(resolveDuplicateSearchOutcomeOnProposedOutcomeChange('ATTACH_EXISTING', '')).toBe('existing_topic_match_confirmed')
  })

  it('resets a stale CREATE_NEW-only selection when switching to ATTACH_EXISTING', () => {
    expect(resolveDuplicateSearchOutcomeOnProposedOutcomeChange('ATTACH_EXISTING', 'no_duplicate_found')).toBe('existing_topic_match_confirmed')
    expect(resolveDuplicateSearchOutcomeOnProposedOutcomeChange('ATTACH_EXISTING', 'possible_duplicate_reviewed_and_distinct')).toBe('existing_topic_match_confirmed')
  })

  it('resets a stale ATTACH_EXISTING-only selection to empty when switching to CREATE_NEW (two valid options -- no auto-select)', () => {
    expect(resolveDuplicateSearchOutcomeOnProposedOutcomeChange('CREATE_NEW', 'existing_topic_match_confirmed')).toBe('')
  })

  it('keeps a still-valid CREATE_NEW selection when switching to CREATE_NEW again (no-op reselect)', () => {
    expect(resolveDuplicateSearchOutcomeOnProposedOutcomeChange('CREATE_NEW', 'no_duplicate_found')).toBe('no_duplicate_found')
    expect(resolveDuplicateSearchOutcomeOnProposedOutcomeChange('CREATE_NEW', 'possible_duplicate_reviewed_and_distinct')).toBe('possible_duplicate_reviewed_and_distinct')
  })

  it('keeps the single ATTACH_EXISTING selection when switching to ATTACH_EXISTING again (no-op reselect)', () => {
    expect(resolveDuplicateSearchOutcomeOnProposedOutcomeChange('ATTACH_EXISTING', 'existing_topic_match_confirmed')).toBe('existing_topic_match_confirmed')
  })

  it('stays empty when nothing was selected yet, regardless of target', () => {
    expect(resolveDuplicateSearchOutcomeOnProposedOutcomeChange('CREATE_NEW', '')).toBe('')
  })
})
