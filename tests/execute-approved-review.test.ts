// PFM Approved Human Review Executor v0 -- unit tests (mocked client, no
// DB, no network). Exercises runExecuteApprovedReview()'s branching against
// a mock SemanticTopicAdminClient whose .rpc() drives the REAL
// executeApprovedReview() wrapper (human-review-service.ts) unmocked --
// only the underlying RPC call itself is faked, so this proves the actual
// wrapper -> mapReviewRpcError -> this module's classification chain, not
// a re-implementation of it.
import { describe, expect, it, vi } from 'vitest'
import {
  computeDecisionsDigestV2,
} from '@/lib/semantic-topic/decisions-digest'
import {
  EXECUTOR_EXIT_CODE,
  deriveExecutionIdempotencyKey,
  exitCodeForExecutorOutcome,
  fetchApprovedReviewPreview,
  runExecuteApprovedReview,
  type ExecutorOutcome,
} from '@/lib/semantic-topic/execute-approved-review-cli-support'
import { redactForDisplay } from '@/lib/semantic-topic/operator-cli-security'

const REVIEW_REQUEST_ID = 'edf568c9-1111-2222-3333-444455556666'
const EXTRACTION_RUN_ID = 'fe246a30-1111-2222-3333-444455556666'
const EVIDENCE_ID = 'f8c2ef09-1111-2222-3333-444455556666'
const SEMANTIC_TOPIC_ID = 'aaaaaaaa-1111-2222-3333-444455556666'
const MEMBERSHIP_ID = 'bbbbbbbb-1111-2222-3333-444455556666'
const DECISION_ID = 'cccccccc-1111-2222-3333-444455556666'
const APPROVAL_DIGEST = 'dd'.repeat(32)

function approvedRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_REQUEST_ID,
    status: 'approved',
    generation: 1,
    requested_at: '2026-08-29T11:13:25.882016+00:00',
    decided_at: '2026-08-29T12:00:00.000000+00:00',
    executed_at: null,
    expires_at: '2026-09-05T11:13:25.882016+00:00',
    canonical_topic_label: '"I Never Told You This Before" couple makeover challenge',
    topic_definition: 'A definition.',
    scope: 'A scope.',
    inclusion_criteria: 'Incl.',
    exclusion_criteria: 'Excl.',
    reviewer_rationale: 'Clear and well-evidenced.',
    approval_digest: APPROVAL_DIGEST,
    approval_digest_version: 1,
    proposed_outcome: 'CREATE_NEW',
    extraction_run_id: EXTRACTION_RUN_ID,
    ...overrides,
  }
}

function extractionRunRow() {
  return {
    id: EXTRACTION_RUN_ID,
    signal_evidence_id: EVIDENCE_ID,
    structured_output: { confidence: 0.62, specificity: 'specific', content_format: 'list_ranking' },
  }
}

function buildMockClient(opts: {
  reviewRequestRow?: Record<string, unknown> | null
  reviewRequestError?: { message: string } | null
  extractionRunRow?: Record<string, unknown> | null
  extractionRunError?: { message: string } | null
  rpc?: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
}) {
  const rpcCalls: { name: string; params: Record<string, unknown> }[] = []
  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => {
                  if (table === 'topic_assignment_review_requests') {
                    return { data: opts.reviewRequestRow ?? null, error: opts.reviewRequestError ?? null }
                  }
                  if (table === 'topic_extraction_runs') {
                    return { data: opts.extractionRunRow ?? null, error: opts.extractionRunError ?? null }
                  }
                  throw new Error(`unexpected table ${table}`)
                },
              }
            },
          }
        },
      }
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params })
      if (!opts.rpc) throw new Error('unexpected .rpc() call -- no rpc handler configured for this test')
      return opts.rpc(name, params)
    },
  }
  return { client, rpcCalls }
}

