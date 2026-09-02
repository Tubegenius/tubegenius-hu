// PFM Collector Seed Admin v0 -- real local DB proof for the register/
// deactivate RPCs (083): idempotency, fingerprint-payload-conflict,
// concurrency (real, unretried, parallel RPC calls), rollback, RLS, grants,
// event append-only enforcement, and migration re-apply idempotency.
//
// No provider is ever called here -- this suite only exercises
// signal_seed_queue / signal_seed_queue_events / the seed-admin ledger via
// the real local Supabase stack.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

vi.setConfig({ testTimeout: 20000 })

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
    input: sql,
    encoding: 'utf-8',
  })
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}
const describeIfLocalDb = stackAvailable ? describe : describe.skip

function realFingerprint(category: string, seedText: string): string {
  function normalizeText(v: string): string {
    return v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  }
  const input = `1:${normalizeText(category)}:${normalizeText(seedText)}:${normalizeText(seedText)}`
  return createHash('sha256').update(input).digest('hex')
}

let marker = 0
function nextMarker(prefix: string): string {
  marker += 1
  return `${prefix}-${Date.now()}-${marker}`
}

async function cleanupFingerprint(fingerprint: string) {
  dockerPsql(`
    delete from signal_seed_queue_events where seed_id in (select id from signal_seed_queue where seed_fingerprint = '${fingerprint}');
    delete from signal_seed_queue where seed_fingerprint = '${fingerprint}';
  `)
}

