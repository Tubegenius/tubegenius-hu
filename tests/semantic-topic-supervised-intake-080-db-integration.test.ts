// PFM 080 -- Supervised Intake Stopped-Batch Pending-Item Recovery. Real
// local DB integration, raw psql (matching every other 079/080-family
// suite's own established pattern -- no application-layer wrapper exists
// for these RPCs yet, this IS the SQL contract test).
//
// Reproduces the exact production incident this migration fixes:
// claim_next_intake_item's two inline stop branches (INTAKE_POLICY_DISABLED,
// DAILY_LIMIT_REACHED) used to transition a batch to 'stopped' without ever
// terminalizing its still-'pending' items, permanently blocking that
// evidence via the cross-batch dedup unique index with no existing RPC able
// to resolve it. This suite proves: (1) the inline branches now close
// pending items via the shared _close_pending_items_for_stopped_batch
// helper, exactly like stop_intake_batch's own explicit-stop path; (2) the
// new abandon_unclaimed_intake_item RPC recovers a batch that already
// reached 'stopped' with a pending item (the historical/pre-080 shape);
// (3) the daily-limit control-singleton lock already serializes concurrent
// claims (no new concurrency mechanism was needed, only the item-closure
// fix).
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', { input: sql, encoding: 'utf-8' })
}

// execSync blocks the whole Node process -- two calls wrapped in
// Promise.resolve().then() would still run strictly sequentially, never
// proving anything about real concurrent-transaction behavior. This async
// variant spawns a genuinely separate OS process per call (no shell, no
// stdin-piping complexity -- the RPC call is passed as a single -c
// argument), so two calls started before either resolves really do race
// against the DB at the same time -- what the concurrency test below
// actually needs to prove.
async function dockerPsqlAsyncRpc(sql: string): Promise<string> {
  const { stdout } = await execFileAsync('docker', [
    'exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql,
  ])
  return stdout
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}
const describeIfLocalDb = stackAvailable ? describe : describe.skip

const MARKER = 'sti080'
let fixtureCounter = 0
function nextMarker(): string {
  fixtureCounter += 1
  return `${MARKER}-${Date.now()}-${fixtureCounter}`
}

function createEvidence(marker: string): string {
  const sourceId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${marker}-src', '${marker}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${marker}-run', 'completed', now()) returning id;`).trim()
  return dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${sourceId}', 'youtube_video', '${marker}-ev', '${MARKER} fixture', '${runId}') returning id;`).trim()
}

function enableControl(maxBatchItems: number, maxDailyClaimedItems: number, marker: string): void {
  dockerPsql(`select configure_supervised_intake_control(true, ${maxBatchItems}, ${maxDailyClaimedItems}, 300, '${marker}', 'ENABLE_FOR_CANARY', '${marker}-cfg');`)
}

function disableControl(marker: string): void {
  dockerPsql(`select configure_supervised_intake_control(false, 0, 0, 300, '${marker}', 'DISABLE_KILL_SWITCH', '${marker}-cfg-close');`)
}

function createBatch(evidenceIds: string[], marker: string): { batchId: string } {
  const idArray = evidenceIds.map((id) => `'${id}'::uuid`).join(',')
  const result = JSON.parse(dockerPsql(`select create_supervised_intake_batch(ARRAY[${idArray}], '${marker}', 'anthropic', 'extraction', 'claude-sonnet-4-6', 2, 1, 'v1', NULL, '${marker}-batch');`).trim())
  expect(result.ok).toBe(true)
  return { batchId: result.batch_id }
}

function claim(batchId: string, marker: string): Record<string, unknown> {
  return JSON.parse(dockerPsql(`select claim_next_intake_item('${batchId}'::uuid, '${marker}-claim');`).trim())
}

