// PFM Supervised Production Candidate Intake v0 -- service-only runner,
// pure unit/contract tests. Every DB/provider boundary is mocked via
// dependency injection (no vi.mock -- the orchestration core itself is
// written to accept an injected client, runShadowExtraction adapter,
// claim-state store, and logger; see lib/semantic-topic/supervised-intake-runner.ts).
// No Docker, no network, no real provider call anywhere in this file.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 5000 })

import {
  parseSupervisedIntakeBatchInputJson,
  validateSupervisedIntakeBatchInput,
  EXIT_CODE,
  CLAIM_STATE_FILE_VERSION,
  type ClaimStateFile,
  type SupervisedIntakeBatchInput,
} from '@/lib/semantic-topic/supervised-intake-types'
import {
  decideItemOutcome,
  runDryRun,
  runSupervisedIntake,
  resolveResumeState,
  createConsoleLogger,
  checkCumulativeDailyCapacity,
  type ClaimStateStore,
  type RunnerLogEvent,
  type SupervisedIntakeRunnerDeps,
} from '@/lib/semantic-topic/supervised-intake-runner'
import type { ShadowExtractionResult } from '@/lib/semantic-topic/extraction-service'
import type { ProviderFailureCategory } from '@/lib/semantic-topic/provider-error-taxonomy'
import type { SemanticTopicAdminClient } from '@/lib/semantic-topic/quota-types'

const VALID_INPUT: SupervisedIntakeBatchInput = {
  idempotencyKey: 'batch-key-001',
  operatorReference: 'test-operator',
  signalEvidenceIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  normalizationVersion: 2,
  extractionSchemaVersion: 1,
  promptVersion: 'v1',
  deterministicExtractorVersion: null,
}

function rawInput(overrides: Record<string, unknown> = {}) {
  return { ...VALID_INPUT, ...overrides }
}

// ===========================================================================
// 1. Input schema and unknown-field rejection
// ===========================================================================
describe('validateSupervisedIntakeBatchInput', () => {
  it('accepts a well-formed input', () => {
    const result = validateSupervisedIntakeBatchInput(rawInput())
    expect(result.ok).toBe(true)
  })

  it('rejects an unknown field', () => {
    const result = validateSupervisedIntakeBatchInput(rawInput({ extraField: 'nope' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.includes('extraField'))).toBe(true)
  })

  for (const forbidden of [
    'confidence', 'specificity', 'structuredOutput', 'reviewOutcome', 'manualReviewConfirmed',
    'semanticTopicId', 'approvalDigest', 'serviceRoleKey', 'providerApiKey', 'apiKey',
    'maxBatchItems', 'maxDailyClaimedItems', 'aiExtractionControlOverride', 'humanReviewFlagOverride',
  ]) {
    it(`rejects the explicitly forbidden field "${forbidden}"`, () => {
      const result = validateSupervisedIntakeBatchInput(rawInput({ [forbidden]: 'x' }))
      expect(result.ok).toBe(false)
    })
  }

  it('rejects a non-UUID evidence id', () => {
    const result = validateSupervisedIntakeBatchInput(rawInput({ signalEvidenceIds: ['not-a-uuid'] }))
    expect(result.ok).toBe(false)
  })

  it('rejects a duplicated evidence id', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const result = validateSupervisedIntakeBatchInput(rawInput({ signalEvidenceIds: [id, id] }))
    expect(result.ok).toBe(false)
  })

  it('rejects an empty evidence-id list', () => {
    const result = validateSupervisedIntakeBatchInput(rawInput({ signalEvidenceIds: [] }))
    expect(result.ok).toBe(false)
  })

  it('rejects a config field that does not match the pinned extraction-config constants', () => {
    expect(validateSupervisedIntakeBatchInput(rawInput({ provider: 'openai' })).ok).toBe(false)
    expect(validateSupervisedIntakeBatchInput(rawInput({ model: 'claude-opus-5' })).ok).toBe(false)
    expect(validateSupervisedIntakeBatchInput(rawInput({ normalizationVersion: 1 })).ok).toBe(false)
    expect(validateSupervisedIntakeBatchInput(rawInput({ extractionSchemaVersion: 2 })).ok).toBe(false)
    expect(validateSupervisedIntakeBatchInput(rawInput({ promptVersion: 'v2' })).ok).toBe(false)
    expect(validateSupervisedIntakeBatchInput(rawInput({ deterministicExtractorVersion: 1 })).ok).toBe(false)
  })

  it('rejects a non-object input', () => {
    expect(validateSupervisedIntakeBatchInput('not an object').ok).toBe(false)
    expect(validateSupervisedIntakeBatchInput(null).ok).toBe(false)
    expect(validateSupervisedIntakeBatchInput([1, 2, 3]).ok).toBe(false)
  })

  it('rejects an operatorReference outside the allowed pattern', () => {
    expect(validateSupervisedIntakeBatchInput(rawInput({ operatorReference: 'a b' })).ok).toBe(false)
    expect(validateSupervisedIntakeBatchInput(rawInput({ operatorReference: 'ab' })).ok).toBe(false)
  })

  it('parseSupervisedIntakeBatchInputJson fails closed on malformed JSON', () => {
    const result = parseSupervisedIntakeBatchInputJson('{not json')
    expect(result.ok).toBe(false)
  })

  it('parseSupervisedIntakeBatchInputJson fails closed on an oversized file', () => {
    const huge = JSON.stringify(rawInput({ operatorReference: 'x'.repeat(300_000) }))
    const result = parseSupervisedIntakeBatchInputJson(huge)
    expect(result.ok).toBe(false)
  })
})

// ===========================================================================
// Shared test doubles
// ===========================================================================

// checkCumulativeDailyCapacity (section G) unconditionally reads
// supervised_intake_control + supervised_intake_attempts before every fresh
// batch creation -- every pre-existing control-flow test in this file
// predates that preflight and never configures either table itself, so both
// the base client and every `mockFromChain(client, '<some other table>', ...)`
// fallback must default these two to "plenty of capacity, zero attempts
// today" (never blocking, never throwing) unless a test deliberately
// overrides one of them to exercise the preflight itself.
function defaultCapacityTableChain(table: string): { select: ReturnType<typeof vi.fn> } | null {
  if (table === 'supervised_intake_control') {
    const maybeSingleMock = vi.fn().mockResolvedValue({ data: { enabled: true, max_daily_claimed_items: 1_000_000 }, error: null })
    return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: maybeSingleMock })) }
  }
  if (table === 'supervised_intake_attempts') {
    // Two distinct chain shapes land on this table name: the restart-resume
    // check (.select('status').eq('id', ...).maybeSingle(), defaulted here
    // to "not found" -- irrelevant unless a test supplies an existing local
    // claim-state file, which every such test already configures itself)
    // and the capacity preflight (.select('id', {count}).gte('created_at',
    // ...), defaulted to zero attempts today).
    const maybeSingleMock = vi.fn().mockResolvedValue({ data: null, error: null })
    const gteMock = vi.fn().mockResolvedValue({ count: 0, error: null })
    return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: maybeSingleMock, gte: gteMock })) }
  }
  return null
}