describe('deriveExecutionIdempotencyKey', () => {
  it('is deterministic and namespaced -- same input always produces the same key, never a random one', () => {
    expect(deriveExecutionIdempotencyKey(REVIEW_REQUEST_ID)).toBe(deriveExecutionIdempotencyKey(REVIEW_REQUEST_ID))
    expect(deriveExecutionIdempotencyKey(REVIEW_REQUEST_ID)).toBe(`execute-approved-review:${REVIEW_REQUEST_ID}`)
  })
  it('different review_request_id -> different key', () => {
    expect(deriveExecutionIdempotencyKey(REVIEW_REQUEST_ID)).not.toBe(deriveExecutionIdempotencyKey(EXTRACTION_RUN_ID))
  })
})

describe('fetchApprovedReviewPreview', () => {
  it('builds a fully redacted preview: only 8-char prefixes for ids/digest, no reviewer UUID field at all', async () => {
    const { client } = buildMockClient({ reviewRequestRow: approvedRequestRow(), extractionRunRow: extractionRunRow() })
    const result = await fetchApprovedReviewPreview(client as any, REVIEW_REQUEST_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preview.reviewRequestIdPrefix).toBe(REVIEW_REQUEST_ID.slice(0, 8))
    expect(result.preview.extractionRunIdPrefix).toBe(EXTRACTION_RUN_ID.slice(0, 8))
    expect(result.preview.signalEvidenceIdPrefix).toBe(EVIDENCE_ID.slice(0, 8))
    expect(result.preview.approvalDigestPrefix).toBe(APPROVAL_DIGEST.slice(0, 8) + '…')
    expect(JSON.stringify(result.preview)).not.toContain(REVIEW_REQUEST_ID)
    expect(JSON.stringify(result.preview)).not.toContain(EXTRACTION_RUN_ID)
    expect(JSON.stringify(result.preview)).not.toContain(EVIDENCE_ID)
    expect(JSON.stringify(result.preview)).not.toContain(APPROVAL_DIGEST)
    // No key named anything reviewer-identity-shaped anywhere in the preview.
    expect(JSON.stringify(result.preview).toLowerCase()).not.toContain('reviewer_user_id')
    expect(JSON.stringify(result.preview).toLowerCase()).not.toContain('revieweruserid')
  })

  it('expectedLifecycle is always candidate_singleton, expectedSideEffectCount.topics=1 for CREATE_NEW', async () => {
    const { client } = buildMockClient({ reviewRequestRow: approvedRequestRow({ proposed_outcome: 'CREATE_NEW' }), extractionRunRow: extractionRunRow() })
    const result = await fetchApprovedReviewPreview(client as any, REVIEW_REQUEST_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preview.expectedLifecycle).toBe('candidate_singleton')
    expect(result.preview.expectedSideEffectCount).toEqual({ events: 1, topics: 1, memberships: 1, membershipEvents: 1, decisions: 1 })
  })

  it('expectedSideEffectCount.topics=0 for ATTACH_EXISTING (no new topic)', async () => {
    const { client } = buildMockClient({ reviewRequestRow: approvedRequestRow({ proposed_outcome: 'ATTACH_EXISTING' }), extractionRunRow: extractionRunRow() })
    const result = await fetchApprovedReviewPreview(client as any, REVIEW_REQUEST_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preview.expectedSideEffectCount.topics).toBe(0)
  })

  it('review_request not found -> configuration_error-shaped result, no full id embedded', async () => {
    const { client } = buildMockClient({ reviewRequestRow: null })
    const result = await fetchApprovedReviewPreview(client as any, REVIEW_REQUEST_ID)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain(REVIEW_REQUEST_ID)
  })

  it('linked extraction_run not found -> configuration_error-shaped result', async () => {
    const { client } = buildMockClient({ reviewRequestRow: approvedRequestRow(), extractionRunRow: null })
    const result = await fetchApprovedReviewPreview(client as any, REVIEW_REQUEST_ID)
    expect(result.ok).toBe(false)
  })
})

