// Creator Intelligence 2B: the test gaps the closing independent review listed. DB-free.
//   * the command's "standing confirmation" check is per CHANNEL
//   * an unknown-version withdraw(confirmation) is seen the same way by the reducer and by the command evaluator
//   * the projection marker on a confirm-only / ineffective list, and through the 2A transitions
//   * the 2A validator's handling of the marker (extra key, undefined, null)
import { describe, expect, it } from 'vitest'
import {
  applyDecisions,
  confirmSuggestion,
  declareOrCorrectClaim,
  dismissSuggestion,
  evaluateDecisionCommand,
  validateFocusProfile,
  type DecisionEventDraft,
  type FocusDecisionEvent,
} from '@/lib/creator-focus'
import {
  AT,
  CHANNEL_A,
  CHANNEL_B,
  FOCUS,
  SUGGESTION_COOKING,
  SUGGESTION_FOCUS,
  confirmEvent,
  dismissEvent,
  uuid,
  withdrawConfirmationEvent,
  world,
} from './support/creator-focus-decision-fixtures'

const V = 'creator-focus-decision.v1'
const confirmCmd = (n: number) => ({ contract_version: V, request_id: uuid(n), action: 'confirm', field: 'specific_focus', suggestion: SUGGESTION_FOCUS, expected_profile_revision: '5' })
const withdrawCmd = (n: number) => ({ contract_version: V, request_id: uuid(n), action: 'withdraw', withdraws: 'confirmation', field: 'specific_focus' })

const run = (command: unknown, w = world(), events: unknown = []) => evaluateDecisionCommand(command, w.profile, w.snapshot, events)
const code = (r: ReturnType<typeof run>) => (r.ok ? 'ok' : r.code)
const outcome = (r: ReturnType<typeof run>) => (r.ok ? r.outcome : null)
const statusOf = (r: ReturnType<typeof applyDecisions>) => r.read_model.claims.specific_focus.confirmation.status
const MARKER = { contract_version: V }

describe('"a confirmation stands" is per channel', () => {
  // channel A confirmation stands; on channel B a confirmation was made and taken back
  const events = (): FocusDecisionEvent[] => [
    confirmEvent(1, 'specific_focus', { revision: '5' }),
    confirmEvent(2, 'specific_focus', { revision: '5', channel: CHANNEL_B }),
    withdrawConfirmationEvent(3, 'specific_focus', CHANNEL_B),
  ]

  it('a withdrawal on channel B does not take channel A\'s confirmation away: a repeat on A is still `already_confirmed`', () => {
    expect(code(run(confirmCmd(10), world(), events()))).toBe('already_confirmed')
  })

  it('and channel A\'s confirmation can still be withdrawn on A', () => {
    expect(outcome(run(withdrawCmd(11), world(), events()))).toBe('new')
  })

  it('on channel B the confirmation was taken back: a new confirmation is a new decision, nothing is left to withdraw', () => {
    const b = world({ channel: CHANNEL_B })
    expect(outcome(run(confirmCmd(12), b, events()))).toBe('new')
    expect(code(run(withdrawCmd(13), b, events()))).toBe('nothing_to_withdraw')
  })
})

describe('an unknown-version withdraw(confirmation): the reducer and the command evaluator see it the same way', () => {
  const withdrawV2 = (seq: number): FocusDecisionEvent => ({ ...withdrawConfirmationEvent(seq, 'specific_focus'), fingerprint_version: 2 })

  it('v1 confirmation + v2 withdrawal: read model `withdrawn`; the command finds nothing to withdraw and accepts a new confirmation', () => {
    const w = world()
    const events = [confirmEvent(1, 'specific_focus', { revision: '5' }), withdrawV2(2)]
    expect(statusOf(applyDecisions(w.profile, w.snapshot, events))).toBe('withdrawn')
    expect(code(run(withdrawCmd(10), w, events))).toBe('nothing_to_withdraw')
    expect(outcome(run(confirmCmd(11), w, events))).toBe('new')
  })

  it('a confirmation that is inert (unknown version) can be withdrawn once, and then nothing is left', () => {
    const w = world()
    const inert = [confirmEvent(1, 'specific_focus', { revision: '5', version: 2 })]
    expect(statusOf(applyDecisions(w.profile, w.snapshot, inert))).toBe('unsupported_fingerprint_version')
    const first = run(withdrawCmd(10), w, inert)
    expect(outcome(first)).toBe('new')
    const after = [...inert, { ...(first as { draft: DecisionEventDraft }).draft, id: 'ev-2', seq: 2, created_at: AT }]
    expect(statusOf(applyDecisions(w.profile, w.snapshot, after))).toBe('withdrawn')
    expect(code(run(withdrawCmd(11), w, after))).toBe('nothing_to_withdraw')
  })

  it('an inert confirmation does not count as a standing one for the repeat guard: a v1 confirmation is a new decision', () => {
    const w = world()
    expect(outcome(run(confirmCmd(10), w, [confirmEvent(1, 'specific_focus', { revision: '5', version: 2 })]))).toBe('new')
  })
})

