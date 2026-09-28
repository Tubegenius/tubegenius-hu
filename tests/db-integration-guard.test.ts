// DB-free unit test for tests/lib/db-integration-guard.ts -- proves the
// target-protection gate itself, WITHOUT touching Docker, a database, or any
// state-mutating test module. Deliberately does NOT import
// semantic-topic-canonical-input-timestamp-v2-db-integration.test.ts (or any
// other *-db-integration.test.ts file) -- those attempt a real Docker
// connection at module scope, which is exactly what this file must never do.
import { describe, expect, it } from 'vitest'
import { isStatefulDbRequired, resolveStatefulDbTarget, STATEFUL_DB_CONFIRM_TOKEN, type StatefulDbTargetEnv } from './lib/db-integration-guard'

describe('resolveStatefulDbTarget -- state-mutating DB-integration target/permission gate', () => {
  it('normal dev environment (no env vars at all): not allowed, zero container named, no Docker/DB call implied', () => {
    const result = resolveStatefulDbTarget({})
    expect(result.allowed).toBe(false)
    expect(result.container).toBeUndefined()
    expect(result.reason).toMatch(/PFM_STATEFUL_DB_TARGET is not set/)
  })

  it('target set but confirmation missing: not allowed', () => {
    const env: StatefulDbTargetEnv = { PFM_STATEFUL_DB_TARGET: 'some_disposable_pg_container' }
    const result = resolveStatefulDbTarget(env)
    expect(result.allowed).toBe(false)
    expect(result.container).toBe('some_disposable_pg_container')
    expect(result.reason).toMatch(/PFM_STATEFUL_DB_CONFIRM is not set/)
  })

  it('target set, confirmation present but wrong (a plausible-looking but incorrect value): not allowed -- no truthy-string bypass', () => {
    // Case-sensitive, exact-content match -- only leading/trailing
    // whitespace around an otherwise-correct token is intentionally
    // tolerated (see the dedicated "surrounding whitespace" test below).
    for (const wrongConfirm of ['1', 'true', 'yes', 'YES-MUTATE-DISPOSABLE-TARGET', 'yes-mutate-disposable-targe', 'yes-mutate-disposable-target-extra']) {
      const result = resolveStatefulDbTarget({ PFM_STATEFUL_DB_TARGET: 'x', PFM_STATEFUL_DB_CONFIRM: wrongConfirm })
      expect(result.allowed, `confirm=${JSON.stringify(wrongConfirm)}`).toBe(false)
    }
  })

  it('surrounding whitespace around an otherwise-correct confirmation token is tolerated (trimmed before comparison)', () => {
    const result = resolveStatefulDbTarget({ PFM_STATEFUL_DB_TARGET: 'x', PFM_STATEFUL_DB_CONFIRM: `  ${STATEFUL_DB_CONFIRM_TOKEN}  ` })
    expect(result.allowed).toBe(true)
  })

  it('confirmation set but target missing: not allowed, target-missing reason wins (checked first)', () => {
    const result = resolveStatefulDbTarget({ PFM_STATEFUL_DB_CONFIRM: STATEFUL_DB_CONFIRM_TOKEN })
    expect(result.allowed).toBe(false)
    expect(result.container).toBeUndefined()
    expect(result.reason).toMatch(/PFM_STATEFUL_DB_TARGET is not set/)
  })

  it('both target and the EXACT confirmation token present: allowed, container echoed back verbatim', () => {
    const result = resolveStatefulDbTarget({
      PFM_STATEFUL_DB_TARGET: 'ci_disposable_pg_36348437820',
      PFM_STATEFUL_DB_CONFIRM: STATEFUL_DB_CONFIRM_TOKEN,
    })
    expect(result.allowed).toBe(true)
    expect(result.container).toBe('ci_disposable_pg_36348437820')
  })

  it('an empty-string target (env var present but blank, e.g. an unset CI secret) is treated as not set', () => {
    const result = resolveStatefulDbTarget({ PFM_STATEFUL_DB_TARGET: '', PFM_STATEFUL_DB_CONFIRM: STATEFUL_DB_CONFIRM_TOKEN })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/PFM_STATEFUL_DB_TARGET is not set/)
  })

  it('whitespace-only target/confirm values are treated as not set (trimmed before comparison)', () => {
    const result = resolveStatefulDbTarget({ PFM_STATEFUL_DB_TARGET: '   ', PFM_STATEFUL_DB_CONFIRM: STATEFUL_DB_CONFIRM_TOKEN })
    expect(result.allowed).toBe(false)
  })

  it('defaults to reading real process.env when no override is passed (the actual call sites use this)', () => {
    // Only asserts the function does not throw and returns a well-formed
    // result shape when reading the real environment -- does not assert a
    // specific allowed/denied value, since that legitimately depends on
    // whatever this process's own env happens to hold.
    const result = resolveStatefulDbTarget()
    expect(typeof result.allowed).toBe('boolean')
    expect(typeof result.reason).toBe('string')
  })

  it('the known long-lived local dev stack name is refused EVEN WITH the exact correct confirmation token -- no override exists', () => {
    const result = resolveStatefulDbTarget({
      PFM_STATEFUL_DB_TARGET: 'supabase_db_WillViralFinal',
      PFM_STATEFUL_DB_CONFIRM: STATEFUL_DB_CONFIRM_TOKEN,
    })
    expect(result.allowed).toBe(false)
    expect(result.container).toBe('supabase_db_WillViralFinal')
    expect(result.reason).toMatch(/known long-lived local dev stack/)
  })

  it('the denylist check happens before the confirmation check -- a wrong OR missing token on the denylisted name still reports the denylist reason, not a token reason', () => {
    for (const confirm of [undefined, 'wrong', STATEFUL_DB_CONFIRM_TOKEN]) {
      const result = resolveStatefulDbTarget({ PFM_STATEFUL_DB_TARGET: 'supabase_db_WillViralFinal', PFM_STATEFUL_DB_CONFIRM: confirm })
      expect(result.allowed, `confirm=${JSON.stringify(confirm)}`).toBe(false)
      expect(result.reason, `confirm=${JSON.stringify(confirm)}`).toMatch(/known long-lived local dev stack/)
    }
  })

  it('a distinctly-named, CI-run-id-suffixed container is NOT denylisted (only the exact known dev-stack name is)', () => {
    const result = resolveStatefulDbTarget({
      PFM_STATEFUL_DB_TARGET: 'pfm_ci_disposable_076_36348437820',
      PFM_STATEFUL_DB_CONFIRM: STATEFUL_DB_CONFIRM_TOKEN,
    })
    expect(result.allowed).toBe(true)
  })
})

describe('isStatefulDbRequired -- explicit "these tests must actually run" declaration', () => {
  it('absent by default: not required', () => {
    expect(isStatefulDbRequired({})).toBe(false)
  })

  it('only the exact literal "1" counts as required -- no truthy-string bypass', () => {
    for (const value of ['true', 'yes', 'TRUE', ' 1', '1 ', '01', 'on']) {
      expect(isStatefulDbRequired({ PFM_STATEFUL_DB_REQUIRED: value }), `value=${JSON.stringify(value)}`).toBe(false)
    }
    expect(isStatefulDbRequired({ PFM_STATEFUL_DB_REQUIRED: '1' })).toBe(true)
  })
})
