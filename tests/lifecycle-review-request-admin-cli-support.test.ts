// PFM Lifecycle Operator CLI v1 -- request-creation support module unit
// tests (mocked client, no DB). Mirrors the established
// lifecycle-review-reader.test.ts idiom: fakeClient() stubs .rpc()/.from(),
// no vi.mock of the module under test.
import { describe, expect, it, vi } from 'vitest'
import {
  deriveLifecycleRequestIdempotencyKey,
  exitCodeForLifecycleRequestCreationOutcome,
  fetchLifecycleRequestPreview,
  isValidOperatorReference,
  isValidSemanticTopicId,
  isValidTargetStatus,
  LIFECYCLE_REQUEST_ADMIN_EXIT_CODE,
  previewIsSupportedTransition,
  previewMechanicalFloorReasonCode,
  runCreateLifecycleReviewRequest,
} from '@/lib/semantic-topic/lifecycle-request-admin-cli-support'

const TOPIC_ID = 'a0000000-0000-4000-8000-000000000001'

function fakeQueryBuilder(result: { data?: unknown; error?: unknown; count?: number }) {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null })),
    then: undefined,
  }
  // .select(..., { count: 'exact', head: true }).eq(...).in(...) resolves
  // directly (no .maybeSingle()) -- make the builder itself awaitable for
  // that call shape.
  builder[Symbol.for('nodejs.util.inspect.custom')] = undefined
  return Object.assign(builder, {
    // Support `await builder` for the count-only query path.
    then: (resolve: any) => resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? 0 }),
  })
}

function fakeClient(opts: {
  topic?: { data?: unknown; error?: unknown }
  vector?: { data?: unknown; error?: unknown }
  actionableCount?: { count?: number; error?: unknown }
  createResult?: { data?: unknown; error?: unknown }
}) {
  const rpc = vi.fn(async (fn: string, params?: Record<string, unknown>) => {
    void params
    if (fn === 'compute_topic_evidence_vector') return opts.vector ?? { data: { ok: true }, error: null }
    if (fn === 'create_semantic_topic_lifecycle_review_request') return opts.createResult ?? { data: null, error: null }
    throw new Error(`unexpected rpc: ${fn}`)
  })
  const from = vi.fn((table: string) => {
    if (table === 'semantic_topics') return fakeQueryBuilder(opts.topic ?? { data: null })
    if (table === 'semantic_topic_lifecycle_review_requests') return fakeQueryBuilder({ count: opts.actionableCount?.count ?? 0, error: opts.actionableCount?.error })
    throw new Error(`unexpected table: ${table}`)
  })
  return { rpc, from }
}

const FULL_VECTOR = {
  ok: true,
  formulaVersion: 'v1',
  activeMembershipCount: 3,
  eligibleMembershipCount: 3,
  eligibleDistinctSourceIdentityCount: 2,
  unknownSourceCount: 0,
  assignmentReasonBreakdownComplete: true,
  evidenceIdentityComplete: true,
  sourceIdentityKnown: true,
  inputIntegrityStatus: 'complete',
}
const TOPIC_ROW = { id: TOPIC_ID, lifecycle_status: 'corroborating', status_version: 1 }

describe('input validation', () => {
  it('isValidSemanticTopicId accepts a real UUID, rejects anything else', () => {
    expect(isValidSemanticTopicId(TOPIC_ID)).toBe(true)
    expect(isValidSemanticTopicId('not-a-uuid')).toBe(false)
    expect(isValidSemanticTopicId(null)).toBe(false)
    expect(isValidSemanticTopicId(123)).toBe(false)
  })
  it('isValidTargetStatus accepts exactly the 3 supported values', () => {
    expect(isValidTargetStatus('coherent')).toBe(true)
    expect(isValidTargetStatus('ambiguous')).toBe(true)
    expect(isValidTargetStatus('corroborating')).toBe(true)
    expect(isValidTargetStatus('candidate_singleton')).toBe(false)
    expect(isValidTargetStatus('')).toBe(false)
  })
  it('isValidOperatorReference accepts a short, safe label, rejects empty/too-short/too-long/unsafe-character values', () => {
    expect(isValidOperatorReference('ops-2026-09-15-pilot')).toBe(true)
    expect(isValidOperatorReference('ab')).toBe(false) // too short (min 3)
    expect(isValidOperatorReference('')).toBe(false)
    expect(isValidOperatorReference('x'.repeat(101))).toBe(false)
    expect(isValidOperatorReference('has spaces')).toBe(false)
    expect(isValidOperatorReference('has/slash')).toBe(false)
    expect(isValidOperatorReference(null)).toBe(false)
  })
})

