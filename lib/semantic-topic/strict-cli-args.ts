// Shared strict command-line argument parser for the PFM Lifecycle
// Operator CLIs (scripts/lifecycle-review-request-admin.ts,
// scripts/execute-approved-lifecycle-transition.ts). Pure, synchronous,
// no I/O -- both CLIs call this as their very first parsing step, before
// any environment read, Supabase client construction, project guard,
// interactive prompt, or DB call.
//
// Fail-closed by construction: everything NOT explicitly recognized is
// rejected with the same closed { ok: false, reason: 'INVALID_ARGUMENTS' }
// result -- never a partial parse, never a best-effort guess, and the
// caller never echoes the raw argv back (see both CLIs' own
// 'invalid command-line arguments' log line, which carries no field
// derived from argv at all).
//
// -h/--help are deliberately OUTSIDE this schema -- each CLI pre-scans
// for them and short-circuits to printing help (exit 0) before this
// function is ever called, matching the established, already-reviewed
// behavior ("--help always works, regardless of anything else on the
// command line"). This module never has to know about that flag.

export type CliFlagKind = 'boolean' | 'value'

export type StrictArgsResult<K extends string> =
  | { ok: true; booleans: Set<K>; values: Partial<Record<K, string>> }
  | { ok: false; reason: 'INVALID_ARGUMENTS' }

// Rejects, in this order of discovery (first violation wins -- the exact
// order does not matter for security, only that EVERY one of these is
// covered):
//   - a bare token that isn't a recognized flag and isn't consumed as the
//     immediately-preceding value-flag's value (covers both "unexpected
//     positional argument" and "boolean flag followed by an unexpected
//     value" -- both are just an unconsumed bare token under this model)
//   - any token containing '=' (neither CLI supports --flag=value syntax)
//   - an unrecognized --flag
//   - the same flag given more than once (boolean or value alike)
//   - a value-flag with no following token, or whose following token
//     itself looks like a flag (starts with '--') -- treated as a
//     missing value, never silently consuming a later flag as this
//     flag's value
export function parseStrictArgs<K extends string>(argv: readonly string[], schema: Readonly<Record<K, CliFlagKind>>): StrictArgsResult<K> {
  const booleans = new Set<K>()
  const values: Partial<Record<K, string>> = {}
  const knownFlags = new Set(Object.keys(schema))

  let i = 0
  while (i < argv.length) {
    const token = argv[i]

    if (!token.startsWith('--')) {
      return { ok: false, reason: 'INVALID_ARGUMENTS' }
    }
    if (token.includes('=')) {
      return { ok: false, reason: 'INVALID_ARGUMENTS' }
    }
    if (!knownFlags.has(token)) {
      return { ok: false, reason: 'INVALID_ARGUMENTS' }
    }
    const flag = token as K
    if (booleans.has(flag) || flag in values) {
      return { ok: false, reason: 'INVALID_ARGUMENTS' }
    }

    if (schema[flag] === 'boolean') {
      booleans.add(flag)
      i += 1
    } else {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, reason: 'INVALID_ARGUMENTS' }
      }
      values[flag] = next
      i += 2
    }
  }

  return { ok: true, booleans, values }
}
