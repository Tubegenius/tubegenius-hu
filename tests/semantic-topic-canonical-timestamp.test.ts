// Semantic Topic Identity v0 -- canonical input timestamp v2. Pure unit
// tests for lib/semantic-topic/canonical-timestamp.ts -- no DB, no network.
// Cross-validated by hand against the SQL-side `to_char(ts AT TIME ZONE
// 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` formula used in migration 076;
// see tests/semantic-topic-canonical-input-timestamp-v2-db-integration.test.ts
// for the DB-side half of that cross-validation.
import { describe, expect, it } from 'vitest'
import { canonicalizeTimestamp } from '@/lib/semantic-topic/canonical-timestamp'

describe('canonicalizeTimestamp -- equivalent representations of one instant', () => {
  const cases: [string, string][] = [
    ['2026-07-26 04:47:43+00', '2026-07-26T04:47:43.000Z'],
    ['2026-07-26T04:47:43+00:00', '2026-07-26T04:47:43.000Z'],
    ['2026-07-26T04:47:43.000Z', '2026-07-26T04:47:43.000Z'],
    ['2026-07-26T06:47:43+02:00', '2026-07-26T04:47:43.000Z'],
  ]
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(canonicalizeTimestamp(input)).toBe(expected)
  })

  it('all four representations collapse to byte-identical output', () => {
    const outputs = new Set(cases.map(([input]) => canonicalizeTimestamp(input)))
    expect(outputs.size).toBe(1)
  })
})

describe('canonicalizeTimestamp -- millisecond precision is TRUNCATED, never rounded', () => {
  it.each([
    ['2026-07-26 04:47:43.000000+00', '2026-07-26T04:47:43.000Z'],
    ['2026-07-26 04:47:43.000499+00', '2026-07-26T04:47:43.000Z'],
    // The load-bearing case: naive rounding would carry .000999 -> .001,
    // which must NOT happen.
    ['2026-07-26 04:47:43.000999+00', '2026-07-26T04:47:43.000Z'],
    ['2026-07-26 04:47:43.123456+00', '2026-07-26T04:47:43.123Z'],
    // Naive rounding of .999999 would carry into the next second (44, not
    // 43) -- must not happen.
    ['2026-07-26 04:47:43.999999+00', '2026-07-26T04:47:43.999Z'],
    // Second-rollover edge: truncating .999999 at :59 must not carry into
    // the next minute either.
    ['2026-07-26 04:47:59.999999+00', '2026-07-26T04:47:59.999Z'],
  ])('%s -> %s', (input, expected) => {
    expect(canonicalizeTimestamp(input)).toBe(expected)
  })
})

describe('canonicalizeTimestamp -- timezone offsets', () => {
  it('negative offset converts correctly to UTC', () => {
    expect(canonicalizeTimestamp('2026-07-26 04:47:43-05')).toBe('2026-07-26T09:47:43.000Z')
  })
  it('positive offset with minutes converts correctly, including a date rollover', () => {
    expect(canonicalizeTimestamp('2026-07-26 04:47:43+0530')).toBe('2026-07-25T23:17:43.000Z')
  })
  it('colon-separated positive offset with minutes', () => {
    expect(canonicalizeTimestamp('2026-07-26T04:47:43+05:30')).toBe('2026-07-25T23:17:43.000Z')
  })
})

describe('canonicalizeTimestamp -- NULL passthrough', () => {
  it('null stays null', () => {
    expect(canonicalizeTimestamp(null)).toBeNull()
  })
})

describe('canonicalizeTimestamp -- fail-closed rejection', () => {
  it.each([
    'not a timestamp',
    '2026-07-26T04:47:43', // no offset/Z at all -- ambiguous, must reject
    '2026-07-26', // date only
    '',
    '   ',
  ])('rejects unparseable input %j', (input) => {
    expect(() => canonicalizeTimestamp(input)).toThrow(/unparseable/)
  })

  it.each([
    ['2026-13-01T00:00:00Z', /invalid calendar date/],
    ['2026-00-01T00:00:00Z', /invalid calendar date/],
    ['2026-02-30T00:00:00Z', /invalid calendar date/], // Feb never has 30 days
    ['2027-02-29T00:00:00Z', /invalid calendar date/], // 2027 is not a leap year
    ['2026-07-26T25:00:00Z', /invalid time-of-day/],
    ['2026-07-26T04:60:00Z', /invalid time-of-day/],
    ['2026-07-26T04:47:60Z', /invalid time-of-day/],
  ])('rejects out-of-range %s', (input, expectedMessage) => {
    expect(() => canonicalizeTimestamp(input)).toThrow(expectedMessage)
  })

  it('accepts a real leap day', () => {
    expect(canonicalizeTimestamp('2028-02-29T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z')
  })
})

describe('canonicalizeTimestamp -- output shape invariants', () => {
  it('always produces exactly the YYYY-MM-DDTHH:mm:ss.sssZ shape', () => {
    const result = canonicalizeTimestamp('2026-07-26 04:47:43+00')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('is idempotent -- canonicalizing an already-canonical string is a no-op', () => {
    const once = canonicalizeTimestamp('2026-07-26 04:47:43+00')!
    const twice = canonicalizeTimestamp(once)
    expect(twice).toBe(once)
  })
})
