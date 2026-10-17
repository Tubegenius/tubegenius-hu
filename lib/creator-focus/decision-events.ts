// lib/creator-focus/decision-events.ts
// Creator Intelligence 2B -- STRICT validation of the decision events and of the profile snapshot that arrive
// from outside. Pure: nothing is read or stored here.
//
// INPUT BOUNDARY: JSON-shaped data only (what JSON.parse or a database driver returns). Getters, Proxies, inherited
// (prototype-chain) properties and sparse arrays are outside the contract (e.g. `k in v` below also sees inherited
// keys, and a hole in an array is skipped); they are documented, not defended against.
//
// VERSIONS: `fingerprint_version` is only checked structurally here (a positive integer up to a bound); whether this
// code KNOWS the version is the reducer's business (an unknown version is inert there). The fingerprint fields are
// validated as 64 lower-case hex whatever the version, so a future version with another format needs a change here.
//
// Fail-closed rule: the events are treated as ONE record. If any single event is malformed, foreign, duplicated or
// inconsistent, none of them is applied (the caller gets the issues and an unchanged profile). Dropping just the bad
// event would be unsafe: a dropped `withdraw` would let a withdrawn confirmation come back.
import { FOCUS_LIMITS } from './contract'
import {
  DECISION_ACTIONS,
  DECISION_FIELDS,
  DECISION_LIMITS,
  DECISION_TIMESTAMP_PATTERN,
  FINGERPRINT_PATTERN,
  REQUEST_ID_PATTERN,
  REVISION_PATTERN,
  WITHDRAW_TARGETS,
  type DecisionAction,
  type DecisionField,
  type DecisionIssue,
  type FocusDecisionEvent,
  type ProfileDecisionSnapshot,
  type WithdrawTarget,
} from './decision-contract'

const EVENT_KEYS = [
  'id', 'seq', 'user_id', 'request_id', 'action', 'field', 'withdraws', 'channel_id', 'value_fingerprint',
  'fingerprint_version', 'suggestion_fingerprint', 'field_revision', 'focus_revision', 'created_at',
]
const SNAPSHOT_KEYS = ['user_id', 'fields']
const SNAPSHOT_FIELD_KEYS = ['value', 'revision']
const MAX_SNAPSHOT_VALUE_CHARS = 5000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasExactKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => k in v)
const isId = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max

