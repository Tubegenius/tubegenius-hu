// lib/creator-focus/transitions.ts
// Explicit state transitions of a FocusProfile. Each one is a PURE function: it returns a NEW profile and never
// mutates its input.
//
// NOTHING HERE IS DURABLE. The history exists only inside the returned profile object. Nothing is written to a
// database, a cache or a file; after a restart, or when the profile row is read again through the adapter,
// the confirmations and corrections made here are gone. Persisting them is an undecided, separate step.
//
// A system suggestion changes into a confirmed claim ONLY through confirmSuggestion(), i.e. an explicit call that
// stands for a user's decision. Nothing else in this module promotes a suggestion.
import {
  CHANNEL_USAGE_MODES,
  FOCUS_LIMITS,
  MAIN_CATEGORY_VALUES,
  type ClaimField,
  type ClaimOrigin,
  type FocusClaim,
  type FocusProfile,
  type FocusTransition,
} from './contract'
import { cleanText } from './text'
import { isFactEligible } from './eligibility'

export type TransitionFailureCode =
  | 'invalid_timestamp'
  | 'unknown_suggestion'
  | 'channel_context_uncertain'
  | 'invalid_field'
  | 'invalid_value'

export type TransitionResult =
  | { ok: true; profile: FocusProfile; transition: FocusTransition | null }
  | { ok: false; code: TransitionFailureCode; profile: FocusProfile }

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function clone(profile: FocusProfile): FocusProfile {
  return {
    ...profile,
    claims: Object.fromEntries(Object.entries(profile.claims).map(([k, v]) => [k, { ...v!, reasons: [...v!.reasons] }])),
    suggestions: profile.suggestions.map(s => ({ ...s })),
    channel: { ...profile.channel },
    ignored_columns: profile.ignored_columns.map(c => ({ ...c })),
    history: profile.history.map(h => ({ ...h, from: h.from ? { ...h.from } : null, to: h.to ? { ...h.to } : null })),
  }
}

function record(
  profile: FocusProfile,
  type: FocusTransition['type'],
  field: ClaimField | null,
  from: FocusTransition['from'],
  to: FocusTransition['to'],
  at: string,
): FocusTransition {
  const transition: FocusTransition = { seq: profile.history.length + 1, type, field, from, to, at, persisted: false }
  profile.history.push(transition)
  return transition
}

function validValue(field: ClaimField, raw: unknown): string | null {
  if (field === 'main_category') return typeof raw === 'string' && MAIN_CATEGORY_VALUES.includes(raw) && raw !== 'other' ? raw : null
  if (field === 'channel_usage_mode') return typeof raw === 'string' && CHANNEL_USAGE_MODES.includes(raw) ? raw : null
  if (field === 'specific_focus') return cleanText(raw, FOCUS_LIMITS.min_focus_chars)
  return cleanText(raw)
}

/**
 * The user adopts a stored suggestion of the ACTIVE channel: its focus (and its category) become
 * user_confirmed, channel-derived claims. Refused while the channel context is uncertain: that confirmation has
 * to go through the product's own review flow, which clears the persisted review state.
 */
export function confirmSuggestion(profile: FocusProfile, suggestionIndex: number, at: string): TransitionResult {
  if (typeof at !== 'string' || !ISO_TIMESTAMP.test(at)) return { ok: false, code: 'invalid_timestamp', profile }
  const suggestion = profile.suggestions.find(s => s.index === suggestionIndex)
  if (!suggestion) return { ok: false, code: 'unknown_suggestion', profile }
  if (profile.channel.context_uncertain) return { ok: false, code: 'channel_context_uncertain', profile }

  const next = clone(profile)
  const apply = (field: 'specific_focus' | 'main_category', value: string) => {
    const before = next.claims[field]
    const claim: FocusClaim = {
      field,
      value,
      origin: 'user_confirmed',
      channel_derived: true,
      fact_eligible: false,
      reasons: ['confirmed_in_memory'],
    }
    claim.fact_eligible = isFactEligible(claim, next.channel)
    next.claims[field] = claim
    record(next, 'confirmed', field, before ? { value: before.value, origin: before.origin } : null, { value, origin: 'user_confirmed' }, at)
  }
  apply('specific_focus', suggestion.specific_focus)
  if (suggestion.main_category !== 'other') apply('main_category', suggestion.main_category)
  next.suggestions = next.suggestions.filter(s => s.index !== suggestionIndex)
  return { ok: true, profile: next, transition: next.history[next.history.length - 1] }
}

/** The user dismisses a suggestion. Claims are not touched. */
export function dismissSuggestion(profile: FocusProfile, suggestionIndex: number, at: string): TransitionResult {
  if (typeof at !== 'string' || !ISO_TIMESTAMP.test(at)) return { ok: false, code: 'invalid_timestamp', profile }
  const suggestion = profile.suggestions.find(s => s.index === suggestionIndex)
  if (!suggestion) return { ok: false, code: 'unknown_suggestion', profile }
  const next = clone(profile)
  next.suggestions = next.suggestions.filter(s => s.index !== suggestionIndex)
  const transition = record(next, 'dismissed', null, null, null, at)
  return { ok: true, profile: next, transition }
}

/**
 * The user states a value for a field. No existing claim: user_declared. A different value over an existing
 * claim: user_corrected, and the previous value and origin are kept in the history entry. The new claim is the
 * user's own words, so it is not channel-derived and stays a fact under a channel mismatch or pending review.
 */
export function declareOrCorrectClaim(profile: FocusProfile, field: ClaimField, rawValue: unknown, at: string): TransitionResult {
  if (typeof at !== 'string' || !ISO_TIMESTAMP.test(at)) return { ok: false, code: 'invalid_timestamp', profile }
  if (!(['main_category', 'specific_focus', 'audience', 'avoid_topics', 'channel_usage_mode'] as string[]).includes(field)) {
    return { ok: false, code: 'invalid_field', profile }
  }
  const value = validValue(field, rawValue)
  if (value === null) return { ok: false, code: 'invalid_value', profile }

  const before = profile.claims[field]
  if (before && before.value === value && before.fact_eligible && !before.channel_derived) {
    return { ok: true, profile, transition: null } // already that, already a fact: nothing to record
  }

  const next = clone(profile)
  const origin: ClaimOrigin = before && before.value !== value ? 'user_corrected' : 'user_declared'
  const claim: FocusClaim = {
    field,
    value,
    origin,
    channel_derived: false,
    fact_eligible: false,
    reasons: [origin === 'user_corrected' ? 'corrected_in_memory' : 'declared_in_memory'],
  }
  claim.fact_eligible = isFactEligible(claim, next.channel)
  next.claims[field] = claim
  const transition = record(
    next,
    origin === 'user_corrected' ? 'corrected' : 'declared',
    field,
    before ? { value: before.value, origin: before.origin } : null,
    { value, origin },
    at,
  )
  return { ok: true, profile: next, transition }
}
