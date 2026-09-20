// PFM Public Schema Privilege Hardening v1 -- DB-free source policy for
// migration 090 and its read-only topology guard. Pins the contract that must
// never regress: atomic BEGIN/COMMIT, the pre-state contract runs BEFORE the
// first REVOKE, the only mutation is the catalog-driven REVOKE of the four
// extra table privileges, and there is no way around the platform-owned
// supabase_admin default ACL (no ALTER DEFAULT PRIVILEGES, no SET ROLE, no
// event trigger, no dynamic privilege workaround).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const MIGRATION_PATH = path.join(ROOT, 'supabase', 'migrations', '090_public_schema_privilege_hardening.sql')
const GUARD_PATH = path.join(ROOT, 'scripts', 'public-schema-privilege-guard.sql')
const DOC_PATH = path.join(ROOT, 'docs', 'operations', 'public-schema-privilege-hardening.md')

const migration = readFileSync(MIGRATION_PATH, 'utf8')
const guard = readFileSync(GUARD_PATH, 'utf8')
const doc = readFileSync(DOC_PATH, 'utf8')

function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
}

function pinned(tag: string): string[] {
  const match = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(migration)
  if (!match) throw new Error(`pinned block ${tag} not found`)
  return JSON.parse(match[1]) as string[]
}

function md5Sorted(lines: string[]): string {
  return createHash('md5').update([...lines].sort().join('\n')).digest('hex')
}

