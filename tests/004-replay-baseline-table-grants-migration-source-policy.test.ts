// DB-free SOURCE policy of migration 004 (replay baseline table grants). Reads files only: no database, no docker, no network.
// THIS TEST IS NOT RUNTIME EVIDENCE. It cannot execute the SQL and cannot detect any runtime behaviour; the runtime claims rest only on the separate isolated replays
// described in docs/operations/migration-004-replay-baseline-table-grants.md. What it does pin: the proven bytes (SHA-256), the single transaction + fail-closed text
// structure, that the text grants nothing but the baseline DML set, the data of the baseline and of the FINAL ACL, the static dependency on migrations 044 / 090 (and the
// later migrations that narrow the 044-time superset), that no workflow applies migrations to a hosted database, and the operations document.
// The structural checks are plain functions of the comment-stripped SQL text. The last describe block runs them on deliberately broken in-memory copies of the SQL
// (negative controls): each control must flip exactly the check that is meant to catch it, so that no check is vacuous. Nothing is written to the migration file.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations')
const FILE = '004_replay_baseline_table_grants.sql'
// SHA-256 of the LF text of the FINAL file
const FINAL_FILE_SHA256 = 'dd68ba25a48733840efea5b0ca9b6a28ac809b451a6ff0d46a2bb36a7d6cc89f'
// SHA-256 of the executable part (from the first "BEGIN;" line to the end). It is byte-identical to the executable part of the v4 file (full-file SHA-256 below) that was
// replayed in the isolated proofs on 2026-10-21; machine-verified. Only the header comment differs (the v4 header still described a local prototype).
const EXECUTABLE_PART_SHA256 = '1f92624ed211a7fcca67c9f822468fd49338de362bbf90a03c940d24b290c6cb'
const PROVEN_V4_FILE_SHA256 = '4ce20764a97e3beb0e711f4272cd651273385e25209fed58ddc9e9e5f65fc0c2'
const DOC_PATH = path.join(ROOT, 'docs', 'operations', 'migration-004-replay-baseline-table-grants.md')

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const SQL = read(path.join(MIG_DIR, FILE))
const DOC = read(DOC_PATH)
const names = readdirSync(MIG_DIR).filter((n) => n.endsWith('.sql')).sort()
const executablePart = (sql: string) => sql.slice(sql.indexOf('\nBEGIN;\n') + 1)
// comments removed: /* ... */ blocks first, then -- to end of line (the file has no -- inside a string literal; asserted below)
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
const CODE = stripComments(SQL)
const jsonConst = (sql: string, tag: string): Array<[string, string, string]> => JSON.parse(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(sql)![1])
const tablesOf = (sql: string) => [...sql.matchAll(/c_tables CONSTANT text\[\] := ARRAY\[([\s\S]*?)\];/g)][0][1].match(/'([a-z_0-9]+)'/g)!.map((s) => s.slice(1, -1))
const TABLES = tablesOf(SQL)
const BASE = jsonConst(SQL, 'base')
const FINAL = jsonConst(SQL, 'final')
const expand = (rows: Array<[string, string, string]>) => rows.flatMap(([t, r, p]) => p.split(',').map((x) => `${t}|${r}|${x}`))

