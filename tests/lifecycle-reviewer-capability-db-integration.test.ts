// PFM Lifecycle Reviewer Self-Capability v1 -- REAL local DB integration
// tests for migration 089's get_semantic_topic_lifecycle_reviewer_capability
// RPC. Exercises the real, applied 089 RPC against real GoTrue sessions --
// active reviewer, inactive reviewer, non-reviewer, anon (no session), and
// service_role (no direct EXECUTE grant) -- plus zero-DML and
// response-shape proofs.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const adminClient = createClient(LOCAL_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', { input: sql, encoding: 'utf-8' })
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}
const describeIfLocalDb = stackAvailable ? describe : describe.skip

const MARKER = 'lrc-dbint'

async function createFixtureUser(): Promise<{ userId: string; client: any }> {
  const email = `${MARKER}-${randomUUID()}@example.test`
  const password = `Test-${randomUUID()}-!Aa1`
  const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`failed to create fixture user: ${error?.message}`)
  const client = createClient(LOCAL_URL, LOCAL_ANON_KEY)
  const signIn = await client.auth.signInWithPassword({ email, password })
  if (signIn.error) throw new Error(`fixture user sign-in failed: ${signIn.error.message}`)
  return { userId: data.user.id, client }
}

function lifecycleTableCounts(): { requests: string; events: string; transitions: string } {
  const out = dockerPsql(`
    select
      (select count(*) from semantic_topic_lifecycle_review_requests),
      (select count(*) from semantic_topic_lifecycle_review_events),
      (select count(*) from semantic_topic_lifecycle_transition_events);
  `).trim()
  const [requests, events, transitions] = out.split('|')
  return { requests, events, transitions }
}

describeIfLocalDb('089 get_semantic_topic_lifecycle_reviewer_capability -- real DB/GoTrue', () => {
  const createdUserIds: string[] = []

  afterEach(() => {
    // Nothing to clean per-test beyond user teardown in afterAll -- the RPC
    // itself is STABLE/zero-DML, so there is never a row to delete here.
  })

  afterAll(async () => {
    for (const userId of createdUserIds) {
      try {
        dockerPsql(`delete from semantic_topic_reviewer_events where reviewer_user_id='${userId}'; delete from semantic_topic_reviewers where user_id='${userId}';`)
      } catch {
        // best-effort
      }
      await adminClient.auth.admin.deleteUser(userId)
    }
  })

  it('active reviewer -- returns true', async () => {
    const { userId, client } = await createFixtureUser()
    createdUserIds.push(userId)
    dockerPsql(`insert into semantic_topic_reviewers (user_id, active, provisioning_note) values ('${userId}', true, '${MARKER} fixture -- not a real bootstrap');`)

    const { data, error } = await (client as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')
    expect(error).toBeNull()
    expect(data).toBe(true)
  })

  it('inactive reviewer -- returns false, indistinguishable from a non-reviewer', async () => {
    const { userId, client } = await createFixtureUser()
    createdUserIds.push(userId)
    dockerPsql(`
      insert into semantic_topic_reviewers (user_id, active, deactivated_at, deactivated_by_user_id, provisioning_note)
      values ('${userId}', false, now(), '${userId}', '${MARKER} fixture -- deactivated');
    `)

    const { data, error } = await (client as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')
    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  it('non-reviewer (authenticated, no semantic_topic_reviewers row at all) -- returns false', async () => {
    const { userId, client } = await createFixtureUser()
    createdUserIds.push(userId)
    // deliberately no insert into semantic_topic_reviewers

    const { data, error } = await (client as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')
    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  it('active reviewer and non-reviewer produce byte-identical response SHAPES (both a bare boolean, no extra fields, no error) -- the false path never carries a distinguishing signal', async () => {
    const active = await createFixtureUser()
    createdUserIds.push(active.userId)
    dockerPsql(`insert into semantic_topic_reviewers (user_id, active, provisioning_note) values ('${active.userId}', true, '${MARKER} fixture');`)

    const nonReviewer = await createFixtureUser()
    createdUserIds.push(nonReviewer.userId)

    const activeResult = await (active.client as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')
    const nonReviewerResult = await (nonReviewer.client as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')

    expect(typeof activeResult.data).toBe('boolean')
    expect(typeof nonReviewerResult.data).toBe('boolean')
    expect(activeResult.error).toBeNull()
    expect(nonReviewerResult.error).toBeNull()
    // Neither response is anything but a bare boolean -- no object, no
    // array, no UUID/email/role field ever present.
    expect(JSON.stringify(activeResult.data)).toMatch(/^true$/)
    expect(JSON.stringify(nonReviewerResult.data)).toMatch(/^false$/)
  })

  it('anon (no session) -- RPC call is rejected, not merely answered false', async () => {
    const anonClient = createClient(LOCAL_URL, LOCAL_ANON_KEY)
    const { data, error } = await (anonClient as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')
    expect(error).not.toBeNull()
    expect(data).toBeNull()
  })

  it('service_role has no direct EXECUTE grant -- the RPC call is rejected even with the service-role key', async () => {
    const { data, error } = await (adminClient as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')
    expect(error).not.toBeNull()
    expect(data).toBeNull()
  })

  it('service_role EXECUTE privilege check directly against pg_proc -- confirms the grant topology, not just one call outcome', () => {
    const out = dockerPsql(
      `select has_function_privilege('service_role', 'public.get_semantic_topic_lifecycle_reviewer_capability()'::regprocedure, 'EXECUTE');`,
    ).trim()
    expect(out).toBe('f')
  })

  it('anon EXECUTE privilege check directly against pg_proc', () => {
    const out = dockerPsql(
      `select has_function_privilege('anon', 'public.get_semantic_topic_lifecycle_reviewer_capability()'::regprocedure, 'EXECUTE');`,
    ).trim()
    expect(out).toBe('f')
  })

  it('authenticated EXECUTE privilege check directly against pg_proc', () => {
    const out = dockerPsql(
      `select has_function_privilege('authenticated', 'public.get_semantic_topic_lifecycle_reviewer_capability()'::regprocedure, 'EXECUTE');`,
    ).trim()
    expect(out).toBe('t')
  })

  it('zero DML / zero lifecycle side effects -- calling the RPC (any outcome) never changes any lifecycle table row count', async () => {
    const before = lifecycleTableCounts()

    const { userId, client } = await createFixtureUser()
    createdUserIds.push(userId)
    dockerPsql(`insert into semantic_topic_reviewers (user_id, active, provisioning_note) values ('${userId}', true, '${MARKER} fixture');`)

    await (client as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')
    await (client as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')
    const anonClient = createClient(LOCAL_URL, LOCAL_ANON_KEY)
    await (anonClient as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')

    const after = lifecycleTableCounts()
    expect(after).toEqual(before)
  })

  it('the raw RPC response is never a JSON object -- no key names (uuid/role/email/list) can ever leak, by construction', async () => {
    const { userId, client } = await createFixtureUser()
    createdUserIds.push(userId)
    dockerPsql(`insert into semantic_topic_reviewers (user_id, active, provisioning_note) values ('${userId}', true, '${MARKER} fixture');`)

    const { data } = await (client as any).rpc('get_semantic_topic_lifecycle_reviewer_capability')
    expect(typeof data).toBe('boolean')
    expect(data).not.toBeInstanceOf(Object)
  })
})
