// Creator Intelligence 2A: the explicit, NON-DURABLE state transitions of a FocusProfile.
import { describe, expect, it } from 'vitest'
import { adaptProfileRow, confirmSuggestion, declareOrCorrectClaim, dismissSuggestion } from '@/lib/creator-focus'
import { AT, CHANNEL_A, CHANNEL_B, candidate, deepFreeze, row } from './support/creator-focus-fixtures'

const suggestionsRow = () => row({
  detected_niche_candidates: [candidate('otthoni edzés kezdőknek', 'health'), candidate('főzés gyorsan', 'lifestyle')],
  active_channel_id: CHANNEL_A,
})

describe('a suggestion becomes a confirmed claim only through an explicit confirmation', () => {
  it('reading the row alone never promotes it', () => {
    const p = adaptProfileRow(suggestionsRow())
    expect(p.claims.specific_focus).toBeUndefined()
    expect(p.suggestions).toHaveLength(2)
  })

  it('confirmSuggestion: focus and category become user_confirmed facts, the suggestion is consumed, a history entry exists', () => {
    const before = deepFreeze(adaptProfileRow(suggestionsRow()))
    const result = confirmSuggestion(before, 0, AT)
    if (!result.ok) throw new Error('expected ok')
    expect(result.profile.claims.specific_focus).toMatchObject({ value: 'otthoni edzés kezdőknek', origin: 'user_confirmed', fact_eligible: true, channel_derived: true })
    expect(result.profile.claims.main_category).toMatchObject({ value: 'health', origin: 'user_confirmed', fact_eligible: true })
    expect(result.profile.suggestions.map(s => s.index)).toEqual([1])
    expect(result.profile.history.map(h => [h.seq, h.type, h.field, h.persisted])).toEqual([
      [1, 'confirmed', 'specific_focus', false],
      [2, 'confirmed', 'main_category', false],
    ])
    expect(before.claims.specific_focus).toBeUndefined() // the input is untouched (it is deep-frozen)
  })

  it('is refused while the channel context is uncertain: the product review flow has to clear it', () => {
    const uncertain = adaptProfileRow({ ...suggestionsRow(), niche_needs_review: true })
    const result = confirmSuggestion(uncertain, 0, AT)
    expect(result).toMatchObject({ ok: false, code: 'channel_context_uncertain' })
    expect(result.profile).toBe(uncertain)
  })

  it('rejects an unknown suggestion index and a malformed timestamp', () => {
    const p = adaptProfileRow(suggestionsRow())
    expect(confirmSuggestion(p, 9, AT)).toMatchObject({ ok: false, code: 'unknown_suggestion' })
    expect(confirmSuggestion(p, 0, 'yesterday')).toMatchObject({ ok: false, code: 'invalid_timestamp' })
    expect(confirmSuggestion(p, 0, 12345 as unknown as string)).toMatchObject({ ok: false, code: 'invalid_timestamp' })
  })

  it('dismissSuggestion removes only the suggestion and touches no claim', () => {
    const p = adaptProfileRow({ ...suggestionsRow(), audience: 'kezdők' })
    const result = dismissSuggestion(p, 0, AT)
    if (!result.ok) throw new Error('expected ok')
    expect(result.profile.suggestions.map(s => s.index)).toEqual([1])
    expect(result.profile.claims).toEqual(p.claims)
    expect(result.profile.history[0]).toMatchObject({ type: 'dismissed', persisted: false })
  })
})

