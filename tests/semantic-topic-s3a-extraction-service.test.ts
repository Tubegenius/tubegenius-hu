// Semantic Topic Identity v0 -- S3A extraction-service unit tests.
// Pure unit tests -- every DB/provider boundary is mocked. No Docker, no
// network, no ANTHROPIC_API_KEY needed. DB-level behavior (quota RPC state
// machine, cap enforcement, digest cross-match with 074) is covered
// separately in tests/semantic-topic-s3a-ai-quota-db-integration.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/semantic-topic/ai-quota', () => ({
  reserveAiProviderUnits: vi.fn(),
  markAiProviderAttemptStarted: vi.fn(),
  commitAiProviderUnits: vi.fn(),
  markAiProviderOutcomeUnknown: vi.fn(),
  releaseAiProviderUnits: vi.fn(),
  finalizeAiProviderReservationOutcome: vi.fn(),
  reconcileStaleAiProviderReservations: vi.fn(),
}))
vi.mock('@/lib/semantic-topic/provider-adapter', () => ({
  callAnthropicForExtraction: vi.fn(),
  classifyProviderError: vi.fn(() => 'mocked_error_class'),
  isDefinitelyUnbilledProviderError: vi.fn(() => false),
}))
vi.mock('@/lib/semantic-topic/extraction-writer', () => ({
  findCompletedExtractionRun: vi.fn(),
  recordCompletedExtractionRun: vi.fn(),
  recordFailedExtractionRun: vi.fn(),
}))

import {
  commitAiProviderUnits,
  finalizeAiProviderReservationOutcome,
  markAiProviderAttemptStarted,
  markAiProviderOutcomeUnknown,
  reconcileStaleAiProviderReservations,
  releaseAiProviderUnits,
  reserveAiProviderUnits,
} from '@/lib/semantic-topic/ai-quota'
import { callAnthropicForExtraction, isDefinitelyUnbilledProviderError } from '@/lib/semantic-topic/provider-adapter'
import {
  findCompletedExtractionRun,
  recordCompletedExtractionRun,
  recordFailedExtractionRun,
} from '@/lib/semantic-topic/extraction-writer'
import { runShadowExtraction, runValidationOnly } from '@/lib/semantic-topic/extraction-service'
import {
  AI_QUOTA_MAX_INPUT_BYTES,
  SEMANTIC_TOPIC_EXTRACTION_MODEL,
  SEMANTIC_TOPIC_EXTRACTION_PROVIDER,
} from '@/lib/semantic-topic/extraction-config'
import { buildNormalizedExtractionInput } from '@/lib/semantic-topic/normalize'
import { computeExtractionConfigDigest, computeNormalizedInputDigest } from '@/lib/semantic-topic/digest'
import { validateTopicExtractionOutputV1 } from '@/lib/semantic-topic/structured-output-schema'

const EVIDENCE = {
  signalEvidenceId: '11111111-1111-4111-8111-111111111111',
  evidence: { title: 'Test title', snippet: 'Test snippet', canonicalUrl: null, publishedAt: null },
}

const VALID_OUTPUT = {
  extraction_schema_version: 1,
  canonical_phenomenon_label: 'Test phenomenon',
  label_language: 'en',
  subject_entities: ['Entity A'],
  action_or_event: null,
  location: null,
  temporal_context: null,
  specificity: 'specific' as const,
  content_format: 'other' as const,
  confidence: 0.9,
  supporting_spans: [{ source_field: 'title', quoted_text: 'Test' }],
}

