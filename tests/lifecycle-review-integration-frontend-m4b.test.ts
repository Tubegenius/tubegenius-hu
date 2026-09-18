import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  LifecycleEvidenceVector,
  LifecycleReviewDetail,
  LifecycleReviewListItem,
  LifecycleRequestStatus,
} from '@/lib/semantic-topic/lifecycle-review-types'
import {
  fetchLifecycleReviewerCapability,
  parseLifecycleReviewerCapability,
} from '@/lib/lifecycle-review-capability-client'
import { requestLifecycleJson } from '@/lib/lifecycle-review-client'
import {
  LIFECYCLE_LIST_PAGE_SIZE,
  buildLifecycleReviewListUrl,
  deriveLifecycleCursor,
  filterLifecycleTransitions,
  lifecycleListError,
  parseLifecycleReviewListResponse,
} from '@/lib/lifecycle-review-presentation'
import {
  buildLifecycleReviewDetailUrl,
  lifecycleDetailError,
  parseLifecycleReviewDetailResponse,
} from '@/lib/lifecycle-review-detail-presentation'
import {
  buildLifecycleDecisionBody,
  buildLifecycleDecisionUrl,
  createLifecycleDecisionIdempotencyKey,
  lifecycleDecisionSubmitError,
  parseLifecycleDecisionResponse,
  type LifecycleDecisionDraft,
} from '@/lib/lifecycle-review-decision-presentation'
import {
  buildLifecycleCancelBody,
  buildLifecycleCancelUrl,
  createLifecycleCancelIdempotencyKey,
  lifecycleCancelSubmitError,
  parseLifecycleCancelResponse,
  type LifecycleCancelDraft,
} from '@/lib/lifecycle-review-cancel-presentation'

const REQUEST_ID = '7dcddc8d-ab57-42b2-99ce-ec996858520d'
const TOPIC_ID = 'a388f707-8991-403a-b5df-33385d81282c'

function evidence(overrides: Partial<LifecycleEvidenceVector> = {}): LifecycleEvidenceVector {
  return {
    ok: true,
    formulaVersion: 'evidence-v3',
    semanticTopicId: TOPIC_ID,
    lifecycleStatus: 'corroborating',
    activeMembershipCount: 14,
    eligibleMembershipCount: 11,
    syndicationExcludedCount: 2,
    eligibleDistinctSourceIdentityCount: 7,
    unknownSourceCount: 0,
    manualReviewConfirmedSourceCount: 3,
    manualReviewOverrideSourceCount: 0,
    automatedAssignmentSourceCount: 8,
    topicCreationSeedSourceCount: 1,
    assignmentReasonBreakdownComplete: true,
    unclassifiedAssignmentReasonEligibleMembershipCount: 0,
    mixedAlgorithmVersions: false,
    byAlgorithmVersion: { 'semantic-v5': 11 },
    confidenceDiagnostics: { min: 0.72, max: 0.94, count: 11 },
    evidenceIdentityComplete: true,
    sourceIdentityKnown: true,
    inputIntegrityStatus: 'complete',
    ...overrides,
  }
}

function listItem(overrides: Partial<LifecycleReviewListItem> = {}): LifecycleReviewListItem {
  return {
    reviewRequestId: REQUEST_ID,
    generation: 3,
    semanticTopicId: TOPIC_ID,
    topicCanonicalLabel: 'Short-form storytelling systems',
    fromStatus: 'corroborating',
    targetStatus: 'coherent',
    requestStatus: 'requested',
    requestedAt: '2026-09-14T08:30:00.000Z',
    expiresAt: '2026-09-16T08:30:00.000Z',
    decidedAt: null,
    staleReasonCode: null,
    ...overrides,
  }
}

