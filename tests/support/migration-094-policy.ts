// A STATIC policy analyser for supabase/migrations/094_profiles_field_revision.sql. It reads TEXT only.
//
// WHAT IT IS: a guard against careless or silent edits of the migration: the exact list of top-level statements, no
// hidden DML/DDL, no swallowed errors (EXCEPTION blocks, RAISE below EXCEPTION level), no constant conditions, no
// no-op branches, the ordering BEGIN -> SET LOCAL timeouts -> LOCK -> pre-check, and a TEXT PIN of the pre-check,
// sequence and post-check DO blocks.
//
// WHAT IT IS NOT: proof that the SQL does what it says. The block-text pins are CHANGE DETECTORS (like the function-body
// md5 pins): they make any edit of a check visible, they do not show that the check is correct. Whether the checks and
// the triggers work needs a real PostgreSQL run (see docs/operations/profiles-field-revision.md).
import { createHash } from 'node:crypto'

/** the exact top-level statements, in order, comments removed, DO and function bodies replaced by their head */
export const EXPECTED_TOP_LEVEL = [
  'BEGIN',
  "SET LOCAL lock_timeout = '5s'",
  "SET LOCAL statement_timeout = '60s'",
  'LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE',
  'DO',
  'DO',
  'REVOKE ALL ON SEQUENCE public.profiles_field_revision_seq FROM PUBLIC, anon, authenticated, service_role',
  "CREATE TEMP TABLE profiles_094_before ON COMMIT DROP AS SELECT count(*) AS rows_count, coalesce(sum((('x' || substr(md5(to_jsonb(t)::text), 1, 16))::bit(64)::bigint)::numeric), 0) AS row_hash_sum FROM public.profiles t",
  "ALTER TABLE public.profiles ADD COLUMN specific_focus_revision bigint NOT NULL DEFAULT nextval('public.profiles_field_revision_seq'), ADD COLUMN main_category_revision bigint NOT NULL DEFAULT nextval('public.profiles_field_revision_seq')",
  'ALTER TABLE public.profiles ALTER COLUMN specific_focus_revision DROP DEFAULT, ALTER COLUMN main_category_revision DROP DEFAULT',
  'ALTER TABLE public.profiles ADD CONSTRAINT profiles_specific_focus_revision_positive CHECK (specific_focus_revision > 0), ADD CONSTRAINT profiles_main_category_revision_positive CHECK (main_category_revision > 0)',
  'CREATE UNIQUE INDEX profiles_specific_focus_revision_key ON public.profiles (specific_focus_revision)',
  'CREATE UNIQUE INDEX profiles_main_category_revision_key ON public.profiles (main_category_revision)',
  "CREATE FUNCTION public.profiles_field_revision_assign() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS",
  "CREATE FUNCTION public.profiles_field_revision_assert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS",
  'REVOKE ALL ON FUNCTION public.profiles_field_revision_assign() FROM PUBLIC, anon, authenticated, service_role',
  'REVOKE ALL ON FUNCTION public.profiles_field_revision_assert() FROM PUBLIC, anon, authenticated, service_role',
  'CREATE TRIGGER profiles_zz_revision_assign BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_field_revision_assign()',
  'CREATE TRIGGER profiles_zz_revision_assert AFTER INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_field_revision_assert()',
  'DO',
  "NOTIFY pgrst, 'reload schema'",
  'COMMIT',
] as const

/**
 * Text pins of the three DO blocks (comments stripped, whitespace collapsed): CHANGE DETECTORS, not proof of behaviour.
 * An intentional edit of a check must update the pin here, which makes the edit visible in review.
 */
export const BLOCK_TEXT_MD5 = {
  pre: 'de07ab02d04bd25931c3bb02fb353f84',
  seq: '86f9dc7e86572e20ff22ed04a031daa4',
  post: '375d1e15efe5d1f28362c6beed4643a3',
} as const

const md5 = (text: string) => createHash('md5').update(text).digest('hex')
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
const stripComments = (sql: string) => sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
const stripLiterals = (text: string) => text.replace(/'(?:[^']|'')*'/g, "''")

/** the head statements, comments removed, DO blocks and $function$ bodies replaced; string literals KEPT */
export function topLevelStatements(sql: string): string[] {
  return stripComments(sql.replace(/\r\n/g, '\n'))
    .replace(/\$function\$[\s\S]*?\$function\$/g, '')
    .replace(/\$([A-Za-z_]\w*)\$[\s\S]*?\$\1\$/g, '')
    .split(';')
    .map(normalize)
    .filter(Boolean)
}

export function doBlocks(sql: string): Array<{ tag: string; body: string }> {
  const text = stripComments(sql.replace(/\r\n/g, '\n'))
  return [...text.matchAll(/\bDO\s+\$([A-Za-z_]\w*)\$([\s\S]*?)\$\1\$/g)].map(m => ({ tag: m[1], body: m[2] }))
}

export function functionBodies(sql: string): Array<{ name: string; header: string; body: string }> {
  const text = stripComments(sql.replace(/\r\n/g, '\n'))
  return [...text.matchAll(/CREATE FUNCTION (public\.\w+)\(\)([\s\S]*?)\$function\$([\s\S]*?)\$function\$;/g)].map(m => ({ name: m[1], header: m[2], body: m[3] }))
}

