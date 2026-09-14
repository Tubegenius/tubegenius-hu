// PFM Lifecycle Operator CLI v1 -- executor support module unit tests
// (mocked client, no DB).
import { describe, expect, it, vi } from 'vitest'
import {
  deriveLifecycleExecutionIdempotencyKey,
  exitCodeForLifecycleExecutionOutcome,
  fetchLifecycleExecutionPreview,
  isValidReviewRequestId,
  LIFECYCLE_EXECUTOR_EXIT_CODE,
  runExecuteApprovedLifecycleTransition,
} from '@/lib/semantic-topic/execute-approved-lifecycle-transition-cli-support'

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001'
const TOPIC_ID = 'b0000000-0000-4000-8000-000000000002'
const DIGEST = 'd'.repeat(64)

function fakeQueryBuilder(data: unknown, error: unknown = null) {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data, error })),
  }
  return builder
}

function fakeClient(opts: {
  request?: { data?: unknown; error?: unknown }
  topic?: { data?: unknown; error?: unknown }
  executeResult?: { data?: unknown; error?: unknown }
}) {
  const rpc = vi.fn(async (fn: string, params?: Record<string, unknown>) => {
    void params
    if (fn === 'execute_approved_semantic_topic_lifecycle_transition') return opts.executeResult ?? { data: null, error: null }
    throw new Error(`unexpected rpc: ${fn}`)
  })
  let callCount = 0
  const from = vi.fn((table: string) => {
    if (table === 'semantic_topic_lifecycle_review_requests') return fakeQueryBuilder(opts.request?.data ?? null, opts.request?.error ?? null)
    if (table === 'semantic_topics') {
      callCount++
      return fakeQueryBuilder(opts.topic?.data ?? null, opts.topic?.error ?? null)
    }
    throw new Error(`unexpected table: ${table}`)
  })
  void callCount
  return { rpc, from }
}

const APPROVED_REQUEST_ROW = {
  id: REQUEST_ID,
  status: 'approved',
  semantic_topic_id: TOPIC_ID,
  from_status: 'corroborating',
  target_status: 'coherent',
  expected_status_version: 1,
  decision_operation_digest: DIGEST,
}
const MATCHING_TOPIC_ROW = { lifecycle_status: 'corroborating', status_version: 1 }

describe('isValidReviewRequestId', () => {
  it('accepts a real UUID, rejects anything else', () => {
    expect(isValidReviewRequestId(REQUEST_ID)).toBe(true)
    expect(isValidReviewRequestId('not-a-uuid')).toBe(false)
    expect(isValidReviewRequestId(null)).toBe(false)
  })
})

describe('deriveLifecycleExecutionIdempotencyKey -- deterministic, domain-separated', () => {
  it('the same (reviewRequestId, decisionOperationDigest) pair always derives the same key', () => {
    const a = deriveLifecycleExecutionIdempotencyKey(REQUEST_ID, DIGEST)
    const b = deriveLifecycleExecutionIdempotencyKey(REQUEST_ID, DIGEST)
    expect(a).toBe(b)
  })
  it('a different digest derives a different key for the same request id', () => {
    const a = deriveLifecycleExecutionIdempotencyKey(REQUEST_ID, DIGEST)
    const b = deriveLifecycleExecutionIdempotencyKey(REQUEST_ID, 'e'.repeat(64))
    expect(a).not.toBe(b)
  })
  it('a different request id derives a different key for the same digest', () => {
    const a = deriveLifecycleExecutionIdempotencyKey(REQUEST_ID, DIGEST)
    const b = deriveLifecycleExecutionIdempotencyKey('c0000000-0000-4000-8000-000000000003', DIGEST)
    expect(a).not.toBe(b)
  })
  it('the key is domain-prefixed and versioned', () => {
    const key = deriveLifecycleExecutionIdempotencyKey(REQUEST_ID, DIGEST)
    expect(key.startsWith('execute-approved-lifecycle-transition:')).toBe(true)
  })
})

