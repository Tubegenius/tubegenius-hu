// lib/creator-focus/decision-command.ts
// Creator Intelligence 2B -- the PURE evaluation of a decision COMMAND against the current state: is it new, a replay
// of one already recorded, or in conflict, and if it is new, which event would be recorded?
//
// It does not write anything. The (future) store would append the returned draft, assigning id, seq and time; the
// user and the channel come from the authenticated session and the profile, never from the command.
//
// REQUEST_ID MODEL (idempotency):
//   * the same request_id with the same meaning       -> `replay`: the already recorded event is returned, whatever
//                                                         the state is by now; nothing new is recorded;
//   * the same request_id with a different meaning    -> `request_id_conflict`: never silently re-applied;
//   * "meaning" = (action, field, withdraws, suggestion, expected revision, expected focus revision). The channel and
//     the current state are NOT part of it: they are the server's.
//
// NO-OPS RECORD NOTHING: a repeat of a confirmation that already stands (`already_confirmed`), of a dismissal that
// already holds (`already_dismissed`), or a withdrawal of nothing standing (`nothing_to_withdraw`) gives no draft,
// even with a fresh request_id, so a retrying client cannot fill the event list.
// CAPACITY: a NEW draft is never proposed when the list is already at the cap applyDecisions reads
// (`event_capacity_reached`). That is a capacity guard only: not compaction, not revocability (open blockers).
// A category confirmation also carries the focus revision the creator saw (`expected_focus_revision`).
//
// ORDER OF CHECKS (the first failure wins): command shape -> profile -> not already projected -> snapshot -> existing
// events -> request_id -> state -> (new draft) capacity. A `confirm` additionally needs: an active channel, no
// pending review / mismatch (the 2A rule: that has to
// go through the product's own review flow), a stored suggestion of the ACTIVE channel, the revision the creator
// saw still being the current one, and the suggestion's value being (strictly, see fingerprint.ts) the value the
// profile holds now. PROVENANCE: the current claim of that field must be a channel-derived suggestion match (origin
// `unknown`); the creator's own declared / corrected claim is refused (`claim_not_confirmable`), so no event is
// produced that could pass it off as channel-derived. A category is confirmed together with its WHOLE suggestion: the
// current focus must equal the suggestion's focus. A confirm does not change the profile; it records a decision
// about the value that is already there.
import { type FocusProfile } from './contract'
import {
  DECISION_ACTIONS,
  DECISION_FIELDS,
  DECISION_LIMITS,
  FOCUS_DECISION_CONTRACT_VERSION,
  REQUEST_ID_PATTERN,
  REVISION_PATTERN,
  WITHDRAW_TARGETS,
  type DecisionCommand,
  type DecisionCommandResult,
  type DecisionEventDraft,
  type DecisionField,
  type DecisionIssue,
  type FocusDecisionEvent,
} from './decision-contract'
import { validateDecisionEvents, validateSnapshot } from './decision-events'
import { FINGERPRINT_VERSION, focusSuggestionFingerprint, focusValueFingerprint, isSupportedFingerprintVersion, normalizeDecisionValue } from './fingerprint'
import { validateFocusProfile } from './profile-validate'

const COMMAND_KEYS = ['contract_version', 'request_id', 'action', 'field', 'suggestion', 'withdraws', 'expected_profile_revision', 'expected_focus_revision']
const SUGGESTION_KEYS = ['main_category', 'specific_focus']

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const absent = (v: unknown) => v === undefined || v === null

interface ParsedCommand {
  request_id: string
  action: DecisionCommand['action']
  field: DecisionField | null
  suggestion: { main_category: string; specific_focus: string } | null
  withdraws: 'confirmation' | 'dismissal' | null
  expected_profile_revision: string | null
  expected_focus_revision: string | null
}

