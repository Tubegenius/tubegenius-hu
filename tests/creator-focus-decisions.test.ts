// Creator Intelligence 2B: the PURE reducer / read model (profile view + snapshot + decision events -> profile view).
// DB-free; the events are plain arguments, NOTHING here is durable or user-facing.
//
// Mandatory negative cases: A -> B -> A, a stale revision, an unknown fingerprint version.
import { describe, expect, it, vi } from 'vitest'
import {
  adaptProfileRow,
  applyDecisions,
  assessFocusFit,
  focusSuggestionFingerprint,
  isFactEligible,
  validateFocusProfile,
  type FocusDecisionEvent,
} from '@/lib/creator-focus'
import { candidate, deepFreeze, row } from './support/creator-focus-fixtures'
import {
  CHANNEL_A,
  CHANNEL_B,
  COOKING,
  FOCUS,
  OTHER_USER,
  SUGGESTION_COOKING,
  SUGGESTION_FOCUS,
  USER,
  confirmEvent,
  dismissEvent,
  shuffled,
  withdrawConfirmationEvent,
  withdrawDismissalEvent,
  world,
} from './support/creator-focus-decision-fixtures'

const statusOf = (r: ReturnType<typeof applyDecisions>, field: 'specific_focus' | 'main_category') => r.read_model.claims[field].confirmation.status

describe('without any decision the 2A behaviour is unchanged', () => {
  it('an empty event list returns an equal profile (a copy), all statuses `none`, the layer applied', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [])
    expect(result.profile).toEqual(profile)
    expect(result.profile).not.toBe(profile)
    expect(result.read_model.layer).toBe('applied')
    expect(statusOf(result, 'specific_focus')).toBe('none')
    expect(statusOf(result, 'main_category')).toBe('none')
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown')
  })

  it('holds over a range of 2A rows, including an empty row and rows with the validation marker', () => {
    const rows = [
      row(),
      row({ specific_focus: FOCUS, detected_niche_candidates: [candidate(FOCUS, 'health')], active_channel_id: CHANNEL_A, niche_validated_for_channel_id: CHANNEL_A }),
      row({ specific_focus: 'saját téma 123', main_category: 'tech_ai', audience: 'kezdők', avoid_topics: 'politika', channel_usage_mode: 'niche_discovery' }),
      row({ specific_focus: FOCUS, detected_niche_candidates: [candidate(FOCUS, 'health', CHANNEL_B)], active_channel_id: CHANNEL_A, channel_connection_type: 'mismatch' }),
    ]
    for (const r of rows) {
      const profile = adaptProfileRow(r)
      const snapshot = {
        user_id: USER,
        fields: {
          specific_focus: { value: typeof r.specific_focus === 'string' ? r.specific_focus : null, revision: '0' },
          main_category: { value: typeof r.main_category === 'string' ? r.main_category : null, revision: '0' },
        },
      }
      expect(applyDecisions(profile, snapshot, []).profile).toEqual(profile)
    }
  })

  it('a profile row and its validation marker NEVER make a confirmation (no retroactive user_confirmed)', () => {
    const { profile, snapshot } = world({ rowExtras: { niche_validated_for_channel_id: CHANNEL_A } })
    const result = applyDecisions(profile, snapshot, [])
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown')
    expect(result.profile.claims.main_category?.origin).toBe('unknown')
    expect(result.profile.claims.specific_focus?.fact_eligible).toBe(false)
  })

  it('does not mutate any input (all inputs deep-frozen) and is deterministic', () => {
    const { profile, snapshot } = world()
    const events = [confirmEvent(1, 'specific_focus', { revision: '5' }), dismissEvent(2, SUGGESTION_COOKING)]
    deepFreeze(profile); deepFreeze(snapshot); deepFreeze(events)
    const a = applyDecisions(profile, snapshot, events)
    const b = applyDecisions(profile, snapshot, events)
    expect(a).toEqual(b)
  })
})

