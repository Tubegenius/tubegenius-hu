// Creator Intelligence 2B: PROVENANCE of the decision record, and the limits / details the independent review found
// untested. DB-free; the events are plain arguments, NOTHING here is durable or user-facing.
import { describe, expect, it } from 'vitest'
import {
  applyDecisions,
  confirmSuggestion,
  declareOrCorrectClaim,
  validateDecisionEvents,
  validateSnapshot,
  type FocusDecisionEvent,
} from '@/lib/creator-focus'
import { candidate } from './support/creator-focus-fixtures'
import {
  CHANNEL_A,
  CHANNEL_B,
  COOKING,
  FOCUS,
  USER,
  confirmEvent,
  uuid,
  world,
} from './support/creator-focus-decision-fixtures'

const statusOf = (r: ReturnType<typeof applyDecisions>, field: 'specific_focus' | 'main_category') => r.read_model.claims[field].confirmation.status
const AT = '2026-10-17T10:00:00Z'

describe('PROVENANCE: a decision record never rewrites the creator\'s own claim into a channel-derived one', () => {
  const OWN_FOCUS = 'saját egyedi témám'
  /** the review's example: the creator's own focus, and a category that happens to equal a stored suggestion's category */
  const ownWorld = (rowExtras: Record<string, unknown> = {}) =>
    world({ focus: OWN_FOCUS, category: 'health', candidates: [candidate(FOCUS, 'health', CHANNEL_A)], rowExtras })

  it('the 2A adapter already holds both claims as the creator\'s own (so the test starts from the right place)', () => {
    const { profile } = ownWorld()
    expect(profile.claims.specific_focus).toMatchObject({ origin: 'user_declared', channel_derived: false, fact_eligible: true })
    expect(profile.claims.main_category).toMatchObject({ origin: 'user_declared', channel_derived: false, fact_eligible: true })
    expect(profile.suggestions.map(s => s.specific_focus)).toEqual([FOCUS])
  })

  it('REVIEW EXAMPLE: a confirm event for the category does not downgrade it; nothing changes', () => {
    const { profile, snapshot } = ownWorld()
    const events = [confirmEvent(1, 'main_category', { revision: '7' })] // (otthoni edzés kezdőknek, health), channel A, current revision
    const result = applyDecisions(profile, snapshot, events)
    expect(statusOf(result, 'main_category')).toBe('claim_not_confirmable')
    expect(result.read_model.claims.main_category.confirmation.decision_id).toBeNull()
    expect(result.profile.claims.main_category).toEqual(profile.claims.main_category)
    expect(result.profile.claims.main_category).toMatchObject({ origin: 'user_declared', channel_derived: false, fact_eligible: true })
    expect(result.profile.claims.main_category?.reasons).not.toContain('confirmed_by_decision_record')
    expect(result.profile.claims).toEqual(profile.claims)
    expect(result.read_model.layer).toBe('applied')
  })

  it('REVIEW EXAMPLE: a confirm event for the creator\'s own focus does not downgrade it either', () => {
    const { profile, snapshot } = ownWorld()
    const events = [confirmEvent(1, 'specific_focus', { revision: '5', value: OWN_FOCUS })]
    const result = applyDecisions(profile, snapshot, events)
    expect(statusOf(result, 'specific_focus')).toBe('claim_not_confirmable')
    expect(result.profile.claims.specific_focus).toEqual(profile.claims.specific_focus)
    expect(result.profile.claims.specific_focus).toMatchObject({ origin: 'user_declared', channel_derived: false, fact_eligible: true })
  })

  it('PENDING CHANNEL REVIEW (niche_needs_review: true): the creator\'s own claims stay the creator\'s own, the 2A fact flag untouched', () => {
    const { profile, snapshot } = ownWorld({ niche_needs_review: true })
    expect(profile.channel.niche_review_required).toBe(true)
    const events = [confirmEvent(1, 'specific_focus', { revision: '5', value: OWN_FOCUS }), confirmEvent(2, 'main_category', { revision: '7' })]
    const result = applyDecisions(profile, snapshot, events)
    expect(statusOf(result, 'specific_focus')).toBe('claim_not_confirmable')
    expect(statusOf(result, 'main_category')).toBe('claim_not_confirmable')
    expect(result.profile.claims).toEqual(profile.claims)
    expect(result.profile.claims.specific_focus?.origin).toBe('user_declared')
    expect(result.profile.claims.main_category?.origin).toBe('user_declared')
  })

  it('PENDING CHANNEL REVIEW: a suggestion-matching claim becomes `user_confirmed` but is still NOT a fact', () => {
    const { profile, snapshot } = world({ rowExtras: { niche_needs_review: true } })
    const result = applyDecisions(profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(statusOf(result, 'specific_focus')).toBe('valid')
    expect(result.profile.claims.specific_focus).toMatchObject({ origin: 'user_confirmed', fact_eligible: false })
  })

  it('a `user_corrected` claim is never touched by a matching confirm event', () => {
    // the creator held another value and corrected it to the text of a stored suggestion
    const base = world({ focus: COOKING, category: 'lifestyle' })
    const corrected = declareOrCorrectClaim(base.profile, 'specific_focus', FOCUS, AT)
    expect(corrected.ok).toBe(true)
    if (!corrected.ok) return
    expect(corrected.profile.claims.specific_focus).toMatchObject({ value: FOCUS, origin: 'user_corrected' })
    const snapshot = { ...base.snapshot, fields: { ...base.snapshot.fields, specific_focus: { value: FOCUS, revision: '5' } } }
    const result = applyDecisions(corrected.profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(statusOf(result, 'specific_focus')).toBe('claim_not_confirmable')
    expect(result.profile.claims.specific_focus).toEqual(corrected.profile.claims.specific_focus)
    expect(result.profile.claims.specific_focus?.origin).toBe('user_corrected')
  })

  it('an `unknown` claim that is NOT channel-derived (not a suggestion match) is not confirmable either', () => {
    const { profile, snapshot } = world()
    const crafted = structuredClone(profile)
    crafted.claims.main_category = { field: 'main_category', value: 'health', origin: 'unknown', channel_derived: false, fact_eligible: false, reasons: ['form_default_value_indistinguishable'] }
    const result = applyDecisions(crafted, snapshot, [confirmEvent(1, 'main_category', { revision: '7' })])
    expect(result.read_model.layer).toBe('applied')
    expect(statusOf(result, 'main_category')).toBe('claim_not_confirmable')
    expect(result.profile.claims.main_category).toEqual(crafted.claims.main_category)
  })

  it('an already confirmed claim (the in-memory 2A transition) is not rewritten by a decision event', () => {
    const { profile, snapshot } = world()
    const confirmed = confirmSuggestion(profile, profile.suggestions[0].index, AT)
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    const result = applyDecisions(confirmed.profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(statusOf(result, 'specific_focus')).toBe('claim_not_confirmable')
    expect(result.profile.claims.specific_focus).toEqual(confirmed.profile.claims.specific_focus)
  })

  it('a confirmation recorded earlier stops upgrading when the claim is no longer a suggestion match', () => {
    // the suggestion list is regenerated and no longer contains the creator's focus: the claim is now user_declared
    const w = world({ candidates: [candidate('valami egészen más téma', 'lifestyle', CHANNEL_A)] })
    expect(w.profile.claims.specific_focus?.origin).toBe('user_declared')
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(statusOf(result, 'specific_focus')).toBe('claim_not_confirmable')
    expect(result.profile.claims.specific_focus?.origin).toBe('user_declared')
  })

  it('a category confirmation covers the WHOLE suggestion: if the focus is not that suggestion\'s focus it is not valid', () => {
    // both suggestions are health, the creator holds the cooking focus; the category event was made against the home-workout one
    const w = world({ focus: COOKING, category: 'health', candidates: [candidate(FOCUS, 'health', CHANNEL_A), candidate(COOKING, 'health', CHANNEL_A)] })
    expect(w.profile.claims.main_category).toMatchObject({ origin: 'unknown', channel_derived: true })
    const against = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'main_category', { revision: '7' })]) // suggestion = (FOCUS, health)
    expect(statusOf(against, 'main_category')).toBe('invalidated_by_value_change')
    expect(against.profile.claims.main_category?.origin).toBe('unknown')
    const right = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'main_category', { revision: '7', suggestion: { main_category: 'health', specific_focus: COOKING } })])
    expect(statusOf(right, 'main_category')).toBe('valid')
    expect(right.profile.claims.main_category?.origin).toBe('user_confirmed')
  })

  it('a category confirmation stops being valid when only the focus changes afterwards (the category revision is unchanged)', () => {
    const before = world()
    expect(statusOf(applyDecisions(before.profile, before.snapshot, [confirmEvent(1, 'main_category', { revision: '7' })]), 'main_category')).toBe('valid')
    // the creator later saves a different focus that is still a suggestion of the same channel with the same category
    const after = world({ focus: COOKING, category: 'health', fRev: '6', candidates: [candidate(FOCUS, 'health', CHANNEL_A), candidate(COOKING, 'health', CHANNEL_A)] })
    const result = applyDecisions(after.profile, after.snapshot, [confirmEvent(1, 'main_category', { revision: '7' })])
    expect(statusOf(result, 'main_category')).toBe('invalidated_by_value_change')
    expect(result.profile.claims.main_category?.origin).toBe('unknown')
  })
})

