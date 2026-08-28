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
  redactForDisplay,
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
      // Remediation regression guard: the preview must NEVER carry the full
      // run id under any field name -- only a prefix, matching the evidence
      // field's own convention exactly. This is the exact bug this gate
      // fixes: the full id was previously stored verbatim on this object.
      expect(result.preview.extractionRunIdPrefix).toBe(RUN_ID.slice(0, 8))
      expect(result.preview.extractionRunIdPrefix.length).toBeLessThan(RUN_ID.length)
      expect(JSON.stringify(result.preview)).not.toContain(RUN_ID)
      expect(JSON.stringify(result.preview)).not.toContain(EVIDENCE_ID)
    }
  })

  it('a not-found run never echoes the full run id in its error message', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, { data: null, error: null })
    const result = await fetchExtractionRunPreview(client, RUN_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).not.toContain(RUN_ID)
  })

  it('a raw DB error message containing a full UUID is shortened before it ever leaves this function', async () => {
    const client = createMockClient()
    const leakyMessage = `duplicate key value violates unique constraint (id=${RUN_ID})`
    wireExtractionRunLookup(client, { data: null, error: { message: leakyMessage } })
    const result = await fetchExtractionRunPreview(client, RUN_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).not.toContain(RUN_ID)
      expect(result.message).toContain(RUN_ID.slice(0, 8))
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

  // Remediation gate (Section D.2): every possible outcome shape, scanned
  // for a full UUID anywhere in its serialized form -- not just the fields
  // this test file happens to assert on individually above. This is the
  // structural guard against a FUTURE field regressing the same way
  // preview.extractionRunId originally did.
  const FULL_REQUEST_ID = '33333333-3333-4333-8333-333333333333'
  const ANY_FULL_UUID = [RUN_ID, EVIDENCE_ID, FULL_REQUEST_ID]

  it.each([
    ['created', { ok: true, outcome_kind: 'created', reason_code: null, review_request_id: FULL_REQUEST_ID, generation: 1, status: 'pending', expires_at: '2026-09-04T00:00:00Z' }],
    ['replayed', { ok: true, outcome_kind: 'replayed', reason_code: null, review_request_id: FULL_REQUEST_ID, generation: 1, status: 'pending', expires_at: '2026-09-04T00:00:00Z' }],
    ['ineligible', { ok: false, outcome_kind: 'ineligible', reason_code: 'NOT_SPECIFIC', message: `run ${RUN_ID} not specific` }],
    ['blocked', { ok: false, outcome_kind: 'blocked', reason_code: 'ALREADY_ASSIGNED', message: `run ${RUN_ID} already assigned` }],
  ])('outcome "%s" never contains a full UUID anywhere in its serialized form, even when the RPC message itself leaks one', async (_label, rpcData) => {
    const client = createMockClient()
    wireExtractionRunLookup(client, mockExtractionRunRow())
    client.rpc.mockResolvedValue({ data: rpcData, error: null })
    const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: false })
    const serialized = JSON.stringify(outcome)
    for (const fullId of ANY_FULL_UUID) expect(serialized).not.toContain(fullId)
  })

  it('dry_run outcome never contains a full UUID anywhere in its serialized form', async () => {
    const client = createMockClient()
    wireExtractionRunLookup(client, mockExtractionRunRow())
    const outcome = await runPostCompletionReviewRecovery(client, { extractionRunId: RUN_ID, dryRun: true })
    const serialized = JSON.stringify(outcome)
    for (const fullId of ANY_FULL_UUID) expect(serialized).not.toContain(fullId)
  })
})

// ===========================================================================
// redactForDisplay -- the central, mandatory display-boundary redactor.
// ===========================================================================
describe('redactForDisplay', () => {
  it('shortens a bare UUID string to an 8-char prefix + ellipsis', () => {
    expect(redactForDisplay(RUN_ID)).toBe(`${RUN_ID.slice(0, 8)}…`)
  })

  it('shortens every UUID-shaped substring inside a longer string, leaving the rest intact', () => {
    const message = `duplicate key (id=${RUN_ID}) references (id=${EVIDENCE_ID})`
    const result = redactForDisplay(message) as string
    expect(result).not.toContain(RUN_ID)
    expect(result).not.toContain(EVIDENCE_ID)
    expect(result).toContain(RUN_ID.slice(0, 8))
    expect(result).toContain(EVIDENCE_ID.slice(0, 8))
    expect(result).toContain('duplicate key')
    expect(result).toContain('references')
  })

  it('recurses into nested objects and arrays', () => {
    const input = { a: { b: [RUN_ID, { c: EVIDENCE_ID }] } }
    const result = redactForDisplay(input) as typeof input
    expect(JSON.stringify(result)).not.toContain(RUN_ID)
    expect(JSON.stringify(result)).not.toContain(EVIDENCE_ID)
  })

  it('fully masks (never merely shortens) a value whose key name looks secret-like, case/separator-insensitive', () => {
    const input = {
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abcdefghijklmnopqrstuvwxyz',
      apiKey: 'sk-ant-abcdefghijklmnop',
      'api-key': 'sk-ant-abcdefghijklmnop',
      Authorization: 'Bearer abc.def.ghi',
      normalField: 'not a secret',
    }
    const result = redactForDisplay(input) as Record<string, unknown>
    expect(result.SUPABASE_SERVICE_ROLE_KEY).toBe('[redacted]')
    expect(result.apiKey).toBe('[redacted]')
    expect(result['api-key']).toBe('[redacted]')
    expect(result.Authorization).toBe('[redacted]')
    expect(result.normalField).toBe('not a secret')
  })

  it('never mutates the original input object', () => {
    const input = { id: RUN_ID }
    const original = JSON.stringify(input)
    redactForDisplay(input)
    expect(JSON.stringify(input)).toBe(original)
  })

  it('passes through non-string, non-object primitives unchanged', () => {
    expect(redactForDisplay(42)).toBe(42)
    expect(redactForDisplay(true)).toBe(true)
    expect(redactForDisplay(null)).toBe(null)
    expect(redactForDisplay(undefined)).toBe(undefined)
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
