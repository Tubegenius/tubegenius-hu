// Creator Intelligence 2B: the guards added after the second independent review. DB-free.
//   * the event CAP is a capacity refusal in the command evaluator (not compaction, not revocability)
//   * repeated dismiss / confirm / withdraw record NOTHING
//   * a category confirmation is bound to the focus REVISION the creator saw (focus A -> B -> A does not revive it)
//   * an unknown fingerprint version: inert for value identities, a withdrawal of confirmations still applies
//   * a projected profile is refused as the input of a second projection / command
//   * limits, status precedence and the other details the review found untested
import { describe, expect, it } from 'vitest'
import {
  DECISION_LIMITATIONS,
  DECISION_LIMITS,
  applyDecisions,
  assessFocusFit,
  evaluateDecisionCommand,
  validateDecisionEvents,
  validateFocusProfile,
  type DecisionEventDraft,
  type FocusDecisionEvent,
} from '@/lib/creator-focus'
import { candidate } from './support/creator-focus-fixtures'
import {
  AT,
  CHANNEL_A,
  CHANNEL_B,
  COOKING,
  FOCUS,
  SUGGESTION_COOKING,
  SUGGESTION_FOCUS,
  USER,
  confirmEvent,
  dismissEvent,
  uuid,
  withdrawConfirmationEvent,
  withdrawDismissalEvent,
  world,
} from './support/creator-focus-decision-fixtures'

const V = 'creator-focus-decision.v1'
const confirmCmd = (n: number, over: Record<string, unknown> = {}) => ({
  contract_version: V, request_id: uuid(n), action: 'confirm', field: 'specific_focus', suggestion: SUGGESTION_FOCUS, expected_profile_revision: '5', ...over,
})
const categoryCmd = (n: number, over: Record<string, unknown> = {}) => confirmCmd(n, {
  field: 'main_category', expected_profile_revision: '7', expected_focus_revision: '5', ...over,
})
const dismissCmd = (n: number, over: Record<string, unknown> = {}) => ({ contract_version: V, request_id: uuid(n), action: 'dismiss', suggestion: SUGGESTION_COOKING, ...over })
const withdrawConfirmationCmd = (n: number, over: Record<string, unknown> = {}) =>
  ({ contract_version: V, request_id: uuid(n), action: 'withdraw', withdraws: 'confirmation', field: 'specific_focus', ...over })
const withdrawDismissalCmd = (n: number, over: Record<string, unknown> = {}) =>
  ({ contract_version: V, request_id: uuid(n), action: 'withdraw', withdraws: 'dismissal', suggestion: SUGGESTION_COOKING, ...over })

const run = (command: unknown, w = world(), events: unknown = []) => evaluateDecisionCommand(command, w.profile, w.snapshot, events)
const code = (r: ReturnType<typeof run>) => (r.ok ? 'ok' : r.code)
const outcome = (r: ReturnType<typeof run>) => (r.ok ? r.outcome : null)
const statusOf = (r: ReturnType<typeof applyDecisions>, field: 'specific_focus' | 'main_category') => r.read_model.claims[field].confirmation.status

/** the "store": assigns id, seq and time to a draft */
const append = (events: FocusDecisionEvent[], draft: DecisionEventDraft): FocusDecisionEvent[] => {
  const seq = events.length + 1
  return [...events, { ...draft, id: `ev-${seq}`, seq, created_at: AT }]
}
const accept = (events: FocusDecisionEvent[], result: ReturnType<typeof run>): FocusDecisionEvent[] => {
  expect(result.ok && result.outcome === 'new').toBe(true)
  return append(events, (result as { draft: DecisionEventDraft }).draft)
}

