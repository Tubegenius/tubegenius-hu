// lib/creator-focus/contract.ts
// Creator Intelligence 2A -- the versioned CREATOR FOCUS contract.
//
// What this module is, and is not:
//   * It models "what we understand to be this creator's focus" as a list of CLAIMS, each with an explicit
//     ORIGIN, so a system suggestion can never silently become a stated fact.
//   * It is PURE: no database, network, file system, AI call or credit operation. It does not read
//     `process.env`, the clock or a random source. Same input, same output.
//   * It does NOT persist anything. Confirmations and corrections exist only inside the objects the functions
//     take and return; after a restart (or a fresh read of the profile row) they are gone. Durable storage is a
//     separate, undecided step (docs/architecture/creator-focus-2a.md, "Open decisions").
//   * It makes no claim about audience preference, retention or expected performance. Those need real
//     measurements this module does not have.

export const CREATOR_FOCUS_CONTRACT_VERSION = 'creator-focus.v1' as const

/** The profile facts a focus claim can be about. Free-form prompts and the legacy `niche` string are NOT claim fields. */
export type ClaimField = 'main_category' | 'specific_focus' | 'audience' | 'avoid_topics' | 'channel_usage_mode'
export const CLAIM_FIELDS: readonly ClaimField[] = ['main_category', 'specific_focus', 'audience', 'avoid_topics', 'channel_usage_mode']

/**
 * Where the CLAIM comes from (who decided to hold it), not who typed the words:
 *   user_declared     written only by user-initiated paths and not recognisable as an adopted suggestion
 *   user_confirmed    a system suggestion the user adopted: produced ONLY by the in-memory confirmSuggestion()
 *                     transition; a profiles row can never prove it
 *   user_corrected    produced ONLY by the in-memory correction transition; the adapter can never prove it
 *   system_suggested  produced by the system; NEVER a fact
 *   unknown           the origin cannot be proven from the data: never a fact
 */
export type ClaimOrigin = 'user_declared' | 'user_confirmed' | 'user_corrected' | 'system_suggested' | 'unknown'
export const FACT_ORIGINS: readonly ClaimOrigin[] = ['user_declared', 'user_confirmed', 'user_corrected']

export type ChannelConnectionKind = 'public' | 'oauth' | 'mismatch'

/** Mirrors lib/search/search-context.ts MAIN_CATEGORIES (a test keeps the two in step). */
export const MAIN_CATEGORY_VALUES: readonly string[] = Object.freeze([
  'science', 'health', 'tech_ai', 'news_current', 'psychology', 'history', 'finance', 'lifestyle', 'entertainment',
  'gaming', 'sports', 'education', 'business', 'crime_mystery', 'space', 'climate', 'other',
])
/** Mirrors the CHECK constraint of migration 029. */
export const CHANNEL_USAGE_MODES: readonly string[] = Object.freeze(['primary_profile', 'stats_only', 'niche_discovery', 'manual'])

export const FOCUS_LIMITS = Object.freeze({
  max_text_chars: 300,
  min_focus_chars: 3,
  max_candidates: 4,
  max_avoid_phrases: 20,
  min_topic_chars: 8,
  max_topic_chars: 300,
  max_id_chars: 128,
})

export type ClaimReasonCode =
  | 'written_only_by_user_initiated_paths'
  | 'matches_system_suggestion_adoption_not_provable'
  | 'validation_marker_proves_a_channel_level_decision_only'
  | 'matches_suggestion_from_other_channel'
  | 'database_default_indistinguishable'
  | 'form_default_value_indistinguishable'
  | 'unrecognized_value'
  | 'declared_in_memory'
  | 'corrected_in_memory'
  | 'confirmed_in_memory'
  | 'confirmed_by_decision_record'

export interface FocusClaim {
  field: ClaimField
  value: string
  origin: ClaimOrigin
  /** the value traces back to a channel-based system suggestion */
  channel_derived: boolean
  /** may this claim enter a fit assessment as a FACT. Always false for suggested/unknown origin. */
  fact_eligible: boolean
  reasons: ClaimReasonCode[]
}

/** A stored system suggestion for the ACTIVE channel. Model confidence and rationale text are deliberately not carried. */
export interface FocusSuggestion {
  /** index in the stored detected_niche_candidates array */
  index: number
  main_category: string
  specific_focus: string
  source_channel_id: string
  origin: 'system_suggested'
  fact_eligible: false
}

