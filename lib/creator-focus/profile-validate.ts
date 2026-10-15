// lib/creator-focus/profile-validate.ts
// Strict structural AND consistency validation of a FocusProfile that arrives from outside (a caller, a test, a
// future API). The assessment does not trust any flag it is handed: a profile that is internally inconsistent is
// rejected as a whole, so a `system_suggested` / `unknown` claim can never reach the fit as a fact by carrying a
// `fact_eligible: true` marker.
//
// WHAT THIS CAN AND CANNOT DO: it proves a profile is consistent with the rules of this module. It cannot prove
// that an `origin` is TRUE. A pure module has no way to authenticate that a human really declared or confirmed a
// claim: a caller that fabricates a perfectly consistent `user_declared` claim is indistinguishable from an honest
// one. The origin is an assertion by whoever built the profile (the adapter, from rows the product wrote through
// user-initiated paths); establishing it for real needs an authenticated, persisted record (undecided, P1).
import {
  CHANNEL_USAGE_MODES,
  CLAIM_FIELDS,
  CREATOR_FOCUS_CONTRACT_VERSION,
  FOCUS_LIMITS,
  MAIN_CATEGORY_VALUES,
  type ClaimField,
  type ClaimOrigin,
} from './contract'
import { isFactEligible } from './eligibility'

export interface ProfileIssue {
  path: string
  code: string
}

const ORIGINS: readonly ClaimOrigin[] = ['user_declared', 'user_confirmed', 'user_corrected', 'unknown']
const PROFILE_KEYS = ['contract_version', 'claims', 'suggestions', 'suggestions_other_channel', 'channel', 'ignored_columns', 'history', 'persistence']
const CLAIM_KEYS = ['field', 'value', 'origin', 'channel_derived', 'fact_eligible', 'reasons']
const SUGGESTION_KEYS = ['index', 'main_category', 'specific_focus', 'source_channel_id', 'origin', 'fact_eligible']
const CHANNEL_KEYS = ['active_channel_id', 'connection', 'niche_review_required', 'mismatch', 'context_uncertain']
const HISTORY_TYPES = ['declared', 'corrected', 'confirmed', 'dismissed']
const MAX_HISTORY = 200

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasOnlyKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k)) && keys.every(k => k in v)
const isText = (v: unknown, min: number): v is string => typeof v === 'string' && v.length >= min && v.length <= FOCUS_LIMITS.max_text_chars && v === v.replace(/\s+/g, ' ').trim()

function validClaimValue(field: ClaimField, value: unknown): boolean {
  if (field === 'main_category') return typeof value === 'string' && MAIN_CATEGORY_VALUES.includes(value)
  if (field === 'channel_usage_mode') return typeof value === 'string' && CHANNEL_USAGE_MODES.includes(value)
  if (field === 'specific_focus') return isText(value, FOCUS_LIMITS.min_focus_chars)
  return isText(value, 1)
}