describe('the event CAP: a capacity refusal in the command evaluator (NOT compaction, NOT revocability)', () => {
  const ev = (seq: number) => confirmEvent(seq, 'specific_focus', { revision: '5' })

  it('with 4999 events one more is proposed; with 5000 a new event is refused, and appending the 5000th still reads fine', () => {
    const w = world()
    const events4999 = Array.from({ length: DECISION_LIMITS.max_events - 1 }, (_, i) => ev(i + 1))
    const last = run(dismissCmd(7000), w, events4999)
    expect(outcome(last)).toBe('new')
    const events5000 = append(events4999, (last as { draft: DecisionEventDraft }).draft)
    expect(events5000).toHaveLength(DECISION_LIMITS.max_events)
    expect(applyDecisions(w.profile, w.snapshot, events5000).read_model.layer).toBe('applied')
    const refused = run(dismissCmd(7001, { suggestion: SUGGESTION_FOCUS }), w, events5000)
    expect(code(refused)).toBe('event_capacity_reached')
    expect(!refused.ok && refused.issues).toEqual([{ path: 'events', code: 'at_the_event_cap_a_capacity_refusal_not_compaction' }])
  })

  it('at the cap EVERY new decision is refused, including a withdrawal: the guard frees nothing', () => {
    const w = world()
    const events = Array.from({ length: DECISION_LIMITS.max_events }, (_, i) => ev(i + 1))
    expect(code(run(withdrawConfirmationCmd(7001), w, events))).toBe('event_capacity_reached')
    expect(code(run(dismissCmd(7002), w, events))).toBe('event_capacity_reached')
    expect(code(run(categoryCmd(7003), w, events))).toBe('event_capacity_reached')
  })

  it('at the cap a REPLAY of a recorded request is still answered, and a conflict is still a conflict', () => {
    const w = world()
    const events = Array.from({ length: DECISION_LIMITS.max_events }, (_, i) => ev(i + 1))
    expect(outcome(run(confirmCmd(1), w, events))).toBe('replay')
    expect(code(run(confirmCmd(1, { expected_profile_revision: '6' }), w, events))).toBe('request_id_conflict')
  })

  it('the state still comes first: a no-op at the cap is reported as the no-op, not as capacity', () => {
    const w = world()
    const events = Array.from({ length: DECISION_LIMITS.max_events }, (_, i) => ev(i + 1))
    expect(code(run(confirmCmd(7001), w, events))).toBe('already_confirmed')
  })

  it('the cap is exactly the applyDecisions cap: one more than a refused command would have produced is invalid input', () => {
    const w = world()
    const events = Array.from({ length: DECISION_LIMITS.max_events + 1 }, (_, i) => ev(i + 1))
    expect(applyDecisions(w.profile, w.snapshot, events).read_model.layer).toBe('disabled')
    expect(code(run(dismissCmd(7001), w, events))).toBe('decision_events_invalid')
  })
})