function mockedFn<T extends (...args: any[]) => any>(fn: T) {
  return fn as unknown as ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('extraction-config -- pinned model', () => {
  it('the exact model id is pinned, not an alias', () => {
    expect(SEMANTIC_TOPIC_EXTRACTION_MODEL).toBe('claude-sonnet-4-6')
    expect(SEMANTIC_TOPIC_EXTRACTION_PROVIDER).toBe('anthropic')
  })
})

describe('extraction-service.ts -- structural boundary (no assignment RPC)', () => {
  // Comments MAY document that record_topic_assignment_decision is out of
  // scope (and do, in extraction-writer.ts's header) -- what must never
  // exist anywhere in this module's tree is an actual RPC INVOCATION of it,
  // or a direct write to the semantic_topics/semantic_topic_membership
  // tables the S2B RPCs own.
  const rpcCallPattern = /\.rpc\(\s*['"]record_topic_assignment_decision['"]/
  const directTablePattern = /\bfrom\(\s*['"]semantic_topics?['"]/

  it('never invokes record_topic_assignment_decision or writes semantic_topics/semantic_topic_membership directly', () => {
    const source = readFileSync(join(process.cwd(), 'lib/semantic-topic/extraction-service.ts'), 'utf8')
    expect(source).not.toMatch(rpcCallPattern)
    expect(source).not.toMatch(directTablePattern)
  })
  it('extraction-writer.ts never invokes record_topic_assignment_decision either', () => {
    const source = readFileSync(join(process.cwd(), 'lib/semantic-topic/extraction-writer.ts'), 'utf8')
    expect(source).not.toMatch(rpcCallPattern)
    expect(source).not.toMatch(directTablePattern)
  })
})

describe('digest.ts -- determinism', () => {
  it('the same normalized input always produces the same digest', () => {
    const a = computeNormalizedInputDigest('same text')
    const b = computeNormalizedInputDigest('same text')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
  it('the same extraction config always produces the same digest, regardless of call order', () => {
    const input = { normalizationVersion: 1, extractionSchemaVersion: 1, provider: 'anthropic', model: 'claude-sonnet-4-6', promptVersion: 'v1' }
    const a = computeExtractionConfigDigest(input)
    const b = computeExtractionConfigDigest({ ...input })
    expect(a).toBe(b)
  })
  it('different normalized input produces a different digest', () => {
    expect(computeNormalizedInputDigest('text A')).not.toBe(computeNormalizedInputDigest('text B'))
  })
})

describe('runValidationOnly -- pure, no provider/DB', () => {
  it('accepts a well-formed structured_output fixture', () => {
    const result = runValidationOnly({ evidence: EVIDENCE.evidence, structuredOutput: VALID_OUTPUT })
    expect(result.ok).toBe(true)
    expect(mockedFn(reserveAiProviderUnits)).not.toHaveBeenCalled()
    expect(mockedFn(callAnthropicForExtraction)).not.toHaveBeenCalled()
  })
  it('rejects an unknown top-level key', () => {
    const result = runValidationOnly({ evidence: EVIDENCE.evidence, structuredOutput: { ...VALID_OUTPUT, extra_field: 'x' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/unknown top-level key/)
  })
  it('rejects an out-of-range confidence', () => {
    const result = runValidationOnly({ evidence: EVIDENCE.evidence, structuredOutput: { ...VALID_OUTPUT, confidence: 1.5 } })
    expect(result.ok).toBe(false)
  })
  it('normalized input matches buildNormalizedExtractionInput directly', () => {
    const result = runValidationOnly({ evidence: EVIDENCE.evidence, structuredOutput: VALID_OUTPUT })
    expect(result.normalizedInput).toBe(buildNormalizedExtractionInput(EVIDENCE.evidence))
  })
})

describe('runShadowExtraction', () => {
  it('completed-cache hit: 0 provider calls, 0 new reservation', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue({ extractionRunId: 'cached-run-id' })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-1' })

    // humanReview: disabled by default (SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
    // is unset in this unit-test environment) -- added by the Application
    // Integration Closure gate; see extraction-service.ts's cache_hit
    // branch and human-review-extraction-hook.ts for why cache_hit must
    // also carry this field, not just the completed branch.
    expect(result).toEqual({ outcome: 'cache_hit', extractionRunId: 'cached-run-id', humanReview: { outcome: 'disabled' } })
    expect(mockedFn(reserveAiProviderUnits)).not.toHaveBeenCalled()
    expect(mockedFn(callAnthropicForExtraction)).not.toHaveBeenCalled()
  })

  it('canonical timestamp v2: two evidence objects with different publishedAt STRING formats (same instant) hit the completed-cache under the IDENTICAL digest -- second caller never reaches the provider', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'budget_exhausted' })

    const callerA = { ...EVIDENCE.evidence, publishedAt: '2026-07-26 04:47:43+00' } // SQL ::text style
    const callerB = { ...EVIDENCE.evidence, publishedAt: '2026-07-26T04:47:43+00:00' } // PostgREST style

    await runShadowExtraction({ signalEvidenceId: EVIDENCE.signalEvidenceId, evidence: callerA, idempotencyKey: 'fmt-a' })
    await runShadowExtraction({ signalEvidenceId: EVIDENCE.signalEvidenceId, evidence: callerB, idempotencyKey: 'fmt-b' })

    const calls = mockedFn(findCompletedExtractionRun).mock.calls
    expect(calls.length).toBe(2)
    const digestA = calls[0][1]
    const digestB = calls[1][1]
    expect(digestA).toBe(digestB) // byte-identical digest despite different source string formats -- the v1 gap, closed
  })

  it('canonical timestamp v2: an UNPARSEABLE publishedAt is rejected fail-closed BEFORE any reservation or provider call', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)

    const badEvidence = { ...EVIDENCE.evidence, publishedAt: 'not-a-real-timestamp' }
    await expect(
      runShadowExtraction({ signalEvidenceId: EVIDENCE.signalEvidenceId, evidence: badEvidence, idempotencyKey: 'bad-ts' }),
    ).rejects.toThrow(/unparseable/)

    expect(mockedFn(reserveAiProviderUnits)).not.toHaveBeenCalled()
    expect(mockedFn(callAnthropicForExtraction)).not.toHaveBeenCalled()
  })

  it('daily/run limit exhausted: reservation rejected, no provider call', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'budget_exhausted' })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-2' })

    expect(result).toEqual({ outcome: 'budget_exhausted' })
    expect(mockedFn(callAnthropicForExtraction)).not.toHaveBeenCalled()
  })

  it('reservation disabled/rejected: exposes a stable reasonCode alongside the existing message, no provider call', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'invalid_request', message: 'ai_extraction_control.enabled is false' })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-2b' })

    expect(result).toEqual({ outcome: 'disabled_or_rejected', reasonCode: 'invalid_request', message: 'ai_extraction_control.enabled is false' })
    expect(mockedFn(callAnthropicForExtraction)).not.toHaveBeenCalled()
  })

  it('reservation disabled/rejected: a database_error reservation outcome carries reasonCode database_error, not a free-text-derived value', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'database_error', operation: 'reserve_ai_provider_units', error: { message: 'connection reset' } })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-2c' })

    expect(result.outcome).toBe('disabled_or_rejected')
    expect((result as { reasonCode: string }).reasonCode).toBe('database_error')
    expect(mockedFn(callAnthropicForExtraction)).not.toHaveBeenCalled()
  })

  it('timeout BEFORE the call: markAttemptStarted fails -> release, never outcome_unknown, reasonCode reflects the underlying quota-op outcome', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'reserved', reservationId: 'res-1' })
    mockedFn(markAiProviderAttemptStarted).mockResolvedValue({ outcome: 'invalid_transition', message: 'timed out marking started' })
    mockedFn(releaseAiProviderUnits).mockResolvedValue({ outcome: 'success', duplicateSafe: true })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-3' })

    expect(result.outcome).toBe('attempt_not_started')
    expect((result as { reasonCode: string }).reasonCode).toBe('invalid_transition')
    expect((result as { message: string }).message).toBe('timed out marking started')
    expect(mockedFn(releaseAiProviderUnits)).toHaveBeenCalledWith('res-1', undefined)
    expect(mockedFn(markAiProviderOutcomeUnknown)).not.toHaveBeenCalled()
    expect(mockedFn(callAnthropicForExtraction)).not.toHaveBeenCalled()
  })

  it('uncertain timeout AFTER the call: attempt started, provider call throws -> outcome_unknown, never release', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'reserved', reservationId: 'res-2' })
    mockedFn(markAiProviderAttemptStarted).mockResolvedValue({ outcome: 'success', duplicateSafe: true })
    mockedFn(callAnthropicForExtraction).mockRejectedValue(new Error('request timed out'))
    mockedFn(markAiProviderOutcomeUnknown).mockResolvedValue({ outcome: 'success', settlement: { reservationId: 'res-2', status: 'committed_unknown', duplicate: false } })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-4' })

    expect(result.outcome).toBe('uncertain')
    expect(mockedFn(markAiProviderOutcomeUnknown)).toHaveBeenCalledWith('res-2', 'mocked_error_class', undefined)
    expect(mockedFn(releaseAiProviderUnits)).not.toHaveBeenCalled()
    expect(mockedFn(recordCompletedExtractionRun)).not.toHaveBeenCalled()
    expect(mockedFn(recordFailedExtractionRun)).not.toHaveBeenCalled()
  })

  it('malformed provider output: commits real usage, records a failed extraction run, then finalizes application_outcome=failed', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'reserved', reservationId: 'res-3' })
    mockedFn(markAiProviderAttemptStarted).mockResolvedValue({ outcome: 'success', duplicateSafe: true })
    mockedFn(callAnthropicForExtraction).mockResolvedValue({ rawText: '{}', parsedJson: { not: 'valid' }, inputTokens: 40, outputTokens: 10 })
    mockedFn(commitAiProviderUnits).mockResolvedValue({ outcome: 'success', settlement: { reservationId: 'res-3', status: 'committed', duplicate: false, actualMicroUsd: 270, capBreach: false } })
    mockedFn(recordFailedExtractionRun).mockResolvedValue({ extractionRunId: 'failed-run-id', outcome: 'created', status: 'failed' })
    mockedFn(finalizeAiProviderReservationOutcome).mockResolvedValue({ outcome: 'success', finalized: { reservationId: 'res-3', applicationOutcome: 'failed', extractionRunId: 'failed-run-id', duplicate: false } })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-5' })

    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.capBreach).toBe(false)
    expect(mockedFn(commitAiProviderUnits)).toHaveBeenCalledWith('res-3', 40, 10, undefined)
    expect(mockedFn(recordFailedExtractionRun)).toHaveBeenCalledTimes(1)
    expect(mockedFn(finalizeAiProviderReservationOutcome)).toHaveBeenCalledWith('res-3', 'failed-run-id', 'failed', undefined)
    expect(mockedFn(recordCompletedExtractionRun)).not.toHaveBeenCalled()
    expect(mockedFn(callAnthropicForExtraction)).toHaveBeenCalledTimes(1) // exactly one provider call per run
  })

  it('completed happy path: commits actual token usage, records a completed extraction run, then finalizes application_outcome=completed', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'reserved', reservationId: 'res-4' })
    mockedFn(markAiProviderAttemptStarted).mockResolvedValue({ outcome: 'success', duplicateSafe: true })
    mockedFn(callAnthropicForExtraction).mockResolvedValue({ rawText: JSON.stringify(VALID_OUTPUT), parsedJson: VALID_OUTPUT, inputTokens: 120, outputTokens: 80 })
    mockedFn(commitAiProviderUnits).mockResolvedValue({ outcome: 'success', settlement: { reservationId: 'res-4', status: 'committed', duplicate: false, actualMicroUsd: 1560, capBreach: false } })
    mockedFn(recordCompletedExtractionRun).mockResolvedValue({ extractionRunId: 'completed-run-id', outcome: 'created', status: 'completed' })
    mockedFn(finalizeAiProviderReservationOutcome).mockResolvedValue({ outcome: 'success', finalized: { reservationId: 'res-4', applicationOutcome: 'completed', extractionRunId: 'completed-run-id', duplicate: false } })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-6' })

    expect(result.outcome).toBe('completed')
    if (result.outcome === 'completed') {
      expect(result.extractionRunId).toBe('completed-run-id')
      expect(result.structuredOutput.canonical_phenomenon_label).toBe('Test phenomenon')
      expect(result.capBreach).toBe(false)
    }
    expect(mockedFn(commitAiProviderUnits)).toHaveBeenCalledWith('res-4', 120, 80, undefined)
    expect(mockedFn(finalizeAiProviderReservationOutcome)).toHaveBeenCalledWith('res-4', 'completed-run-id', 'completed', undefined)
    expect(mockedFn(callAnthropicForExtraction)).toHaveBeenCalledTimes(1)
    expect(mockedFn(recordFailedExtractionRun)).not.toHaveBeenCalled()
  })

  it('correction-gate item 2: cap_breach=true still records the completed extraction run -- real result is never discarded', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'reserved', reservationId: 'res-breach' })
    mockedFn(markAiProviderAttemptStarted).mockResolvedValue({ outcome: 'success', duplicateSafe: true })
    mockedFn(callAnthropicForExtraction).mockResolvedValue({ rawText: JSON.stringify(VALID_OUTPUT), parsedJson: VALID_OUTPUT, inputTokens: 5000, outputTokens: 5000 })
    mockedFn(commitAiProviderUnits).mockResolvedValue({ outcome: 'success', settlement: { reservationId: 'res-breach', status: 'committed', duplicate: false, actualMicroUsd: 90000, capBreach: true } })
    mockedFn(recordCompletedExtractionRun).mockResolvedValue({ extractionRunId: 'breach-run-id', outcome: 'created', status: 'completed' })
    mockedFn(finalizeAiProviderReservationOutcome).mockResolvedValue({ outcome: 'success', finalized: { reservationId: 'res-breach', applicationOutcome: 'completed', extractionRunId: 'breach-run-id', duplicate: false } })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-breach' })

    expect(result.outcome).toBe('completed')
    if (result.outcome === 'completed') {
      expect(result.capBreach).toBe(true)
      expect(result.extractionRunId).toBe('breach-run-id') // the real result, not discarded
    }
    expect(mockedFn(recordCompletedExtractionRun)).toHaveBeenCalledTimes(1)
  })

  it('commit failure (structural RPC error, NOT a cap breach) falls back to outcome_unknown rather than recording an uncommitted completed run', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'reserved', reservationId: 'res-5' })
    mockedFn(markAiProviderAttemptStarted).mockResolvedValue({ outcome: 'success', duplicateSafe: true })
    mockedFn(callAnthropicForExtraction).mockResolvedValue({ rawText: JSON.stringify(VALID_OUTPUT), parsedJson: VALID_OUTPUT, inputTokens: 120, outputTokens: 80 })
    mockedFn(commitAiProviderUnits).mockResolvedValue({ outcome: 'invalid_transition', message: 'reservation not found' })
    mockedFn(markAiProviderOutcomeUnknown).mockResolvedValue({ outcome: 'success', settlement: { reservationId: 'res-5', status: 'committed_unknown', duplicate: false } })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-7' })

    expect(result.outcome).toBe('uncertain')
    expect(mockedFn(recordCompletedExtractionRun)).not.toHaveBeenCalled()
    expect(mockedFn(recordFailedExtractionRun)).not.toHaveBeenCalled()
    expect(mockedFn(finalizeAiProviderReservationOutcome)).not.toHaveBeenCalled()
  })

  it('correction-gate item 5: a definitely-unbilled provider rejection (4xx) commits actual cost 0, records a failed extraction run, never releases', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'reserved', reservationId: 'res-unbilled' })
    mockedFn(markAiProviderAttemptStarted).mockResolvedValue({ outcome: 'success', duplicateSafe: true })
    const rejectionError = new Error('400 invalid_request_error')
    mockedFn(callAnthropicForExtraction).mockRejectedValue(rejectionError)
    mockedFn(isDefinitelyUnbilledProviderError).mockReturnValue(true)
    mockedFn(commitAiProviderUnits).mockResolvedValue({ outcome: 'success', settlement: { reservationId: 'res-unbilled', status: 'committed', duplicate: false, actualMicroUsd: 0, capBreach: false } })
    mockedFn(recordFailedExtractionRun).mockResolvedValue({ extractionRunId: 'unbilled-run-id', outcome: 'created', status: 'failed' })
    mockedFn(finalizeAiProviderReservationOutcome).mockResolvedValue({ outcome: 'success', finalized: { reservationId: 'res-unbilled', applicationOutcome: 'failed', extractionRunId: 'unbilled-run-id', duplicate: false } })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-unbilled' })

    expect(result.outcome).toBe('failed')
    expect(mockedFn(commitAiProviderUnits)).toHaveBeenCalledWith('res-unbilled', 0, 0, undefined)
    expect(mockedFn(recordFailedExtractionRun)).toHaveBeenCalledTimes(1)
    expect(mockedFn(finalizeAiProviderReservationOutcome)).toHaveBeenCalledWith('res-unbilled', 'unbilled-run-id', 'failed', undefined)
    expect(mockedFn(releaseAiProviderUnits)).not.toHaveBeenCalled()
    expect(mockedFn(markAiProviderOutcomeUnknown)).not.toHaveBeenCalled()
  })

  it('correction-gate item 3: an oversized prompt is rejected fail-closed BEFORE any reservation or provider call', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    const hugeSnippet = 'x'.repeat(AI_QUOTA_MAX_INPUT_BYTES + 1000)

    const result = await runShadowExtraction({
      signalEvidenceId: EVIDENCE.signalEvidenceId,
      evidence: { ...EVIDENCE.evidence, snippet: hugeSnippet },
      idempotencyKey: 'key-huge',
    })

    expect(result.outcome).toBe('input_too_large')
    expect(mockedFn(reserveAiProviderUnits)).not.toHaveBeenCalled()
    expect(mockedFn(callAnthropicForExtraction)).not.toHaveBeenCalled()
  })

  it('correction-gate item 3: the pre-call reservation estimate grows with the FULL request (system prompt + evidence-derived user content), not just the user text alone', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'budget_exhausted' }) // stop right after reserve is called

    await runShadowExtraction({ ...EVIDENCE, evidence: { ...EVIDENCE.evidence, snippet: 'short' }, idempotencyKey: 'key-short' })
    const shortCallArgs = mockedFn(reserveAiProviderUnits).mock.calls[0][0]

    mockedFn(reserveAiProviderUnits).mockClear()
    const longSnippet = 'word '.repeat(500) // ~2500 extra bytes of USER content only
    await runShadowExtraction({ ...EVIDENCE, evidence: { ...EVIDENCE.evidence, snippet: longSnippet }, idempotencyKey: 'key-long' })
    const longCallArgs = mockedFn(reserveAiProviderUnits).mock.calls[0][0]

    // The estimate for the long-snippet call must be larger than the short
    // one by roughly the extra user-content bytes (proving the user content
    // is actually counted), AND the short call's estimate must already be
    // well above trivial single-digit token counts (proving the FIXED
    // system-prompt text is also counted, not just the variable user part).
    expect(longCallArgs.estimatedInputTokens).toBeGreaterThan(shortCallArgs.estimatedInputTokens + 2000)
    expect(shortCallArgs.estimatedInputTokens).toBeGreaterThan(300) // system prompt alone is several hundred bytes
  })

  it('attempt_started is a mandatory provider-call boundary: the provider adapter is NEVER invoked except immediately after a resolved, successful markAiProviderAttemptStarted call', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'reserved', reservationId: 'res-order' })
    const callOrder: string[] = []
    mockedFn(markAiProviderAttemptStarted).mockImplementation(async () => {
      callOrder.push('markAttemptStarted')
      return { outcome: 'success', duplicateSafe: true }
    })
    mockedFn(callAnthropicForExtraction).mockImplementation(async () => {
      callOrder.push('providerCall')
      return { rawText: JSON.stringify(VALID_OUTPUT), parsedJson: VALID_OUTPUT, inputTokens: 10, outputTokens: 10 }
    })
    mockedFn(commitAiProviderUnits).mockResolvedValue({ outcome: 'success', settlement: { reservationId: 'res-order', status: 'committed', duplicate: false, actualMicroUsd: 180, capBreach: false } })
    mockedFn(recordCompletedExtractionRun).mockResolvedValue({ extractionRunId: 'order-run-id', outcome: 'created', status: 'completed' })
    mockedFn(finalizeAiProviderReservationOutcome).mockResolvedValue({ outcome: 'success', finalized: { reservationId: 'res-order', applicationOutcome: 'completed', extractionRunId: 'order-run-id', duplicate: false } })

    await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-order' })

    expect(callOrder).toEqual(['markAttemptStarted', 'providerCall'])
    expect(mockedFn(markAiProviderAttemptStarted)).toHaveBeenCalledTimes(1)
    expect(mockedFn(callAnthropicForExtraction)).toHaveBeenCalledTimes(1)
  })

  it('when markAiProviderAttemptStarted fails, the provider adapter is never even constructed/invoked -- release happens instead of any network attempt', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue(null)
    mockedFn(reserveAiProviderUnits).mockResolvedValue({ outcome: 'reserved', reservationId: 'res-noattempt' })
    mockedFn(markAiProviderAttemptStarted).mockResolvedValue({ outcome: 'invalid_transition', message: 'reservation vanished' })
    mockedFn(releaseAiProviderUnits).mockResolvedValue({ outcome: 'success', duplicateSafe: true })

    const result = await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-noattempt' })

    expect(result.outcome).toBe('attempt_not_started')
    expect(mockedFn(callAnthropicForExtraction)).not.toHaveBeenCalled()
    expect(mockedFn(commitAiProviderUnits)).not.toHaveBeenCalled()
    expect(mockedFn(markAiProviderOutcomeUnknown)).not.toHaveBeenCalled()
  })

  it('correction-gate item 4: reconcile_stale_ai_provider_reservations is called before anything else, on every invocation', async () => {
    mockedFn(findCompletedExtractionRun).mockResolvedValue({ extractionRunId: 'cached-run-id' })
    const callOrder: string[] = []
    mockedFn(reconcileStaleAiProviderReservations).mockImplementation(async () => {
      callOrder.push('reconcile')
      return { outcome: 'success', summary: { released: 0, markedUnknown: 0, skippedConcurrentRun: false } }
    })
    mockedFn(findCompletedExtractionRun).mockImplementation(async () => {
      callOrder.push('cache-check')
      return { extractionRunId: 'cached-run-id' }
    })

    await runShadowExtraction({ ...EVIDENCE, idempotencyKey: 'key-reconcile-order' })

    expect(mockedFn(reconcileStaleAiProviderReservations)).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['reconcile', 'cache-check'])
  })
})