describe('a valid confirmation', () => {
  it('turns the matching claim into user_confirmed: channel-derived, a fact, with the decision-record reason; both fields independently', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [
      confirmEvent(1, 'specific_focus', { revision: '5' }),
      confirmEvent(2, 'main_category', { revision: '7' }),
    ])
    const focus = result.profile.claims.specific_focus!
    expect(focus).toMatchObject({ origin: 'user_confirmed', channel_derived: true, fact_eligible: true, reasons: ['confirmed_by_decision_record'], value: FOCUS })
    expect(result.profile.claims.main_category).toMatchObject({ origin: 'user_confirmed', channel_derived: true, fact_eligible: true, value: 'health' })
    expect(statusOf(result, 'specific_focus')).toBe('valid')
    expect(result.read_model.claims.specific_focus.confirmation.decision_id).toBe('ev-1')
    expect(validateFocusProfile(result.profile)).toEqual([])
    expect(isFactEligible(focus, result.profile.channel)).toBe(true)
  })

  it('confirming one field leaves the other alone', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(result.profile.claims.main_category?.origin).toBe('unknown')
    expect(statusOf(result, 'main_category')).toBe('none')
  })

  it('the confirmed focus is used as a FACT by the fit assessment; unconfirmed it is not', () => {
    const { profile, snapshot } = world()
    const topic = { text: 'otthoni edzés kezdőknek egyszerűen' }
    expect(assessFocusFit({ contract_version: 'creator-focus.v1', profile, topic }).status).toBe('unknown')
    const confirmed = applyDecisions(profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })]).profile
    const fit = assessFocusFit({ contract_version: 'creator-focus.v1', profile: confirmed, topic })
    expect(fit.status).toBe('fits')
    expect(fit.basis.claims_used).toEqual([{ field: 'specific_focus', origin: 'user_confirmed' }])
  })

  it('under a pending niche review the claim is user_confirmed but NOT a fact (the 2A rule for channel-derived claims)', () => {
    const { profile, snapshot } = world({ rowExtras: { niche_needs_review: true } })
    expect(profile.channel.context_uncertain).toBe(true)
    const result = applyDecisions(profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(result.profile.claims.specific_focus).toMatchObject({ origin: 'user_confirmed', fact_eligible: false })
    const fit = assessFocusFit({ contract_version: 'creator-focus.v1', profile: result.profile, topic: { text: 'otthoni edzés kezdőknek egyszerűen' } })
    expect(fit.status).toBe('unknown')
  })

  it('the order of the input array does not matter (events are ordered by seq)', () => {
    const { profile, snapshot } = world()
    const events = [
      confirmEvent(1, 'specific_focus', { revision: '5' }),
      withdrawConfirmationEvent(2, 'specific_focus'),
      confirmEvent(3, 'specific_focus', { revision: '5' }),
      dismissEvent(4, SUGGESTION_COOKING),
      withdrawDismissalEvent(5, SUGGESTION_COOKING),
    ]
    const expected = applyDecisions(profile, snapshot, events)
    for (let seed = 1; seed <= 20; seed++) expect(applyDecisions(profile, snapshot, shuffled(events, seed))).toEqual(expected)
    expect(statusOf(expected, 'specific_focus')).toBe('valid')
  })
})

