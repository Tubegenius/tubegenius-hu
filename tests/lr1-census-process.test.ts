// LR-1 census runner -- process-level proofs, still with NO database and NO psql.
// The only processes started here are this machine's own Node binary running
// tiny stand-in scripts written into a temp directory. They prove:
//   * two runners racing for one approval: exactly one wins (the exclusive claim),
//     and the old read -> check -> write handling really does let both through;
//   * the very bytes that were hashed are the bytes psql receives on stdin, also
//     when the SQL file is tampered with after the hash check;
//   * psql's argv/environment contain exactly what the runner promises.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { claimExclusive, claimPathFor, readClaimFile } from '../lib/lr1-census/approval-claim'
import { CENSUS_PSQL_ARGS, buildChildEnv, probePsqlArgs, runCensusPsql, runProbePsql } from '../lib/lr1-census/psql-process'
import {
  CENSUS_SQL_RELATIVE_PATH,
  PHASE_LABEL,
  SYSTEM_IDENTIFIER_PROBE_SQL,
  roleFingerprint,
  runCensus,
  sha256Hex,
  targetFingerprint,
} from '../lib/lr1-census/runner-core'
import type { ApprovalRecord, ConnectionTarget, RunnerDeps } from '../lib/lr1-census/runner-core'

const ROOT = process.cwd()
const SQL_BYTES = fs.readFileSync(path.join(ROOT, CENSUS_SQL_RELATIVE_PATH))
const SQL_SHA = sha256Hex(SQL_BYTES)
const CLAIM_MODULE = path.join(ROOT, 'lib', 'lr1-census', 'approval-claim.ts')
const TARGET: ConnectionTarget = { projectRef: 'procref1234567890abcd', host: 'db.procref1234567890abcd.sentinel-proc.test', port: '5432', database: 'procdatabase' }
const ROLE = 'proc_sentinel_role'
const SECOND = sha256Hex('proc-system-identifier')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1-census-process-'))
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))
let counter = 0
const freshDir = () => {
  counter += 1
  const dir = path.join(tmpRoot, `case-${counter}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const CLAIM_CHILD = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [modulePath, claimPath, approvalPath, goPath, id, mode] = process.argv.slice(2)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const mod = await import(pathToFileURL(modulePath).href)
writeFileSync(goPath + '.ready.' + id, '1')
while (!existsSync(goPath)) sleep(1)
let result
if (mode === 'exclusive') {
  result = mod.claimExclusive(claimPath, 'used', { runner: id })
} else {
  // the OLD handling: read the approval, see "unused", then write "used" -- not an atomic claim
  const record = JSON.parse(readFileSync(approvalPath, 'utf8'))
  if (record.status === 'unused') {
    writeFileSync(goPath + '.read.' + id, '1')
    const other = id === 'A' ? 'B' : 'A'
    const started = Date.now()
    while (!existsSync(goPath + '.read.' + other) && Date.now() - started < 5000) sleep(1)
    writeFileSync(approvalPath, JSON.stringify({ ...record, status: 'used', by: id }))
    result = { ok: true }
  } else {
    result = { ok: false, reason: 'exists' }
  }
}
console.log(JSON.stringify(result))
`

const FAKE_PSQL = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [recordPath, ...psqlArgs] = process.argv.slice(2)
const chunks = []
if (psqlArgs.includes('-f')) {
  for await (const chunk of process.stdin) chunks.push(chunk)
}
const stdin = Buffer.concat(chunks)
writeFileSync(recordPath, JSON.stringify({
  args: psqlArgs,
  envKeys: Object.keys(process.env),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^PG|^PSQLRC$|^LEAK_/.test(k))),
  stdinSha256: createHash('sha256').update(stdin).digest('hex'),
  stdinLength: stdin.length,
}))
const outFile = recordPath + '.out'
if (existsSync(outFile)) process.stdout.write(readFileSync(outFile, 'utf8'))
`

function runChild(script: string, args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    child.on('close', (code) => resolve({ stdout, code }))
  })
}

async function race(mode: 'exclusive' | 'naive'): Promise<Array<{ ok: boolean; reason?: string }>> {
  const dir = freshDir()
  const script = path.join(dir, 'claim-child.mjs')
  fs.writeFileSync(script, CLAIM_CHILD)
  const approvalPath = path.join(dir, 'approval.json')
  fs.writeFileSync(approvalPath, JSON.stringify({ status: 'unused' }))
  const claimPath = claimPathFor(approvalPath)
  const goPath = path.join(dir, 'go')
  const run = (id: string) => runChild(script, [CLAIM_MODULE, claimPath, approvalPath, goPath, id, mode])
  const both = Promise.all([run('A'), run('B')])
  const started = Date.now()
  while (!(fs.existsSync(`${goPath}.ready.A`) && fs.existsSync(`${goPath}.ready.B`))) {
    if (Date.now() - started > 20000) throw new Error('children did not become ready')
    await new Promise((r) => setTimeout(r, 5))
  }
  fs.writeFileSync(goPath, '1') // release both at (almost) the same instant
  const results = await both
  return results.map((r) => JSON.parse(r.stdout.trim()) as { ok: boolean; reason?: string })
}

describe('approval claim (in-process, real file system)', () => {
  it('the first claim wins and every later one gets "exists" (same machine, same file system; NO crash / power-loss test exists)', () => {
    const claimPath = path.join(freshDir(), 'a.json.claim')
    expect(readClaimFile(claimPath)).toBeNull()
    expect(claimExclusive(claimPath, 'used', { at: 'now' })).toEqual({ ok: true })
    expect(claimExclusive(claimPath, 'used', {})).toEqual({ ok: false, reason: 'exists' })
    expect(claimExclusive(claimPath, 'burned', {})).toEqual({ ok: false, reason: 'exists' })
    expect(readClaimFile(claimPath)).toEqual({ state: 'used' })
  })
  it('a burned claim reads as burned and cannot be turned into a used one', () => {
    const claimPath = path.join(freshDir(), 'b.json.claim')
    expect(claimExclusive(claimPath, 'burned', { reason: 'target_mismatch' })).toEqual({ ok: true })
    expect(readClaimFile(claimPath)).toEqual({ state: 'burned' })
    expect(claimExclusive(claimPath, 'used', {})).toEqual({ ok: false, reason: 'exists' })
  })
  it('anything that exists at the claim path counts as a claim (even garbage or an empty file)', () => {
    const dir = freshDir()
    const garbage = path.join(dir, 'g.claim')
    fs.writeFileSync(garbage, '{not json')
    expect(readClaimFile(garbage)).toEqual({ state: 'used' })
    const empty = path.join(dir, 'e.claim')
    fs.writeFileSync(empty, '')
    expect(readClaimFile(empty)).toEqual({ state: 'used' })
    expect(claimExclusive(empty, 'used', {})).toEqual({ ok: false, reason: 'exists' })
  })
  it('a claim path that exists but cannot be read (here: a directory) still counts as a claim, never as "no claim"', () => {
    const asDirectory = path.join(freshDir(), 'd.claim')
    fs.mkdirSync(asDirectory)
    expect(readClaimFile(asDirectory)).toEqual({ state: 'used' })
    expect(claimExclusive(asDirectory, 'used', {})).toEqual({ ok: false, reason: 'exists' })
  })
  it('a claim that cannot be created is an io error, not a success', () => {
    const missingDir = path.join(freshDir(), 'does-not-exist', 'x.claim')
    expect(claimExclusive(missingDir, 'used', {})).toEqual({ ok: false, reason: 'io_error' })
    expect(readClaimFile(missingDir)).toBeNull() // and nothing was created
  })
  it('the claim file holds no secret: only the keys the runner passes', () => {
    const claimPath = path.join(freshDir(), 'k.claim')
    claimExclusive(claimPath, 'used', { at: '2026-10-08T10:00:00.000Z', phase: 'staging_dryrun', label: 'staging', sql_sha256: SQL_SHA })
    expect(Object.keys(JSON.parse(fs.readFileSync(claimPath, 'utf8'))).sort()).toEqual(['at', 'label', 'phase', 'sql_sha256', 'state'])
  })
})

describe('two runners racing for one approval (two real processes)', () => {
  it('the exclusive claim lets exactly ONE of two simultaneous processes win, in every round', async () => {
    for (let round = 0; round < 12; round += 1) {
      const results = await race('exclusive')
      expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1)
      expect(results.filter((r) => !r.ok).map((r) => r.reason)).toEqual(['exists'])
    }
  }, 120000)

  it('negative control: the OLD read -> check -> write handling lets BOTH processes start (the test has teeth)', async () => {
    const results = await race('naive')
    expect(results.filter((r) => r.ok)).toHaveLength(2)
  }, 60000)
})

describe('the exact verified bytes reach psql (a local stand-in, no database)', () => {
  const setupFake = (cannedOutput?: string) => {
    const dir = freshDir()
    const script = path.join(dir, 'fake-psql.mjs')
    fs.writeFileSync(script, FAKE_PSQL)
    const recordPath = path.join(dir, 'record.json')
    if (cannedOutput !== undefined) fs.writeFileSync(`${recordPath}.out`, cannedOutput)
    return { dir, options: { executable: process.execPath, argPrefix: [script, recordPath], timeoutMs: 30000 }, read: () => JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { args: string[]; envKeys: string[]; env: Record<string, string>; stdinSha256: string; stdinLength: number } }
  }

  it('psql gets the approved bytes on stdin, exactly, and no file path', async () => {
    const fake = setupFake('ok\n')
    const run = await runCensusPsql(TARGET, ROLE, SQL_BYTES, fake.options)
    const seen = fake.read()
    expect(run).toMatchObject({ exitCode: 0, stdout: 'ok\n', timedOut: false })
    expect(seen.stdinSha256).toBe(SQL_SHA)
    expect(seen.stdinLength).toBe(SQL_BYTES.length)
    // literal on purpose (not derived from the module): password prompt forced, no rc files, stop on error, csv, script on stdin
    expect(seen.args).toEqual(['-X', '-q', '--no-psqlrc', '-W', '-v', 'ON_ERROR_STOP=1', '--csv', '-f', '-'])
    expect([...CENSUS_PSQL_ARGS]).toEqual(seen.args)
    expect(seen.args.slice(-2)).toEqual(['-f', '-'])
    expect(seen.args.join(' ')).not.toContain(CENSUS_SQL_RELATIVE_PATH)
    expect(seen.args.join(' ')).not.toMatch(/\.sql/)
  })

  it('the child environment is private: the target and role are set, nothing leaks from the parent, no password variable', async () => {
    const saved = { PGPASSWORD: process.env.PGPASSWORD, LEAK_TOKEN: process.env.LEAK_TOKEN, PGOPTIONS: process.env.PGOPTIONS, PGSERVICE: process.env.PGSERVICE }
    process.env.PGPASSWORD = 'LEAK_parent_password'
    process.env.LEAK_TOKEN = 'LEAK_parent_token'
    process.env.PGOPTIONS = '-c search_path=evil'
    process.env.PGSERVICE = 'evil'
    try {
      const fake = setupFake('')
      await runCensusPsql(TARGET, ROLE, SQL_BYTES, fake.options)
      const seen = fake.read()
      expect(seen.env).toMatchObject({ PGHOST: TARGET.host, PGPORT: '5432', PGDATABASE: TARGET.database, PGUSER: ROLE, PGSSLMODE: 'require', PGPASSFILE: os.devNull, PSQLRC: os.devNull })
      expect(seen.envKeys).not.toContain('PGPASSWORD')
      expect(seen.envKeys).not.toContain('PGOPTIONS')
      expect(seen.envKeys).not.toContain('PGSERVICE')
      expect(seen.envKeys).not.toContain('LEAK_TOKEN')
      expect(JSON.stringify(seen)).not.toContain('LEAK_parent')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('the probe sends only the fixed constant with -c and nothing on stdin', async () => {
    const fake = setupFake('')
    await runProbePsql(TARGET, ROLE, SYSTEM_IDENTIFIER_PROBE_SQL, fake.options)
    const seen = fake.read()
    expect(seen.args).toEqual(['-X', '-q', '--no-psqlrc', '-W', '-v', 'ON_ERROR_STOP=1', '--csv', '-t', '-c', SYSTEM_IDENTIFIER_PROBE_SQL])
    expect(probePsqlArgs(SYSTEM_IDENTIFIER_PROBE_SQL)).toEqual(seen.args)
    expect(seen.args.slice(-2)).toEqual(['-c', SYSTEM_IDENTIFIER_PROBE_SQL])
    expect(seen.stdinLength).toBe(0)
  })

  it('buildChildEnv never carries a password variable and trims the inputs', () => {
    const env = buildChildEnv({ host: ' h ', port: '', database: ' d ' }, ' r ', { PATH: '/bin', PGPASSWORD: 'x' } as unknown as NodeJS.ProcessEnv)
    expect(env).toMatchObject({ PGHOST: 'h', PGPORT: '5432', PGDATABASE: 'd', PGUSER: 'r', PATH: '/bin' })
    expect(Object.keys(env)).not.toContain('PGPASSWORD')
  })

  // ---- end to end: runCensus + the real claim + the real psql module + the stand-in --------------------------------
  const record = (): ApprovalRecord => ({
    phase: 'staging_dryrun',
    target_label: PHASE_LABEL.staging_dryrun,
    target_fingerprint: targetFingerprint(TARGET),
    role_fingerprint: roleFingerprint(ROLE),
    sql_sha256: SQL_SHA,
    approver: 'approver-sentinel',
    expires_at: '2026-10-09T10:00:00.000Z',
    status: 'unused',
    second_factor: { kind: 'system_identifier_sha256', value: SECOND },
  })
  const GOOD = ['session_guard_status,server_version_num', 'ok,150006', 'schema_guard_status', 'ok', 'tool_type,status,n_rows_bucket', 'tool_type,status,period,n_rows_bucket', 'relname,n_tup_ins_bucket,n_tup_upd_bucket,n_tup_del_bucket', 'stats_reset', '', 'tool_type,n_spends_not_refunded_bucket,n_completed_cost_pos_bucket,n_completed_cost_zero_bucket', 'n_users_with_mapped_spends_and_no_paid_results_bucket', '0'].join('\n') + '\n'

  function e2eDeps(opts: { sqlPath: string; claimPath: string; psqlOptions: ReturnType<typeof setupFake>['options']; lines: string[]; beforeRun?: () => void; reopenByPath?: boolean }): RunnerDeps {
    const answers: Record<string, string> = { project_ref: TARGET.projectRef, host: TARGET.host, port: TARGET.port, database: TARGET.database, role: ROLE }
    return {
      now: () => new Date('2026-10-08T10:00:00.000Z'),
      readSqlBytes: () => fs.readFileSync(opts.sqlPath),
      readApproval: () => record(),
      readClaim: () => readClaimFile(opts.claimPath),
      claim: (state, info) => claimExclusive(opts.claimPath, state, info),
      promptHidden: async (field) => answers[field],
      confirmExecute: async () => {
        opts.beforeRun?.() // tamper with the file AFTER the hash check, BEFORE psql starts
        return true
      },
      probeSecondFactor: async () => ({ ok: true, value: SECOND }),
      runPsql: (target, role, bytes) =>
        runCensusPsql(target, role, opts.reopenByPath ? fs.readFileSync(opts.sqlPath) : bytes, opts.psqlOptions),
      emit: (line) => opts.lines.push(line),
    }
  }

  it('TOCTOU: the SQL file is replaced after the hash check -- psql still receives the approved bytes', async () => {
    const fake = setupFake(GOOD)
    const dir = freshDir()
    const sqlPath = path.join(dir, 'census.sql')
    fs.writeFileSync(sqlPath, SQL_BYTES)
    const lines: string[] = []
    const ev = await runCensus(
      e2eDeps({ sqlPath, claimPath: path.join(dir, 'approval.json.claim'), psqlOptions: fake.options, lines, beforeRun: () => fs.writeFileSync(sqlPath, 'DELETE FROM paid_results;') }),
      { phase: 'staging_dryrun', execute: true },
    )
    expect(fs.readFileSync(sqlPath, 'utf8')).toBe('DELETE FROM paid_results;') // the tampering really happened
    expect(ev.status).toBe('ok')
    expect(fake.read().stdinSha256).toBe(SQL_SHA)
    expect(fake.read().args.join(' ')).not.toContain('census.sql')
  }, 60000)

  it('negative control: re-opening the path after the check WOULD have run the tampered bytes (the test has teeth)', async () => {
    const fake = setupFake(GOOD)
    const dir = freshDir()
    const sqlPath = path.join(dir, 'census.sql')
    fs.writeFileSync(sqlPath, SQL_BYTES)
    await runCensus(
      e2eDeps({ sqlPath, claimPath: path.join(dir, 'approval.json.claim'), psqlOptions: fake.options, lines: [], reopenByPath: true, beforeRun: () => fs.writeFileSync(sqlPath, 'DELETE FROM paid_results;') }),
      { phase: 'staging_dryrun', execute: true },
    )
    expect(fake.read().stdinSha256).toBe(sha256Hex('DELETE FROM paid_results;'))
    expect(fake.read().stdinSha256).not.toBe(SQL_SHA)
  }, 60000)

  it('two runners in one process race through every gate: exactly one reaches psql, the other loses the claim', async () => {
    const fakeA = setupFake(GOOD)
    const fakeB = setupFake(GOOD)
    const dir = freshDir()
    const sqlPath = path.join(dir, 'census.sql')
    fs.writeFileSync(sqlPath, SQL_BYTES)
    const claimPath = path.join(dir, 'approval.json.claim')
    const linesA: string[] = []
    const linesB: string[] = []
    const [a, b] = await Promise.all([
      runCensus(e2eDeps({ sqlPath, claimPath, psqlOptions: fakeA.options, lines: linesA }), { phase: 'staging_dryrun', execute: true }),
      runCensus(e2eDeps({ sqlPath, claimPath, psqlOptions: fakeB.options, lines: linesB }), { phase: 'staging_dryrun', execute: true }),
    ])
    const statuses = [a.status === 'ok' ? 'ok' : a.code, b.status === 'ok' ? 'ok' : b.code].sort()
    expect(statuses).toEqual(['approval_claim_lost', 'ok'])
    expect([fs.existsSync(path.join(fakeA.dir, 'record.json')), fs.existsSync(path.join(fakeB.dir, 'record.json'))].filter(Boolean)).toHaveLength(1)
    expect(readClaimFile(claimPath)).toEqual({ state: 'used' })
  }, 60000)

  it('a wrong role burns the claim file for real, and a later run is refused before anything else', async () => {
    const fake = setupFake(GOOD)
    const dir = freshDir()
    const sqlPath = path.join(dir, 'census.sql')
    fs.writeFileSync(sqlPath, SQL_BYTES)
    const claimPath = path.join(dir, 'approval.json.claim')
    const wrong = e2eDeps({ sqlPath, claimPath, psqlOptions: fake.options, lines: [] })
    const original = wrong.promptHidden
    wrong.promptHidden = async (field) => (field === 'role' ? 'some_other_admin_role' : original(field))
    expect(await runCensus(wrong, { phase: 'staging_dryrun', execute: true })).toMatchObject({ code: 'role_mismatch' })
    expect(readClaimFile(claimPath)).toEqual({ state: 'burned' })
    expect(fs.existsSync(path.join(fake.dir, 'record.json'))).toBe(false) // psql was never started
    const retry = await runCensus(e2eDeps({ sqlPath, claimPath, psqlOptions: fake.options, lines: [] }), { phase: 'staging_dryrun', execute: true })
    expect(retry).toMatchObject({ code: 'approval_burned' })
  }, 60000)

  it('an unwritable claim path while burning is the loud BURN FAILED failure (no psql, no silent unused)', async () => {
    const fake = setupFake(GOOD)
    const dir = freshDir()
    const sqlPath = path.join(dir, 'census.sql')
    fs.writeFileSync(sqlPath, SQL_BYTES)
    const lines: string[] = []
    const deps = e2eDeps({ sqlPath, claimPath: path.join(dir, 'missing-dir', 'approval.json.claim'), psqlOptions: fake.options, lines })
    const original = deps.promptHidden
    deps.promptHidden = async (field) => (field === 'host' ? 'db.wrong-host.sentinel.test' : original(field))
    const ev = await runCensus(deps, { phase: 'staging_dryrun', execute: true })
    expect(ev).toMatchObject({ status: 'aborted', code: 'burn_failed' })
    expect(lines.some((l) => l.includes('BURN FAILED'))).toBe(true)
    expect(fs.existsSync(path.join(fake.dir, 'record.json'))).toBe(false)
  }, 60000)
})

// ---------------------------------------------------------------------------------------------------------------------
// The hash-pinned SQL must survive git with core.autocrlf=true (the setting of this Windows checkout).
// Everything below happens in throw-away repositories under the OS temp directory; the project repository is only read
// (git check-attr). No commit is made anywhere else.
// ---------------------------------------------------------------------------------------------------------------------
describe('.gitattributes keeps the approved SQL bytes under core.autocrlf=true (scratch repositories only)', () => {
  const rel = CENSUS_SQL_RELATIVE_PATH
  // an EMPTY config file stands in for the global git config (git on Windows rejects the null device here)
  const emptyGitConfig = path.join(tmpRoot, 'empty-gitconfig')
  fs.writeFileSync(emptyGitConfig, '')
  const gitEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGitConfig } as unknown as NodeJS.ProcessEnv
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, env: gitEnv, encoding: 'buffer' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString('utf8')}`)
    return r.stdout
  }
  const crCount = (bytes: Buffer) => bytes.filter((b) => b === 0x0d).length

  function roundTrip(opts: { withRule: boolean; crlfWorkingCopy: boolean }) {
    const dir = freshDir()
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true })
    const target = path.join(dir, rel)
    fs.writeFileSync(target, opts.crlfWorkingCopy ? Buffer.from(SQL_BYTES.toString('latin1').replace(/\n/g, '\r\n'), 'latin1') : SQL_BYTES)
    if (opts.withRule) fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(dir, '.gitattributes'))
    git(dir, ['init', '-q'])
    git(dir, ['config', 'core.autocrlf', 'true'])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 't'])
    const storedBlob = git(dir, ['cat-file', 'blob', `HEAD:${rel}`])
    fs.rmSync(target)
    git(dir, ['checkout', '-q', '--', rel]) // a fresh checkout, through the smudge / eol conversion
    const checkedOut = fs.readFileSync(target)
    return { stored: sha256Hex(storedBlob), checkout: sha256Hex(checkedOut), crInCheckout: crCount(checkedOut), crInBlob: crCount(storedBlob) }
  }

  it('the rule file scopes exactly this one file and nothing broader', () => {
    const lines = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
    expect(lines).toEqual([`${CENSUS_SQL_RELATIVE_PATH} text eol=lf`])
  })

  it('git reports text + eol=lf for the SQL file in this repository', () => {
    const out = git(ROOT, ['check-attr', 'text', 'eol', '--', CENSUS_SQL_RELATIVE_PATH]).toString('utf8')
    expect(out).toContain('text: set')
    expect(out).toContain('eol: lf')
  })

  it('WITH the rule: the stored blob and a fresh checkout are byte-identical to the approved file (LF input)', () => {
    const r = roundTrip({ withRule: true, crlfWorkingCopy: false })
    expect(r).toMatchObject({ stored: SQL_SHA, checkout: SQL_SHA, crInCheckout: 0, crInBlob: 0 })
  }, 60000)

  it('WITH the rule: even a working copy that an editor saved with CRLF is stored and checked out as the approved bytes', () => {
    const r = roundTrip({ withRule: true, crlfWorkingCopy: true })
    expect(r).toMatchObject({ stored: SQL_SHA, checkout: SQL_SHA, crInCheckout: 0, crInBlob: 0 })
  }, 60000)

  it('negative control: WITHOUT the rule a core.autocrlf=true checkout rewrites the file to CRLF and the hash changes', () => {
    const r = roundTrip({ withRule: false, crlfWorkingCopy: false })
    expect(r.stored).toBe(SQL_SHA) // the repository content is fine ...
    expect(r.checkout).not.toBe(SQL_SHA) // ... the checkout is not
    expect(r.crInCheckout).toBeGreaterThan(0)
  }, 60000)

  it('the claim and runner sources never describe the claim as surviving a crash or power loss (not verified)', () => {
    for (const rel2 of ['lib/lr1-census/approval-claim.ts', 'lib/lr1-census/runner-core.ts', 'lib/lr1-census/psql-process.ts', 'scripts/lr1-census-runner.ts']) {
      for (const line of fs.readFileSync(path.join(ROOT, rel2), 'utf8').split('\n')) {
        if (/durab/i.test(line)) expect(line, `${rel2}: ${line}`).toMatch(/\bnot\b/i)
      }
    }
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'operations', 'paid-operations-d1-d2-state-model.md'), 'utf8')
    expect(doc).not.toMatch(/tartós(an)?\s+(claim|igénylés|burn)/i)
    expect(doc).toMatch(/áramszünet[^\n]{0,200}nem igazolt|nem igazolt[^\n]{0,200}áramszünet/i)
  })
})