export function validateDecisionEvents(
  input: unknown,
  userId: string,
): { events: FocusDecisionEvent[]; issues: DecisionIssue[] } {
  const issues: DecisionIssue[] = []
  const add = (path: string, code: string) => issues.push({ path, code })
  if (!Array.isArray(input)) return { events: [], issues: [{ path: 'events', code: 'not_an_array' }] }
  if (input.length > DECISION_LIMITS.max_events) return { events: [], issues: [{ path: 'events', code: 'too_many_events' }] }

  const ids = new Set<string>()
  const seqs = new Set<number>()
  const requestIds = new Set<string>()

  input.forEach((raw, i) => {
    const path = `events[${i}]`
    if (!isRecord(raw) || !hasExactKeys(raw, EVENT_KEYS)) { add(path, 'invalid_shape'); return }

    if (!isId(raw.id, DECISION_LIMITS.max_id_chars)) add(`${path}.id`, 'invalid_value')
    else if (ids.has(raw.id)) add(`${path}.id`, 'duplicate')
    else ids.add(raw.id)

    if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 1) add(`${path}.seq`, 'invalid_value')
    else if (seqs.has(raw.seq as number)) add(`${path}.seq`, 'duplicate')
    else seqs.add(raw.seq as number)

    if (raw.user_id !== userId) add(`${path}.user_id`, 'foreign_user')

    if (typeof raw.request_id !== 'string' || !REQUEST_ID_PATTERN.test(raw.request_id)) add(`${path}.request_id`, 'invalid_value')
    else if (requestIds.has(raw.request_id.toLowerCase())) add(`${path}.request_id`, 'duplicate')
    else requestIds.add(raw.request_id.toLowerCase())

    if (!isId(raw.channel_id, FOCUS_LIMITS.max_id_chars)) add(`${path}.channel_id`, 'invalid_value')
    if (!Number.isInteger(raw.fingerprint_version) || (raw.fingerprint_version as number) < 1 || (raw.fingerprint_version as number) > DECISION_LIMITS.max_fingerprint_version) {
      add(`${path}.fingerprint_version`, 'invalid_value')
    }
    if (typeof raw.created_at !== 'string' || !DECISION_TIMESTAMP_PATTERN.test(raw.created_at)) add(`${path}.created_at`, 'invalid_value')

    const nullOr = (key: string, ok: (v: unknown) => boolean) => {
      if (raw[key] !== null && !ok(raw[key])) add(`${path}.${key}`, 'invalid_value')
    }
    nullOr('field', v => DECISION_FIELDS.includes(v as DecisionField))
    nullOr('withdraws', v => WITHDRAW_TARGETS.includes(v as WithdrawTarget))
    nullOr('value_fingerprint', v => typeof v === 'string' && FINGERPRINT_PATTERN.test(v))
    nullOr('suggestion_fingerprint', v => typeof v === 'string' && FINGERPRINT_PATTERN.test(v))
    nullOr('field_revision', v => typeof v === 'string' && REVISION_PATTERN.test(v))
    nullOr('focus_revision', v => typeof v === 'string' && REVISION_PATTERN.test(v))

    if (!DECISION_ACTIONS.includes(raw.action as DecisionAction)) { add(`${path}.action`, 'invalid_value'); return }
    const must = (key: string, present: boolean) => {
      if ((raw[key] !== null) !== present) add(`${path}.${key}`, present ? 'required_for_this_action' : 'not_allowed_for_this_action')
    }
    if (raw.action === 'confirm') {
      must('field', true); must('withdraws', false); must('value_fingerprint', true)
      must('suggestion_fingerprint', true); must('field_revision', true)
      must('focus_revision', raw.field === 'main_category') // only a category confirmation is bound to the focus revision
    } else if (raw.action === 'dismiss') {
      must('field', false); must('withdraws', false); must('value_fingerprint', false)
      must('suggestion_fingerprint', true); must('field_revision', false); must('focus_revision', false)
    } else {
      must('withdraws', true); must('value_fingerprint', false); must('field_revision', false); must('focus_revision', false)
      if (raw.withdraws === 'confirmation') { must('field', true); must('suggestion_fingerprint', false) }
      else if (raw.withdraws === 'dismissal') { must('field', false); must('suggestion_fingerprint', true) }
    }
  })

  if (issues.length > 0) return { events: [], issues }
  const events = (input as FocusDecisionEvent[]).map(e => ({ ...e })).sort((a, b) => a.seq - b.seq)
  return { events, issues: [] }
}

export function validateSnapshot(input: unknown): { snapshot: ProfileDecisionSnapshot | null; issues: DecisionIssue[] } {
  const issues: DecisionIssue[] = []
  const add = (path: string, code: string) => issues.push({ path, code })
  if (!isRecord(input) || !hasExactKeys(input, SNAPSHOT_KEYS)) return { snapshot: null, issues: [{ path: 'snapshot', code: 'invalid_shape' }] }
  if (!isId(input.user_id, DECISION_LIMITS.max_id_chars)) add('snapshot.user_id', 'invalid_value')
  const fields = input.fields
  if (!isRecord(fields) || !hasExactKeys(fields, DECISION_FIELDS as unknown as string[])) {
    add('snapshot.fields', 'invalid_shape')
  } else {
    for (const field of DECISION_FIELDS) {
      const entry = fields[field]
      const path = `snapshot.fields.${field}`
      if (!isRecord(entry) || !hasExactKeys(entry, SNAPSHOT_FIELD_KEYS)) { add(path, 'invalid_shape'); continue }
      if (entry.value !== null && (typeof entry.value !== 'string' || entry.value.length > MAX_SNAPSHOT_VALUE_CHARS)) add(`${path}.value`, 'invalid_value')
      if (typeof entry.revision !== 'string' || !REVISION_PATTERN.test(entry.revision)) add(`${path}.revision`, 'invalid_value')
    }
  }
  if (issues.length > 0) return { snapshot: null, issues }
  const f = fields as Record<DecisionField, { value: string | null; revision: string }>
  return {
    snapshot: {
      user_id: input.user_id as string,
      fields: {
        specific_focus: { value: f.specific_focus.value, revision: f.specific_focus.revision },
        main_category: { value: f.main_category.value, revision: f.main_category.revision },
      },
    },
    issues: [],
  }
}
