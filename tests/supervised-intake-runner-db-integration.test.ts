// PFM Supervised Production Candidate Intake v0 -- service-only runner,
// REAL local DB integration test. Same pattern as
// tests/creator-lane-foundation-db-integration.test.ts: uses the existing,
// running local Supabase Docker stack (127.0.0.1:54321, demo service_role
// key -- not production), skips entirely (not a failure) when unavailable.
//
// The runner's orchestration core (createSupervisedIntakeBatch,
// claimNextIntakeItem, beginIntakeAttemptCall, completeIntakeItemSuccess,
// failIntakeItem, stopIntakeBatch, finalizeIntakeBatch) is exercised against
// the REAL 079 RPCs on the REAL local DB -- this is what actually proves
// the runner's RPC argument shapes match migration 079's real signatures,
// something a pure-mock unit test cannot prove on its own. The ONE thing
// still injected/mocked here is runShadowExtraction itself -- there is
// NEVER a real provider call in this file, and ai_extraction_control.enabled
// is asserted to stay false for the entire file, matching every other gate
// in this rollout.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20000 })
import { execSync } from 'node:child_process'
import type { ShadowExtractionResult } from '@/lib/semantic-topic/extraction-service'
import type { SupervisedIntakeBatchInput } from '@/lib/semantic-topic/supervised-intake-types'
import { EXIT_CODE } from '@/lib/semantic-topic/supervised-intake-types'

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const MARKER = 'sti-runner'

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
  return dockerPsql(`insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id) values ('${srcId}', 'youtube_video', '${m}-ev', '${m} runner fixture evidence', '${runId}') returning id;`).trim()
}

function enableControlForFixture(maxItems = 10) {
  dockerPsql(`select configure_supervised_intake_control(true, ${maxItems}, ${maxItems}, 900, 'db-integration-test', 'INITIAL_SETUP', '${nextMarker('cfg')}');`)
}

function resetControlDisabled() {
  dockerPsql(`update supervised_intake_control set enabled=false, max_batch_items=0, max_daily_claimed_items=0, claim_lease_seconds=900 where id=1;`)
}

// Mirrors the circular-FK-aware cleanup ordering established across every
// other 079-adjacent DB integration suite in this rollout: batch_items must
// be reset to a CHECK-satisfying 'pending' shape before attempts can be
// deleted, before items, before batches.
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

async function buildDeps(overrides: { runShadowExtraction?: (input: unknown) => Promise<ShadowExtractionResult> } = {}) {
  const { createAdminClient } = await import('@/lib/supabase-server')
  const { createConsoleLogger } = await import('@/lib/semantic-topic/supervised-intake-runner')
  const client = createAdminClient()
  const events: unknown[] = []
  const logger = { log: (event: unknown) => events.push(event) }
  const claimStateStore = createMemoryStore()
  const runShadowExtraction = overrides.runShadowExtraction ?? (async () => {
    throw new Error('runShadowExtraction must always be overridden in this suite -- never a real provider call')
  })
  return { client, logger, events, claimStateStore, deps: { client, runShadowExtraction, claimStateStore, logger } }
}

function createMemoryStore() {
  let current: unknown = null
  return {
    async read() { return current as never },
    async write(state: unknown) { current = state },
    async clear() { current = null },
    get current() { return current },
  }
}

