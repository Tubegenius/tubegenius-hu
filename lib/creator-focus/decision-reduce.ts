// lib/creator-focus/decision-reduce.ts
// Creator Intelligence 2B -- the PURE reducer / read model: (profile view, snapshot, decision events) -> the profile
// view with the creator's recorded decisions applied.
//
// NOT DURABLE: the events are the caller's argument. Nothing is read or stored here, and a profile row alone still
// never proves `user_confirmed`. Without any events, the returned profile equals the input (2A behaviour unchanged).
//
// THE RULES (one source of truth: the VALUE is the profile row's, the DECISION is the record's):
//   * confirmation validity   a `confirm` event makes the field's claim `user_confirmed` only while ALL hold:
//       - no later `withdraw(confirmation)` for that field on the event's channel,
//       - the fingerprint version is one this code knows (otherwise the event is inert, never reinterpreted),
//       - the event's channel is the ACTIVE channel,
//       - the event's field revision EQUALS the current field revision  (any save that changed the field has given it
//         a new, never-reused revision: A -> B -> A does not bring a confirmation back),
//       - the event's value fingerprint equals the fingerprint of the current value (defence in depth: with the
//         revision equal this can only fail if the revision protection was bypassed; that is reported as an
//         integrity mismatch and the confirmation is NOT honoured).
//       - PROVENANCE: the claim is a channel-derived suggestion match (origin `unknown`). The creator's own declared /
//         corrected claim (and an already confirmed one) is never rewritten: status `claim_not_confirmable`,
//       - for the CATEGORY: the focus is still the focus of the whole suggestion it was confirmed against AND still
//         the same focus REVISION the creator saw (a focus round trip A -> B -> A has a new revision).
//     A confirmation that is not valid has no effect; a NEW explicit decision on the current revision is needed.
//     (A channel round trip A -> B -> A with an unchanged value and field revision makes it valid again: a product
//     rule, see decision-contract.ts.)
//   * withdrawal              `withdraw(confirmation)` takes back every confirmation of that field on that channel
//                             made before it; a later `confirm` is a new decision and counts again.
//   * unknown version         an event that NEEDS A VALUE IDENTITY (confirm, dismiss, withdraw(dismissal)) and carries
//                             a fingerprint version this code does not know is INERT: never honoured, never
//                             reinterpreted, and it does not disable the layer. `withdraw(confirmation)` carries no
//                             fingerprint (it is bound to the event's field + channel + order only), so it keeps
//                             WORKING whatever its version: making a withdrawal inert would bring an earlier
//                             confirmation back to life. (An event that is not even structurally valid does disable
//                             the whole layer: see decision-events.ts.)
//   * projection              the returned profile carries `decision_projection` when a non-empty list was applied.
//                             A profile that already carries it is refused as the input (`profile_already_projected`):
//                             the dismissed suggestions are gone from it, so a second pass would give a silently
//                             weaker read model. Applying the SAME events to the SAME unprojected input is
//                             deterministic and repeatable.
//   * dismissal               the latest of dismiss / withdraw(dismissal) for a (channel, suggestion fingerprint)
//                             decides. It hides the suggestion in THIS read model only; it makes no promise about any
//                             suggestion generator, and it never touches a claim.
//   * context                 a confirmed claim is channel-derived: the 2A rule still applies, so under a pending
//                             niche review or a channel mismatch it is `user_confirmed` but not a FACT.
//   * fail-closed             an invalid profile, snapshot or event list disables the whole layer.
import {
  type ClaimField,
  type FocusClaim,
  type FocusProfile,
} from './contract'
import {
  DECISION_FIELDS,
  DECISION_LIMITATIONS,
  FOCUS_DECISION_CONTRACT_VERSION,
  type ConfirmationStatus,
  type DecisionField,
  type DecisionIssue,
  type DecisionReadModel,
  type DecisionReadModelClaim,
  type DecisionReadModelSuggestion,
  type FocusDecisionEvent,
  type ProfileDecisionSnapshot,
} from './decision-contract'
import { validateDecisionEvents, validateSnapshot } from './decision-events'
import { isFactEligible } from './eligibility'
import { focusSuggestionFingerprint, focusValueFingerprint, isSupportedFingerprintVersion, normalizeDecisionValue } from './fingerprint'
import { validateFocusProfile } from './profile-validate'

