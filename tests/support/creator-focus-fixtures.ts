// FICTIONAL profile rows for the Creator Focus tests. Nothing here is a real creator, channel or video.
import { adaptProfileRow, confirmSuggestion, isFactEligible, type FocusProfile } from '@/lib/creator-focus'
export const CHANNEL_A = 'UC_fictional_channel_a'
export const CHANNEL_B = 'UC_fictional_channel_b'

export function candidate(focus: string, category: string, channel: string | null = CHANNEL_A) {
  return {
    main_category: category,
    specific_focus: focus,
    confidence: 0.91,
    rationale: 'invented rationale text that must never be carried',
    ...(channel ? { source_channel_id: channel } : {}),
  }
}

/** A profiles row with every column the adapter reads, defaulted the way an untouched row looks. */
export function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specific_focus: null,
    main_category: null,
    audience: null,
    avoid_topics: null,
    channel_usage_mode: 'manual',
    niche: '',
    selected_main_niche: null,
    primary_creator_lane: null,
    detected_niche_candidates: null,
    niche_needs_review: false,
    niche_validated_for_channel_id: null,
    active_channel_id: null,
    channel_connection_type: null,
    ...over,
  }
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/** Every object key in a value, recursively (for "this output never grows a score/prediction field" checks). */
export function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(v => allKeys(v, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); allKeys(v, out) }
  }
  return out
}

export const AT = '2026-10-15T12:00:00Z'

/**
 * A profile in which the user has CONFIRMED a suggestion in memory (user_confirmed, channel-derived, a fact) and
 * the channel context THEN becomes uncertain (a review turns pending): the flags are recomputed consistently, as
 * a caller that re-derives the profile would. The only way a channel-derived claim can be a fact at all.
 */
export function confirmedThenReviewPending(rowOver: Record<string, unknown> = {}): { before: FocusProfile; after: FocusProfile } {
  const start = adaptProfileRow(row({
    detected_niche_candidates: [candidate('otthoni edzés kezdőknek', 'health')], active_channel_id: CHANNEL_A, ...rowOver,
  }))
  const confirmed = confirmSuggestion(start, 0, AT)
  if (!confirmed.ok) throw new Error('fixture: confirmation refused')
  const before = confirmed.profile
  const after = structuredClone(before)
  after.channel.niche_review_required = true
  after.channel.context_uncertain = true
  for (const claim of Object.values(after.claims)) if (claim) claim.fact_eligible = isFactEligible(claim, after.channel)
  return { before, after }
}