describeIfLocalDb('PFM Collector Seed Admin v0 -- register_signal_seed / deactivate_signal_seed (real local DB)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
  })

  afterAll(() => {
    dockerPsql(`delete from signal_seed_admin_idempotency_ledger where idempotency_key like 'test-%';`)
  })

  // Applies to every it() in this file that stashes ctx.task.meta.fingerprint
  // -- Vitest registers hooks for the whole enclosing describe scope during
  // the synchronous collection pass, so this single hook covers all nested
  // describe blocks below regardless of their declaration order.
  afterEach(async (ctx) => {
    const fp = (ctx.task.meta as { fingerprint?: string }).fingerprint
    if (fp) await cleanupFingerprint(fp)
  })

  describe('083 migration -- RLS, grants, append-only enforcement, re-apply idempotency', () => {
    it('signal_seed_admin_idempotency_ledger and signal_seed_queue_events have RLS enabled+forced', () => {
      const out = dockerPsql(`
        select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relname in ('signal_seed_admin_idempotency_ledger','signal_seed_queue_events') order by relname;
      `).trim().split('\n')
      expect(out).toEqual([
        'signal_seed_admin_idempotency_ledger|t|t',
        'signal_seed_queue_events|t|t',
      ])
    })

    it('service_role has SELECT-only on both new tables -- no INSERT/UPDATE/DELETE grant exists', () => {
      const out = dockerPsql(`
        select table_name, privilege_type from information_schema.role_table_grants
        where table_schema='public' and grantee='service_role'
          and table_name in ('signal_seed_admin_idempotency_ledger','signal_seed_queue_events')
        order by table_name, privilege_type;
      `).trim().split('\n')
      expect(out).toEqual([
        'signal_seed_admin_idempotency_ledger|SELECT',
        'signal_seed_queue_events|SELECT',
      ])
    })

    it('signal_seed_queue: service_role retains SELECT+UPDATE but INSERT was revoked', () => {
      const out = dockerPsql(`
        select privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name='signal_seed_queue' and grantee='service_role'
        order by privilege_type;
      `).trim().split('\n')
      expect(out).toEqual(['SELECT', 'UPDATE'])
    })

    it('a direct service_role INSERT into signal_seed_queue via PostgREST is rejected (RPC bypass closed)', async () => {
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()
      const { error } = await admin.from('signal_seed_queue').insert({
        seed_fingerprint: realFingerprint('default', nextMarker('bypass-attempt')),
        seed_type: 'curated_global', seed_text: nextMarker('bypass'), category: 'default', region: 'HU', language: 'hu',
      })
      expect(error).not.toBeNull()
    })

    it('a direct service_role UPDATE/DELETE on signal_seed_queue_events via PostgREST is rejected (append-only)', async () => {
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()
      const updateResult = await admin.from('signal_seed_queue_events').update({ reason_code: 'OPERATOR_REQUESTED' }).eq('event_kind', 'created')
      expect(updateResult.error).not.toBeNull()
      const deleteResult = await admin.from('signal_seed_queue_events').delete().eq('event_kind', 'created')
      expect(deleteResult.error).not.toBeNull()
    })

    it('re-applying migration 083 is a clean no-op (idempotent reapply, no errors)', () => {
      const sql = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'supabase', 'migrations', '083_signal_seed_admin_audit_and_rpcs.sql'),
        'utf8',
      )
      expect(() => dockerPsql(sql)).not.toThrow()
    })

    it('event_kind/reason_code closed dictionary rejects an invalid combination at the DB level', () => {
      const fingerprint = realFingerprint('default', nextMarker('dict-fixture'))
      const seedId = dockerPsql(`
        insert into signal_seed_queue (seed_fingerprint, seed_type, seed_text, category, region, language)
        values ('${fingerprint}', 'curated_global', 'dict fixture', 'default', 'HU', 'hu')
        returning id;
      `).trim()
      try {
        // 'created' MUST pair with reason_code='CURATED_CATALOG_REGISTRATION' --
        // pairing it with a deactivate-only reason must violate the CHECK.
        expect(() => dockerPsql(`
          insert into signal_seed_queue_events (seed_id, event_kind, reason_code, operator_reference, idempotency_key, request_digest)
          values ('${seedId}', 'created', 'OPERATOR_REQUESTED', 'test-operator', 'bad-combo-key', repeat('a', 64));
        `)).toThrow()
      } finally {
        dockerPsql(`delete from signal_seed_queue where id='${seedId}';`)
      }
    })
  })

  describe('register_signal_seed -- idempotency and fingerprint-payload-conflict', () => {
    it('new fingerprint creates exactly once; same idempotency_key replays the identical result', async (ctx) => {
      const seedText = nextMarker('register-replay')
      const fingerprint = realFingerprint('entertainment', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()
      const key = nextMarker('test-idem')

      const first = await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'entertainment', p_region: 'HU', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: key,
      })
      expect(first.error).toBeNull()
      expect(first.data).toMatchObject({ ok: true, outcome: 'created' })

      const replay = await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'entertainment', p_region: 'HU', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: key,
      })
      expect(replay.error).toBeNull()
      expect(replay.data).toEqual(first.data)

      const count = dockerPsql(`select count(*) from signal_seed_queue where seed_fingerprint='${fingerprint}';`).trim()
      expect(count).toBe('1')
      const events = dockerPsql(`select count(*) from signal_seed_queue_events where seed_id=(select id from signal_seed_queue where seed_fingerprint='${fingerprint}');`).trim()
      expect(events).toBe('1')
    })

    it('same fingerprint + same payload, different idempotency_key -> already_exists (no duplicate row)', async (ctx) => {
      const seedText = nextMarker('register-already')
      const fingerprint = realFingerprint('gaming', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()

      const first = await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'gaming', p_region: 'HU', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      expect(first.data).toMatchObject({ outcome: 'created' })

      const second = await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'gaming', p_region: 'HU', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      expect(second.error).toBeNull()
      expect(second.data).toMatchObject({ ok: true, outcome: 'already_exists', active: true })
      expect((second.data as { seed_id: string }).seed_id).toBe((first.data as { seed_id: string }).seed_id)

      const count = dockerPsql(`select count(*) from signal_seed_queue where seed_fingerprint='${fingerprint}';`).trim()
      expect(count).toBe('1')
    })

    it('same fingerprint + different payload -> FINGERPRINT_PAYLOAD_CONFLICT, no write at all', async (ctx) => {
      const seedText = nextMarker('register-conflict')
      const fingerprint = realFingerprint('psychology', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()

      await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'psychology', p_region: 'HU', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })

      const conflicting = await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'psychology', p_region: 'US', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      expect(conflicting.error).not.toBeNull()
      expect(conflicting.error?.message).toContain('FINGERPRINT_PAYLOAD_CONFLICT')

      const count = dockerPsql(`select count(*) from signal_seed_queue where seed_fingerprint='${fingerprint}';`).trim()
      expect(count).toBe('1')
      const region = dockerPsql(`select region from signal_seed_queue where seed_fingerprint='${fingerprint}';`).trim()
      expect(region).toBe('HU')
    })

    it('same idempotency_key, different payload -> IDEMPOTENCY_KEY_REUSE', async (ctx) => {
      const seedText = nextMarker('register-reuse')
      const fingerprint = realFingerprint('finance_crypto', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()
      const key = nextMarker('test-idem')

      await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'finance_crypto', p_region: 'HU', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: key,
      })

      const reused = await admin.rpc('register_signal_seed', {
        p_seed_text: 'a genuinely different seed text', p_category: 'finance_crypto', p_region: 'HU', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: realFingerprint('finance_crypto', 'a genuinely different seed text'),
        p_operator_reference: 'test-operator', p_idempotency_key: key,
      })
      expect(reused.error).not.toBeNull()
      expect(reused.error?.message).toContain('IDEMPOTENCY_KEY_REUSE')
    })
  })

  describe('register_signal_seed -- never reactivates an inactive seed', () => {
    it('registering an already-deactivated fingerprint with matching payload reports already_exists/active:false, never flips it back on', async (ctx) => {
      const seedText = nextMarker('never-reactivate')
      const fingerprint = realFingerprint('health_wellness', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()

      await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'health_wellness', p_region: 'HU', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      await admin.rpc('deactivate_signal_seed', {
        p_target_seed_fingerprint: fingerprint, p_reason_code: 'OPERATOR_REQUESTED',
        p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })

      const reregistered = await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'health_wellness', p_region: 'HU', p_language: 'hu',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      expect(reregistered.error).toBeNull()
      expect(reregistered.data).toMatchObject({ ok: true, outcome: 'already_exists', active: false })

      const active = dockerPsql(`select active from signal_seed_queue where seed_fingerprint='${fingerprint}';`).trim()
      expect(active).toBe('f')
    })
  })

  describe('deactivate_signal_seed -- rollback contract', () => {
    it('active seed -> deactivated, active=false, exactly one deactivated event', async (ctx) => {
      const seedText = nextMarker('deactivate-basic')
      const fingerprint = realFingerprint('space_discovery', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()

      await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'space_discovery', p_region: 'BOTH', p_language: 'en',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })

      const result = await admin.rpc('deactivate_signal_seed', {
        p_target_seed_fingerprint: fingerprint, p_reason_code: 'LOW_QUALITY_YIELD',
        p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      expect(result.error).toBeNull()
      expect(result.data).toMatchObject({ ok: true, outcome: 'deactivated' })

      expect(dockerPsql(`select active from signal_seed_queue where seed_fingerprint='${fingerprint}';`).trim()).toBe('f')
      expect(dockerPsql(`select count(*) from signal_seed_queue_events where seed_id=(select id from signal_seed_queue where seed_fingerprint='${fingerprint}') and event_kind='deactivated';`).trim()).toBe('1')
    })

    it('already-inactive seed, same reason+operator -> already_inactive_replay, no new event row', async (ctx) => {
      const seedText = nextMarker('deactivate-replay')
      const fingerprint = realFingerprint('science_medical', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()

      await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'science_medical', p_region: 'BOTH', p_language: 'en',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      await admin.rpc('deactivate_signal_seed', {
        p_target_seed_fingerprint: fingerprint, p_reason_code: 'DUPLICATE_COVERAGE',
        p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })

      const replay = await admin.rpc('deactivate_signal_seed', {
        p_target_seed_fingerprint: fingerprint, p_reason_code: 'DUPLICATE_COVERAGE',
        p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      expect(replay.error).toBeNull()
      expect(replay.data).toMatchObject({ ok: true, outcome: 'already_inactive_replay' })

      expect(dockerPsql(`select count(*) from signal_seed_queue_events where seed_id=(select id from signal_seed_queue where seed_fingerprint='${fingerprint}') and event_kind='deactivated';`).trim()).toBe('1')
    })

    it('already-inactive seed, different reason -> ALREADY_INACTIVE_DIFFERENT_REQUEST, fail-closed', async (ctx) => {
      const seedText = nextMarker('deactivate-conflict')
      const fingerprint = realFingerprint('history_strange', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()

      await admin.rpc('register_signal_seed', {
        p_seed_text: seedText, p_category: 'history_strange', p_region: 'BOTH', p_language: 'en',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      await admin.rpc('deactivate_signal_seed', {
        p_target_seed_fingerprint: fingerprint, p_reason_code: 'QUOTA_REDUCTION',
        p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })

      const different = await admin.rpc('deactivate_signal_seed', {
        p_target_seed_fingerprint: fingerprint, p_reason_code: 'PHASE_ROLLBACK',
        p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      expect(different.error).not.toBeNull()
      expect(different.error?.message).toContain('ALREADY_INACTIVE_DIFFERENT_REQUEST')
    })

    it('unknown fingerprint -> SEED_NOT_FOUND', async () => {
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()
      const result = await admin.rpc('deactivate_signal_seed', {
        p_target_seed_fingerprint: realFingerprint('default', nextMarker('never-registered')),
        p_reason_code: 'OPERATOR_REQUESTED', p_operator_reference: 'test-operator', p_idempotency_key: nextMarker('test-idem'),
      })
      expect(result.error).not.toBeNull()
      expect(result.error?.message).toContain('SEED_NOT_FOUND')
    })
  })

  describe('concurrency -- real, parallel, unretried RPC calls (no client-side retry)', () => {
    it('two concurrent register calls, SAME idempotency_key, SAME new fingerprint -> exactly one created + one identical replay, never a leaked unique_violation', async (ctx) => {
      const seedText = nextMarker('concurrent-same-key')
      const fingerprint = realFingerprint('tech_ai', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()
      const key = nextMarker('test-idem')
      const payload = {
        p_seed_text: seedText, p_category: 'tech_ai', p_region: 'BOTH', p_language: 'en',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator', p_idempotency_key: key,
      }

      const [r1, r2] = await Promise.all([admin.rpc('register_signal_seed', payload), admin.rpc('register_signal_seed', payload)])
      expect(r1.error).toBeNull()
      expect(r2.error).toBeNull()
      const outcomes = [r1.data, r2.data].map((d) => (d as { outcome: string }).outcome).sort()
      expect(outcomes).toEqual(['created', 'created']) // same key -> both see the identical replay_result once settled
      expect((r1.data as { seed_id: string }).seed_id).toBe((r2.data as { seed_id: string }).seed_id)

      expect(dockerPsql(`select count(*) from signal_seed_queue where seed_fingerprint='${fingerprint}';`).trim()).toBe('1')
    })

    it('two concurrent register calls, DIFFERENT idempotency_keys, SAME new fingerprint -> exactly one created + one already_exists, never a leaked unique_violation', async (ctx) => {
      const seedText = nextMarker('concurrent-diff-key')
      const fingerprint = realFingerprint('news_current', seedText)
      ;(ctx.task.meta as { fingerprint?: string }).fingerprint = fingerprint
      const { createAdminClient } = await import('@/lib/supabase-server')
      const admin = createAdminClient()
      const base = {
        p_seed_text: seedText, p_category: 'news_current', p_region: 'BOTH', p_language: 'en',
        p_seed_type: 'curated_global', p_fingerprint: fingerprint, p_operator_reference: 'test-operator',
      }

      const [r1, r2] = await Promise.all([
        admin.rpc('register_signal_seed', { ...base, p_idempotency_key: nextMarker('test-idem') }),
        admin.rpc('register_signal_seed', { ...base, p_idempotency_key: nextMarker('test-idem') }),
      ])
      expect(r1.error).toBeNull()
      expect(r2.error).toBeNull()
      const outcomes = [r1.data, r2.data].map((d) => (d as { outcome: string }).outcome).sort()
      expect(outcomes).toEqual(['already_exists', 'created'])
      expect((r1.data as { seed_id: string }).seed_id).toBe((r2.data as { seed_id: string }).seed_id)

      expect(dockerPsql(`select count(*) from signal_seed_queue where seed_fingerprint='${fingerprint}';`).trim()).toBe('1')
      expect(dockerPsql(`select count(*) from signal_seed_queue_events where seed_id=(select id from signal_seed_queue where seed_fingerprint='${fingerprint}');`).trim()).toBe('1')
    })
  })

  describe('static source guarantees', () => {
    it('only register_signal_seed and deactivate_signal_seed exist for this domain -- no delete/reactivate function was added', () => {
      const out = dockerPsql(`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname in (
          'register_signal_seed','deactivate_signal_seed','delete_signal_seed','reactivate_signal_seed','remove_signal_seed'
        ) order by p.proname;
      `).trim().split('\n')
      expect(out).toEqual(['deactivate_signal_seed', 'register_signal_seed'])
    })
  })
})
