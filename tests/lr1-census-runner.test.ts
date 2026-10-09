// LR-1 census runner + target-identity gate -- DB-free tests.
// No database, no network, no psql process, no child_process import: every
// side effect of the runner is a fake. The two-process claim race and the
// "exact bytes reach psql" proofs live in tests/lr1-census-process.test.ts
// (they start only local Node stand-ins, never a database client).
// These tests do NOT prove PostgreSQL behaviour of the census SQL; they prove
// the gate sequence, the output whitelist, the leak guarantees and the textual
// properties of the SQL file.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUCKET_LABELS,
  CENSUS_SEGMENT_HEADERS,
  CENSUS_SQL_RELATIVE_PATH,
  OBSOLETE_CENSUS_SQL_SHA256,
  PHASE_LABEL,
  STATUS_VOCAB,
  SYSTEM_IDENTIFIER_PROBE_SQL,
  TOOL_VOCAB,
  TargetInputError,
  canonicalRoleString,
  canonicalTargetString,
  checkSqlHash,
  recordsAreDistinct,
  redactText,
  roleFingerprint,
  runCensus,
  sha256Hex,
  targetFingerprint,
  validateApprovalRecord,
  validateCensusOutput,
} from '../lib/lr1-census/runner-core'
import type { ApprovalRecord, ClaimResult, ClaimState, ConnectionTarget, Evidence, Phase, PromptField, PsqlResult, RunnerDeps } from '../lib/lr1-census/runner-core'
import { bucketLabel, parseBucketTables, publishedKey } from './support/lr1-census-model'

const ROOT = process.cwd()
const SQL_PATH = path.join(ROOT, CENSUS_SQL_RELATIVE_PATH)
const SQL_BYTES = fs.readFileSync(SQL_PATH)
const SQL_TEXT = SQL_BYTES.toString('utf8')
const SQL_SHA = sha256Hex(SQL_BYTES)
const NOW = new Date('2026-10-08T10:00:00.000Z')

// sentinel targets and roles: none of these strings may ever appear in any emitted line, evidence or written claim
const STAGING: ConnectionTarget = { projectRef: 'stgref1234567890abcd', host: 'db.stgref1234567890abcd.sentinel-stg.test', port: '5432', database: 'stgdatabase' }
const PRODUCTION: ConnectionTarget = { projectRef: 'prdref0987654321wxyz', host: 'db.prdref0987654321wxyz.sentinel-prd.test', port: '5432', database: 'prddatabase' }
const STG_ROLE = 'stg_sentinel_role'
const PRD_ROLE = 'prd_sentinel_role'
const OTHER_ROLE = 'other_admin_sentinel_role'
const SYSTEM_ID_FACTOR = sha256Hex('7000000000000000001')
const SENTINELS = [STAGING.projectRef, STAGING.host, STAGING.database, STG_ROLE, PRODUCTION.projectRef, PRODUCTION.host, PRODUCTION.database, PRD_ROLE, OTHER_ROLE]
const SENTINEL_RE = new RegExp(SENTINELS.join('|'))

function makeRecord(over: Partial<ApprovalRecord> & { target?: ConnectionTarget; role?: string } = {}): ApprovalRecord {
  const phase: Phase = over.phase ?? 'staging_dryrun'
  const target = over.target ?? (phase === 'production' ? PRODUCTION : STAGING)
  const role = over.role ?? (phase === 'production' ? PRD_ROLE : STG_ROLE)
  const { target: _t, role: _r, ...rest } = over
  void _t
  void _r
  return {
    phase,
    target_label: PHASE_LABEL[phase],
    target_fingerprint: targetFingerprint(target),
    role_fingerprint: roleFingerprint(role),
    sql_sha256: SQL_SHA,
    approver: 'approver-sentinel',
    expires_at: '2026-10-09T10:00:00.000Z',
    status: 'unused',
    second_factor: { kind: 'system_identifier_sha256', value: SYSTEM_ID_FACTOR },
    ...rest,
  }
}

// a canonical, valid psql --csv output
const GOOD_OUTPUT = [
  'session_guard_status,server_version_num', 'ok,150006',
  'schema_guard_status', 'ok',
  'tool_type,status,n_rows_bucket', 'viral_score,completed,100-499', 'similar_videos,completed,10-49', 'viral_score,failed,<5',
  'tool_type,status,period,n_rows_bucket', 'viral_score,failed,(suppressed),<5',
  'relname,n_tup_ins_bucket,n_tup_upd_bucket,n_tup_del_bucket', 'credit_ledger,1000-9999,100-499,0', 'paid_results,100-499,10-49,<5',
  'stats_reset', '2026-09-01 08:30:00.123456+00',
  'tool_type,n_spends_not_refunded_bucket,n_completed_cost_pos_bucket,n_completed_cost_zero_bucket', 'viral_score,100-499,100-499,<5', '(unmapped),10-49,0,0',
  'n_users_with_mapped_spends_and_no_paid_results_bucket', '<5',
].join('\n') + '\n'

interface Harness {
  deps: RunnerDeps
  calls: string[]
  lines: string[]
  claims: Array<{ state: ClaimState; info: Record<string, string> }>
  claimState: { current: { state: ClaimState } | null }
  psqlBytes: Uint8Array[]
  sqlReads: { count: number }
}

function harness(opts: {
  record?: unknown
  target?: ConnectionTarget
  role?: string
  sqlBytes?: () => Uint8Array
  confirm?: boolean | (() => boolean)
  preloadedClaim?: { state: ClaimState } | null
  claimBehavior?: (state: ClaimState) => ClaimResult | 'throw'
  readClaimThrows?: boolean
  probe?: { ok: true; value: string } | { ok: false }
  psql?: Partial<PsqlResult>
  promptValues?: Partial<Record<PromptField, string>>
} = {}): Harness {
  const calls: string[] = []
  const lines: string[] = []
  const claims: Harness['claims'] = []
  const psqlBytes: Uint8Array[] = []
  const sqlReads = { count: 0 }
  const claimState: Harness['claimState'] = { current: opts.preloadedClaim ?? null }
  const record = opts.record === undefined ? makeRecord() : opts.record
  const target = opts.target ?? STAGING
  const values: Record<PromptField, string> = {
    project_ref: target.projectRef,
    host: target.host,
    port: target.port,
    database: target.database,
    role: opts.role ?? STG_ROLE,
    ...opts.promptValues,
  }
  const deps: RunnerDeps = {
    now: () => NOW,
    readSqlBytes: () => {
      calls.push('readSql')
      sqlReads.count += 1
      return opts.sqlBytes ? opts.sqlBytes() : SQL_BYTES
    },
    readApproval: () => {
      calls.push('readApproval')
      return record
    },
    readClaim: () => {
      calls.push('readClaim')
      if (opts.readClaimThrows) throw new Error('EIO')
      return claimState.current
    },
    claim: (state, info) => {
      calls.push(`claim:${state}`)
      const behavior = opts.claimBehavior?.(state)
      if (behavior === 'throw') throw new Error('claim exploded')
      if (behavior) return behavior
      if (claimState.current) return { ok: false, reason: 'exists' }
      claimState.current = { state }
      claims.push({ state, info })
      return { ok: true }
    },
    promptHidden: async (field) => {
      calls.push(`prompt:${field}`)
      return values[field]
    },
    confirmExecute: async () => {
      calls.push('confirm')
      return typeof opts.confirm === 'function' ? opts.confirm() : (opts.confirm ?? true)
    },
    probeSecondFactor: async () => {
      calls.push('probe')
      return opts.probe ?? { ok: true, value: SYSTEM_ID_FACTOR }
    },
    runPsql: async (_target, _role, bytes) => {
      calls.push('psql')
      psqlBytes.push(bytes)
      return { exitCode: 0, stdout: GOOD_OUTPUT, stderr: '', timedOut: false, ...opts.psql }
    },
    emit: (line) => lines.push(line),
  }
  return { deps, calls, lines, claims, claimState, psqlBytes, sqlReads }
}

