// Creator Intelligence 2B: the PURE evaluation of a decision COMMAND (new / replay / conflict, and the draft event).
// DB-free; no route, no store: a "store" below is only an array the test appends to.
import { describe, expect, it } from 'vitest'
import {
  applyDecisions,
  confirmSuggestion,
  declareOrCorrectClaim,
  evaluateDecisionCommand,
  focusSuggestionFingerprint,
  focusValueFingerprint,
  type DecisionEventDraft,
  type FocusDecisionEvent,
} from '@/lib/creator-focus'
import { allKeys } from './support/creator-focus-fixtures'
import {
  AT,
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
  uuid,
  withdrawConfirmationEvent,
  world,
} from './support/creator-focus-decision-fixtures'

const V = 'creator-focus-decision.v1'
const confirmCmd = (n: number, over: Record<string, unknown> = {}) =>
  ({
    contract_version: V, request_id: uuid(n), action: 'confirm', field: 'specific_focus', suggestion: SUGGESTION_FOCUS, expected_profile_revision: '5',
    // a category confirmation also carries the revision of the focus the creator saw (the default world's: 5)
    ...(over.field === 'main_category' && !('expected_focus_revision' in over) ? { expected_focus_revision: '5' } : {}),
    ...over,
  })
const dismissCmd = (n: number, over: Record<string, unknown> = {}) =>
  ({ contract_version: V, request_id: uuid(n), action: 'dismiss', suggestion: SUGGESTION_COOKING, ...over })
const withdrawConfirmationCmd = (n: number, over: Record<string, unknown> = {}) =>
  ({ contract_version: V, request_id: uuid(n), action: 'withdraw', withdraws: 'confirmation', field: 'specific_focus', ...over })
const withdrawDismissalCmd = (n: number, over: Record<string, unknown> = {}) =>
  ({ contract_version: V, request_id: uuid(n), action: 'withdraw', withdraws: 'dismissal', suggestion: SUGGESTION_COOKING, ...over })

/** the "store": assigns id, seq and time to a draft, exactly what the future store would do */
const append = (events: FocusDecisionEvent[], draft: DecisionEventDraft): FocusDecisionEvent[] => {
  const seq = events.length + 1
  return [...events, { ...draft, id: `ev-${seq}`, seq, created_at: AT }]
}

const run = (command: unknown, w = world(), events: unknown = []) => evaluateDecisionCommand(command, w.profile, w.snapshot, events)
const code = (r: ReturnType<typeof run>) => (r.ok ? 'ok' : r.code)