describe('declaring and correcting claims', () => {
  it('a new value on an empty field is user_declared', () => {
    const r = declareOrCorrectClaim(adaptProfileRow(row()), 'specific_focus', '  retró   számítógépek ', AT)
    if (!r.ok) throw new Error('expected ok')
    expect(r.profile.claims.specific_focus).toMatchObject({ value: 'retró számítógépek', origin: 'user_declared', fact_eligible: true })
    expect(r.transition).toMatchObject({ type: 'declared', from: null, persisted: false })
  })

  it('a different value over an existing claim is user_corrected and the previous value and origin are kept in the history', () => {
    const start = adaptProfileRow(row({ specific_focus: 'otthoni edzés kezdőknek' }))
    const r = declareOrCorrectClaim(start, 'specific_focus', 'futás maraton előtt', AT)
    if (!r.ok) throw new Error('expected ok')
    expect(r.profile.claims.specific_focus).toMatchObject({ value: 'futás maraton előtt', origin: 'user_corrected', fact_eligible: true })
    expect(r.transition).toMatchObject({
      type: 'corrected',
      from: { value: 'otthoni edzés kezdőknek', origin: 'user_declared' },
      to: { value: 'futás maraton előtt', origin: 'user_corrected' },
    })
  })

  it('correcting a channel-derived claim yields an independent fact that survives a pending review', () => {
    const review = adaptProfileRow({
      ...suggestionsRow(), specific_focus: 'otthoni edzés kezdőknek', niche_validated_for_channel_id: CHANNEL_A, niche_needs_review: true,
    })
    expect(review.claims.specific_focus!.fact_eligible).toBe(false)
    const r = declareOrCorrectClaim(review, 'specific_focus', 'retró számítógépek', AT)
    if (!r.ok) throw new Error('expected ok')
    expect(r.profile.claims.specific_focus).toMatchObject({ origin: 'user_corrected', channel_derived: false, fact_eligible: true })
  })

  it('stating the value that is already a fact is a recorded no-op', () => {
    const start = adaptProfileRow(row({ audience: 'kezdők' }))
    const r = declareOrCorrectClaim(start, 'audience', 'kezdők', AT)
    expect(r).toMatchObject({ ok: true, transition: null })
    expect(r.ok && r.profile).toBe(start)
  })

  it.each([
    ['an unknown field', 'niche' as never, 'x', 'invalid_field'],
    ['a too short focus', 'specific_focus' as const, 'ab', 'invalid_value'],
    ['an over-long text', 'audience' as const, 'x'.repeat(301), 'invalid_value'],
    ['the form-default category', 'main_category' as const, 'other', 'invalid_value'],
    ['an unknown category', 'main_category' as const, 'bogus', 'invalid_value'],
    ['an unknown mode', 'channel_usage_mode' as const, 'auto', 'invalid_value'],
    ['a non-string value', 'avoid_topics' as const, 42, 'invalid_value'],
  ])('rejects %s', (_name, field, value, code) => {
    const start = adaptProfileRow(row())
    const r = declareOrCorrectClaim(start, field, value, AT)
    expect(r).toMatchObject({ ok: false, code })
    expect(r.profile).toBe(start)
  })
})

describe('the history is NOT durable', () => {
  it('re-reading the same profile row after a transition starts from scratch: no confirmation, no correction, no history', () => {
    const source = suggestionsRow()
    const first = adaptProfileRow(source)
    const confirmed = confirmSuggestion(first, 0, AT)
    if (!confirmed.ok) throw new Error('expected ok')
    expect(confirmed.profile.claims.specific_focus?.origin).toBe('user_confirmed')
    expect(confirmed.profile.history).toHaveLength(2)

    // "restart": the only persistent thing is the row, and nothing wrote to it
    const reread = adaptProfileRow(source)
    expect(reread.claims.specific_focus).toBeUndefined()
    expect(reread.suggestions).toHaveLength(2)
    expect(reread.history).toEqual([])
    expect(JSON.stringify(reread)).toBe(JSON.stringify(first))
  })

  it('every profile and every history entry says it is not persisted', () => {
    const r = declareOrCorrectClaim(adaptProfileRow(row()), 'audience', 'kezdők', AT)
    if (!r.ok) throw new Error('expected ok')
    expect(r.profile.persistence).toBe('none')
    expect(r.profile.history.every(h => h.persisted === false)).toBe(true)
  })

  it('is deterministic: the same inputs give identical outputs (the caller supplies the timestamp)', () => {
    const run = () => {
      const p = adaptProfileRow(suggestionsRow())
      const a = confirmSuggestion(p, 1, AT)
      if (!a.ok) throw new Error('expected ok')
      const b = declareOrCorrectClaim(a.profile, 'audience', 'kezdők', AT)
      return JSON.stringify(b)
    }
    expect(run()).toBe(run())
  })

  it('the other channel keeps its separation: a suggestion for another channel cannot be confirmed', () => {
    const p = adaptProfileRow(row({ detected_niche_candidates: [candidate('otthoni edzés kezdőknek', 'health', CHANNEL_B)], active_channel_id: CHANNEL_A }))
    expect(p.suggestions).toEqual([])
    expect(confirmSuggestion(p, 0, AT)).toMatchObject({ ok: false, code: 'unknown_suggestion' })
  })
})