const connected = (calls: string[]) => calls.includes('probe') || calls.includes('psql')
const visible = (h: Harness, ev: Evidence) => [...h.lines, JSON.stringify(ev), JSON.stringify(h.claims)].join('\n')
const PROMPTS = ['prompt:project_ref', 'prompt:host', 'prompt:port', 'prompt:database', 'prompt:role']

describe('target fingerprint', () => {
  it('canonical string is v1|ref|host|port|database, normalized', () => {
    expect(canonicalTargetString({ projectRef: ' ABC ', host: 'Db.Example.TEST.', port: '', database: 'Postgres' })).toBe('v1|abc|db.example.test|5432|Postgres')
  })
  it('is deterministic and a 64-char hex', () => {
    expect(targetFingerprint(STAGING)).toMatch(/^[0-9a-f]{64}$/)
    expect(targetFingerprint(STAGING)).toBe(targetFingerprint({ ...STAGING, host: STAGING.host.toUpperCase() }))
  })
  it.each(['projectRef', 'host', 'port', 'database'] as const)('changes when the %s component changes', (field) => {
    const changed = { ...STAGING, [field]: field === 'port' ? '6543' : `${STAGING[field]}x` }
    expect(targetFingerprint(changed)).not.toBe(targetFingerprint(STAGING))
  })
  it('staging and production fingerprints differ, and the role is not part of the target fingerprint', () => {
    expect(targetFingerprint(STAGING)).not.toBe(targetFingerprint(PRODUCTION))
    expect(canonicalTargetString(STAGING)).not.toContain(STG_ROLE)
  })
  it.each([
    ['empty ref', { ...STAGING, projectRef: '  ' }],
    ['pipe in host', { ...STAGING, host: 'a|b' }],
    ['space in database', { ...STAGING, database: 'a b' }],
    ['non numeric port', { ...STAGING, port: '54x2' }],
    ['control char', { ...STAGING, host: 'a\u0007b' }],
  ])('rejects invalid input: %s', (_name, bad) => {
    expect(() => canonicalTargetString(bad)).toThrow(TargetInputError)
  })
})

describe('role fingerprint (the approved admin read is bound to its executing role)', () => {
  it('is deterministic, exact (case-sensitive) and differs per role', () => {
    expect(canonicalRoleString(' admin ')).toBe('v1|role|admin')
    expect(roleFingerprint(STG_ROLE)).toMatch(/^[0-9a-f]{64}$/)
    expect(roleFingerprint(STG_ROLE)).toBe(roleFingerprint(` ${STG_ROLE} `))
    expect(roleFingerprint(STG_ROLE)).not.toBe(roleFingerprint(STG_ROLE.toUpperCase()))
    expect(roleFingerprint(STG_ROLE)).not.toBe(roleFingerprint(OTHER_ROLE))
  })
  it('is not derived from the target and does not equal a target fingerprint', () => {
    expect(roleFingerprint('db')).not.toBe(targetFingerprint({ projectRef: 'a', host: 'b', port: '5432', database: 'db' }))
  })
  it.each(['', '   ', 'a|b', 'a b', 'a\u0007b'])('rejects an invalid role %j', (bad) => {
    expect(() => roleFingerprint(bad)).toThrow(TargetInputError)
  })
})

describe('approval record validation', () => {
  const ok = (r: unknown) => validateApprovalRecord(r, NOW)
  it('accepts a valid staging and a valid production record', () => {
    expect(ok(makeRecord()).ok).toBe(true)
    expect(ok(makeRecord({ phase: 'production' })).ok).toBe(true)
  })
  it.each([
    ['not an object', 'x', 'approval_invalid'],
    ['null', null, 'approval_invalid'],
    ['bad phase', { ...makeRecord(), phase: 'prod' }, 'approval_phase_invalid'],
    ['label does not match the phase', { ...makeRecord(), target_label: 'production' }, 'approval_label_phase_mismatch'],
    ['sql hash malformed', { ...makeRecord(), sql_sha256: 'abc' }, 'approval_sql_hash_malformed'],
    ['fingerprint malformed', { ...makeRecord(), target_fingerprint: 'ZZ'.repeat(32) }, 'approval_fingerprint_malformed'],
    ['role fingerprint missing', { ...makeRecord(), role_fingerprint: undefined }, 'approval_role_fingerprint_malformed'],
    ['role fingerprint malformed', { ...makeRecord(), role_fingerprint: 'abc' }, 'approval_role_fingerprint_malformed'],
    ['no approver', { ...makeRecord(), approver: ' ' }, 'approval_invalid'],
    ['bad expiry', { ...makeRecord(), expires_at: 'tomorrow' }, 'approval_invalid'],
    ['expired', { ...makeRecord(), expires_at: '2026-10-08T09:59:59.000Z' }, 'approval_expired'],
    ['expires exactly now', { ...makeRecord(), expires_at: NOW.toISOString() }, 'approval_expired'],
    ['status used in the file', { ...makeRecord(), status: 'used' }, 'approval_already_used'],
    ['status burned in the file', { ...makeRecord(), status: 'burned' }, 'approval_burned'],
    ['unknown status', { ...makeRecord(), status: 'unusedish' }, 'approval_invalid'],
    ['no second factor', { ...makeRecord(), second_factor: undefined }, 'approval_second_factor_invalid'],
    ['system factor with a short value', { ...makeRecord(), second_factor: { kind: 'system_identifier_sha256', value: 'abc' } }, 'approval_second_factor_invalid'],
    ['human factor without a confirmer', { ...makeRecord(), second_factor: { kind: 'human_dashboard_confirmation', confirmed_by: '', confirmed_at: '2026-10-08T09:00:00.000Z' } }, 'approval_second_factor_invalid'],
    ['unknown factor kind', { ...makeRecord(), second_factor: { kind: 'telepathy' } }, 'approval_second_factor_invalid'],
  ])('rejects: %s', (_name, record, code) => {
    expect(ok(record)).toEqual({ ok: false, code })
  })
  it('accepts a recorded human dashboard confirmation as the second factor', () => {
    expect(ok(makeRecord({ second_factor: { kind: 'human_dashboard_confirmation', confirmed_by: 'someone', confirmed_at: '2026-10-08T09:00:00.000Z' } })).ok).toBe(true)
  })
  it('a staging and a production record are distinct, two records of one phase or one fingerprint are not', () => {
    expect(recordsAreDistinct(makeRecord(), makeRecord({ phase: 'production' }))).toBe(true)
    expect(recordsAreDistinct(makeRecord(), makeRecord())).toBe(false)
    expect(recordsAreDistinct(makeRecord(), makeRecord({ phase: 'production', target: STAGING }))).toBe(false)
  })
})

