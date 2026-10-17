// lib/creator-focus/decision-contract.ts
// Creator Intelligence 2B (local, DB-free core) -- the versioned DECISION contract.
//
// WHAT THIS IS: the shapes of a creator's explicit DECISIONS about two focus fields (specific_focus, main_category)
// and the rules that turn a list of such decisions into a read model. Everything is PURE: the events are handed in,
// nothing is read or stored here.
//
// WHAT THIS IS NOT (yet): a durable record. There is no table, no trigger, no API route and no UI behind it. The
// events exist only as the caller's arguments. Until a store exists, nothing in this file makes a confirmation
// outlive the process that built it, and it is not a user-usable Creator Intelligence feature.
//
// THE SINGLE SOURCE-OF-TRUTH RULE (see docs/architecture/creator-focus-2b.md):
//   * the VALUE of a field is whatever the profile row says now;
//   * a DECISION is bound to (user, field, channel, value fingerprint, field REVISION);
//   * a confirmation is valid only while the revision and the channel it was made on are still the current ones.
//     A later profile save that changes the field gives it a new revision, so the confirmation is no longer valid
//     for that or any later value (including A -> B -> A) until a NEW explicit decision is made.
//   * PROVENANCE: only a claim that the 2A adapter could not attribute to the creator (origin `unknown`, a
//     channel-derived suggestion match) can be raised to `user_confirmed`. The creator's own declared / corrected
//     claims are never rewritten by a decision event (status `claim_not_confirmable`).
//   * IDENTITY: a decision is about THIS value, compared strictly (see fingerprint.ts), not by the lossy 2A topic key.
//
// PRODUCT RULE (channel round trip): the channel is part of the binding, but nothing makes a channel change bump the
// field revision. If the active channel goes A -> B -> A while the value and the field revision stay the same, the
// confirmation made on A is valid again. This is intended (the creator decided about this value on this channel and
// neither changed); a change of the value gives a new revision and ends it. A new explicit decision is needed only
// after a value change, a withdrawal, or on a different channel.
//
// INPUT BOUNDARY: events and snapshots are JSON-shaped data (what JSON.parse or a database driver returns). Objects
// with getters, Proxies, prototype-chain properties or sparse arrays are not part of the contract and are not
// defended against beyond what the strict key checks happen to catch.
export const FOCUS_DECISION_CONTRACT_VERSION = 'creator-focus-decision.v1' as const

/** The 2B decisions cover exactly these two fields. audience / avoid_topics are deliberately NOT in this version. */
export type DecisionField = 'specific_focus' | 'main_category'
export const DECISION_FIELDS: readonly DecisionField[] = Object.freeze(['specific_focus', 'main_category'] as DecisionField[])

export type DecisionAction = 'confirm' | 'dismiss' | 'withdraw'
export const DECISION_ACTIONS: readonly DecisionAction[] = Object.freeze(['confirm', 'dismiss', 'withdraw'] as DecisionAction[])

/** what a `withdraw` takes back */
export type WithdrawTarget = 'confirmation' | 'dismissal'
export const WITHDRAW_TARGETS: readonly WithdrawTarget[] = Object.freeze(['confirmation', 'dismissal'] as WithdrawTarget[])

/**
 * A revision is a bigint carried as a canonical decimal STRING (no sign, no leading zeros, at most 19 digits). It is
 * only ever compared for EQUALITY: a revision is unique, not ordered (sequence values are handed out
 * non-transactionally, so their order is not the commit order). Never convert it to a number.
 */
export const REVISION_PATTERN = /^(0|[1-9][0-9]{0,18})$/
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
export const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const DECISION_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

// OPEN BLOCKER before any durable store: more than `max_events` events are refused (the whole layer is disabled),
// there is no compaction and no revocation/erasure path. Raising the number or reading "the last N" would silently
// change meaning (a dropped withdrawal revives a confirmation), so the cap is a limit, not a solution.
// The command evaluator refuses to propose a NEW event when the list is already at the cap
// (`event_capacity_reached`), so a client cannot push the list over it; that refusal is a CAPACITY guard only. It is
// not compaction, it frees nothing, and it is not a durable revocation path: a creator at the cap can no longer
// record any new decision (not even a withdrawal) until compaction/retention is decided and built.
export const DECISION_LIMITS = Object.freeze({
  max_events: 5000,
  max_id_chars: 128,
  max_fingerprint_version: 1000,
})

/**
 * One recorded decision. It carries NO value text: validity needs only the fingerprint and the revision, so the
 * event keeps working (and stays comparable) whatever is decided later about retaining or erasing the words.
 */