function createMockClient() {
  const rpc = vi.fn()
  const fromTables: Record<string, { select: ReturnType<typeof vi.fn> }> = {}
  const from = vi.fn((table: string) => {
    const capacityDefault = defaultCapacityTableChain(table)
    if (capacityDefault) {
      fromTables[table] = capacityDefault
      return capacityDefault
    }
    const eqMock = vi.fn().mockReturnThis()
    const maybeSingleMock = vi.fn()
    const selectMock = vi.fn(() => ({ eq: eqMock, maybeSingle: maybeSingleMock }))
    fromTables[table] = { select: selectMock }
    return { select: selectMock, eq: eqMock, maybeSingle: maybeSingleMock }
  })
  return { rpc, from, fromTables } as unknown as SemanticTopicAdminClient & { rpc: ReturnType<typeof vi.fn>; from: ReturnType<typeof vi.fn> }
}

// Simplified chainable .from().select().eq().maybeSingle() mock builder --
// each call configures what the NEXT maybeSingle() resolves to. Also wires a
// default .gte() (zero count) onto the configured table itself, since the
// capacity preflight's .gte() chain can land on the SAME table name a test
// is otherwise configuring for a different purpose (e.g. a resume-state
// test configuring supervised_intake_attempts via .eq().maybeSingle()).
function mockFromChain(client: ReturnType<typeof createMockClient>, table: string, response: { data: unknown; error: unknown }) {
  const eqMock = vi.fn().mockReturnThis()
  const maybeSingleMock = vi.fn().mockResolvedValue(response)
  const gteMock = vi.fn().mockResolvedValue({ count: 0, error: null })
  const selectMock = vi.fn(() => ({ eq: eqMock, maybeSingle: maybeSingleMock, gte: gteMock }))
  ;(client.from as ReturnType<typeof vi.fn>).mockImplementation((t: string) => {
    if (t === table) return { select: selectMock }
    const capacityDefault = defaultCapacityTableChain(t)
    if (capacityDefault) return capacityDefault
    return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })) }
  })
  return { eqMock, maybeSingleMock, selectMock }
}

function createMemoryClaimStateStore(initial: ClaimStateFile | null = null): ClaimStateStore & { current: ClaimStateFile | null; writeCalls: ClaimStateFile[] } {
  let current = initial
  const writeCalls: ClaimStateFile[] = []
  return {
    get current() { return current },
    writeCalls,
    async read() { return current },
    async write(state) { writeCalls.push(state); current = state },
    async clear() { current = null },
  }
}

function createRecordingLogger() {
  const events: RunnerLogEvent[] = []
  return { log: (event: RunnerLogEvent) => events.push(event), events }
}

const EVIDENCE_ROW = { title: 'Evidence title', snippet: 'snippet', canonical_url: null, published_at: null }

function claimedResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true, outcome: 'claimed', item_id: 'item-1', attempt_id: 'attempt-1', signal_evidence_id: VALID_INPUT.signalEvidenceIds[0],
    claim_token: 'plaintext-claim-token-xyz', claim_token_available: true, fencing_generation: 1, lease_expires_at: '2099-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<SupervisedIntakeRunnerDeps> = {}) {
  const client = createMockClient()
  const claimStateStore = createMemoryClaimStateStore()
  const logger = createRecordingLogger()
  const runShadowExtraction = vi.fn()
  return {
    client, claimStateStore, logger, runShadowExtraction,
    deps: { client, claimStateStore, logger, runShadowExtraction, ...overrides } as unknown as SupervisedIntakeRunnerDeps,
  }
}

