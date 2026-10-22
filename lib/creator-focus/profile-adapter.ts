// lib/creator-focus/profile-adapter.ts
// Turns ONE `profiles` row into a FocusProfile. Pure: it only reads the object it is given.
//
// PROVENANCE POLICY (the result of the writer audit, see docs/architecture/creator-focus-2a.md):
//   A column is only marked user_declared when BOTH hold: (1) EVERY known writer of that column in this
//   repository is a user-initiated path, and (2) the stored value CAN be told apart from a default the system
//   filled in. A value that is indistinguishable from a default (the database default `manual`, the form's
//   initial category `other`) is therefore NEVER automatically user_declared. Where either condition fails, the
//   origin is `unknown` (or the column is ignored) and it never serves as a fit fact. A system suggestion (detected_niche_candidates) is never turned into a claim by this module.
//   A row can NEVER prove that a user adopted a particular suggestion: a value that equals a stored suggestion
//   is `unknown`, whatever the validation marker says (it proves a channel-level decision only). The origin
//   `user_confirmed` is produced solely by the in-memory confirmSuggestion() transition.
import { candidatesForActiveChannel, isNicheReviewRequired } from '@/lib/channel-scope'
import type { NicheCandidate } from '@/types'
import {
  CHANNEL_USAGE_MODES,
  CREATOR_FOCUS_CONTRACT_VERSION,
  FOCUS_LIMITS,
  MAIN_CATEGORY_VALUES,
  type ChannelConnectionKind,
  type ClaimField,
  type ClaimOrigin,
  type ClaimReasonCode,
  type FocusChannelContext,
  type FocusClaim,
  type FocusProfile,
  type FocusSuggestion,
  type IgnoredColumnReason,
} from './contract'
import { isFactEligible } from './eligibility'
import { cleanText, identityKey } from './text'

/** Per column: which in-repo writers exist, and what origin that proves. Mirrored in the architecture doc. */
export const PROFILE_COLUMN_PROVENANCE = Object.freeze({
  specific_focus: {
    writers: ['POST /api/profile (form save)', 'POST /api/youtube/resolve-niche-review (select_candidate, after an explicit click)'],
    proves: 'user-initiated writes only; the wording may come from an adopted system suggestion',
  },
  main_category: {
    writers: ['POST /api/profile (form save)', 'POST /api/youtube/resolve-niche-review (select_candidate, after an explicit click)'],
    proves: "user-initiated writes only; the form's initial value 'other' is indistinguishable from a deliberate choice",
  },
  audience: { writers: ['POST /api/profile (form save)'], proves: 'user-initiated writes only' },
  avoid_topics: { writers: ['POST /api/profile (form save)'], proves: 'user-initiated writes only' },
  channel_usage_mode: {
    writers: ['POST /api/profile (form save)', 'POST /api/youtube/confirm-channel (user choice in the request body)'],
    proves: "user-initiated writes only; the value 'manual' is also the NOT NULL database default",
  },
  niche: {
    writers: ['POST /api/profile (copy of specific_focus)', 'POST /api/youtube/resolve-niche-review'],
    proves: 'nothing usable: legacy strings (category label inside the text) exist; ignored in favour of specific_focus',
  },
  selected_main_niche: { writers: ['no in-repo writer found (allowed by the profile API, not sent by any UI)'], proves: 'nothing' },
  primary_creator_lane: { writers: ['no in-repo writer found'], proves: 'nothing' },
  detected_niche_candidates: { writers: ['POST /api/youtube/discover-niche (AI, service role)'], proves: 'system suggestion' },
  niche_validated_for_channel_id: {
    writers: ['POST /api/youtube/resolve-niche-review (keep_current / select_candidate)'],
    proves: 'a user decision about the niche for that channel; NOT that any value was adopted: keep_current leaves the value alone and a later profile save can change it without clearing the marker',
  },
  niche_needs_review: { writers: ['channel sync / resolve-mismatch (true)', 'resolve-niche-review (false)'], proves: 'system flag, cleared by the user' },
  active_channel_id: { writers: ['channel sync', 'resolve-mismatch'], proves: 'system-maintained channel identity' },
  channel_connection_type: { writers: ['channel sync', 'resolve-mismatch'], proves: 'system-maintained' },
} as const)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)