export interface FocusDecisionEvent {
  /** the record's own identifier */
  id: string
  /** strictly positive, unique per user, assigned by the (future) store; the order of decisions */
  seq: number
  user_id: string
  /** idempotency key of the command that produced it (a UUID) */
  request_id: string
  action: DecisionAction
  /** confirm / withdraw(confirmation): the field; dismiss / withdraw(dismissal): null */
  field: DecisionField | null
  /** withdraw only */
  withdraws: WithdrawTarget | null
  /** the channel the decision was made on (the ACTIVE channel at the time) */
  channel_id: string
  /** confirm only: fingerprint of the confirmed value (version below) */
  value_fingerprint: string | null
  /** the canonicalisation version of every fingerprint in this event */
  fingerprint_version: number
  /** confirm: the suggestion it was confirmed against; dismiss / withdraw(dismissal): the suggestion concerned */
  suggestion_fingerprint: string | null
  /** confirm only: the field revision the value had when the creator decided */
  field_revision: string | null
  /**
   * confirm of `main_category` only (null otherwise): the revision of `specific_focus` the creator saw. A category is
   * confirmed together with the focus of its whole suggestion, so the confirmation ends with ANY later change of the
   * focus, including a value round trip A -> B -> A (which gives the focus a new revision).
   */
  focus_revision: string | null
  /** audit only; never used for ordering or validity */
  created_at: string
}

/** an event before the store has assigned id, seq and time */
export type DecisionEventDraft = Omit<FocusDecisionEvent, 'id' | 'seq' | 'created_at'>

/** What the caller read from the profile row (revisions as text, `::text`, never as a JS number). */
export interface ProfileDecisionSnapshot {
  user_id: string
  fields: Record<DecisionField, { value: string | null; revision: string }>
}

export interface DecisionIssue {
  path: string
  code: string
}

export type ConfirmationStatus =
  | 'none'
  | 'valid'
  | 'withdrawn'
  | 'invalidated_by_value_change'
  | 'invalidated_by_channel_change'
  | 'unsupported_fingerprint_version'
  | 'integrity_mismatch'
  | 'no_current_value'
  /**
   * a recorded decision matches the value, revision and channel, but the claim is NOT a channel-derived suggestion
   * match (the creator's own declared / corrected claim, or a claim that is already confirmed): the decision record
   * never rewrites such a claim, and it is not reported as a valid confirmation either
   */
  | 'claim_not_confirmable'
  | 'unverifiable'

export interface DecisionReadModelClaim {
  field: DecisionField
  value: string | null
  /** origin of the claim in the RETURNED profile; null when there is no claim */
  origin: string | null
  confirmation: { status: ConfirmationStatus; decision_id: string | null }
}

export interface DecisionReadModelSuggestion {
  index: number
  main_category: string
  specific_focus: string
  suggestion_fingerprint: string | null
  status: 'open' | 'dismissed'
}

export interface DecisionReadModel {
  contract_version: typeof FOCUS_DECISION_CONTRACT_VERSION
  /** `disabled`: the profile, the snapshot or the events were not trustworthy; NO decision was applied */
  layer: 'applied' | 'disabled'
  claims: Record<DecisionField, DecisionReadModelClaim>
  suggestions: DecisionReadModelSuggestion[]
  issues: DecisionIssue[]
  limitations: string[]
}

/** Always listed: what this read model cannot say. */
export const DECISION_LIMITATIONS: readonly string[] = Object.freeze([
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

// ───────────────────────────── commands ─────────────────────────────
export interface DecisionCommand {
  contract_version: typeof FOCUS_DECISION_CONTRACT_VERSION
  request_id: string
  action: DecisionAction
  field?: DecisionField | null
  /** the stored suggestion concerned (confirm, dismiss, withdraw of a dismissal) */
  suggestion?: { main_category: string; specific_focus: string } | null
  withdraws?: WithdrawTarget | null
  /** confirm: the revision of the field the creator saw. An EXPECTATION only; the store's current value decides. */
  expected_profile_revision?: string | null
  /** confirm of `main_category` only: the revision of `specific_focus` the creator saw (required there, forbidden elsewhere) */
  expected_focus_revision?: string | null
}

export type DecisionFailureCode =
  | 'invalid_request'
  | 'unsupported_contract_version'
  | 'invalid_profile'
  | 'invalid_snapshot'
  | 'snapshot_profile_mismatch'
  | 'decision_events_invalid'
  | 'request_id_conflict'
  | 'no_active_channel'
  | 'channel_context_uncertain'
  | 'suggestion_not_available'
  | 'profile_revision_changed'
  | 'value_not_adopted'
  | 'claim_not_confirmable'
  | 'nothing_to_withdraw'
  /** the confirmation already stands (same field, channel, revision(s) and value): a repeat records nothing */
  | 'already_confirmed'
  /** the suggestion is already dismissed on this channel: a repeat records nothing */
  | 'already_dismissed'
  /**
   * the event list is at the applyDecisions cap, so appending one more event would disable the whole layer. This is a
   * CAPACITY refusal, NOT compaction and NOT a durable revocation path: both stay open blockers before a store.
   */
  | 'event_capacity_reached'
  /** the profile object is already the output of applyDecisions (see FocusProfile.decision_projection) */
  | 'profile_already_projected'

export type DecisionCommandResult =
  | { ok: true; outcome: 'new'; draft: DecisionEventDraft }
  | { ok: true; outcome: 'replay'; event: FocusDecisionEvent }
  | { ok: false; code: DecisionFailureCode; issues: DecisionIssue[] }