describe('runExecuteApprovedReview', () => {
  it('dry_run: returns the preview, never calls .rpc()', async () => {
    const { client, rpcCalls } = buildMockClient({ reviewRequestRow: approvedRequestRow(), extractionRunRow: extractionRunRow() })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: true })
    expect(outcome.kind).toBe('dry_run')
    expect(rpcCalls.length).toBe(0)
    expect(exitCodeForExecutorOutcome(outcome)).toBe(EXECUTOR_EXIT_CODE.OK)
  })

  it.each(['pending', 'rejected', 'cancelled', 'expired', 'revoked'])('status=%s never reaches the RPC -- not_executable, exit 3, zero writes', async (status) => {
    const { client, rpcCalls } = buildMockClient({ reviewRequestRow: approvedRequestRow({ status }), extractionRunRow: extractionRunRow() })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'not_executable', status })
    expect(rpcCalls.length).toBe(0)
    expect(exitCodeForExecutorOutcome(outcome)).toBe(EXECUTOR_EXIT_CODE.NOT_EXECUTABLE)
  })

  it('executed: exactly one .rpc() call, correct prefixes, exit 0', async () => {
    const { client, rpcCalls } = buildMockClient({
      reviewRequestRow: approvedRequestRow(),
      extractionRunRow: extractionRunRow(),
      rpc: async () => ({
        data: {
          ok: true, outcome: 'executed', review_request_id: REVIEW_REQUEST_ID, proposed_outcome: 'CREATE_NEW',
          semantic_topic_id: SEMANTIC_TOPIC_ID, resulting_membership_id: MEMBERSHIP_ID, resulting_decision_id: DECISION_ID,
        },
        error: null,
      }),
    })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({
      kind: 'executed', reviewRequestIdPrefix: REVIEW_REQUEST_ID.slice(0, 8), proposedOutcome: 'CREATE_NEW',
      semanticTopicIdPrefix: SEMANTIC_TOPIC_ID.slice(0, 8), membershipIdPrefix: MEMBERSHIP_ID.slice(0, 8), decisionIdPrefix: DECISION_ID.slice(0, 8),
    })
    expect(rpcCalls.length).toBe(1)
    expect(rpcCalls[0].name).toBe('execute_approved_topic_assignment_review')
    expect(exitCodeForExecutorOutcome(outcome)).toBe(EXECUTOR_EXIT_CODE.OK)
    expect(JSON.stringify(outcome)).not.toContain(SEMANTIC_TOPIC_ID)
    expect(JSON.stringify(outcome)).not.toContain(MEMBERSHIP_ID)
    expect(JSON.stringify(outcome)).not.toContain(DECISION_ID)
  })

  it('replayed: only resultingDecisionIdPrefix populated (no topic/membership -- the RPC replay branch never returns those), exit 0, exactly one .rpc() call', async () => {
    const { client, rpcCalls } = buildMockClient({
      reviewRequestRow: approvedRequestRow({ status: 'executed' }),
      extractionRunRow: extractionRunRow(),
      rpc: async () => ({ data: { ok: true, outcome: 'replayed', review_request_id: REVIEW_REQUEST_ID, resulting_decision_id: DECISION_ID }, error: null }),
    })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'replayed', reviewRequestIdPrefix: REVIEW_REQUEST_ID.slice(0, 8), resultingDecisionIdPrefix: DECISION_ID.slice(0, 8) })
    expect(rpcCalls.length).toBe(1)
    expect(exitCodeForExecutorOutcome(outcome)).toBe(EXECUTOR_EXIT_CODE.OK)
  })

  it('RPC error "ALREADY_EXECUTED" (mismatched key) -> blocked/ALREADY_EXECUTED_DIFFERENT_KEY, exit 4', async () => {
    const { client } = buildMockClient({
      reviewRequestRow: approvedRequestRow({ status: 'executed' }),
      extractionRunRow: extractionRunRow(),
      rpc: async () => ({ data: null, error: { message: `execute_approved_topic_assignment_review: ALREADY_EXECUTED -- review_request ${REVIEW_REQUEST_ID} already executed` } }),
    })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'blocked', reasonCode: 'ALREADY_EXECUTED_DIFFERENT_KEY' })
    expect(exitCodeForExecutorOutcome(outcome)).toBe(EXECUTOR_EXIT_CODE.BLOCKED)
  })

  it('RPC error "IDEMPOTENCY_KEY_REUSE" -> blocked/IDEMPOTENCY_KEY_REUSE, exit 4', async () => {
    const { client } = buildMockClient({
      reviewRequestRow: approvedRequestRow(),
      extractionRunRow: extractionRunRow(),
      rpc: async () => ({ data: null, error: { message: 'execute_approved_topic_assignment_review: IDEMPOTENCY_KEY_REUSE -- idempotency_key x already used on a different review_request' } }),
    })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'blocked', reasonCode: 'IDEMPOTENCY_KEY_REUSE' })
  })

  it.each([
    ['request_payload_digest drift detected for review_request x', 'REQUEST_PAYLOAD_DIGEST_DRIFT'],
    ['approval_digest drift detected for review_request x', 'APPROVAL_DIGEST_DRIFT'],
    ['unsupported review_policy_version/approval_digest_version for review_request x', 'UNSUPPORTED_POLICY_VERSION'],
    ['reviewer for review_request x is no longer active', 'REVIEWER_NO_LONGER_ACTIVE'],
    ['extraction_run x already has a topic_assignment_decisions row', 'EXTRACTION_RUN_ALREADY_DECIDED'],
    ['extraction_run x is no longer completed (status=failed)', 'EXTRACTION_RUN_NOT_COMPLETED'],
    ['target topic lifecycle_status=archived no longer accepts ATTACH_EXISTING', 'TARGET_TOPIC_LIFECYCLE_BLOCKS_ATTACH'],
  ])('known RPC business-rule message %j classifies to blocked/%s, exit 4', async (message, reasonCode) => {
    const { client } = buildMockClient({
      reviewRequestRow: approvedRequestRow(),
      extractionRunRow: extractionRunRow(),
      rpc: async () => ({ data: null, error: { message: `execute_approved_topic_assignment_review: ${message}` } }),
    })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'blocked', reasonCode })
    expect(exitCodeForExecutorOutcome(outcome)).toBe(EXECUTOR_EXIT_CODE.BLOCKED)
  })

  it('a "target semantic_topic ... not found" RPC message is intercepted by mapReviewRpcError()s own generic /not found/ pattern BEFORE this module ever classifies it -- surfaces honestly as configuration_error, not a guessed blocked/TARGET_TOPIC_NOT_FOUND (documents a real upstream-mapping limitation discovered while building this classifier, not an oversight)', async () => {
    const { client } = buildMockClient({
      reviewRequestRow: approvedRequestRow({ proposed_outcome: 'ATTACH_EXISTING' }),
      extractionRunRow: extractionRunRow(),
      rpc: async () => ({ data: null, error: { message: 'execute_approved_topic_assignment_review: target semantic_topic deadbeef-0000-0000-0000-000000000000 not found' } }),
    })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome.kind).toBe('configuration_error')
    expect(exitCodeForExecutorOutcome(outcome)).toBe(EXECUTOR_EXIT_CODE.VALIDATION_OR_CONFIG_ERROR)
    if (outcome.kind === 'configuration_error') expect(outcome.message).not.toContain('deadbeef')
  })

  it('an unrecognized RPC error message stays database_error -- fail-closed, never guesses a reasonCode, exit 5', async () => {
    const { client } = buildMockClient({
      reviewRequestRow: approvedRequestRow(),
      extractionRunRow: extractionRunRow(),
      rpc: async () => ({ data: null, error: { message: 'execute_approved_topic_assignment_review: some totally novel failure nobody anticipated' } }),
    })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'database_error', operation: 'execute_approved_topic_assignment_review' })
    expect(exitCodeForExecutorOutcome(outcome)).toBe(EXECUTOR_EXIT_CODE.UNEXPECTED_ERROR)
  })

  it('an unknown/malformed executeApprovedReview() result (module-mocked) falls to the fail-closed default branch, never crashes, exit 5', async () => {
    vi.resetModules()
    vi.doMock('@/lib/semantic-topic/human-review-service', () => ({
      executeApprovedReview: async () => ({ outcome: 'not_eligible', message: 'a variant this module never expects from this specific wrapper' }),
    }))
    const { runExecuteApprovedReview: freshRun, exitCodeForExecutorOutcome: freshExit, EXECUTOR_EXIT_CODE: freshCodes } = await import(
      '@/lib/semantic-topic/execute-approved-review-cli-support'
    )
    const { client } = buildMockClient({ reviewRequestRow: approvedRequestRow(), extractionRunRow: extractionRunRow() })
    const outcome = await freshRun(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome).toEqual({ kind: 'database_error', operation: 'execute_approved_topic_assignment_review' })
    expect(freshExit(outcome)).toBe(freshCodes.UNEXPECTED_ERROR)
    vi.doUnmock('@/lib/semantic-topic/human-review-service')
    vi.resetModules()
  })

  it('review_request not found (via RPC not_found path, status already advanced past the local check) -> configuration_error', async () => {
    const { client } = buildMockClient({
      reviewRequestRow: approvedRequestRow(),
      extractionRunRow: extractionRunRow(),
      rpc: async () => ({ data: null, error: { message: `execute_approved_topic_assignment_review: review_request ${REVIEW_REQUEST_ID} not found (post-lock)` } }),
    })
    const outcome = await runExecuteApprovedReview(client as any, { reviewRequestId: REVIEW_REQUEST_ID, dryRun: false })
    expect(outcome.kind).toBe('configuration_error')
  })
})