describe('repeats record NOTHING (no-ops cannot fill the event list)', () => {
  it('a repeated dismissal is `already_dismissed`; after a withdrawal it is a new dismissal; another channel is independent', () => {
    const w = world()
    const first = accept([], run(dismissCmd(1), w))
    expect(code(run(dismissCmd(2), w, first))).toBe('already_dismissed')
    const withdrawn = accept(first, run(withdrawDismissalCmd(3), w, first))
    expect(outcome(run(dismissCmd(4), w, withdrawn))).toBe('new')
    // a dismissal made on channel A does not make the same suggestion "already dismissed" on channel B
    const onA = accept([], run(dismissCmd(5, { suggestion: SUGGESTION_FOCUS }), w))
    expect(outcome(run(dismissCmd(6, { suggestion: SUGGESTION_FOCUS }), world({ channel: CHANNEL_B }), onA))).toBe('new')
  })

  it('a retry storm with fresh request ids records exactly one dismissal and one confirmation', () => {
    const w = world()
    let events: FocusDecisionEvent[] = []
    for (let n = 1; n <= 12; n++) {
      const result = run(n % 2 === 0 ? dismissCmd(n) : confirmCmd(n), w, events)
      if (result.ok && result.outcome === 'new') events = append(events, result.draft)
    }
    expect(events.map(e => e.action)).toEqual(['confirm', 'dismiss'])
  })

  it('a repeated confirmation is `already_confirmed`; after a withdrawal it is new; after a value change (new revision) it is new', () => {
    const w = world()
    const first = accept([], run(confirmCmd(1), w))
    expect(code(run(confirmCmd(2), w, first))).toBe('already_confirmed')
    const withdrawn = accept(first, run(withdrawConfirmationCmd(3), w, first))
    expect(outcome(run(confirmCmd(4), w, withdrawn))).toBe('new')
    // the focus was saved again (same text, new revision): a confirmation of the new revision is a new decision
    const saved = world({ fRev: '6' })
    expect(outcome(run(confirmCmd(5, { expected_profile_revision: '6' }), saved, first))).toBe('new')
    // another channel is another decision
    expect(outcome(run(confirmCmd(6), world({ channel: CHANNEL_B }), first))).toBe('new')
  })

  it('a repeated category confirmation is `already_confirmed`; a new FOCUS revision makes it a new decision', () => {
    const w = world()
    const first = accept([], run(categoryCmd(1), w))
    expect(code(run(categoryCmd(2), w, first))).toBe('already_confirmed')
    const focusSaved = world({ fRev: '6' })
    expect(outcome(run(categoryCmd(3, { expected_focus_revision: '6' }), focusSaved, first))).toBe('new')
  })

  it('a confirmation that was taken back or never made cannot be withdrawn again', () => {
    const w = world()
    expect(code(run(withdrawConfirmationCmd(1), w))).toBe('nothing_to_withdraw')
    const confirmed = accept([], run(confirmCmd(2), w))
    const withdrawn = accept(confirmed, run(withdrawConfirmationCmd(3), w, confirmed))
    expect(code(run(withdrawConfirmationCmd(4), w, withdrawn))).toBe('nothing_to_withdraw')
    // a later confirmation is a new decision and can be withdrawn again
    const again = accept(withdrawn, run(confirmCmd(5), w, withdrawn))
    expect(outcome(run(withdrawConfirmationCmd(6), w, again))).toBe('new')
  })

  it('a stale confirmation that is still standing can be withdrawn (it is the creator\'s own record)', () => {
    const stale = world({ fRev: '9' })
    expect(outcome(run(withdrawConfirmationCmd(9), stale, [confirmEvent(1, 'specific_focus', { revision: '5' })]))).toBe('new')
  })

  it('a withdrawal of one field does not stand in for the other field', () => {
    const events = [confirmEvent(1, 'specific_focus', { revision: '5' }), confirmEvent(2, 'main_category', { revision: '7' }), withdrawConfirmationEvent(3, 'specific_focus')]
    expect(code(run(withdrawConfirmationCmd(4), world(), events))).toBe('nothing_to_withdraw')
    expect(outcome(run(withdrawConfirmationCmd(5, { field: 'main_category' }), world(), events))).toBe('new')
  })
})

