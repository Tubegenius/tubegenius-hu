// PFM Post-Completion Review Handoff Recovery v0 -- pure unit/contract
// tests. Every DB boundary is mocked via dependency injection (no vi.mock,
// no Docker, no network) -- mirrors tests/supervised-intake-runner.test.ts's
// own mocking convention exactly.
import { describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_EXIT_CODE,
  exitCodeForOutcome,
  fetchExtractionRunPreview,
  projectGuardPasses,
  resolveProjectIdentity,
  runPostCompletionReviewRecovery,
  type RecoveryOutcome,
} from '@/lib/semantic-topic/post-completion-review-recovery'
import type { SemanticTopicAdminClient } from '@/lib/semantic-topic/human-review-types'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const EVIDENCE_ID = '22222222-2222-4222-8222-222222222222'

function createMockClient() {
  const rpc = vi.fn()
  const from = vi.fn()
  return { rpc, from } as unknown as SemanticTopicAdminClient & { rpc: ReturnType<typeof vi.fn>; from: ReturnType<typeof vi.fn> }
}

function mockExtractionRunRow(overrides: Record<string, unknown> = {}) {
  const row = {
    id: RUN_ID,
    status: 'completed',
    signal_evidence_id: EVIDENCE_ID,
    structured_output: { confidence: 0.62, specificity: 'specific', content_format: 'list_ranking', supporting_spans: [{}, {}, {}] },
    ...overrides,
  }
  return { data: row, error: null }
}

function wireExtractionRunLookup(client: ReturnType<typeof createMockClient>, response: { data: unknown; error: unknown }) {
  const maybeSingleMock = vi.fn().mockResolvedValue(response)
  const eqMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }))
  const selectMock = vi.fn(() => ({ eq: eqMock }))
  client.from.mockImplementation((table: string) => {
    if (table === 'topic_extraction_runs') return { select: selectMock }
    throw new Error(`unexpected table in test: ${table}`)
  })
  return { maybeSingleMock, eqMock, selectMock }
}

// ===========================================================================
// resolveProjectIdentity / projectGuardPasses -- pure, no I/O.
// ===========================================================================
describe('resolveProjectIdentity', () => {
  it('recognizes a Supabase-hosted production URL and extracts the project ref', () => {
    expect(resolveProjectIdentity('https://sdvqzrcdvdtozfpjhnkh.supabase.co')).toEqual({ kind: 'remote', projectRef: 'sdvqzrcdvdtozfpjhnkh' })
  })
  it('recognizes localhost', () => {
    expect(resolveProjectIdentity('http://localhost:54321')).toEqual({ kind: 'local', host: 'localhost' })
  })
  it('recognizes 127.0.0.1', () => {
    expect(resolveProjectIdentity('http://127.0.0.1:54321')).toEqual({ kind: 'local', host: '127.0.0.1' })
  })
  it('marks an unparseable URL as unrecognized', () => {
    expect(resolveProjectIdentity('not a url').kind).toBe('unrecognized')
  })
  it('marks a non-supabase.co remote host as unrecognized', () => {
    expect(resolveProjectIdentity('https://example.com').kind).toBe('unrecognized')
  })
})

describe('projectGuardPasses', () => {
  it('passes only when the confirmation exactly matches a remote project ref', () => {
    expect(projectGuardPasses({ kind: 'remote', projectRef: 'abc123' }, 'abc123')).toBe(true)
  })
  it('fails on a mismatched ref', () => {
    expect(projectGuardPasses({ kind: 'remote', projectRef: 'abc123' }, 'wrong')).toBe(false)
  })
  it('fails for a local target no matter what string is passed -- cannot be talked into "confirming" localhost as production', () => {
    expect(projectGuardPasses({ kind: 'local', host: 'localhost' }, 'localhost')).toBe(false)
    expect(projectGuardPasses({ kind: 'local', host: 'localhost' }, 'abc123')).toBe(false)
  })
  it('fails for an unrecognized target', () => {
    expect(projectGuardPasses({ kind: 'unrecognized', host: 'example.com' }, 'example.com')).toBe(false)
  })
})

// ===========================================================================
// fetchExtractionRunPreview -- read-only, never exposes raw content.
// ===========================================================================
describe('fetchExtractionRunPreview', () => {
  it('returns a redacted preview (evidence id prefix only, span count not content) for a found run', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, mockExtractionRunRow())
    const result = await fetchExtractionRunPreview(client, RUN_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.preview.status).toBe('completed')
      expect(result.preview.confidenceRaw).toBe('0.62')
      expect(result.preview.specificity).toBe('specific')
      expect(result.preview.contentFormat).toBe('list_ranking')
      expect(result.preview.supportingSpansCount).toBe(3)
      expect(result.preview.signalEvidenceIdPrefix).toBe(EVIDENCE_ID.slice(0, 8))
      expect(result.preview.signalEvidenceIdPrefix.length).toBeLessThan(EVIDENCE_ID.length)
    }
  })

  it('reports not-found as a structured failure, never throws', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, { data: null, error: null })
    const result = await fetchExtractionRunPreview(client, RUN_ID)
    expect(result.ok).toBe(false)
  })

  it('propagates a DB error as a structured failure', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, { data: null, error: { message: 'connection reset' } })
    const result = await fetchExtractionRunPreview(client, RUN_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('connection reset')
  })
})