describe('sql hash check', () => {
  it('ok / obsolete / mismatch', () => {
    expect(checkSqlHash(SQL_SHA, SQL_SHA)).toBe('ok')
    expect(checkSqlHash(sha256Hex('other'), SQL_SHA)).toBe('mismatch')
    for (const old of OBSOLETE_CENSUS_SQL_SHA256) {
      expect(checkSqlHash(old, old)).toBe('obsolete') // even an "approved" obsolete hash is refused
    }
  })
  it('the obsolete set is exactly v1 and v2, and the current file is neither', () => {
    expect([...OBSOLETE_CENSUS_SQL_SHA256].sort()).toEqual([
      '365a14e16170e246d507309fd98ff859a675803a6c7050310d44fb8b33ac16b7',
      '63c822aa3bf7e7fb2ec857927982171e3406207cc6962c69a8afba367f7ce09f',
    ])
    expect(OBSOLETE_CENSUS_SQL_SHA256.has(SQL_SHA)).toBe(false)
  })
})

describe('gate sequence (fakes only: nothing connects)', () => {
  it('happy path: fixed order, role asked BEFORE the claim, claim BEFORE the first connection, evidence carries only labels', async () => {
    const h = harness()
    const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
    expect(ev.status).toBe('ok')
    expect(ev.label).toBe('staging')
    expect(ev.sql_sha256).toBe(SQL_SHA)
    expect(h.calls).toEqual(['readClaim', 'readApproval', 'readSql', ...PROMPTS, 'confirm', 'claim:used', 'probe', 'psql'])
    expect(h.calls.indexOf('prompt:role')).toBeLessThan(h.calls.indexOf('claim:used'))
    expect(h.calls.indexOf('claim:used')).toBeLessThan(h.calls.indexOf('probe'))
    expect(h.lines).toContain('TARGET OK staging')
    expect(h.lines).toContain('ROLE OK')
    expect(h.claimState.current?.state).toBe('used')
    expect(ev.census?.q5).toEqual([['<5']])
    expect(visible(h, ev)).not.toMatch(SENTINEL_RE)
  })

  it('gate-only (execute=false): checks target AND role, but no confirmation, no claim, no probe, no psql', async () => {
    const h = harness()
    const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: false })
    expect(ev.status).toBe('gate_passed_no_run')
    expect(h.calls).toEqual(['readClaim', 'readApproval', 'readSql', ...PROMPTS])
    expect(h.claimState.current).toBeNull()
    expect(h.lines).toContain('ROLE OK')
    expect(h.lines).toContain('GATE_ONLY_COMPLETE')
  })

  describe('the verified bytes are the bytes that run', () => {
    it('the SQL is read exactly once, and psql receives bytes whose hash is the approved one', async () => {
      const h = harness()
      await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(h.sqlReads.count).toBe(1)
      expect(h.psqlBytes).toHaveLength(1)
      expect(sha256Hex(h.psqlBytes[0])).toBe(SQL_SHA)
      expect(Buffer.from(h.psqlBytes[0]).equals(SQL_BYTES)).toBe(true)
    })
    it('a source that changes after the first read cannot change what runs (a second read would show different bytes)', async () => {
      let reads = 0
      const h = harness({ sqlBytes: () => { reads += 1; return reads === 1 ? SQL_BYTES : Buffer.from('DELETE FROM paid_results;') } })
      await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(reads).toBe(1)
      expect(sha256Hex(h.psqlBytes[0])).toBe(SQL_SHA)
    })
    it('mutating the array the reader returned, AFTER the hash check, does not change what psql receives (the runner keeps its own copy)', async () => {
      const shared = Buffer.from(SQL_BYTES)
      const h = harness({ sqlBytes: () => shared, confirm: () => { shared.fill(0x58); return true } }) // tampering during the typed confirmation
      const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(ev.status).toBe('ok')
      expect(sha256Hex(h.psqlBytes[0])).toBe(SQL_SHA)
    })
    it('bytes that do not match the approval never reach psql', async () => {
      const h = harness({ sqlBytes: () => Buffer.from(`${SQL_TEXT}\n-- tampered`) })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'sql_hash_mismatch' })
      expect(h.psqlBytes).toHaveLength(0)
    })
  })

  it('an SQL hash mismatch aborts before any prompt, connection or claim', async () => {
    const h = harness({ sqlBytes: () => Buffer.from(`${SQL_TEXT}\n-- tampered`) })
    const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
    expect(ev).toMatchObject({ status: 'aborted', code: 'sql_hash_mismatch' })
    expect(h.calls).toEqual(['readClaim', 'readApproval', 'readSql'])
    expect(h.claimState.current).toBeNull()
  })

  it.each([...OBSOLETE_CENSUS_SQL_SHA256])('an obsolete SQL hash (%s) is refused even when the approval itself names it', async (obsolete) => {
    for (const approved of [obsolete, SQL_SHA]) {
      const h = harness({ record: makeRecord({ sql_sha256: approved }) })
      h.deps.hashBytes = () => obsolete
      const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(ev).toMatchObject({ status: 'aborted', code: 'sql_hash_obsolete' })
      expect(h.calls).toEqual(['readClaim', 'readApproval', 'readSql'])
    }
  })

  it.each([
    ['phase mismatch', makeRecord(), 'production' as Phase, 'phase_mismatch'],
    ['expired', makeRecord({ expires_at: '2026-10-08T09:00:00.000Z' }), 'staging_dryrun' as Phase, 'approval_expired'],
    ['status used in the file', makeRecord({ status: 'used' }), 'staging_dryrun' as Phase, 'approval_already_used'],
  ])('%s: aborts before reading the SQL or prompting for the target', async (_name, record, phase, code) => {
    const h = harness({ record })
    const ev = await runCensus(h.deps, { phase, execute: true })
    expect(ev).toMatchObject({ status: 'aborted', code })
    expect(h.calls.some((c) => c.startsWith('prompt:') || c === 'readSql' || c === 'psql' || c === 'probe' || c.startsWith('claim:'))).toBe(false)
  })

  describe('the exclusive claim is the single-use state', () => {
    it.each([
      ['used', 'approval_already_used'],
      ['burned', 'approval_burned'],
    ] as const)('an existing %s claim stops everything before the approval is even read', async (state, code) => {
      const h = harness({ preloadedClaim: { state } })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ status: 'aborted', code })
      expect(h.calls).toEqual(['readClaim'])
    })
    it('an unreadable claim state aborts (fail closed)', async () => {
      const h = harness({ readClaimThrows: true })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'claim_state_unreadable' })
      expect(h.calls).toEqual(['readClaim'])
    })
    it('losing the race for the claim stops before the second factor and before any connection', async () => {
      // both runners passed every gate and read "unused"; the other one created the claim first
      const h = harness({ claimBehavior: () => ({ ok: false, reason: 'exists' }) })
      const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(ev).toMatchObject({ status: 'aborted', code: 'approval_claim_lost' })
      expect(connected(h.calls)).toBe(false)
      expect(h.psqlBytes).toHaveLength(0)
    })
    it('a claim that cannot be made (io error) stops before any connection', async () => {
      const h = harness({ claimBehavior: () => ({ ok: false, reason: 'io_error' }) })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'approval_claim_failed' })
      expect(connected(h.calls)).toBe(false)
    })
    it('a claim function that throws is an io error, not a pass', async () => {
      const h = harness({ claimBehavior: () => 'throw' })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'approval_claim_failed' })
      expect(connected(h.calls)).toBe(false)
    })
    it('a second run with the same approval is refused after a successful first run', async () => {
      const first = harness()
      await runCensus(first.deps, { phase: 'staging_dryrun', execute: true })
      const second = harness({ preloadedClaim: first.claimState.current })
      expect(await runCensus(second.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'approval_already_used' })
      expect(connected(second.calls)).toBe(false)
    })
  })

  describe('a wrong target or a wrong role burns the approval -- and a burn that fails is its own loud failure', () => {
    it('a wrong target prints only TARGET MISMATCH, never connects, never confirms, and BURNS the approval', async () => {
      const h = harness({ target: PRODUCTION }) // staging approval, production target typed
      const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(ev).toMatchObject({ status: 'aborted', code: 'target_mismatch' })
      expect(h.lines).toContain('TARGET MISMATCH')
      expect(h.lines.some((l) => l.startsWith('TARGET OK'))).toBe(false)
      expect(connected(h.calls)).toBe(false)
      expect(h.calls).not.toContain('confirm')
      expect(h.calls.filter((c) => c.startsWith('claim:'))).toEqual(['claim:burned'])
      expect(h.claims[0].info.reason).toBe('target_mismatch')
      expect(visible(h, ev)).not.toMatch(SENTINEL_RE)
      // the burned approval cannot be tried again, not even with the right target
      const again = harness({ preloadedClaim: h.claimState.current, target: STAGING })
      expect(await runCensus(again.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'approval_burned' })
      expect(again.calls).toEqual(['readClaim'])
    })

    it('a wrong ROLE with the right target also burns, before the approval is consumed, and never connects', async () => {
      const h = harness({ role: OTHER_ROLE })
      const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(ev).toMatchObject({ status: 'aborted', code: 'role_mismatch' })
      expect(h.lines).toContain('ROLE MISMATCH')
      expect(h.lines).not.toContain('ROLE OK')
      expect(h.calls.filter((c) => c.startsWith('claim:'))).toEqual(['claim:burned'])
      expect(h.claims[0].info.reason).toBe('role_mismatch')
      expect(h.calls).not.toContain('confirm')
      expect(connected(h.calls)).toBe(false)
      expect(visible(h, ev)).not.toMatch(SENTINEL_RE)
    })

    it('a wrong role is caught in gate-only mode too', async () => {
      const h = harness({ role: OTHER_ROLE })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: false })).toMatchObject({ code: 'role_mismatch' })
      expect(h.claimState.current?.state).toBe('burned')
    })

    it('when both are wrong the failure is reported as the target mismatch', async () => {
      const h = harness({ target: PRODUCTION, role: OTHER_ROLE })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'target_mismatch' })
    })

    it('BURN FAILED: if the burn cannot be recorded, that is a distinct failure with a loud line (the approval may still be unused)', async () => {
      const h = harness({ target: PRODUCTION, claimBehavior: () => ({ ok: false, reason: 'io_error' }) })
      const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(ev).toMatchObject({ status: 'aborted', code: 'burn_failed' })
      expect(h.lines.some((l) => l.includes('BURN FAILED') && l.includes('revoke the approval'))).toBe(true)
      expect(h.claimState.current).toBeNull() // the state really is "may still be unused": the runner says so instead of pretending
      expect(connected(h.calls)).toBe(false)
      expect(h.calls).not.toContain('confirm')
      expect(visible(h, ev)).not.toMatch(SENTINEL_RE)
    })

    it('BURN FAILED also when the claim function throws', async () => {
      const h = harness({ role: OTHER_ROLE, claimBehavior: () => 'throw' })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'burn_failed' })
    })

    it('if the approval was already claimed by someone else when the burn is attempted, it is a plain mismatch (nothing is lost)', async () => {
      const h = harness({ target: PRODUCTION, claimBehavior: () => ({ ok: false, reason: 'exists' }) })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'target_mismatch' })
    })

    it('a production approval is not satisfied by the staging target (and vice versa)', async () => {
      const h = harness({ record: makeRecord({ phase: 'production' }), target: STAGING, role: PRD_ROLE })
      expect(await runCensus(h.deps, { phase: 'production', execute: true })).toMatchObject({ code: 'target_mismatch' })
      const h2 = harness({ record: makeRecord(), target: PRODUCTION })
      expect(await runCensus(h2.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'target_mismatch' })
    })
  })

  it('a staging approval cannot be used with phase=production even with the right staging target', async () => {
    const h = harness()
    expect(await runCensus(h.deps, { phase: 'production', execute: true })).toMatchObject({ code: 'phase_mismatch' })
    expect(h.calls.some((c) => c.startsWith('prompt:'))).toBe(false)
  })

  it('invalid target or role input aborts without a connection and without burning', async () => {
    for (const promptValues of [{ host: 'bad host' }, { role: 'bad role' }] as const) {
      const h = harness({ promptValues })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'target_input_invalid' })
      expect(connected(h.calls)).toBe(false)
      expect(h.calls.filter((c) => c.startsWith('claim:'))).toEqual([])
    }
  })

  it('an empty port prompt means 5432 (same fingerprint)', async () => {
    const h = harness({ promptValues: { port: '' } })
    expect((await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).status).toBe('ok')
  })

  it('the operator can decline: nothing is claimed and nothing connects', async () => {
    const h = harness({ confirm: false })
    expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'operator_declined' })
    expect(h.calls.some((c) => c.startsWith('claim:'))).toBe(false)
    expect(connected(h.calls)).toBe(false)
    expect(h.claimState.current).toBeNull()
  })

  describe('second factor', () => {
    it('a matching system identifier fingerprint passes', async () => {
      const h = harness({ probe: { ok: true, value: SYSTEM_ID_FACTOR } })
      expect((await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).status).toBe('ok')
      expect(h.lines).toContain('SECOND_FACTOR system_identifier_ok')
    })
    it('a mismatching fingerprint aborts before the census and the probe value is never printed', async () => {
      const other = sha256Hex('another cluster')
      const h = harness({ probe: { ok: true, value: other } })
      const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(ev).toMatchObject({ code: 'second_factor_mismatch' })
      expect(h.calls).not.toContain('psql')
      const printed = [...h.lines, JSON.stringify(ev)].join('\n')
      expect(printed).not.toContain(other)
      expect(printed).not.toContain(SYSTEM_ID_FACTOR)
    })
    it('an unavailable probe aborts and is NOT silently downgraded', async () => {
      const h = harness({ probe: { ok: false } })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'second_factor_unavailable' })
      expect(h.calls).not.toContain('psql')
    })
    it('a recorded human confirmation skips the probe but says so explicitly (single technical factor)', async () => {
      const h = harness({ record: makeRecord({ second_factor: { kind: 'human_dashboard_confirmation', confirmed_by: 'someone', confirmed_at: '2026-10-08T09:00:00.000Z' } }) })
      expect((await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).status).toBe('ok')
      expect(h.calls).not.toContain('probe')
      expect(h.lines.some((l) => l.includes('single technical factor'))).toBe(true)
    })
  })

  describe('failed or suspicious runs discard everything', () => {
    it('a non-zero exit discards the output (even if it looks valid), classifies the guard and redacts the error', async () => {
      const h = harness({
        psql: {
          exitCode: 3,
          stdout: GOOD_OUTPUT,
          stderr: `psql: ERROR: lr1_census_guard_failed: schema_guard: expected exactly 10 columns, found 9 at ${STAGING.host} as ${STG_ROLE} db ${STAGING.database}`,
        },
      })
      const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(ev).toMatchObject({ status: 'sql_failed', code: 'psql_nonzero_exit', error_class: 'guard_failed', exit_code: 3, census: null })
      expect(ev.error_summary).toContain('lr1_census_guard_failed')
      expect(visible(h, ev)).not.toMatch(SENTINEL_RE)
      expect(JSON.stringify(ev)).not.toContain('viral_score') // the (valid-looking) stdout was thrown away
    })
    it('a timeout is a failure', async () => {
      const h = harness({ psql: { exitCode: null, timedOut: true, stdout: GOOD_OUTPUT } })
      expect(await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })).toMatchObject({ status: 'sql_failed', code: 'timeout', census: null })
    })
    it.each([
      ['a uuid in the output', GOOD_OUTPUT.replace('credit_ledger,', '0f8fad5b-d9cb-469f-a165-70867728950e,')],
      ['the staging host in the output', `${GOOD_OUTPUT}${STAGING.host}\n`],
      ['the executing role in the output', `${GOOD_OUTPUT}${STG_ROLE}\n`],
      ['an e-mail in the output', `${GOOD_OUTPUT}someone@example.com\n`],
      ['a jwt-like string', `${GOOD_OUTPUT}eyJhbGciOiJIUzI1NiIsInR5cCI6\n`],
      ['an unknown value in a bucket column', GOOD_OUTPUT.replace('100-499,100-499,<5', '100-499,100-499,7')],
      ['an unknown tool_type', GOOD_OUTPUT.replace('similar_videos,completed', 'my_secret_topic,completed')],
    ])('blocks %s and keeps no census', async (_name, stdout) => {
      const h = harness({ psql: { stdout } })
      const ev = await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
      expect(ev.status).toBe('output_blocked')
      expect(ev.census).toBeNull()
      expect(visible(h, ev)).not.toMatch(SENTINEL_RE)
    })
  })

  it('leak sweep: no sentinel appears anywhere on any path', async () => {
    const paths: Array<[string, Harness, Phase]> = [
      ['ok', harness(), 'staging_dryrun'],
      ['production ok', harness({ record: makeRecord({ phase: 'production' }), target: PRODUCTION, role: PRD_ROLE }), 'production'],
      ['target mismatch', harness({ target: PRODUCTION }), 'staging_dryrun'],
      ['role mismatch', harness({ role: OTHER_ROLE }), 'staging_dryrun'],
      ['burn failed', harness({ target: PRODUCTION, claimBehavior: () => ({ ok: false, reason: 'io_error' }) }), 'staging_dryrun'],
      ['sql failed', harness({ psql: { exitCode: 2, stdout: '', stderr: `connection to server at "${STAGING.host}" (${STAGING.projectRef}) failed for ${STG_ROLE}, database ${STAGING.database}` } }), 'staging_dryrun'],
      ['probe mismatch', harness({ probe: { ok: true, value: sha256Hex('x') } }), 'staging_dryrun'],
    ]
    for (const [name, h, phase] of paths) {
      const ev = await runCensus(h.deps, { phase, execute: true })
      expect(visible(h, ev), name).not.toMatch(SENTINEL_RE)
    }
  })

  it('prompts are asked in the fixed order, all of them before the confirmation and the claim', async () => {
    const h = harness()
    await runCensus(h.deps, { phase: 'staging_dryrun', execute: true })
    expect(h.calls.filter((c) => c.startsWith('prompt:'))).toEqual(PROMPTS)
    expect(h.calls.indexOf('prompt:role')).toBeLessThan(h.calls.indexOf('confirm'))
  })
})