describe('deriveLifecycleRequestIdempotencyKey -- deterministic, domain-separated', () => {
  it('the same (operatorReference, topicId, targetStatus) triple always derives the same key', () => {
    const a = deriveLifecycleRequestIdempotencyKey('op-1', TOPIC_ID, 'coherent')
    const b = deriveLifecycleRequestIdempotencyKey('op-1', TOPIC_ID, 'coherent')
    expect(a).toBe(b)
  })
  it('a different operatorReference derives a different key for the same topic+target', () => {
    const a = deriveLifecycleRequestIdempotencyKey('op-1', TOPIC_ID, 'coherent')
    const b = deriveLifecycleRequestIdempotencyKey('op-2', TOPIC_ID, 'coherent')
    expect(a).not.toBe(b)
  })
  it('a different targetStatus derives a different key for the same operatorReference+topic', () => {
    const a = deriveLifecycleRequestIdempotencyKey('op-1', TOPIC_ID, 'coherent')
    const b = deriveLifecycleRequestIdempotencyKey('op-1', TOPIC_ID, 'ambiguous')
    expect(a).not.toBe(b)
  })
  it('a different topic id derives a different key for the same operatorReference+target', () => {
    const a = deriveLifecycleRequestIdempotencyKey('op-1', TOPIC_ID, 'coherent')
    const b = deriveLifecycleRequestIdempotencyKey('op-1', 'b0000000-0000-4000-8000-000000000002', 'coherent')
    expect(a).not.toBe(b)
  })
  it('the key is domain-prefixed and versioned, never a bare hash', () => {
    const key = deriveLifecycleRequestIdempotencyKey('op-1', TOPIC_ID, 'coherent')
    expect(key.startsWith('lifecycle-review-request-admin:create:')).toBe(true)
  })
})

describe('previewIsSupportedTransition -- mirrors 087s own 4-pair rule', () => {
  it.each([
    ['corroborating', 'coherent', true],
    ['corroborating', 'ambiguous', true],
    ['ambiguous', 'corroborating', true],
    ['ambiguous', 'coherent', true],
    ['corroborating', 'corroborating', false],
    ['ambiguous', 'ambiguous', false],
    ['candidate_singleton', 'coherent', false],
    ['coherent', 'ambiguous', false],
  ])('%s -> %s is supported=%s', (from, to, expected) => {
    expect(previewIsSupportedTransition(from, to)).toBe(expected)
  })
})

describe('previewMechanicalFloorReasonCode -- mirrors _semantic_topic_lifecycle_mechanical_check exactly (cross-verified against the real DB function in the DB-integration suite)', () => {
  it('passes (null) when all 4 conditions are satisfied', () => {
    expect(previewMechanicalFloorReasonCode({ eligibleDistinctSourceIdentityCount: 2, evidenceIdentityComplete: true, sourceIdentityKnown: true, assignmentReasonBreakdownComplete: true })).toBeNull()
  })
  it('INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES has top priority', () => {
    expect(
      previewMechanicalFloorReasonCode({ eligibleDistinctSourceIdentityCount: 1, evidenceIdentityComplete: false, sourceIdentityKnown: false, assignmentReasonBreakdownComplete: false }),
    ).toBe('INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES')
  })
  it('EVIDENCE_IDENTITY_INCOMPLETE is checked second', () => {
    expect(
      previewMechanicalFloorReasonCode({ eligibleDistinctSourceIdentityCount: 2, evidenceIdentityComplete: false, sourceIdentityKnown: false, assignmentReasonBreakdownComplete: false }),
    ).toBe('EVIDENCE_IDENTITY_INCOMPLETE')
  })
  it('SOURCE_IDENTITY_UNKNOWN is checked third', () => {
    expect(
      previewMechanicalFloorReasonCode({ eligibleDistinctSourceIdentityCount: 2, evidenceIdentityComplete: true, sourceIdentityKnown: false, assignmentReasonBreakdownComplete: false }),
    ).toBe('SOURCE_IDENTITY_UNKNOWN')
  })
  it('ASSIGNMENT_REASON_BREAKDOWN_INCOMPLETE is checked last', () => {
    expect(
      previewMechanicalFloorReasonCode({ eligibleDistinctSourceIdentityCount: 2, evidenceIdentityComplete: true, sourceIdentityKnown: true, assignmentReasonBreakdownComplete: false }),
    ).toBe('ASSIGNMENT_REASON_BREAKDOWN_INCOMPLETE')
  })
})

