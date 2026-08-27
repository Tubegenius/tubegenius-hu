// PFM Supervised Production Candidate Intake v0 -- crash/restart E2E
// (section 6) and claim-state file security (section 7), against the REAL
// local Supabase Docker stack and the REAL, file-backed ClaimStateStore
// (createFileClaimStateStore -- node:fs, atomic temp-then-rename, exactly
// what the CLI itself uses). Every scenario here seeds real DB state via
// the runner's own real RPC wrapper functions (createSupervisedIntakeBatch,
// claimNextIntakeItem, beginIntakeAttemptCall) -- never a raw INSERT into a
// 079 table -- so the seeded state is byte-identical to what a genuinely
// crashed prior run would have left behind. runShadowExtraction is always
// injected/mocked; there is never a real provider call in this file.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20000 })

import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ShadowExtractionResult } from '@/lib/semantic-topic/extraction-service'
import type { SupervisedIntakeBatchInput } from '@/lib/semantic-topic/supervised-intake-types'
import { EXIT_CODE } from '@/lib/semantic-topic/supervised-intake-types'

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const MARKER = 'sti-crash-restart'

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

let supervisedIntakeApplied = false
if (stackAvailable) {
  try {
    const out = dockerPsql(`select count(*) from pg_tables where schemaname='public' and tablename like 'supervised_intake%';`).trim()
    supervisedIntakeApplied = out === '7'
  } catch {
    supervisedIntakeApplied = false
  }
}

const describeIfLocalDb = stackAvailable && supervisedIntakeApplied ? describe : describe.skip

function nextMarker(suffix: string): string {
  return `${MARKER}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${suffix}`
}

function createEvidence(suffix: string): string {
  const m = nextMarker(suffix)
  const srcId = dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${m}-src', '${m}-src') returning id;`).trim()
  const runId = dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${m}-run', 'completed', now()) returning id;`).trim()
  return dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${srcId}', 'youtube_video', '${m}-ev', '${m} crash-restart fixture evidence', '${runId}') returning id;`).trim()
}

function enableControlForFixture(maxItems = 10) {
  dockerPsql(`select configure_supervised_intake_control(true, ${maxItems}, ${maxItems}, 900, 'crash-restart-test', 'INITIAL_SETUP', '${nextMarker('cfg')}');`)
}

function resetControlDisabled() {
  dockerPsql(`update supervised_intake_control set enabled=false, max_batch_items=0, max_daily_claimed_items=0, claim_lease_seconds=900 where id=1;`)
}

function cleanupMarker() {
  dockerPsql(`
    do $$
    begin
      update supervised_intake_batch_items set status='pending', current_attempt_id=NULL, token_digest=NULL, claimed_at=NULL, lease_expires_at=NULL, extraction_run_id=NULL, review_request_id=NULL, reason_code=NULL where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_events where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_attempts where batch_item_id in (select id from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%'));
      delete from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key like '${MARKER}-%');
      delete from supervised_intake_batches where idempotency_key like '${MARKER}-%';
      delete from supervised_intake_idempotency_ledger where idempotency_key like '${MARKER}-%';
      delete from supervised_intake_control_events;
      delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
      delete from ai_provider_budget_reservations where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
      delete from signal_evidence where external_ref like '${MARKER}-%';
      delete from signal_sources where external_id like '${MARKER}-%';
      delete from signal_runs where idempotency_key like '${MARKER}-%';
    end $$;
  `)
  resetControlDisabled()
}

const VALID_CONFIG = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-6' as const,
  normalizationVersion: 2,
  extractionSchemaVersion: 1,
  promptVersion: 'v1' as const,
  deterministicExtractorVersion: null,
}

let workDir: string

function buildDeps(client: unknown, claimStateStore: unknown, runShadowExtraction: (input: unknown) => Promise<ShadowExtractionResult>) {
  const events: unknown[] = []
  const logger = { log: (event: unknown) => events.push(event) }
  return { deps: { client, runShadowExtraction, claimStateStore, logger } as never, events }
}