export function validateFocusProfile(profile: unknown): ProfileIssue[] {
  const issues: ProfileIssue[] = []
  const add = (path: string, code: string) => issues.push({ path, code })
  if (!isRecord(profile)) return [{ path: 'profile', code: 'not_an_object' }]

  for (const key of Object.keys(profile)) if (!PROFILE_KEYS.includes(key)) add(`profile.${key}`, 'unknown_field')
  if (profile.contract_version !== CREATOR_FOCUS_CONTRACT_VERSION) add('profile.contract_version', 'unsupported_version')
  if (profile.persistence !== 'none') add('profile.persistence', 'invalid_value')

  // ── channel context ──
  const channel = profile.channel
  let contextUncertain = false
  let activeChannelId: string | null = null
  if (!isRecord(channel) || !hasOnlyKeys(channel, CHANNEL_KEYS)) {
    add('profile.channel', 'invalid_value')
  } else {
    const bools = ['niche_review_required', 'mismatch', 'context_uncertain'].every(k => typeof channel[k] === 'boolean')
    const connectionOk = channel.connection === null || channel.connection === 'public' || channel.connection === 'oauth' || channel.connection === 'mismatch'
    const idOk = channel.active_channel_id === null || (typeof channel.active_channel_id === 'string' && channel.active_channel_id.length >= 1 && channel.active_channel_id.length <= FOCUS_LIMITS.max_id_chars)
    if (!bools || !connectionOk || !idOk) {
      add('profile.channel', 'invalid_value')
    } else {
      if (channel.mismatch !== (channel.connection === 'mismatch')) add('profile.channel.mismatch', 'inconsistent_with_connection')
      if (channel.context_uncertain !== (channel.niche_review_required === true || channel.mismatch === true)) add('profile.channel.context_uncertain', 'inconsistent_with_review_and_mismatch')
      contextUncertain = channel.context_uncertain === true
      activeChannelId = channel.active_channel_id as string | null
    }
  }

  // ── claims ──
  const claims = profile.claims
  if (!isRecord(claims)) {
    add('profile.claims', 'invalid_value')
  } else {
    for (const [key, raw] of Object.entries(claims)) {
      const path = `profile.claims.${key}`
      if (!CLAIM_FIELDS.includes(key as ClaimField)) { add(path, 'unknown_field'); continue }
      if (!isRecord(raw) || !hasOnlyKeys(raw, CLAIM_KEYS)) { add(path, 'invalid_value'); continue }
      if (raw.field !== key) add(`${path}.field`, 'does_not_match_key')
      if (!validClaimValue(key as ClaimField, raw.value)) add(`${path}.value`, 'invalid_value')
      if (raw.origin === 'system_suggested') add(`${path}.origin`, 'system_suggestion_is_not_a_claim')
      else if (!ORIGINS.includes(raw.origin as ClaimOrigin)) add(`${path}.origin`, 'invalid_value')
      if (typeof raw.channel_derived !== 'boolean') add(`${path}.channel_derived`, 'invalid_value')
      if (typeof raw.fact_eligible !== 'boolean') add(`${path}.fact_eligible`, 'invalid_value')
      if (!Array.isArray(raw.reasons) || raw.reasons.length > 5 || !raw.reasons.every(r => typeof r === 'string' && r.length <= 80)) add(`${path}.reasons`, 'invalid_value')
      if (!ORIGINS.includes(raw.origin as ClaimOrigin) || typeof raw.channel_derived !== 'boolean') continue

      const origin = raw.origin as ClaimOrigin
      if (origin === 'user_confirmed' && raw.channel_derived !== true) add(`${path}.channel_derived`, 'confirmed_claim_must_be_channel_derived')
      if ((origin === 'user_declared' || origin === 'user_corrected') && raw.channel_derived === true) add(`${path}.channel_derived`, 'own_words_cannot_be_channel_derived')
      // the flag that came with the profile is checked against the rule, never used in its place
      if (typeof raw.fact_eligible === 'boolean' && raw.fact_eligible !== isFactEligible({ origin, channel_derived: raw.channel_derived }, { context_uncertain: contextUncertain })) {
        add(`${path}.fact_eligible`, 'inconsistent_with_origin_and_channel_context')
      }
    }
  }

  // ── suggestions ──
  if (!Array.isArray(profile.suggestions) || profile.suggestions.length > FOCUS_LIMITS.max_candidates) {
    add('profile.suggestions', 'invalid_value')
  } else {
    profile.suggestions.forEach((raw, i) => {
      const path = `profile.suggestions[${i}]`
      if (!isRecord(raw) || !hasOnlyKeys(raw, SUGGESTION_KEYS)) { add(path, 'invalid_value'); return }
      if (raw.origin !== 'system_suggested') add(`${path}.origin`, 'must_be_system_suggested')
      if (raw.fact_eligible !== false) add(`${path}.fact_eligible`, 'a_suggestion_is_never_a_fact')
      if (!Number.isInteger(raw.index) || (raw.index as number) < 0) add(`${path}.index`, 'invalid_value')
      if (typeof raw.main_category !== 'string' || !MAIN_CATEGORY_VALUES.includes(raw.main_category)) add(`${path}.main_category`, 'invalid_value')
      if (!isText(raw.specific_focus, FOCUS_LIMITS.min_focus_chars)) add(`${path}.specific_focus`, 'invalid_value')
      if (typeof raw.source_channel_id !== 'string' || raw.source_channel_id !== activeChannelId) add(`${path}.source_channel_id`, 'not_the_active_channel')
    })
  }
  if (!Number.isInteger(profile.suggestions_other_channel) || (profile.suggestions_other_channel as number) < 0 || (profile.suggestions_other_channel as number) > 1000) {
    add('profile.suggestions_other_channel', 'invalid_value')
  }

  // ── bookkeeping fields ──
  if (!Array.isArray(profile.ignored_columns) || !profile.ignored_columns.every(c => isRecord(c) && typeof c.column === 'string' && typeof c.reason === 'string')) {
    add('profile.ignored_columns', 'invalid_value')
  }
  if (!Array.isArray(profile.history) || profile.history.length > MAX_HISTORY
    || !profile.history.every(h => isRecord(h) && h.persisted === false && HISTORY_TYPES.includes(h.type as string))) {
    add('profile.history', 'invalid_value')
  }
  return issues
}