function parseCommand(raw: unknown): { ok: true; command: ParsedCommand } | { ok: false; code: 'invalid_request' | 'unsupported_contract_version'; issues: DecisionIssue[] } {
  const issues: DecisionIssue[] = []
  const add = (path: string, code: string) => issues.push({ path, code })
  if (!isRecord(raw)) return { ok: false, code: 'invalid_request', issues: [{ path: 'command', code: 'not_an_object' }] }
  for (const key of Object.keys(raw)) if (!COMMAND_KEYS.includes(key)) add(`command.${key}`, 'unknown_field')
  if (raw.contract_version !== FOCUS_DECISION_CONTRACT_VERSION) {
    return { ok: false, code: 'unsupported_contract_version', issues: [{ path: 'command.contract_version', code: 'unsupported_version' }] }
  }
  if (typeof raw.request_id !== 'string' || !REQUEST_ID_PATTERN.test(raw.request_id)) add('command.request_id', 'invalid_value')
  if (!DECISION_ACTIONS.includes(raw.action as DecisionCommand['action'])) add('command.action', 'invalid_value')

  let field: DecisionField | null = null
  if (!absent(raw.field)) {
    if (DECISION_FIELDS.includes(raw.field as DecisionField)) field = raw.field as DecisionField
    else add('command.field', 'invalid_value')
  }
  let withdraws: ParsedCommand['withdraws'] = null
  if (!absent(raw.withdraws)) {
    if (WITHDRAW_TARGETS.includes(raw.withdraws as 'confirmation' | 'dismissal')) withdraws = raw.withdraws as 'confirmation' | 'dismissal'
    else add('command.withdraws', 'invalid_value')
  }
  let suggestion: ParsedCommand['suggestion'] = null
  if (!absent(raw.suggestion)) {
    const s = raw.suggestion
    if (!isRecord(s) || Object.keys(s).length !== SUGGESTION_KEYS.length || !SUGGESTION_KEYS.every(k => k in s)) add('command.suggestion', 'invalid_shape')
    else if (focusSuggestionFingerprint(s as { main_category: unknown; specific_focus: unknown }) === null) add('command.suggestion', 'invalid_value')
    else suggestion = { main_category: s.main_category as string, specific_focus: s.specific_focus as string }
  }
  let expected: string | null = null
  if (!absent(raw.expected_profile_revision)) {
    if (typeof raw.expected_profile_revision === 'string' && REVISION_PATTERN.test(raw.expected_profile_revision)) expected = raw.expected_profile_revision
    else add('command.expected_profile_revision', 'invalid_value')
  }
  let expectedFocus: string | null = null
  if (!absent(raw.expected_focus_revision)) {
    if (typeof raw.expected_focus_revision === 'string' && REVISION_PATTERN.test(raw.expected_focus_revision)) expectedFocus = raw.expected_focus_revision
    else add('command.expected_focus_revision', 'invalid_value')
  }

  // which parts each action needs (and forbids)
  const action = raw.action
  const need = (name: string, present: boolean, wanted: boolean) => {
    if (wanted && !present) add(`command.${name}`, 'required_for_this_action')
    if (!wanted && present) add(`command.${name}`, 'not_allowed_for_this_action')
  }
  if (action === 'confirm') {
    need('field', field !== null, true); need('suggestion', suggestion !== null, true)
    need('expected_profile_revision', expected !== null, true); need('withdraws', withdraws !== null, false)
    need('expected_focus_revision', expectedFocus !== null, field === 'main_category') // a category is bound to the focus revision seen
  } else if (action === 'dismiss') {
    need('suggestion', suggestion !== null, true); need('field', field !== null, false)
    need('expected_profile_revision', expected !== null, false); need('withdraws', withdraws !== null, false)
    need('expected_focus_revision', expectedFocus !== null, false)
  } else if (action === 'withdraw') {
    need('withdraws', withdraws !== null, true); need('expected_profile_revision', expected !== null, false)
    need('expected_focus_revision', expectedFocus !== null, false)
    if (withdraws === 'confirmation') { need('field', field !== null, true); need('suggestion', suggestion !== null, false) }
    if (withdraws === 'dismissal') { need('suggestion', suggestion !== null, true); need('field', field !== null, false) }
  }
  if (issues.length > 0) return { ok: false, code: 'invalid_request', issues }
  return {
    ok: true,
    command: { request_id: (raw.request_id as string), action: action as ParsedCommand['action'], field, suggestion, withdraws, expected_profile_revision: expected, expected_focus_revision: expectedFocus },
  }
}

/** The part of a command that decides "the same request": what it means, not when or on which state. */
function meaningMatches(command: ParsedCommand, event: FocusDecisionEvent): boolean {
  if (command.action !== event.action) return false
  if (command.field !== event.field) return false
  if (command.withdraws !== event.withdraws) return false
  if (command.expected_profile_revision !== event.field_revision) return false
  if (command.expected_focus_revision !== event.focus_revision) return false
  const suggestionFingerprint = command.suggestion === null ? null : focusSuggestionFingerprint(command.suggestion, event.fingerprint_version)
  return suggestionFingerprint === event.suggestion_fingerprint
}