// The table-level ACL of these 14 tables as read from the production catalog on 2026-10-20 (production and staging were identical, SHA-256 equal). Transcribed here by
// hand from that read-only catalog read: this test reads no database and cannot verify the values against any live catalog, only against the literal in the SQL file.
const PRODUCTION_FINAL_TRANSCRIBED: Record<string, { authenticated: string; service_role: string }> = {
  ai_usage_logs: { authenticated: 'INSERT,SELECT', service_role: 'INSERT,SELECT' },
  creator_memory: { authenticated: 'SELECT', service_role: 'DELETE,SELECT' },
  opportunity_cache: { authenticated: 'SELECT', service_role: 'INSERT,SELECT,UPDATE' },
  profiles: { authenticated: 'SELECT,UPDATE', service_role: 'SELECT,UPDATE' },
  source_video_analysis: { authenticated: 'INSERT,SELECT', service_role: 'INSERT,SELECT' },
  topic_feedback: { authenticated: 'INSERT,SELECT', service_role: 'INSERT,SELECT' },
  trend_candidate_cache: { authenticated: '', service_role: 'DELETE,INSERT,SELECT,UPDATE' },
  usage_logs: { authenticated: 'INSERT,SELECT', service_role: 'INSERT,SELECT' },
  user_credits: { authenticated: 'SELECT,UPDATE', service_role: 'INSERT,SELECT,UPDATE' },
  video_audits: { authenticated: '', service_role: 'DELETE,INSERT,SELECT,UPDATE' },
  video_packages: { authenticated: 'DELETE,INSERT,SELECT', service_role: 'DELETE,INSERT,SELECT,UPDATE' },
  viral_score_cache: { authenticated: 'SELECT', service_role: 'INSERT,SELECT,UPDATE' },
  youtube_search_cache: { authenticated: 'SELECT', service_role: 'INSERT,SELECT,UPDATE' },
  youtube_search_logs: { authenticated: 'DELETE,INSERT,SELECT,UPDATE', service_role: 'DELETE,INSERT,SELECT,UPDATE' },
}

