// Creator Focus 2B -- static source policy for migration 094 (profiles field revisions). NO database needed.
//
// WHAT THIS PINS: the SQL text of the migration to the revision rules (see tests/support/profile-revision-model.ts and
// docs/operations/profiles-field-revision.md). WHAT IT DOES NOT PROVE: that the trigger behaves like that when it runs.
// The real trigger behaviour, the DDL syntax and the catalog post-checks are UNVERIFIED until a database runs them
// (open item, see the runbook).
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { REVISION_PATTERN } from '@/lib/creator-focus'
import { BLOCK_TEXT_MD5, EXPECTED_TOP_LEVEL, analyzeMigration094 } from './support/migration-094-policy'

const ROOT = path.resolve(__dirname, '..')
const MIGRATION_FILE = '094_profiles_field_revision.sql'
const SQL = readFileSync(path.join(ROOT, 'supabase', 'migrations', MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n')
const DOC = readFileSync(path.join(ROOT, 'docs', 'operations', 'profiles-field-revision.md'), 'utf8').replace(/\r\n/g, '\n')

const WITHOUT_COMMENTS = SQL.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
const FUNCTIONS = [...WITHOUT_COMMENTS.matchAll(/CREATE FUNCTION (public\.\w+)\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$;/g)]
  .map(m => ({ name: m[1], body: m[2], whole: m[0] }))
const ASSIGN = FUNCTIONS.find(f => f.name === 'public.profiles_field_revision_assign')!
const ASSERT = FUNCTIONS.find(f => f.name === 'public.profiles_field_revision_assert')!
const WITHOUT_BODIES = WITHOUT_COMMENTS.replace(/\$function\$[\s\S]*?\$function\$/g, '').replace(/\$(pre|seq|post)\$[\s\S]*?\$\1\$/g, '')
const STATEMENTS = WITHOUT_BODIES.replace(/'(?:[^']|'')*'/g, "''")
// the DO blocks (comments and string literals stripped): the data-statement scan must reach them too, because a
// DML statement hidden in a pre/post-check would not be seen by the STATEMENTS scan
const DO_BLOCKS = Object.fromEntries(
  (['pre', 'seq', 'post'] as const).map(tag => [
    tag,
    (new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(WITHOUT_COMMENTS)?.[1] ?? '').replace(/'(?:[^']|'')*'/g, "''"),
  ]),
) as Record<'pre' | 'seq' | 'post', string>
/** the RAISE EXCEPTION messages of each DO block, in order (string literals kept, comments stripped) */
const RAW_RAISES = Object.fromEntries(
  (['pre', 'seq', 'post'] as const).map(tag => [
    tag,
    [...(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(WITHOUT_COMMENTS)?.[1] ?? '').matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'/g)].map(m => m[1]),
  ]),
) as Record<'pre' | 'seq' | 'post', string[]>
const RAW_FUNCTION_BODIES = new Map(
  [...SQL.matchAll(/CREATE FUNCTION (public\.\w+)\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$;/g)].map(m => [m[1], m[2]] as const),
)
const bodyMd5 = (name: string) => createHash('md5').update(RAW_FUNCTION_BODIES.get(name) ?? '').digest('hex')
// the trigger DDL legitimately says INSERT OR UPDATE; the data-statement scan excludes exactly those two statements
const DATA_SCAN = STATEMENTS.replace(/CREATE TRIGGER[\s\S]*?;/g, '')

describe('the migration file', () => {
  it('is the only 094 and has the expected name', () => {
    const files = readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql'))
    expect(files.filter(f => f.startsWith('094'))).toEqual([MIGRATION_FILE])
  })

  it('is one transaction with bounded lock and statement timeouts, an exclusive table lock BEFORE the pre-checks, and a PostgREST reload', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1)
    const lockTimeout = /^SET LOCAL lock_timeout = '(\d+)s';$/m.exec(SQL)
    const statementTimeout = /^SET LOCAL statement_timeout = '(\d+)s';$/m.exec(SQL)
    expect(lockTimeout, 'a lock_timeout in seconds').not.toBeNull()
    expect(statementTimeout, 'a statement_timeout in seconds').not.toBeNull()
    // never 0 (= unlimited) and never an hour: a bound that actually bounds
    expect(Number(lockTimeout![1])).toBeGreaterThanOrEqual(1)
    expect(Number(lockTimeout![1])).toBeLessThanOrEqual(30)
    expect(Number(statementTimeout![1])).toBeGreaterThanOrEqual(10)
    expect(Number(statementTimeout![1])).toBeLessThanOrEqual(300)
    expect(SQL).toMatch(/^LOCK TABLE public\.profiles IN ACCESS EXCLUSIVE MODE;$/m)
    expect(SQL).toMatch(/^NOTIFY pgrst, 'reload schema';$/m)
    const order = ['SET LOCAL lock_timeout', 'SET LOCAL statement_timeout', 'LOCK TABLE', '$pre$', 'CREATE SEQUENCE', 'CREATE TEMP TABLE', 'ADD COLUMN'].map(k => WITHOUT_COMMENTS.indexOf(k))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order) // the pre-checks run AFTER the table lock
  })

  it('is plain ASCII (no CR-only line ends, no non-ASCII characters), like the other migrations', () => {
    const raw = readFileSync(path.join(ROOT, 'supabase', 'migrations', MIGRATION_FILE), 'utf8')
    // eslint-disable-next-line no-control-regex
    expect(raw).not.toMatch(/[^\x00-\x7F]/)
    expect(raw.replace(/\r\n/g, '\n')).not.toMatch(/\r/)
  })

  it('does NOT pin a run status into the migration text (that would go stale); it points to the runbook and states the limits', () => {
    const header = SQL.split('\nBEGIN;')[0].replace(/\n--\s?/g, ' ')
    // the run status lives in the runbook ("Futasi statusz"); a status baked into the migration would have to lie
    // after the first real run, or force an edit of an already-reviewed migration
    expect(header).not.toMatch(/NEM FUTTATOTT|NEM REVIEWZOTT|nem futott/i)
    expect(header).toMatch(/docs\/operations\/profiles-field-revision\.md/)
    expect(header).toMatch(/DB-mentes teszt NEM\s+bizonyitja/)
    expect(header).toMatch(/GARANCIA HATARA/)
    expect(header).toMatch(/DISABLE TRIGGER/)
    expect(header).toMatch(/nem commit-sorrend/)
  })
})

