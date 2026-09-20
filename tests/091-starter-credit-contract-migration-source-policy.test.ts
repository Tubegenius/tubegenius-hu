// Starter Credit Contract v1 -- static source policy for migration 091 (no database needed).
// Pins the migration, lib/starter-credit.ts, GET /api/credits and the docs to one contract.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { STARTER_CREDIT } from '@/lib/starter-credit'

const ROOT = path.resolve(__dirname, '..')
const MIGRATION_FILE = '091_starter_credit_contract.sql'
const SQL = readFileSync(path.join(ROOT, 'supabase', 'migrations', MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n')
const ROUTE = readFileSync(path.join(ROOT, 'app', 'api', 'credits', 'route.ts'), 'utf8')
const DOC = readFileSync(path.join(ROOT, 'docs', 'operations', 'starter-credit-contract.md'), 'utf8')

const FUNCTION_BODY = /\$function\$([\s\S]*?)\$function\$/.exec(SQL)?.[1] ?? ''
const WITHOUT_COMMENTS = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
const WITHOUT_FUNCTION_BODY = WITHOUT_COMMENTS.replace(/\$function\$[\s\S]*?\$function\$/, '')
// Statement scan view: string literals removed (they legitimately contain e.g. the trigger definition
// text 'AFTER INSERT ON auth.users'), and the two allowed temp-table lifecycle statements removed.
const STATEMENT_SCAN = WITHOUT_FUNCTION_BODY
  .replace(/'(?:[^']|'')*'/g, "''")
  .replace(/DROP TABLE IF EXISTS pg_temp\.starter_credit_091_before;/g, '')
  .replace(/ON COMMIT DROP/g, '')

describe('091 migration file', () => {
  it('is the newest migration and the only 091', () => {
    const files = readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort()
    expect(files.filter((f) => f.startsWith('091'))).toEqual([MIGRATION_FILE])
    expect(files[files.length - 1]).toBe(MIGRATION_FILE)
  })

  it('is a single transaction: BEGIN ... COMMIT', () => {
    expect(SQL).toMatch(/^BEGIN;$/m)
    expect(SQL).toMatch(/^COMMIT;$/m)
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1)
  })

  it('changes exactly one object: CREATE OR REPLACE FUNCTION public.handle_new_user_credits()', () => {
    const creates = STATEMENT_SCAN.match(/CREATE\s+(OR\s+REPLACE\s+)?(TEMP\s+)?(FUNCTION|TRIGGER|TABLE|INDEX|VIEW|POLICY)[^\n]*/gi) ?? []
    expect(creates.map((c) => c.replace(/\s+/g, ' ').trim())).toEqual([
      'CREATE TEMP TABLE starter_credit_091_before AS',
      'CREATE OR REPLACE FUNCTION public.handle_new_user_credits()',
    ])
  })

  it('outside the function body it has NO data or privilege statements (no backfill, no grant/revoke, no ALTER/DROP)', () => {
    expect(STATEMENT_SCAN).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|DROP|ALTER|COPY|CALL|VACUUM)\b/i)
  })

  it('never mentions a backfill/retroactive path against existing users', () => {
    expect(WITHOUT_COMMENTS).not.toMatch(/backfill|retroactiv|FOR\s+EACH\s+ROW\s+IN|\bLOOP\b/i)
  })

  it('is fail-fast: pins old/new function md5, RPC md5+ACL, trigger set, ledger UNIQUE, user_credits defaults, and re-checks data + ACL afterwards', () => {
    for (const marker of [
      'OLD_FN_MD5', 'NEW_FN_MD5', 'ABC_FN_MD5',
      "on_auth_user_created,on_auth_user_created_credits",
      'UNIQUE (external_ref)',
      "{postgres=X/postgres,service_role=X/postgres}",
      '091 post-check failed: migration changed credit data',
      'owner/security/config/ACL changed',
    ]) expect(SQL).toContain(marker)
    const md5s = [...SQL.matchAll(/(?:OLD|NEW|ABC)_FN_MD5 CONSTANT text := '([0-9a-f]{32})'/g)].map((m) => m[1])
    expect(md5s).toHaveLength(4) // OLD + NEW (pre) + ABC + NEW (post)
    expect(SQL).not.toContain('__NEW_FN_MD5__')
  })

  it('the function body issues the canonical starter grant, through the shared idempotent RPC', () => {
    expect(FUNCTION_BODY).toContain('INSERT INTO public.user_credits (user_id) VALUES (NEW.id)')
    expect(FUNCTION_BODY).toContain('ON CONFLICT (user_id) DO NOTHING')
    const call = /PERFORM public\.apply_bucket_credit_event\(([\s\S]*?)\);\s*RETURN NEW;/.exec(FUNCTION_BODY)?.[1] ?? ''
    const args = call.replace(/\s+/g, ' ').trim()
    expect(args).toBe(
      `NEW.id, ${STARTER_CREDIT.amount}, '${STARTER_CREDIT.bucket}', ${STARTER_CREDIT.cap}, '${STARTER_CREDIT.externalRefPrefix}' || NEW.id::text, '${STARTER_CREDIT.reason}', jsonb_build_object('plan', '${STARTER_CREDIT.plan}')`,
    )
    // exactly one grant, no second ledger writer, no exception swallowing (fail-closed)
    expect(FUNCTION_BODY.match(/apply_bucket_credit_event/g)).toHaveLength(1)
    expect(FUNCTION_BODY).not.toMatch(/credit_ledger|EXCEPTION\s+WHEN|RAISE\s+(WARNING|NOTICE)/i)
  })

  it('keeps SECURITY DEFINER + the pinned search_path on the function', () => {
    expect(WITHOUT_COMMENTS).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'\s+AS \$function\$/)
  })
})

describe('shared contract: lib/starter-credit.ts <-> GET /api/credits <-> docs', () => {
  it('the route uses the shared helper and hardcodes no starter value', () => {
    expect(ROUTE).toContain("import { starterCreditRpcArgs } from '@/lib/starter-credit'")
    expect(ROUTE).toContain("admin.rpc('apply_bucket_credit_event', starterCreditRpcArgs(user.id))")
    expect(ROUTE).not.toMatch(/p_delta|initial_credit|initial:|p_cap/)
  })

  it('the route only grants on a definitive "row not found" (PGRST116) and only when it created the row', () => {
    expect(ROUTE).toContain("error.code !== 'PGRST116'")
    expect(ROUTE).toMatch(/if \(!createError\) \{[\s\S]*apply_bucket_credit_event/)
  })

  it('the contract doc records the decision, the no-backfill rule and the staging follow-up', () => {
    for (const phrase of ['50', 'subscription', 'initial:<user_id>', 'initial_credit', 'no backfill', 'staging user']) {
      expect(DOC.toLowerCase()).toContain(phrase.toLowerCase())
    }
  })
})