describe('census output whitelist', () => {
  const secrets = [STAGING.projectRef, STAGING.host, STAGING.database]
  const valid = (s: string) => validateCensusOutput(s, secrets)
  it('accepts the canonical output and CRLF line ends', () => {
    expect(valid(GOOD_OUTPUT).ok).toBe(true)
    expect(valid(GOOD_OUTPUT.replace(/\n/g, '\r\n')).ok).toBe(true)
  })
  it('accepts empty q1..q4 result sets and an empty (NULL) stats_reset row', () => {
    const empty = [
      'session_guard_status,server_version_num', 'ok,150006', 'schema_guard_status', 'ok',
      'tool_type,status,n_rows_bucket', 'tool_type,status,period,n_rows_bucket',
      'relname,n_tup_ins_bucket,n_tup_upd_bucket,n_tup_del_bucket', 'stats_reset', '',
      'tool_type,n_spends_not_refunded_bucket,n_completed_cost_pos_bucket,n_completed_cost_zero_bucket',
      'n_users_with_mapped_spends_and_no_paid_results_bucket', '0',
    ].join('\n')
    const r = valid(empty)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.tables.q3b).toEqual([['']])
  })
  it.each([
    ['empty output', '', 'segment_order'],
    ['a data row before any header', 'ok,150006\n', 'segment_order'],
    ['missing last segment', GOOD_OUTPUT.split('n_users_with')[0], 'segment_order'],
    ['a segment header out of its place (read as a malformed row)', GOOD_OUTPUT.replace('schema_guard_status\nok\n', '').replace('relname', 'schema_guard_status\nok\nrelname'), 'row_shape'],
    ['q5 without its row', GOOD_OUTPUT.replace(/\n<5\n$/, '\n'), 'row_count'],
    ['a row with too many cells', GOOD_OUTPUT.replace('viral_score,failed,<5', 'viral_score,failed,<5,<5'), 'row_shape'],
    ['a quote', GOOD_OUTPUT.replace('viral_score,failed,<5', '"viral_score",failed,<5'), 'unexpected_quote'],
    ['a bucket outside the table', GOOD_OUTPUT.replace('100-499,100-499,<5', '100-499,100-499,3'), 'value_outside_domain'],
    ['a period that is not a quarter start', GOOD_OUTPUT.replace('(suppressed),<5', '2026-05-01,<5'), 'value_outside_domain'],
    ['a status outside the vocabulary', GOOD_OUTPUT.replace('viral_score,failed,<5', 'viral_score,pwned,<5'), 'value_outside_domain'],
    ['a table name outside the two', GOOD_OUTPUT.replace('credit_ledger,', 'other_table,'), 'value_outside_domain'],
    ['a duplicate relname', GOOD_OUTPUT.replace('paid_results,100-499', 'credit_ledger,100-499'), 'duplicate_key'],
    ['a guard status other than ok', GOOD_OUTPUT.replace('ok,150006', 'bad,150006'), 'value_outside_domain'],
  ])('rejects: %s', (_name, output, code) => {
    expect(valid(output)).toEqual({ ok: false, code })
  })
  it('the supplied secrets are blocked wherever they appear', () => {
    expect(valid(`${GOOD_OUTPUT}${STAGING.database}\n`)).toEqual({ ok: false, code: 'secret_in_output' })
  })
  it('the declared segment headers are exactly the census output shapes', () => {
    expect(CENSUS_SEGMENT_HEADERS.map((s) => s.name)).toEqual(['session_guard', 'schema_guard', 'q1', 'q2', 'q3', 'q3b', 'q4', 'q5'])
  })
})