/** the latest of dismiss / withdraw(dismissal) for this suggestion on this channel decides (same rule as the reducer) */
function suggestionIsDismissed(events: FocusDecisionEvent[], channelId: string, suggestion: { main_category: string; specific_focus: string }): boolean {
  let dismissed = false
  for (const e of events) {
    if ((e.action !== 'dismiss' && !(e.action === 'withdraw' && e.withdraws === 'dismissal')) || e.channel_id !== channelId) continue
    if (!isSupportedFingerprintVersion(e.fingerprint_version)) continue
    if (e.suggestion_fingerprint !== focusSuggestionFingerprint(suggestion, e.fingerprint_version)) continue
    dismissed = e.action === 'dismiss'
  }
  return dismissed
}

/** a confirmation of this field on this channel that no later withdraw(confirmation) of the same field + channel took back */
const isStanding = (events: FocusDecisionEvent[], e: FocusDecisionEvent): boolean =>
  !events.some(w => w.action === 'withdraw' && w.withdraws === 'confirmation' && w.field === e.field && w.channel_id === e.channel_id && w.seq > e.seq)

export function evaluateDecisionCommand(
  commandInput: unknown,
  profile: FocusProfile,
  snapshotInput: unknown,
  eventsInput: unknown,
): DecisionCommandResult {
  const fail = (code: Extract<DecisionCommandResult, { ok: false }>['code'], issues: DecisionIssue[] = []): DecisionCommandResult => ({ ok: false, code, issues })

  const parsed = parseCommand(commandInput)
  if (!parsed.ok) return fail(parsed.code, parsed.issues)
  const command = parsed.command

  const profileIssues = validateFocusProfile(profile).map(i => ({ path: i.path, code: i.code }))
  if (profileIssues.length > 0) return fail('invalid_profile', profileIssues)
  if (profile.decision_projection !== undefined) return fail('profile_already_projected', [{ path: 'profile.decision_projection', code: 'a_projection_is_not_an_input' }])
  const snap = validateSnapshot(snapshotInput)
  if (!snap.snapshot) return fail('invalid_snapshot', snap.issues)
  const snapshot = snap.snapshot
  const existing = validateDecisionEvents(eventsInput, snapshot.user_id)
  if (existing.issues.length > 0) return fail('decision_events_invalid', existing.issues)
  const events = existing.events

  // ── request_id: replay or conflict, regardless of the present state ──
  const same = events.find(e => e.request_id.toLowerCase() === command.request_id.toLowerCase())
  if (same) {
    return meaningMatches(command, same)
      ? { ok: true, outcome: 'replay', event: { ...same } }
      : fail('request_id_conflict', [{ path: 'command.request_id', code: 'already_used_for_a_different_decision' }])
  }

  const channelId = profile.channel.active_channel_id
  // the only way out for a NEW event: never one that would push the list over the cap applyDecisions reads
  const accept = (draft: DecisionEventDraft): DecisionCommandResult =>
    events.length >= DECISION_LIMITS.max_events
      ? fail('event_capacity_reached', [{ path: 'events', code: 'at_the_event_cap_a_capacity_refusal_not_compaction' }])
      : { ok: true, outcome: 'new', draft }

  // ── state checks per action ──
  if (command.action === 'confirm') {
    const field = command.field as DecisionField
    if (channelId === null) return fail('no_active_channel')
    if (profile.channel.context_uncertain) return fail('channel_context_uncertain')
    const suggestionFingerprint = focusSuggestionFingerprint(command.suggestion!)
    const available = profile.suggestions.find(s => focusSuggestionFingerprint(s) === suggestionFingerprint)
    if (!available || suggestionFingerprint === null) return fail('suggestion_not_available')

    const entry = snapshot.fields[field]
    if (entry.revision !== command.expected_profile_revision) return fail('profile_revision_changed')
    if (field === 'main_category' && snapshot.fields.specific_focus.revision !== command.expected_focus_revision) {
      return fail('profile_revision_changed', [{ path: 'snapshot.fields.specific_focus.revision', code: 'focus_revision_changed' }])
    }
    const current = normalizeDecisionValue(field, entry.value)
    const claim = profile.claims[field] ?? null
    if (current !== null && (claim === null || claim.value !== current)) return fail('snapshot_profile_mismatch', [{ path: `snapshot.fields.${field}`, code: 'snapshot_profile_mismatch' }])
    const currentFingerprint = focusValueFingerprint(field, current)
    const suggestedFingerprint = focusValueFingerprint(field, available[field])
    if (current === null || currentFingerprint === null || suggestedFingerprint === null || currentFingerprint !== suggestedFingerprint) return fail('value_not_adopted')

    // PROVENANCE: only a claim the adapter attributes to the channel's suggestions (origin `unknown`, channel-derived)
    // can be confirmed. The creator's own declared / corrected claim must not be rewritten into a channel-derived one,
    // so no confirming event is produced for it, whatever the value equals.
    if (claim === null || claim.origin !== 'unknown' || !claim.channel_derived) {
      return fail('claim_not_confirmable', [{ path: `profile.claims.${field}`, code: 'claim_is_not_a_channel_derived_suggestion_match' }])
    }
    // a category is confirmed together with its WHOLE suggestion: the current focus must be that suggestion's focus
    if (field === 'main_category') {
      const focusEntry = snapshot.fields.specific_focus
      const focusNow = normalizeDecisionValue('specific_focus', focusEntry.value)
      const focusClaim = profile.claims.specific_focus ?? null
      if (focusNow !== null && (focusClaim === null || focusClaim.value !== focusNow)) {
        return fail('snapshot_profile_mismatch', [{ path: 'snapshot.fields.specific_focus', code: 'snapshot_profile_mismatch' }])
      }
      const focusFingerprint = focusValueFingerprint('specific_focus', focusNow)
      const suggestedFocusFingerprint = focusValueFingerprint('specific_focus', available.specific_focus)
      if (focusFingerprint === null || suggestedFocusFingerprint === null || focusFingerprint !== suggestedFocusFingerprint) return fail('value_not_adopted')
    }

    // a repeat of a confirmation that already stands records nothing
    const alreadyStanding = events.some(e =>
      e.action === 'confirm'
      && e.field === field
      && e.channel_id === channelId
      && isSupportedFingerprintVersion(e.fingerprint_version)
      && isStanding(events, e)
      && e.field_revision === entry.revision
      && e.value_fingerprint === focusValueFingerprint(field, current, e.fingerprint_version)
      && (field === 'specific_focus'
        || (e.focus_revision === snapshot.fields.specific_focus.revision && e.suggestion_fingerprint === focusSuggestionFingerprint(command.suggestion!, e.fingerprint_version))))
    if (alreadyStanding) return fail('already_confirmed')

    const draft: DecisionEventDraft = {
      user_id: snapshot.user_id,
      request_id: command.request_id,
      action: 'confirm',
      field,
      withdraws: null,
      channel_id: channelId,
      value_fingerprint: currentFingerprint,
      fingerprint_version: FINGERPRINT_VERSION,
      suggestion_fingerprint: suggestionFingerprint,
      field_revision: entry.revision,
      focus_revision: field === 'main_category' ? snapshot.fields.specific_focus.revision : null,
    }
    return accept(draft)
  }

  if (command.action === 'dismiss') {
    if (channelId === null) return fail('no_active_channel')
    const suggestionFingerprint = focusSuggestionFingerprint(command.suggestion!)
    const available = profile.suggestions.find(s => focusSuggestionFingerprint(s) === suggestionFingerprint)
    if (!available || suggestionFingerprint === null) return fail('suggestion_not_available')
    if (suggestionIsDismissed(events, channelId, command.suggestion!)) return fail('already_dismissed')
    return accept({
      user_id: snapshot.user_id, request_id: command.request_id, action: 'dismiss', field: null, withdraws: null,
      channel_id: channelId, value_fingerprint: null, fingerprint_version: FINGERPRINT_VERSION,
      suggestion_fingerprint: suggestionFingerprint, field_revision: null, focus_revision: null,
    })
  }

  // withdraw
  if (channelId === null) return fail('no_active_channel')
  if (command.withdraws === 'confirmation') {
    const field = command.field as DecisionField
    // something to take back: a confirmation of this field on this channel that has not been taken back already
    const hasStanding = events.some(e => e.action === 'confirm' && e.field === field && e.channel_id === channelId && isStanding(events, e))
    if (!hasStanding) return fail('nothing_to_withdraw')
    return accept({
      user_id: snapshot.user_id, request_id: command.request_id, action: 'withdraw', field, withdraws: 'confirmation',
      channel_id: channelId, value_fingerprint: null, fingerprint_version: FINGERPRINT_VERSION,
      suggestion_fingerprint: null, field_revision: null, focus_revision: null,
    })
  }

  // withdraw of a dismissal: only if that suggestion is currently dismissed on this channel
  const suggestionFingerprint = focusSuggestionFingerprint(command.suggestion!)
  if (suggestionFingerprint === null || !suggestionIsDismissed(events, channelId, command.suggestion!)) return fail('nothing_to_withdraw')
  return accept({
    user_id: snapshot.user_id, request_id: command.request_id, action: 'withdraw', field: null, withdraws: 'dismissal',
    channel_id: channelId, value_fingerprint: null, fingerprint_version: FINGERPRINT_VERSION,
    suggestion_fingerprint: suggestionFingerprint, field_revision: null, focus_revision: null,
  })
}