describe('ExecutorOutcome serialization never leaks a full UUID', () => {
  const sample: ExecutorOutcome[] = [
    { kind: 'executed', reviewRequestIdPrefix: 'edf568c9', proposedOutcome: 'CREATE_NEW', semanticTopicIdPrefix: 'aaaaaaaa', membershipIdPrefix: 'bbbbbbbb', decisionIdPrefix: 'cccccccc' },
    { kind: 'replayed', reviewRequestIdPrefix: 'edf568c9', resultingDecisionIdPrefix: 'cccccccc' },
    { kind: 'not_executable', status: 'pending' },
    { kind: 'blocked', reasonCode: 'APPROVAL_DIGEST_DRIFT' },
    { kind: 'database_error', operation: 'execute_approved_topic_assignment_review' },
  ]
  const FULL_UUIDS = [REVIEW_REQUEST_ID, EXTRACTION_RUN_ID, EVIDENCE_ID, SEMANTIC_TOPIC_ID, MEMBERSHIP_ID, DECISION_ID]

  it.each(sample)('outcome kind=$kind never contains a full known UUID when redacted and stringified', (outcome) => {
    const redacted = redactForDisplay(outcome)
    const json = JSON.stringify(redacted)
    for (const uuid of FULL_UUIDS) expect(json).not.toContain(uuid)
  })
})

// Sanity cross-check that decisions-digest.ts (used by the CLI's optional
// digest-preflight display, if wired in) never becomes part of a preview
// object that could leak a full UUID through its own aggregate hash --
// the hash itself is opaque hex, but this documents that expectation.
describe('decisions digest never embeds a full UUID in its own output', () => {
  it('hex-only output for a row containing full UUIDs as input', () => {
    const digest = computeDecisionsDigestV2([{ id: REVIEW_REQUEST_ID, extractionRunId: EXTRACTION_RUN_ID, outcome: 'CREATE_NEW', decisionDigest: 'ab'.repeat(32) }])
    expect(digest).not.toContain(REVIEW_REQUEST_ID)
    expect(digest).not.toContain(EXTRACTION_RUN_ID)
    expect(digest).toMatch(/^v2:1:[0-9a-f]{64}$/)
  })
})