describe('the shape of a command', () => {
  it('a valid command of every kind is accepted as new', () => {
    const commands: Array<Record<string, unknown>> = [confirmCmd(1), dismissCmd(2), withdrawConfirmationCmd(3), withdrawDismissalCmd(4)]
    for (const command of commands) {
      const events = command.action === 'withdraw'
        ? (command.withdraws === 'confirmation' ? [confirmEvent(10, 'specific_focus', { revision: '5' })] : [dismissEvent(10, SUGGESTION_COOKING)])
        : []
      const cleaned = JSON.parse(JSON.stringify(command))
      expect(code(run(cleaned, world(), events)), JSON.stringify(cleaned)).toBe('ok')
    }
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'confirm'],
    ['an unknown key (a user id from the client)', confirmCmd(1, { user_id: USER })],
    ['an unknown key (a channel from the client)', confirmCmd(1, { channel_id: CHANNEL_A })],
    ['an unknown key (a value text)', confirmCmd(1, { value: FOCUS })],
    ['a bad request_id', confirmCmd(1, { request_id: 'nope' })],
    ['a missing request_id', (() => { const c: Record<string, unknown> = confirmCmd(1); delete c.request_id; return c })()],
    ['an unknown action', confirmCmd(1, { action: 'approve' })],
    ['an unknown field', confirmCmd(1, { field: 'audience' })],
    ['a confirm without a field', confirmCmd(1, { field: undefined })],
    ['a confirm without a suggestion', confirmCmd(1, { suggestion: undefined })],
    ['a confirm without an expected revision', confirmCmd(1, { expected_profile_revision: undefined })],
    ['a confirm with a non-canonical revision', confirmCmd(1, { expected_profile_revision: '05' })],
    ['a confirm with a numeric revision', confirmCmd(1, { expected_profile_revision: 5 })],
    ['a confirm with a withdraws target', confirmCmd(1, { withdraws: 'confirmation' })],
    ['a suggestion with an extra key', confirmCmd(1, { suggestion: { ...SUGGESTION_FOCUS, confidence: 0.9 } })],
    ['a suggestion with a missing key', confirmCmd(1, { suggestion: { main_category: 'health' } })],
    ['a suggestion with an invalid category', confirmCmd(1, { suggestion: { main_category: 'nope', specific_focus: FOCUS } })],
    ['a suggestion with a too short focus', confirmCmd(1, { suggestion: { main_category: 'health', specific_focus: 'ab' } })],
    ['a dismiss with a field', dismissCmd(1, { field: 'specific_focus' })],
    ['a dismiss with a revision', dismissCmd(1, { expected_profile_revision: '5' })],
    ['a dismiss without a suggestion', dismissCmd(1, { suggestion: undefined })],
    ['a withdraw without a target', withdrawConfirmationCmd(1, { withdraws: undefined })],
    ['a withdraw(confirmation) without a field', withdrawConfirmationCmd(1, { field: undefined })],
    ['a withdraw(confirmation) with a suggestion', withdrawConfirmationCmd(1, { suggestion: SUGGESTION_FOCUS })],
    ['a withdraw(dismissal) with a field', withdrawDismissalCmd(1, { field: 'specific_focus' })],
    ['a withdraw(dismissal) without a suggestion', withdrawDismissalCmd(1, { suggestion: undefined })],
    ['a withdraw with an expected revision', withdrawConfirmationCmd(1, { expected_profile_revision: '5' })],
  ])('rejects %s as invalid_request', (_name, command) => {
    const result = run(JSON.parse(JSON.stringify(command ?? null)))
    expect(code(result)).toBe('invalid_request')
    expect(result.ok ? [] : result.issues.length).toBeGreaterThan(0)
  })

  it('a wrong contract version is its own error', () => {
    expect(code(run(confirmCmd(1, { contract_version: 'creator-focus-decision.v2' })))).toBe('unsupported_contract_version')
    expect(code(run(confirmCmd(1, { contract_version: undefined })))).toBe('unsupported_contract_version')
  })

  it('JSON-null optional parts count as absent', () => {
    expect(code(run(dismissCmd(1, { field: null, withdraws: null, expected_profile_revision: null })))).toBe('ok')
  })
})