describe('A -> B -> A: a confirmation does not come back by itself', () => {
  it('after the value changed to B and back to A (new revisions) the old confirmation is NOT valid; a new decision on the new revision is', () => {
    const events: FocusDecisionEvent[] = [confirmEvent(1, 'specific_focus', { revision: '5' })]

    const atA = world({ fRev: '5' })
    expect(statusOf(applyDecisions(atA.profile, atA.snapshot, events), 'specific_focus')).toBe('valid')

    const atB = world({ focus: COOKING, category: 'lifestyle', fRev: '9' })
    const b = applyDecisions(atB.profile, atB.snapshot, events)
    expect(statusOf(b, 'specific_focus')).toBe('invalidated_by_value_change')
    expect(b.profile.claims.specific_focus?.origin).not.toBe('user_confirmed')

    const backToA = world({ fRev: '12' }) // the SAME words as before, but a new revision
    const again = applyDecisions(backToA.profile, backToA.snapshot, events)
    expect(statusOf(again, 'specific_focus')).toBe('invalidated_by_value_change')
    expect(again.profile.claims.specific_focus?.origin).toBe('unknown')
    expect(again.profile.claims.specific_focus?.fact_eligible).toBe(false)

    const decided = applyDecisions(backToA.profile, backToA.snapshot, [...events, confirmEvent(2, 'specific_focus', { revision: '12' })])
    expect(statusOf(decided, 'specific_focus')).toBe('valid')
    expect(decided.read_model.claims.specific_focus.confirmation.decision_id).toBe('ev-2')
  })

  it('even a revision that went DOWN or only changed once does not revive it: only equality counts', () => {
    const events = [confirmEvent(1, 'specific_focus', { revision: '5' })]
    for (const revision of ['0', '4', '6', '50', '9223372036854775807']) {
      const w = world({ fRev: revision })
      expect(statusOf(applyDecisions(w.profile, w.snapshot, events), 'specific_focus')).toBe('invalidated_by_value_change')
    }
  })
})

describe('a stale revision', () => {
  it('the same words but another revision: the confirmation is not valid (the fingerprint alone is never enough)', () => {
    const w = world({ fRev: '6' })
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(statusOf(result, 'specific_focus')).toBe('invalidated_by_value_change')
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown')
  })

  it('the SAME revision but a different value (the revision protection was bypassed): reported as an integrity mismatch and NOT honoured', () => {
    const w = world({ focus: COOKING, category: 'lifestyle', fRev: '5' })
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(statusOf(result, 'specific_focus')).toBe('integrity_mismatch')
    expect(result.profile.claims.specific_focus?.origin).not.toBe('user_confirmed')
  })

  it('a revision is compared as text: "5" is not "05" or 5', () => {
    const w = world({ fRev: '5' })
    const event = { ...confirmEvent(1, 'specific_focus', { revision: '5' }), field_revision: '05' }
    const result = applyDecisions(w.profile, w.snapshot, [event])
    expect(result.read_model.layer).toBe('disabled') // "05" is not a canonical revision: the whole record is rejected
  })
})

describe('an unknown fingerprint version', () => {
  it('is inert: never reinterpreted, never honoured, reported', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5', version: 2 })])
    expect(result.read_model.layer).toBe('applied')
    expect(statusOf(result, 'specific_focus')).toBe('unsupported_fingerprint_version')
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown')
  })

  it('does not disturb a valid v1 confirmation next to it', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [
      confirmEvent(1, 'specific_focus', { revision: '5' }),
      confirmEvent(2, 'specific_focus', { revision: '5', version: 2 }),
    ])
    expect(statusOf(result, 'specific_focus')).toBe('valid')
    expect(result.read_model.claims.specific_focus.confirmation.decision_id).toBe('ev-1')
  })

  it('an unknown-version dismissal does not hide anything', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [{ ...dismissEvent(1, SUGGESTION_COOKING), fingerprint_version: 2 }])
    expect(result.profile.suggestions).toHaveLength(profile.suggestions.length)
    expect(result.read_model.suggestions.every(s => s.status === 'open')).toBe(true)
  })
})

