// Starter Credit Contract v1 -- REAL local DB integration tests for migration 091.
//
// Every scenario runs inside ONE transaction that is ROLLED BACK (the shared local stack is never
// left drifted). Each scenario applies the 091 migration body itself (it is idempotent) and, where
// the pre-091 behaviour matters, first restores the recorded pre-091 function, so the tests hold
// whether or not 091 is already applied on the local stack.
// The single exception is the concurrency test, which needs real overlapping transactions: it
// creates one committed throw-away user and deletes it (cascade) in a finally block.
import { describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 120000 })

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const MIGRATION = readFileSync(path.join(ROOT, 'supabase', 'migrations', '091_starter_credit_contract.sql'), 'utf8').replace(/\r\n/g, '\n')
const GUARD = readFileSync(path.join(ROOT, 'scripts', 'public-schema-privilege-guard.sql'), 'utf8')

interface PsqlResult { status: number | null; output: string }
const DOCKER_ARGS = ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']

function psql(sql: string): PsqlResult {
  const result = spawnSync('docker', DOCKER_ARGS, { input: sql, encoding: 'utf-8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function psqlAsync(sql: string): Promise<PsqlResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', DOCKER_ARGS)
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (status) => resolve({ status, output: out }))
    child.stdin.end(sql)
  })
}

let stackAvailable = false
try { stackAvailable = psql('select 1;').status === 0 } catch { stackAvailable = false }
const describeIfLocalDb = stackAvailable ? describe : describe.skip

// The migration minus its own BEGIN/COMMIT, so scenarios can wrap it in their own transaction.
const MIGRATION_BODY = (() => {
  const lines = MIGRATION.split('\n')
  const begin = lines.findIndex((l) => l === 'BEGIN;')
  const commit = lines.lastIndexOf('COMMIT;')
  if (begin < 0 || commit < 0) throw new Error('091 must contain BEGIN; and COMMIT;')
  return lines.slice(begin + 1, commit).join('\n')
})()

const GUARD_BODY = GUARD.split('\n').filter((l) => l !== 'BEGIN;' && l !== 'ROLLBACK;' && !l.startsWith('\\pset')).join('\n')

// The recorded pre-091 function (identical to what 001-090 leave behind).
const PRE_091_FUNCTION = `
CREATE OR REPLACE FUNCTION public.handle_new_user_credits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.user_credits (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$;`

const tx = (...steps: string[]) => `BEGIN;\n${steps.join('\n')}\nROLLBACK;`
const apply091 = MIGRATION_BODY
const asPre091 = PRE_091_FUNCTION

function newUser(id: string): string {
  return `insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values ('${id}', 'starter-${id}@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated');`
}

const grantArgs = (id: string) => `'${id}', 50, 'subscription', 50, 'initial:${id}', 'initial_credit', '{"plan":"beta"}'::jsonb`

function snapshot(id: string, tag = 'S'): string {
  return `
select '${tag}_UC|'||balance||'|'||subscription_credit_balance||'|'||purchased_credit_balance||'|'||total_used||'|'||plan||'|'||monthly_allowance||'|'||coalesce(subscription_status,'null') from public.user_credits where user_id='${id}';
select '${tag}_UC_COUNT|'||count(*) from public.user_credits where user_id='${id}';
select '${tag}_PROFILES|'||count(*) from public.profiles where user_id='${id}';
select '${tag}_LEDGER_COUNT|'||count(*) from public.credit_ledger where user_id='${id}';
select '${tag}_LEDGER|'||external_ref||'|'||reason||'|'||delta||'|'||credit_bucket||'|'||subscription_delta||'|'||purchased_delta||'|'||balance_after||'|'||subscription_balance_after||'|'||purchased_balance_after from public.credit_ledger where user_id='${id}' order by created_at, external_ref;`
}

function ok(sql: string): string {
  const r = psql(sql)
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.output.slice(0, 2000)}`)
  return r.output
}
function kv(output: string, key: string): string[] {
  return output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${key}|`)).map((l) => l.slice(key.length + 1))
}
const one = (output: string, key: string): string => {
  const v = kv(output, key)
  if (v.length !== 1) throw new Error(`expected exactly one ${key} line, got ${v.length}: ${output.slice(0, 800)}`)
  return v[0]
}

