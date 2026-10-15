// lib/creator-focus/fit.ts
// A conservative, deterministic, source-traceable focus-fit assessment of ONE topic against a FocusProfile.
//
// Why this does not reuse calculateNicheFit (lib/niche-fit.ts): that function scores video text against a
// semantic term map and falls back to FUZZY matches (`hasFallbackFuzzyMatch`), and returns a 0-100 score. Both
// are the opposite of what is needed here (an auditable yes / partly / no / "we do not know"). Only the
// existing relevance gate's word and prefix rule is reused, through termsMatch().
//
// The profile is NOT trusted. It is validated structurally and for consistency (profile-validate.ts) and every
// fact-eligibility decision is RECOMPUTED here from the claim's origin and the channel context
// (eligibility.ts); a `fact_eligible` flag that arrives with the profile is only checked, never used as an
// authority. An inconsistent profile is rejected as a whole (`invalid_input`). What no pure module can do is
// authenticate that an origin is TRUE; see profile-validate.ts.
//
// Rules, in order of precedence (the first that applies decides):
//   1. malformed or inconsistent input         -> unknown (invalid_input)
//   2. the user declared stats_only mode        -> unknown (stats_only_mode): the product rule is that the
//      channel/profile niche must not drive anything in that mode
//   3. topic too short to judge                -> unknown (topic_too_short)
//   4. avoid-topic hit AND focus overlap       -> unknown (conflicting_claims)
//   5. avoid-topic hit                          -> does_not_fit  (only a user-declared avoid topic can say "no")
//   6. no fact-eligible focus                  -> unknown (no_eligible_focus)
//   7. no lexical overlap                      -> unknown (no_lexical_overlap): the absence of shared words is
//      NOT evidence that the topic does not fit
//   8. >= 2 focus terms matched                -> fits; exactly one -> partial
// System suggestions, the model's own confidence and unknown-origin claims are never used as facts.
//
// LANE: always `unknown` in 2A. A topic's linked_signal_cluster_id is an unverified string supplied by the
// caller; it is returned only as an unverified link signal and never as evidence for a lane.
import {
  CREATOR_FOCUS_CONTRACT_VERSION,
  FACT_ORIGINS,
  FIT_LIMITATIONS,
  FOCUS_LIMITS,
  type FitReason,
  type FocusClaim,
  type FocusFitAssessment,
  type FocusFitInput,
  type FocusProfile,
  type UnknownReason,
} from './contract'
import { isFactEligible } from './eligibility'
import { validateFocusProfile } from './profile-validate'
import { cleanText, termsMatch, termsOf } from './text'

const INPUT_KEYS = ['contract_version', 'profile', 'topic']
const TOPIC_KEYS = ['text', 'linked_signal_cluster_id']

type UnverifiedLink = FocusFitAssessment['lane_suggestion']['unverified_link']

function empty(): FocusFitAssessment {
  return {
    contract_version: CREATOR_FOCUS_CONTRACT_VERSION,
    status: 'unknown',
    unknown_because: [],
    reasons: [],
    lane_suggestion: { value: 'unknown', reasons: ['lane_requires_an_authenticated_link_and_decision'], unverified_link: null },
    basis: { claims_used: [], suggestions_ignored: 0, suggestions_other_channel: 0 },
    warnings: [],
    limitations: [...FIT_LIMITATIONS],
    issues: [],
  }
}