describe('the channel binding', () => {
  it('a confirmation made on channel A is not valid on channel B, and valid again when channel A is active again (same revision)', () => {
    const events = [confirmEvent(1, 'specific_focus', { revision: '5', channel: CHANNEL_A })]
    const onA = world({ channel: CHANNEL_A })
    const onB = world({ channel: CHANNEL_B })
    expect(statusOf(applyDecisions(onA.profile, onA.snapshot, events), 'specific_focus')).toBe('valid')
    const moved = applyDecisions(onB.profile, onB.snapshot, events)
    expect(statusOf(moved, 'specific_focus')).toBe('invalidated_by_channel_change')
    expect(moved.profile.claims.specific_focus?.origin).not.toBe('user_confirmed')
    expect(statusOf(applyDecisions(onA.profile, onA.snapshot, events), 'specific_focus')).toBe('valid')
  })

  it('no active channel: nothing is valid', () => {
    const w = world({ channel: null })
    expect(statusOf(applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })]), 'specific_focus')).toBe('invalidated_by_channel_change')
  })

  it('a decision on the other channel can be valid next to an invalid one', () => {
    const onB = world({ channel: CHANNEL_B })
    const result = applyDecisions(onB.profile, onB.snapshot, [
      confirmEvent(1, 'specific_focus', { revision: '5', channel: CHANNEL_A }),
      confirmEvent(2, 'specific_focus', { revision: '5', channel: CHANNEL_B }),
    ])
    expect(statusOf(result, 'specific_focus')).toBe('valid')
    expect(result.read_model.claims.specific_focus.confirmation.decision_id).toBe('ev-2')
  })
})

describe('withdrawal', () => {
  it('takes back the confirmation; the claim returns to its 2A origin', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' }), withdrawConfirmationEvent(2, 'specific_focus')])
    expect(statusOf(result, 'specific_focus')).toBe('withdrawn')
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown')
  })

  it('a LATER confirmation is a new explicit decision and counts again', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [
      confirmEvent(1, 'specific_focus', { revision: '5' }),
      withdrawConfirmationEvent(2, 'specific_focus'),
      confirmEvent(3, 'specific_focus', { revision: '5' }),
    ])
    expect(statusOf(result, 'specific_focus')).toBe('valid')
    expect(result.read_model.claims.specific_focus.confirmation.decision_id).toBe('ev-3')
  })

  it('a withdrawal before the confirmation has no effect', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [withdrawConfirmationEvent(1, 'specific_focus'), confirmEvent(2, 'specific_focus', { revision: '5' })])
    expect(statusOf(result, 'specific_focus')).toBe('valid')
  })

  it('one withdrawal takes back every earlier confirmation of that field on that channel', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [
      confirmEvent(1, 'specific_focus', { revision: '5' }),
      confirmEvent(2, 'specific_focus', { revision: '5' }),
      withdrawConfirmationEvent(3, 'specific_focus'),
    ])
    expect(statusOf(result, 'specific_focus')).toBe('withdrawn')
  })

  it('a withdrawal of another field or another channel does not touch it', () => {
    const { profile, snapshot } = world()
    const events = [
      confirmEvent(1, 'specific_focus', { revision: '5' }),
      withdrawConfirmationEvent(2, 'main_category'),
      withdrawConfirmationEvent(3, 'specific_focus', CHANNEL_B),
    ]
    expect(statusOf(applyDecisions(profile, snapshot, events), 'specific_focus')).toBe('valid')
  })

  it('a confirmation that arrives late (a higher seq, an old revision) cannot cancel a valid one made on the current revision', () => {
    const { profile, snapshot } = world({ fRev: '6' })
    const result = applyDecisions(profile, snapshot, [
      confirmEvent(1, 'specific_focus', { revision: '6' }),
      confirmEvent(2, 'specific_focus', { revision: '5' }), // raced: made on the revision before the last save
    ])
    expect(statusOf(result, 'specific_focus')).toBe('valid')
    expect(result.read_model.claims.specific_focus.confirmation.decision_id).toBe('ev-1')
  })
})