describe('redaction', () => {
  it('removes the secrets and the generic patterns and truncates', () => {
    const text = `FATAL: password authentication failed for user "${STG_ROLE}" at ${STAGING.host} (0f8fad5b-d9cb-469f-a165-70867728950e) a@b.co postgres://x:y@h/db`
    const out = redactText(text, [STG_ROLE, STAGING.host])
    expect(out).not.toMatch(new RegExp(`${STG_ROLE}|${STAGING.host}|0f8fad5b|a@b\\.co|postgres://`))
    expect(out).toContain('<redacted>')
    expect(redactText('x'.repeat(1000), []).length).toBeLessThanOrEqual(303)
  })
  it('ignores secrets shorter than three characters (no over-redaction of digits)', () => {
    expect(redactText('port 5432 failed', ['54'])).toBe('port 5432 failed')
  })
})

describe('the SQL file (textual properties; PostgreSQL behaviour is NOT tested here)', () => {
  const statements = SQL_TEXT.split('\n')
  const code = statements.filter((l) => !l.trim().startsWith('--')).join('\n')

  it('its sha256 is recorded in the plan document, and the obsolete hashes are marked obsolete', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'operations', 'paid-operations-d1-d2-state-model.md'), 'utf8')
    expect(doc).toContain(SQL_SHA)
    expect(code.length).toBeGreaterThan(1000)
    expect(SQL_BYTES.includes(0x0d)).toBe(false) // LF only
    expect(/^[\x00-\x7f]*$/.test(SQL_TEXT)).toBe(true) // ASCII only
  })
  it('starts with a read-only repeatable-read transaction and ends with ROLLBACK', () => {
    const stmts = code.split(';').map((s) => s.trim()).filter(Boolean)
    expect(stmts[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(stmts[stmts.length - 1]).toBe('ROLLBACK')
    expect(code).not.toMatch(/\bCOMMIT\b/i)
  })
  it('contains no write, DDL or locking statement', () => {
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|ANALYZE|REINDEX|LOCK|CALL)\b/i)
    expect(code).not.toMatch(/FOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)/i)
    expect(code).not.toMatch(/SELECT\s+\*/i)
    expect(code).not.toMatch(/\bpg_(sleep|advisory|terminate|cancel)/i)
  })
  it('Q0 and Q0b are real gates: DO blocks that RAISE EXCEPTION, exactly 10 columns, BASE TABLE', () => {
    const doBlocks = [...code.matchAll(/DO \$guard\$([\s\S]*?)\$guard\$;/g)].map((m) => m[1])
    expect(doBlocks).toHaveLength(2)
    expect(doBlocks[0]).toContain("current_setting('transaction_read_only') <> 'on'")
    expect(doBlocks[0]).toContain("current_setting('transaction_isolation') <> 'repeatable read'")
    expect(doBlocks[0].match(/RAISE EXCEPTION/g)).toHaveLength(2)
    expect(doBlocks[1]).toContain('IF found_columns <> 10 THEN')
    expect(doBlocks[1]).toContain('RAISE EXCEPTION')
    expect(doBlocks[1]).toContain("t.table_type = 'BASE TABLE'")
    for (const b of doBlocks) expect(b).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXECUTE|PERFORM)\b/i)
    // the gates come before every census query
    expect(code.indexOf('$guard$')).toBeLessThan(code.indexOf('FROM public.paid_results'))
    expect(code.lastIndexOf('$guard$')).toBeLessThan(code.indexOf('WITH bucket'))
    // the 10 expected columns are exactly the ones the queries use
    const guard = doBlocks[1]
    const listed = [...guard.matchAll(/IN \(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
    expect(listed.sort()).toEqual(['credit_cost', 'id', 'metadata', 'reason', 'related_transaction_id', 'status', 'tool_type', 'updated_at', 'user_id', 'user_id'].sort())
  })
  it('each OUTPUT: line equals the declared segment header, in order (shape is declared once, in two places)', () => {
    const outputs = [...SQL_TEXT.matchAll(/^-- OUTPUT: (.+)$/gm)].map((m) => m[1].split(',').map((c) => c.trim()))
    expect(outputs).toEqual(CENSUS_SEGMENT_HEADERS.map((s) => [...s.header]))
  })
  it('no identifier or raw text column is ever an output column', () => {
    const outputs = [...SQL_TEXT.matchAll(/^-- OUTPUT: (.+)$/gm)].flatMap((m) => m[1].split(',').map((c) => c.trim()))
    for (const forbidden of ['id', 'user_id', 'input_hash', 'normalized_input', 'original_input', 'result_json', 'summary_json', 'source_run_id', 'external_ref', 'metadata', 'related_transaction_id']) {
      expect(outputs).not.toContain(forbidden)
    }
    // no exact count column: every numeric-looking output is a bucket or the Q0 version number
    for (const column of outputs) expect(column).not.toMatch(/^(n_rows|n_spends|n_completed|n_users|n_live_tup|n_dead_tup|n_tup_(ins|upd|del)|indicative_gap|total|count)$/)
  })
  it('raw tool_type / status columns appear only in JOIN, WHERE, FILTER or IS NULL positions, never as an output expression', () => {
    for (const line of statements.filter((l) => !l.trim().startsWith('--') && /\bp\.(tool_type|status)\b/.test(l))) {
      expect(line, line).toMatch(/JOIN|WHERE|FILTER|IS NULL/)
    }
    for (const line of statements.filter((l) => /\bSELECT\b.*\bp\.(tool_type|status)\b/.test(l))) {
      expect(line, line).toMatch(/IS NULL/)
    }
  })
  it('credit_ledger.metadata is read only as metadata->>\'feature\'', () => {
    const uses = [...code.matchAll(/\bmetadata\b/g)].length
    const safe = [...code.matchAll(/metadata->>'feature'/g)].length
    expect(uses).toBe(safe + 1) // +1: the schema guard column list
  })
  it('the vocabulary tables equal the migration CHECK lists (drift fails the test and needs a new hash)', () => {
    const tool026 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '026_paid_results_opportunity_channel_audit.sql'), 'utf8')
    const checkList = tool026.slice(tool026.indexOf('CHECK (tool_type IN ('))
    const migrationTools = [...checkList.slice(0, checkList.indexOf('));')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    const status019 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '019_paid_results.sql'), 'utf8')
    const statusMatch = /status\s+TEXT DEFAULT 'completed' CHECK \(status IN \(([^)]*)\)\)/.exec(status019)
    const migrationStatuses = [...(statusMatch?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(migrationTools).toHaveLength(17)
    expect(migrationStatuses).toEqual(['completed', 'failed', 'refreshed', 'archived'])
    expect([...TOOL_VOCAB]).toEqual(migrationTools)
    expect([...STATUS_VOCAB]).toEqual(migrationStatuses)
    const sqlToolLists = [...SQL_TEXT.matchAll(/tool_vocab\(value\) AS \(\s*VALUES([\s\S]*?)\n\)/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]))
    expect(sqlToolLists).toHaveLength(3) // Q1, Q2, Q4
    for (const list of sqlToolLists) expect(list).toEqual(migrationTools)
    const sqlStatusLists = [...SQL_TEXT.matchAll(/status_vocab\(value\) AS \(\s*VALUES([\s\S]*?)\n\)/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]))
    expect(sqlStatusLists).toHaveLength(2) // Q1, Q2
    for (const list of sqlStatusLists) expect(list).toEqual(migrationStatuses)
  })
  it('the bucket table is identical in every query, contiguous, covers [0, max] and matches the runner whitelist', () => {
    const tables = parseBucketTables(SQL_TEXT)
    expect(tables).toHaveLength(5)
    for (const t of tables) expect(t).toEqual(tables[0])
    const t = tables[0]
    expect(t[0].lo).toBe(BigInt(0))
    for (let i = 1; i < t.length; i += 1) expect(t[i].lo).toBe(t[i - 1].hi)
    expect(t[t.length - 1].hi).toBe(BigInt('9223372036854775807'))
    expect(t.map((b) => b.label)).toEqual([...BUCKET_LABELS])
    expect(t.find((b) => b.label === '0')).toMatchObject({ lo: BigInt(0), hi: BigInt(1) })
    expect(t.find((b) => b.label === '<5')).toMatchObject({ lo: BigInt(1), hi: BigInt(5) })
  })
  it('Q2 merges every cell below 5 into one (suppressed) period and uses a UTC quarter', () => {
    expect(SQL_TEXT).toContain("CASE WHEN n < 5 THEN NULL::date ELSE quarter_utc END")
    expect(SQL_TEXT).toContain("'(suppressed)'")
    expect(SQL_TEXT).toContain("date_trunc('quarter', p.updated_at AT TIME ZONE 'UTC')")
    expect(SQL_TEXT).not.toMatch(/date_trunc\('(month|week|day|hour)'/)
  })
  it('Q3 prints no live/dead row estimate and Q4 prints no total, refunded count or gap', () => {
    expect(code).not.toMatch(/n_live_tup|n_dead_tup|indicative_gap|\bn_spends\b|\bn_completed\b/)
  })
})