function detail(status: LifecycleRequestStatus = 'requested'): LifecycleReviewDetail {
  const decided = status === 'approved' || status === 'rejected'
  const cancelled = status === 'cancelled'
  return {
    ...listItem({
      requestStatus: status,
      decidedAt: decided ? '2026-09-14T10:12:00.000Z' : null,
      staleReasonCode: status === 'stale' ? 'EVIDENCE_VECTOR_CHANGED' : null,
    }),
    snapshot: {
      evidenceVector: evidence(),
      digest: 'sha256:snapshot-vector-0000000000000001',
      capturedAt: '2026-09-14T08:30:00.000Z',
      fromLifecycleStatus: 'corroborating',
      expectedStatusVersion: 12,
    },
    reviewPolicyVersion: 1,
    decision: decided ? {
      reviewerRoleSnapshot: 'semantic_topic_reviewer',
      decidedAt: '2026-09-14T10:12:00.000Z',
      reasonCode: status === 'approved' ? 'identity_consistency_confirmed' : 'insufficient_evidence',
      reviewerRationale: 'A bizonyítéki és azonossági jeleket ellenőriztem.',
      sameSemanticIdentityConfirmed: status === 'approved' ? true : null,
      noMaterialIdentityConflict: status === 'approved' ? true : null,
      canonicalDefinitionScopeFitConfirmed: status === 'approved' ? true : null,
      provenanceRelationshipReviewed: status === 'approved' ? true : null,
      decidedByCurrentReviewer: true,
    } : null,
    execution: null,
    cancellation: cancelled ? {
      cancelledAt: '2026-09-14T11:00:00.000Z',
      cancelReasonCode: 'NEW_EVIDENCE_REQUIRES_NEW_REVIEW',
      cancelRationale: 'Új bizonyítéki kör érkezett.',
      cancelledByCurrentReviewer: true,
    } : null,
    transitionHistory: [
      { eventType: 'requested', actorKind: 'service_role_system', createdAt: '2026-09-14T08:30:00.000Z' },
      ...(decided ? [{ eventType: status, actorKind: 'authenticated_reviewer', createdAt: '2026-09-14T10:12:00.000Z' } as const] : []),
      ...(cancelled ? [{ eventType: 'cancelled', actorKind: 'authenticated_reviewer', createdAt: '2026-09-14T11:00:00.000Z' } as const] : []),
    ],
    live: {
      lifecycleStatus: 'corroborating',
      statusVersion: 12,
      evidenceVector: evidence(),
      vectorDigest: 'sha256:snapshot-vector-0000000000000001',
      mechanicalRequirementsCurrentlyMet: true,
    },
    stalenessSignals: {
      topicStatusChanged: false,
      topicVersionChanged: false,
      evidenceVectorChanged: false,
      mechanicalRequirementsLost: false,
    },
    isPotentiallyStale: false,
  }
}

const approveDraft: LifecycleDecisionDraft = {
  outcome: 'approved',
  reasonCode: 'identity_consistency_confirmed',
  reviewerRationale: 'A forrásazonosságok és a kanonikus definíció konzisztens.',
  sameSemanticIdentityConfirmed: true,
  noMaterialIdentityConflict: true,
  canonicalDefinitionScopeFitConfirmed: true,
  provenanceRelationshipReviewed: true,
}

const rejectDraft: LifecycleDecisionDraft = {
  outcome: 'rejected',
  reasonCode: 'insufficient_evidence',
  reviewerRationale: 'A jelenlegi bizonyíték nem elegendő a lifecycle váltáshoz.',
  sameSemanticIdentityConfirmed: null,
  noMaterialIdentityConflict: null,
  canonicalDefinitionScopeFitConfirmed: null,
  provenanceRelationshipReviewed: null,
}

const cancelDraft: LifecycleCancelDraft = {
  cancelReasonCode: 'NEW_EVIDENCE_REQUIRES_NEW_REVIEW',
  cancelRationale: 'Új bizonyítéki kör érkezett, ezért friss kérelem szükséges.',
}