function invalid(issues: Array<{ path: string; code: string }>): FocusFitAssessment {
  const out = empty()
  out.unknown_because = ['invalid_input']
  out.issues = issues
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function matchedFocusTerms(topicTerms: string[], focusTerms: string[]): string[] {
  const hit: string[] = []
  for (const focus of focusTerms) if (topicTerms.some(t => termsMatch(t, focus))) hit.push(focus)
  return hit
}

function avoidPhrases(text: string): string[][] {
  return text
    .split(/[,;\n]/)
    .map(part => termsOf(part))
    .filter(terms => terms.length > 0)
    .slice(0, FOCUS_LIMITS.max_avoid_phrases)
}

export function assessFocusFit(rawInput: FocusFitInput): FocusFitAssessment {
  // ── 1. input validation (strict: unknown keys are rejected, nothing is coerced, no flag is trusted) ──
  const input: unknown = rawInput
  if (!isRecord(input)) return invalid([{ path: '', code: 'not_an_object' }])
  const issues: Array<{ path: string; code: string }> = []
  for (const key of Object.keys(input)) if (!INPUT_KEYS.includes(key)) issues.push({ path: key, code: 'unknown_field' })
  if (input.contract_version !== CREATOR_FOCUS_CONTRACT_VERSION) issues.push({ path: 'contract_version', code: 'unsupported_version' })
  issues.push(...validateFocusProfile(input.profile))

  const topicRaw = input.topic
  let topicText: string | null = null
  let clusterId: string | null = null
  if (!isRecord(topicRaw)) {
    issues.push({ path: 'topic', code: 'invalid_value' })
  } else {
    for (const key of Object.keys(topicRaw)) if (!TOPIC_KEYS.includes(key)) issues.push({ path: `topic.${key}`, code: 'unknown_field' })
    topicText = typeof topicRaw.text === 'string' ? topicRaw.text.replace(/\s+/g, ' ').trim() : null
    if (topicText === null || topicText.length > FOCUS_LIMITS.max_topic_chars) issues.push({ path: 'topic.text', code: 'invalid_value' })
    if (topicRaw.linked_signal_cluster_id !== undefined && topicRaw.linked_signal_cluster_id !== null) {
      clusterId = cleanText(topicRaw.linked_signal_cluster_id, 1, FOCUS_LIMITS.max_id_chars)
      if (clusterId === null) issues.push({ path: 'topic.linked_signal_cluster_id', code: 'invalid_value' })
    }
  }
  if (issues.length > 0 || topicText === null) return invalid(issues)

  const profile = input.profile as FocusProfile
  const out = empty()
  // the id, when well-formed, is echoed as an UNVERIFIED hint; it never changes status or lane
  const link: UnverifiedLink = clusterId ? { kind: 'linked_signal_cluster_id', value: clusterId, status: 'unverified' } : null
  out.lane_suggestion.unverified_link = link
  if (link) out.lane_suggestion.reasons.push('linked_signal_cluster_id_is_an_unverified_hint')

  out.basis.suggestions_ignored = profile.suggestions.length
  out.basis.suggestions_other_channel = profile.suggestions_other_channel
  if (profile.channel.mismatch) out.warnings.push('channel_mismatch')
  if (profile.channel.niche_review_required) out.warnings.push('niche_review_pending')

  // eligibility is RECOMPUTED here; the (already verified-consistent) flag on the claim is not read again
  const claims = profile.claims as Partial<Record<string, FocusClaim>>
  const eligible = (claim: FocusClaim | undefined): boolean => claim !== undefined && isFactEligible(claim, profile.channel)
  if (Object.values(claims).some(c => c && c.channel_derived && profile.channel.context_uncertain)) out.warnings.push('channel_derived_claims_unreliable')
  if (out.basis.suggestions_ignored > 0) out.warnings.push('system_suggestions_not_used_as_facts')

  const unknown = (reason: UnknownReason): FocusFitAssessment => {
    out.status = 'unknown'
    if (!out.unknown_because.includes(reason)) out.unknown_because.push(reason)
    return out
  }

  // ── 2. stats_only: a user-declared mode that forbids using the profile niche ──
  const mode = claims.channel_usage_mode
  if (mode && eligible(mode) && mode.value === 'stats_only') {
    out.basis.claims_used.push({ field: 'channel_usage_mode', origin: mode.origin })
    return unknown('stats_only_mode')
  }

  // ── 3. topic length ──
  const topicTerms = termsOf(topicText)
  if (topicText.length < FOCUS_LIMITS.min_topic_chars || topicTerms.length < 2) return unknown('topic_too_short')

  // ── focus and avoid evidence (fact-eligible claims only) ──
  const focusClaim = claims.specific_focus
  const focusUsable = eligible(focusClaim)
  const focusTerms = focusUsable && focusClaim ? termsOf(focusClaim.value) : []
  const focusHits = focusTerms.length > 0 ? matchedFocusTerms(topicTerms, focusTerms) : []

  const avoidClaim = claims.avoid_topics
  const avoidHits: string[] = []
  if (avoidClaim && eligible(avoidClaim)) {
    for (const phrase of avoidPhrases(avoidClaim.value)) {
      if (phrase.every(term => topicTerms.some(t => termsMatch(t, term)))) avoidHits.push(...phrase)
    }
  }
  const avoidMatched = avoidHits.length > 0

  // ── 4. contradiction beats everything below ──
  if (avoidMatched && focusHits.length > 0) {
    out.reasons.push({ code: 'avoid_topic_matched', claim_field: 'avoid_topics', claim_origin: avoidClaim!.origin, matched_terms: [...new Set(avoidHits)].sort() })
    out.reasons.push({ code: 'focus_terms_matched', claim_field: 'specific_focus', claim_origin: focusClaim!.origin, matched_terms: [...focusHits].sort() })
    out.basis.claims_used.push({ field: 'specific_focus', origin: focusClaim!.origin }, { field: 'avoid_topics', origin: avoidClaim!.origin })
    return unknown('conflicting_claims')
  }

  // ── 5. an explicit, user-declared avoid topic ──
  if (avoidMatched) {
    out.status = 'does_not_fit'
    out.reasons.push({ code: 'avoid_topic_matched', claim_field: 'avoid_topics', claim_origin: avoidClaim!.origin, matched_terms: [...new Set(avoidHits)].sort() })
    out.basis.claims_used.push({ field: 'avoid_topics', origin: avoidClaim!.origin })
    return out
  }

  // ── 6. a focus that may serve as a fact ──
  if (!focusUsable || !focusClaim) {
    const why: FitReason = { code: 'focus_missing', claim_field: 'specific_focus', claim_origin: null, matched_terms: [] }
    if (focusClaim) {
      why.claim_origin = focusClaim.origin
      why.code = focusClaim.channel_derived && profile.channel.context_uncertain && FACT_ORIGINS.includes(focusClaim.origin)
        ? 'focus_claim_not_eligible_channel_context_uncertain'
        : 'focus_claim_origin_unknown'
    } else if (out.basis.suggestions_ignored > 0) {
      why.code = 'focus_only_system_suggested'
    }
    out.reasons.push(why)
    return unknown('no_eligible_focus')
  }
  out.basis.claims_used.push({ field: 'specific_focus', origin: focusClaim.origin })

  // ── 7 / 8. overlap ──
  if (focusHits.length === 0) return unknown('no_lexical_overlap')
  const sorted = [...focusHits].sort()
  if (focusHits.length >= 2) {
    out.status = 'fits'
    out.reasons.push({ code: 'focus_terms_matched', claim_field: 'specific_focus', claim_origin: focusClaim.origin, matched_terms: sorted })
  } else {
    out.status = 'partial'
    out.reasons.push({ code: 'single_focus_term_matched', claim_field: 'specific_focus', claim_origin: focusClaim.origin, matched_terms: sorted })
  }
  return out
}