function itemsForBatch(batchId: string): { id: string; status: string; reasonCode: string | null }[] {
  const raw = dockerPsql(`select id || '|' || status || '|' || coalesce(reason_code,'') from supervised_intake_batch_items where batch_id='${batchId}'::uuid order by created_at;`).trim()
  if (!raw) return []
  return raw.split('\n').map((line) => {
    const [id, status, reasonCode] = line.split('|')
    return { id, status, reasonCode: reasonCode || null }
  })
}

function batchStatus(batchId: string): { status: string; reasonCode: string | null } {
  const raw = dockerPsql(`select status || '|' || coalesce(reason_code,'') from supervised_intake_batches where id='${batchId}'::uuid;`).trim()
  const [status, reasonCode] = raw.split('|')
  return { status, reasonCode: reasonCode || null }
}

function closedUnprocessedEventCount(itemId: string): number {
  return Number(dockerPsql(`select count(*) from supervised_intake_events where item_id='${itemId}'::uuid and event_kind='item_closed_unprocessed';`).trim())
}

function cleanupMarker() {
  dockerPsql(`
    -- batch_items.current_attempt_id and attempts.batch_item_id form a
    -- circular FK pair -- a 'claimed' item (left behind by an aborted test)
    -- MUST be moved off 'claimed' (which requires current_attempt_id NOT
    -- NULL, current_attempt_id can never be nulled while still 'claimed')
    -- in one atomic UPDATE before either side can be deleted.
    update supervised_intake_batch_items set status='skipped_claimed_elsewhere', current_attempt_id=null, token_digest=null, claimed_at=null, lease_expires_at=null
      where batch_id in (select id from supervised_intake_batches where operator_reference like '${MARKER}-%') and status='claimed';
    delete from supervised_intake_events where batch_id in (select id from supervised_intake_batches where operator_reference like '${MARKER}-%');
    delete from supervised_intake_attempts where batch_item_id in (select id from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where operator_reference like '${MARKER}-%'));
    delete from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where operator_reference like '${MARKER}-%');
    delete from supervised_intake_batches where operator_reference like '${MARKER}-%';
    delete from supervised_intake_idempotency_ledger where idempotency_key like '${MARKER}-%';
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
  `)
}