// ---- structural checks over the comment-stripped SQL text (each returns true when the text has the intended shape) ----
// the ONE statement that grants: a loop over the baseline constant c_base (and over nothing else), with exactly this dynamic statement
const LOOP_RE = /FOR r IN SELECT e ->> 0 AS tbl, e ->> 1 AS grantee, e ->> 2 AS privs FROM jsonb_array_elements\(c_base\) e\s+LOOP\s+EXECUTE format\('GRANT %s ON TABLE public\.%I TO %I', r\.privs, r\.tbl, r\.grantee\);\s+END LOOP;/
// the ONLY early exit: LEGACY / FINAL only, containing nothing but the notice and the RETURN
const EARLY_RETURN_RE = /IF v_state IN \('LEGACY', 'FINAL'\) THEN\s+RAISE NOTICE '[^']*', cardinality\(c_tables\), v_state;\s+RETURN;\s+END IF;/
const GATE_RE = /IF v_distinct <> 1 OR v_state = 'OTHER' THEN\s+RAISE EXCEPTION '004 baseline fail-closed[\s\S]*?;\s+END IF;/
const POST_RE = /IF v_offenders IS NOT NULL THEN\s+RAISE EXCEPTION '004 baseline fail-closed[\s\S]*?;\s+END IF;/
const count = (code: string, re: RegExp) => (code.match(re) || []).length
const at = (code: string, re: RegExp) => { const m = re.exec(code); return m ? m.index : -1 }
const checks = {
  // exactly one upper-case GRANT keyword, exactly one EXECUTE, no static grant statement in any case, and that single statement is the c_base loop
  grantOnlyFromBase: (c: string) => count(c, /\bGRANT\b/g) === 1 && count(c, /\bEXECUTE\b/g) === 1 && count(c, /(^|;)\s*grant\s/gim) === 0 && LOOP_RE.test(c) &&
    count(c, /jsonb_array_elements\(c_base\)/g) === 2 && count(c, /jsonb_array_elements\(c_final\)/g) === 1,
  // exactly one RETURN, and it is the one inside the LEGACY / FINAL block
  earlyReturnOnly: (c: string) => count(c, /\bRETURN\b/g) === 1 && EARLY_RETURN_RE.test(c),
  // the fail-closed gate, the early exit, the grant loop and the exact post-condition occur in this order; exactly three fail-closed raises
  gateOrder: (c: string) => {
    const pos = [at(c, GATE_RE), at(c, EARLY_RETURN_RE), at(c, LOOP_RE), at(c, POST_RE)]
    return pos.every((p) => p >= 0) && pos.every((p, i) => i === 0 || p > pos[i - 1]) && count(c, /RAISE EXCEPTION '004 baseline fail-closed/g) === 3
  },
  // nothing but the one dynamic GRANT: no REVOKE / ALTER / CREATE / DROP / default privileges / grant option / PUBLIC or anon target / static GRANT ALL
  noOtherDdl: (c: string) => [/\bREVOKE\b/i, /\bALTER\b/i, /\bCREATE\b/i, /\bDROP\b/i, /DEFAULT PRIVILEGES/i, /GRANT OPTION/i, /\bTO\s+anon\b/i, /\bTO\s+PUBLIC\b/i, /\bGRANT\s+ALL\b/i].every((re) => !re.test(c)),
  // PLATFORM-NEW is gated on PG >= 17 and on exactly the four non-DML privileges; the post-condition adds them only in that state
  platformGuards: (c: string) => c.includes("v_pg17 boolean := current_setting('server_version_num')::int >= 170000") &&
    c.includes("v_platform_privs CONSTANT text[] := ARRAY['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE']") &&
    /CASE WHEN v_pg17 THEN string_agg\(ro\.r \|\| '\|' \|\| p \|\| '\|false'/.test(c) &&
    c.includes("(VALUES ('anon'),('authenticated'),('service_role')) ro(r)") && c.includes("WHERE v_state = 'PLATFORM-NEW') u"),
  // the state test compares the whole non-owner ACL string incl. grant option
  // (the two ACL-reading CTEs, before and after the grants, both exclude the owner and both carry the grant option)
  aclComparison: (c: string) => count(c, /x\.grantee <> c\.relowner/g) === 2 && count(c, /x\.is_grantable::text/g) === 2 && c.includes("a.s = pn.s THEN 'PLATFORM-NEW'") && /v_found <> cardinality\(c_tables\)/.test(c),
}
// data checks of the two jsonb constants
const baseDataOk = (rows: Array<[string, string, string]>, tables: string[]) => {
  const tuples = expand(rows)
  return rows.length === 25 && tuples.length === 64 && new Set(tuples).size === 64 &&
    rows.every(([t, r, p]) => tables.includes(t) && ['authenticated', 'service_role'].includes(r) && p.split(',').every((x) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(x))) &&
    new Set(rows.map((e) => e[0])).size === tables.length
}
const finalEquals = (rows: Array<[string, string, string]>) => {
  const fromFile: Record<string, { authenticated: string; service_role: string }> = {}
  for (const [t, r, p] of rows) (fromFile[t] ||= { authenticated: '', service_role: '' })[r as 'authenticated' | 'service_role'] = p.split(',').sort().join(',')
  return rows.length === 26 && JSON.stringify(Object.entries(fromFile).sort()) === JSON.stringify(Object.entries(PRODUCTION_FINAL_TRANSCRIBED).sort())
}

// table-level GRANTs that migrations with a number LOWER than `below` issue explicitly (004 itself grants dynamically and is skipped)
const L: Record<string, string> = { SELECT: 'SELECT', INSERT: 'INSERT', UPDATE: 'UPDATE', DELETE: 'DELETE' }
const explicitBefore = (below: number) => {
  const out = new Set<string>()
  for (const n of names) {
    if (+n.slice(0, 3) >= below || n === FILE) continue
    const t = read(path.join(MIG_DIR, n))
    for (const m of t.matchAll(/^\s*GRANT\s+([^;]+?)\s+ON\s+(?:TABLE\s+)?([^;]+?)\s+TO\s+([^;]+);/gim)) {
      if (/FUNCTION|SEQUENCE|EXECUTE/i.test(m[0]) || /\(/.test(m[1])) continue
      const privs = /^ALL/i.test(m[1].trim()) ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : m[1].split(',').map((p) => L[p.trim().toUpperCase()]).filter(Boolean)
      for (const tb of m[2].split(',').map((s) => s.trim().replace(/^public\./, '').replace(/"/g, ''))) {
        for (const r of m[3].split(',').map((s) => s.trim())) privs.forEach((p) => out.add(`${tb}|${r}|${p}`))
      }
    }
  }
  return out
}

describe('004 migration file: the proven bytes, the slot, the transaction', () => {
  it('is the pinned file (SHA-256 of the LF text) and plain ASCII; its executable part is the part that was proven (v4)', () => {
    expect(sha256(SQL)).toBe(FINAL_FILE_SHA256)
    expect(sha256(executablePart(SQL))).toBe(EXECUTABLE_PART_SHA256)
    expect(FINAL_FILE_SHA256).not.toBe(PROVEN_V4_FILE_SHA256) // the header was corrected after the proofs; the executable bytes were not
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(SQL)).toBe(false)
  })

  it('the header does not describe the file as a prototype / not in migrations / never run', () => {
    const header = SQL.slice(0, SQL.indexOf('\nBEGIN;\n'))
    expect(header).toMatch(/Migration 004: replay baseline table grants/)
    expect(header).not.toMatch(/prototype|candidate|not (yet )?(in|part of) (the )?migrations|never run|never been run/i)
  })

  it('is the only 004, sorts after 003 and before 011 (versions 004..010 were unused), and no other migration was renumbered', () => {
    expect(names.filter((n) => n.startsWith('004'))).toEqual([FILE])
    const i = names.indexOf(FILE)
    expect(names[i - 1]).toBe('003_baseline_capture_flagged_tables.sql')
    expect(names[i + 1].startsWith('011_')).toBe(true)
    expect(names.filter((n) => /^00[5-9]_|^010_/.test(n))).toEqual([])
    expect(names[names.length - 1] >= '091_starter_credit_contract.sql').toBe(true)
  })

  it('is one transaction with one DO block; no block comment; no -- inside a string literal (so the comment stripping of this test is exact)', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(SQL.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(SQL.match(/DO \$baseline_004\$/g)).toHaveLength(1)
    expect(SQL.match(/\$baseline_004\$;/g)).toHaveLength(1)
    expect(SQL.includes('/*')).toBe(false)
    for (const l of SQL.split('\n')) { const i = l.indexOf('--'); if (i > 0) expect((l.slice(0, i).match(/'/g) || []).length % 2, l).toBe(0) }
  })
})

describe('004 migration: fail-closed state machine (four accepted ACL states, everything else raises)', () => {
  it('names the four states; the gate, the early exit (LEGACY / FINAL only), the grant loop and the exact post-condition occur in this order', () => {
    for (const s of ["'EMPTY'", "'LEGACY'", "'FINAL'", "'PLATFORM-NEW'", "'OTHER'"]) expect(CODE).toContain(s)
    expect(checks.gateOrder(CODE)).toBe(true)
    expect(checks.earlyReturnOnly(CODE)).toBe(true)
  })

  it('recognises PLATFORM-NEW only on PG >= 17 and only as exactly MAINTAIN, REFERENCES, TRIGGER, TRUNCATE for the three roles', () => {
    expect(checks.platformGuards(CODE)).toBe(true)
  })

  it('compares the whole non-owner ACL string incl. grant option (nothing is skipped silently)', () => {
    expect(checks.aclComparison(CODE)).toBe(true)
  })
})

describe('004 migration: it grants nothing but the baseline DML set', () => {
  it('has exactly one GRANT / EXECUTE, the dynamic one fed by c_base; no REVOKE / ALTER / CREATE / DROP / default privileges / grant option / anon / PUBLIC target', () => {
    expect(checks.grantOnlyFromBase(CODE)).toBe(true)
    expect(checks.noOtherDdl(CODE)).toBe(true)
  })

  it('c_base: 25 role/table pairs, 64 privileges, only authenticated / service_role, only SELECT / INSERT / UPDATE / DELETE, all 14 tables', () => {
    expect(TABLES).toHaveLength(14)
    expect(baseDataOk(BASE, TABLES)).toBe(true)
    // privileges reachable by the single grant statement are exactly the c_base privileges, so TRUNCATE / REFERENCES / TRIGGER / MAINTAIN and anon cannot be granted
    expect(new Set(expand(BASE).map((x) => x.split('|')[2]))).toEqual(new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']))
    expect(new Set(BASE.map((e) => e[1]))).toEqual(new Set(['authenticated', 'service_role']))
  })

  it('c_final equals the transcribed production catalog (26 pairs, all 14 tables)', () => {
    expect(finalEquals(FINAL)).toBe(true)
  })

  it('every one of the 14 tables is created by migrations 001..003, i.e. a slot right after 003 is early enough', () => {
    const created = new Set<string>()
    for (const n of names.filter((x) => +x.slice(0, 3) <= 3)) for (const m of read(path.join(MIG_DIR, n)).matchAll(/^\s*CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z_0-9]+)"?/gim)) created.add(m[1])
    for (const t of TABLES) expect(created.has(t), t).toBe(true)
  })
})

describe('004 migration: dependency on 044 / 090 and on the later migrations that narrow the 044-time superset', () => {
  const t044 = read(path.join(MIG_DIR, '044_reconcile_table_grants.sql'))
  const keepers044 = [...t044.matchAll(/\('([a-z_0-9]+)','(authenticated|service_role)','(SELECT|INSERT|UPDATE|DELETE)'\)/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`)
  const baseTuples = new Set(expand(BASE))
  const before044 = explicitBefore(44)

  it('044 pins 157 keeper tuples (24 authenticated + 133 service_role)', () => {
    expect(keepers044).toHaveLength(157)
    expect(keepers044.filter((k) => k.includes('|authenticated|'))).toHaveLength(24)
    expect(keepers044.filter((k) => k.includes('|service_role|'))).toHaveLength(133)
  })

  it('every 044 keeper on a baseline table is granted explicitly before 044 OR supplied by 004 (nothing is missing for 044\'s MISSING_LOCAL check)', () => {
    const onBaseline = keepers044.filter((k) => TABLES.includes(k.split('|')[0]))
    expect(onBaseline.length).toBeGreaterThan(0)
    const missing = onBaseline.filter((k) => !before044.has(k) && !baseTuples.has(k))
    expect(missing).toEqual([])
  })

  it('004 supplies no tuple that 044 would see as EXTRA_LOCAL: every baseline tuple on a table in 044\'s scope is one of its keepers; profiles is outside the 044 scope', () => {
    const scope = new Set(keepers044.map((k) => k.split('|')[0]))
    const extra = [...baseTuples].filter((k) => scope.has(k.split('|')[0]) && !keepers044.includes(k))
    expect(extra).toEqual([])
    expect([...baseTuples].filter((k) => !scope.has(k.split('|')[0])).map((k) => k.split('|')[0])).toEqual(['profiles', 'profiles', 'profiles', 'profiles'])
  })

  it('the 044-time superset is narrowed exactly by 067 / 068 (creator_memory), 041 (profiles) and 039 / 036 complete the rest: base minus final, and final minus base, are explained', () => {
    const finalTuples = new Set(expand(FINAL))
    const baseNotFinal = [...baseTuples].filter((k) => !finalTuples.has(k)).sort()
    expect(baseNotFinal).toEqual(['creator_memory|authenticated|DELETE', 'creator_memory|authenticated|INSERT', 'creator_memory|authenticated|UPDATE', 'creator_memory|service_role|INSERT', 'creator_memory|service_role|UPDATE'])
    expect(read(path.join(MIG_DIR, '067_creator_lane_expand.sql'))).toContain('REVOKE INSERT, UPDATE, DELETE ON creator_memory FROM authenticated;')
    expect(read(path.join(MIG_DIR, '068_creator_lane_contract.sql'))).toContain('REVOKE INSERT, UPDATE ON creator_memory FROM service_role;')
    const finalNotBase = [...finalTuples].filter((k) => !baseTuples.has(k)).sort()
    expect(finalNotBase).toEqual(['user_credits|service_role|INSERT', 'user_credits|service_role|SELECT', 'user_credits|service_role|UPDATE', 'video_packages|service_role|UPDATE'])
    const before090 = explicitBefore(90)
    for (const k of finalNotBase) expect(before090.has(k), `${k} must be granted explicitly by a migration before 090`).toBe(true)
    expect(read(path.join(MIG_DIR, '041_capture_profile_schema_drift.sql'))).toContain('REVOKE INSERT, DELETE ON public.profiles FROM authenticated;')
  })

  it('every FINAL tuple is provided by 004 or by an explicit grant before 090 (090 pins 23 authenticated / 200 service_role DML keepers, 81 column ACLs, 82 RLS tables)', () => {
    const before090 = explicitBefore(90)
    const lacking = [...new Set(expand(FINAL))].filter((k) => !baseTuples.has(k) && !before090.has(k))
    expect(lacking).toEqual([])
    const t090 = read(path.join(MIG_DIR, '090_public_schema_privilege_hardening.sql'))
    expect(t090).toContain('c_dml_auth_count CONSTANT int := 23;')
    expect(t090).toContain('c_dml_service_count CONSTANT int := 200;')
    expect(t090).toContain('c_colacl_count CONSTANT int := 81;')
    expect(t090).toContain('c_rls_count CONSTANT int := 82;')
    // 090 removes exactly the four non-DML privileges that the PLATFORM-NEW state leaves behind
    expect(t090).toContain("EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE %s FROM %s'")
  })
})

describe('no workflow or build step applies migrations to a hosted database', () => {
  const wfDir = path.join(ROOT, '.github', 'workflows')
  const workflows = readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n)).map((n) => ({ n, t: read(path.join(wfDir, n)) }))

  it('no db push / link / --linked / --db-url / migration up|repair / remote secret in any workflow; any supabase start is the local disposable stack', () => {
    expect(workflows.length).toBeGreaterThan(0)
    for (const { n, t } of workflows) {
      const code = t.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n')
      for (const bad of [/supabase\s+db\s+(push|remote|reset|pull|dump)/i, /supabase\s+link/i, /--linked/, /--db-url/, /supabase\s+migration\s+(up|repair|squash)/i, /SUPABASE_ACCESS_TOKEN/, /SUPABASE_DB_PASSWORD/, /SUPABASE_PROJECT_(REF|ID)/, /postgres(ql)?:\/\//i]) {
        expect(code, `${n} ${bad}`).not.toMatch(bad)
      }
    }
    const quality = workflows.find((w) => w.n === 'quality.yml')!.t
    expect(quality).toMatch(/supabase\s+start/)
    expect(quality).toMatch(/docker exec supabase_db_/)
  })

  it('package scripts and vercel.json contain no hosted-database migration command', () => {
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')))
    for (const [k, v] of Object.entries(pkg.scripts as Record<string, string>)) expect(`${k}=${v}`, k).not.toMatch(/supabase\s+(db|link|migration)|\bpsql\b|--db-url|--linked/i)
    const vercel = existsSync(path.join(ROOT, 'vercel.json')) ? read(path.join(ROOT, 'vercel.json')) : ''
    expect(vercel).not.toMatch(/supabase|migrat|psql/i)
  })
})

describe('operations document', () => {
  it('names the four accepted states (PLATFORM-NEW, never "CLEAN" for the platform state), the dependency on 044 / 090 and the migration-history facts', () => {
    for (const s of ['`EMPTY`', '`PLATFORM-NEW`', '`LEGACY`', '`FINAL`']) expect(DOC).toContain(s)
    expect(DOC).not.toMatch(/CLEAN/)
    expect(DOC).toMatch(/\*\*not\*\* what the platform or the CLI produces/)
    expect(DOC).toMatch(/not a safe resting state/)
    expect(DOC).toMatch(/not protected by RLS/)
    expect(DOC).toMatch(/044/)
    expect(DOC).toMatch(/090/)
    expect(DOC).toMatch(/retroactive/i)
    expect(DOC).toMatch(/no CLI migration history/i)
    expect(DOC).toMatch(/must never be run against production/)
  })

  it('records the final and the proven hashes, that only comments differ, and no longer says the header was deliberately left as a prototype', () => {
    expect(DOC).toContain(FINAL_FILE_SHA256)
    expect(DOC).toContain(PROVEN_V4_FILE_SHA256)
    expect(DOC).toContain(EXECUTABLE_PART_SHA256)
    expect(DOC).toMatch(/only comments differ/i)
    expect(DOC).not.toMatch(/deliberately NOT edited|local prototype candidate/)
    expect(DOC).not.toMatch(/2026-10-21\/22/)
  })

  it('describes the staging --include-all / migration repair paths only as operator options that need their own approval, not as recommended steps', () => {
    expect(DOC).toMatch(/--include-all/)
    expect(DOC).toMatch(/migration repair/)
    expect(DOC).toMatch(/operator options/i)
    expect(DOC).toMatch(/separate, explicit approval/)
    expect(DOC).toMatch(/does\s+not\s+recommend/)
    expect(DOC).not.toMatch(/\brecommended (step|action|way)\b/i)
  })

  it('states the limits: the source test is not runtime evidence, re-run is not idempotent, the open evidence gaps', () => {
    expect(DOC).toMatch(/source test[^.]*not runtime evidence/i)
    expect(DOC).toMatch(/not idempotent/i)
    expect(DOC).toMatch(/Not proven/)
    expect(DOC).toMatch(/without 004/)
  })
})

describe('negative controls: every structural check flips on a deliberately broken in-memory copy of the SQL', () => {
  type Key = keyof typeof checks
  // replaces all `n` occurrences of `from` (n asserted, default 1), so a control can never silently test the unmodified text
  const mutate = (from: string, to: string, n = 1) => {
    expect(SQL.split(from).length - 1, `control anchor must occur exactly ${n} time(s): ${from.slice(0, 60)}`).toBe(n)
    return SQL.split(from).join(to)
  }
  const GRANT_LINE = '  FOR r IN SELECT e ->> 0 AS tbl'

  it('the real SQL passes every check (the controls start from a passing baseline)', () => {
    for (const k of Object.keys(checks) as Key[]) expect(checks[k](CODE), k).toBe(true)
  })

  const controls: Array<[string, string, string, Key[], number?]> = [
    ['the grant loop is fed by c_final instead of c_base', 'FROM jsonb_array_elements(c_base) e\n  LOOP', 'FROM jsonb_array_elements(c_final) e\n  LOOP', ['grantOnlyFromBase', 'gateOrder']],
    ['a second, static upper-case GRANT is added', GRANT_LINE, '  GRANT ALL ON TABLE public.profiles TO anon;\n' + GRANT_LINE, ['grantOnlyFromBase', 'noOtherDdl']],
    ['a second, static lower-case grant is added', GRANT_LINE, '  grant select on table public.profiles to public;\n' + GRANT_LINE, ['grantOnlyFromBase']],
    ['a second dynamic lower-case grant is added', GRANT_LINE, "  EXECUTE 'grant all on table public.profiles to anon';\n" + GRANT_LINE, ['grantOnlyFromBase']],
    ['a RETURN is added after the grant loop', "  RAISE NOTICE '004 baseline: % state, baseline DML supplied", "  RETURN;\n  RAISE NOTICE '004 baseline: % state, baseline DML supplied", ['earlyReturnOnly']],
    ['the early exit is widened to the EMPTY state', "IF v_state IN ('LEGACY', 'FINAL') THEN", "IF v_state IN ('LEGACY', 'FINAL', 'EMPTY') THEN", ['earlyReturnOnly', 'gateOrder']],
    ['a statement is added inside the early-exit block', '    RETURN;\n  END IF;', "    EXECUTE 'select 1';\n    RETURN;\n  END IF;", ['earlyReturnOnly', 'grantOnlyFromBase']],
    ['the fail-closed gate no longer stops on OTHER', "IF v_distinct <> 1 OR v_state = 'OTHER' THEN", 'IF v_distinct <> 1 THEN', ['gateOrder']],
    ['the exact post-condition is disabled', 'IF v_offenders IS NOT NULL THEN', 'IF false THEN', ['gateOrder']],
    ['the PG >= 17 gate of PLATFORM-NEW is removed', 'CASE WHEN v_pg17 THEN string_agg(', 'CASE WHEN true THEN string_agg(', ['platformGuards']],
    ['the PLATFORM-NEW guard of the post-condition union is removed', "WHERE v_state = 'PLATFORM-NEW') u", ') u', ['platformGuards']],
    ['the non-DML privilege set of PLATFORM-NEW loses one privilege', "ARRAY['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE']", "ARRAY['MAINTAIN','REFERENCES','TRIGGER']", ['platformGuards']],
    ['the owner exclusion of the compared ACL string is removed', 'x.grantee <> c.relowner', 'true', ['aclComparison'], 2],
    ['the grant option is no longer part of the compared ACL string', 'x.is_grantable::text', "'false'", ['aclComparison'], 2],
    ['a REVOKE is added', GRANT_LINE, '  REVOKE ALL ON TABLE public.profiles FROM anon;\n' + GRANT_LINE, ['noOtherDdl']],
    ['default privileges are altered', GRANT_LINE, '  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;\n' + GRANT_LINE, ['noOtherDdl', 'grantOnlyFromBase']],
  ]

  it.each(controls)('%s', (_name, from, to, mustFlip, n) => {
    const code = stripComments(mutate(from, to, n))
    for (const k of mustFlip) expect(checks[k](code), `${k} must be false on this broken copy`).toBe(false)
  })

  it('the old, weaker assertion (any occurrence of jsonb_array_elements(c_base) e) would have passed the c_final-fed loop: the loop check is what catches it', () => {
    const code = stripComments(mutate('FROM jsonb_array_elements(c_base) e\n  LOOP', 'FROM jsonb_array_elements(c_final) e\n  LOOP'))
    expect(code.includes('FROM jsonb_array_elements(c_base) e')).toBe(true) // still true, via the post-condition CTE
    expect(checks.grantOnlyFromBase(code)).toBe(false)
  })

  it('comments are not executable: grants, RETURNs and DDL inside -- or /* */ comments neither trip nor hide anything, and stripping is what makes that so', () => {
    const withComments = SQL.replace('BEGIN;\n', 'BEGIN;\n-- GRANT ALL ON TABLE public.profiles TO anon; RETURN; REVOKE ALL\n/* GRANT ALL ON TABLE public.profiles TO anon;\n   RETURN;\n   DROP TABLE public.profiles; */\n')
    expect(withComments).not.toBe(SQL)
    const code = stripComments(withComments)
    for (const k of Object.keys(checks) as Key[]) expect(checks[k](code), k).toBe(true)
    expect(code.replace(/\n+/g, '\n')).toBe(CODE.replace(/\n+/g, '\n')) // nothing but blank lines is left of the inserted comments
    // without the stripping the same text would be rejected
    expect(checks.grantOnlyFromBase(withComments)).toBe(false)
    expect(checks.earlyReturnOnly(withComments)).toBe(false)
  })

  it('data controls: a TRUNCATE privilege, an anon row, a foreign table, a duplicate or a dropped row make c_base invalid; an altered row makes c_final differ from the catalog transcription', () => {
    expect(baseDataOk(BASE, TABLES)).toBe(true)
    const row0 = BASE[0]
    expect(baseDataOk([...BASE.slice(1), [row0[0], row0[1], `${row0[2]},TRUNCATE`]], TABLES)).toBe(false)
    expect(baseDataOk([...BASE.slice(1), [row0[0], 'anon', row0[2]]], TABLES)).toBe(false)
    expect(baseDataOk([...BASE.slice(1), ['not_a_baseline_table', row0[1], row0[2]]], TABLES)).toBe(false)
    expect(baseDataOk([...BASE, row0], TABLES)).toBe(false)
    expect(baseDataOk(BASE.slice(1), TABLES)).toBe(false)
    expect(finalEquals(FINAL)).toBe(true)
    expect(finalEquals([['ai_usage_logs', 'authenticated', 'INSERT,SELECT,DELETE'], ...FINAL.slice(1)])).toBe(false)
    expect(finalEquals(FINAL.slice(1))).toBe(false)
  })

  it('the table list parser is exact: the real list has 14 tables and a list with one name removed is detected', () => {
    expect(tablesOf(SQL)).toHaveLength(14)
    expect(tablesOf(mutate("'ai_usage_logs',", ''))).toHaveLength(13)
  })
})