// ===========================================================================
// 2. Structured extraction-outcome mapping -- every ShadowExtractionResult branch
// ===========================================================================
describe('decideItemOutcome', () => {
  it('completed -> succeed, with review_request_id from a created review', () => {
    const result: ShadowExtractionResult = {
      outcome: 'completed', reservationId: 'res-1', extractionRunId: 'run-1',
      structuredOutput: {} as never, capBreach: false,
      humanReview: { outcome: 'created', reviewRequestId: 'review-1', generation: 1, expiresAt: '2099-01-01T00:00:00Z' },
    }
    expect(decideItemOutcome(result)).toEqual({ kind: 'succeed', providerReservationId: 'res-1', extractionRunId: 'run-1', reviewRequestId: 'review-1' })
  })

  it('completed with humanReview disabled -> succeed with reviewRequestId null', () => {
    const result: ShadowExtractionResult = {
      outcome: 'completed', reservationId: 'res-1', extractionRunId: 'run-1',
      structuredOutput: {} as never, capBreach: false, humanReview: { outcome: 'disabled' },
    }
    expect(decideItemOutcome(result)).toEqual({ kind: 'succeed', providerReservationId: 'res-1', extractionRunId: 'run-1', reviewRequestId: null })
  })

  it('cache_hit -> succeed, providerReservationId is null (no new provider cost)', () => {
    const result: ShadowExtractionResult = { outcome: 'cache_hit', extractionRunId: 'run-2', humanReview: { outcome: 'disabled' } }
    const decision = decideItemOutcome(result)
    expect(decision).toEqual({ kind: 'succeed', providerReservationId: null, extractionRunId: 'run-2', reviewRequestId: null })
  })

  it('cache_hit with a replayed review carries that reviewRequestId through', () => {
    const result: ShadowExtractionResult = {
      outcome: 'cache_hit', extractionRunId: 'run-2',
      humanReview: { outcome: 'replayed', reviewRequestId: 'review-2', generation: 1, expiresAt: '2099-01-01T00:00:00Z' },
    }
    expect(decideItemOutcome(result)).toEqual({ kind: 'succeed', providerReservationId: null, extractionRunId: 'run-2', reviewRequestId: 'review-2' })
  })

  it('input_too_large -> fail_item_continue, not retryable', () => {
    const result: ShadowExtractionResult = { outcome: 'input_too_large', totalInputBytes: 99999 }
    expect(decideItemOutcome(result)).toEqual({ kind: 'fail_item_continue', reasonCode: 'INVALID_EVIDENCE_STATE', retryable: false, diagnosticCode: 'input_too_large' })
  })

  it('failed/malformed_output -> fail_item_continue, NOT retryable (charged attempt, no cost-aware retry gate in 079 v0)', () => {
    const result: ShadowExtractionResult = {
      outcome: 'failed', reservationId: 'res-3', extractionRunId: 'run-3', errorClass: 'malformed_output',
      classification: { category: 'malformed_output_charged', httpStatus: null, billed: 'billed', retryPolicy: 'never_automatic' },
      capBreach: false,
    }
    expect(decideItemOutcome(result)).toEqual({ kind: 'fail_item_continue', reasonCode: 'INVALID_STRUCTURED_OUTPUT', retryable: false, diagnosticCode: 'malformed_output' })
  })

  // Provider Failure Taxonomy v0: each of the four definitely-unbilled 4xx
  // categories now stops the WHOLE batch (never item-local) and is never
  // automatically retryable -- see decideItemOutcome's own header and
  // provider-error-taxonomy.ts for why (account-/config-level, not
  // evidence-specific by default).
  const unbilledTaxonomyCases: Array<{ category: ProviderFailureCategory; httpStatus: number; reasonCode: string; diagnosticCode: string }> = [
    { category: 'authentication_failed', httpStatus: 401, reasonCode: 'PROVIDER_AUTHENTICATION_FAILED', diagnosticCode: 'authentication_failed' },
    { category: 'permission_denied', httpStatus: 403, reasonCode: 'PROVIDER_PERMISSION_DENIED', diagnosticCode: 'permission_denied' },
    { category: 'model_or_endpoint_not_found', httpStatus: 404, reasonCode: 'PROVIDER_MODEL_NOT_FOUND', diagnosticCode: 'model_or_endpoint_not_found' },
    { category: 'invalid_request_unbilled', httpStatus: 400, reasonCode: 'PROVIDER_INVALID_REQUEST_UNBILLED', diagnosticCode: 'invalid_request_unbilled' },
  ]
  for (const { category, httpStatus, reasonCode, diagnosticCode } of unbilledTaxonomyCases) {
    it(`failed/${category} (HTTP ${httpStatus}) -> fail_item_and_stop_batch, retryable=false, ${reasonCode}`, () => {
      const result: ShadowExtractionResult = {
        outcome: 'failed', reservationId: 'res-4', extractionRunId: 'run-4', errorClass: category,
        classification: { category, httpStatus, billed: 'unbilled', retryPolicy: 'batch_stop_required' },
        capBreach: false,
      }
      expect(decideItemOutcome(result)).toEqual({
        kind: 'fail_item_and_stop_batch', reasonCode, retryable: false, diagnosticCode, stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR',
      })
    })
  }

  it('failed/provider_rejected_unbilled_unknown (defensive fallback status) -> fail_item_and_stop_batch, retryable=false, PROVIDER_REJECTED_UNBILLED_UNKNOWN', () => {
    const result: ShadowExtractionResult = {
      outcome: 'failed', reservationId: 'res-4b', extractionRunId: 'run-4b', errorClass: 'provider_rejected_unbilled_unknown',
      classification: { category: 'provider_rejected_unbilled_unknown', httpStatus: 418, billed: 'unbilled', retryPolicy: 'batch_stop_required' },
      capBreach: false,
    }
    expect(decideItemOutcome(result)).toEqual({
      kind: 'fail_item_and_stop_batch', reasonCode: 'PROVIDER_REJECTED_UNBILLED_UNKNOWN', retryable: false,
      diagnosticCode: 'provider_rejected_unbilled_unknown', stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR',
    })
  })

  it('failed with a genuinely unrecognized future classification.category fails closed: batch-fatal, not retryable', () => {
    const result = {
      outcome: 'failed', reservationId: 'res-5', extractionRunId: 'run-5', errorClass: 'brand_new_never_seen_before',
      classification: { category: 'brand_new_never_seen_before' as unknown as ProviderFailureCategory, httpStatus: null, billed: 'uncertain', retryPolicy: 'conservative_uncertain' },
      capBreach: false,
    } as ShadowExtractionResult
    const decision = decideItemOutcome(result)
    expect(decision.kind).toBe('fail_item_and_stop_batch')
    if (decision.kind === 'fail_item_and_stop_batch') {
      expect(decision.retryable).toBe(false)
      expect(decision.stopReasonCode).toBe('AUTHORIZATION_OR_CONFIG_ERROR')
      expect(decision.diagnosticCode.length).toBeLessThanOrEqual(64)
      expect(decision.diagnosticCode).toMatch(/^[A-Za-z0-9_.:-]*$/)
    }
  })

  it('disabled_or_rejected -> fail_item_and_stop_batch, AUTHORIZATION_OR_CONFIG_ERROR', () => {
    const result: ShadowExtractionResult = { outcome: 'disabled_or_rejected', reasonCode: 'invalid_request', message: 'ai_extraction_control.enabled is false' }
    const decision = decideItemOutcome(result)
    expect(decision).toEqual({ kind: 'fail_item_and_stop_batch', reasonCode: 'INVALID_EVIDENCE_STATE', retryable: true, diagnosticCode: 'disabled_or_rejected_invalid_request', stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR' })
  })

  it('disabled_or_rejected with reasonCode ai_extraction_disabled -> fail_item_and_stop_batch, stopReasonCode exactly AI_EXTRACTION_DISABLED (not the generic AUTHORIZATION_OR_CONFIG_ERROR)', () => {
    const result: ShadowExtractionResult = { outcome: 'disabled_or_rejected', reasonCode: 'ai_extraction_disabled', message: 'ai_extraction_disabled' }
    const decision = decideItemOutcome(result)
    expect(decision).toEqual({ kind: 'fail_item_and_stop_batch', reasonCode: 'INVALID_EVIDENCE_STATE', retryable: true, diagnosticCode: 'disabled_or_rejected_ai_extraction_disabled', stopReasonCode: 'AI_EXTRACTION_DISABLED' })
  })

  it('every OTHER disabled_or_rejected reasonCode still maps to the generic AUTHORIZATION_OR_CONFIG_ERROR, never AI_EXTRACTION_DISABLED', () => {
    const otherReasonCodes = ['invalid_request', 'invalid_transition', 'database_error', 'invalid_rpc_response'] as const
    for (const reasonCode of otherReasonCodes) {
      const result: ShadowExtractionResult = { outcome: 'disabled_or_rejected', reasonCode, message: 'x' }
      const decision = decideItemOutcome(result)
      if (decision.kind === 'fail_item_and_stop_batch') expect(decision.stopReasonCode).toBe('AUTHORIZATION_OR_CONFIG_ERROR')
      else throw new Error('expected fail_item_and_stop_batch')
    }
  })

  it('budget_exhausted -> fail_item_and_stop_batch, BUDGET_EXHAUSTED', () => {
    const result: ShadowExtractionResult = { outcome: 'budget_exhausted' }
    const decision = decideItemOutcome(result)
    expect(decision.kind).toBe('fail_item_and_stop_batch')
    if (decision.kind === 'fail_item_and_stop_batch') expect(decision.stopReasonCode).toBe('BUDGET_EXHAUSTED')
  })

  it('attempt_not_started -> fail_item_and_stop_batch, AUTHORIZATION_OR_CONFIG_ERROR', () => {
    const result: ShadowExtractionResult = { outcome: 'attempt_not_started', reservationId: 'res-6', reasonCode: 'invalid_transition', message: 'reservation vanished' }
    const decision = decideItemOutcome(result)
    expect(decision.kind).toBe('fail_item_and_stop_batch')
    if (decision.kind === 'fail_item_and_stop_batch') {
      expect(decision.stopReasonCode).toBe('AUTHORIZATION_OR_CONFIG_ERROR')
      expect(decision.diagnosticCode).toBe('attempt_not_started_invalid_transition')
    }
  })

  it('uncertain -> stop_batch_only, PROVIDER_OUTCOME_UNCERTAIN, no fail_intake_item decision emitted', () => {
    const result: ShadowExtractionResult = {
      outcome: 'uncertain', reservationId: 'res-7', errorClass: 'timeout',
      classification: { category: 'network_or_transport_uncertain', httpStatus: null, billed: 'uncertain', retryPolicy: 'conservative_uncertain' },
    }
    expect(decideItemOutcome(result)).toEqual({ kind: 'stop_batch_only', stopReasonCode: 'PROVIDER_OUTCOME_UNCERTAIN' })
  })

  it('an unrecognized future top-level outcome fails closed at runtime (defense in depth beyond the compile-time exhaustiveness check)', () => {
    const bogus = { outcome: 'some_future_outcome_nobody_added_a_case_for' } as unknown as ShadowExtractionResult
    expect(() => decideItemOutcome(bogus)).toThrow(/unhandled ShadowExtractionResult outcome/)
  })
})

// ===========================================================================
// 3. Dry-run: zero DB mutation, zero provider call, deterministic digest
// ===========================================================================
describe('runDryRun', () => {
  it('never calls .rpc (zero DB mutation) and reports env/policy state read-only', async () => {
    const client = createMockClient()
    mockFromChain(client, 'supervised_intake_control', { data: { enabled: true, max_batch_items: 5, max_daily_claimed_items: 5 }, error: null })
    const logger = createRecordingLogger()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:1'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = undefined as unknown as string

    const { result, report } = await runDryRun({ client, logger }, VALID_INPUT)

    expect(client.rpc).not.toHaveBeenCalled()
    expect(report.envVarsPresent.NEXT_PUBLIC_SUPABASE_URL).toBe(true)
    expect(report.envVarsPresent.SUPABASE_SERVICE_ROLE_KEY).toBe(true)
    expect(result.exitCode).toBe(EXIT_CODE.COMPLETED)
  })

  it('never logs the actual env var values, only presence booleans', async () => {
    const client = createMockClient()
    mockFromChain(client, 'supervised_intake_control', { data: { enabled: true, max_batch_items: 5, max_daily_claimed_items: 5 }, error: null })
    const logger = createRecordingLogger()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'super-secret-value-must-never-appear'

    await runDryRun({ client, logger }, VALID_INPUT)

    const serialized = JSON.stringify(logger.events)
    expect(serialized).not.toContain('super-secret-value-must-never-appear')
  })

  it('produces the identical extractionConfigDigest across two calls with the same input (deterministic)', async () => {
    const client1 = createMockClient()
    mockFromChain(client1, 'supervised_intake_control', { data: { enabled: true, max_batch_items: 5, max_daily_claimed_items: 5 }, error: null })
    const client2 = createMockClient()
    mockFromChain(client2, 'supervised_intake_control', { data: { enabled: true, max_batch_items: 5, max_daily_claimed_items: 5 }, error: null })

    const r1 = await runDryRun({ client: client1, logger: createRecordingLogger() }, VALID_INPUT)
    const r2 = await runDryRun({ client: client2, logger: createRecordingLogger() }, VALID_INPUT)

    expect(r1.report.extractionConfigDigest).toBe(r2.report.extractionConfigDigest)
    expect(r1.report.requestDigestPreview).toBe(r2.report.requestDigestPreview)
  })

  it('flags a disabled supervised_intake_control policy as a dry-run error', async () => {
    const client = createMockClient()
    mockFromChain(client, 'supervised_intake_control', { data: { enabled: false, max_batch_items: 0, max_daily_claimed_items: 0 }, error: null })

    const { result, report } = await runDryRun({ client, logger: createRecordingLogger() }, VALID_INPUT)

    expect(result.exitCode).toBe(EXIT_CODE.VALIDATION_OR_CONFIG_ERROR)
    expect(report.errors.some((e) => e.includes('supervised_intake_control.enabled is false'))).toBe(true)
  })
})

// ===========================================================================
// 4. Claim-state persistence ordering + write-failure safety
// ===========================================================================
describe('runSupervisedIntake -- claim-state persistence', () => {
  it('persists claim state BEFORE begin_intake_attempt_call and BEFORE runShadowExtraction, and clears it after a successful complete', async () => {
    const { client, claimStateStore, logger, runShadowExtraction, deps } = makeDeps()
    ;(client.rpc as ReturnType<typeof vi.fn>).mockImplementation((op: string) => {
      if (op === 'create_supervised_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'batch_created', extraction_config_digest: 'x'.repeat(64) }, error: null })
      if (op === 'claim_next_intake_item') {
        if ((client.rpc as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'claim_next_intake_item').length === 1) {
          return Promise.resolve({ data: claimedResponse(), error: null })
        }
        return Promise.resolve({ data: { ok: true, outcome: 'no_more_items' }, error: null })
      }
      if (op === 'begin_intake_attempt_call') return Promise.resolve({ data: { ok: true, attempt_id: 'attempt-1', base_idempotency_key: 'supervised-intake:item-1:1', status: 'calling' }, error: null })
      if (op === 'complete_intake_item_success') return Promise.resolve({ data: { ok: true, item_id: 'item-1', status: 'succeeded' }, error: null })
      if (op === 'finalize_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'completed' }, error: null })
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${op}` } })
    })
    mockFromChain(client, 'signal_evidence', { data: EVIDENCE_ROW, error: null })

    const callOrder: string[] = []
    const originalWrite = claimStateStore.write.bind(claimStateStore)
    claimStateStore.write = async (state) => { callOrder.push('write_state'); return originalWrite(state) }
    runShadowExtraction.mockImplementation(async () => {
      callOrder.push('run_shadow_extraction')
      return { outcome: 'cache_hit', extractionRunId: 'run-1', humanReview: { outcome: 'disabled' } } satisfies ShadowExtractionResult
    })
    const originalRpc = client.rpc as unknown as (op: string, args: unknown) => Promise<unknown>
    ;(client as unknown as { rpc: unknown }).rpc = vi.fn(async (op: string, args: unknown) => {
      if (op === 'begin_intake_attempt_call') callOrder.push('begin_intake_attempt_call')
      return originalRpc(op, args)
    })

    const result = await runSupervisedIntake(deps, VALID_INPUT)

    expect(result.exitCode).toBe(EXIT_CODE.COMPLETED)
    expect(callOrder.indexOf('write_state')).toBeLessThan(callOrder.indexOf('begin_intake_attempt_call'))
    expect(callOrder.indexOf('begin_intake_attempt_call')).toBeLessThan(callOrder.indexOf('run_shadow_extraction'))
    expect(claimStateStore.current).toBeNull() // cleared after success
  })

  it('a claim-state write failure aborts BEFORE begin_intake_attempt_call and BEFORE runShadowExtraction', async () => {
    const { client, claimStateStore, logger, runShadowExtraction, deps } = makeDeps()
    ;(client.rpc as ReturnType<typeof vi.fn>).mockImplementation((op: string) => {
      if (op === 'create_supervised_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'batch_created', extraction_config_digest: 'x'.repeat(64) }, error: null })
      if (op === 'claim_next_intake_item') return Promise.resolve({ data: claimedResponse(), error: null })
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${op} -- should never be reached after a state-write failure` } })
    })
    claimStateStore.write = vi.fn().mockRejectedValue(new Error('disk full'))

    const result = await runSupervisedIntake(deps, VALID_INPUT)

    expect(result.exitCode).toBe(EXIT_CODE.UNEXPECTED_INTERNAL_ERROR)
    expect((client.rpc as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'begin_intake_attempt_call')).toBe(false)
    expect(runShadowExtraction).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// 5. Batch-level control flow: fatal vs item-local, uncertain -> stop
// ===========================================================================
describe('runSupervisedIntake -- batch control flow', () => {
  function baseRpcMock(client: ReturnType<typeof createMockClient>, extractionResult: ShadowExtractionResult) {
    ;(client.rpc as ReturnType<typeof vi.fn>).mockImplementation((op: string) => {
      if (op === 'create_supervised_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'batch_created', extraction_config_digest: 'x'.repeat(64) }, error: null })
      if (op === 'claim_next_intake_item') return Promise.resolve({ data: claimedResponse(), error: null })
      if (op === 'begin_intake_attempt_call') return Promise.resolve({ data: { ok: true, attempt_id: 'attempt-1', base_idempotency_key: 'supervised-intake:item-1:1', status: 'calling' }, error: null })
      if (op === 'fail_intake_item') return Promise.resolve({ data: { ok: true, item_id: 'item-1', status: 'failed', retryable: true }, error: null })
      if (op === 'stop_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', closed_pending_items: 0 }, error: null })
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${op}` } })
    })
    mockFromChain(client, 'signal_evidence', { data: EVIDENCE_ROW, error: null })
  }

  it('uncertain: stops the batch, never calls fail_intake_item, leaves local claim state in place', async () => {
    const { client, claimStateStore, runShadowExtraction, deps } = makeDeps()
    const uncertainResult: ShadowExtractionResult = {
      outcome: 'uncertain', reservationId: 'res-1', errorClass: 'timeout',
      classification: { category: 'network_or_transport_uncertain', httpStatus: null, billed: 'uncertain', retryPolicy: 'conservative_uncertain' },
    }
    baseRpcMock(client, uncertainResult)
    runShadowExtraction.mockResolvedValue(uncertainResult)

    const result = await runSupervisedIntake(deps, VALID_INPUT)

    expect(result.exitCode).toBe(EXIT_CODE.RECONCILIATION_REQUIRED)
    expect((client.rpc as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'fail_intake_item')).toBe(false)
    expect((client.rpc as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'stop_intake_batch')).toBe(true)
    expect(claimStateStore.current).not.toBeNull() // preserved for reconciliation, never cleared
  })

  it('input_too_large: item-local, batch is NOT stopped (no stop_intake_batch call), continues to the next item', async () => {
    const { client, runShadowExtraction, deps } = makeDeps()
    let claimCalls = 0
    ;(client.rpc as ReturnType<typeof vi.fn>).mockImplementation((op: string) => {
      if (op === 'create_supervised_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'batch_created', extraction_config_digest: 'x'.repeat(64) }, error: null })
      if (op === 'claim_next_intake_item') {
        claimCalls += 1
        if (claimCalls === 1) return Promise.resolve({ data: claimedResponse(), error: null })
        return Promise.resolve({ data: { ok: true, outcome: 'no_more_items' }, error: null })
      }
      if (op === 'begin_intake_attempt_call') return Promise.resolve({ data: { ok: true, attempt_id: 'attempt-1', base_idempotency_key: 'k', status: 'calling' }, error: null })
      if (op === 'fail_intake_item') return Promise.resolve({ data: { ok: true, item_id: 'item-1', status: 'failed', retryable: false }, error: null })
      if (op === 'finalize_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'completed_with_failures' }, error: null })
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${op}` } })
    })
    mockFromChain(client, 'signal_evidence', { data: EVIDENCE_ROW, error: null })
    runShadowExtraction.mockResolvedValue({ outcome: 'input_too_large', totalInputBytes: 99999 } satisfies ShadowExtractionResult)

    const result = await runSupervisedIntake(deps, VALID_INPUT)

    expect(result.exitCode).toBe(EXIT_CODE.COMPLETED)
    expect((client.rpc as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'stop_intake_batch')).toBe(false)
    expect((client.rpc as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'finalize_intake_batch')).toBe(true)
  })

  it('disabled_or_rejected: batch-fatal, calls fail_intake_item THEN stop_intake_batch', async () => {
    const { client, runShadowExtraction, deps } = makeDeps()
    baseRpcMock(client, { outcome: 'disabled_or_rejected', reasonCode: 'invalid_request', message: 'x' })
    runShadowExtraction.mockResolvedValue({ outcome: 'disabled_or_rejected', reasonCode: 'invalid_request', message: 'ai_extraction_control.enabled is false' } satisfies ShadowExtractionResult)

    const result = await runSupervisedIntake(deps, VALID_INPUT)

    expect(result.exitCode).toBe(EXIT_CODE.BATCH_STOPPED)
    const calls = (client.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls.indexOf('fail_intake_item')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('stop_intake_batch')).toBeGreaterThan(calls.indexOf('fail_intake_item'))
  })

  it('never claims a new item once the abort signal has fired', async () => {
    const { client, runShadowExtraction, deps } = makeDeps()
    const controller = new AbortController()
    let claimCalls = 0
    ;(client.rpc as ReturnType<typeof vi.fn>).mockImplementation((op: string) => {
      if (op === 'create_supervised_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'batch_created', extraction_config_digest: 'x'.repeat(64) }, error: null })
      if (op === 'claim_next_intake_item') {
        claimCalls += 1
        return Promise.resolve({ data: claimedResponse(), error: null })
      }
      if (op === 'begin_intake_attempt_call') return Promise.resolve({ data: { ok: true, attempt_id: 'attempt-1', base_idempotency_key: 'k', status: 'calling' }, error: null })
      if (op === 'complete_intake_item_success') return Promise.resolve({ data: { ok: true, item_id: 'item-1', status: 'succeeded' }, error: null })
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${op}` } })
    })
    mockFromChain(client, 'signal_evidence', { data: EVIDENCE_ROW, error: null })
    runShadowExtraction.mockImplementation(async () => {
      controller.abort() // signal arrives WHILE the (only) in-flight item is being processed
      return { outcome: 'cache_hit', extractionRunId: 'run-1', humanReview: { outcome: 'disabled' } } satisfies ShadowExtractionResult
    })

    const result = await runSupervisedIntake(deps, VALID_INPUT, controller.signal)

    expect(claimCalls).toBe(1) // the in-flight item was still let through to completion
    expect(result.exitCode).toBe(EXIT_CODE.BATCH_STOPPED)
  })
})

// ===========================================================================
// 6. Restart/resume (section 7)
// ===========================================================================
describe('resolveResumeState + runSupervisedIntake restart handling', () => {
  it('resolveResumeState: prepared -> resumable_prepared', async () => {
    const client = createMockClient()
    mockFromChain(client, 'supervised_intake_attempts', { data: { status: 'prepared' }, error: null })
    const state: ClaimStateFile = { version: CLAIM_STATE_FILE_VERSION, batchId: 'b', itemId: 'i', attemptId: 'a', signalEvidenceId: 'e', claimToken: 't', claimTokenDigest: 'd', fencingGeneration: 1, leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: '2020-01-01T00:00:00Z' }
    expect(await resolveResumeState(client, state)).toEqual({ kind: 'resumable_prepared' })
  })

  it('resolveResumeState: calling -> blocked_calling', async () => {
    const client = createMockClient()
    mockFromChain(client, 'supervised_intake_attempts', { data: { status: 'calling' }, error: null })
    const state: ClaimStateFile = { version: CLAIM_STATE_FILE_VERSION, batchId: 'b', itemId: 'i', attemptId: 'a', signalEvidenceId: 'e', claimToken: 't', claimTokenDigest: 'd', fencingGeneration: 1, leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: '2020-01-01T00:00:00Z' }
    expect(await resolveResumeState(client, state)).toEqual({ kind: 'blocked_calling' })
  })

  it('resolveResumeState: reconciliation_required -> blocked_needs_reconciliation', async () => {
    const client = createMockClient()
    mockFromChain(client, 'supervised_intake_attempts', { data: { status: 'reconciliation_required' }, error: null })
    const state: ClaimStateFile = { version: CLAIM_STATE_FILE_VERSION, batchId: 'b', itemId: 'i', attemptId: 'a', signalEvidenceId: 'e', claimToken: 't', claimTokenDigest: 'd', fencingGeneration: 1, leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: '2020-01-01T00:00:00Z' }
    expect(await resolveResumeState(client, state)).toEqual({ kind: 'blocked_needs_reconciliation' })
  })

  it('resolveResumeState: completed -> stale_resolved', async () => {
    const client = createMockClient()
    mockFromChain(client, 'supervised_intake_attempts', { data: { status: 'completed' }, error: null })
    const state: ClaimStateFile = { version: CLAIM_STATE_FILE_VERSION, batchId: 'b', itemId: 'i', attemptId: 'a', signalEvidenceId: 'e', claimToken: 't', claimTokenDigest: 'd', fencingGeneration: 1, leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: '2020-01-01T00:00:00Z' }
    expect(await resolveResumeState(client, state)).toEqual({ kind: 'stale_resolved' })
  })

  it('a "calling"-state restart requires reconciliation and NEVER re-calls the provider', async () => {
    const existingState: ClaimStateFile = { version: CLAIM_STATE_FILE_VERSION, batchId: 'batch-1', itemId: 'item-1', attemptId: 'attempt-1', signalEvidenceId: 'e', claimToken: 't', claimTokenDigest: 'd', fencingGeneration: 1, leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: '2020-01-01T00:00:00Z' }
    const { client, claimStateStore, runShadowExtraction, deps } = makeDeps()
    claimStateStore.write(existingState) // pre-seed
    mockFromChain(client, 'supervised_intake_attempts', { data: { status: 'calling' }, error: null })

    const result = await runSupervisedIntake(deps, VALID_INPUT)

    expect(result.exitCode).toBe(EXIT_CODE.RECONCILIATION_REQUIRED)
    expect(runShadowExtraction).not.toHaveBeenCalled()
    expect((client.rpc as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('a "prepared"-state restart resumes at begin_intake_attempt_call without re-claiming a new item', async () => {
    const existingState: ClaimStateFile = { version: CLAIM_STATE_FILE_VERSION, batchId: 'batch-1', itemId: 'item-1', attemptId: 'attempt-1', signalEvidenceId: 'e', claimToken: 't', claimTokenDigest: 'd', fencingGeneration: 1, leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: '2020-01-01T00:00:00Z' }
    const { client, claimStateStore, runShadowExtraction, deps } = makeDeps()
    claimStateStore.write(existingState)
    let attemptStatusQueries = 0
    ;(client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'supervised_intake_attempts') {
        attemptStatusQueries += 1
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { status: 'prepared' }, error: null }) }) }) }
      }
      if (table === 'signal_evidence') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: EVIDENCE_ROW, error: null }) }) }) }
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }
    })
    ;(client.rpc as ReturnType<typeof vi.fn>).mockImplementation((op: string) => {
      if (op === 'begin_intake_attempt_call') return Promise.resolve({ data: { ok: true, attempt_id: 'attempt-1', base_idempotency_key: 'k', status: 'calling' }, error: null })
      if (op === 'complete_intake_item_success') return Promise.resolve({ data: { ok: true, item_id: 'item-1', status: 'succeeded' }, error: null })
      if (op === 'claim_next_intake_item') return Promise.resolve({ data: { ok: true, outcome: 'no_more_items' }, error: null })
      if (op === 'finalize_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'completed' }, error: null })
      return Promise.resolve({ data: null, error: { message: `unexpected create_supervised_intake_batch call on resume: ${op}` } })
    })
    runShadowExtraction.mockResolvedValue({ outcome: 'cache_hit', extractionRunId: 'run-1', humanReview: { outcome: 'disabled' } } satisfies ShadowExtractionResult)

    const result = await runSupervisedIntake(deps, VALID_INPUT)

    expect(attemptStatusQueries).toBe(1)
    expect((client.rpc as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'create_supervised_intake_batch')).toBe(false)
    expect(result.exitCode).toBe(EXIT_CODE.COMPLETED)
  })

  it('a stale (already-resolved) local state file is cleared and the runner proceeds with a fresh batch', async () => {
    const existingState: ClaimStateFile = { version: CLAIM_STATE_FILE_VERSION, batchId: 'batch-old', itemId: 'item-old', attemptId: 'attempt-old', signalEvidenceId: 'e', claimToken: 't', claimTokenDigest: 'd', fencingGeneration: 1, leaseExpiresAt: '2099-01-01T00:00:00Z', claimedAt: '2020-01-01T00:00:00Z' }
    const { client, claimStateStore, deps } = makeDeps()
    claimStateStore.write(existingState)
    mockFromChain(client, 'supervised_intake_attempts', { data: { status: 'completed' }, error: null })
    ;(client.rpc as ReturnType<typeof vi.fn>).mockImplementation((op: string) => {
      if (op === 'create_supervised_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-new', status: 'batch_created', extraction_config_digest: 'x'.repeat(64) }, error: null })
      if (op === 'claim_next_intake_item') return Promise.resolve({ data: { ok: true, outcome: 'no_more_items' }, error: null })
      if (op === 'finalize_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-new', status: 'completed' }, error: null })
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${op}` } })
    })

    const result = await runSupervisedIntake(deps, VALID_INPUT)

    expect(claimStateStore.current).toBeNull()
    expect(result.exitCode).toBe(EXIT_CODE.COMPLETED)
  })
})