interface StoredCandidate {
  index: number
  main_category: string
  specific_focus: string
  source_channel_id: string | null
}

function readCandidates(raw: unknown): StoredCandidate[] {
  if (!Array.isArray(raw)) return []
  const out: StoredCandidate[] = []
  raw.slice(0, FOCUS_LIMITS.max_candidates).forEach((item, index) => {
    if (!isRecord(item)) return
    const focus = cleanText(item.specific_focus, FOCUS_LIMITS.min_focus_chars)
    const category = typeof item.main_category === 'string' && MAIN_CATEGORY_VALUES.includes(item.main_category) ? item.main_category : null
    if (!focus || !category) return
    const source = cleanText(item.source_channel_id, 1, FOCUS_LIMITS.max_id_chars)
    out.push({ index, main_category: category, specific_focus: focus, source_channel_id: source })
  })
  return out
}

function makeClaim(
  field: ClaimField,
  value: string,
  origin: ClaimOrigin,
  channelDerived: boolean,
  reasons: ClaimReasonCode[],
  channel: FocusChannelContext,
): FocusClaim {
  const claim: FocusClaim = { field, value, origin, channel_derived: channelDerived, fact_eligible: false, reasons }
  claim.fact_eligible = isFactEligible(claim, channel)
  return claim
}