describe('fetchLifecycleExecutionPreview', () => {
  it('an approved, non-stale request is reported executable with no advisory stale signal', async () => {
    const client = fakeClient({ request: { data: APPROVED_REQUEST_ROW }, topic: { data: MATCHING_TOPIC_ROW } })
    const result = await fetchLifecycleExecutionPreview(client as any, REQUEST_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.preview.executable).toBe(true)
    expect(result.preview.advisoryStaleSignal).toBeNull()
    expect(result.decisionOperationDigest).toBe(DIGEST)
  })
  it('a non-approved request (e.g. requested) is reported not executable', async () => {
    const client = fakeClient({ request: { data: { ...APPROVED_REQUEST_ROW, status: 'requested' } }, topic: { data: MATCHING_TOPIC_ROW } })
    const result = await fetchLifecycleExecutionPreview(client as any, REQUEST_ID)
    if (!result.ok) throw new Error('unreachable')
    expect(result.preview.executable).toBe(false)
  })
  it('a live lifecycle_status different from from_status raises advisory topic_state_changed', async () => {
    const client = fakeClient({ request: { data: APPROVED_REQUEST_ROW }, topic: { data: { lifecycle_status: 'ambiguous', status_version: 1 } } })
    const result = await fetchLifecycleExecutionPreview(client as any, REQUEST_ID)
    if (!result.ok) throw new Error('unreachable')
    expect(result.preview.advisoryStaleSignal).toBe('topic_state_changed')
  })
  it('a live status_version different from expected_status_version raises advisory topic_version_changed (only when lifecycle_status still matches)', async () => {
    const client = fakeClient({ request: { data: APPROVED_REQUEST_ROW }, topic: { data: { lifecycle_status: 'corroborating', status_version: 2 } } })
    const result = await fetchLifecycleExecutionPreview(client as any, REQUEST_ID)
    if (!result.ok) throw new Error('unreachable')
    expect(result.preview.advisoryStaleSignal).toBe('topic_version_changed')
  })
  it('a non-existent request returns ok:false without ever calling the execute RPC', async () => {
    const client = fakeClient({ request: { data: null } })
    const result = await fetchLifecycleExecutionPreview(client as any, REQUEST_ID)
    expect(result.ok).toBe(false)
    expect(client.rpc).not.toHaveBeenCalledWith('execute_approved_semantic_topic_lifecycle_transition', expect.anything())
  })
  it('a request with no decision digest yet (never decided) has a null idempotencyKeyPrefix', async () => {
    const client = fakeClient({ request: { data: { ...APPROVED_REQUEST_ROW, status: 'requested', decision_operation_digest: null } }, topic: { data: MATCHING_TOPIC_ROW } })
    const result = await fetchLifecycleExecutionPreview(client as any, REQUEST_ID)
    if (!result.ok) throw new Error('unreachable')
    expect(result.preview.idempotencyKeyPrefix).toBeNull()
    expect(result.decisionOperationDigest).toBeNull()
  })
  it('never leaks a full idempotency key -- only a prefix', async () => {
    const client = fakeClient({ request: { data: APPROVED_REQUEST_ROW }, topic: { data: MATCHING_TOPIC_ROW } })
    const result = await fetchLifecycleExecutionPreview(client as any, REQUEST_ID)
    if (!result.ok) throw new Error('unreachable')
    const fullKey = deriveLifecycleExecutionIdempotencyKey(REQUEST_ID, DIGEST)
    expect(result.preview.idempotencyKeyPrefix!.length).toBeLessThan(fullKey.length)
  })
})