describe('LIMITS and details the review found untested', () => {
  const ev = (seq: number): FocusDecisionEvent => confirmEvent(seq, 'specific_focus', { revision: '5' })

  it('exactly 5000 distinct valid events are accepted', () => {
    const events = Array.from({ length: 5000 }, (_, i) => ev(i + 1))
    expect(new Set(events.map(e => e.id)).size).toBe(5000)
    expect(new Set(events.map(e => e.request_id.toLowerCase())).size).toBe(5000)
    expect(validateDecisionEvents(events, USER).issues).toEqual([])
    const { profile, snapshot } = world()
    expect(applyDecisions(profile, snapshot, events).read_model.layer).toBe('applied')
  })

  it('5001 distinct valid events are refused with `too_many_events` (the limit itself, not a duplicate)', () => {
    const events = Array.from({ length: 5001 }, (_, i) => ev(i + 1))
    expect(new Set(events.map(e => e.id)).size).toBe(5001)
    expect(new Set(events.map(e => e.request_id.toLowerCase())).size).toBe(5001)
    expect(new Set(events.map(e => e.seq)).size).toBe(5001)
    expect(validateDecisionEvents(events, USER).issues).toEqual([{ path: 'events', code: 'too_many_events' }])
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, events)
    expect(result.read_model.layer).toBe('disabled')
    expect(result.read_model.issues).toEqual([{ path: 'events', code: 'decision_events_invalid' }, { path: 'events', code: 'too_many_events' }])
    expect(result.profile).toEqual(profile)
  })

  it('a snapshot value of exactly 5000 characters is accepted, 5001 is refused', () => {
    expect(validateSnapshot({ user_id: USER, fields: { specific_focus: { value: 'x'.repeat(5000), revision: '1' }, main_category: { value: null, revision: '1' } } }).issues).toEqual([])
    expect(validateSnapshot({ user_id: USER, fields: { specific_focus: { value: 'x'.repeat(5001), revision: '1' }, main_category: { value: null, revision: '1' } } }).issues).toEqual([
      { path: 'snapshot.fields.specific_focus.value', code: 'invalid_value' },
    ])
  })

  it('two valid confirmations of one field: the decision id is the LATEST one, in any input order', () => {
    const { profile, snapshot } = world()
    const events = [ev(1), ev(3)]
    for (const input of [events, [...events].reverse()]) {
      const result = applyDecisions(profile, snapshot, input)
      expect(result.read_model.claims.specific_focus.confirmation).toEqual({ status: 'valid', decision_id: 'ev-3' })
    }
  })

  it('when none is valid, the status reports the MOST RECENT confirmation', () => {
    const { profile, snapshot } = world()
    const otherChannel = confirmEvent(1, 'specific_focus', { revision: '5', channel: CHANNEL_B })
    const staleRevision = confirmEvent(2, 'specific_focus', { revision: '4' })
    expect(statusOf(applyDecisions(profile, snapshot, [otherChannel, staleRevision]), 'specific_focus')).toBe('invalidated_by_value_change')
    const otherChannelLater = { ...otherChannel, seq: 3, id: 'ev-3', request_id: uuid(3) }
    expect(statusOf(applyDecisions(profile, snapshot, [staleRevision, otherChannelLater]), 'specific_focus')).toBe('invalidated_by_channel_change')
  })

  it('the validated event list is a COPY: changing the result never changes the caller\'s events', () => {
    const input = [ev(1), ev(2)]
    const before = JSON.stringify(input)
    const { events } = validateDecisionEvents(input, USER)
    expect(events).toEqual(input)
    expect(events[0]).not.toBe(input[0])
    events[0].channel_id = 'tampered'
    events[1].field_revision = '999'
    expect(JSON.stringify(input)).toBe(before)
  })

  it('JSON-shaped input is the contract: a JSON round trip of a valid list is accepted unchanged', () => {
    const roundTrip = JSON.parse(JSON.stringify([ev(1), ev(2)]))
    expect(validateDecisionEvents(roundTrip, USER).issues).toEqual([])
    expect(validateDecisionEvents(roundTrip, USER).events).toEqual([ev(1), ev(2)])
  })
})