describe('a category confirmation is bound to the FOCUS REVISION the creator saw', () => {
  const fix = (focusRevision: string, focus: string = FOCUS) =>
    world({ focus, category: 'health', fRev: focusRevision, candidates: [candidate(FOCUS, 'health', CHANNEL_A), candidate(COOKING, 'health', CHANNEL_A)] })

  it('REGRESSION: focus A -> B -> A gives the focus a new revision, so the category confirmation does not come back', () => {
    const event = confirmEvent(1, 'main_category', { revision: '7', focusRevision: '5' })
    const a = fix('5')
    expect(statusOf(applyDecisions(a.profile, a.snapshot, [event]), 'main_category')).toBe('valid')
    const b = fix('6', COOKING)
    const atB = applyDecisions(b.profile, b.snapshot, [event])
    expect(statusOf(atB, 'main_category')).toBe('invalidated_by_value_change')
    // back to A: same text, the SAME category revision (7), but the focus revision is a new one (8)
    const aAgain = fix('8')
    expect(aAgain.snapshot.fields.main_category.revision).toBe('7')
    const back = applyDecisions(aAgain.profile, aAgain.snapshot, [event])
    expect(statusOf(back, 'main_category')).toBe('invalidated_by_value_change')
    expect(back.profile.claims.main_category?.origin).toBe('unknown')
    expect(back.read_model.claims.main_category.confirmation.decision_id).toBeNull()
  })

  it('the focus revision the event recorded must equal the current one (a stale focus revision alone invalidates)', () => {
    const w = fix('5')
    expect(statusOf(applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'main_category', { revision: '7', focusRevision: '4' })]), 'main_category')).toBe('invalidated_by_value_change')
    expect(statusOf(applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'main_category', { revision: '7', focusRevision: '5' })]), 'main_category')).toBe('valid')
  })

  it('a focus confirmation is NOT bound to the category (an explicit asymmetry): it ignores the category and its revision', () => {
    const w = world({ category: 'tech_ai' }) // the creator's category is not the suggestion's category
    expect(w.profile.claims.main_category?.origin).toBe('user_declared')
    const result = run(confirmCmd(1), w) // (FOCUS, health) is a stored suggestion; the focus equals it
    expect(outcome(result)).toBe('new')
    const events = accept([], result)
    const read = applyDecisions(w.profile, w.snapshot, events)
    expect(statusOf(read, 'specific_focus')).toBe('valid')
    expect(read.profile.claims.specific_focus?.origin).toBe('user_confirmed')
    expect(read.profile.claims.main_category?.origin).toBe('user_declared') // untouched
    // and a later save of the category does not end the focus confirmation
    const categorySaved = world({ category: 'finance', cRev: '9' })
    expect(statusOf(applyDecisions(categorySaved.profile, categorySaved.snapshot, events), 'specific_focus')).toBe('valid')
  })

  it('the command carries the focus revision only for a category confirmation', () => {
    expect(code(run(categoryCmd(1, { expected_focus_revision: undefined })))).toBe('invalid_request')
    expect(code(run(categoryCmd(1, { expected_focus_revision: null })))).toBe('invalid_request')
    expect(code(run(confirmCmd(1, { expected_focus_revision: '5' })))).toBe('invalid_request')
    expect(code(run(dismissCmd(1, { expected_focus_revision: '5' })))).toBe('invalid_request')
    expect(code(run(withdrawConfirmationCmd(1, { expected_focus_revision: '5' }), world(), [confirmEvent(10, 'specific_focus', { revision: '5' })]))).toBe('invalid_request')
    expect(code(run(categoryCmd(1, { expected_focus_revision: '05' })))).toBe('invalid_request')
  })

  it('a category confirmation whose focus revision is not the current one is refused; the draft records the focus revision', () => {
    const w = world()
    const stale = run(categoryCmd(1, { expected_focus_revision: '4' }), w)
    expect(code(stale)).toBe('profile_revision_changed')
    expect(!stale.ok && stale.issues).toEqual([{ path: 'snapshot.fields.specific_focus.revision', code: 'focus_revision_changed' }])
    const ok = run(categoryCmd(2), w)
    expect(ok.ok && ok.outcome === 'new' && ok.draft.focus_revision).toBe('5')
    expect(run(confirmCmd(3), w).ok && (run(confirmCmd(3), w) as { draft: DecisionEventDraft }).draft.focus_revision).toBeNull()
  })

  it('the same request id with another expected focus revision is a conflict', () => {
    const recorded = accept([], run(categoryCmd(1), world()))
    expect(code(run(categoryCmd(1, { expected_focus_revision: '6' }), world({ fRev: '6' }), recorded))).toBe('request_id_conflict')
    expect(outcome(run(categoryCmd(1), world({ fRev: '6' }), recorded))).toBe('replay')
  })

  it('the same request id withdrawing another FIELD is a conflict (the field is part of the meaning)', () => {
    const w = world()
    const events = [confirmEvent(1, 'specific_focus', { revision: '5' }), confirmEvent(2, 'main_category', { revision: '7' })]
    const withdrawn = accept(events, run(withdrawConfirmationCmd(3), w, events))
    expect(outcome(run(withdrawConfirmationCmd(3), w, withdrawn))).toBe('replay')
    expect(code(run(withdrawConfirmationCmd(3, { field: 'main_category' }), w, withdrawn))).toBe('request_id_conflict')
  })

  it('a draft round-trips through the event validator and produces a valid confirmation', () => {
    const w = world()
    const events = accept([], run(categoryCmd(1), w))
    expect(validateDecisionEvents(events, USER).issues).toEqual([])
    expect(statusOf(applyDecisions(w.profile, w.snapshot, events), 'main_category')).toBe('valid')
  })

  it.each([
    ['a category confirm without a focus revision', () => ({ ...confirmEvent(1, 'main_category', { revision: '7' }), focus_revision: null })],
    ['a focus confirm WITH a focus revision', () => ({ ...confirmEvent(1, 'specific_focus', { revision: '5' }), focus_revision: '5' })],
    ['a dismiss with a focus revision', () => ({ ...dismissEvent(1, SUGGESTION_COOKING), focus_revision: '5' })],
    ['a withdraw with a focus revision', () => ({ ...withdrawConfirmationEvent(1, 'specific_focus'), focus_revision: '5' })],
    ['a malformed focus revision', () => ({ ...confirmEvent(1, 'main_category', { revision: '7' }), focus_revision: '05' })],
    ['an event without the focus_revision key', () => { const e: Record<string, unknown> = { ...confirmEvent(1, 'main_category', { revision: '7' }) }; delete e.focus_revision; return e }],
  ])('the event schema refuses %s (and the whole layer is disabled)', (_name, make) => {
    const w = world()
    const result = applyDecisions(w.profile, w.snapshot, [make()])
    expect(result.read_model.layer).toBe('disabled')
    expect(result.profile).toEqual(w.profile)
  })
})