export function cloneFocusProfile(profile: FocusProfile): FocusProfile {
  return {
    ...profile,
    claims: Object.fromEntries(Object.entries(profile.claims).map(([k, v]) => [k, { ...v!, reasons: [...v!.reasons] }])),
    suggestions: profile.suggestions.map(s => ({ ...s })),
    channel: { ...profile.channel },
    ...(profile.decision_projection ? { decision_projection: { ...profile.decision_projection } } : {}),
    ignored_columns: profile.ignored_columns.map(c => ({ ...c })),
    history: profile.history.map(h => ({ ...h, from: h.from ? { ...h.from } : null, to: h.to ? { ...h.to } : null })),
  }
}

function suggestionRows(profile: FocusProfile, dismissed: (index: number) => boolean): DecisionReadModelSuggestion[] {
  return profile.suggestions.map(s => ({
    index: s.index,
    main_category: s.main_category,
    specific_focus: s.specific_focus,
    suggestion_fingerprint: focusSuggestionFingerprint(s),
    status: dismissed(s.index) ? 'dismissed' : 'open',
  }))
}

function disabled(profile: FocusProfile, issues: DecisionIssue[]): { profile: FocusProfile; read_model: DecisionReadModel } {
  const valid = validateFocusProfile(profile).length === 0
  const claims = {} as Record<DecisionField, DecisionReadModelClaim>
  for (const field of DECISION_FIELDS) {
    const claim = valid ? profile.claims[field as ClaimField] : undefined
    claims[field] = {
      field,
      value: claim ? claim.value : null,
      origin: claim ? claim.origin : null,
      confirmation: { status: 'unverifiable', decision_id: null },
    }
  }
  return {
    profile: valid ? cloneFocusProfile(profile) : profile,
    read_model: {
      contract_version: FOCUS_DECISION_CONTRACT_VERSION,
      layer: 'disabled',
      claims,
      suggestions: valid ? suggestionRows(profile, () => false) : [],
      issues,
      limitations: [...DECISION_LIMITATIONS],
    },
  }
}