describe('Lifecycle Reviewer Milestone 4B capability access closure', () => {
  it('accepts only the explicit closed boolean contract', () => {
    expect(parseLifecycleReviewerCapability({ canReviewSemanticTopicLifecycle: true })).toEqual({ canReviewSemanticTopicLifecycle: true })
    expect(parseLifecycleReviewerCapability({ canReviewSemanticTopicLifecycle: false })).toEqual({ canReviewSemanticTopicLifecycle: false })
    expect(parseLifecycleReviewerCapability({ canReviewSemanticTopicLifecycle: 'true' })).toBeNull()
    expect(parseLifecycleReviewerCapability({ canReview: true })).toBeNull()
    expect(parseLifecycleReviewerCapability(null)).toBeNull()
  })

  it.each([
    [true, 200, { canReviewSemanticTopicLifecycle: true }],
    [false, 200, { canReviewSemanticTopicLifecycle: false }],
    [false, 401, { error: 'Unauthorized' }],
    [false, 403, { error: 'Forbidden' }],
    [false, 500, { error: 'Internal server error' }],
    [false, 200, { canReviewSemanticTopicLifecycle: 'true' }],
  ])('fails closed to %s for HTTP %s and payload %o', async (expected, status, payload) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch
    await expect(fetchLifecycleReviewerCapability(undefined, fetcher)).resolves.toBe(expected)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('fails closed on a network error without automatic retry', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('offline') }) as unknown as typeof fetch
    await expect(fetchLifecycleReviewerCapability(undefined, fetcher)).resolves.toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps the menu hidden during loading and never derives access from identity metadata', () => {
    const shell = readFileSync(join(process.cwd(), 'components', 'dashboard', 'CreatorOSShell.tsx'), 'utf8')
    const capability = readFileSync(join(process.cwd(), 'lib', 'lifecycle-review-capability-client.ts'), 'utf8')
    expect(shell).toContain('useState(false)')
    expect(shell).toContain('canReviewSemanticTopicLifecycle ? (')
    expect(shell).toContain('if (!controller.signal.aborted && canReview)')
    expect(capability).toContain('=== true')
    expect(`${shell}\n${capability}`).not.toMatch(/localStorage|sessionStorage/)
    expect(capability).not.toMatch(/email|profile|metadata/i)
  })
})