describe('what the migration creates and what it must not do', () => {
  it('creates exactly: a sequence (in a guarded DO), a temp table, two columns, constraints, two unique indexes, two functions, two triggers', () => {
    const creates = (WITHOUT_COMMENTS.match(/CREATE\s+(OR\s+REPLACE\s+)?(TEMP\s+)?(UNIQUE\s+)?(FUNCTION|TRIGGER|TABLE|INDEX|SEQUENCE|VIEW|POLICY)\s+[^\n]*/gi) ?? [])
      .map(c => c.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' '))
    expect(creates).toEqual([
      'CREATE SEQUENCE public.profiles_field_revision_seq AS bigint',
      'CREATE TEMP TABLE profiles_094_before ON',
      'CREATE UNIQUE INDEX profiles_specific_focus_revision_key ON',
      'CREATE UNIQUE INDEX profiles_main_category_revision_key ON',
      'CREATE FUNCTION public.profiles_field_revision_assign()',
      'CREATE FUNCTION public.profiles_field_revision_assert()',
      'CREATE TRIGGER profiles_zz_revision_assign',
      'CREATE TRIGGER profiles_zz_revision_assert',
    ])
  })

  it('NEVER resets, drops or re-seeds the sequence (a revision must never be reused, even across rollback + re-apply)', () => {
    expect(WITHOUT_COMMENTS).not.toMatch(/\bsetval\b/i)
    expect(WITHOUT_COMMENTS).not.toMatch(/\bRESTART\b/i)
    expect(WITHOUT_COMMENTS).not.toMatch(/ALTER\s+SEQUENCE/i)
    expect(WITHOUT_COMMENTS).not.toMatch(/DROP\s+SEQUENCE/i)
    expect(WITHOUT_COMMENTS).not.toMatch(/\bTRUNCATE\b/i)
  })

  it('has no data statements: no UPDATE / DELETE / INSERT / COPY on any table (the one-off backfill is a column DEFAULT, not an UPDATE)', () => {
    expect(DATA_SCAN).not.toMatch(/\b(UPDATE|DELETE|INSERT|COPY|CALL|VACUUM)\b/i)
  })

  it('the DO blocks are read-only checks: no DML / DDL / privilege statement hides in $pre$ or $post$, and $seq$ only creates the sequence', () => {
    const forbiddenInChecks = /\b(UPDATE|DELETE|INSERT|TRUNCATE|COPY|CALL|VACUUM|DROP|ALTER|GRANT|REVOKE|CREATE|LOCK|SET|NOTIFY|PERFORM|EXECUTE)\b/i
    expect(DO_BLOCKS.pre).toMatch(/\bRAISE EXCEPTION\b/) // the blocks are not empty (the extraction works)
    expect(DO_BLOCKS.post).toMatch(/\bRAISE EXCEPTION\b/)
    expect(DO_BLOCKS.pre).not.toMatch(forbiddenInChecks)
    expect(DO_BLOCKS.post).not.toMatch(forbiddenInChecks)
    expect(DO_BLOCKS.seq).toMatch(/\bCREATE SEQUENCE public\.profiles_field_revision_seq\b/)
    expect(DO_BLOCKS.seq).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE|COPY|CALL|VACUUM|DROP|ALTER|GRANT|REVOKE|PERFORM|EXECUTE|setval)\b/i)
    expect(DO_BLOCKS.seq.match(/\bCREATE\b/g)).toHaveLength(1)
  })

  it('the pre-check is exactly the expected fail-fast list and can never return early or be switched off', () => {
    expect(RAW_RAISES.pre).toEqual([
      '094 fail-closed: public.profiles is missing',
      '094 fail-closed: profiles.specific_focus / profiles.main_category must both exist as text',
      '094 fail-closed: a revision column already exists (partially applied?)',
      '094 fail-closed: a revision trigger function already exists (partially applied?)',
      '094 fail-closed: a revision trigger already exists (partially applied?)',
      '094 fail-closed: a revision index already exists (partially applied?)',
      '094 fail-closed: a BEFORE ROW trigger on profiles would fire after the revision trigger',
    ])
    expect(DO_BLOCKS.pre).not.toMatch(/\bRETURN\b|\bEXIT\b|\bIF\s+(false|true)\b|\bNULL\s*;/i)
  })

  it('has no GRANT (only REVOKE), and no DROP of anything but the two column defaults', () => {
    expect(WITHOUT_COMMENTS).not.toMatch(/\bGRANT\b/i)
    const drops = (STATEMENTS.match(/\bDROP\b[^\n;]*/gi) ?? []).map(d => d.replace(/\s+/g, ' ').trim())
    // the temp table's ON COMMIT DROP, then ALTER COLUMN ... DROP DEFAULT (x2)
    expect(drops).toEqual(['DROP AS', 'DROP DEFAULT,', 'DROP DEFAULT'])
  })

  it('the sequence is bigint, CACHE 1, NO CYCLE, increment 1, and is not left readable/usable by the app roles', () => {
    expect(WITHOUT_COMMENTS).toMatch(/CREATE SEQUENCE public\.profiles_field_revision_seq AS bigint INCREMENT BY 1 MINVALUE 1 START WITH 1 CACHE 1 NO CYCLE;/)
    expect(WITHOUT_COMMENTS).toMatch(/REVOKE ALL ON SEQUENCE public\.profiles_field_revision_seq FROM PUBLIC, anon, authenticated, service_role;/)
    // an existing sequence is validated, not trusted
    expect(WITHOUT_COMMENTS).toMatch(/seqtypid = 'bigint'::regtype AND seqincrement = 1 AND seqmin = 1/)
    expect(WITHOUT_COMMENTS).toMatch(/seqcache = 1 AND NOT seqcycle/)
  })
})

describe('the columns', () => {
  it('are bigint NOT NULL, back-filled by a volatile DEFAULT in the ALTER (rewrite, no UPDATE), and then the DEFAULT is dropped', () => {
    expect(WITHOUT_COMMENTS).toMatch(/ADD COLUMN specific_focus_revision bigint NOT NULL DEFAULT nextval\('public\.profiles_field_revision_seq'\)/)
    expect(WITHOUT_COMMENTS).toMatch(/ADD COLUMN main_category_revision\s+bigint NOT NULL DEFAULT nextval\('public\.profiles_field_revision_seq'\)/)
    expect(WITHOUT_COMMENTS).toMatch(/ALTER COLUMN specific_focus_revision DROP DEFAULT/)
    expect(WITHOUT_COMMENTS).toMatch(/ALTER COLUMN main_category_revision\s+DROP DEFAULT/)
    expect(WITHOUT_COMMENTS.indexOf('ADD COLUMN specific_focus_revision')).toBeLessThan(WITHOUT_COMMENTS.indexOf('DROP DEFAULT'))
  })

  it('are positive and unique among live rows', () => {
    expect(WITHOUT_COMMENTS).toMatch(/CHECK \(specific_focus_revision > 0\)/)
    expect(WITHOUT_COMMENTS).toMatch(/CHECK \(main_category_revision > 0\)/)
    expect(WITHOUT_COMMENTS).toMatch(/CREATE UNIQUE INDEX profiles_specific_focus_revision_key ON public\.profiles \(specific_focus_revision\);/)
    expect(WITHOUT_COMMENTS).toMatch(/CREATE UNIQUE INDEX profiles_main_category_revision_key\s+ON public\.profiles \(main_category_revision\);/)
  })

  it('a bigint revision always fits the decision core\'s canonical text form (<= 19 digits)', () => {
    expect(REVISION_PATTERN.test('9223372036854775807')).toBe(true)
    expect(REVISION_PATTERN.test('9223372036854775807'.padStart(20, '1'))).toBe(false)
  })
})