/**
 * The violations (stable codes) of a migration text; [] = the policy holds.
 * Every code is exercised by a direct negative test (tests/094-...source-policy.test.ts).
 */
export function analyzeMigration094(sql: string): string[] {
  const out = new Set<string>()
  const statements = topLevelStatements(sql)

  // 1. the exact top-level statement list (this also fixes the order: BEGIN, SET LOCAL timeouts, LOCK, pre-check, ...)
  if (JSON.stringify(statements) !== JSON.stringify(EXPECTED_TOP_LEVEL)) out.add('top_level_statements_changed')
  const idx = (s: string) => statements.findIndex(x => x.startsWith(s))
  const begin = idx('BEGIN')
  const firstSet = idx('SET LOCAL')
  if (begin < 0 || (firstSet >= 0 && begin > firstSet)) out.add('begin_not_before_set_local')
  const lock = idx('LOCK TABLE')
  const firstDo = idx('DO')
  if (lock < 0 || firstDo < 0 || lock > firstDo || (firstSet >= 0 && firstSet > lock)) out.add('lock_or_timeouts_not_before_pre_check')

  // 2. the DO blocks: exactly pre, seq, post, in that order, with their text pinned
  const blocks = doBlocks(sql)
  if (blocks.map(b => b.tag).join(',') !== 'pre,seq,post') out.add('do_blocks_unexpected')
  for (const b of blocks) {
    const pinned = (BLOCK_TEXT_MD5 as Record<string, string>)[b.tag]
    if (pinned && md5(normalize(b.body)) !== pinned) out.add(`block_text_changed:${b.tag}`)
  }

  // 3. nothing that swallows errors, anywhere in a DO block or a function body
  const checked = [...blocks.map(b => ({ where: `do:${b.tag}`, body: stripLiterals(b.body) })), ...functionBodies(sql).map(f => ({ where: `fn:${f.name}`, body: stripLiterals(f.body) }))]
  for (const c of checked) {
    if (/\bEXCEPTION\s+WHEN\b/i.test(c.body)) out.add('exception_block')
    if (/\bRAISE\s+(?:NOTICE|WARNING|INFO|LOG|DEBUG)\b/i.test(c.body)) out.add('raise_below_exception')
    if (/\b(?:AND|OR|IF|ELSIF|WHERE|WHEN)\s+(?:NOT\s+)?(?:false|true)\b/i.test(c.body)) out.add('constant_condition')
    if (/\bTHEN\s+(?:NULL|PERFORM\s+[^;]*)\s*;/i.test(c.body)) out.add('no_op_branch')
    if (/\bEXECUTE\b(?!\s+FUNCTION)/i.test(c.body)) out.add('dynamic_sql')
  }

  // 4. the check blocks are read-only: no DML / DDL / privilege / session statement, and no early exit
  for (const b of blocks) {
    const text = stripLiterals(b.body)
    if (b.tag === 'pre' || b.tag === 'post') {
      if (/\b(?:UPDATE|DELETE|INSERT|TRUNCATE|COPY|CALL|VACUUM|DROP|ALTER|GRANT|REVOKE|CREATE|LOCK|SET|NOTIFY|PERFORM)\b/i.test(text)) out.add('dml_or_ddl_in_check_block')
      if (/\bRETURN\b|\bEXIT\b|\bCONTINUE\b/i.test(text)) out.add('early_exit_in_check_block')
    } else if (b.tag === 'seq') {
      if (/\b(?:UPDATE|DELETE|INSERT|TRUNCATE|COPY|CALL|VACUUM|DROP|ALTER|GRANT|REVOKE|PERFORM|setval)\b/i.test(text)) out.add('dml_or_ddl_in_seq_block')
    }
  }

  // 5. the trigger functions: plpgsql trigger functions that end by returning NEW, exactly once, never NULL
  const fns = functionBodies(sql)
  if (fns.map(f => f.name).join(',') !== 'public.profiles_field_revision_assign,public.profiles_field_revision_assert') out.add('functions_unexpected')
  for (const f of fns) {
    if (!/RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER/.test(f.header)) out.add('function_header')
    if (!/RETURN NEW;\s*END;\s*$/.test(f.body) || (f.body.match(/\bRETURN\b/g) ?? []).length !== 1 || /RETURN NULL|RETURN OLD/i.test(f.body)) out.add('function_return')
  }

  // 6. bounded timeouts
  const lockTimeout = /^SET LOCAL lock_timeout = '(\d+)s';$/m.exec(sql)
  const statementTimeout = /^SET LOCAL statement_timeout = '(\d+)s';$/m.exec(sql)
  if (!lockTimeout || Number(lockTimeout[1]) < 1 || Number(lockTimeout[1]) > 30) out.add('lock_timeout_unbounded')
  if (!statementTimeout || Number(statementTimeout[1]) < 10 || Number(statementTimeout[1]) > 300) out.add('statement_timeout_unbounded')

  // 7. plain ASCII
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(sql)) out.add('non_ascii')

  return [...out].sort()
}