describe('small-cell differencing (model of Q1 + Q2, tied to the SQL by its bucket table)', () => {
  const table = parseBucketTables(SQL_TEXT)[0]
  const QUARTERS = 3
  const MAX_CELL = 12
  const datasets: number[][] = []
  const build = (prefix: number[]) => {
    if (prefix.length === QUARTERS) {
      datasets.push(prefix)
      return
    }
    for (let v = 0; v <= MAX_CELL; v += 1) build([...prefix, v])
  }
  build([])
  const classes = (merge: boolean) => {
    const map = new Map<string, number[][]>()
    for (const d of datasets) {
      const key = publishedKey(d, table, merge)
      map.set(key, [...(map.get(key) ?? []), d])
    }
    return map
  }
  const smallSum = (d: number[]) => d.filter((n) => n > 0 && n < 5).reduce((a, b) => a + b, 0)

  it('the model reproduces the bucket labels of the SQL table', () => {
    expect(bucketLabel(0, table)).toBe('0')
    expect(bucketLabel(1, table)).toBe('<5')
    expect(bucketLabel(4, table)).toBe('<5')
    expect(bucketLabel(5, table)).toBe('5-9')
    expect(bucketLabel(10, table)).toBe('10-49')
  })
  it('with the merge, the published output never pins down the number of rows in small cells (every dataset has a consistent twin with another small total)', () => {
    const merged = classes(true)
    let checked = 0
    for (const d of datasets) {
      const s = smallSum(d)
      if (s === 0) continue
      const twins = merged.get(publishedKey(d, table, true)) ?? []
      expect(twins.some((t) => smallSum(t) !== s), JSON.stringify(d)).toBe(true)
      checked += 1
    }
    expect(checked).toBeGreaterThan(1000)
  })
  it('the bucketing alone already hides the exact value of a small cell; the merge additionally hides WHICH quarter holds it', () => {
    for (const v of [1, 2, 3, 4]) {
      expect(publishedKey([v, 0, 0], table, true)).toBe(publishedKey([0, v, 0], table, true))
      expect(publishedKey([v, 0, 0], table, true)).toBe(publishedKey([0, 0, v], table, true))
    }
  })
  it('negative control: WITHOUT the merge the quarter of a small cell is visible (the test has teeth)', () => {
    for (const v of [1, 2, 3, 4]) {
      expect(publishedKey([v, 0, 0], table, false)).not.toBe(publishedKey([0, v, 0], table, false))
    }
    // and without the merge the exact value is still not recoverable: that protection is the bucketing, not the merge
    const unmerged = classes(false)
    for (const d of datasets) {
      if (!d.some((n) => n > 0 && n < 5)) continue
      const twins = unmerged.get(publishedKey(d, table, false)) ?? []
      expect(twins.some((t) => smallSum(t) !== smallSum(d)), JSON.stringify(d)).toBe(true)
    }
  })
  it('a group whose total is below 5 publishes the same output whatever the exact value (1, 2, 3, 4)', () => {
    const keys = [1, 2, 3, 4].map((v) => publishedKey([v, 0, 0], table))
    expect(new Set(keys).size).toBe(1)
    expect(publishedKey([0, 0, 0], table)).not.toBe(keys[0]) // zero stays distinguishable (that is the signal)
  })
})

