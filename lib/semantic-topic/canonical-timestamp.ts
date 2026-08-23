// Semantic Topic Identity v0 -- S3A-v2 canonical timestamp contract.
//
// Every timestamp fed into normalized_input_digest (and mirrored into
// source_snapshot -- see migration 076) MUST pass through this single
// function first. Rationale: the v1 pipeline embedded whatever raw
// timestamp string a caller's data source happened to produce --
// Postgres's own `::text` cast on a timestamptz ("2026-07-26 04:47:43+00")
// and PostgREST's `to_json()`-based REST serialization of the same column
// ("2026-07-26T04:47:43+00:00") disagree on format, so the SAME instant
// hashed to a DIFFERENT normalized_input_digest depending on which code
// path fetched the evidence row. This was discovered, root-caused, and
// closed by the "Canonical Input Timestamp v2" gate; see
// docs/architecture/semantic-topic-identity-v0-contract.md SS30 for the
// full incident writeup. SEMANTIC_TOPIC_NORMALIZATION_VERSION was bumped
// 1 -> 2 in extraction-config.ts to mark this as a real, versioned change
// to the normalization algorithm, not a silent v1 patch.
//
// Canonical output contract: `YYYY-MM-DDTHH:mm:ss.sssZ` -- always UTC,
// always "T", always exactly 3 millisecond digits, always "Z". Two inputs
// that denote the same instant always produce byte-identical output,
// regardless of which timezone offset or fractional-second precision the
// original string used. NULL maps to NULL. Anything unparseable is
// rejected (throws), never silently coerced -- a caller must never be
// able to spend a reservation on an input this function could not prove
// it canonicalized correctly.
//
// Deliberately does NOT use `new Date(someString)` anywhere: the ECMA-262
// spec only guarantees a specific parse for the exact ISO 8601 subset
// `new Date().toISOString()` itself produces: it does NOT guarantee how
// (or whether) engines parse non-"Z" offsets, space-separated
// date/time, or fractional seconds with other than exactly 3 digits --
// exactly the RFC 3339 / Postgres-native variety of strings this
// contract needs to accept. Every field is instead extracted by an
// explicit regex and combined with `Date.UTC(...)`, whose *arithmetic*
// (turning calendar fields into a time value) IS fully spec-guaranteed,
// so no part of this function's behavior depends on V8/engine string-
// parsing quirks or the host's locale/timezone.
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/

function parseOffsetMinutes(offset: string): number {
  if (offset === 'Z') return 0
  const sign = offset[0] === '-' ? -1 : 1
  const digits = offset.slice(1).replace(':', '')
  const hours = Number(digits.slice(0, 2))
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0
  return sign * (hours * 60 + minutes)
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false
  // Date.UTC's own arithmetic (not string parsing) to find the last day
  // of `month`, leap-year-aware: day 0 of month+1 == last day of month.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day >= 1 && day <= daysInMonth
}

/**
 * Canonicalizes a timestamp string to exactly `YYYY-MM-DDTHH:mm:ss.sssZ`
 * (UTC, millisecond precision, truncated -- never rounded -- from any
 * finer source precision). `null` passes through as `null`. Throws on
 * anything it cannot parse and validate -- fail-closed, never a silent
 * best-effort guess.
 */
export function canonicalizeTimestamp(input: string | null): string | null {
  if (input === null) return null

  const trimmed = input.trim()
  const match = TIMESTAMP_RE.exec(trimmed)
  if (!match) {
    throw new Error(`canonicalizeTimestamp: unparseable timestamp: ${JSON.stringify(input)}`)
  }

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, fracStr, offsetStr] = match
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  const second = Number(secondStr)

  if (!isValidCalendarDate(year, month, day)) {
    throw new Error(`canonicalizeTimestamp: invalid calendar date in ${JSON.stringify(input)}`)
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`canonicalizeTimestamp: invalid time-of-day in ${JSON.stringify(input)}`)
  }

  // Explicit truncation (never rounding) to exactly 3 fractional-second
  // digits: string-slice the already-parsed digit run, zero-padded on the
  // right if the source supplied fewer than 3 digits. This is the
  // load-bearing correction over the v1 behavior -- e.g. ".000999" MUST
  // truncate to ".000", never round up to ".001" and risk carrying into
  // the next second.
  const milliseconds = Number((fracStr ?? '').padEnd(3, '0').slice(0, 3))

  const offsetMinutes = parseOffsetMinutes(offsetStr)

  // Date.UTC(...) here treats the parsed fields as if they were already
  // UTC; subtracting the source offset converts "local wall-clock time at
  // that offset" into the true UTC instant (localTime = UTC + offset =>
  // UTC = localTime - offset). No timezone-name/DST lookup is ever
  // involved -- the offset is always the explicit numeric one the source
  // string carried, which is why DST-ambiguous *named* local times are
  // categorically out of scope for this function: every accepted input
  // already carries its own explicit UTC offset (or "Z"), never a bare
  // local time requiring zone-rule disambiguation.
  const asIfUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds)
  const trueUtcMs = asIfUtcMs - offsetMinutes * 60_000

  if (!Number.isFinite(trueUtcMs)) {
    throw new Error(`canonicalizeTimestamp: out-of-range timestamp: ${JSON.stringify(input)}`)
  }

  return new Date(trueUtcMs).toISOString()
}