describe('structured-output-schema.ts -- direct validation coverage', () => {
  it('accepts the canonical fixture', () => {
    expect(validateTopicExtractionOutputV1(VALID_OUTPUT, 1).ok).toBe(true)
  })
  it('rejects a non-object', () => {
    expect(validateTopicExtractionOutputV1('not an object', 1).ok).toBe(false)
  })
  it('rejects a schema version mismatch', () => {
    expect(validateTopicExtractionOutputV1({ ...VALID_OUTPUT, extraction_schema_version: 2 }, 1).ok).toBe(false)
  })
  it('rejects an invalid content_format', () => {
    expect(validateTopicExtractionOutputV1({ ...VALID_OUTPUT, content_format: 'invalid' }, 1).ok).toBe(false)
  })
  it('rejects more than 20 subject_entities', () => {
    const many = Array.from({ length: 21 }, (_, i) => `Entity ${i}`)
    expect(validateTopicExtractionOutputV1({ ...VALID_OUTPUT, subject_entities: many }, 1).ok).toBe(false)
  })
  it('rejects more than 10 supporting_spans', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ source_field: 'title', quoted_text: `x${i}` }))
    expect(validateTopicExtractionOutputV1({ ...VALID_OUTPUT, supporting_spans: many }, 1).ok).toBe(false)
  })
})