// ===========================================================================
// 7. Redaction
// ===========================================================================
describe('log redaction', () => {
  it('createConsoleLogger never lets a claimToken-named field reach the serialized line', () => {
    const originalLog = console.log
    const lines: string[] = []
    console.log = (line: string) => lines.push(line)
    try {
      createConsoleLogger().log({ level: 'info', message: 'test', fields: { claimToken: 'super-secret-token-value', itemId: 'item-1' } })
    } finally {
      console.log = originalLog
    }
    expect(lines.join('')).not.toContain('super-secret-token-value')
    expect(lines.join('')).toContain('[redacted]')
    expect(lines.join('')).toContain('item-1')
  })

  it('never logs the plaintext claim token anywhere during a full successful run', async () => {
    const { client, logger, runShadowExtraction, deps } = makeDeps()
    const SECRET_TOKEN = 'plaintext-claim-token-xyz'
    let claimCalls = 0
    ;(client.rpc as ReturnType<typeof vi.fn>).mockImplementation((op: string) => {
      if (op === 'create_supervised_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'batch_created', extraction_config_digest: 'x'.repeat(64) }, error: null })
      if (op === 'claim_next_intake_item') {
        claimCalls += 1
        if (claimCalls === 1) return Promise.resolve({ data: claimedResponse({ claim_token: SECRET_TOKEN }), error: null })
        return Promise.resolve({ data: { ok: true, outcome: 'no_more_items' }, error: null })
      }
      if (op === 'begin_intake_attempt_call') return Promise.resolve({ data: { ok: true, attempt_id: 'attempt-1', base_idempotency_key: 'k', status: 'calling' }, error: null })
      if (op === 'complete_intake_item_success') return Promise.resolve({ data: { ok: true, item_id: 'item-1', status: 'succeeded' }, error: null })
      if (op === 'finalize_intake_batch') return Promise.resolve({ data: { ok: true, batch_id: 'batch-1', status: 'completed' }, error: null })
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${op}` } })
    })
    mockFromChain(client, 'signal_evidence', { data: EVIDENCE_ROW, error: null })
    runShadowExtraction.mockResolvedValue({ outcome: 'cache_hit', extractionRunId: 'run-1', humanReview: { outcome: 'disabled' } } satisfies ShadowExtractionResult)

    await runSupervisedIntake(deps, VALID_INPUT)

    expect(JSON.stringify(logger.events)).not.toContain(SECRET_TOKEN)
  })
})

// ===========================================================================
// 8. Static source-scan: no regex/message-parsing branching, no direct 079
// table mutation, production adapter wires the canonical runShadowExtraction.
// ===========================================================================
describe('static source guarantees', () => {
  const runnerSource = readFileSync(join(process.cwd(), 'lib/semantic-topic/supervised-intake-runner.ts'), 'utf8')
  const cliSource = readFileSync(join(process.cwd(), 'scripts/supervised-intake-runner.ts'), 'utf8')

  it('decideItemOutcome never calls .includes( or tests a regex against a message/text field for branching', () => {
    const decideFnMatch = runnerSource.match(/export function decideItemOutcome[\s\S]*?\n}\n/)
    expect(decideFnMatch).not.toBeNull()
    const body = decideFnMatch![0]
    expect(body).not.toMatch(/\.message\.includes\(/)
    expect(body).not.toMatch(/\/[^/\n]+\/\.test\(/)
  })

  it('never issues a direct mutating call against a supervised_intake_* table via .from(...).insert/update/delete', () => {
    expect(runnerSource).not.toMatch(/\.from\(\s*['"]supervised_intake_[a-z_]+['"]\s*\)\s*\.(insert|update|delete|upsert)/)
  })

  it('never calls configure_supervised_intake_control, reconcile_stale_intake_claims, resolve_intake_attempt_reconciliation, authorize_intake_item_retry, or cancel_intake_batch', () => {
    for (const forbiddenRpc of [
      'configure_supervised_intake_control',
      'reconcile_stale_intake_claims',
      'resolve_intake_attempt_reconciliation',
      'authorize_intake_item_retry',
      'cancel_intake_batch',
    ]) {
      expect(runnerSource).not.toContain(`'${forbiddenRpc}'`)
    }
  })

  it('the CLI wires the real, canonical runShadowExtraction import, never a substitute', () => {
    expect(cliSource).toMatch(/import\(['"]\.\.\/lib\/semantic-topic\/extraction-service['"]\)/)
    expect(cliSource).toMatch(/runShadowExtraction/)
  })

  it('the CLI never imports a dotenv-style loader and never opens .env/.env.local as a file', () => {
    expect(cliSource).not.toMatch(/import\(['"]dotenv['"]\)/)
    expect(cliSource).not.toMatch(/from ['"]dotenv['"]/)
    expect(cliSource).not.toMatch(/readFile\([^)]*\.env/)
    expect(cliSource).not.toMatch(/require\(['"]\.env/)
  })

  it('no file under scripts/ is imported by anything under app/ (never bundled into the client, never a route)', () => {
    const appDir = join(process.cwd(), 'app')
    let anyReferencesScripts = false
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        const text = readFileSync(full, 'utf8')
        if (/from ['"].*scripts\/supervised-intake-runner/.test(text)) anyReferencesScripts = true
      }
    }
    walk(appDir)
    expect(anyReferencesScripts).toBe(false)
  })

  it('the CLI imports the shared redaction/guard primitives from operator-cli-security.ts, never a local reimplementation', () => {
    expect(runnerSource).toMatch(/import\s*\{\s*redactForDisplay\s*\}\s*from\s*['"]\.\/operator-cli-security['"]/)
    expect(runnerSource).not.toMatch(/function\s+redactForDisplay/)
  })

  it('the CLI top-level catch-all redacts via its own self-contained shortener, never printing a raw error object', () => {
    expect(cliSource).toMatch(/shortenUuidsFallback/)
    expect(cliSource).toMatch(/error:\s*shortenUuidsFallback\(rawMessage\)/)
  })

  it('createConsoleLogger is the ONE place in the runner that calls console.log/console.error -- every other log line goes through the injected RunnerLogger', () => {
    const outsideLogger = runnerSource.replace(/export function createConsoleLogger[\s\S]*?\n}\n/, '')
    expect(outsideLogger).not.toMatch(/console\.(log|error)\(/)
  })
})

// ===========================================================================
// 9. Cumulative daily-capacity preflight (section G)
// ===========================================================================
describe('checkCumulativeDailyCapacity', () => {
  it('reports remainingCapacity = absoluteLimit - claimedOrAttemptedToday when the policy is enabled', async () => {
    const { client } = makeDeps()
    ;(client.from as ReturnType<typeof vi.fn>).mockImplementation((t: string) => {
      if (t === 'supervised_intake_control') return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { enabled: true, max_daily_claimed_items: 50 }, error: null }) })) }
      if (t === 'supervised_intake_attempts') return { select: vi.fn(() => ({ gte: vi.fn().mockResolvedValue({ count: 12, error: null }) })) }
      return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })) }
    })

    const result = await checkCumulativeDailyCapacity(client)

    expect(result).toEqual({ ok: true, policyEnabled: true, claimedOrAttemptedToday: 12, absoluteLimit: 50, remainingCapacity: 38 })
  })

  it('the attempts count query filters by created_at >= UTC midnight of "now", matching claim_next_intake_item (080) exactly', async () => {
    const { client } = makeDeps()
    const gteMock = vi.fn().mockResolvedValue({ count: 0, error: null })
    ;(client.from as ReturnType<typeof vi.fn>).mockImplementation((t: string) => {
      if (t === 'supervised_intake_control') return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { enabled: true, max_daily_claimed_items: 10 }, error: null }) })) }
      if (t === 'supervised_intake_attempts') return { select: vi.fn(() => ({ gte: gteMock })) }
      return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })) }
    })

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-29T17:42:13.500Z'))
      await checkCumulativeDailyCapacity(client)
    } finally {
      vi.useRealTimers()
    }

    expect(gteMock).toHaveBeenCalledWith('created_at', '2026-08-29T00:00:00.000Z')
  })

  it('a disabled policy is reported as policyEnabled=false even when remainingCapacity computes to zero (the at-rest 0 baseline)', async () => {
    const { client } = makeDeps()
    ;(client.from as ReturnType<typeof vi.fn>).mockImplementation((t: string) => {
      if (t === 'supervised_intake_control') return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { enabled: false, max_daily_claimed_items: 0 }, error: null }) })) }
      if (t === 'supervised_intake_attempts') return { select: vi.fn(() => ({ gte: vi.fn().mockResolvedValue({ count: 0, error: null }) })) }
      return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })) }
    })

    const result = await checkCumulativeDailyCapacity(client)

    expect(result).toEqual({ ok: true, policyEnabled: false, claimedOrAttemptedToday: 0, absoluteLimit: 0, remainingCapacity: 0 })
  })

  it('fails closed (ok:false) when supervised_intake_control cannot be read', async () => {
    const { client } = makeDeps()
    ;(client.from as ReturnType<typeof vi.fn>).mockImplementation((t: string) => {
      if (t === 'supervised_intake_control') return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection reset' } }) })) }
      return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })) }
    })

    const result = await checkCumulativeDailyCapacity(client)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('connection reset')
  })

  it('runSupervisedIntake refuses to create a new batch (BATCH_STOPPED) when the policy is enabled and remainingCapacity <= 0, without ever calling create_supervised_intake_batch', async () => {
    const { client, logger, deps } = makeDeps()
    ;(client.from as ReturnType<typeof vi.fn>).mockImplementation((t: string) => {
      if (t === 'supervised_intake_control') return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { enabled: true, max_daily_claimed_items: 5 }, error: null }) })) }
      if (t === 'supervised_intake_attempts') return { select: vi.fn(() => ({ gte: vi.fn().mockResolvedValue({ count: 5, error: null }) })) }
      return { select: vi.fn(() => ({ eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })) }
    })

    const result = await runSupervisedIntake(deps, VALID_INPUT)

    expect(result.exitCode).toBe(EXIT_CODE.BATCH_STOPPED)
    expect((client.rpc as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'create_supervised_intake_batch')).toBe(false)
    expect(JSON.stringify(logger.events)).toMatch(/UTC daily cumulative absolute limit/)
  })

  it('a cache_hit outcome still counted as "attempted" -- the preflight never re-derives capacity from extraction outcomes, only from the attempts table claim_next_intake_item itself writes to', async () => {
    // Structural guarantee: checkCumulativeDailyCapacity never references
    // ShadowExtractionResult/cache_hit/decideItemOutcome at all -- capacity
    // accounting is entirely a function of supervised_intake_attempts row
    // creation (one per claim, regardless of the later extraction outcome),
    // never of this runner's own cache/outcome bookkeeping.
    const runnerSource = readFileSync(join(process.cwd(), 'lib/semantic-topic/supervised-intake-runner.ts'), 'utf8')
    const fnMatch = runnerSource.match(/export async function checkCumulativeDailyCapacity[\s\S]*?\n}\n/)
    expect(fnMatch).not.toBeNull()
    if (fnMatch) {
      expect(fnMatch[0]).not.toMatch(/cache_hit|decideItemOutcome|ShadowExtractionResult/)
      expect(fnMatch[0]).toMatch(/supervised_intake_attempts/)
    }
  })
})
