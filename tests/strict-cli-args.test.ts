// PFM Lifecycle Operator CLI v1 -- unit tests for the shared strict
// command-line argument parser (lib/semantic-topic/strict-cli-args.ts).
// Pure function, no mocking needed.
import { describe, expect, it } from 'vitest'
import { parseStrictArgs } from '@/lib/semantic-topic/strict-cli-args'

type F = '--dry-run' | '--apply' | '--semantic-topic-id' | '--target-status'
const SCHEMA: Record<F, 'boolean' | 'value'> = {
  '--dry-run': 'boolean',
  '--apply': 'boolean',
  '--semantic-topic-id': 'value',
  '--target-status': 'value',
}

describe('parseStrictArgs -- accepts well-formed input unchanged', () => {
  it('an empty argv parses to no booleans, no values', () => {
    const result = parseStrictArgs<F>([], SCHEMA)
    expect(result).toEqual({ ok: true, booleans: new Set(), values: {} })
  })
  it('a single boolean flag', () => {
    const result = parseStrictArgs<F>(['--dry-run'], SCHEMA)
    expect(result).toEqual({ ok: true, booleans: new Set(['--dry-run']), values: {} })
  })
  it('a single value flag with its value', () => {
    const result = parseStrictArgs<F>(['--semantic-topic-id', 'abc-123'], SCHEMA)
    expect(result).toEqual({ ok: true, booleans: new Set(), values: { '--semantic-topic-id': 'abc-123' } })
  })
  it('multiple distinct flags in any order', () => {
    const result = parseStrictArgs<F>(['--target-status', 'coherent', '--apply', '--semantic-topic-id', 'xyz'], SCHEMA)
    expect(result).toEqual({ ok: true, booleans: new Set(['--apply']), values: { '--target-status': 'coherent', '--semantic-topic-id': 'xyz' } })
  })
})

describe('parseStrictArgs -- rejects an unknown flag', () => {
  it('an entirely unrecognized flag', () => {
    expect(parseStrictArgs<F>(['--not-a-real-flag'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
  it('a typo of a real flag (--aply instead of --apply)', () => {
    expect(parseStrictArgs<F>(['--aply'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
  it('an unknown flag mixed in among otherwise-valid flags', () => {
    expect(parseStrictArgs<F>(['--dry-run', '--surprise-flag'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
})

describe('parseStrictArgs -- rejects an unexpected positional argument', () => {
  it('a single bare token with no flags at all', () => {
    expect(parseStrictArgs<F>(['just-a-value'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
  it('a bare token trailing after a complete, valid flag set', () => {
    expect(parseStrictArgs<F>(['--dry-run', 'unexpected'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
  it('a bare token BEFORE a valid flag', () => {
    expect(parseStrictArgs<F>(['unexpected', '--dry-run'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
})

describe('parseStrictArgs -- rejects a repeated flag', () => {
  it('the same boolean flag given twice', () => {
    expect(parseStrictArgs<F>(['--apply', '--apply'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
  it('the same value flag given twice, even with different values', () => {
    expect(parseStrictArgs<F>(['--semantic-topic-id', 'a', '--semantic-topic-id', 'b'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
})

describe('parseStrictArgs -- rejects a missing value for a value-flag', () => {
  it('a value flag as the very last token, no value follows', () => {
    expect(parseStrictArgs<F>(['--semantic-topic-id'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
  it('a value flag immediately followed by another flag (never silently consumes it as a value)', () => {
    expect(parseStrictArgs<F>(['--semantic-topic-id', '--dry-run'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
})

describe('parseStrictArgs -- rejects the --flag=value form entirely', () => {
  it('a known flag written with an = sign', () => {
    expect(parseStrictArgs<F>(['--semantic-topic-id=abc'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
  it('a boolean flag written with an = sign', () => {
    expect(parseStrictArgs<F>(['--apply=true'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
})

describe('parseStrictArgs -- rejects an unexpected value after a boolean flag', () => {
  it('--dry-run followed by a bare, non-flag token', () => {
    expect(parseStrictArgs<F>(['--dry-run', 'true'], SCHEMA)).toEqual({ ok: false, reason: 'INVALID_ARGUMENTS' })
  })
})

describe('parseStrictArgs -- never partially succeeds', () => {
  it('a single violation anywhere in a long, otherwise-valid argv rejects the whole parse', () => {
    const result = parseStrictArgs<F>(['--semantic-topic-id', 'x', '--target-status', 'coherent', '--apply', '--rogue'], SCHEMA)
    expect(result.ok).toBe(false)
  })
})