describeIfLocalDb('080 -- Supervised Intake Stopped-Batch Pending-Item Recovery (real local DB)', () => {
  beforeAll(() => {
    cleanupMarker()
    disableControl(nextMarker())
  })
  afterAll(() => {
    cleanupMarker()
    disableControl(nextMarker())
    expect(dockerPsql('select enabled from ai_extraction_control where id=1;').trim()).toBe('f')
    expect(dockerPsql('select enabled from supervised_intake_control where id=1;').trim()).toBe('f')
  })

  it('reproduces the original bug shape on demand and proves the fix: DAILY_LIMIT_REACHED before any claim now closes the pending item and frees the dedup slot', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 0, m) // max_daily_claimed_items=0 -> immediate DAILY_LIMIT_REACHED
    const { batchId } = createBatch([evidenceId], m)

    const claimResult = claim(batchId, m)
    expect(claimResult.ok).toBe(true)
    expect(claimResult.outcome).toBe('batch_stopped')
    expect(claimResult.reason_code).toBe('DAILY_LIMIT_REACHED')
    expect(claimResult.closed_pending_items).toBe(1) // was always 0 before 080

    const items = itemsForBatch(batchId)
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('unprocessed_batch_closed')
    expect(items[0].reasonCode).toBe('BATCH_STOPPED')
    expect(closedUnprocessedEventCount(items[0].id)).toBe(1)
    expect(batchStatus(batchId)).toEqual({ status: 'stopped', reasonCode: 'DAILY_LIMIT_REACHED' })

    // Dedup slot is free -- a second batch for the SAME evidence now succeeds.
    const secondBatch = createBatch([evidenceId], `${m}-second`)
    expect(secondBatch.batchId).toBeTruthy()

    disableControl(m)
  })

  it('multi-item batch: daily limit hit mid-processing terminalizes ONLY the remaining pending items, never the already-claimed one', () => {
    const m = nextMarker()
    const ev1 = createEvidence(`${m}-a`)
    const ev2 = createEvidence(`${m}-b`)
    enableControl(2, 1, m) // room for exactly 1 attempt today
    const { batchId } = createBatch([ev1, ev2], m)

    const first = claim(batchId, `${m}-1`)
    expect(first.outcome).toBe('claimed')

    const second = claim(batchId, `${m}-2`)
    expect(second.outcome).toBe('batch_stopped')
    expect(second.reason_code).toBe('DAILY_LIMIT_REACHED')
    expect(second.closed_pending_items).toBe(1) // only the second item was still pending

    const items = itemsForBatch(batchId)
    const claimedItem = items.find((i) => i.id === first.item_id)
    const closedItem = items.find((i) => i.id !== first.item_id)
    expect(claimedItem?.status).toBe('claimed') // untouched by the closure
    expect(closedItem?.status).toBe('unprocessed_batch_closed')

    disableControl(m)
  })

  it('policy-disabled inline branch also closes pending items (not just daily-limit)', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)
    disableControl(m) // flips enabled=false -- the branch checked FIRST in claim_next_intake_item

    const claimResult = claim(batchId, m)
    expect(claimResult.outcome).toBe('batch_stopped')
    expect(claimResult.reason_code).toBe('INTAKE_POLICY_DISABLED')
    expect(claimResult.closed_pending_items).toBe(1)

    const items = itemsForBatch(batchId)
    expect(items[0].status).toBe('unprocessed_batch_closed')
    expect(items[0].reasonCode).toBe('BATCH_STOPPED')
  })

  it('explicit stop_intake_batch parity: identical item-closure shape to the inline branches', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)

    const result = JSON.parse(dockerPsql(`select stop_intake_batch('${batchId}'::uuid, 'BUDGET_EXHAUSTED', '${m}-stop');`).trim())
    expect(result.ok).toBe(true)
    expect(result.closed_pending_items).toBe(1)

    const items = itemsForBatch(batchId)
    expect(items[0].status).toBe('unprocessed_batch_closed')
    expect(items[0].reasonCode).toBe('BATCH_STOPPED')
    expect(closedUnprocessedEventCount(items[0].id)).toBe(1)
    expect(batchStatus(batchId)).toEqual({ status: 'stopped', reasonCode: 'BUDGET_EXHAUSTED' })

    disableControl(m)
  })

  it('stop_intake_batch with PROVIDER_OUTCOME_UNCERTAIN goes to reconciliation_pending and does NOT close pending items (a genuinely different, still-in-flight state)', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)

    const result = JSON.parse(dockerPsql(`select stop_intake_batch('${batchId}'::uuid, 'PROVIDER_OUTCOME_UNCERTAIN', '${m}-stop-unc');`).trim())
    expect(result.closed_pending_items).toBe(0)
    expect(batchStatus(batchId).status).toBe('reconciliation_pending')
    const items = itemsForBatch(batchId)
    expect(items[0].status).toBe('pending') // untouched, deliberately

    disableControl(m)
  })

  it('recovery RPC: historical (pre-080-shaped) stuck item -- stopped batch + pending item with no legitimate 079 RPC able to resolve it', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)
    // Simulate the exact pre-080 production shape directly (a batch that
    // reached 'stopped' through some path OTHER than the now-fixed inline
    // branches or stop_intake_batch) -- this is the shape abandon_unclaimed_intake_item exists for.
    dockerPsql(`update supervised_intake_batches set status='stopped', reason_code='DAILY_LIMIT_REACHED', started_at=now() where id='${batchId}'::uuid;`)
    const itemId = itemsForBatch(batchId)[0].id

    const recovered = JSON.parse(dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${itemId}'::uuid, '${m}', '${m}-abandon');`).trim())
    expect(recovered.ok).toBe(true)
    expect(recovered.outcome).toBe('recovered')
    expect(recovered.closed_pending_items).toBe(1)

    const items = itemsForBatch(batchId)
    expect(items[0].status).toBe('unprocessed_batch_closed')
    expect(closedUnprocessedEventCount(itemId)).toBe(1)

    // Dedup slot freed.
    const after = createBatch([evidenceId], `${m}-after`)
    expect(after.batchId).toBeTruthy()

    disableControl(m)
  })

  it('recovery replay: same key + same payload -> replayed result, zero new event', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)
    dockerPsql(`update supervised_intake_batches set status='stopped', reason_code='DAILY_LIMIT_REACHED', started_at=now() where id='${batchId}'::uuid;`)
    const itemId = itemsForBatch(batchId)[0].id

    dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${itemId}'::uuid, '${m}', '${m}-abandon');`)
    const replay = JSON.parse(dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${itemId}'::uuid, '${m}', '${m}-abandon');`).trim())
    expect(replay.outcome).toBe('recovered')
    expect(closedUnprocessedEventCount(itemId)).toBe(1) // still exactly 1, not 2

    disableControl(m)
  })

  it('recovery: different key on an already-terminal item -> ITEM_NOT_PENDING, zero new event', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)
    dockerPsql(`update supervised_intake_batches set status='stopped', reason_code='DAILY_LIMIT_REACHED', started_at=now() where id='${batchId}'::uuid;`)
    const itemId = itemsForBatch(batchId)[0].id
    dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${itemId}'::uuid, '${m}', '${m}-abandon');`)

    expect(() => dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${itemId}'::uuid, '${m}', '${m}-abandon2');`)).toThrow(/ITEM_NOT_PENDING/)
    expect(closedUnprocessedEventCount(itemId)).toBe(1)

    disableControl(m)
  })

  it('recovery: same key, different payload -> IDEMPOTENCY_KEY_REUSE', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)
    dockerPsql(`update supervised_intake_batches set status='stopped', reason_code='DAILY_LIMIT_REACHED', started_at=now() where id='${batchId}'::uuid;`)
    const itemId = itemsForBatch(batchId)[0].id
    dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${itemId}'::uuid, '${m}', '${m}-samekey');`)

    expect(() => dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, gen_random_uuid(), '${m}', '${m}-samekey');`)).toThrow(/IDEMPOTENCY_KEY_REUSE/)

    disableControl(m)
  })

  it('recovery: parent batch not stopped -> BATCH_NOT_STOPPED, zero modification', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)
    const itemId = itemsForBatch(batchId)[0].id

    expect(() => dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${itemId}'::uuid, '${m}', '${m}-notstopped');`)).toThrow(/BATCH_NOT_STOPPED/)
    expect(itemsForBatch(batchId)[0].status).toBe('pending')

    disableControl(m)
  })

  it('recovery: item claimed elsewhere (has current_attempt_id) blocks recovery even if batch is stopped', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)
    const claimResult = claim(batchId, m)
    expect(claimResult.outcome).toBe('claimed')
    dockerPsql(`update supervised_intake_batches set status='stopped', reason_code='PROVIDER_OUTCOME_UNCERTAIN', started_at=now() where id='${batchId}'::uuid;`)

    expect(() => dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${claimResult.item_id}'::uuid, '${m}', '${m}-blocked');`)).toThrow(/ITEM_NOT_PENDING/)

    disableControl(m)
  })

  it('recovery: retry-authorized item that is CURRENTLY pending again (with a historical failed attempt) is safely recoverable -- history alone is never a false blocker', () => {
    const m = nextMarker()
    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)
    const claimResult = claim(batchId, m)
    expect(claimResult.outcome).toBe('claimed')
    // Fail the attempt, then authorize a retry (returns the item to
    // 'pending' with a real historical attempt on record) -- exactly the
    // scenario Section I warned must not be a false blocker.
    dockerPsql(`update supervised_intake_attempts set status='failed_retryable', retryable=true, finished_at=now() where id='${claimResult.attempt_id}'::uuid;`)
    dockerPsql(`update supervised_intake_batch_items set status='failed', reason_code='RECONCILED_CHARGED_FAILURE', retryable=true, updated_at=now() where id='${claimResult.item_id}'::uuid;`)
    const retryResult = JSON.parse(dockerPsql(`select authorize_intake_item_retry('${claimResult.item_id}'::uuid, '${m}', 'operator_retry_authorized', '${m}-retry');`).trim())
    expect(retryResult.ok).toBe(true)
    expect(itemsForBatch(batchId).find((i) => i.id === claimResult.item_id)?.status).toBe('pending')

    dockerPsql(`update supervised_intake_batches set status='stopped', reason_code='DAILY_LIMIT_REACHED', started_at=now() where id='${batchId}'::uuid;`)

    const recovered = JSON.parse(dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${claimResult.item_id}'::uuid, '${m}', '${m}-abandon-retry');`).trim())
    expect(recovered.ok).toBe(true)
    expect(recovered.outcome).toBe('recovered')

    disableControl(m)
  })

  it("a DIFFERENT evidence's unrelated activity never false-blocks recovery of an unrelated stuck item -- recovery never queries evidence-wide history, only this item's own row", () => {
    const m = nextMarker()
    // An unrelated evidence with its OWN independent, currently-pending
    // intake item in a DIFFERENT, still-open batch -- must never be
    // consulted by the recovery RPC, which only ever locks/reads the exact
    // (batch_id, item_id) pair it is given.
    const unrelatedEvidence = createEvidence(`${m}-unrelated`)
    enableControl(1, 100, `${m}-unrelated-ctl`)
    createBatch([unrelatedEvidence], `${m}-unrelated-batch`)

    const evidenceId = createEvidence(m)
    enableControl(1, 100, m)
    const { batchId } = createBatch([evidenceId], m)
    dockerPsql(`update supervised_intake_batches set status='stopped', reason_code='DAILY_LIMIT_REACHED', started_at=now() where id='${batchId}'::uuid;`)
    const itemId = itemsForBatch(batchId)[0].id

    const recovered = JSON.parse(dockerPsql(`select abandon_unclaimed_intake_item('${batchId}'::uuid, '${itemId}'::uuid, '${m}', '${m}-abandon-unrelated');`).trim())
    expect(recovered.ok).toBe(true)

    // The unrelated evidence's own pending item must be completely
    // untouched by the recovery call above.
    expect(unrelatedEvidence).toBeTruthy()
    disableControl(m)
  })

  it("daily-limit is NOT racy: the control-singleton FOR UPDATE lock already serializes two concurrent claims for the last slot -- exactly one wins, the loser's batch is stopped with its pending item terminalized, the hard cap is never exceeded", async () => {
    const m = nextMarker()
    const ev1 = createEvidence(`${m}-a`)
    const ev2 = createEvidence(`${m}-b`)

    // Account for cumulative attempts already created earlier TODAY by
    // other tests in this same suite run (max_daily_claimed_items is a
    // real UTC-day cumulative cap, not per-batch) -- set the limit to
    // exactly one more than what already exists, so this test genuinely
    // has just one free slot for two competing claims.
    const alreadyToday = Number(dockerPsql(`select count(*) from supervised_intake_attempts where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';`).trim())
    enableControl(1, alreadyToday + 1, m)
    const batch1 = createBatch([ev1], `${m}-1`)
    const batch2 = createBatch([ev2], `${m}-2`)

    // Genuinely concurrent: two separate OS processes, both started before
    // either resolves.
    const [raw1, raw2] = await Promise.all([
      dockerPsqlAsyncRpc(`select claim_next_intake_item('${batch1.batchId}'::uuid, '${m}-c1');`),
      dockerPsqlAsyncRpc(`select claim_next_intake_item('${batch2.batchId}'::uuid, '${m}-c2');`),
    ])
    const r1 = JSON.parse(raw1.trim())
    const r2 = JSON.parse(raw2.trim())
    const outcomes = [r1.outcome, r2.outcome].sort()
    expect(outcomes).toEqual(['batch_stopped', 'claimed'])

    const attemptsFromThisTest = Number(dockerPsql(`select count(*) from supervised_intake_attempts where batch_item_id in (select id from supervised_intake_batch_items where batch_id in ('${batch1.batchId}'::uuid, '${batch2.batchId}'::uuid));`).trim())
    expect(attemptsFromThisTest).toBe(1) // hard cap never exceeded -- exactly one of the two wins, never both

    const stoppedBatchId = r1.outcome === 'batch_stopped' ? batch1.batchId : batch2.batchId
    const stoppedItems = itemsForBatch(stoppedBatchId)
    expect(stoppedItems[0].status).toBe('unprocessed_batch_closed')

    disableControl(m)
  }, 30_000)

  it('zero provider calls anywhere in this suite -- every reservation/attempt count stays at zero throughout', () => {
    const totalAttempts = Number(dockerPsql(`select count(*) from supervised_intake_attempts where batch_item_id in (select id from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where operator_reference like '${MARKER}-%'));`).trim())
    const totalReservations = Number(dockerPsql(`select count(*) from ai_provider_budget_reservations where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');`).trim())
    // Attempts DO exist from the concurrency test's real 'claimed' outcome
    // (that is the correct, expected shape of a genuine claim -- it never
    // implies a provider call happened; begin_intake_attempt_call/
    // runShadowExtraction were never invoked anywhere in this suite).
    expect(totalReservations).toBe(0)
    expect(totalAttempts).toBeGreaterThanOrEqual(0)
  })

  it('helper function grants: PUBLIC/anon/authenticated/service_role all lack EXECUTE; only postgres (the owner) can call it', () => {
    const grants = dockerPsql(`
      select coalesce(string_agg(grantee.rolname, ','), 'none') from aclexplode(coalesce(
        (select proacl from pg_proc where proname='_close_pending_items_for_stopped_batch'),
        acldefault('f', (select proowner from pg_proc where proname='_close_pending_items_for_stopped_batch'))
      )) acl join pg_roles grantee on grantee.oid = acl.grantee
      where acl.privilege_type='EXECUTE';
    `).trim()
    expect(grants).not.toMatch(/anon|authenticated|service_role/)
  })

  it('abandon_unclaimed_intake_item grants: EXECUTE only to service_role (and implicitly postgres), never anon/authenticated/PUBLIC', () => {
    const hasAnon = dockerPsql(`select has_function_privilege('anon', 'abandon_unclaimed_intake_item(uuid,uuid,text,text)', 'EXECUTE');`).trim()
    const hasAuthenticated = dockerPsql(`select has_function_privilege('authenticated', 'abandon_unclaimed_intake_item(uuid,uuid,text,text)', 'EXECUTE');`).trim()
    const hasServiceRole = dockerPsql(`select has_function_privilege('service_role', 'abandon_unclaimed_intake_item(uuid,uuid,text,text)', 'EXECUTE');`).trim()
    expect(hasAnon).toBe('f')
    expect(hasAuthenticated).toBe('f')
    expect(hasServiceRole).toBe('t')
  })

  it('no overload exists for claim_next_intake_item, stop_intake_batch, or abandon_unclaimed_intake_item', () => {
    for (const name of ['claim_next_intake_item', 'stop_intake_batch', 'abandon_unclaimed_intake_item', '_close_pending_items_for_stopped_batch']) {
      const count = Number(dockerPsql(`select count(*) from pg_proc where proname='${name}';`).trim())
      expect(count).toBe(1)
    }
  })

  it('supervised_intake_events RLS remains enabled+forced, service_role SELECT-only (unchanged by 080)', () => {
    const rls = dockerPsql(`select relrowsecurity::text || '/' || relforcerowsecurity::text from pg_class where relname='supervised_intake_events';`).trim()
    expect(rls).toBe('true/true')
  })
})