describe('runner source policy (this test file never starts a process)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const codeOnly = (src: string) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  const core = codeOnly(read('lib/lr1-census/runner-core.ts'))
  const claim = codeOnly(read('lib/lr1-census/approval-claim.ts'))
  const psql = codeOnly(read('lib/lr1-census/psql-process.ts'))
  const cli = codeOnly(read('scripts/lr1-census-runner.ts'))
  const importsOf = (src: string) => [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', '.next', '.git'].includes(e.name) ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []))

  it('the core imports only node:crypto and does no I/O of its own', () => {
    expect(importsOf(core)).toEqual(['node:crypto'])
    expect(core).not.toMatch(/child_process|node:fs|process\.(env|argv|stdin|stdout|stderr)|fetch\(|require\(/)
  })
  it('the claim module imports only node:fs, creates the claim exclusively and never deletes or rewrites anything', () => {
    expect(importsOf(claim)).toEqual(['node:fs'])
    expect(claim).toContain("openSync(claimPath, 'wx'")
    expect(claim).not.toMatch(/unlinkSync|rmSync|renameSync|writeFileSync|appendFileSync|truncateSync|copyFileSync/)
  })
  it('the psql module is the only place that starts a process, sends the census on stdin and never sets PGPASSWORD', () => {
    expect(importsOf(psql).sort()).toEqual([`node:${['child', 'process'].join('_')}`, 'node:os'])
    expect(psql).toContain("'-f', '-'")
    expect(psql).not.toMatch(/PGPASSWORD|process\.env\.PG/)
    expect(psql).toContain('PGPASSFILE: devNull')
    expect(psql).toContain("'-W'")
    expect(psql.match(/spawn\(/g)).toHaveLength(1)
  })
  it('this test file does not import child_process or spawn anything', () => {
    const self = read('tests/lr1-census-runner.test.ts')
    // the module name is assembled so that this very file does not contain the forbidden literal
    const moduleName = ['child', 'process'].join('_')
    expect(self).not.toContain(`'node:${moduleName}'`)
    expect(self).not.toContain(`'${moduleName}'`)
    expect(self).not.toMatch(/\bspawn\(|\bexecSync\(|\bexecFile\(/)
  })
  it('nothing in app/, lib/ (other than the lr1-census modules) or components imports the runner', () => {
    for (const dir of ['app', 'lib', 'components']) {
      if (!fs.existsSync(path.join(ROOT, dir))) continue
      for (const f of walk(path.join(ROOT, dir))) {
        if (f.split(path.sep).join('/').includes('/lib/lr1-census/')) continue
        expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/lr1-census/)
      }
    }
  })
  it('the CLI takes no connection flag, reads no PG* / password environment and never sets PGPASSWORD', () => {
    expect(cli).toMatch(/'--approval'/)
    expect(cli).toMatch(/'--phase'/)
    expect(cli).toMatch(/'--execute'/)
    expect(cli).not.toMatch(/'--(host|port|database|dbname|role|user|password|url|dsn|ref|project)/)
    expect(cli).not.toMatch(/process\.env\.PG[A-Z]*|process\.env\[/)
    expect(cli).not.toMatch(/PGPASSWORD/)
  })
  it('the five connection fields (the role included) come only from hidden prompts, in one fixed place', () => {
    expect(cli).toMatch(/promptHidden: \(field\) => promptHiddenLine\(FIELD_QUESTION\[field\]\)/)
    expect([...cli.matchAll(/FIELD_QUESTION = \{([\s\S]*?)\} as const/g)][0][1].match(/\(hidden/g)).toHaveLength(5)
    expect(cli).toMatch(/new Writable\(\{ write: \(_chunk, _encoding, callback\) => callback\(\) \}\)/) // muted output = no echo
  })
  it('the verified bytes are what runs: the CLI reads the SQL path once and never hands a path to psql', () => {
    expect(cli.match(/readFileSync\(sqlPath\)/g)).toHaveLength(1)
    expect(cli.match(/\bsqlPath\b/g)).toHaveLength(2) // the definition and that one read
    expect(cli).toMatch(/runPsql: \(target, role, sqlBytes\) => psql\.runCensusPsql\(target, role, sqlBytes,/)
    expect(core).toMatch(/Uint8Array\.from\(deps\.readSqlBytes\(\)\)/)
    expect(core.match(/readSqlBytes\(\)/g)).toHaveLength(2) // the interface declaration and the single call
  })
  it('the approval file is never rewritten: the CLI only reads it and claims through the exclusive claim file', () => {
    expect(cli).not.toMatch(/writeFileSync|appendFileSync|renameSync|unlinkSync/)
    expect(cli).toMatch(/claims\.claimExclusive\(claimPath, state, info\)/)
    expect(cli).toMatch(/claims\.readClaimFile\(claimPath\)/)
  })
  it('the only SQL ever sent is the approved file (stdin) and the fixed probe constant (-c)', () => {
    expect(psql.match(/'-c'/g)).toHaveLength(1)
    expect(psql).toMatch(/probePsqlArgs\(probeSql: string\)/)
    expect(cli).toMatch(/psql\.runProbePsql\(target, role, core\.SYSTEM_IDENTIFIER_PROBE_SQL,/)
    expect(SYSTEM_IDENTIFIER_PROBE_SQL).toBe("SELECT encode(sha256(convert_to(system_identifier::text, 'UTF8')), 'hex') AS f FROM pg_control_system()")
    expect(SYSTEM_IDENTIFIER_PROBE_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i)
  })
  it('the CLI maps a failed burn to its own exit code and never sets the hash test seam', () => {
    expect(cli).toMatch(/evidence\.code === 'burn_failed'\) process\.exit\(3\)/)
    expect(cli).not.toMatch(/hashBytes/)
  })
  it('the CLI never prints the target or the role (console calls carry no target / role / host variable)', () => {
    for (const call of cli.match(/console\.(log|error)\([^\n]*\)/g) ?? []) {
      expect(call).not.toMatch(/target|role|host|database|projectRef|password/i)
    }
  })
  it('the gate order in the core: claim state, approval, one SQL read, hash, target + role, fingerprints, confirmation, claim, second factor, psql', () => {
    const body = core.slice(core.indexOf('export async function runCensus'))
    const order = [
      'deps.readClaim()', 'validateApprovalRecord', 'deps.readSqlBytes()', 'checkSqlHash', "promptHidden('project_ref')", "promptHidden('role')",
      'targetFingerprint(target)', 'roleFingerprint(role)', "tryClaim('burned'", 'confirmExecute', "tryClaim('used'", 'probeSecondFactor', 'deps.runPsql(',
    ]
    let last = -1
    for (const marker of order) {
      const at = body.indexOf(marker)
      expect(at, marker).toBeGreaterThan(last)
      last = at
    }
  })
})