describe('the assigning trigger function', () => {
  it('is SECURITY DEFINER with a pinned search_path, and has no EXECUTE for the app roles', () => {
    for (const fn of FUNCTIONS) {
      expect(fn.whole).toMatch(/SECURITY DEFINER/)
      expect(fn.whole).toMatch(/SET search_path TO 'public', 'pg_temp'/)
      expect(WITHOUT_COMMENTS).toContain(`REVOKE ALL ON FUNCTION ${fn.name}() FROM PUBLIC, anon, authenticated, service_role;`)
    }
    expect(FUNCTIONS).toHaveLength(2)
  })

  it('INSERT: both fields always get a fresh nextval(); a client value is overwritten (assignment, no IS NULL guard)', () => {
    const insertBranch = /IF TG_OP = 'INSERT' THEN([\s\S]*?)ELSIF TG_OP = 'UPDATE' THEN/.exec(ASSIGN.body)?.[1] ?? ''
    expect(insertBranch).toMatch(/NEW\.specific_focus_revision := nextval\('public\.profiles_field_revision_seq'\);/)
    expect(insertBranch).toMatch(/NEW\.main_category_revision := nextval\('public\.profiles_field_revision_seq'\);/)
    expect(insertBranch).not.toMatch(/IS NULL|COALESCE|IF /i)
  })

  it('UPDATE: per field, a fresh nextval() when the value IS DISTINCT FROM the old one, otherwise the OLD revision', () => {
    for (const field of ['specific_focus', 'main_category']) {
      const re = new RegExp(
        `IF NEW\\.${field} IS DISTINCT FROM OLD\\.${field} THEN\\s+NEW\\.${field}_revision := nextval\\('public\\.profiles_field_revision_seq'\\);\\s+ELSE\\s+NEW\\.${field}_revision := OLD\\.${field}_revision;\\s+END IF;`,
      )
      expect(ASSIGN.body).toMatch(re)
    }
  })

  it('uses nextval exactly four times (2 on INSERT, 2 on UPDATE) and nothing else that could pick a revision', () => {
    expect(ASSIGN.body.match(/nextval\(/g)).toHaveLength(4)
    expect(ASSIGN.body).not.toMatch(/\bsetval\b|\bcurrval\b|\bmax\(|\brandom\(|\bnow\(|\bclock_timestamp\(|\buuid/i)
  })

  it('refuses any operation other than INSERT / UPDATE', () => {
    expect(ASSIGN.body).toMatch(/ELSE\s+RAISE EXCEPTION 'profiles_field_revision_assign: unsupported operation %', TG_OP;/)
  })
})

describe('the asserting trigger function (fail-closed)', () => {
  it('checks: set, positive, already issued, the two fields never share a revision', () => {
    expect(ASSERT.body).toMatch(/SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO issued FROM public\.profiles_field_revision_seq;/)
    expect(ASSERT.body).toMatch(/NEW\.specific_focus_revision > issued OR NEW\.main_category_revision > issued/)
    expect(ASSERT.body).toMatch(/NEW\.specific_focus_revision = NEW\.main_category_revision/)
  })

  it('checks on UPDATE, per field: value changed => revision changed; value unchanged => revision unchanged', () => {
    for (const field of ['specific_focus', 'main_category']) {
      expect(ASSERT.body).toMatch(new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}[\\s\\S]*?NEW\\.${field}_revision = OLD\\.${field}_revision`))
      expect(ASSERT.body).toMatch(new RegExp(`ELSIF NEW\\.${field}_revision <> OLD\\.${field}_revision THEN`))
    }
  })

  it('RAISES (does not merely compute) on each of the six violations', () => {
    const raises = (ASSERT.body.match(/RAISE EXCEPTION '[^']*'/g) ?? []).map(r => r.replace(/^RAISE EXCEPTION '|'$/g, ''))
    expect(raises).toEqual([
      'profiles_field_revision_assert: a revision is missing, not positive, or was never issued',
      'profiles_field_revision_assert: two fields share one revision',
      'profiles_field_revision_assert: specific_focus changed without a new revision',
      'profiles_field_revision_assert: specific_focus revision changed without a value change',
      'profiles_field_revision_assert: main_category changed without a new revision',
      'profiles_field_revision_assert: main_category revision changed without a value change',
    ])
    // every violation message is the argument of a statement, never inside a comment or a no-op
    expect(ASSERT.body).not.toMatch(/\bNULL;/)
  })

  it('compares revisions for (in)equality only: it never orders them against each other', () => {
    // the only "<" / ">" comparisons are against the constant 1 and the sequence's issued value
    const orderings = ASSERT.body.match(/NEW\.\w+_revision\s*[<>]=?\s*[\w.]+/g) ?? []
    expect(orderings.every(o => /\s(1|issued)$/.test(o))).toBe(true)
    expect(ASSERT.body).not.toMatch(/OLD\.\w+_revision\s*[<>]/)
  })
})

describe('the triggers', () => {
  it('are exactly BEFORE and AFTER INSERT OR UPDATE FOR EACH ROW, with no OF <column> and no WHEN', () => {
    expect(WITHOUT_COMMENTS).toMatch(/CREATE TRIGGER profiles_zz_revision_assign\s+BEFORE INSERT OR UPDATE ON public\.profiles\s+FOR EACH ROW EXECUTE FUNCTION public\.profiles_field_revision_assign\(\);/)
    expect(WITHOUT_COMMENTS).toMatch(/CREATE TRIGGER profiles_zz_revision_assert\s+AFTER INSERT OR UPDATE ON public\.profiles\s+FOR EACH ROW EXECUTE FUNCTION public\.profiles_field_revision_assert\(\);/)
    const triggerStatements = STATEMENTS.match(/CREATE TRIGGER[\s\S]*?;/g) ?? []
    expect(triggerStatements).toHaveLength(2)
    for (const t of triggerStatements) {
      expect(t).not.toMatch(/\bUPDATE OF\b|\bINSERT OF\b/i)
      expect(t).not.toMatch(/\bWHEN\b/i)
      expect(t).not.toMatch(/FOR EACH STATEMENT/i)
    }
  })

  it('the assigning trigger is named so that it fires AFTER the existing BEFORE trigger (name order, C collation)', () => {
    const existing = 'profiles_updated_at' // supabase/migrations/001_initial_schema.sql
    const compareC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    expect(compareC(existing, 'profiles_zz_revision_assign')).toBe(-1)
    // and the migration fails fast if some other BEFORE ROW trigger would sort after it
    expect(WITHOUT_COMMENTS).toMatch(/\(tgtype & 3\) = 3[\s\S]*?tgname COLLATE "C" > 'profiles_zz_revision_assign'/)
  })

  it('the only pre-existing BEFORE trigger on profiles in the migration history is profiles_updated_at', () => {
    const dir = path.join(ROOT, 'supabase', 'migrations')
    const found = new Set<string>()
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql') && !f.startsWith('094'))) {
      const text = readFileSync(path.join(dir, file), 'utf8')
      for (const m of text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+(BEFORE|AFTER|INSTEAD OF)\s+[^;]*?\bON\s+(?:public\.)?profiles\b/gi)) {
        found.add(`${m[1]}:${m[2].toUpperCase()}`)
      }
    }
    expect([...found].sort()).toEqual(['profiles_updated_at:BEFORE'])
  })
})

describe('the post-check is fail-closed and covers what the rules need', () => {
  const post = /\$post\$([\s\S]*?)\$post\$/.exec(WITHOUT_COMMENTS)?.[1] ?? ''

  it('is exactly the expected list of checks: it cannot be returned from, switched off, or silently dropped', () => {
    expect(RAW_RAISES.post).toEqual([
      '094 post-check failed: the migration changed existing profile data (it must not)',
      '094 post-check failed: backfilled revisions are not all distinct',
      '094 post-check failed: revision columns must be bigint NOT NULL without a default',
      '094 post-check failed: the revision CHECK constraints are missing or not validated',
      '094 post-check failed: the revision unique indexes are missing, invalid, partial or on the wrong column',
      '094 post-check failed: sequence definition drifted',
      '094 post-check failed: the sequence grants privileges to PUBLIC/anon/authenticated/service_role',
      '094 post-check failed: trigger functions must be SECURITY DEFINER, pinned search_path, with no PUBLIC/anon/authenticated/service_role EXECUTE',
      '094 post-check failed: revision triggers are missing, disabled, or have OF/WHEN/arguments',
    ])
    expect(DO_BLOCKS.post).not.toMatch(/\bRETURN\b|\bEXIT\b|\bIF\s+(false|true)\b|\bNULL\s*;/i)
    // every RAISE is the body of an IF ... THEN (no unconditional, no commented-out guard)
    expect(post.match(/\bIF\b[\s\S]*?\bTHEN\s+RAISE EXCEPTION/g)).toHaveLength(RAW_RAISES.post.length)
  })

  it('the existing-data check is a bounded, order-independent per-row hash sum over everything but the two new columns (no giant string_agg)', () => {
    expect(WITHOUT_COMMENTS).not.toMatch(/string_agg/i)
    expect(post).toMatch(/IF a\.rows_count <> b\.rows_count OR a\.row_hash_sum <> b\.row_hash_sum THEN/)
    expect(post).toMatch(/\(to_jsonb\(t\) - 'specific_focus_revision' - 'main_category_revision'\)::text/)
    expect(post).toMatch(/sum\(\(\('x' \|\| substr\(md5\(/)
    // the snapshot taken BEFORE the change uses the same per-row hash on the whole row
    expect(WITHOUT_COMMENTS).toMatch(/CREATE TEMP TABLE profiles_094_before ON COMMIT DROP AS\s+SELECT count\(\*\) AS rows_count,\s+coalesce\(sum\(\(\('x' \|\| substr\(md5\(to_jsonb\(t\)::text\), 1, 16\)\)::bit\(64\)::bigint\)::numeric\), 0\) AS row_hash_sum\s+FROM public\.profiles t;/)
  })

  it('checks distinctness over BOTH columns (UNION ALL, not UNION), column shape, constraints, indexes, sequence and ACLs', () => {
    expect(post).toMatch(/UNION ALL SELECT main_category_revision FROM public\.profiles\) s\)\s+<> \(SELECT count\(DISTINCT v\)/)
    expect(post).toMatch(/udt_name = 'int8' AND is_nullable = 'NO' AND column_default IS NULL\) <> 2/)
    expect(post).toMatch(/contype = 'c' AND convalidated/)
    expect(post).toMatch(/i\.indisunique AND i\.indisvalid AND i\.indnatts = 1 AND i\.indpred IS NULL/)
    expect(post).toMatch(/i\.indkey\[0\] = \(SELECT attnum FROM pg_attribute WHERE attrelid = 'public\.profiles'::regclass AND attname = 'specific_focus_revision'/)
    expect(post).toMatch(/i\.indkey\[0\] = \(SELECT attnum FROM pg_attribute WHERE attrelid = 'public\.profiles'::regclass AND attname = 'main_category_revision'/)
    expect(post).toMatch(/seqmax = 9223372036854775807 AND seqcache = 1 AND NOT seqcycle/)
    // the sequence ACL check includes PUBLIC (grantee = 0) and the three API roles
    expect(post).toMatch(/aclexplode\(c\.relacl\) x\s+WHERE c\.oid = 'public\.profiles_field_revision_seq'::regclass\s+AND \(x\.grantee = 0 OR x\.grantee IN \('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole\)\)/)
  })

  it('checks the functions (SECURITY DEFINER, pinned search_path, explicit non-null ACL without PUBLIC/anon, owner = the table owner) and the trigger shape', () => {
    expect(post).toMatch(/p\.prosecdef AND p\.proconfig = ARRAY\['search_path=public, pg_temp'\] AND p\.proacl IS NOT NULL/)
    expect(post).toMatch(/p\.proowner = \(SELECT relowner FROM pg_class WHERE oid = 'public\.profiles'::regclass\)/)
    expect(post).toMatch(/aclexplode\(p\.proacl\) x\s+WHERE x\.grantee = 0 OR x\.grantee IN \('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole\)\)\) <> 2/)
    expect(post).toMatch(/t\.tgenabled = 'O'/)
    expect(post).toMatch(/t\.tgqual IS NULL AND COALESCE\(array_length\(t\.tgattr::int2\[\], 1\), 0\) = 0 AND t\.tgnargs = 0/)
    expect(post).toMatch(/t\.tgtype = 23 AND p\.proname = 'profiles_field_revision_assign'/)
    expect(post).toMatch(/t\.tgtype = 21 AND p\.proname = 'profiles_field_revision_assert'/)
    expect(post).toMatch(/AND p\.proname = 'profiles_field_revision_assert'\)\)\) <> 2 THEN/)
  })

  it('the pre-check refuses a partial earlier application instead of repairing it', () => {
    const pre = /\$pre\$([\s\S]*?)\$pre\$/.exec(WITHOUT_COMMENTS)?.[1] ?? ''
    expect(pre.match(/partially applied/g)!.length).toBe(4)
  })
})

describe('negative controls: a function that cannot work, or a check that is switched off, must fail HERE (before any database)', () => {
  it.each([
    ['public.profiles_field_revision_assign', 'RETURN NEW;'],
    ['public.profiles_field_revision_assert', 'RETURN NEW;'],
  ])('%s returns NEW on its normal path and never NULL (a RETURN NULL BEFORE trigger would silently cancel every write)', (name, ret) => {
    const body = FUNCTIONS.find(f => f.name === name)!.body
    expect(body).toMatch(/RETURN NEW;\s*END;\s*$/)
    expect(body.match(/\bRETURN\b/g)).toHaveLength(1)
    expect(body).toContain(ret)
    expect(body).not.toMatch(/RETURN NULL|RETURN OLD/)
  })

  it('both are plpgsql trigger functions: RETURNS trigger LANGUAGE plpgsql (not sql, not void)', () => {
    for (const fn of FUNCTIONS) {
      expect(fn.whole).toMatch(/RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER/)
    }
  })

  it('the assigning function ends every branch with an assignment or a RAISE (no branch can leave NEW unchanged by accident)', () => {
    const branches = ASSIGN.body.match(/IF TG_OP = 'INSERT' THEN[\s\S]*?ELSIF TG_OP = 'UPDATE' THEN[\s\S]*?ELSE[\s\S]*?END IF;/)
    expect(branches).not.toBeNull()
  })
})

describe('the static policy analyser (tests/support/migration-094-policy.ts): a TEXT guard, not proof of SQL behaviour', () => {
  /** replace exactly one occurrence; throws when the anchor is missing, so a negative test can never be vacuous */
  const mutate = (from: string, to: string): string => {
    expect(SQL.includes(from), `anchor present: ${from.slice(0, 50)}`).toBe(true)
    return SQL.replace(from, () => to)
  }
  const codes = (sql: string) => analyzeMigration094(sql)

  it('the real migration has no violation', () => {
    expect(codes(SQL)).toEqual([])
  })

  it('the top-level statement list and the three block-text pins are what the analyser pins (change detectors, not proof)', () => {
    expect(EXPECTED_TOP_LEVEL).toHaveLength(22)
    expect(Object.keys(BLOCK_TEXT_MD5)).toEqual(['pre', 'seq', 'post'])
  })

  // The dangerous variants the independent review showed to survive the older regex-fragment tests.
  describe.each([
    ['pre', 'DO $pre$\nBEGIN\n', '$pre$;'],
    ['post', 'DO $post$\nDECLARE', '$post$;'],
  ])('an EXCEPTION wrapper that swallows every failure of the %s block', (tag, head, tail) => {
    it('is reported (exception_block, raise_below_exception, block text changed)', () => {
      expect(SQL.includes(head) && SQL.includes(`END\n${tail}`), `anchors for ${tag}`).toBe(true)
      const wrapped = SQL.replace(`END\n${tail}`, () => `EXCEPTION WHEN OTHERS THEN\n  RAISE NOTICE 'ignored';\nEND\n${tail}`)
      const found = codes(wrapped)
      expect(found).toContain('exception_block')
      expect(found).toContain('raise_below_exception')
      expect(found).toContain(`block_text_changed:${tag}`)
    })
  })

  it.each([
    ['an `AND false` on the post-check sequence-ACL query', "WHERE c.oid = 'public.profiles_field_revision_seq'::regclass", "WHERE c.oid = 'public.profiles_field_revision_seq'::regclass AND false"],
    ['an `AND false` on the post-check function ACL / SECURITY DEFINER query', 'AND p.prosecdef AND p.proconfig', 'AND false AND p.prosecdef AND p.proconfig'],
    ['an `AND false` on the post-check column-shape query', "AND udt_name = 'int8'", "AND false AND udt_name = 'int8'"],
    ['an `AND false` on the post-check CHECK-constraint query', "contype = 'c' AND convalidated", "contype = 'c' AND convalidated AND false"],
    ['an `AND false` on the post-check unique-index query', 'i.indisunique AND i.indisvalid', 'i.indisunique AND false AND i.indisvalid'],
    ['an `AND false` on the pre-check text-column query', "AND column_name IN ('specific_focus', 'main_category') AND udt_name = 'text'", "AND column_name IN ('specific_focus', 'main_category') AND udt_name = 'text' AND false"],
    ['an `AND false` on the pre-check later-named BEFORE trigger query', "AND (tgtype & 3) = 3  -- ROW + BEFORE", "AND false AND (tgtype & 3) = 3  -- ROW + BEFORE"],
    ['an `AND false` on the pre-check existing-trigger-name query', "AND tgname IN ('profiles_zz_revision_assign', 'profiles_zz_revision_assert')", "AND tgname IN ('profiles_zz_revision_assign', 'profiles_zz_revision_assert') AND false"],
    ['a post-check condition turned into a constant `IF false`', "IF a.rows_count <> b.rows_count OR a.row_hash_sum <> b.row_hash_sum THEN", 'IF false THEN'],
  ])('%s is reported as a constant condition', (_name, from, to) => {
    expect(codes(mutate(from, to))).toContain('constant_condition')
  })

  it('a check whose RAISE is replaced by a no-op branch is reported', () => {
    const found = codes(mutate("RAISE EXCEPTION '094 post-check failed: sequence definition drifted';", 'NULL;'))
    expect(found).toContain('no_op_branch')
    expect(found).toContain('block_text_changed:post')
  })

  it('an early RETURN that switches a whole check block off is reported', () => {
    expect(codes(mutate('DO $post$\nDECLARE\n  b record;\n  a record;\nBEGIN\n', 'DO $post$\nDECLARE\n  b record;\n  a record;\nBEGIN\n  RETURN;\n'))).toContain('early_exit_in_check_block')
    expect(codes(mutate('DO $pre$\nBEGIN\n', 'DO $pre$\nBEGIN\n  RETURN;\n'))).toContain('early_exit_in_check_block')
  })

  it('moving BEGIN; behind the SET LOCAL timeouts (they would silently do nothing) is reported', () => {
    const moved = SQL.replace('BEGIN;\n', () => '').replace("SET LOCAL statement_timeout = '60s';\n", () => "SET LOCAL statement_timeout = '60s';\nBEGIN;\n")
    const found = codes(moved)
    expect(found).toContain('begin_not_before_set_local')
    expect(found).toContain('top_level_statements_changed')
  })

  it.each([
    ['DISABLE ROW LEVEL SECURITY', 'ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;'],
    ['NO FORCE ROW LEVEL SECURITY', 'ALTER TABLE public.profiles NO FORCE ROW LEVEL SECURITY;'],
    ['an extra ADD COLUMN', 'ALTER TABLE public.profiles ADD COLUMN zz integer;'],
    ['an owner change', 'ALTER TABLE public.profiles OWNER TO anon;'],
    ['DISABLE TRIGGER', 'ALTER TABLE public.profiles DISABLE TRIGGER profiles_zz_revision_assert;'],
    ['session_replication_role', "SET LOCAL session_replication_role = 'replica';"],
    ['RESET statement_timeout', 'RESET statement_timeout;'],
    ['a later lock_timeout = 0', "SET LOCAL lock_timeout = '0s';"],
    ['an unreviewed GRANT', 'GRANT SELECT ON public.profiles TO anon;'],
    ['a data statement', 'UPDATE public.profiles SET onboarding_completed = true;'],
  ])('an unexpected top-level statement (%s) is reported', (_name, statement) => {
    expect(codes(mutate('NOTIFY pgrst', `${statement}\nNOTIFY pgrst`))).toContain('top_level_statements_changed')
  })

  it('a DO block with an unknown tag that runs dynamic SQL is reported', () => {
    const found = codes(mutate('NOTIFY pgrst', "DO $x$ BEGIN EXECUTE 'UPDATE public.profiles SET onboarding_completed = true'; END $x$;\nNOTIFY pgrst"))
    expect(found).toContain('do_blocks_unexpected')
    expect(found).toContain('top_level_statements_changed')
    expect(found).toContain('dynamic_sql')
  })

  it('a DML statement hidden in a check block or in the sequence block is reported', () => {
    expect(codes(mutate('  SELECT * INTO b FROM profiles_094_before;', '  UPDATE public.profiles SET onboarding_completed = true;\n  SELECT * INTO b FROM profiles_094_before;'))).toContain('dml_or_ddl_in_check_block')
    expect(codes(mutate('DO $seq$\nBEGIN\n', 'DO $seq$\nBEGIN\n  DELETE FROM public.profiles;\n'))).toContain('dml_or_ddl_in_seq_block')
  })

  it('a trigger function that returns NULL, returns nothing, is not plpgsql, or returns void is reported', () => {
    const tail = "  RETURN NEW;\nEND;\n$function$;\n\n-- ------------------------------------------------------------\n-- 5."
    expect(SQL.includes(tail), 'anchor for the assign function end').toBe(true)
    expect(codes(SQL.replace(tail, () => tail.replace('RETURN NEW;', 'RETURN NULL;')))).toContain('function_return')
    expect(codes(SQL.replace(tail, () => tail.replace('  RETURN NEW;\n', '')))).toContain('function_return')
    expect(codes(mutate('RETURNS trigger\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO \'public\', \'pg_temp\'\nAS $function$\nBEGIN\n  IF TG_OP', 'RETURNS trigger\n LANGUAGE sql\n SECURITY DEFINER\n SET search_path TO \'public\', \'pg_temp\'\nAS $function$\nBEGIN\n  IF TG_OP'))).toContain('function_header')
  })

  it('unbounded or missing timeouts and a non-ASCII character are reported', () => {
    expect(codes(mutate("SET LOCAL lock_timeout = '5s';", "SET LOCAL lock_timeout = '0s';"))).toContain('lock_timeout_unbounded')
    expect(codes(mutate("SET LOCAL lock_timeout = '5s';", "SET LOCAL lock_timeout = '3600s';"))).toContain('lock_timeout_unbounded')
    expect(codes(mutate("SET LOCAL statement_timeout = '60s';\n", ''))).toContain('statement_timeout_unbounded')
    expect(codes(mutate("SET LOCAL statement_timeout = '60s';", "SET LOCAL statement_timeout = '0s';"))).toContain('statement_timeout_unbounded')
    expect(codes(mutate('-- 4. A kiosztott', '-- 4. A kiosztó'))).toContain('non_ascii')
  })

  it('the LOCK moved behind the pre-check is reported (the pre-check would run unlocked)', () => {
    const moved = SQL.replace('LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;\n', () => '').replace('-- 1. A szekvencia:', () => 'LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;\n-- 1. A szekvencia:')
    expect(codes(moved)).toContain('lock_or_timeouts_not_before_pre_check')
  })

  it('the sequence block\'s own fail-fast message is pinned (it was defined but never asserted)', () => {
    expect(RAW_RAISES.seq).toEqual(['094 fail-closed: an existing profiles_field_revision_seq has an unexpected definition'])
  })
})

describe('the isolated-PostgreSQL probe script (scripts/profiles-field-revision-probe.sql): a non-skippable contract, checked as TEXT only', () => {
  const PROBE = readFileSync(path.join(ROOT, 'scripts', 'profiles-field-revision-probe.sql'), 'utf8').replace(/\r\n/g, '\n')
  const probeCode = PROBE.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
  const ids = Array.from({ length: 16 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`)

  it('is one transaction that ends in ROLLBACK (nothing it changes survives), stops on the first error, and never commits', () => {
    expect(probeCode).toMatch(/^\\set ON_ERROR_STOP on$/m)
    expect(probeCode.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(probeCode.trimEnd().endsWith('ROLLBACK;')).toBe(true)
    const noLiterals = probeCode.replace(/E?'(?:[^']|'')*'/g, "''")
    expect(noLiterals).not.toMatch(/\bCOMMIT\b/i)
    expect(noLiterals).not.toMatch(/\b(TRUNCATE|DELETE|DROP|GRANT|REVOKE|CREATE)\b/i)
  })

  it('has exactly 16 checks C01..C16: each a DO block that RAISEs PROBE_FAIL, followed by its own PROBE_PASS line, in order; the last line is PROBE_RESULT checks=16', () => {
    const passes = [...probeCode.matchAll(/^SELECT 'PROBE_PASS\|(C\d\d)_[a-z0-9_]+';$/gm)].map(m => m[1])
    expect(passes).toEqual(ids)
    const doTags = [...probeCode.matchAll(/^DO \$(c\d\d)\$$/gm)].map(m => m[1].toUpperCase())
    expect(doTags).toEqual(ids)
    for (const id of ids) {
      const block = new RegExp(`DO \\$${id.toLowerCase()}\\$([\\s\\S]*?)\\$${id.toLowerCase()}\\$;`).exec(probeCode)?.[1] ?? ''
      expect(block, id).toMatch(new RegExp(`RAISE EXCEPTION 'PROBE_FAIL\\|${id}\\b`))
      // the PASS line of this check comes after its block and before the next block
      expect(probeCode.indexOf(`'PROBE_PASS|${id}_`), id).toBeGreaterThan(probeCode.indexOf(`$${id.toLowerCase()}$;`))
    }
    expect(probeCode.trimEnd().split('\n').filter(l => l.trim() !== '' && l.trim() !== 'ROLLBACK;').pop()).toBe("SELECT 'PROBE_RESULT|checks=16';")
    expect(PROBE).toMatch(/exactly 16 lines starting `PROBE_PASS\|C01` \.\.\. `C16`/)
    expect(PROBE).toMatch(/There is no "skipped" state/)
  })

  it('no check can pass silently: nothing swallows errors except the two EXPECTED-error catches (C14, C15), no constant conditions, no notices', () => {
    expect(probeCode).not.toMatch(/\bRAISE\s+(NOTICE|WARNING|INFO|LOG|DEBUG)\b/i)
    expect(probeCode).not.toMatch(/\b(?:AND|OR|IF|ELSIF|WHERE|WHEN)\s+(?:NOT\s+)?(?:false|true)\b/i)
    expect(probeCode).not.toMatch(/\bTHEN\s+(?:NULL|PERFORM\s+[^;]*)\s*;/i)
    expect(probeCode.match(/EXCEPTION WHEN OTHERS THEN/g)).toHaveLength(2)
    for (const id of ['c14', 'c15']) {
      const block = new RegExp(`DO \\$${id}\\$([\\s\\S]*?)\\$${id}\\$;`).exec(probeCode)?.[1] ?? ''
      expect(block).toMatch(/EXCEPTION WHEN OTHERS THEN\s+caught := SQLERRM;/)
      expect(block).toMatch(/IF caught IS NULL OR caught NOT LIKE '%[^']+%' THEN\s+RAISE EXCEPTION 'PROBE_FAIL\|C1[45]/) // a caught error must be the EXPECTED one
      expect(block.match(/DISABLE TRIGGER profiles_zz_revision_assign/g)).toHaveLength(1)
      expect(block.match(/ENABLE TRIGGER profiles_zz_revision_assign/g)).toHaveLength(1)
    }
  })

  it('changes data only for the one synthetic user (every UPDATE has WHERE user_id = u; the single INSERT is the ON CONFLICT e2e shape)', () => {
    const updates = [...probeCode.matchAll(/UPDATE public\.profiles SET [^;]*;/g)].map(m => m[0])
    expect(updates.length).toBeGreaterThanOrEqual(10)
    for (const u of updates) expect(u).toMatch(/WHERE user_id = u;/)
    expect(probeCode.match(/INSERT INTO public\.profiles/g)).toHaveLength(1)
    expect(probeCode).toMatch(/INSERT INTO public\.profiles \(user_id, onboarding_completed\) VALUES \(u, true\)\s+ON CONFLICT \(user_id\) DO UPDATE SET onboarding_completed = true;/)
  })

  it('is isolated by construction: it needs the synthetic user variable, and names no shared stack, port, container or docker', () => {
    expect(probeCode).toMatch(/SELECT set_config\('probe\.user', :'synthetic_user', true\);/)
    // (the header may NAME the shared container as an exclusion; the executable text must not use it)
    expect(probeCode).not.toMatch(/supabase_db_WillViralFinal|54321|127\.0\.0\.1|docker/i)
    expect(PROBE).toMatch(/NOT the shared\s+(?:--\s*)?supabase_db_WillViralFinal container/)
  })

  it('pins the same two function contract lines (with the body md5 of the CURRENT migration text) as the 090 DB test', () => {
    const line = (name: string) => `${name}()|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=${bodyMd5(`public.${name}`)}`
    expect(PROBE).toContain(line('profiles_field_revision_assert'))
    expect(PROBE).toContain(line('profiles_field_revision_assign'))
  })
})

describe('the 090 DB-integration test stays in sync with the migration text (the closed allowlist is not weakened, only itemized)', () => {
  const DB_TEST = readFileSync(path.join(ROOT, 'tests', '090-public-schema-privilege-hardening-db-integration.test.ts'), 'utf8').replace(/\r\n/g, '\n')
  const pin = (name: string) =>
    `${name}()|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=${bodyMd5(`public.${name}`)}`

  it('PIN_094_APP lists exactly the two functions with the md5 of their CURRENT bodies (any body edit must update the pin)', () => {
    expect(DB_TEST).toContain(`'${pin('profiles_field_revision_assert')}'`)
    expect(DB_TEST).toContain(`'${pin('profiles_field_revision_assign')}'`)
    const block = /const PIN_094_APP = \[([\s\S]*?)\n\]/.exec(DB_TEST)?.[1] ?? ''
    expect(block.match(/^\s+'/gm)).toHaveLength(2)
  })

  it('the undo list names exactly the two triggers and two functions of this migration, and does not touch anything else', () => {
    const undo = /const PRE_094_UNDO_SQL = `([\s\S]*?)`/.exec(DB_TEST)?.[1] ?? ''
    expect(undo.split('\n').map(l => l.trim()).filter(Boolean)).toEqual([
      'DROP TRIGGER IF EXISTS profiles_zz_revision_assert ON public.profiles;',
      'DROP TRIGGER IF EXISTS profiles_zz_revision_assign ON public.profiles;',
      'DROP FUNCTION IF EXISTS public.profiles_field_revision_assert();',
      'DROP FUNCTION IF EXISTS public.profiles_field_revision_assign();',
    ])
    expect(undo).not.toMatch(/CASCADE/i)
  })

  it('the counters moved by exactly the two new functions (108 -> 110 public functions, 77 -> 79 application functions)', () => {
    expect(DB_TEST).toMatch(/public_functions=110/)
    expect(DB_TEST).toMatch(/toHaveLength\(79\)/)
    expect(DB_TEST).not.toMatch(/public_functions=108/)
    expect(DB_TEST).toMatch(/\.\.\.pinned\('pin_app'\), \.\.\.PIN_094_APP/)
  })

  it('the undo is EXPLICIT: injected only into the transactions that re-run MIGRATION_BODY, NOT by the psql() wrapper', () => {
    // wrapper: only the pre-091 function
    expect(DB_TEST).toMatch(/sql\.replace\('BEGIN;', `BEGIN;\\n\$\{PRE_091_FUNCTION_SQL\}`\)/)
    expect(DB_TEST).not.toMatch(/sql\.replace\('BEGIN;'[^\n]*PRE_094_UNDO_SQL/)
    const code = DB_TEST.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    const bodySites = [...code.matchAll(/\$\{MIGRATION_BODY\}/g)].map(m => m.index!)
    const undoSites = [...code.matchAll(/\$\{PRE_094_UNDO_SQL\}/g)].map(m => m.index!)
    expect(bodySites).toHaveLength(6) // runBodyAfter, apply, PUBLIC-revoke, reapply, stricter default ACL, wider default ACL loop
    expect(undoSites).toHaveLength(bodySites.length)
    for (const site of bodySites) {
      // the nearest BEGIN; before this MIGRATION_BODY is followed by the undo, before the body
      const begin = code.lastIndexOf('BEGIN;', site)
      const undo = code.indexOf('${PRE_094_UNDO_SQL}', begin)
      expect(begin, 'a BEGIN; before every MIGRATION_BODY').toBeGreaterThanOrEqual(0)
      expect(undo, 'the undo sits between that BEGIN; and the MIGRATION_BODY').toBeGreaterThan(begin)
      expect(undo).toBeLessThan(site)
    }
  })

  it('scenarios that do NOT re-run MIGRATION_BODY (guard injection, TRUNCATE-role, keeper-read, live pins) run on the real post-094 catalog: no undo there', () => {
    const code = DB_TEST.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    // the guard-injection helper and its 13 scenarios open `BEGIN;\n${mutation}\n${GUARD_BODY}` -- no undo in between
    expect(code).toMatch(/psql\(`BEGIN;\\n\$\{mutation\}\\n\$\{GUARD_BODY\}\\nROLLBACK;`, user\)/)
    expect(code).not.toMatch(/GUARD_BODY\}[^\n]*PRE_094_UNDO_SQL|PRE_094_UNDO_SQL[^\n]*GUARD_BODY/)
  })

  it('the 090 migration file itself is untouched by this package', () => {
    const rawMigration090 = readFileSync(path.join(ROOT, 'supabase', 'migrations', '090_public_schema_privilege_hardening.sql'), 'utf8')
    expect(rawMigration090).toMatch(/pin_app/)
    expect(rawMigration090).not.toMatch(/profiles_field_revision/)
  })
})

describe('the writers the design assumes (a drift guard, not a proof)', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name)) files.push(p)
    }
  }
  walk(path.join(ROOT, 'app'))
  walk(path.join(ROOT, 'lib'))

  it('no application code INSERTs / UPSERTs into profiles (profiles rows are created only by handle_new_user(); a new writer must be reviewed against the trigger rules)', () => {
    const offenders = files.filter(f => /from\('profiles'\)\s*\.(insert|upsert)\(/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(f => path.relative(ROOT, f))).toEqual([])
  })

  it('no application code writes the revision columns', () => {
    const offenders = files.filter(f => /(specific_focus_revision|main_category_revision)/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(f => path.relative(ROOT, f))).toEqual([])
  })

  // The ONLY other writers of profiles are the e2e fixtures (raw SQL through psql, disposable local stack). They use
  // `INSERT ... ON CONFLICT (user_id) DO UPDATE`: the row already exists (created by handle_new_user), so this is
  // an UPDATE of non-focus columns. By trace (UNVERIFIED without a database): the BEFORE INSERT trigger fires first and
  // burns two sequence values; the conflict then turns it into an UPDATE, whose BEFORE UPDATE trigger finds the focus
  // and category columns unchanged and keeps the OLD revisions. Pinned here so a new statement of this shape (or one
  // that touches the focus columns) fails this test and gets reviewed; also listed in the runbook's PostgreSQL matrix.
  it('the only INSERT ... ON CONFLICT writers of profiles are the two known e2e fixtures, and neither touches the focus/category columns', () => {
    const e2eFiles: string[] = []
    const walkE2e = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue
        const p = path.join(dir, name)
        if (statSync(p).isDirectory()) walkE2e(p)
        else if (/\.(ts|tsx|sql)$/.test(name)) e2eFiles.push(p)
      }
    }
    walkE2e(path.join(ROOT, 'e2e'))
    const found = e2eFiles.flatMap(f =>
      [...readFileSync(f, 'utf8').matchAll(/insert\s+into\s+profiles\b[^;`]*/gi)].map(m => ({ file: path.relative(ROOT, f).replace(/\\/g, '/'), statement: m[0].replace(/\s+/g, ' ').trim() })),
    )
    expect(found.map(f => f.file).sort()).toEqual(['e2e/support/credit-fixtures.ts', 'e2e/support/db.ts'])
    for (const f of found) {
      expect(f.statement, f.file).toMatch(/on conflict \(user_id\) do update set /i)
      expect(f.statement, f.file).not.toMatch(/specific_focus|main_category/i)
    }
  })

  it('the decision core accepts every revision the database can issue: 1 .. 2^63-1 (the core also accepts "0", which the DB never issues: CHECK > 0)', () => {
    // REVISION_PATTERN is the STORE-AGNOSTIC canonical-decimal shape the pure core accepts (equality-only use); a
    // revision "0" is a legal shape there and is used by the pure tests. The database range is narrower on purpose:
    // the sequence starts at 1 and both columns carry CHECK (> 0). Tightening the pure core to "no 0" would change the
    // already-pushed PR #13 contract for no safety gain (a "0" snapshot revision can only equal a "0" event revision).
    expect(WITHOUT_COMMENTS).toMatch(/CHECK \(specific_focus_revision > 0\)/)
    expect(REVISION_PATTERN.test('1')).toBe(true)
    expect(REVISION_PATTERN.test('9223372036854775807')).toBe(true)
    expect(REVISION_PATTERN.test('0')).toBe(true)
    expect(REVISION_PATTERN.test('9223372036854775808'.padStart(20, '1'))).toBe(false)
  })
})

describe('the runbook states the limits instead of hiding them', () => {
  it.each([
    ['rollback keeps the sequence', /A szekvenci[aá]t SOHA nem dobjuk el/],
    ['a "Futási státusz" section that holds the run status (updated there, not pinned to a fixed wording elsewhere)', /## Futási státusz[\s\S]*?\| Környezet \| Státusz \| Megjegyzés \|[\s\S]*?izol[aá]lt helyi PostgreSQL[\s\S]*?\| \*\*(?:nem futott|futott[^|]*)\*\*[\s\S]*?Staging[\s\S]*?Production/],
    ['a skipped test is not a PASS', /kihagyott \(skipped\) teszt nem PASS/],
    ['the isolated probe is not the shared-stack 090 suite', /Ez a próba NEM a 090 DB-teszt-suite futtatása/],
    ['the probe has its own non-skippable result contract', /pontosan 16 darab `PROBE_PASS\|C01` … `C16`[\s\S]*?`PROBE_RESULT\|checks=16`[\s\S]*?„kihagyott” állapot nincs/],
    ['the matrix covers the authenticated UPDATE, the empty and one-row table and the statement_timeout negative control', /P13[\s\S]*?authenticated[\s\S]*?P14[\s\S]*?N = 0[\s\S]*?N = 1[\s\S]*?P15[\s\S]*?statement_timeout[\s\S]*?negatív kontroll/],
    ['the PIN / counter states with and without 094 are stated consistently', /094 jelenlétét \*\*várja\*\*[\s\S]*?elvárt módon elbuknak/],
    ['the lock upper bound is quantified and the client-side gap is named', /~360 s[\s\S]*?idle_in_transaction_session_timeout/],
    ['the undo is explicit in six named transactions, not injected by the wrapper', /kizárólag abban a hat visszagörgetett\s+tranzakcióban[\s\S]*?Nem\*\* injektálja a `psql\(\)` burkoló/],
    ['the CRLF fix is declared as NOT part of this package', /A CRLF-teszt javítás NEM része ennek a csomagnak/],
    ['trigger disabled = no guarantee', /nincs garancia/i],
    ['read as text', /::text/],
    ['an open item for the real DB behaviour', /Nyitott/],
    ['no decision tables / audit / receipts / RPC / API / UI in this package', /nem r[eé]sze/],
    ['the existing ON CONFLICT e2e writers are documented', /e2e\/support\/db\.ts[\s\S]*e2e\/support\/credit-fixtures\.ts/],
    ['the remaining lock and time limit are documented', /statement_timeout[\s\S]*Fennmarad[oó] korl[aá]t/],
    ['the PR #8 collision with the 090 DB test is a declared merge blocker, not claimed as settled', /MERGE-BLOKKOL[OÓ][^\n]*nem rendezett[\s\S]*PR #8/],
    ['the first run is a disposable, isolated local PostgreSQL with synthetic data only', /eldobhat[oó], izol[aá]lt helyi PostgreSQL[\s\S]*szintetikus adattal/],
    ['staging / production / provider databases are excluded', /Staging, production\s+és szolg[aá]ltat[oó]i adatb[aá]zis\s+\*\*kiz[aá]rt\*\*/],
    ['logical restore, replication and failover limits are stated', /logikai replik[aá]ci[oó][\s\S]*aszinkron failover/],
  ])('%s', (_name, pattern) => {
    expect(DOC).toMatch(pattern)
  })
})
