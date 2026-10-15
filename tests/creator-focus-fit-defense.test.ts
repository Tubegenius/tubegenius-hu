// Defence in depth: even if the structural validator were bypassed, the assessment must not take a
// `fact_eligible` flag as an authority. The validator is replaced here with one that accepts everything.
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/creator-focus/profile-validate', () => ({ validateFocusProfile: () => [] }))

describe('eligibility is recomputed from origin and channel context, not read from the flag', () => {
  it('a forged `fact_eligible: true` on unknown / suggested origin never reaches the fit as a fact', async () => {
    const { adaptProfileRow, assessFocusFit } = await import('@/lib/creator-focus')
    const { row, CHANNEL_A } = await import('./support/creator-focus-fixtures')
    const topic = { text: 'otthoni edzés kezdőknek 4 hét alatt' }

    for (const origin of ['unknown', 'system_suggested'] as const) {
      const profile = structuredClone(adaptProfileRow(row({ specific_focus: 'otthoni edzés kezdőknek', active_channel_id: CHANNEL_A })))
      profile.claims.specific_focus = { ...profile.claims.specific_focus!, origin: origin as never, fact_eligible: true }
      const r = assessFocusFit({ contract_version: 'creator-focus.v1', profile, topic })
      expect(r.status, origin).toBe('unknown')
      expect(r.unknown_because, origin).toEqual(['no_eligible_focus'])
      expect(r.basis.claims_used, origin).toEqual([])
    }
  })

  it('a forged flag on a channel-derived claim under an uncertain context is not a fact either', async () => {
    const { assessFocusFit } = await import('@/lib/creator-focus')
    const { confirmedThenReviewPending } = await import('./support/creator-focus-fixtures')
    const profile = confirmedThenReviewPending().after
    expect(profile.claims.specific_focus).toMatchObject({ origin: 'user_confirmed', fact_eligible: false })
    profile.claims.specific_focus!.fact_eligible = true
    const r = assessFocusFit({ contract_version: 'creator-focus.v1', profile, topic: { text: 'otthoni edzés kezdőknek 4 hét alatt' } })
    expect(r.status).toBe('unknown')
    expect(r.reasons[0]).toMatchObject({ code: 'focus_claim_not_eligible_channel_context_uncertain' })
  })

  it('a forged declared avoid topic of unknown origin cannot produce does_not_fit', async () => {
    const { adaptProfileRow, assessFocusFit } = await import('@/lib/creator-focus')
    const { row } = await import('./support/creator-focus-fixtures')
    const profile = structuredClone(adaptProfileRow(row({ specific_focus: 'otthoni edzés kezdőknek', avoid_topics: 'politika' })))
    profile.claims.avoid_topics = { ...profile.claims.avoid_topics!, origin: 'unknown', fact_eligible: true }
    const r = assessFocusFit({ contract_version: 'creator-focus.v1', profile, topic: { text: 'politika hírek elemzés' } })
    expect(r.status).not.toBe('does_not_fit')
  })
})