describe('runExecuteApprovedLifecycleTransition', () => {
  it('dry-run never calls the execute RPC', async () => {
    const client = fakeClient({ request: { data: APPROVED_REQUEST_ROW }, topic: { data: MATCHING_TOPIC_ROW } })
    const outcome = await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: true })
    expect(outcome.kind).toBe('dry_run')
    expect(client.rpc).not.toHaveBeenCalledWith('execute_approved_semantic_topic_lifecycle_transition', expect.anything())
  })
  it('a non-executable status (requested) is refused locally, without ever calling the RPC', async () => {
    const client = fakeClient({ request: { data: { ...APPROVED_REQUEST_ROW, status: 'requested' } }, topic: { data: MATCHING_TOPIC_ROW } })
    const outcome = await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'not_executable', status: 'requested' })
    expect(client.rpc).not.toHaveBeenCalledWith('execute_approved_semantic_topic_lifecycle_transition', expect.anything())
  })
  it('apply calls the RPC exactly once on a clean success', async () => {
    const client = fakeClient({
      request: { data: APPROVED_REQUEST_ROW },
      topic: { data: MATCHING_TOPIC_ROW },
      executeResult: { data: { ok: true, outcomeKind: 'executed', reviewRequestId: REQUEST_ID }, error: null },
    })
    const outcome = await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'executed', reviewRequestIdPrefix: REQUEST_ID.slice(0, 8), fromStatus: 'corroborating', targetStatus: 'coherent' })
    const executeCalls = client.rpc.mock.calls.filter((c: unknown[]) => c[0] === 'execute_approved_semantic_topic_lifecycle_transition')
    expect(executeCalls).toHaveLength(1)
  })
  it('apply passes the derived idempotency key (from reviewRequestId + stored decision digest), never a caller-supplied one', async () => {
    const client = fakeClient({
      request: { data: APPROVED_REQUEST_ROW },
      topic: { data: MATCHING_TOPIC_ROW },
      executeResult: { data: { ok: true, outcomeKind: 'executed', reviewRequestId: REQUEST_ID }, error: null },
    })
    await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: false })
    const [, params] = client.rpc.mock.calls.find((c: unknown[]) => c[0] === 'execute_approved_semantic_topic_lifecycle_transition')!
    expect((params as Record<string, unknown>).p_idempotency_key).toBe(deriveLifecycleExecutionIdempotencyKey(REQUEST_ID, DIGEST))
  })
  it('replayed outcome is distinguished from executed', async () => {
    const client = fakeClient({
      request: { data: APPROVED_REQUEST_ROW },
      topic: { data: MATCHING_TOPIC_ROW },
      executeResult: { data: { ok: true, outcomeKind: 'replayed', reviewRequestId: REQUEST_ID }, error: null },
    })
    const outcome = await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'replayed', reviewRequestIdPrefix: REQUEST_ID.slice(0, 8) })
  })
  it('a stale result (normal ok:false return) never claims a transition happened', async () => {
    const client = fakeClient({
      request: { data: APPROVED_REQUEST_ROW },
      topic: { data: MATCHING_TOPIC_ROW },
      executeResult: { data: { ok: false, reasonCode: 'STALE_REVIEW_REQUEST', staleReasonCode: 'TOPIC_VERSION_CHANGED', reviewRequestId: REQUEST_ID }, error: null },
    })
    const outcome = await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'stale', reviewRequestIdPrefix: REQUEST_ID.slice(0, 8), staleReasonCode: 'TOPIC_VERSION_CHANGED' })
    const executeCalls = client.rpc.mock.calls.filter((c: unknown[]) => c[0] === 'execute_approved_semantic_topic_lifecycle_transition')
    expect(executeCalls).toHaveLength(1)
  })
  it('a REVIEW_REQUEST_NOT_EXECUTABLE exception maps to not_executable', async () => {
    const client = fakeClient({
      request: { data: { ...APPROVED_REQUEST_ROW, status: 'stale' } },
      topic: { data: MATCHING_TOPIC_ROW },
      executeResult: { data: null, error: { message: 'execute_approved_semantic_topic_lifecycle_transition: REVIEW_REQUEST_NOT_EXECUTABLE -- status=stale' } },
    })
    const outcome = await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'not_executable' })
  })
  it('an unrecognized exception message maps to database_error, fail-closed', async () => {
    const client = fakeClient({
      request: { data: APPROVED_REQUEST_ROW },
      topic: { data: MATCHING_TOPIC_ROW },
      executeResult: { data: null, error: { code: '42P01', message: 'relation does not exist' } },
    })
    const outcome = await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'database_error' })
  })
  it('a malformed RPC response body maps to database_error', async () => {
    const client = fakeClient({ request: { data: APPROVED_REQUEST_ROW }, topic: { data: MATCHING_TOPIC_ROW }, executeResult: { data: {}, error: null } })
    const outcome = await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'database_error' })
  })
  it('a stale outcome never triggers a second RPC call (no automatic retry or new request creation)', async () => {
    const client = fakeClient({
      request: { data: APPROVED_REQUEST_ROW },
      topic: { data: MATCHING_TOPIC_ROW },
      executeResult: { data: { ok: false, reasonCode: 'STALE_REVIEW_REQUEST', staleReasonCode: 'TOPIC_STATE_CHANGED', reviewRequestId: REQUEST_ID }, error: null },
    })
    await runExecuteApprovedLifecycleTransition(client as any, { reviewRequestId: REQUEST_ID, dryRun: false })
    const executeCalls = client.rpc.mock.calls.filter((c: unknown[]) => c[0] === 'execute_approved_semantic_topic_lifecycle_transition')
    expect(executeCalls).toHaveLength(1)
    expect(client.rpc.mock.calls.some((c: unknown[]) => c[0] === 'create_semantic_topic_lifecycle_review_request')).toBe(false)
  })
})

describe('exitCodeForLifecycleExecutionOutcome', () => {
  it('maps OK outcomes to exit 0', () => {
    expect(exitCodeForLifecycleExecutionOutcome({ kind: 'dry_run', preview: {} as any })).toBe(LIFECYCLE_EXECUTOR_EXIT_CODE.OK)
    expect(exitCodeForLifecycleExecutionOutcome({ kind: 'executed', reviewRequestIdPrefix: 'x', fromStatus: 'a', targetStatus: 'b' })).toBe(LIFECYCLE_EXECUTOR_EXIT_CODE.OK)
    expect(exitCodeForLifecycleExecutionOutcome({ kind: 'replayed', reviewRequestIdPrefix: 'x' })).toBe(LIFECYCLE_EXECUTOR_EXIT_CODE.OK)
  })
  it('maps not_executable/stale/configuration_error/database_error to their own distinct exit codes', () => {
    expect(exitCodeForLifecycleExecutionOutcome({ kind: 'not_executable' })).toBe(LIFECYCLE_EXECUTOR_EXIT_CODE.NOT_EXECUTABLE)
    expect(exitCodeForLifecycleExecutionOutcome({ kind: 'stale', reviewRequestIdPrefix: 'x', staleReasonCode: 'Y' })).toBe(LIFECYCLE_EXECUTOR_EXIT_CODE.STALE)
    expect(exitCodeForLifecycleExecutionOutcome({ kind: 'configuration_error', message: 'x' })).toBe(LIFECYCLE_EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR)
    expect(exitCodeForLifecycleExecutionOutcome({ kind: 'database_error' })).toBe(LIFECYCLE_EXECUTOR_EXIT_CODE.DATABASE_ERROR)
  })
})