describe('090 migration source policy', () => {
  const code = stripSqlComments(migration)

  it('is a normally named, ASCII-only, LF-only file and the only 090 migration (later migrations, e.g. 091, may follow it)', () => {
    const names = readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort()
    expect(names.filter((n) => n.startsWith('090'))).toEqual(['090_public_schema_privilege_hardening.sql'])
    expect(names[names.length - 1] >= '090_public_schema_privilege_hardening.sql').toBe(true)
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(migration)).toBe(false)
    expect(migration.includes('\r')).toBe(false)
  })

  it('is atomic: exactly one BEGIN and one COMMIT, COMMIT last', () => {
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(code.trimStart().startsWith('BEGIN;')).toBe(true)
  })

  it('documents the platform-owned residual, what it fixes and cannot modify, and how drift is detected', () => {
    const header = migration.slice(0, migration.indexOf('BEGIN;'))
    for (const needle of [
      'PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL',
      'MIT JAVIT A 090',
      'MIT NEM TUD MODOSITANI',
      'MIERT PLATFORM-OWNED A RESIDUAL',
      'FELSO KORLAT',
      'scripts/public-schema-privilege-guard.sql',
      'docs/operations/public-schema-privilege-hardening.md',
      'Supabase support',
      'Automatically expose new tables',
    ]) {
      expect(header, needle).toContain(needle)
    }
    for (const needle of ['PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL', 'Automatically expose new tables', 'Supabase support', 'Extension policy']) {
      expect(doc, needle).toContain(needle)
    }
  })

  it('has no workaround around the platform-owned default ACL and no other mutation than the REVOKE', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['ALTER DEFAULT PRIVILEGES', /ALTER\s+DEFAULT\s+PRIVILEGES/i],
      ['SET ROLE', /\bSET\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i],
      ['SET SESSION AUTHORIZATION', /SESSION\s+AUTHORIZATION/i],
      ['EVENT TRIGGER', /EVENT\s+TRIGGER/i],
      ['GRANT', /\bGRANT\b/i],
      ['CREATE', /\bCREATE\b/i],
      ['ALTER', /\bALTER\b/i],
      ['DROP', /\bDROP\b/i],
      ['INSERT INTO', /\bINSERT\s+INTO\b/i],
      ['UPDATE ... SET', /\bUPDATE\s+[\w."]+\s+SET\b/i],
      ['DELETE FROM', /\bDELETE\s+FROM\b/i],
      ['TRUNCATE TABLE statement', /\bTRUNCATE\s+(TABLE\s+)?[\w."]+\s*;/i],
      ['ROW LEVEL SECURITY', /ROW\s+LEVEL\s+SECURITY/i],
      ['SECURITY DEFINER', /SECURITY\s+DEFINER/i],
      ['SET SCHEMA', /SET\s+SCHEMA/i],
      ['SECURITY LABEL', /SECURITY\s+LABEL/i],
      ['pg_catalog write', /\b(UPDATE|DELETE|INSERT)\b[^;]*\bpg_(class|proc|default_acl|extension)\b/i],
    ]
    for (const [label, pattern] of forbidden) {
      expect(pattern.test(code), label).toBe(false)
    }
    // The single mutation: one dynamic, catalog-driven REVOKE of exactly the four extra privileges.
    const revokes = code.match(/REVOKE\b[^;]*/gi) ?? []
    expect(revokes).toHaveLength(1)
    expect((revokes[0] ?? '').replace(/\s+/g, ' ')).toBe("REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE %s FROM %s', r.rel, r.grantee_sql)")
    expect(code.match(/EXECUTE\s+format\(/gi)).toHaveLength(1)
  })

  it('runs the whole pre-state contract before the first REVOKE (fail-fast before any table grant modification)', () => {
    const firstRevoke = code.search(/REVOKE\s+TRUNCATE/)
    expect(firstRevoke).toBeGreaterThan(0)
    for (const marker of [
      '089 capability RPC missing or body hash changed',
      'application function contract drift',
      'pg_trgm allowlist drift',
      'callable by PUBLIC or anon',
      'extension policy violated',
      'authenticated keeper DML set changed',
      'service_role keeper DML set changed',
      'column-level ACL set changed',
      'RLS enabled/forced topology changed',
      'PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL): default ACL in schema public EXCEEDS',
      'PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL): global default ACL EXCEEDS',
    ]) {
      const at = code.indexOf(marker)
      expect(at, marker).toBeGreaterThan(-1)
      expect(at, `${marker} must precede the first REVOKE`).toBeLessThan(firstRevoke)
    }
    // the end-state validation follows the REVOKE
    expect(code.indexOf('effective TRUNCATE/REFERENCES/TRIGGER/MAINTAIN privileges remain')).toBeGreaterThan(firstRevoke)
    expect(code).toMatch(/FOR v_phase IN 1\.\.2 LOOP/)
  })

  it('pins exactly 77 application functions and a 31-function pg_trgm allowlist with recorded hashes', () => {
    const app = pinned('pin_app')
    const trgm = pinned('pin_trgm')
    expect(app).toHaveLength(77)
    expect(trgm).toHaveLength(31)
    expect(new Set(app).size).toBe(77)
    expect(new Set(trgm).size).toBe(31)
    expect(md5Sorted(trgm)).toBe('eaaf46529ec704fadcc08759534bc903')
    expect(md5Sorted(app)).toBe('9eb82e3e7f28f01b338fc6634ec16fe0')
    for (const line of trgm) {
      expect(line).toMatch(/\|owner=supabase_admin\|kind=f\|secdef=false\|vol=[isv]\|body=[0-9a-f]{32}$/)
    }
    for (const line of app) {
      expect(line).toMatch(/\|owner=postgres\|kind=f\|secdef=(true|false)\|vol=[isv]\|cfg=.*\|acl=.*\|body=[0-9a-f]{32}$/)
      // no application function may ever be pinned with a PUBLIC or anon EXECUTE
      expect(line).not.toMatch(/\|acl=[^|]*(PUBLIC:|anon:)/)
      // every SECURITY DEFINER application function pins a fixed search_path
      if (line.includes('|secdef=true|')) expect(line).toMatch(/\|cfg=search_path=/)
    }
    expect(app.filter((l) => l.startsWith('get_semantic_topic_lifecycle_reviewer_capability(')).length).toBe(1)
  })

  it('records the platform default ACL as an upper bound, with no PUBLIC grantee and no unexpected object type', () => {
    const bound = pinned('pin_dp')
    const owners = new Set(bound.map((t) => t.split('|')[0]))
    expect([...owners].sort()).toEqual(['postgres', 'supabase_admin'])
    const types = new Set(bound.map((t) => t.split('|')[1]))
    expect([...types].sort()).toEqual(['S', 'f', 'r'])
    for (const tuple of bound) expect(tuple.split('|')[2]).not.toBe('PUBLIC')
    // the postgres-owned public default is owner-only (046)
    expect(bound.filter((t) => t.startsWith('postgres|')).every((t) => t.split('|')[2] === 'postgres')).toBe(true)
    const globalBound = pinned('pin_dg')
    expect(globalBound).toEqual(['postgres|f|postgres|EXECUTE'])
    // the migration only READS pg_default_acl
    expect(code).toMatch(/FROM pg_default_acl d/)
  })

  it('pins the keeper DML, column ACL and RLS digests', () => {
    expect(migration).toMatch(/c_dml_auth_count CONSTANT int := 23;/)
    expect(migration).toMatch(/c_dml_service_count CONSTANT int := 200;/)
    expect(migration).toMatch(/c_colacl_count CONSTANT int := 81;/)
    expect(migration).toMatch(/c_rls_count CONSTANT int := 82;/)
    for (const name of ['c_dml_auth_digest', 'c_dml_service_digest', 'c_colacl_digest', 'c_rls_digest']) {
      expect(migration).toMatch(new RegExp(`${name} CONSTANT text := '[0-9a-f]{32}';`))
    }
    expect(migration).toMatch(/c_cap089_body CONSTANT text := '141a93f922973dc9b2b20dc8df7e2de0';/)
  })
})

describe('090 read-only topology guard source policy', () => {
  const code = stripSqlComments(guard)

  it('is ASCII, read-only and wrapped in BEGIN ... ROLLBACK', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(guard)).toBe(false)
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(code.match(/^ROLLBACK;$/gm)).toHaveLength(1)
    // relay-compatible: outside the two dollar-quoted upper-bound literals (data, not statements)
    // the interactive relay's write-keyword guard must not trip on the file
    const withoutLiterals = code.replace(/\$guard_(dp|dg)\$[\s\S]*?\$guard_\1\$/g, '')
    expect(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|perform|vacuum|set\s+role)\b/i.test(withoutLiterals)).toBe(false)
  })

  it('covers table, sequence, function, extension and default-ACL drift and emits a machine-readable result', () => {
    for (const kind of [
      'table_anon_privilege',
      'table_public_privilege',
      'table_extra_privilege',
      'table_effective_extra_privilege',
      'table_rls_disabled',
      'sequence_broad_privilege',
      'function_public_or_anon_execute',
      'pg_trgm_allowlist_size',
      'extension_in_public',
      'foreign_extension_function_in_public',
      'default_acl_public_exceeds_bound',
      'default_acl_global_exceeds_bound',
    ]) {
      expect(guard, kind).toContain(`VIOLATION|${kind}|`)
    }
    expect(guard).toContain('GUARD_RESULT|violations=')
  })

  it('embeds the same default ACL upper bound as the migration', () => {
    const bound = pinned('pin_dp')
    const embedded = /\$guard_dp\$([\s\S]*?)\$guard_dp\$/.exec(guard)
    expect(embedded).not.toBeNull()
    expect(JSON.parse(embedded![1])).toEqual(bound)
    const globalEmbedded = /\$guard_dg\$([\s\S]*?)\$guard_dg\$/.exec(guard)
    expect(JSON.parse(globalEmbedded![1])).toEqual(pinned('pin_dg'))
  })

  it('ships next to its documentation', () => {
    expect(existsSync(DOC_PATH)).toBe(true)
  })
})