describe('Lifecycle Reviewer Milestone 4B mocked integration flow', () => {
  it('runs capability → list → detail → approve → reread → cancel → reread through the production URL builders', async () => {
    let serverStatus: LifecycleRequestStatus = 'requested'
    const detailReads: LifecycleRequestStatus[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/capability')) return Response.json({ canReviewSemanticTopicLifecycle: true })
      if (url === buildLifecycleReviewListUrl('actionable', LIFECYCLE_LIST_PAGE_SIZE, null)) {
        return Response.json({ requests: [listItem({ requestStatus: serverStatus })] })
      }
      if (url === buildLifecycleDecisionUrl(REQUEST_ID) && init?.method === 'POST') {
        serverStatus = 'approved'
        return Response.json({ result: { outcomeKind: 'approved', reviewRequestId: REQUEST_ID, status: serverStatus } })
      }
      if (url === buildLifecycleCancelUrl(REQUEST_ID) && init?.method === 'POST') {
        serverStatus = 'cancelled'
        return Response.json({ result: { outcomeKind: 'cancelled', reviewRequestId: REQUEST_ID, status: serverStatus } })
      }
      if (url === buildLifecycleReviewDetailUrl(REQUEST_ID)) {
        detailReads.push(serverStatus)
        return Response.json({ request: detail(serverStatus) })
      }
      return Response.json({ error: 'not found' }, { status: 404 })
    }) as unknown as typeof fetch

    await expect(fetchLifecycleReviewerCapability(undefined, fetcher)).resolves.toBe(true)

    const listResponse = await requestLifecycleJson(buildLifecycleReviewListUrl('actionable', LIFECYCLE_LIST_PAGE_SIZE, null), {
      method: 'GET', headers: { Accept: 'application/json' },
    }, fetcher)
    expect(parseLifecycleReviewListResponse(listResponse.payload)).toHaveLength(1)

    const initialDetail = await requestLifecycleJson(buildLifecycleReviewDetailUrl(REQUEST_ID), {
      method: 'GET', headers: { Accept: 'application/json' },
    }, fetcher)
    expect(parseLifecycleReviewDetailResponse(initialDetail.payload)?.requestStatus).toBe('requested')

    const decisionKey = createLifecycleDecisionIdempotencyKey(REQUEST_ID, () => '11111111-2222-4333-8444-555555555555')
    const decisionBody = buildLifecycleDecisionBody(approveDraft, 'coherent', 1, decisionKey)
    const decisionResponse = await requestLifecycleJson(buildLifecycleDecisionUrl(REQUEST_ID), {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(decisionBody),
    }, fetcher)
    expect(parseLifecycleDecisionResponse(decisionResponse.payload)?.status).toBe('approved')

    const afterDecision = await requestLifecycleJson(buildLifecycleReviewDetailUrl(REQUEST_ID), {
      method: 'GET', headers: { Accept: 'application/json' },
    }, fetcher)
    expect(parseLifecycleReviewDetailResponse(afterDecision.payload)?.requestStatus).toBe('approved')

    const cancelKey = createLifecycleCancelIdempotencyKey(REQUEST_ID, () => '66666666-7777-4888-8999-000000000000')
    const cancelBody = buildLifecycleCancelBody(cancelDraft, cancelKey)
    const cancelResponse = await requestLifecycleJson(buildLifecycleCancelUrl(REQUEST_ID), {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(cancelBody),
    }, fetcher)
    expect(parseLifecycleCancelResponse(cancelResponse.payload)?.status).toBe('cancelled')

    const afterCancel = await requestLifecycleJson(buildLifecycleReviewDetailUrl(REQUEST_ID), {
      method: 'GET', headers: { Accept: 'application/json' },
    }, fetcher)
    expect(parseLifecycleReviewDetailResponse(afterCancel.payload)?.requestStatus).toBe('cancelled')
    expect(detailReads).toEqual(['requested', 'approved', 'cancelled'])
    expect(fetcher).toHaveBeenCalledTimes(7)
  })

  it('covers filters, complete keyset pagination and a potentially stale detail', () => {
    const page = Array.from({ length: LIFECYCLE_LIST_PAGE_SIZE }, (_, index) => listItem({
      reviewRequestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      requestedAt: `2026-09-14T08:${String(index).padStart(2, '0')}:00.000Z`,
      fromStatus: index % 2 ? 'ambiguous' : 'corroborating',
      targetStatus: index % 2 ? 'corroborating' : 'coherent',
    }))
    const cursor = deriveLifecycleCursor(page, LIFECYCLE_LIST_PAGE_SIZE)
    expect(cursor).not.toBeNull()
    expect(buildLifecycleReviewListUrl('history', LIFECYCLE_LIST_PAGE_SIZE, cursor)).toContain('after_requested_at=')
    expect(filterLifecycleTransitions(page, 'corroborating', 'coherent')).toHaveLength(LIFECYCLE_LIST_PAGE_SIZE / 2)
    expect(parseLifecycleReviewDetailResponse({ request: { ...detail('stale'), isPotentiallyStale: true } })?.isPotentiallyStale).toBe(true)
  })

  it('builds both approve and reject payloads while retaining a stable key for a manual retry', () => {
    const stableKey = createLifecycleDecisionIdempotencyKey(REQUEST_ID, () => '11111111-2222-4333-8444-555555555555')
    const approve = buildLifecycleDecisionBody(approveDraft, 'coherent', 1, stableKey)
    const manualRetry = buildLifecycleDecisionBody(approveDraft, 'coherent', 1, stableKey)
    const reject = buildLifecycleDecisionBody(rejectDraft, 'coherent', 1, stableKey)
    expect(approve?.outcome).toBe('approved')
    expect(reject?.outcome).toBe('rejected')
    expect(manualRetry?.idempotencyKey).toBe(approve?.idempotencyKey)

    const cancelKey = createLifecycleCancelIdempotencyKey(REQUEST_ID, () => '66666666-7777-4888-8999-000000000000')
    expect(buildLifecycleCancelBody(cancelDraft, cancelKey)?.idempotencyKey).toBe(cancelKey)
    expect(buildLifecycleCancelBody(cancelDraft, cancelKey)?.idempotencyKey).toBe(cancelKey)
  })

  it.each([401, 403, 404, 409, 410, 422, 500])('maps HTTP %s without claiming success', status => {
    expect(lifecycleListError(status).kind).not.toBe('success')
    expect(lifecycleDetailError(status).kind).not.toBe('success')
    expect(lifecycleDecisionSubmitError(status).kind).not.toBe('success')
    expect(lifecycleCancelSubmitError(status).kind).not.toBe('success')
  })

  it('performs exactly one fetch on HTTP and network failure', async () => {
    const httpFetcher = vi.fn(async () => Response.json({ error: 'conflict' }, { status: 409 })) as unknown as typeof fetch
    const response = await requestLifecycleJson('/api/admin/semantic-topic-lifecycle-reviews/id/decision', { method: 'POST' }, httpFetcher)
    expect(response.status).toBe(409)
    expect(httpFetcher).toHaveBeenCalledTimes(1)

    const networkFetcher = vi.fn(async () => { throw new TypeError('offline') }) as unknown as typeof fetch
    await expect(requestLifecycleJson('/api/admin/semantic-topic-lifecycle-reviews', { method: 'GET' }, networkFetcher)).rejects.toThrow('offline')
    expect(networkFetcher).toHaveBeenCalledTimes(1)
  })
})

