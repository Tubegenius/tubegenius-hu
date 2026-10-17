// FICTIONAL decision events and profile worlds for the Creator Focus 2B tests. Nothing here is a real creator,
// channel, video or user.
import {
  adaptProfileRow,
  focusSuggestionFingerprint,
  focusValueFingerprint,
  type DecisionField,
  type FocusDecisionEvent,
  type FocusProfile,
  type ProfileDecisionSnapshot,
} from '@/lib/creator-focus'
import { CHANNEL_A, CHANNEL_B, candidate, row } from './creator-focus-fixtures'

export { CHANNEL_A, CHANNEL_B }
export const USER = 'user-1'
export const OTHER_USER = 'user-2'
export const FOCUS = 'otthoni edzés kezdőknek'
export const COOKING = 'főzés gyorsan'
export const AT = '2026-10-17T10:00:00Z'

// every id has hex LETTERS in it (a-f), so that `.toUpperCase()` really changes it (a digits-only id would make a
// case-insensitivity test vacuous); the counter is the last group, in hex
export const uuid = (n: number) => `abcdef12-cafe-4abc-8def-${n.toString(16).padStart(12, '0')}`

export interface World {
  profile: FocusProfile
  snapshot: ProfileDecisionSnapshot
}

/**
 * A profile (built by the real 2A adapter) and the snapshot of the same row. By default the creator holds the
 * suggested focus and category of the active channel A.
 */
export function world(o: {
  focus?: string | null
  category?: string | null
  fRev?: string
  cRev?: string
  channel?: string | null
  rowExtras?: Record<string, unknown>
  candidates?: Array<ReturnType<typeof candidate>>
} = {}): World {
  const focus = o.focus === undefined ? FOCUS : o.focus
  const category = o.category === undefined ? 'health' : o.category
  const channel = o.channel === undefined ? CHANNEL_A : o.channel
  const candidates = o.candidates ?? [
    candidate(FOCUS, 'health', CHANNEL_A),
    candidate(COOKING, 'lifestyle', CHANNEL_A),
    candidate(FOCUS, 'health', CHANNEL_B),
  ]
  const profile = adaptProfileRow(row({
    specific_focus: focus,
    main_category: category,
    detected_niche_candidates: candidates,
    active_channel_id: channel,
    channel_usage_mode: 'primary_profile',
    ...(o.rowExtras ?? {}),
  }))
  const snapshot: ProfileDecisionSnapshot = {
    user_id: USER,
    fields: {
      specific_focus: { value: focus, revision: o.fRev ?? '5' },
      main_category: { value: category, revision: o.cRev ?? '7' },
    },
  }
  return { profile, snapshot }
}

const valueOf = (field: DecisionField) => (field === 'specific_focus' ? FOCUS : 'health')

export function confirmEvent(seq: number, field: DecisionField, o: {
  value?: string
  revision: string
  channel?: string
  version?: number
  suggestion?: { main_category: string; specific_focus: string }
  user?: string
  /** main_category only: the revision of the focus the creator saw (default: the default world's focus revision) */
  focusRevision?: string
}): FocusDecisionEvent {
  return {
    id: `ev-${seq}`,
    seq,
    user_id: o.user ?? USER,
    request_id: uuid(seq),
    action: 'confirm',
    field,
    withdraws: null,
    channel_id: o.channel ?? CHANNEL_A,
    value_fingerprint: focusValueFingerprint(field, o.value ?? valueOf(field), 1),
    fingerprint_version: o.version ?? 1,
    suggestion_fingerprint: focusSuggestionFingerprint(o.suggestion ?? { main_category: 'health', specific_focus: FOCUS }, 1),
    field_revision: o.revision,
    focus_revision: field === 'main_category' ? (o.focusRevision ?? '5') : null,
    created_at: AT,
  } as FocusDecisionEvent
}

export function withdrawConfirmationEvent(seq: number, field: DecisionField, channel: string = CHANNEL_A): FocusDecisionEvent {
  return {
    id: `ev-${seq}`, seq, user_id: USER, request_id: uuid(seq), action: 'withdraw', field, withdraws: 'confirmation',
    channel_id: channel, value_fingerprint: null, fingerprint_version: 1, suggestion_fingerprint: null, field_revision: null, focus_revision: null, created_at: AT,
  }
}

export function dismissEvent(seq: number, suggestion: { main_category: string; specific_focus: string }, channel: string = CHANNEL_A): FocusDecisionEvent {
  return {
    id: `ev-${seq}`, seq, user_id: USER, request_id: uuid(seq), action: 'dismiss', field: null, withdraws: null,
    channel_id: channel, value_fingerprint: null, fingerprint_version: 1,
    suggestion_fingerprint: focusSuggestionFingerprint(suggestion, 1), field_revision: null, focus_revision: null, created_at: AT,
  }
}

export function withdrawDismissalEvent(seq: number, suggestion: { main_category: string; specific_focus: string }, channel: string = CHANNEL_A): FocusDecisionEvent {
  return {
    id: `ev-${seq}`, seq, user_id: USER, request_id: uuid(seq), action: 'withdraw', field: null, withdraws: 'dismissal',
    channel_id: channel, value_fingerprint: null, fingerprint_version: 1,
    suggestion_fingerprint: focusSuggestionFingerprint(suggestion, 1), field_revision: null, focus_revision: null, created_at: AT,
  }
}

export const SUGGESTION_FOCUS = { main_category: 'health', specific_focus: FOCUS }
export const SUGGESTION_COOKING = { main_category: 'lifestyle', specific_focus: COOKING }

/** a deterministic shuffle (so the "order of the input array does not matter" test is reproducible) */
export function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items]
  let state = seed >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