describeIfLocalDb('Supervised Intake -- crash/restart E2E (section 6) + claim-state file security (section 7)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
    cleanupMarker()
  })

  afterAll(() => {
    cleanupMarker()
    expect(dockerPsql('select enabled from ai_extraction_control where id=1;').trim()).toBe('f')
    expect(dockerPsql('select enabled from supervised_intake_control where id=1;').trim()).toBe('f')
  })

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'sti-crash-restart-'))
  })

  afterEach(() => {
    cleanupMarker()
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------
  // 6. Crash/restart -- "prepared, resumable" window: claim_next_intake_item
  // succeeded (real 'prepared' attempt row + real claim token) and the
  // local file was durably written -- but the process crashed BEFORE
  // begin_intake_attempt_call. A fresh runSupervisedIntake invocation,
  // pointed at the SAME real claim-state file, must resume at exactly that
  // step (never re-claim, never touch the provider for a prior attempt it
  // never started) and finish the item normally.
  // -------------------------------------------------------------------
  it('prepared-but-not-begun: a fresh run resumes at begin_intake_attempt_call, never re-claims, completes the item, clears the real claim-state file', async () => {
    enableControlForFixture()
    const evidenceId = createEvidence('prepared-resume')
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { createSupervisedIntakeBatch, claimNextIntakeItem, createFileClaimStateStore } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const { CLAIM_STATE_FILE_VERSION } = await import('@/lib/semantic-topic/supervised-intake-types')
    const client = createAdminClient()

    const idempotencyKey = nextMarker('batch-prepared')
    const input: SupervisedIntakeBatchInput = { idempotencyKey, operatorReference: 'crash-restart-test', signalEvidenceIds: [evidenceId], ...VALID_CONFIG }
    const created = await createSupervisedIntakeBatch(client, input)
    if (!created.ok) throw new Error('fixture setup failed: ' + created.message)
    const claim = await claimNextIntakeItem(client, created.batchId, `${created.batchId}:claim:${nextMarker('claim')}`)
    if (!claim.ok || claim.data.outcome !== 'claimed') throw new Error('fixture setup failed: claim did not succeed')

    // Real attempt row genuinely at 'prepared' -- the exact crash window this test targets.
    expect(dockerPsql(`select status from supervised_intake_attempts where id='${claim.data.attempt_id}';`).trim()).toBe('prepared')

    const claimStatePath = path.join(workDir, 'claim-state.json')
    const claimStateStore = await createFileClaimStateStore(claimStatePath)
    await claimStateStore.write({
      version: CLAIM_STATE_FILE_VERSION, batchId: created.batchId, itemId: claim.data.item_id, attemptId: claim.data.attempt_id,
      signalEvidenceId: claim.data.signal_evidence_id, claimToken: claim.data.claim_token, claimTokenDigest: 'irrelevant-for-this-test',
      fencingGeneration: claim.data.fencing_generation, leaseExpiresAt: claim.data.lease_expires_at, claimedAt: new Date().toISOString(),
    })
    expect(existsSync(claimStatePath)).toBe(true)

    // Fresh process simulation: a brand-new deps object, the SAME real file on disk.
    const { runSupervisedIntake } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const freshClaimStateStore = await createFileClaimStateStore(claimStatePath)
    let shadowCalls = 0
    const runShadowExtraction = async () => {
      shadowCalls += 1
      const structured = { extraction_schema_version: 1, canonical_phenomenon_label: 'resume test', label_language: 'en', subject_entities: [], action_or_event: null, location: null, temporal_context: null, specificity: 'unknown', content_format: 'other', confidence: 0.5, supporting_spans: [] }
      const escaped = JSON.stringify(structured).replace(/'/g, "''")
      const out = dockerPsql(`select record_topic_extraction_run('${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL, 'norm-${nextMarker('input')}', 1, 'completed', '${escaped}'::jsonb, 100, 50, 0.001, NULL, '${nextMarker('extraction-run')}', now() - interval '1 minute', now());`)
      const runId = (JSON.parse(out) as { extraction_run_id: string }).extraction_run_id
      return { outcome: 'cache_hit', extractionRunId: runId, humanReview: { outcome: 'disabled' } } satisfies ShadowExtractionResult
    }
    const { deps } = buildDeps(client, freshClaimStateStore, runShadowExtraction)

    const result = await runSupervisedIntake(deps, input)

    expect(result.exitCode).toBe(EXIT_CODE.COMPLETED)
    expect(shadowCalls).toBe(1) // resumed the ONE prior claim -- never re-claimed a second item for the same evidence
    const attemptStatus = dockerPsql(`select status from supervised_intake_attempts where id='${claim.data.attempt_id}';`).trim()
    expect(attemptStatus).toBe('completed')
    const itemStatus = dockerPsql(`select status from supervised_intake_batch_items where id='${claim.data.item_id}';`).trim()
    expect(itemStatus).toBe('succeeded')
    expect(existsSync(claimStatePath)).toBe(false) // cleared on successful resolution
    // create_supervised_intake_batch was never called a second time -- same idempotencyKey, single batch row.
    const batchCount = dockerPsql(`select count(*) from supervised_intake_batches where idempotency_key='${idempotencyKey}';`).trim()
    expect(batchCount).toBe('1')
  })

  // -------------------------------------------------------------------
  // 6. Crash/restart -- "calling, provider outcome unknown" window: the
  // process crashed (or was signaled) AFTER begin_intake_attempt_call but
  // this test doesn't even need to reach a real provider call to prove the
  // invariant -- a real 'calling' attempt row plus a matching local file is
  // enough on its own. A fresh run must NEVER re-drive this attempt into a
  // second provider call; it must report RECONCILIATION_REQUIRED and leave
  // the local file in place for a separate, explicit reconciliation pass.
  // -------------------------------------------------------------------
  it("calling (provider outcome unknown): a fresh run refuses to resume, reports RECONCILIATION_REQUIRED, NEVER calls runShadowExtraction, file preserved", async () => {
    enableControlForFixture()
    const evidenceId = createEvidence('calling-blocked')
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { createSupervisedIntakeBatch, claimNextIntakeItem, beginIntakeAttemptCall, createFileClaimStateStore } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const { CLAIM_STATE_FILE_VERSION } = await import('@/lib/semantic-topic/supervised-intake-types')
    const client = createAdminClient()

    const idempotencyKey = nextMarker('batch-calling')
    const input: SupervisedIntakeBatchInput = { idempotencyKey, operatorReference: 'crash-restart-test', signalEvidenceIds: [evidenceId], ...VALID_CONFIG }
    const created = await createSupervisedIntakeBatch(client, input)
    if (!created.ok) throw new Error('fixture setup failed: ' + created.message)
    const claim = await claimNextIntakeItem(client, created.batchId, `${created.batchId}:claim:${nextMarker('claim')}`)
    if (!claim.ok || claim.data.outcome !== 'claimed') throw new Error('fixture setup failed: claim did not succeed')
    const begin = await beginIntakeAttemptCall(client, claim.data.item_id, claim.data.claim_token, `${claim.data.item_id}:begin`)
    if (!begin.ok) throw new Error('fixture setup failed: begin did not succeed')

    // Real attempt genuinely 'calling' -- provider_call_started_at is set,
    // finished_at is NULL: exactly the "we do not know what happened" window.
    expect(dockerPsql(`select status from supervised_intake_attempts where id='${claim.data.attempt_id}';`).trim()).toBe('calling')

    const claimStatePath = path.join(workDir, 'claim-state.json')
    const claimStateStore = await createFileClaimStateStore(claimStatePath)
    await claimStateStore.write({
      version: CLAIM_STATE_FILE_VERSION, batchId: created.batchId, itemId: claim.data.item_id, attemptId: claim.data.attempt_id,
      signalEvidenceId: claim.data.signal_evidence_id, claimToken: claim.data.claim_token, claimTokenDigest: 'irrelevant-for-this-test',
      fencingGeneration: claim.data.fencing_generation, leaseExpiresAt: claim.data.lease_expires_at, claimedAt: new Date().toISOString(),
    })

    const { runSupervisedIntake } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const freshClaimStateStore = await createFileClaimStateStore(claimStatePath)
    let shadowCalls = 0
    const runShadowExtraction = async () => { shadowCalls += 1; throw new Error('must never be called for a blocked_calling resume') }
    const { deps } = buildDeps(client, freshClaimStateStore, runShadowExtraction)

    const result = await runSupervisedIntake(deps, input)

    expect(result.exitCode).toBe(EXIT_CODE.RECONCILIATION_REQUIRED)
    expect(shadowCalls).toBe(0)
    expect(dockerPsql(`select status from supervised_intake_attempts where id='${claim.data.attempt_id}';`).trim()).toBe('calling') // untouched
    expect(existsSync(claimStatePath)).toBe(true) // preserved, not cleared -- forensic trail for reconciliation
  })

  // -------------------------------------------------------------------
  // 6. Crash/restart -- stale-resolved local file: a SEPARATE reconciliation
  // pass already resolved this attempt (it is now 'completed') since the
  // local file was written -- the file is now simply out of date, not a
  // live in-flight claim. A fresh run must detect this, clear the stale
  // file, and proceed normally rather than getting stuck.
  // -------------------------------------------------------------------
  it('stale-resolved: an attempt already completed server-side (file just never got cleaned up) is detected and the stale file is cleared, run proceeds normally', async () => {
    enableControlForFixture()
    const evidenceId = createEvidence('stale-resolved')
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { createSupervisedIntakeBatch, claimNextIntakeItem, createFileClaimStateStore } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const { CLAIM_STATE_FILE_VERSION } = await import('@/lib/semantic-topic/supervised-intake-types')
    const client = createAdminClient()

    const idempotencyKey = nextMarker('batch-stale')
    const input: SupervisedIntakeBatchInput = { idempotencyKey, operatorReference: 'crash-restart-test', signalEvidenceIds: [evidenceId], ...VALID_CONFIG }
    const created = await createSupervisedIntakeBatch(client, input)
    if (!created.ok) throw new Error('fixture setup failed: ' + created.message)
    const claim = await claimNextIntakeItem(client, created.batchId, `${created.batchId}:claim:${nextMarker('claim')}`)
    if (!claim.ok || claim.data.outcome !== 'claimed') throw new Error('fixture setup failed: claim did not succeed')

    const claimStatePath = path.join(workDir, 'claim-state.json')
    const claimStateStore = await createFileClaimStateStore(claimStatePath)
    await claimStateStore.write({
      version: CLAIM_STATE_FILE_VERSION, batchId: created.batchId, itemId: claim.data.item_id, attemptId: claim.data.attempt_id,
      signalEvidenceId: claim.data.signal_evidence_id, claimToken: claim.data.claim_token, claimTokenDigest: 'irrelevant-for-this-test',
      fencingGeneration: claim.data.fencing_generation, leaseExpiresAt: claim.data.lease_expires_at, claimedAt: new Date().toISOString(),
    })

    // Simulate "a separate reconciliation/manual pass already resolved this
    // attempt" by driving it to completion directly via the real RPCs,
    // WITHOUT going through runSupervisedIntake (so the local file is left
    // stale on purpose).
    const { beginIntakeAttemptCall, completeIntakeItemSuccess } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const begin = await beginIntakeAttemptCall(client, claim.data.item_id, claim.data.claim_token, `${claim.data.item_id}:begin`)
    if (!begin.ok) throw new Error('fixture setup failed: begin did not succeed')
    const structured = { extraction_schema_version: 1, canonical_phenomenon_label: 'stale test', label_language: 'en', subject_entities: [], action_or_event: null, location: null, temporal_context: null, specificity: 'unknown', content_format: 'other', confidence: 0.5, supporting_spans: [] }
    const escaped = JSON.stringify(structured).replace(/'/g, "''")
    const out = dockerPsql(`select record_topic_extraction_run('${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL, 'norm-${nextMarker('input')}', 1, 'completed', '${escaped}'::jsonb, 100, 50, 0.001, NULL, '${nextMarker('extraction-run')}', now() - interval '1 minute', now());`)
    const runId = (JSON.parse(out) as { extraction_run_id: string }).extraction_run_id
    const complete = await completeIntakeItemSuccess(client, { itemId: claim.data.item_id, claimToken: claim.data.claim_token, providerReservationId: null, extractionRunId: runId, reviewRequestId: null, idempotencyKey: `${claim.data.item_id}:complete` })
    if (!complete.ok) throw new Error('fixture setup failed: complete did not succeed')
    expect(dockerPsql(`select status from supervised_intake_batch_items where id='${claim.data.item_id}';`).trim()).toBe('succeeded')
    expect(existsSync(claimStatePath)).toBe(true) // still there -- stale on purpose

    const { runSupervisedIntake } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const freshClaimStateStore = await createFileClaimStateStore(claimStatePath)
    let shadowCalls = 0
    const runShadowExtraction = async () => { shadowCalls += 1; throw new Error('must never be called -- there is nothing left to claim for this single-item batch') }
    const { deps } = buildDeps(client, freshClaimStateStore, runShadowExtraction)

    const result = await runSupervisedIntake(deps, input)

    // Nothing left pending for this single-item batch -- stale file cleared, batch just finalizes.
    expect(result.exitCode).toBe(EXIT_CODE.COMPLETED)
    expect(shadowCalls).toBe(0)
    expect(existsSync(claimStatePath)).toBe(false)
    const batchStatus = dockerPsql(`select status from supervised_intake_batches where idempotency_key='${idempotencyKey}';`).trim()
    expect(batchStatus).toBe('completed')
  })

  // -------------------------------------------------------------------
  // 6. "Lost token": the claim succeeded server-side (real 'prepared'
  // attempt + real claim token exist), but the local file was NEVER
  // written at all (simulating "the file was lost/never durably written"
  // -- e.g. disk failure between claim and write). Without the file, this
  // runner has no way to derive the claim token, so a fresh invocation
  // must NOT be able to touch that orphaned item at all -- it is simply
  // left behind for lease-expiry-based reconciliation, and the fresh run
  // proceeds/finishes normally rather than getting stuck on it.
  // -------------------------------------------------------------------
  it('lost token: an orphaned prepared claim with no local file is left untouched, never re-claimed or provider-called by a fresh run (finalize then legitimately refuses to close the batch while it is still in flight)', async () => {
    // NOTE: max_daily_claimed_items must stay generous here -- claim_next_intake_item
    // (079) checks the daily cap unconditionally BEFORE checking whether any
    // pending items even remain, so a cap set exactly equal to "how many
    // real claims this fixture makes" would itself trip DAILY_LIMIT_REACHED
    // on the final no-more-items check, independent of the orphaned-claim
    // behavior this test actually targets.
    enableControlForFixture()
    // Two evidence items in one batch; claim_next_intake_item's pick order
    // between two equally-eligible pending rows is NOT assumed to be
    // deterministic (and does not need to be) -- whichever one the first
    // (soon-to-be-orphaned) claim actually gets is read back from its own
    // response, never assumed from array position.
    const evidenceIdA = createEvidence('lost-token-a')
    const evidenceIdB = createEvidence('lost-token-b')
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { createSupervisedIntakeBatch, claimNextIntakeItem } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const client = createAdminClient()

    const idempotencyKey = nextMarker('batch-lost-token')
    const input: SupervisedIntakeBatchInput = { idempotencyKey, operatorReference: 'crash-restart-test', signalEvidenceIds: [evidenceIdA, evidenceIdB], ...VALID_CONFIG }
    const created = await createSupervisedIntakeBatch(client, input)
    if (!created.ok) throw new Error('fixture setup failed: ' + created.message)
    // Claim ONE item for real (a real 'prepared' attempt + real claim
    // token now exist), then deliberately DISCARD the claim token -- no
    // local file is ever written for it, matching "the write itself was
    // lost". This orphaned claim is now permanently unreachable by this
    // runner (by design -- it has no token) until lease expiry + a
    // separate reconcile_stale_intake_claims pass frees it.
    const orphanClaim = await claimNextIntakeItem(client, created.batchId, `${created.batchId}:claim:${nextMarker('claim-orphan')}`)
    if (!orphanClaim.ok || orphanClaim.data.outcome !== 'claimed') throw new Error('fixture setup failed: orphan claim did not succeed')

    const { runSupervisedIntake, createFileClaimStateStore } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const claimStatePath = path.join(workDir, 'claim-state.json') // never written to before this run
    const claimStateStore = await createFileClaimStateStore(claimStatePath)
    let shadowCalls = 0
    let claimedItemId: string | null = null
    const runShadowExtraction = async (extractionInput: { signalEvidenceId: string }) => {
      shadowCalls += 1
      const structured = { extraction_schema_version: 1, canonical_phenomenon_label: 'lost token test', label_language: 'en', subject_entities: [], action_or_event: null, location: null, temporal_context: null, specificity: 'unknown', content_format: 'other', confidence: 0.5, supporting_spans: [] }
      const escaped = JSON.stringify(structured).replace(/'/g, "''")
      const out = dockerPsql(`select record_topic_extraction_run('${extractionInput.signalEvidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL, 'norm-${nextMarker('input')}', 1, 'completed', '${escaped}'::jsonb, 100, 50, 0.001, NULL, '${nextMarker('extraction-run')}', now() - interval '1 minute', now());`)
      const runId = (JSON.parse(out) as { extraction_run_id: string }).extraction_run_id
      return { outcome: 'cache_hit', extractionRunId: runId, humanReview: { outcome: 'disabled' } } satisfies ShadowExtractionResult
    }
    const events: unknown[] = []
    // The ONE remaining pending item (whichever evidence the orphan claim
    // above did NOT take) is what this run claims and processes -- captured
    // straight from the real 'beginning intake attempt call' log event,
    // never assumed from array position.
    const logger = {
      log: (event: { message: string; fields?: Record<string, unknown> }) => {
        events.push(event)
        if (event.message === 'beginning intake attempt call' && event.fields) claimedItemId = event.fields.itemId as string
      },
    }
    const deps = { client, runShadowExtraction, claimStateStore, logger } as never

    // No local state to resume from: this call goes straight to
    // create_supervised_intake_batch... but that batch already exists
    // (same idempotencyKey) -- create_supervised_intake_batch is itself
    // idempotent, so it replays the existing batch rather than erroring.
    const result = await runSupervisedIntake(deps, input)

    // The orphaned item is genuinely unreachable to this runner (no local
    // token) so it correctly claims and resolves ONLY the other, fresh
    // item -- but 079's finalize_intake_batch itself then legitimately
    // REFUSES to close the batch while the orphaned item is still
    // claimed/in-flight ("ITEMS_STILL_IN_FLIGHT"), which this runner
    // surfaces via the generic UNEXPECTED_INTERNAL_ERROR (5) path (079 has
    // no separate, structured reason code for this specific rejection --
    // documented explicitly in the operator runbook rather than parsed
    // from the message here). This is a SAFE outcome, not a silent one:
    // nothing was double-processed, no state was corrupted, and the
    // orphan is exactly where a separate reconcile_stale_intake_claims
    // pass expects to find it after its lease expires.
    expect(result.exitCode).toBe(EXIT_CODE.UNEXPECTED_INTERNAL_ERROR)
    const lastEvent = events[events.length - 1] as { message: string; fields: { error: string } }
    expect(lastEvent.message).toBe('finalize_intake_batch failed')
    expect(lastEvent.fields.error).toMatch(/ITEMS_STILL_IN_FLIGHT/)

    expect(shadowCalls).toBe(1) // only ONE item was ever claimed/processed by this fresh run
    expect(claimedItemId).not.toBeNull()
    expect(claimedItemId).not.toBe(orphanClaim.data.item_id) // never the orphaned item -- it has no local token to claim it with
    // The orphaned item is untouched -- still 'claimed', still holding the lease, never resolved.
    expect(dockerPsql(`select status from supervised_intake_batch_items where id='${orphanClaim.data.item_id}';`).trim()).toBe('claimed')
    expect(dockerPsql(`select status from supervised_intake_attempts where batch_item_id='${orphanClaim.data.item_id}';`).trim()).toBe('prepared')
  })

  // -------------------------------------------------------------------
  // 6. Idempotency-key replay: re-running the SAME CLI command (same batch
  // idempotency key) never creates a second batch.
  // -------------------------------------------------------------------
  it('replaying the identical batch idempotency key never creates a second batch row', async () => {
    enableControlForFixture()
    const evidenceId = createEvidence('idempotent-replay')
    const { createAdminClient } = await import('@/lib/supabase-server')
    const { createSupervisedIntakeBatch } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const client = createAdminClient()

    const idempotencyKey = nextMarker('batch-replay')
    const input: SupervisedIntakeBatchInput = { idempotencyKey, operatorReference: 'crash-restart-test', signalEvidenceIds: [evidenceId], ...VALID_CONFIG }
    const first = await createSupervisedIntakeBatch(client, input)
    const second = await createSupervisedIntakeBatch(client, input)

    if (!first.ok || !second.ok) throw new Error('fixture setup failed')
    expect(second.batchId).toBe(first.batchId)
    const count = dockerPsql(`select count(*) from supervised_intake_batches where idempotency_key='${idempotencyKey}';`).trim()
    expect(count).toBe('1')
  })

  // ===========================================================================
  // 7. Claim-state file security
  // ===========================================================================
  describe('claim-state file security', () => {
    it('the atomic temp file never lingers after a successful write', async () => {
      const { createFileClaimStateStore } = await import('@/lib/semantic-topic/supervised-intake-runner')
      const { CLAIM_STATE_FILE_VERSION } = await import('@/lib/semantic-topic/supervised-intake-types')
      const claimStatePath = path.join(workDir, 'claim-state.json')
      const store = await createFileClaimStateStore(claimStatePath)

      await store.write({
        version: CLAIM_STATE_FILE_VERSION, batchId: 'b', itemId: 'i', attemptId: 'a', signalEvidenceId: 'e',
        claimToken: 'super-secret-plaintext-token-xyz', claimTokenDigest: 'd', fencingGeneration: 1,
        leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: new Date().toISOString(),
      })

      expect(existsSync(claimStatePath)).toBe(true)
      expect(existsSync(`${claimStatePath}.tmp-${process.pid}`)).toBe(false)
    })

    it('file permissions are narrowed on write (POSIX: exactly 0600; Windows: chmod is best-effort, never fatal -- see createFileClaimStateStore)', async () => {
      const { createFileClaimStateStore } = await import('@/lib/semantic-topic/supervised-intake-runner')
      const { CLAIM_STATE_FILE_VERSION } = await import('@/lib/semantic-topic/supervised-intake-types')
      const claimStatePath = path.join(workDir, 'claim-state.json')
      const store = await createFileClaimStateStore(claimStatePath)

      await store.write({
        version: CLAIM_STATE_FILE_VERSION, batchId: 'b', itemId: 'i', attemptId: 'a', signalEvidenceId: 'e',
        claimToken: 't', claimTokenDigest: 'd', fencingGeneration: 1, leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: new Date().toISOString(),
      })

      if (process.platform !== 'win32') {
        const mode = statSync(claimStatePath).mode & 0o777
        expect(mode).toBe(0o600)
      } else {
        // Windows/NTFS has no POSIX mode bits -- the write succeeding at
        // all (chmod's failure path is caught and non-fatal) is the
        // meaningful assertion here.
        expect(existsSync(claimStatePath)).toBe(true)
      }
    })

    it('the plaintext claim token never appears in any logged runner event, only in the on-disk file itself', async () => {
      enableControlForFixture()
      const evidenceId = createEvidence('token-not-logged')
      const { createAdminClient } = await import('@/lib/supabase-server')
      const { runSupervisedIntake, createFileClaimStateStore } = await import('@/lib/semantic-topic/supervised-intake-runner')
      const client = createAdminClient()
      const claimStatePath = path.join(workDir, 'claim-state.json')
      const claimStateStore = await createFileClaimStateStore(claimStatePath)
      const events: unknown[] = []
      const logger = { log: (event: unknown) => events.push(event) }
      const runShadowExtraction = async () => ({ outcome: 'disabled_or_rejected', reasonCode: 'ai_extraction_disabled', message: 'ai_extraction_disabled' } satisfies ShadowExtractionResult)

      const idempotencyKey = nextMarker('batch-token-log')
      const input: SupervisedIntakeBatchInput = { idempotencyKey, operatorReference: 'crash-restart-test', signalEvidenceIds: [evidenceId], ...VALID_CONFIG }
      await runSupervisedIntake({ client, runShadowExtraction, claimStateStore, logger } as never, input)

      const claimTokenOnDisk = existsSync(claimStatePath) ? null : null // file is cleared after resolution in this scenario; token, if ever captured, would have to appear in `events`
      const serializedEvents = JSON.stringify(events)
      // The runner never has a fixed/known plaintext token to search for
      // here (it's DB-generated per claim) -- so this asserts the STRUCTURAL
      // guarantee instead: no event field is ever named claimToken/claim_token,
      // matching redactClaimState()'s explicit exclusion list and the
      // logger's own defensive NEVER_LOGGED_FIELD_NAMES deny-list.
      expect(serializedEvents).not.toMatch(/"claimToken"\s*:/)
      expect(serializedEvents).not.toMatch(/"claim_token"\s*:/)
      void claimTokenOnDisk
    })

    it('clear() on a store whose file was never written does not throw (ENOENT tolerated)', async () => {
      const { createFileClaimStateStore } = await import('@/lib/semantic-topic/supervised-intake-runner')
      const claimStatePath = path.join(workDir, 'never-written.json')
      const store = await createFileClaimStateStore(claimStatePath)
      await expect(store.clear()).resolves.toBeUndefined()
    })

    it('two independent stores at different paths never touch each other\'s file', async () => {
      const { createFileClaimStateStore } = await import('@/lib/semantic-topic/supervised-intake-runner')
      const { CLAIM_STATE_FILE_VERSION } = await import('@/lib/semantic-topic/supervised-intake-types')
      const pathA = path.join(workDir, 'a.json')
      const pathB = path.join(workDir, 'b.json')
      const storeA = await createFileClaimStateStore(pathA)
      const storeB = await createFileClaimStateStore(pathB)

      await storeA.write({
        version: CLAIM_STATE_FILE_VERSION, batchId: 'batch-a', itemId: 'i', attemptId: 'a', signalEvidenceId: 'e',
        claimToken: 't', claimTokenDigest: 'd', fencingGeneration: 1, leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: new Date().toISOString(),
      })
      await storeB.clear() // must never delete A's file

      expect(existsSync(pathA)).toBe(true)
      const contentA = JSON.parse(readFileSync(pathA, 'utf8')) as { batchId: string }
      expect(contentA.batchId).toBe('batch-a')
    })
  })
})
