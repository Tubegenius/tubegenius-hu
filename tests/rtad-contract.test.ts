// Unit tests for tests/lib/rtad-contract.ts -- pure, DB-free. Deliberately
// does NOT import tests/semantic-topic-s2a-audit-temporal-db-integration.
// test.ts (the stateful, Docker-gated file this logic serves): that module
// makes real Docker/DB calls at its own top level (STATEFUL_TARGET/
// DB_CONTAINER resolution, stackAvailable's schema probe), which must never
// run as a side effect of importing it from a DB-free test file.
import { describe, expect, it } from 'vitest'
import { checkRtadContract, parseRtadContractRow, type RtadContractRow } from './lib/rtad-contract'

const HASH = '9e681c94870719a0a7cb4605de458baf'

function row(overrides: Partial<RtadContractRow> = {}): RtadContractRow {
  return {
    hash: HASH,
    owner: 'postgres',
    secdef: 'true',
    volatility: 'v',
    searchPath: 'search_path=public, pg_temp',
    svcExec: 'true',
    anonExec: 'false',
    authExec: 'false',
    ...overrides,
  }
}

describe('parseRtadContractRow', () => {
  it('splits the pipe-delimited row into its 8 named fields, in order', () => {
    const parsed = parseRtadContractRow(`${HASH}|postgres|true|v|search_path=public, pg_temp|true|false|false`)
    expect(parsed).toEqual(row())
  })

  it('trims surrounding whitespace before splitting (psql -t output often carries a trailing newline)', () => {
    const parsed = parseRtadContractRow(`\n  ${HASH}|postgres|true|v|search_path=public, pg_temp|true|false|false  \n`)
    expect(parsed).toEqual(row())
  })
})

describe('checkRtadContract -- boolean-text comparison (the actual 2026-09-28 bug)', () => {
  it('accepts the correct contract: service_role EXECUTE, anon/authenticated explicitly not, exact hash/owner/secdef/volatility/search_path', () => {
    expect(checkRtadContract(row(), HASH)).toEqual([])
  })

  it('compares against the literal Postgres ::text cast output (\'true\'/\'false\'), never psql\'s -A -t display abbreviation (\'t\'/\'f\')', () => {
    // This is the exact bug: a genuinely CORRECT row, if it had used the
    // abbreviated 't'/'f' forms instead of the real '::text' cast output,
    // must still be flagged -- proving the comparison is against the
    // literal 'true'/'false' strings, not a truthy/loose check.
    const abbreviated = row({ secdef: 't', svcExec: 't', anonExec: 'f', authExec: 'f' })
    const problems = checkRtadContract(abbreviated, HASH)
    expect(problems).toContain('secdef=t (expected true)')
    expect(problems).toContain('service_role is missing EXECUTE')
    expect(problems).toContain('anon unexpectedly has EXECUTE')
    expect(problems).toContain('authenticated unexpectedly has EXECUTE')
  })

  it('rejects missing service_role EXECUTE even when anon/authenticated are correctly locked out', () => {
    const problems = checkRtadContract(row({ svcExec: 'false' }), HASH)
    expect(problems).toEqual(['service_role is missing EXECUTE'])
  })

  it('rejects anon having EXECUTE even when service_role and authenticated are correct', () => {
    const problems = checkRtadContract(row({ anonExec: 'true' }), HASH)
    expect(problems).toEqual(['anon unexpectedly has EXECUTE'])
  })

  it('rejects authenticated having EXECUTE even when service_role and anon are correct', () => {
    const problems = checkRtadContract(row({ authExec: 'true' }), HASH)
    expect(problems).toEqual(['authenticated unexpectedly has EXECUTE'])
  })

  it('reports every ACL violation at once when all three are wrong, alongside a body-hash mismatch', () => {
    const problems = checkRtadContract(row({ hash: 'deadbeef', svcExec: 'false', anonExec: 'true', authExec: 'true' }), HASH)
    expect(problems).toEqual([
      `body_hash=deadbeef (expected ${HASH})`,
      'service_role is missing EXECUTE',
      'anon unexpectedly has EXECUTE',
      'authenticated unexpectedly has EXECUTE',
    ])
  })
})

describe('checkRtadContract -- non-ACL fields (unchanged by the 2026-09-28 fix, still exercised for regression safety)', () => {
  it('rejects a body-hash mismatch', () => {
    expect(checkRtadContract(row({ hash: 'stalehash' }), HASH)).toEqual([`body_hash=stalehash (expected ${HASH})`])
  })
  it('rejects a non-postgres owner', () => {
    expect(checkRtadContract(row({ owner: 'someone_else' }), HASH)).toEqual(['owner=someone_else (expected postgres)'])
  })
  it('rejects a non-volatile function', () => {
    expect(checkRtadContract(row({ volatility: 's' }), HASH)).toEqual(['volatility=s (expected v)'])
  })
  it('rejects an unexpected search_path', () => {
    const problems = checkRtadContract(row({ searchPath: 'search_path=public' }), HASH)
    expect(problems).toEqual(['search_path="search_path=public" (expected "search_path=public, pg_temp")'])
  })
})