describeIfLocalDb('091 starter credit contract -- new users', () => {
  it('BEFORE 091 (recorded old function): a new user gets balance 0 and NO ledger row -- the bug being fixed', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, newUser(id), snapshot(id)))
    expect(one(out, 'S_UC')).toBe('0.00|0|0|0.00|beta|50.00|free')
    expect(one(out, 'S_LEDGER_COUNT')).toBe('0')
    expect(one(out, 'S_PROFILES')).toBe('1')
  })

  it('AFTER 091: a new user gets profile x1, user_credits x1 and exactly one starter ledger row', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id), snapshot(id)))
    expect(one(out, 'S_PROFILES')).toBe('1')
    expect(one(out, 'S_UC_COUNT')).toBe('1')
    expect(one(out, 'S_LEDGER_COUNT')).toBe('1')
  })

  it('AFTER 091: 50 credits in the SUBSCRIPTION bucket, balance = bucket sum, plan beta, allowance 50', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id), snapshot(id)))
    // balance | subscription | purchased | total_used | plan | monthly_allowance | subscription_status
    expect(one(out, 'S_UC')).toBe('50.00|50|0|0.00|beta|50.00|free')
    const [bal, sub, pur] = one(out, 'S_UC').split('|').map(Number)
    expect(bal).toBe(sub + pur)
  })

  it('AFTER 091: the ledger row follows the contract (initial:<id>, initial_credit, subscription bucket, delta 50)', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id), snapshot(id)))
    // external_ref|reason|delta|bucket|sub_delta|purchased_delta|balance_after|sub_after|purchased_after
    expect(one(out, 'S_LEDGER')).toBe(`initial:${id}|initial_credit|50|subscription|50|0|50|50|0`)
  })

  it('AFTER 091: renews_at keeps the 30-day default; nothing else is granted', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id),
      `select 'RENEW|'||round(extract(epoch from (renews_at - now()))/86400)::int from public.user_credits where user_id='${id}';`))
    expect(one(out, 'RENEW')).toBe('30')
  })

  it('two users created in the same transaction each get their own independent single grant', () => {
    const a = randomUUID()
    const b = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(a), newUser(b), snapshot(a, 'A'), snapshot(b, 'B')))
    expect(one(out, 'A_LEDGER')).toBe(`initial:${a}|initial_credit|50|subscription|50|0|50|50|0`)
    expect(one(out, 'B_LEDGER')).toBe(`initial:${b}|initial_credit|50|subscription|50|0|50|50|0`)
    expect(one(out, 'A_LEDGER_COUNT')).toBe('1')
    expect(one(out, 'B_LEDGER_COUNT')).toBe('1')
  })

  it('a repeated grant (the /api/credits fallback, a retried RPC) is a no-op: duplicate=true, balance stays 50, ledger stays 1', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id),
      `select 'DUP1|'||(public.apply_bucket_credit_event(${grantArgs(id)})->>'duplicate');`,
      `select 'DUP2|'||(public.apply_bucket_credit_event(${grantArgs(id)})->>'duplicate');`,
      snapshot(id)))
    expect(one(out, 'DUP1')).toBe('true')
    expect(one(out, 'DUP2')).toBe('true')
    expect(one(out, 'S_UC')).toBe('50.00|50|0|0.00|beta|50.00|free')
    expect(one(out, 'S_LEDGER_COUNT')).toBe('1')
  })

  it('the ledger UNIQUE(external_ref) makes a raw second starter row impossible', () => {
    const id = randomUUID()
    const r = psql(tx(asPre091, apply091, newUser(id),
      `insert into public.credit_ledger(user_id, external_ref, reason, delta, balance_after, credit_bucket, subscription_delta, purchased_delta, subscription_balance_after, purchased_balance_after)
       values ('${id}', 'initial:${id}', 'initial_credit', 50, 50, 'subscription', 50, 0, 50, 0);`))
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('credit_ledger_external_ref_key')
  })

  it('the migration is idempotent: applying it twice changes nothing and still grants exactly once', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, apply091, newUser(id), snapshot(id)))
    expect(one(out, 'S_LEDGER_COUNT')).toBe('1')
    expect(one(out, 'S_UC')).toBe('50.00|50|0|0.00|beta|50.00|free')
  })
})