describe('dismissal: suppressed in THIS read model only', () => {
  it('hides the dismissed suggestion in the returned profile and marks it in the read model; claims are untouched', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [dismissEvent(1, SUGGESTION_COOKING)])
    expect(result.profile.suggestions.map(s => s.specific_focus)).toEqual([FOCUS])
    const rows = result.read_model.suggestions
    expect(rows.find(s => s.specific_focus === COOKING)?.status).toBe('dismissed')
    expect(rows.find(s => s.specific_focus === FOCUS)?.status).toBe('open')
    expect(result.profile.claims).toEqual(profile.claims)
    expect(result.read_model.limitations).toContain('dismissal_suppression_applies_to_this_read_model_only_not_to_any_suggestion_generator')
  })

  it('is keyed by content, not by position: the same suggestion regenerated at another index stays dismissed', () => {
    const regenerated = world({ candidates: [candidate(COOKING, 'lifestyle'), candidate(FOCUS, 'health')] })
    const result = applyDecisions(regenerated.profile, regenerated.snapshot, [dismissEvent(1, SUGGESTION_COOKING)])
    expect(result.profile.suggestions.map(s => s.specific_focus)).toEqual([FOCUS])
  })

  it('is keyed by the STRICT identity: a suggestion regenerated with other case / punctuation is a different one and is open again', () => {
    const regenerated = world({ candidates: [candidate('FŐZÉS, gyorsan!', 'lifestyle'), candidate(FOCUS, 'health')] })
    const result = applyDecisions(regenerated.profile, regenerated.snapshot, [dismissEvent(1, SUGGESTION_COOKING)])
    expect(result.read_model.suggestions.find(s => s.specific_focus === 'FŐZÉS, gyorsan!')?.status).toBe('open')
  })

  it('a regeneration that differs only in whitespace or Unicode normalisation is the same suggestion (still dismissed)', () => {
    const regenerated = world({ candidates: [candidate('főzés   gyorsan ', 'lifestyle'), candidate(FOCUS, 'health')] })
    const result = applyDecisions(regenerated.profile, regenerated.snapshot, [dismissEvent(1, SUGGESTION_COOKING)])
    expect(result.read_model.suggestions.find(s => s.specific_focus === COOKING)?.status).toBe('dismissed')
    const nfd = world({ candidates: [candidate('fözés gyorsan'.normalize('NFD'), 'lifestyle'), candidate(FOCUS, 'health')] })
    expect(applyDecisions(nfd.profile, nfd.snapshot, [dismissEvent(1, { main_category: 'lifestyle', specific_focus: 'fözés gyorsan' })]).read_model.suggestions[0].status).toBe('dismissed')
  })

  it('two suggestions that the lossy 2A key would merge are two decisions: dismissing one does not hide the other', () => {
    const w = world({ candidates: [candidate('Łódź', 'lifestyle'), candidate('odz', 'lifestyle')] })
    const result = applyDecisions(w.profile, w.snapshot, [dismissEvent(1, { main_category: 'lifestyle', specific_focus: 'Łódź' })])
    expect(result.read_model.suggestions.map(s => [s.specific_focus, s.status])).toEqual([['Łódź', 'dismissed'], ['odz', 'open']])
    expect(result.profile.suggestions.map(s => s.specific_focus)).toEqual(['odz'])
  })

  it('another category is another suggestion', () => {
    const regenerated = world({ candidates: [candidate(COOKING, 'health'), candidate(FOCUS, 'health')] })
    const result = applyDecisions(regenerated.profile, regenerated.snapshot, [dismissEvent(1, SUGGESTION_COOKING)])
    expect(result.profile.suggestions).toHaveLength(2)
  })

  it('a dismissal made on another channel does not hide anything here', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [dismissEvent(1, SUGGESTION_COOKING, CHANNEL_B)])
    expect(result.profile.suggestions).toHaveLength(profile.suggestions.length)
  })

  it('withdrawing the dismissal restores the suggestion; a later dismissal hides it again (the latest wins)', () => {
    const { profile, snapshot } = world()
    const open = applyDecisions(profile, snapshot, [dismissEvent(1, SUGGESTION_COOKING), withdrawDismissalEvent(2, SUGGESTION_COOKING)])
    expect(open.profile.suggestions).toHaveLength(profile.suggestions.length)
    const hidden = applyDecisions(profile, snapshot, [dismissEvent(1, SUGGESTION_COOKING), withdrawDismissalEvent(2, SUGGESTION_COOKING), dismissEvent(3, SUGGESTION_COOKING)])
    expect(hidden.profile.suggestions.map(s => s.specific_focus)).toEqual([FOCUS])
  })

  it('dismissing a suggestion does not withdraw a confirmation and a confirmation does not dismiss anything', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' }), dismissEvent(2, SUGGESTION_FOCUS)])
    expect(statusOf(result, 'specific_focus')).toBe('valid')
    expect(result.profile.suggestions.map(s => s.specific_focus)).toEqual([COOKING])
  })

  it('makes no claim about any generator: the stored candidates are untouched (the profile row is not an input to be edited)', () => {
    const { profile, snapshot } = world()
    deepFreeze(profile)
    expect(() => applyDecisions(profile, snapshot, [dismissEvent(1, SUGGESTION_COOKING)])).not.toThrow()
  })
})