describe('confirm: what is recorded and what is refused', () => {
  it('records a draft bound to the session user, the ACTIVE channel, the current revision and the fingerprints; no value text, no id, no time', () => {
    const result = run(confirmCmd(1))
    expect(result.ok && result.outcome).toBe('new')
    const draft = (result as { draft: DecisionEventDraft }).draft
    expect(draft).toEqual({
      user_id: USER,
      request_id: uuid(1),
      action: 'confirm',
      field: 'specific_focus',
      withdraws: null,
      channel_id: CHANNEL_A,
      value_fingerprint: focusValueFingerprint('specific_focus', FOCUS),
      fingerprint_version: 1,
      suggestion_fingerprint: focusSuggestionFingerprint(SUGGESTION_FOCUS),
      field_revision: '5',
      focus_revision: null,
    })
    expect(allKeys(draft)).not.toEqual(expect.arrayContaining(['id', 'seq', 'created_at', 'value', 'value_text']))
  })

  it('the category can be confirmed against the same suggestion (revision of THAT field)', () => {
    const result = run(confirmCmd(2, { field: 'main_category', expected_profile_revision: '7' }))
    expect(result.ok && result.outcome === 'new' && result.draft.field_revision).toBe('7')
    expect(result.ok && result.outcome === 'new' && result.draft.focus_revision).toBe('5') // the focus revision the creator saw
    expect(result.ok && result.outcome === 'new' && result.draft.value_fingerprint).toBe(focusValueFingerprint('main_category', 'health'))
  })

  it('the user and the channel come from the session and the profile, never from the command', () => {
    const w = world({ channel: CHANNEL_B })
    const result = run(confirmCmd(1, { suggestion: SUGGESTION_FOCUS }), w)
    expect(result.ok && result.outcome === 'new' && result.draft.channel_id).toBe(CHANNEL_B)
    expect(result.ok && result.outcome === 'new' && result.draft.user_id).toBe(USER)
  })

  it('refuses with no active channel', () => {
    expect(code(run(confirmCmd(1), world({ channel: null })))).toBe('no_active_channel')
  })

  it('refuses while a niche review is pending or the channel is a mismatch (the 2A rule)', () => {
    expect(code(run(confirmCmd(1), world({ rowExtras: { niche_needs_review: true } })))).toBe('channel_context_uncertain')
    expect(code(run(confirmCmd(1), world({ rowExtras: { channel_connection_type: 'mismatch' } })))).toBe('channel_context_uncertain')
  })

  it('refuses a suggestion that is not among the ACTIVE channel\'s stored suggestions', () => {
    expect(code(run(confirmCmd(1, { suggestion: { main_category: 'finance', specific_focus: 'részvények kezdőknek' } })))).toBe('suggestion_not_available')
    // stored only for the other channel
    const w = world({ rowExtras: { niche_validated_for_channel_id: CHANNEL_A }, candidates: [{ main_category: 'health', specific_focus: FOCUS, confidence: 0.9, rationale: 'x', source_channel_id: CHANNEL_B }] })
    expect(code(run(confirmCmd(1), w))).toBe('suggestion_not_available')
  })

  it('refuses when the revision the creator saw is not the current one', () => {
    expect(code(run(confirmCmd(1, { expected_profile_revision: '4' })))).toBe('profile_revision_changed')
    expect(code(run(confirmCmd(1, { expected_profile_revision: '0' })))).toBe('profile_revision_changed')
  })

  it('refuses a suggestion whose value is not the value the profile holds now', () => {
    const w = world({ focus: COOKING, category: 'lifestyle' })
    expect(code(run(confirmCmd(1), w))).toBe('value_not_adopted') // the creator holds the cooking focus, not the home-workout one
  })

  it('a category of `other` cannot be confirmed', () => {
    const w = world({ category: 'other', candidates: [{ main_category: 'other', specific_focus: FOCUS, confidence: 1, rationale: 'x', source_channel_id: CHANNEL_A }] })
    expect(code(run(confirmCmd(1, { field: 'main_category', expected_profile_revision: '7', suggestion: { main_category: 'other', specific_focus: FOCUS } }), w))).toBe('value_not_adopted')
  })

  it('refuses when the snapshot does not describe the profile row', () => {
    const w = world()
    const snapshot = { ...w.snapshot, fields: { ...w.snapshot.fields, specific_focus: { value: 'egészen más téma itt', revision: '5' } } }
    expect(code(evaluateDecisionCommand(confirmCmd(1), w.profile, snapshot, []))).toBe('snapshot_profile_mismatch')
  })

  describe('PROVENANCE: no confirming event for the creator\'s own claim', () => {
    const OWN_FOCUS = 'saját egyedi témám'
    const ownWorld = (rowExtras: Record<string, unknown> = {}) =>
      world({ focus: OWN_FOCUS, category: 'health', candidates: [{ main_category: 'health', specific_focus: FOCUS, confidence: 0.9, rationale: 'x', source_channel_id: CHANNEL_A }], rowExtras })
    const categoryCmd = (n: number, over: Record<string, unknown> = {}) => confirmCmd(n, { field: 'main_category', expected_profile_revision: '7', ...over })

    it('REVIEW EXAMPLE: focus `saját egyedi témám`, category health, suggestion (otthoni edzés kezdőknek, health): the category confirm is refused', () => {
      const w = ownWorld()
      expect(w.profile.claims.main_category).toMatchObject({ origin: 'user_declared', channel_derived: false })
      const result = run(categoryCmd(1), w)
      expect(code(result)).toBe('claim_not_confirmable')
      expect(result.ok).toBe(false)
      expect(!result.ok && result.issues).toEqual([{ path: 'profile.claims.main_category', code: 'claim_is_not_a_channel_derived_suggestion_match' }])
    })

    it('REVIEW EXAMPLE: whatever the command, no draft is produced for the creator\'s own claims', () => {
      const w = ownWorld()
      for (const command of [categoryCmd(1), confirmCmd(2), confirmCmd(3, { field: 'main_category', expected_profile_revision: '7', suggestion: SUGGESTION_FOCUS })]) {
        const result = run(command, w)
        expect(result.ok, JSON.stringify(command)).toBe(false)
      }
    })

    it('PENDING CHANNEL REVIEW (niche_needs_review: true): refused too (the channel context comes first), no draft', () => {
      expect(code(run(categoryCmd(1), ownWorld({ niche_needs_review: true })))).toBe('channel_context_uncertain')
    })

    it('a `user_corrected` focus is refused, even though its text equals the suggestion', () => {
      const base = world({ focus: COOKING, category: 'lifestyle' })
      const corrected = declareOrCorrectClaim(base.profile, 'specific_focus', FOCUS, AT)
      expect(corrected.ok).toBe(true)
      if (!corrected.ok) return
      expect(corrected.profile.claims.specific_focus).toMatchObject({ value: FOCUS, origin: 'user_corrected' })
      const snapshot = { ...base.snapshot, fields: { ...base.snapshot.fields, specific_focus: { value: FOCUS, revision: '5' } } }
      const result = evaluateDecisionCommand(confirmCmd(1), corrected.profile, snapshot, [])
      expect(code(result)).toBe('claim_not_confirmable')
    })

    it('a hand-built profile: an `unknown` claim that is not channel-derived, or an already confirmed claim, is refused too', () => {
      const w = world()
      const notDerived = structuredClone(w.profile)
      notDerived.claims.main_category = { field: 'main_category', value: 'health', origin: 'unknown', channel_derived: false, fact_eligible: false, reasons: ['form_default_value_indistinguishable'] }
      expect(code(evaluateDecisionCommand(categoryCmd(1), notDerived, w.snapshot, []))).toBe('claim_not_confirmable')
      const confirmedAlready = structuredClone(w.profile)
      confirmedAlready.claims.specific_focus = { field: 'specific_focus', value: FOCUS, origin: 'user_confirmed', channel_derived: true, fact_eligible: true, reasons: ['confirmed_by_decision_record'] }
      expect(confirmedAlready.suggestions.length).toBeGreaterThan(0)
      expect(code(evaluateDecisionCommand(confirmCmd(2), confirmedAlready, w.snapshot, []))).toBe('claim_not_confirmable')
    })

    it('an already confirmed claim (the in-memory 2A transition) is refused (that transition also consumes the suggestion)', () => {
      const w = world()
      const confirmed = confirmSuggestion(w.profile, w.profile.suggestions[0].index, AT)
      expect(confirmed.ok).toBe(true)
      if (!confirmed.ok) return
      expect(code(evaluateDecisionCommand(confirmCmd(1), confirmed.profile, w.snapshot, []))).toBe('suggestion_not_available')
    })

    it('the category is confirmed together with its WHOLE suggestion: the current focus must be that suggestion\'s focus', () => {
      // both suggestions are health, the creator holds the cooking focus
      const w = world({ focus: COOKING, category: 'health', candidates: [{ main_category: 'health', specific_focus: FOCUS, confidence: 0.9, rationale: 'x', source_channel_id: CHANNEL_A }, { main_category: 'health', specific_focus: COOKING, confidence: 0.9, rationale: 'x', source_channel_id: CHANNEL_A }] })
      expect(w.profile.claims.main_category).toMatchObject({ origin: 'unknown', channel_derived: true })
      expect(code(run(categoryCmd(1), w))).toBe('value_not_adopted') // suggestion (FOCUS, health), focus now COOKING
      const right = run(categoryCmd(2, { suggestion: { main_category: 'health', specific_focus: COOKING } }), w)
      expect(code(right)).toBe('ok')
    })

    it('the strict identity: a focus that differs only in case from the suggestion is not "adopted" (the 2A fit rule is a different thing)', () => {
      const w = world({ focus: 'Otthoni edzés kezdőknek', category: 'health' })
      expect(w.profile.claims.specific_focus).toMatchObject({ origin: 'unknown', channel_derived: true }) // the 2A adapter still treats it as the suggestion
      expect(code(run(confirmCmd(1), w))).toBe('value_not_adopted')
      expect(code(run(categoryCmd(2), w))).toBe('value_not_adopted')
    })

    it('a focus in a script without Latin letters can now be confirmed against an identical suggestion', () => {
      const jp = '日本料理 ramen レシピ'
      const w = world({ focus: jp, category: 'lifestyle', candidates: [{ main_category: 'lifestyle', specific_focus: jp, confidence: 0.9, rationale: 'x', source_channel_id: CHANNEL_A }] })
      const result = run(confirmCmd(1, { suggestion: { main_category: 'lifestyle', specific_focus: jp } }), w)
      expect(code(result)).toBe('ok')
    })

    it('two focuses that the lossy 2A key would merge are two values: the other one is not "adopted"', () => {
      const w = world({ focus: 'ramen', category: 'lifestyle', candidates: [{ main_category: 'lifestyle', specific_focus: '日本料理 ramen', confidence: 0.9, rationale: 'x', source_channel_id: CHANNEL_A }] })
      expect(code(run(confirmCmd(1, { suggestion: { main_category: 'lifestyle', specific_focus: '日本料理 ramen' } }), w))).toBe('value_not_adopted')
    })
  })

  it('a second confirmation with a NEW request id, while the first still stands, records nothing (`already_confirmed`)', () => {
    const first = run(confirmCmd(1))
    const events = append([], (first as { draft: DecisionEventDraft }).draft)
    expect(code(run(confirmCmd(2), world(), events))).toBe('already_confirmed')
  })
})