describeIfLocalDb('091 starter credit contract -- existing users are untouched (no backfill)', () => {
  it('applying 091 changes NO existing user_credits/credit_ledger data (content digests identical before/after)', () => {
    const digest = (tag: string) => `
select '${tag}_UC|'||count(*)||'|'||md5(coalesce(string_agg(t::text, '|' order by t.user_id), '')) from public.user_credits t;
select '${tag}_LEDGER|'||count(*)||'|'||md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.credit_ledger t;`
    const out = ok(tx(asPre091, digest('BEFORE'), apply091, digest('AFTER')))
    expect(one(out, 'AFTER_UC')).toBe(one(out, 'BEFORE_UC'))
    expect(one(out, 'AFTER_LEDGER')).toBe(one(out, 'BEFORE_LEDGER'))
  })

  it('a 0-balance user created before 091 stays at 0 with no ledger row after 091 is applied', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, newUser(id), snapshot(id, 'PRE'), apply091, snapshot(id, 'POST')))
    expect(one(out, 'PRE_UC')).toBe('0.00|0|0|0.00|beta|50.00|free')
    expect(one(out, 'POST_UC')).toBe(one(out, 'PRE_UC'))
    expect(one(out, 'POST_LEDGER_COUNT')).toBe('0')
  })

  it('a pre-091 user with a real balance/purchased credits keeps every bucket unchanged', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, newUser(id),
      `select public.apply_bucket_credit_event('${id}', 194, 'purchased', NULL, 'test:topup:${id}', 'topup_purchase', '{}'::jsonb);`,
      snapshot(id, 'PRE'), apply091, snapshot(id, 'POST')))
    expect(one(out, 'PRE_UC')).toBe('194.00|0|194|0.00|beta|50.00|free')
    expect(one(out, 'POST_UC')).toBe(one(out, 'PRE_UC'))
    expect(one(out, 'POST_LEDGER_COUNT')).toBe(one(out, 'PRE_LEDGER_COUNT'))
  })
})