export function adaptProfileRow(row: unknown): FocusProfile {
  const r: Record<string, unknown> = isRecord(row) ? row : {}

  // ── channel context (reuses the product's own review predicate) ──
  const activeChannelId = cleanText(r.active_channel_id, 1, FOCUS_LIMITS.max_id_chars)
  const validatedFor = cleanText(r.niche_validated_for_channel_id, 1, FOCUS_LIMITS.max_id_chars)
  const connection: ChannelConnectionKind | null =
    r.channel_connection_type === 'public' || r.channel_connection_type === 'oauth' || r.channel_connection_type === 'mismatch'
      ? r.channel_connection_type
      : null
  const stored = readCandidates(r.detected_niche_candidates)
  // confidence and rationale are deliberately zeroed: the module never carries model self-confidence or AI prose
  const asProductCandidates: NicheCandidate[] = stored.map(c => ({
    main_category: c.main_category,
    specific_focus: c.specific_focus,
    confidence: 0,
    rationale: '',
    ...(c.source_channel_id ? { source_channel_id: c.source_channel_id } : {}),
  }))
  const reviewRequired = isNicheReviewRequired({
    storedReviewFlag: r.niche_needs_review === true,
    validatedForChannelId: validatedFor,
    candidates: asProductCandidates,
    activeChannelId,
  })
  const mismatch = connection === 'mismatch'
  const channel: FocusChannelContext = {
    active_channel_id: activeChannelId,
    connection,
    niche_review_required: reviewRequired,
    mismatch,
    context_uncertain: reviewRequired || mismatch,
  }

  // ── suggestions: listed for the ACTIVE channel only; never turned into claims ──
  const activeOnes = candidatesForActiveChannel(asProductCandidates, activeChannelId)
  const suggestions: FocusSuggestion[] = []
  for (const candidate of stored) {
    if (!activeChannelId || candidate.source_channel_id !== activeChannelId) continue
    suggestions.push({
      index: candidate.index,
      main_category: candidate.main_category,
      specific_focus: candidate.specific_focus,
      source_channel_id: activeChannelId,
      origin: 'system_suggested',
      fact_eligible: false,
    })
  }
  const suggestionsOtherChannel = stored.length - activeOnes.length

  // ── claims ──
  const claims: FocusProfile['claims'] = {}
  const focusText = cleanText(r.specific_focus, FOCUS_LIMITS.min_focus_chars)
  let focusMatchesAnySuggestion = false

  if (focusText) {
    const key = identityKey(focusText)
    const matches = stored.filter(c => identityKey(c.specific_focus) === key)
    const activeMatch = matches.find(c => activeChannelId !== null && c.source_channel_id === activeChannelId)
    if (activeMatch) {
      focusMatchesAnySuggestion = true
      // The validation marker is set by BOTH resolve-niche-review actions (keep_current leaves the value alone), and
      // a later profile save can change the focus without clearing it. So it proves a decision about the CHANNEL's
      // niche at some time, never that THIS value is an adopted suggestion: the origin stays unknown either way.
      const reasons: ClaimReasonCode[] = ['matches_system_suggestion_adoption_not_provable']
      if (validatedFor !== null && validatedFor === activeChannelId) reasons.push('validation_marker_proves_a_channel_level_decision_only')
      claims.specific_focus = makeClaim('specific_focus', focusText, 'unknown', true, reasons, channel)
    } else if (matches.length > 0) {
      focusMatchesAnySuggestion = true
      claims.specific_focus = makeClaim('specific_focus', focusText, 'unknown', true, ['matches_suggestion_from_other_channel'], channel)
    } else {
      claims.specific_focus = makeClaim('specific_focus', focusText, 'user_declared', false, ['written_only_by_user_initiated_paths'], channel)
    }
  }

  if (typeof r.main_category === 'string') {
    const category = r.main_category
    if (!MAIN_CATEGORY_VALUES.includes(category)) {
      // not a recognised value: no claim at all
    } else if (category === 'other') {
      claims.main_category = makeClaim('main_category', category, 'unknown', false, ['form_default_value_indistinguishable'], channel)
    } else {
      // the category is channel-derived only together with an adopted focus that came with exactly this category
      const pair = focusText
        ? stored.find(c => identityKey(c.specific_focus) === identityKey(focusText) && c.main_category === category)
        : undefined
      if (pair && focusMatchesAnySuggestion) {
        const sameChannel = activeChannelId !== null && pair.source_channel_id === activeChannelId
        if (sameChannel) {
          const reasons: ClaimReasonCode[] = ['matches_system_suggestion_adoption_not_provable']
          if (validatedFor !== null && validatedFor === activeChannelId) reasons.push('validation_marker_proves_a_channel_level_decision_only')
          claims.main_category = makeClaim('main_category', category, 'unknown', true, reasons, channel)
        } else {
          claims.main_category = makeClaim('main_category', category, 'unknown', true, ['matches_suggestion_from_other_channel'], channel)
        }
      } else {
        claims.main_category = makeClaim('main_category', category, 'user_declared', false, ['written_only_by_user_initiated_paths'], channel)
      }
    }
  }

  for (const field of ['audience', 'avoid_topics'] as const) {
    const value = cleanText(r[field])
    if (value) claims[field] = makeClaim(field, value, 'user_declared', false, ['written_only_by_user_initiated_paths'], channel)
  }

  if (typeof r.channel_usage_mode === 'string' && CHANNEL_USAGE_MODES.includes(r.channel_usage_mode)) {
    const mode = r.channel_usage_mode
    claims.channel_usage_mode = mode === 'manual'
      ? makeClaim('channel_usage_mode', mode, 'unknown', false, ['database_default_indistinguishable'], channel)
      : makeClaim('channel_usage_mode', mode, 'user_declared', false, ['written_only_by_user_initiated_paths'], channel)
  }

  // ── columns whose origin cannot be proven: reported, never used ──
  const ignored: FocusProfile['ignored_columns'] = []
  const note = (column: string, reason: IgnoredColumnReason) => ignored.push({ column, reason })
  if (cleanText(r.niche)) note('niche', 'legacy_value_format_unproven')
  if (cleanText(r.selected_main_niche)) note('selected_main_niche', 'no_in_repo_writer_origin_unproven')
  if (cleanText(r.primary_creator_lane)) note('primary_creator_lane', 'no_in_repo_writer_origin_unproven')

  return {
    contract_version: CREATOR_FOCUS_CONTRACT_VERSION,
    claims,
    suggestions,
    suggestions_other_channel: suggestionsOtherChannel,
    channel,
    ignored_columns: ignored,
    history: [],
    persistence: 'none',
  }
}