describe('dismiss and withdraw', () => {
  it('dismiss records the suggestion fingerprint on the active channel and is allowed even under a pending review (it creates no fact)', () => {
    const result = run(dismissCmd(1), world({ rowExtras: { niche_needs_review: true } }))
    expect(result.ok && result.outcome === 'new' && result.draft).toMatchObject({
      action: 'dismiss', field: null, channel_id: CHANNEL_A, suggestion_fingerprint: focusSuggestionFingerprint(SUGGESTION_COOKING), field_revision: null, value_fingerprint: null,
    })
  })

  it('dismiss needs an active channel and a stored suggestion of it', () => {
    expect(code(run(dismissCmd(1), world({ channel: null })))).toBe('no_active_channel')
    expect(code(run(dismissCmd(1, { suggestion: { main_category: 'finance', specific_focus: 'részvények kezdőknek' } })))).toBe('suggestion_not_available')
  })

  it('withdraw(confirmation) needs an earlier confirmation of that field on THIS channel', () => {
    expect(code(run(withdrawConfirmationCmd(9)))).toBe('nothing_to_withdraw')
    expect(code(run(withdrawConfirmationCmd(9), world(), [confirmEvent(1, 'specific_focus', { revision: '5', channel: CHANNEL_B })]))).toBe('nothing_to_withdraw')
    expect(code(run(withdrawConfirmationCmd(9), world(), [confirmEvent(1, 'main_category', { revision: '7' })]))).toBe('nothing_to_withdraw')
    const ok = run(withdrawConfirmationCmd(9), world(), [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(ok.ok && ok.outcome === 'new' && ok.draft).toMatchObject({ action: 'withdraw', withdraws: 'confirmation', field: 'specific_focus', channel_id: CHANNEL_A, suggestion_fingerprint: null })
  })

  it('withdraw(confirmation) is possible even after the confirmation went stale (it is the creator\'s own record)', () => {
    const stale = world({ fRev: '9' })
    expect(code(run(withdrawConfirmationCmd(9), stale, [confirmEvent(1, 'specific_focus', { revision: '5' })]))).toBe('ok')
  })

  it('withdraw(dismissal) needs the suggestion to be currently dismissed on this channel', () => {
    expect(code(run(withdrawDismissalCmd(9)))).toBe('nothing_to_withdraw')
    expect(code(run(withdrawDismissalCmd(9), world(), [dismissEvent(1, SUGGESTION_COOKING, CHANNEL_B)]))).toBe('nothing_to_withdraw')
    expect(code(run(withdrawDismissalCmd(2), world(), [dismissEvent(1, SUGGESTION_COOKING)]))).toBe('ok')
  })

  it('withdraw(dismissal) after it was already withdrawn: nothing to withdraw', () => {
    const events = [dismissEvent(1, SUGGESTION_COOKING), { ...dismissEvent(2, SUGGESTION_COOKING), action: 'withdraw' as const, withdraws: 'dismissal' as const }]
    expect(code(run(withdrawDismissalCmd(3), world(), events))).toBe('nothing_to_withdraw')
  })

  it('every withdraw needs an active channel', () => {
    expect(code(run(withdrawConfirmationCmd(1), world({ channel: null })))).toBe('no_active_channel')
    expect(code(run(withdrawDismissalCmd(1), world({ channel: null })))).toBe('no_active_channel')
  })
})

describe('request_id: replay and conflict', () => {
  const recorded = () => append([], (run(confirmCmd(1)) as { draft: DecisionEventDraft }).draft)

  it('the same request with the same meaning is a replay: the recorded event comes back, nothing new', () => {
    const events = recorded()
    const result = run(confirmCmd(1), world(), events)
    expect(result.ok && result.outcome).toBe('replay')
    expect(result.ok && result.outcome === 'replay' && result.event).toEqual(events[0])
  })

  it('a replay is answered whatever the state is by now (profile changed, channel changed, review pending)', () => {
    const events = recorded()
    for (const w of [world({ fRev: '99' }), world({ channel: CHANNEL_B }), world({ rowExtras: { niche_needs_review: true } }), world({ focus: COOKING, category: 'lifestyle' })]) {
      expect(code(run(confirmCmd(1), w, events))).toBe('ok')
      const result = run(confirmCmd(1), w, events)
      expect(result.ok && result.outcome).toBe('replay')
    }
  })

  it('a dismissal and a withdrawal of the dismissal for the same suggestion are NOT the same request (neither direction)', () => {
    const dismissed = append([], (run(dismissCmd(1)) as { draft: DecisionEventDraft }).draft)
    expect(code(run(withdrawDismissalCmd(1), world(), dismissed))).toBe('request_id_conflict')
    const withdrawn = append(dismissed, (run(withdrawDismissalCmd(2), world(), dismissed) as { draft: DecisionEventDraft }).draft)
    expect(code(run(dismissCmd(2), world(), withdrawn))).toBe('request_id_conflict')
    // and the same meaning is a replay in both cases
    expect(code(run(dismissCmd(1), world(), dismissed))).toBe('ok')
    expect((run(withdrawDismissalCmd(2), world(), withdrawn) as { outcome: string }).outcome).toBe('replay')
  })

  it('a replay hands back a COPY: changing it never changes the stored events', () => {
    const events = recorded()
    const before = JSON.stringify(events)
    const result = run(confirmCmd(1), world(), events)
    expect(result.ok && result.outcome === 'replay').toBe(true)
    if (result.ok && result.outcome === 'replay') result.event.channel_id = 'tampered'
    expect(JSON.stringify(events)).toBe(before)
  })

  it('the request id is compared case-insensitively', () => {
    const events = recorded()
    // not vacuous: the upper-case id really is a different string
    expect(uuid(1).toUpperCase()).not.toBe(uuid(1))
    expect(events[0].request_id).toBe(uuid(1))
    const result = run(confirmCmd(1, { request_id: uuid(1).toUpperCase() }), world(), events)
    expect(result.ok && result.outcome).toBe('replay')
    // and an event stored in upper case is found by the lower-case command
    const upperStored = [{ ...events[0], request_id: uuid(1).toUpperCase() }]
    const back = run(confirmCmd(1), world(), upperStored)
    expect(back.ok && back.outcome).toBe('replay')
  })

  it('an upper-case and a lower-case copy of one id are one id: the events list with both is invalid', () => {
    const [first] = recorded()
    const second: FocusDecisionEvent = { ...first, id: 'ev-2', seq: 2, request_id: uuid(1).toUpperCase() }
    expect(code(run(confirmCmd(9), world(), [first, second]))).toBe('decision_events_invalid')
  })

  it.each([
    ['another action', () => dismissCmd(1)],
    ['another field', () => confirmCmd(1, { field: 'main_category' })],
    ['another suggestion', () => confirmCmd(1, { suggestion: SUGGESTION_COOKING })],
    ['another expected revision', () => confirmCmd(1, { expected_profile_revision: '6' })],
  ])('the same request id with %s is a conflict, never re-applied', (_name, command) => {
    const result = run(command(), world(), recorded())
    expect(code(result)).toBe('request_id_conflict')
  })

  it('a conflict is reported before any state failure (even when the state would refuse the command anyway)', () => {
    const result = run(confirmCmd(1, { expected_profile_revision: '6' }), world({ channel: null }), recorded())
    expect(code(result)).toBe('request_id_conflict')
  })

  it('a replay of a dismiss and of a withdraw works the same way', () => {
    let events = append([], (run(dismissCmd(1)) as { draft: DecisionEventDraft }).draft)
    expect(run(dismissCmd(1), world(), events).ok).toBe(true)
    expect((run(dismissCmd(1), world(), events) as { outcome: string }).outcome).toBe('replay')
    events = append(events, (run(withdrawDismissalCmd(2), world(), events) as { draft: DecisionEventDraft }).draft)
    expect((run(withdrawDismissalCmd(2), world(), events) as { outcome: string }).outcome).toBe('replay')
    expect(code(run(withdrawDismissalCmd(2, { suggestion: SUGGESTION_FOCUS }), world(), events))).toBe('request_id_conflict')
  })

  it('an unsupported-version event with the same request id is a conflict (fail-closed), not a replay', () => {
    const events = [{ ...confirmEvent(1, 'specific_focus', { revision: '5' }), fingerprint_version: 2 }]
    expect(code(run(confirmCmd(1), world(), events))).toBe('request_id_conflict')
  })
})

describe('the order of checks, and a record that cannot be trusted', () => {
  it('the command shape is checked before anything else', () => {
    const w = world()
    const badEverything = evaluateDecisionCommand({ contract_version: V, nope: 1 }, { not: 'a profile' } as never, 'x', 'y')
    expect(badEverything.ok ? 'ok' : badEverything.code).toBe('invalid_request')
    expect(code(evaluateDecisionCommand({ nope: 1 }, { not: 'a profile' } as never, 'x', 'y'))).toBe('unsupported_contract_version')
    expect(code(evaluateDecisionCommand(confirmCmd(1), { not: 'a profile' } as never, w.snapshot, []))).toBe('invalid_profile')
  })

  it('then the snapshot, then the existing events', () => {
    const w = world()
    expect(code(evaluateDecisionCommand(confirmCmd(1), w.profile, null, []))).toBe('invalid_snapshot')
    expect(code(evaluateDecisionCommand(confirmCmd(1), w.profile, w.snapshot, 'nope'))).toBe('decision_events_invalid')
    expect(code(run(confirmCmd(1), world(), [confirmEvent(1, 'specific_focus', { revision: '5', user: OTHER_USER })]))).toBe('decision_events_invalid')
  })

  it('a single malformed existing event blocks every new decision (including a withdraw)', () => {
    const bad = { ...withdrawConfirmationEvent(2, 'specific_focus'), field: null }
    expect(code(run(withdrawConfirmationCmd(9), world(), [confirmEvent(1, 'specific_focus', { revision: '5' }), bad]))).toBe('decision_events_invalid')
  })

  it('does not mutate its inputs and is deterministic', () => {
    const w = world()
    const events = [confirmEvent(1, 'specific_focus', { revision: '5' })]
    const before = JSON.stringify([w, events])
    const a = run(withdrawConfirmationCmd(2), w, events)
    const b = run(withdrawConfirmationCmd(2), w, events)
    expect(a).toEqual(b)
    expect(JSON.stringify([w, events])).toBe(before)
  })
})

describe('end to end (an array as the store): command -> event -> read model', () => {
  it('a confirm command, once recorded, makes the read model confirm the claim', () => {
    const w = world()
    let events: FocusDecisionEvent[] = []
    const result = run(confirmCmd(1), w, events)
    events = append(events, (result as { draft: DecisionEventDraft }).draft)
    const view = applyDecisions(w.profile, w.snapshot, events)
    expect(view.read_model.claims.specific_focus.confirmation.status).toBe('valid')
    expect(view.profile.claims.specific_focus?.origin).toBe('user_confirmed')
  })

  it('A -> B -> A through the commands: the old request replays, a stale expectation is refused, a fresh decision on the new revision works, the old confirmation stays invalid', () => {
    const atA = world({ fRev: '5' })
    let events = append([], (run(confirmCmd(1), atA, []) as { draft: DecisionEventDraft }).draft)

    const atB = world({ focus: COOKING, category: 'lifestyle', fRev: '9' })
    expect(applyDecisions(atB.profile, atB.snapshot, events).read_model.claims.specific_focus.confirmation.status).toBe('invalidated_by_value_change')

    const backToA = world({ fRev: '12' })
    // the old request id replays exactly what was recorded (idempotency), it does not re-confirm
    const replay = run(confirmCmd(1), backToA, events)
    expect(replay.ok && replay.outcome).toBe('replay')
    expect(applyDecisions(backToA.profile, backToA.snapshot, events).read_model.claims.specific_focus.confirmation.status).toBe('invalidated_by_value_change')
    // a new request that still expects the old revision is refused
    expect(code(run(confirmCmd(2, { expected_profile_revision: '5' }), backToA, events))).toBe('profile_revision_changed')
    // a new explicit decision on the current revision works
    const fresh = run(confirmCmd(3, { expected_profile_revision: '12' }), backToA, events)
    events = append(events, (fresh as { draft: DecisionEventDraft }).draft)
    expect(applyDecisions(backToA.profile, backToA.snapshot, events).read_model.claims.specific_focus.confirmation.status).toBe('valid')
  })

  it('dismiss then withdraw the dismissal through the commands', () => {
    const w = world()
    let events: FocusDecisionEvent[] = []
    events = append(events, (run(dismissCmd(1), w, events) as { draft: DecisionEventDraft }).draft)
    expect(applyDecisions(w.profile, w.snapshot, events).profile.suggestions.map(s => s.specific_focus)).not.toContain(COOKING)
    events = append(events, (run(withdrawDismissalCmd(2), w, events) as { draft: DecisionEventDraft }).draft)
    expect(applyDecisions(w.profile, w.snapshot, events).profile.suggestions.map(s => s.specific_focus)).toContain(COOKING)
  })
})