describe('fetchLifecycleRequestPreview', () => {
  it('returns a full, correctly-shaped preview for a valid topic', async () => {
    const client = fakeClient({ topic: { data: TOPIC_ROW }, vector: { data: FULL_VECTOR } })
    const result = await fetchLifecycleRequestPreview(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.preview.currentLifecycleStatus).toBe('corroborating')
    expect(result.preview.currentStatusVersion).toBe(1)
    expect(result.preview.supportedTransition).toBe(true)
    expect(result.preview.mechanicalFloorApplies).toBe(true)
    expect(result.preview.mechanicalFloorExpectedReasonCode).toBeNull()
    expect(result.preview.actionableRequestAlreadyExists).toBe(false)
    expect(result.preview.semanticTopicIdPrefix).toBe(TOPIC_ID.slice(0, 8))
  })
  it('mechanicalFloorApplies is false for an ambiguous target -- expected reason code is always null regardless of the vector', async () => {
    const client = fakeClient({ topic: { data: TOPIC_ROW }, vector: { data: { ...FULL_VECTOR, eligibleDistinctSourceIdentityCount: 0 } } })
    const result = await fetchLifecycleRequestPreview(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'ambiguous', operatorReference: 'op-1' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.preview.mechanicalFloorApplies).toBe(false)
    expect(result.preview.mechanicalFloorExpectedReasonCode).toBeNull()
  })
  it('a non-existent topic returns ok:false without ever calling the write RPC', async () => {
    const client = fakeClient({ topic: { data: null } })
    const result = await fetchLifecycleRequestPreview(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1' })
    expect(result.ok).toBe(false)
    expect(client.rpc).not.toHaveBeenCalledWith('create_semantic_topic_lifecycle_review_request', expect.anything())
  })
  it('never leaks a full idempotency key -- only a prefix', async () => {
    const client = fakeClient({ topic: { data: TOPIC_ROW }, vector: { data: FULL_VECTOR } })
    const result = await fetchLifecycleRequestPreview(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1' })
    if (!result.ok) throw new Error('unreachable')
    const fullKey = deriveLifecycleRequestIdempotencyKey('op-1', TOPIC_ID, 'coherent')
    expect(result.preview.idempotencyKeyPrefix.length).toBeLessThan(fullKey.length)
    expect(fullKey.startsWith(result.preview.idempotencyKeyPrefix.replace(/…$/, ''))).toBe(true)
  })
})

describe('runCreateLifecycleReviewRequest', () => {
  it('dry-run never calls the write RPC', async () => {
    const client = fakeClient({ topic: { data: TOPIC_ROW }, vector: { data: FULL_VECTOR } })
    const outcome = await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1', dryRun: true })
    expect(outcome.kind).toBe('dry_run')
    expect(client.rpc).not.toHaveBeenCalledWith('create_semantic_topic_lifecycle_review_request', expect.anything())
  })
  it('apply calls the write RPC exactly once on a clean success', async () => {
    const client = fakeClient({
      topic: { data: TOPIC_ROW },
      vector: { data: FULL_VECTOR },
      createResult: { data: { ok: true, outcomeKind: 'created', reviewRequestId: 'r1234567-0000-4000-8000-000000000001', status: 'requested', generation: 1 }, error: null },
    })
    const outcome = await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1', dryRun: false })
    expect(outcome).toEqual({ kind: 'created', reviewRequestIdPrefix: 'r1234567', status: 'requested', generation: 1 })
    const createCalls = client.rpc.mock.calls.filter((c: unknown[]) => c[0] === 'create_semantic_topic_lifecycle_review_request')
    expect(createCalls).toHaveLength(1)
  })
  it('apply passes the derived idempotency key, never a caller-supplied one', async () => {
    const client = fakeClient({
      topic: { data: TOPIC_ROW },
      vector: { data: FULL_VECTOR },
      createResult: { data: { ok: true, outcomeKind: 'created', reviewRequestId: 'r1234567-0000-4000-8000-000000000001', status: 'requested', generation: 1 }, error: null },
    })
    await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1', dryRun: false })
    const [, params] = client.rpc.mock.calls.find((c: unknown[]) => c[0] === 'create_semantic_topic_lifecycle_review_request')!
    expect((params as Record<string, unknown>).p_idempotency_key).toBe(deriveLifecycleRequestIdempotencyKey('op-1', TOPIC_ID, 'coherent'))
  })
  it('replayed outcome is distinguished from created', async () => {
    const client = fakeClient({
      topic: { data: TOPIC_ROW },
      vector: { data: FULL_VECTOR },
      createResult: { data: { ok: true, outcomeKind: 'replayed', reviewRequestId: 'r1234567-0000-4000-8000-000000000001', status: 'requested', generation: 1 }, error: null },
    })
    const outcome = await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1', dryRun: false })
    expect(outcome.kind).toBe('replayed')
  })
  it('REQUEST_ALREADY_ACTIONABLE_FOR_TOPIC (normal ok:false return) maps to request_already_actionable, never a retry', async () => {
    const client = fakeClient({
      topic: { data: TOPIC_ROW },
      vector: { data: FULL_VECTOR },
      createResult: { data: { ok: false, reasonCode: 'REQUEST_ALREADY_ACTIONABLE_FOR_TOPIC' }, error: null },
    })
    const outcome = await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1', dryRun: false })
    expect(outcome).toEqual({ kind: 'request_already_actionable' })
    const createCalls = client.rpc.mock.calls.filter((c: unknown[]) => c[0] === 'create_semantic_topic_lifecycle_review_request')
    expect(createCalls).toHaveLength(1)
  })
  it('a mechanical-floor reasonCode (normal ok:false return) maps to evidence_floor_not_met with the reason preserved', async () => {
    const client = fakeClient({
      topic: { data: TOPIC_ROW },
      vector: { data: FULL_VECTOR },
      createResult: { data: { ok: false, reasonCode: 'INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES' }, error: null },
    })
    const outcome = await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1', dryRun: false })
    expect(outcome).toEqual({ kind: 'evidence_floor_not_met', reasonCode: 'INSUFFICIENT_ELIGIBLE_SOURCE_IDENTITIES' })
  })
  it('an UNSUPPORTED_TRANSITION exception maps to unsupported_transition', async () => {
    const client = fakeClient({
      topic: { data: TOPIC_ROW },
      vector: { data: FULL_VECTOR },
      createResult: { data: null, error: { message: 'create_semantic_topic_lifecycle_review_request: UNSUPPORTED_TRANSITION -- corroborating->corroborating is not one of the four v1-supported transitions' } },
    })
    const outcome = await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'corroborating', operatorReference: 'op-1', dryRun: false })
    expect(outcome).toEqual({ kind: 'unsupported_transition' })
  })
  it('an unrecognized exception message maps to database_error, fail-closed -- never invents a more specific outcome', async () => {
    const client = fakeClient({
      topic: { data: TOPIC_ROW },
      vector: { data: FULL_VECTOR },
      createResult: { data: null, error: { code: '42P01', message: 'relation does not exist' } },
    })
    const outcome = await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1', dryRun: false })
    expect(outcome).toEqual({ kind: 'database_error' })
  })
  it('a malformed RPC response body (ok field missing) maps to database_error', async () => {
    const client = fakeClient({ topic: { data: TOPIC_ROW }, vector: { data: FULL_VECTOR }, createResult: { data: {}, error: null } })
    const outcome = await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1', dryRun: false })
    expect(outcome).toEqual({ kind: 'database_error' })
  })
  it('a business rejection never triggers a second RPC call (no retry)', async () => {
    const client = fakeClient({
      topic: { data: TOPIC_ROW },
      vector: { data: FULL_VECTOR },
      createResult: { data: { ok: false, reasonCode: 'REQUEST_ALREADY_ACTIONABLE_FOR_TOPIC' }, error: null },
    })
    await runCreateLifecycleReviewRequest(client as any, { semanticTopicId: TOPIC_ID, targetStatus: 'coherent', operatorReference: 'op-1', dryRun: false })
    const createCalls = client.rpc.mock.calls.filter((c: unknown[]) => c[0] === 'create_semantic_topic_lifecycle_review_request')
    expect(createCalls).toHaveLength(1)
  })
})