describe('the projection marker', () => {
  it('a confirm-only list marks the output (a dismissal is not needed for the marker)', () => {
    const w = world()
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(result.profile.decision_projection).toEqual(MARKER)
    expect(result.profile.suggestions).toHaveLength(w.profile.suggestions.length) // nothing was removed, and it is still marked
  })

  it('a non-empty but ineffective list (only an unknown-version confirmation) marks it too: conservative', () => {
    const w = world()
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5', version: 2 })])
    expect(result.profile.decision_projection).toEqual(MARKER)
    expect(result.profile.claims).toEqual(w.profile.claims)
  })

  it('a disabled result (bad events) does not mark the profile it hands back', () => {
    const w = world()
    const result = applyDecisions(w.profile, w.snapshot, [{ ...confirmEvent(1, 'specific_focus', { revision: '5' }), seq: 0 }])
    expect(result.read_model.layer).toBe('disabled')
    expect(result.profile.decision_projection).toBeUndefined()
  })

  it('the marker survives the 2A transitions (they clone the profile), the profile stays valid, and it is still refused as an input', () => {
    const w = world()
    const projected = applyDecisions(w.profile, w.snapshot, [dismissEvent(1, SUGGESTION_COOKING)]).profile
    expect(projected.decision_projection).toEqual(MARKER)
    const index = projected.suggestions[0].index

    const results = [
      confirmSuggestion(projected, index, AT),
      dismissSuggestion(projected, index, AT),
      declareOrCorrectClaim(projected, 'audience', 'haladók', AT),
    ]
    for (const result of results) {
      expect(result.ok).toBe(true)
      expect(result.profile.decision_projection).toEqual(MARKER)
      expect(validateFocusProfile(result.profile)).toEqual([])
      expect(applyDecisions(result.profile, w.snapshot, []).read_model.issues[0]).toEqual({ path: 'profile', code: 'profile_already_projected' })
      expect(code(evaluateDecisionCommand(confirmCmd(20), result.profile, w.snapshot, []))).toBe('profile_already_projected')
    }
  })
})

describe('the 2A validator and the marker', () => {
  const base = () => structuredClone(world().profile) as unknown as Record<string, unknown>
  const issues = (profile: Record<string, unknown>) => validateFocusProfile(profile).map(i => `${i.path}:${i.code}`)

  it('a profile without the key is valid, exactly as before', () => {
    expect(issues(base())).toEqual([])
    expect('decision_projection' in base()).toBe(false)
  })

  it('the exact marker is valid', () => {
    expect(issues({ ...base(), decision_projection: { contract_version: V } })).toEqual([])
  })

  it.each([
    ['an extra key', { contract_version: V, extra: 1 }],
    ['a missing contract_version', {}],
    ['another version', { contract_version: 'other' }],
    ['null', null],
    ['undefined (the KEY is present)', undefined],
    ['a string', 'x'],
    ['an array', []],
    ['a number', 1],
  ])('the marker %s is refused', (_name, marker) => {
    expect(issues({ ...base(), decision_projection: marker })).toContain('profile.decision_projection:invalid_value')
  })

  it('any other unknown key is still refused', () => {
    expect(issues({ ...base(), decision_projection_x: { contract_version: V } })).toContain('profile.decision_projection_x:unknown_field')
  })
})