describe('FAIL-CLOSED: one bad input disables the whole decision layer, and the profile comes back unchanged', () => {
  const valid = () => confirmEvent(1, 'specific_focus', { revision: '5' })
  const mutate = (patch: Record<string, unknown>) => ({ ...valid(), ...patch })

  const badEvents: Array<[string, unknown]> = [
    ['not an array', { 0: valid() }],
    ['an event that is not an object', ['x']],
    ['a missing key', (() => { const e: Record<string, unknown> = { ...valid() }; delete e.created_at; return [e] })()],
    ['an extra key', [mutate({ value_text: 'otthoni edzés kezdőknek' })]],
    ['an empty id', [mutate({ id: '' })]],
    ['seq 0', [mutate({ seq: 0 })]],
    ['a fractional seq', [mutate({ seq: 1.5 })]],
    ['a seq beyond the safe integer range (1e21)', [mutate({ seq: 1e21 })]],
    ['a seq of 2^53', [mutate({ seq: 2 ** 53 })]],
    ['a negative seq', [mutate({ seq: -3 })]],
    ['a string seq', [mutate({ seq: '1' })]],
    ['a foreign user', [mutate({ user_id: OTHER_USER })]],
    ['an invalid request_id', [mutate({ request_id: 'not-a-uuid' })]],
    ['an unknown action', [mutate({ action: 'approve' })]],
    ['an empty channel', [mutate({ channel_id: '' })]],
    ['fingerprint_version 0', [mutate({ fingerprint_version: 0 })]],
    ['fingerprint_version 1001', [mutate({ fingerprint_version: 1001 })]],
    ['a fractional fingerprint_version', [mutate({ fingerprint_version: 1.5 })]],
    ['an invalid timestamp', [mutate({ created_at: '2026-10-17 10:00' })]],
    ['an unknown field', [mutate({ field: 'audience' })]],
    ['a confirm without a revision', [mutate({ field_revision: null })]],
    ['a confirm without a value fingerprint', [mutate({ value_fingerprint: null })]],
    ['a confirm with withdraws set', [mutate({ withdraws: 'confirmation' })]],
    ['an upper-case fingerprint', [mutate({ value_fingerprint: 'A'.repeat(64) })]],
    ['a short fingerprint', [mutate({ value_fingerprint: 'abc' })]],
    ['a leading-zero revision', [mutate({ field_revision: '007' })]],
    ['a negative revision', [mutate({ field_revision: '-1' })]],
    ['a fractional revision', [mutate({ field_revision: '1.5' })]],
    ['a numeric revision', [mutate({ field_revision: 5 })]],
    ['a 20-digit revision', [mutate({ field_revision: '1'.repeat(20) })]],
    ['a dismiss with a field', [{ ...dismissEvent(1, SUGGESTION_COOKING), field: 'specific_focus' }]],
    ['a dismiss without a suggestion fingerprint', [{ ...dismissEvent(1, SUGGESTION_COOKING), suggestion_fingerprint: null }]],
    ['a withdraw without a target', [{ ...withdrawConfirmationEvent(1, 'specific_focus'), withdraws: null }]],
    ['a withdraw(confirmation) without a field', [{ ...withdrawConfirmationEvent(1, 'specific_focus'), field: null }]],
    ['a withdraw(confirmation) with a suggestion', [{ ...withdrawConfirmationEvent(1, 'specific_focus'), suggestion_fingerprint: focusSuggestionFingerprint(SUGGESTION_FOCUS) }]],
    ['a withdraw(dismissal) with a field', [{ ...withdrawDismissalEvent(1, SUGGESTION_COOKING), field: 'specific_focus' }]],
    ['a duplicate id', [valid(), { ...confirmEvent(2, 'main_category', { revision: '7' }), id: 'ev-1' }]],
    ['a duplicate seq', [valid(), { ...confirmEvent(2, 'main_category', { revision: '7' }), seq: 1 }]],
    ['a duplicate request_id', [valid(), { ...confirmEvent(2, 'main_category', { revision: '7' }), request_id: valid().request_id }]],
  ]

  it.each(badEvents)('%s -> layer disabled, nothing applied, every status unverifiable', (_name, events) => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, events)
    expect(result.read_model.layer).toBe('disabled')
    expect(result.profile).toEqual(profile)
    expect(result.read_model.issues[0]).toEqual({ path: 'events', code: 'decision_events_invalid' })
    expect(statusOf(result, 'specific_focus')).toBe('unverifiable')
    expect(statusOf(result, 'main_category')).toBe('unverifiable')
  })

  it('a bad `withdraw` next to a good `confirm` cannot revive anything: the good confirm is not applied either', () => {
    const { profile, snapshot } = world()
    const result = applyDecisions(profile, snapshot, [valid(), { ...withdrawConfirmationEvent(2, 'specific_focus'), field: null }])
    expect(result.read_model.layer).toBe('disabled')
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown')
  })

  it.each([
    ['null', null],
    ['no fields', { user_id: USER }],
    ['an empty user', { user_id: '', fields: { specific_focus: { value: null, revision: '0' }, main_category: { value: null, revision: '0' } } }],
    ['a numeric revision', { user_id: USER, fields: { specific_focus: { value: FOCUS, revision: 5 }, main_category: { value: null, revision: '0' } } }],
    ['a non-canonical revision', { user_id: USER, fields: { specific_focus: { value: FOCUS, revision: '05' }, main_category: { value: null, revision: '0' } } }],
    ['a missing field', { user_id: USER, fields: { specific_focus: { value: FOCUS, revision: '5' } } }],
    ['a value of 5001 characters', { user_id: USER, fields: { specific_focus: { value: 'x'.repeat(5001), revision: '5' }, main_category: { value: null, revision: '0' } } }],
    ['a numeric value', { user_id: USER, fields: { specific_focus: { value: 42, revision: '5' }, main_category: { value: null, revision: '0' } } }],
    ['an extra field', { user_id: USER, fields: { specific_focus: { value: FOCUS, revision: '5' }, main_category: { value: null, revision: '0' }, audience: { value: 'x', revision: '0' } } }],
  ])('an invalid snapshot (%s) disables the layer', (_name, snapshot) => {
    const { profile } = world()
    const result = applyDecisions(profile, snapshot, [valid()])
    expect(result.read_model.layer).toBe('disabled')
    expect(result.profile).toEqual(profile)
    expect(result.read_model.issues[0]).toEqual({ path: 'snapshot', code: 'invalid_snapshot' })
  })

  it('an invalid profile (an inconsistent fact flag) disables the layer and is returned as it came', () => {
    const { profile, snapshot } = world()
    const forged = structuredClone(profile)
    forged.claims.specific_focus!.fact_eligible = true // an unknown-origin claim cannot be a fact
    const result = applyDecisions(forged, snapshot, [valid()])
    expect(result.read_model.layer).toBe('disabled')
    expect(result.read_model.issues[0]).toEqual({ path: 'profile', code: 'invalid_profile' })
    expect(result.profile).toBe(forged)
  })

  it('a snapshot that does not describe the profile row: nothing is honoured for that field, and it is reported', () => {
    const { profile, snapshot } = world()
    const other = { ...snapshot, fields: { ...snapshot.fields, specific_focus: { value: 'egészen más téma itt', revision: '5' } } }
    const result = applyDecisions(profile, other, [confirmEvent(1, 'specific_focus', { revision: '5' }), confirmEvent(2, 'main_category', { revision: '7' })])
    expect(statusOf(result, 'specific_focus')).toBe('unverifiable')
    expect(result.read_model.issues).toContainEqual({ path: 'snapshot.fields.specific_focus', code: 'snapshot_profile_mismatch' })
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown')
    // a category confirmation covers the WHOLE suggestion: while the focus cannot be verified it is not honoured either
    expect(statusOf(result, 'main_category')).toBe('invalidated_by_value_change')
    expect(result.profile.claims.main_category?.origin).toBe('unknown')
  })

  it('a snapshot whose CATEGORY does not describe the row does not stop the (consistent) focus from being honoured', () => {
    const { profile, snapshot } = world()
    const other = { ...snapshot, fields: { ...snapshot.fields, main_category: { value: 'tech_ai', revision: '7' } } }
    const result = applyDecisions(profile, other, [confirmEvent(1, 'specific_focus', { revision: '5' }), confirmEvent(2, 'main_category', { revision: '7' })])
    expect(statusOf(result, 'main_category')).toBe('unverifiable')
    expect(statusOf(result, 'specific_focus')).toBe('valid')
  })

  it('a forged confirm for a value the creator does not hold changes nothing', () => {
    const { profile, snapshot } = world()
    const forged = confirmEvent(1, 'specific_focus', { revision: '5', value: COOKING })
    const result = applyDecisions(profile, snapshot, [forged])
    expect(statusOf(result, 'specific_focus')).toBe('integrity_mismatch')
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown')
  })

  it('a field with no value (nothing to confirm) reports no_current_value when a confirmation exists', () => {
    const w = world({ focus: null })
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(statusOf(result, 'specific_focus')).toBe('no_current_value')
    expect(result.profile.claims.specific_focus).toBeUndefined()
  })

  it('a category of `other` cannot be confirmed', () => {
    const w = world({ category: 'other' })
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'main_category', { revision: '7', value: 'health' })])
    expect(statusOf(result, 'main_category')).toBe('no_current_value')
    expect(result.profile.claims.main_category?.origin).toBe('unknown')
  })
})

describe('the read model says what it is, and the module stays pure at runtime', () => {
  it('lists its limitations, including that it is not a durable or user-usable feature and that a request is not proof of a human', () => {
    const { profile, snapshot } = world()
    const { read_model } = applyDecisions(profile, snapshot, [])
    expect(read_model.contract_version).toBe('creator-focus-decision.v1')
    expect(read_model.limitations).toEqual(expect.arrayContaining([
      'confirmation_is_a_recorded_request_not_proof_that_a_human_saw_or_accepted_it',
      'decision_events_are_supplied_by_the_caller_and_nothing_is_stored_by_this_module',
      'not_a_durable_or_user_usable_creator_intelligence_feature_yet',
    ]))
  })

  it('a full scenario reads no clock, no randomness, no network and logs nothing', () => {
    const fetchSpy = vi.fn(() => { throw new Error('network used') })
    vi.stubGlobal('fetch', fetchSpy)
    const now = vi.spyOn(Date, 'now')
    const random = vi.spyOn(Math, 'random')
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const { profile, snapshot } = world()
    applyDecisions(profile, snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' }), dismissEvent(2, SUGGESTION_COOKING)])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(now).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
})