describe('an unknown fingerprint version', () => {
  it('a value identity (confirm, dismiss, withdraw(dismissal)) of an unknown version is inert and does not disable the layer', () => {
    const w = world()
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5', version: 2 }), { ...dismissEvent(2, SUGGESTION_COOKING), fingerprint_version: 2 }])
    expect(result.read_model.layer).toBe('applied')
    expect(statusOf(result, 'specific_focus')).toBe('unsupported_fingerprint_version')
    expect(result.profile.suggestions).toHaveLength(w.profile.suggestions.length) // the v2 dismissal hides nothing
    // a v2 withdrawal of a dismissal restores nothing
    const dismissed = [dismissEvent(1, SUGGESTION_COOKING), { ...withdrawDismissalEvent(2, SUGGESTION_COOKING), fingerprint_version: 2 }]
    expect(applyDecisions(w.profile, w.snapshot, dismissed).profile.suggestions.map(s => s.specific_focus)).toEqual([FOCUS])
  })

  it('PINNED: a withdraw(confirmation) of an unknown version STILL takes back earlier confirmations (it has no value identity)', () => {
    const w = world()
    const withdrawV2 = { ...withdrawConfirmationEvent(2, 'specific_focus'), fingerprint_version: 2 }
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' }), withdrawV2])
    expect(result.read_model.layer).toBe('applied')
    expect(statusOf(result, 'specific_focus')).toBe('withdrawn')
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown')
    // and it does not take back a LATER confirmation
    const later = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' }), withdrawV2, confirmEvent(3, 'specific_focus', { revision: '5' })])
    expect(statusOf(later, 'specific_focus')).toBe('valid')
  })

  it('structural bounds of fingerprint_version: 1000 is accepted (and inert), 1001 and 0 disable the layer', () => {
    const w = world()
    const v1000 = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5', version: 1000 })])
    expect(v1000.read_model.layer).toBe('applied')
    expect(statusOf(v1000, 'specific_focus')).toBe('unsupported_fingerprint_version')
    expect(applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5', version: 1001 })]).read_model.layer).toBe('disabled')
    expect(applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5', version: 0 })]).read_model.layer).toBe('disabled')
  })
})

describe('a projected profile is not an input (applyDecisions is not applied to its own output)', () => {
  const events = () => [confirmEvent(1, 'specific_focus', { revision: '5' }), dismissEvent(2, SUGGESTION_COOKING)]

  it('the output of a non-empty list is marked, still a valid profile, and still usable by the 2A fit assessment', () => {
    const w = world()
    const first = applyDecisions(w.profile, w.snapshot, events())
    expect(first.profile.decision_projection).toEqual({ contract_version: V })
    expect(validateFocusProfile(first.profile)).toEqual([])
    const fit = assessFocusFit({ contract_version: 'creator-focus.v1', profile: first.profile, topic: { text: 'otthoni edzés kezdőknek program' } } as never)
    expect(fit.issues).toEqual([])
  })

  it('an empty list returns an unmarked copy (2A behaviour unchanged)', () => {
    const w = world()
    const result = applyDecisions(w.profile, w.snapshot, [])
    expect('decision_projection' in result.profile).toBe(false)
    expect(result.profile).toEqual(w.profile)
  })

  it('a second projection of the output is REFUSED, not silently weaker: nothing is applied, the object comes back as it came', () => {
    const w = world()
    const first = applyDecisions(w.profile, w.snapshot, events())
    expect(first.profile.suggestions.map(s => s.specific_focus)).toEqual([FOCUS]) // the dismissed one is gone from the projection
    const second = applyDecisions(first.profile, w.snapshot, events())
    expect(second.read_model.layer).toBe('disabled')
    expect(second.read_model.issues).toEqual([{ path: 'profile', code: 'profile_already_projected' }])
    expect(second.profile).toEqual(first.profile)
    expect(statusOf(second, 'specific_focus')).toBe('unverifiable')
    // an empty list is refused too: a projection is not an input at all
    expect(applyDecisions(first.profile, w.snapshot, []).read_model.layer).toBe('disabled')
  })

  it('the same events applied to the same unprojected profile give the same result every time', () => {
    const w = world()
    const a = applyDecisions(w.profile, w.snapshot, events())
    const b = applyDecisions(w.profile, w.snapshot, events())
    expect(b).toEqual(a)
    expect(w.profile.decision_projection).toBeUndefined()
  })

  it('the command evaluator refuses a projected profile too', () => {
    const w = world()
    const projected = applyDecisions(w.profile, w.snapshot, events()).profile
    const result = evaluateDecisionCommand(confirmCmd(9), projected, w.snapshot, [])
    expect(code(result)).toBe('profile_already_projected')
  })

  it('a malformed marker is an invalid profile', () => {
    const w = world()
    const broken = structuredClone(w.profile) as unknown as Record<string, unknown>
    broken.decision_projection = { contract_version: 'other' }
    expect(validateFocusProfile(broken).map(i => i.path)).toContain('profile.decision_projection')
    expect(applyDecisions(broken as never, w.snapshot, []).read_model.issues[0]).toEqual({ path: 'profile', code: 'invalid_profile' })
  })
})

describe('details the review found untested', () => {
  it('an event id of exactly 128 characters is accepted, 129 is refused', () => {
    const w = world()
    expect(applyDecisions(w.profile, w.snapshot, [{ ...confirmEvent(1, 'specific_focus', { revision: '5' }), id: 'x'.repeat(128) }]).read_model.layer).toBe('applied')
    expect(applyDecisions(w.profile, w.snapshot, [{ ...confirmEvent(1, 'specific_focus', { revision: '5' }), id: 'x'.repeat(129) }]).read_model.layer).toBe('disabled')
  })

  it('the limitations are listed in full', () => {
    expect([...DECISION_LIMITATIONS]).toEqual([
      'confirmation_is_a_recorded_request_not_proof_that_a_human_saw_or_accepted_it',
      'decision_events_are_supplied_by_the_caller_and_nothing_is_stored_by_this_module',
      'confirmation_is_bound_to_value_revision_and_channel_not_to_the_words_alone',
      'dismissal_suppression_applies_to_this_read_model_only_not_to_any_suggestion_generator',
      'fingerprints_are_pseudonymous_unsalted_data_about_the_creator_not_anonymous_data',
      'at_most_5000_events_are_read_and_there_is_no_compaction_or_revocation_yet_a_blocker_before_a_durable_store',
      'at_the_event_cap_new_decisions_including_withdrawals_are_refused_that_is_a_capacity_guard_not_compaction',
      'a_projected_profile_is_refused_as_the_input_of_a_second_projection',
      'an_event_that_needs_a_value_identity_of_an_unknown_fingerprint_version_is_inert_a_withdrawal_of_confirmations_still_applies',
      'a_confirmation_may_become_valid_again_on_a_channel_round_trip_if_value_and_field_revision_are_unchanged',
      'not_a_durable_or_user_usable_creator_intelligence_feature_yet',
    ])
  })

  it('an invalid profile disables the layer WITHOUT exposing its claim values or origins', () => {
    const w = world()
    const forged = structuredClone(w.profile)
    forged.claims.specific_focus!.fact_eligible = true // inconsistent with an unknown origin
    const result = applyDecisions(forged, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(result.read_model.layer).toBe('disabled')
    for (const field of ['specific_focus', 'main_category'] as const) {
      expect(result.read_model.claims[field]).toEqual({ field, value: null, origin: null, confirmation: { status: 'unverifiable', decision_id: null } })
    }
    expect(result.read_model.suggestions).toEqual([])
  })

  it('status precedence: withdrawn > unsupported version > no current value > channel change > value change', () => {
    const w = world()
    const noFocus = world({ focus: null })
    // withdrawn beats an unsupported version
    expect(statusOf(applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5', version: 2 }), withdrawConfirmationEvent(2, 'specific_focus')]), 'specific_focus')).toBe('withdrawn')
    // an unsupported version beats "no current value"
    expect(statusOf(applyDecisions(noFocus.profile, noFocus.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5', version: 2 })]), 'specific_focus')).toBe('unsupported_fingerprint_version')
    // "no current value" beats a channel change
    expect(statusOf(applyDecisions(noFocus.profile, noFocus.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5', channel: CHANNEL_B })]), 'specific_focus')).toBe('no_current_value')
    // a channel change beats a stale revision
    expect(statusOf(applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '4', channel: CHANNEL_B })]), 'specific_focus')).toBe('invalidated_by_channel_change')
    // a stale revision is a value change
    expect(statusOf(applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '4' })]), 'specific_focus')).toBe('invalidated_by_value_change')
  })

  it('R1: the focus claim of the PROFILE must be the focus of the snapshot for a category confirmation to count', () => {
    // the profile holds the cooking focus, the snapshot (wrongly) says the home-workout focus = the suggestion's focus
    const w = world({ focus: COOKING, category: 'health', candidates: [candidate(FOCUS, 'health', CHANNEL_A), candidate(COOKING, 'health', CHANNEL_A)] })
    const snapshot = { ...w.snapshot, fields: { ...w.snapshot.fields, specific_focus: { value: FOCUS, revision: '5' } } }
    const result = applyDecisions(w.profile, snapshot, [confirmEvent(1, 'main_category', { revision: '7' })])
    expect(statusOf(result, 'specific_focus')).toBe('unverifiable') // the focus field itself is not honoured either
    expect(result.read_model.issues).toContainEqual({ path: 'snapshot.fields.specific_focus', code: 'snapshot_profile_mismatch' })
    expect(statusOf(result, 'main_category')).toBe('invalidated_by_value_change')
    expect(result.profile.claims.main_category?.origin).toBe('unknown')
  })

  it('C4: the same inconsistency stops a category confirmation COMMAND', () => {
    const w = world({ focus: COOKING, category: 'health', candidates: [candidate(FOCUS, 'health', CHANNEL_A), candidate(COOKING, 'health', CHANNEL_A)] })
    const snapshot = { ...w.snapshot, fields: { ...w.snapshot.fields, specific_focus: { value: FOCUS, revision: '5' } } }
    const result = evaluateDecisionCommand(categoryCmd(1), w.profile, snapshot, [])
    expect(code(result)).toBe('snapshot_profile_mismatch')
    expect(!result.ok && result.issues).toEqual([{ path: 'snapshot.fields.specific_focus', code: 'snapshot_profile_mismatch' }])
  })

  it('R2: a category other than `health` is confirmed against its own suggestion (command and read model)', () => {
    const w = world({ focus: COOKING, category: 'lifestyle' }) // the default candidates hold (COOKING, lifestyle) on channel A
    expect(w.profile.claims.main_category).toMatchObject({ origin: 'unknown', channel_derived: true })
    const result = run({ ...categoryCmd(1, { suggestion: SUGGESTION_COOKING }) }, w)
    expect(outcome(result)).toBe('new')
    const events = accept([], result)
    expect(events[0].value_fingerprint).not.toBeNull()
    const read = applyDecisions(w.profile, w.snapshot, events)
    expect(statusOf(read, 'main_category')).toBe('valid')
    expect(read.profile.claims.main_category).toMatchObject({ origin: 'user_confirmed', value: 'lifestyle' })
  })
})