// ===========================================================================
// runPostCompletionReviewRecovery -- the RPC call count assertion is the
// single most important thing in this file: never more than one per call,
// and zero on the dry-run/ineligible/not-completed paths that precede it.
// ===========================================================================
describe('runPostCompletionReviewRecovery', () => {
  it('dry-run: never calls the RPC, returns a preview', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, mockExtractionRunRow())
    const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: true })
    expect(outcome.kind).toBe('dry_run')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('non-completed run: configuration_error, RPC never called', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, mockExtractionRunRow({ status: 'failed' }))
    const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: false })
    expect(outcome.kind).toBe('configuration_error')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('run not found: configuration_error, RPC never called', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, { data: null, error: null })
    const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: false })
    expect(outcome.kind).toBe('configuration_error')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('eligible + no prior request: created, exactly one RPC call, with the deterministic idempotency key', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, mockExtractionRunRow())
    client.rpc.mockResolvedValue({
      data: { ok: true, outcome_kind: 'created', reason_code: null, review_request_id: '33333333-3333-4333-8333-333333333333', generation: 1, status: 'pending', expires_at: '2026-09-04T00:00:00Z' },
      error: null,
    })
    const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: false })
    expect(outcome.kind).toBe('created')
    expect(client.rpc).toHaveBeenCalledTimes(1)
    const [, args] = client.rpc.mock.calls[0]
    expect(args.p_extraction_run_id).toBe(RUN_ID)
    expect(args.p_idempotency_key).toBe(`human-review-request:${RUN_ID}`)
  })

  it('idempotent replay: same call shape maps to "replayed", still exactly one RPC call', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, mockExtractionRunRow())
    client.rpc.mockResolvedValue({
      data: { ok: true, outcome_kind: 'replayed', reason_code: null, review_request_id: '33333333-3333-4333-8333-333333333333', generation: 1, status: 'pending', expires_at: '2026-09-04T00:00:00Z' },
      error: null,
    })
    const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: false })
    expect(outcome.kind).toBe('replayed')
    expect(client.rpc).toHaveBeenCalledTimes(1)
  })

  for (const reasonCode of ['NOT_SPECIFIC', 'CONFIDENCE_NOT_REVIEW_ELIGIBLE', 'NO_SUPPORTING_SPANS', 'INVALID_STRUCTURED_OUTPUT', 'EXTRACTION_NOT_COMPLETED']) {
    it(`ineligible reason "${reasonCode}": mapped through, exactly one RPC call`, async () => {
      const client = createMockClient()
      wireExtractionRunLookup(client, mockExtractionRunRow())
      client.rpc.mockResolvedValue({ data: { ok: false, outcome_kind: 'ineligible', reason_code: reasonCode, message: 'x' }, error: null })
      const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: false })
      expect(outcome.kind).toBe('ineligible')
      if (outcome.kind === 'ineligible') expect(outcome.reasonCode).toBe(reasonCode)
      expect(client.rpc).toHaveBeenCalledTimes(1)
    })
  }

  for (const reasonCode of ['ALREADY_ASSIGNED', 'LIVE_REVIEW_REQUEST_EXISTS']) {
    it(`blocked reason "${reasonCode}": mapped through, exactly one RPC call`, async () => {
      const client = createMockClient()
      wireExtractionRunLookup(client, mockExtractionRunRow())
      client.rpc.mockResolvedValue({ data: { ok: false, outcome_kind: 'blocked', reason_code: reasonCode, message: 'x' }, error: null })
      const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: false })
      expect(outcome.kind).toBe('blocked')
      if (outcome.kind === 'blocked') expect(outcome.reasonCode).toBe(reasonCode)
      expect(client.rpc).toHaveBeenCalledTimes(1)
    })
  }

  it('a raw RPC/transport error maps to database_error, exactly one RPC call attempted', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, mockExtractionRunRow())
    client.rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } })
    const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: false })
    expect(outcome.kind).toBe('database_error')
    expect(client.rpc).toHaveBeenCalledTimes(1)
  })

  it('an unrecognized RPC response shape maps to database_error, never guessed at', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, mockExtractionRunRow())
    client.rpc.mockResolvedValue({ data: { unexpected: true }, error: null })
    const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: false })
    expect(outcome.kind).toBe('database_error')
  })
})

// ===========================================================================
// exitCodeForOutcome -- exhaustive mapping.
// ===========================================================================
describe('exitCodeForOutcome', () => {
  const cases: Array<[RecoveryOutcome, number]> = [
    [{ kind: 'dry_run', preview: {} as never, idempotencyKeyPreview: 'x' }, RECOVERY_EXIT_CODE.OK],
    [{ kind: 'created', reviewRequestIdPrefix: 'x', generation: 1, status: 'pending', expiresAt: 'x' }, RECOVERY_EXIT_CODE.OK],
    [{ kind: 'replayed', reviewRequestIdPrefix: 'x', generation: 1, status: 'pending', expiresAt: 'x' }, RECOVERY_EXIT_CODE.OK],
    [{ kind: 'ineligible', reasonCode: 'NOT_SPECIFIC' }, RECOVERY_EXIT_CODE.INELIGIBLE],
    [{ kind: 'blocked', reasonCode: 'ALREADY_ASSIGNED' }, RECOVERY_EXIT_CODE.BLOCKED],
    [{ kind: 'configuration_error', message: 'x' }, RECOVERY_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR],
    [{ kind: 'database_error', operation: 'x' }, RECOVERY_EXIT_CODE.UNEXPECTED_ERROR],
  ]
  for (const [outcome, expected] of cases) {
    it(`maps outcome kind "${outcome.kind}" to exit code ${expected}`, () => {
      expect(exitCodeForOutcome(outcome)).toBe(expected)
    })
  }
})