describeIfLocalDb('Supervised Intake Runner -- real local DB integration (079 RPCs, mocked provider adapter)', () => {
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

  afterEach(() => {
    cleanupMarker()
  })

  it('happy path: create -> claim -> begin -> complete -> finalize, against the real 079 RPCs, ai_extraction_control never touched', async () => {
    enableControlForFixture()
    const evidenceId = createEvidence('happy')
    const { runSupervisedIntake } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const { deps } = await buildDeps({
      runShadowExtraction: async () => {
        const structured = {
          extraction_schema_version: 1, canonical_phenomenon_label: 'runner db-integration test phenomenon', label_language: 'en',
          subject_entities: ['Entity A'], action_or_event: null, location: null, temporal_context: null, specificity: 'specific',
          content_format: 'other', confidence: 0.7, supporting_spans: [{ source_field: 'title', quoted_text: 'runner db-integration test phenomenon' }],
        }
        const escaped = JSON.stringify(structured).replace(/'/g, "''")
        const out = dockerPsql(`select record_topic_extraction_run('${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL, 'norm-${nextMarker('input')}', 1, 'completed', '${escaped}'::jsonb, 100, 50, 0.001, NULL, '${nextMarker('extraction-run')}', now() - interval '1 minute', now());`)
        const runId = (JSON.parse(out) as { extraction_run_id: string }).extraction_run_id
        // cache_hit (not 'completed'): this mock never creates a real
        // ai_provider_budget_reservations row, so providerReservationId
        // must be NULL, exactly matching what a genuine cache-hit result
        // (no new provider spend) would carry -- avoids fabricating a
        // reservation UUID that complete_intake_item_success would reject.
        return { outcome: 'cache_hit', extractionRunId: runId, humanReview: { outcome: 'disabled' } } satisfies ShadowExtractionResult
      },
    })

    const input: SupervisedIntakeBatchInput = { idempotencyKey: nextMarker('batch'), operatorReference: 'db-integration-test', signalEvidenceIds: [evidenceId], ...VALID_CONFIG }
    const result = await runSupervisedIntake(deps, input)

    expect(result.exitCode).toBe(EXIT_CODE.COMPLETED)
    const batchStatus = dockerPsql(`select status from supervised_intake_batches where idempotency_key='${input.idempotencyKey}';`).trim()
    expect(batchStatus).toBe('completed')
    const itemStatus = dockerPsql(`select status from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key='${input.idempotencyKey}');`).trim()
    expect(itemStatus).toBe('succeeded')
    expect(deps.claimStateStore.current).toBeNull()
    expect(dockerPsql('select enabled from ai_extraction_control where id=1;').trim()).toBe('f')
  })

  it('input_too_large: item-local failure, batch finalizes completed_with_failures, never stops the batch', async () => {
    enableControlForFixture()
    const evidenceId = createEvidence('too-large')
    const { runSupervisedIntake } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const { deps } = await buildDeps({
      runShadowExtraction: async () => ({ outcome: 'input_too_large', totalInputBytes: 999999 } satisfies ShadowExtractionResult),
    })

    const input: SupervisedIntakeBatchInput = { idempotencyKey: nextMarker('batch-toolarge'), operatorReference: 'db-integration-test', signalEvidenceIds: [evidenceId], ...VALID_CONFIG }
    const result = await runSupervisedIntake(deps, input)

    expect(result.exitCode).toBe(EXIT_CODE.COMPLETED)
    const row = dockerPsql(`select status||'|'||reason_code||'|'||retryable::text from supervised_intake_batch_items where batch_id in (select id from supervised_intake_batches where idempotency_key='${input.idempotencyKey}');`).trim()
    expect(row).toBe('failed|INVALID_EVIDENCE_STATE|false')
    const batchStatus = dockerPsql(`select status from supervised_intake_batches where idempotency_key='${input.idempotencyKey}';`).trim()
    expect(batchStatus).toBe('completed_with_failures')
  })

  it('disabled_or_rejected-shaped outcome: batch-fatal, stops the batch via the real stop_intake_batch RPC', async () => {
    enableControlForFixture()
    const evidenceId = createEvidence('disabled')
    const { runSupervisedIntake } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const { deps } = await buildDeps({
      runShadowExtraction: async () => ({ outcome: 'disabled_or_rejected', reasonCode: 'invalid_request', message: 'simulated' } satisfies ShadowExtractionResult),
    })

    const input: SupervisedIntakeBatchInput = { idempotencyKey: nextMarker('batch-disabled'), operatorReference: 'db-integration-test', signalEvidenceIds: [evidenceId], ...VALID_CONFIG }
    const result = await runSupervisedIntake(deps, input)

    expect(result.exitCode).toBe(EXIT_CODE.BATCH_STOPPED)
    const row = dockerPsql(`select status||'|'||reason_code from supervised_intake_batches where idempotency_key='${input.idempotencyKey}';`).trim()
    expect(row).toBe('stopped|AUTHORIZATION_OR_CONFIG_ERROR')
  })

  it('a disabled supervised_intake_control policy rejects create_supervised_intake_batch itself, no batch row is ever created, never calls the provider adapter', async () => {
    resetControlDisabled() // explicit: NOT enabled for this one test
    const evidenceId = createEvidence('policy-disabled')
    const { runSupervisedIntake } = await import('@/lib/semantic-topic/supervised-intake-runner')
    const shadowExtraction = vi.fn(async () => ({ outcome: 'input_too_large', totalInputBytes: 1 }) as ShadowExtractionResult)
    const { deps } = await buildDeps({ runShadowExtraction: shadowExtraction })

    const input: SupervisedIntakeBatchInput = { idempotencyKey: nextMarker('batch-policy-off'), operatorReference: 'db-integration-test', signalEvidenceIds: [evidenceId], ...VALID_CONFIG }
    const result = await runSupervisedIntake(deps, input)

    // create_supervised_intake_batch itself checks supervised_intake_control.enabled
    // BEFORE creating anything (migration 079, INTAKE_POLICY_DISABLED) --
    // batch creation fails outright, surfaced as a config-error exit code;
    // claim_next_intake_item's own (separate) INTAKE_POLICY_DISABLED
    // batch_stopped path only matters for a batch that was already created
    // while enabled and then had the policy disabled out from under it.
    expect(result.exitCode).toBe(EXIT_CODE.VALIDATION_OR_CONFIG_ERROR)
    expect(shadowExtraction).not.toHaveBeenCalled()
    const batchCount = dockerPsql(`select count(*) from supervised_intake_batches where idempotency_key='${input.idempotencyKey}';`).trim()
    expect(batchCount).toBe('0')
  })
})