describe('exitCodeForLifecycleRequestCreationOutcome', () => {
  it('maps OK outcomes to exit 0', () => {
    expect(exitCodeForLifecycleRequestCreationOutcome({ kind: 'dry_run', preview: {} as any })).toBe(LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.OK)
    expect(exitCodeForLifecycleRequestCreationOutcome({ kind: 'created', reviewRequestIdPrefix: 'x', status: 'requested', generation: 1 })).toBe(LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.OK)
    expect(exitCodeForLifecycleRequestCreationOutcome({ kind: 'replayed', reviewRequestIdPrefix: 'x', status: 'requested', generation: 1 })).toBe(LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.OK)
  })
  it('maps business rejections to BUSINESS_REJECTED', () => {
    expect(exitCodeForLifecycleRequestCreationOutcome({ kind: 'unsupported_transition' })).toBe(LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.BUSINESS_REJECTED)
    expect(exitCodeForLifecycleRequestCreationOutcome({ kind: 'request_already_actionable' })).toBe(LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.BUSINESS_REJECTED)
    expect(exitCodeForLifecycleRequestCreationOutcome({ kind: 'evidence_floor_not_met', reasonCode: 'X' })).toBe(LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.BUSINESS_REJECTED)
  })
  it('maps configuration_error to VALIDATION_OR_CONFIG_ERROR and database_error to DATABASE_ERROR', () => {
    expect(exitCodeForLifecycleRequestCreationOutcome({ kind: 'configuration_error', message: 'x' })).toBe(LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR)
    expect(exitCodeForLifecycleRequestCreationOutcome({ kind: 'database_error' })).toBe(LIFECYCLE_REQUEST_ADMIN_EXIT_CODE.DATABASE_ERROR)
  })
})