describeIfLocalDb('091 starter credit contract -- top-up, subscription, spend/refund regression', () => {
  it('a top-up adds to the PURCHASED bucket only; the starter grant is untouched', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id),
      `select public.apply_bucket_credit_event('${id}', 50, 'purchased', NULL, 'test:topup:${id}', 'topup_purchase', '{}'::jsonb);`,
      snapshot(id)))
    expect(one(out, 'S_UC')).toBe('100.00|50|50|0.00|beta|50.00|free')
    expect(kv(out, 'S_LEDGER_COUNT')).toEqual(['2'])
  })

  it('a subscription start (cap = plan credits) ABSORBS the starter grant, never stacks, and never touches purchased credits', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id),
      `select public.apply_bucket_credit_event('${id}', 50, 'purchased', NULL, 'test:topup:${id}', 'topup_purchase', '{}'::jsonb);`,
      // Creator plan: 150 credits, cap 150 (lib/stripe.ts PLANS.creator.credits)
      `select public.apply_bucket_credit_event('${id}', 150, 'subscription', 150, 'test:sub:${id}', 'subscription_start', '{}'::jsonb);`,
      snapshot(id)))
    expect(one(out, 'S_UC')).toBe('200.00|150|50|0.00|beta|50.00|free')
  })

  it('a Starter-plan start (50 credits, cap 50) leaves the subscription bucket at 50 (no double counting)', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id),
      `select public.apply_bucket_credit_event('${id}', 50, 'subscription', 50, 'test:sub:${id}', 'subscription_start', '{}'::jsonb);`,
      snapshot(id)))
    expect(one(out, 'S_UC')).toBe('50.00|50|0|0.00|beta|50.00|free')
  })

  it('a monthly renewal respects the rollover cap and never reduces purchased credits', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id),
      `select public.apply_bucket_credit_event('${id}', 50, 'purchased', NULL, 'test:topup:${id}', 'topup_purchase', '{}'::jsonb);`,
      // Starter plan renewal: +50, rollover cap 75 (PLANS.starter.rolloverCap)
      `select public.apply_bucket_credit_event('${id}', 50, 'subscription', 75, 'test:renew:${id}', 'subscription_renewal', '{}'::jsonb);`,
      snapshot(id)))
    expect(one(out, 'S_UC')).toBe('125.00|75|50|0.00|beta|50.00|free')
  })

  it('spending takes the subscription (starter) bucket first, then purchased; a refund restores the exact split', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id),
      `select public.apply_bucket_credit_event('${id}', 50, 'purchased', NULL, 'test:topup:${id}', 'topup_purchase', '{}'::jsonb);`,
      `select 'SPEND|'||(public.spend_credits('${id}', 70, 'test_feature', 'test:spend:${id}', '{}'::jsonb)->>'transaction_id');`,
      snapshot(id, 'AFTER_SPEND'),
      `select 'REFUND|'||(public.refund_credit_spend('${id}', (select id from public.credit_ledger where external_ref='test:spend:${id}'), 'test:refund:${id}', '{}'::jsonb)->>'duplicate');`,
      snapshot(id, 'AFTER_REFUND')))
    expect(one(out, 'AFTER_SPEND_UC')).toBe('30.00|0|30|70.00|beta|50.00|free')
    expect(one(out, 'REFUND')).toBe('false')
    // refund puts back exactly the original split (50 subscription + 20 purchased); total_used is not rolled back by design
    expect(one(out, 'AFTER_REFUND_UC').split('|').slice(0, 3).join('|')).toBe('100.00|50|50')
  })

  it('spending more than the balance is still refused', () => {
    const id = randomUUID()
    const r = psql(tx(asPre091, apply091, newUser(id),
      `select public.spend_credits('${id}', 51, 'test_feature', 'test:spend:${id}', '{}'::jsonb);`))
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('insufficient credits')
  })
})

describeIfLocalDb('091 starter credit contract -- cascade and object integrity', () => {
  it('deleting the auth user still cascades to profiles, user_credits and credit_ledger', () => {
    const id = randomUUID()
    const out = ok(tx(asPre091, apply091, newUser(id), snapshot(id, 'BEFORE'),
      `delete from auth.users where id='${id}';`, snapshot(id, 'AFTER')))
    expect(one(out, 'BEFORE_UC_COUNT')).toBe('1')
    expect(one(out, 'BEFORE_LEDGER_COUNT')).toBe('1')
    expect(one(out, 'AFTER_UC_COUNT')).toBe('0')
    expect(one(out, 'AFTER_PROFILES')).toBe('0')
    expect(one(out, 'AFTER_LEDGER_COUNT')).toBe('0')
  })

  it('handle_new_user_credits keeps its owner, SECURITY DEFINER, search_path and ACL; the trigger set is unchanged', () => {
    const probe = (tag: string) => `
select '${tag}_FN|'||pg_get_userbyid(p.proowner)||'|'||p.prosecdef::text||'|'||coalesce(p.proconfig::text,'null')||'|'||coalesce(p.proacl::text,'null') from pg_proc p where p.oid='public.handle_new_user_credits()'::regprocedure;
select '${tag}_TRG|'||string_agg(t.tgname||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid), ' ; ' order by t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relname='users' and not t.tgisinternal;
select '${tag}_ABC|'||coalesce(p.proacl::text,'null')||'|'||md5(replace(p.prosrc, chr(13)||chr(10), chr(10))) from pg_proc p where p.oid='public.apply_bucket_credit_event(uuid,numeric,text,numeric,text,text,jsonb)'::regprocedure;`
    const out = ok(tx(asPre091, probe('BEFORE'), apply091, probe('AFTER')))
    expect(one(out, 'AFTER_FN')).toBe(one(out, 'BEFORE_FN'))
    expect(one(out, 'AFTER_TRG')).toBe(one(out, 'BEFORE_TRG'))
    expect(one(out, 'AFTER_ABC')).toBe(one(out, 'BEFORE_ABC'))
    expect(one(out, 'AFTER_FN')).toContain('|true|{"search_path=public, pg_temp"}|{postgres=X/postgres}')
  })

  it('the public-schema privilege guard (090) still reports zero violations with 091 applied', () => {
    const out = ok(tx(asPre091, apply091, GUARD_BODY))
    const m = /GUARD_RESULT\|violations=(\d+)/.exec(out)
    expect(m, out.slice(0, 500)).not.toBeNull()
    expect(m![1]).toBe('0')
  })
})