export function applyDecisions(
  profile: FocusProfile,
  snapshotInput: unknown,
  eventsInput: unknown,
): { profile: FocusProfile; read_model: DecisionReadModel } {
  const profileIssues = validateFocusProfile(profile).map(i => ({ path: i.path, code: i.code }))
  if (profileIssues.length > 0) return disabled(profile, [{ path: 'profile', code: 'invalid_profile' }, ...profileIssues])

  if (profile.decision_projection !== undefined) return disabled(profile, [{ path: 'profile', code: 'profile_already_projected' }])

  const parsedSnapshot = validateSnapshot(snapshotInput)
  if (!parsedSnapshot.snapshot) return disabled(profile, [{ path: 'snapshot', code: 'invalid_snapshot' }, ...parsedSnapshot.issues])
  const snapshot: ProfileDecisionSnapshot = parsedSnapshot.snapshot

  const parsedEvents = validateDecisionEvents(eventsInput, snapshot.user_id)
  if (parsedEvents.issues.length > 0) return disabled(profile, [{ path: 'events', code: 'decision_events_invalid' }, ...parsedEvents.issues])
  const events = parsedEvents.events // ascending by seq

  const next = cloneFocusProfile(profile)
  const issues: DecisionIssue[] = []
  const activeChannel = profile.channel.active_channel_id
  const withdrawals = events.filter(e => e.action === 'withdraw' && e.withdraws === 'confirmation')

  const claims = {} as Record<DecisionField, DecisionReadModelClaim>
  for (const field of DECISION_FIELDS) {
    const snap = snapshot.fields[field]
    const current = normalizeDecisionValue(field, snap.value)
    const claim = profile.claims[field as ClaimField] ?? null
    const confirms = events.filter(e => e.action === 'confirm' && e.field === field)

    let status: ConfirmationStatus = 'none'
    let decisionId: string | null = null

    if (current !== null && (claim === null || claim.value !== current)) {
      // the snapshot and the profile view do not describe the same row: nothing is honoured for this field
      issues.push({ path: `snapshot.fields.${field}`, code: 'snapshot_profile_mismatch' })
      status = 'unverifiable'
    } else if (confirms.length > 0) {
      const withdrawn = (e: FocusDecisionEvent) =>
        withdrawals.some(w => w.field === field && w.channel_id === e.channel_id && w.seq > e.seq)
      const supported = (e: FocusDecisionEvent) => isSupportedFingerprintVersion(e.fingerprint_version)
      // a category is confirmed together with the focus of the WHOLE suggestion it was confirmed against: if the focus
      // is no longer that suggestion's focus, the category confirmation is no longer about what the creator holds
      const focusNow = normalizeDecisionValue('specific_focus', snapshot.fields.specific_focus.value)
      const focusClaim = profile.claims.specific_focus ?? null
      const suggestionBound = (e: FocusDecisionEvent) => {
        if (field !== 'main_category') return true
        if (current === null || focusNow === null || focusClaim === null || focusClaim.value !== focusNow) return false
        // the focus is the same revision the creator saw (a value round trip A -> B -> A has a new one) ...
        if (e.focus_revision !== snapshot.fields.specific_focus.revision) return false
        // ... and the event's suggestion is the (category, focus) pair the creator holds now
        return e.suggestion_fingerprint === focusSuggestionFingerprint({ main_category: current, specific_focus: focusNow }, e.fingerprint_version)
      }
      const valid = confirms.filter(e =>
        current !== null
        && !withdrawn(e)
        && supported(e)
        && e.channel_id === activeChannel
        && e.field_revision === snap.revision
        && e.value_fingerprint === focusValueFingerprint(field, current, e.fingerprint_version))

      if (valid.length > 0) {
        // PROVENANCE: only a claim the adapter could not attribute to the creator (origin `unknown`, channel-derived:
        // a suggestion match) can be raised to `user_confirmed`. A declared / corrected / already confirmed claim is
        // the creator's own and is never rewritten into a channel-derived one by a decision event.
        const bound = valid.filter(suggestionBound)
        if (claim === null || claim.origin !== 'unknown' || !claim.channel_derived) status = 'claim_not_confirmable'
        else if (bound.length === 0) status = 'invalidated_by_value_change' // the focus is no longer the suggestion's focus
        else {
          status = 'valid'
          decisionId = bound[bound.length - 1].id
        }
      } else {
        const reference = confirms[confirms.length - 1] // the most recent confirmation decides what to report
        if (withdrawn(reference)) status = 'withdrawn'
        else if (!supported(reference)) status = 'unsupported_fingerprint_version'
        else if (current === null) status = 'no_current_value'
        else if (reference.channel_id !== activeChannel) status = 'invalidated_by_channel_change'
        else if (reference.field_revision !== snap.revision) status = 'invalidated_by_value_change'
        else status = 'integrity_mismatch'
      }
    }

    if (status === 'valid' && claim !== null) {
      const upgraded: FocusClaim = {
        field: field as ClaimField,
        value: claim.value,
        origin: 'user_confirmed',
        channel_derived: true,
        fact_eligible: false,
        reasons: ['confirmed_by_decision_record'],
      }
      upgraded.fact_eligible = isFactEligible(upgraded, next.channel)
      next.claims[field as ClaimField] = upgraded
    }
    const finalClaim = next.claims[field as ClaimField] ?? null
    claims[field] = { field, value: finalClaim ? finalClaim.value : null, origin: finalClaim ? finalClaim.origin : null, confirmation: { status, decision_id: decisionId } }
  }

  // ── dismissals: the latest of dismiss / withdraw(dismissal) per (channel, suggestion fingerprint) ──
  const dismissalEvents = events.filter(e => e.action === 'dismiss' || (e.action === 'withdraw' && e.withdraws === 'dismissal'))
  const isDismissed = (s: FocusProfile['suggestions'][number]): boolean => {
    let state: 'dismissed' | 'open' | null = null
    for (const e of dismissalEvents) { // ascending by seq: the last match wins
      if (e.channel_id !== s.source_channel_id) continue
      if (!isSupportedFingerprintVersion(e.fingerprint_version)) continue
      if (e.suggestion_fingerprint !== focusSuggestionFingerprint(s, e.fingerprint_version)) continue
      state = e.action === 'dismiss' ? 'dismissed' : 'open'
    }
    return state === 'dismissed'
  }
  const dismissedIndexes = new Set(profile.suggestions.filter(isDismissed).map(s => s.index))
  const suggestions = suggestionRows(profile, index => dismissedIndexes.has(index))
  next.suggestions = next.suggestions.filter(s => !dismissedIndexes.has(s.index))

  if (events.length > 0) next.decision_projection = { contract_version: FOCUS_DECISION_CONTRACT_VERSION }

  // defence in depth: whatever this function returns must itself be a valid profile
  const resultIssues = validateFocusProfile(next)
  if (resultIssues.length > 0) return disabled(profile, [{ path: 'result', code: 'result_profile_invalid' }, ...resultIssues.map(i => ({ path: i.path, code: i.code }))])

  return {
    profile: next,
    read_model: {
      contract_version: FOCUS_DECISION_CONTRACT_VERSION,
      layer: 'applied',
      claims,
      suggestions,
      issues,
      limitations: [...DECISION_LIMITATIONS],
    },
  }
}
