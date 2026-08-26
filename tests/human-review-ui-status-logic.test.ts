// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, minimal
// reviewer UI. Pure-logic unit tests for
// components/semantic-topic-reviews/statusLogic.ts.
import { describe, expect, it } from 'vitest'
import { availableActionsForStatus, isPastExpiry } from '@/components/semantic-topic-reviews/statusLogic'
import type { ReviewRequestStatus } from '@/components/semantic-topic-reviews/types'

describe('availableActionsForStatus', () => {
  it('pending: can decide and cancel, cannot revoke', () => {
    expect(availableActionsForStatus('pending')).toEqual({ canDecide: true, canCancel: true, canRevoke: false })
  })

  it('approved: can revoke only', () => {
    expect(availableActionsForStatus('approved')).toEqual({ canDecide: false, canCancel: false, canRevoke: true })
  })

  it.each<ReviewRequestStatus>(['rejected', 'expired', 'cancelled', 'revoked', 'executed'])('%s: no action is ever available (terminal state)', status => {
    expect(availableActionsForStatus(status)).toEqual({ canDecide: false, canCancel: false, canRevoke: false })
  })
})

describe('isPastExpiry', () => {
  it('returns false for a future expiry', () => {
    expect(isPastExpiry('2999-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z'))).toBe(false)
  })

  it('returns true for a past expiry', () => {
    expect(isPastExpiry('2020-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z'))).toBe(true)
  })

  it('returns false (fail-safe) for an unparseable date rather than throwing', () => {
    expect(isPastExpiry('not-a-date')).toBe(false)
  })
})