describeIfLocalDb('091 starter credit contract -- fail-fast preconditions', () => {
  const expectFailure = (mutation: string, message: string) => {
    const r = psql(tx(asPre091, mutation, apply091))
    expect(r.status).not.toBe(0)
    expect(r.output).toContain(message)
  }

  it('refuses to run over an unexpected handle_new_user_credits definition', () => {
    expectFailure(`CREATE OR REPLACE FUNCTION public.handle_new_user_credits() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$ BEGIN RETURN NEW; END; $f$;`,
      'handle_new_user_credits() has an unexpected definition')
  })

  it('refuses to run when the function lost its pinned search_path (definition drift)', () => {
    expectFailure(`ALTER FUNCTION public.handle_new_user_credits() RESET search_path;`, 'handle_new_user_credits() has an unexpected definition')
  })

  it('refuses to run over an unexpected extra auth.users trigger', () => {
    expectFailure(`CREATE TRIGGER zz_extra_signup_trigger AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();`, 'unexpected auth.users trigger set')
  })

  it('refuses to run when the shared grant RPC drifted (definition or ACL)', () => {
    expectFailure(`GRANT EXECUTE ON FUNCTION public.apply_bucket_credit_event(uuid,numeric,text,numeric,text,text,jsonb) TO authenticated;`, 'apply_bucket_credit_event ACL drifted')
  })

  it('refuses to run without the ledger UNIQUE(external_ref) idempotency anchor', () => {
    expectFailure(`ALTER TABLE public.credit_ledger DROP CONSTRAINT credit_ledger_external_ref_key;`, 'credit_ledger UNIQUE(external_ref) is missing')
  })

  it('refuses to run when a user_credits default the contract relies on drifted', () => {
    expectFailure(`ALTER TABLE public.user_credits ALTER COLUMN balance SET DEFAULT 50;`, 'user_credits defaults drifted')
  })
})

describeIfLocalDb('091 starter credit contract -- concurrency', () => {
  it('overlapping grant calls that share one idempotency key produce exactly one ledger row and one credit mutation', async () => {
    const id = randomUUID()
    const ref = `race:${id}`
    try {
      // Committed throw-away user (deleted in finally). The signup trigger creates the profile + credit row
      // (with the starter grant iff 091 is already applied on the local stack), so measure a baseline first.
      ok(newUser(id))
      const before = ok(snapshot(id, 'BEFORE'))
      const baseline = Number(one(before, 'BEFORE_UC').split('|')[0])
      const call = `BEGIN;\nselect pg_sleep(0.4);\nselect 'R|'||(public.apply_bucket_credit_event('${id}', 50, 'subscription', NULL, '${ref}', 'race_test', '{}'::jsonb)->>'duplicate');\nCOMMIT;`
      const results = await Promise.all([psqlAsync(call), psqlAsync(call), psqlAsync(call), psqlAsync(call)])
      for (const r of results) expect(r.status, r.output).toBe(0)
      const duplicates = results.flatMap((r) => kv(r.output, 'R'))
      expect(duplicates.filter((d) => d === 'false')).toHaveLength(1)
      expect(duplicates.filter((d) => d === 'true')).toHaveLength(3)
      const out = ok(`${snapshot(id, 'AFTER')}\nselect 'REF_ROWS|'||count(*) from public.credit_ledger where external_ref='${ref}';`)
      expect(one(out, 'REF_ROWS')).toBe('1')
      expect(Number(one(out, 'AFTER_UC').split('|')[0])).toBe(baseline + 50)
    } finally {
      psql(`delete from auth.users where id='${id}';`)
    }
  })
})