export interface FocusChannelContext {
  active_channel_id: string | null
  connection: ChannelConnectionKind | null
  niche_review_required: boolean
  mismatch: boolean
  /** claims that trace back to a channel are not reliable while this is true */
  context_uncertain: boolean
}

export type IgnoredColumnReason =
  | 'legacy_value_format_unproven'
  | 'no_in_repo_writer_origin_unproven'

export interface FocusTransition {
  seq: number
  type: 'declared' | 'corrected' | 'confirmed' | 'dismissed'
  field: ClaimField | null
  from: { value: string; origin: ClaimOrigin } | null
  to: { value: string; origin: ClaimOrigin } | null
  /** caller-supplied timestamp (the module has no clock) */
  at: string
  /** always false: history lives only in this object */
  persisted: false
}

export interface FocusProfile {
  contract_version: typeof CREATOR_FOCUS_CONTRACT_VERSION
  claims: Partial<Record<ClaimField, FocusClaim>>
  suggestions: FocusSuggestion[]
  /** stored suggestions that belong to another (or an unknown) channel: counted, never listed or used */
  suggestions_other_channel: number
  channel: FocusChannelContext
  ignored_columns: Array<{ column: string; reason: IgnoredColumnReason }>
  /** in-memory only; re-reading the profile row starts with an empty history */
  history: FocusTransition[]
  persistence: 'none'
  /**
   * 2B only, ABSENT in every 2A profile: set by `applyDecisions` on the profile it returns when it applied a
   * non-empty decision list. A profile that carries it is already a PROJECTION; it is refused as the input of a
   * second projection / command (the dismissed suggestions are gone from it, so a second pass would silently give a
   * weaker read model). The marker is asserted by whoever holds the object, like every other field.
   */
  decision_projection?: { contract_version: 'creator-focus-decision.v1' }
}

// ───────────────────────────── fit assessment ─────────────────────────────
export type FocusFitStatus = 'fits' | 'partial' | 'does_not_fit' | 'unknown'

export type UnknownReason =
  | 'invalid_input'
  | 'stats_only_mode'
  | 'topic_too_short'
  | 'conflicting_claims'
  | 'no_eligible_focus'
  | 'no_lexical_overlap'

export type FitReasonCode =
  | 'focus_terms_matched'
  | 'single_focus_term_matched'
  | 'avoid_topic_matched'
  | 'focus_claim_not_eligible_channel_context_uncertain'
  | 'focus_claim_origin_unknown'
  | 'focus_only_system_suggested'
  | 'focus_missing'

export interface FitReason {
  code: FitReasonCode
  claim_field: ClaimField | null
  claim_origin: ClaimOrigin | null
  matched_terms: string[]
}

export interface FocusFitInput {
  contract_version: typeof CREATOR_FOCUS_CONTRACT_VERSION
  profile: FocusProfile
  topic: {
    text: string
    /** video_ideas.linked_signal_cluster_id as the caller reports it: an UNVERIFIED hint, never evidence */
    linked_signal_cluster_id?: string | null
  }
}

export interface FocusFitAssessment {
  contract_version: typeof CREATOR_FOCUS_CONTRACT_VERSION
  status: FocusFitStatus
  /** non-empty exactly when status is `unknown` */
  unknown_because: UnknownReason[]
  reasons: FitReason[]
  /**
   * Always `unknown` in 2A. A caller-supplied cluster id is echoed ONLY as an unverified link signal; it is not
   * evidence, and it never produces a lane. A lane suggestion needs an authenticated link and a separate decision.
   */
  lane_suggestion: {
    value: 'unknown'
    reasons: string[]
    unverified_link: { kind: 'linked_signal_cluster_id'; value: string; status: 'unverified' } | null
  }
  basis: {
    claims_used: Array<{ field: ClaimField; origin: ClaimOrigin }>
    suggestions_ignored: number
    suggestions_other_channel: number
  }
  warnings: string[]
  limitations: string[]
  issues: Array<{ path: string; code: string }>
}

/** Always listed: what this assessment cannot say. */
export const FIT_LIMITATIONS: readonly string[] = Object.freeze([
  'lexical_overlap_only_no_semantic_understanding',
  'no_audience_preference_claim',
  'no_retention_or_performance_estimate',
  'not_a_quality_judgement_of_the_topic',
  'claim_origin_is_asserted_by_the_caller_and_not_authenticated',
  'lane_not_suggested_without_an_authenticated_link_and_decision',
])