describe('Lifecycle Reviewer Milestone 4B interaction and visual closure', () => {
  const decision = readFileSync(join(process.cwd(), 'components', 'semantic-topic-lifecycle-reviews', 'LifecycleReviewDecisionPanel.tsx'), 'utf8')
  const cancel = readFileSync(join(process.cwd(), 'components', 'semantic-topic-lifecycle-reviews', 'LifecycleReviewCancelPanel.tsx'), 'utf8')
  const detailSource = readFileSync(join(process.cwd(), 'components', 'semantic-topic-lifecycle-reviews', 'LifecycleReviewDetail.tsx'), 'utf8')
  const css = readFileSync(join(process.cwd(), 'app', 'dashboard', 'creator-os.css'), 'utf8')

  it('blocks parallel mutation submission and triggers verified server rereads', () => {
    for (const source of [decision, cancel]) {
      expect(source).toContain('if (submittingRef.current) return')
      expect(source).toContain('submittingRef.current = true')
      expect(source).not.toMatch(/setTimeout|setInterval/)
    }
    expect(detailSource).toMatch(/const handleDecided[\s\S]*refresh\(\)/)
    expect(detailSource).toMatch(/const handleCancelled[\s\S]*refresh\(\)/)
  })

  it('keeps both final modals keyboard-contained and restores focus', () => {
    for (const source of [decision, cancel]) {
      expect(source).toContain('aria-modal="true"')
      expect(source).toContain("event.key === 'Escape'")
      expect(source).toContain("event.key !== 'Tab'")
      expect(source).toContain('reviewButtonRef.current?.focus()')
      expect(source).toContain("document.body.style.overflow = 'hidden'")
    }
  })

  it('retains the shared premium responsive system, focus states and reduced motion', () => {
    expect(css).toContain('@media (max-width: 720px)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('.wv-lifecycle-decision-overlay')
    expect(css).toContain('.wv-lifecycle-cancel-overlay')
    expect(css).toContain('.wv-lifecycle-stale-alert')
  })
})
