// FICTIONAL profile rows for the Creator Focus tests. Nothing here is a real creator, channel or video.
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
