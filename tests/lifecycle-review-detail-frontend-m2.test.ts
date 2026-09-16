import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LifecycleEvidenceVector, LifecycleReviewDetail } from '@/lib/semantic-topic/lifecycle-review-types'
import {
  buildLifecycleReviewDetailUrl,
  compactLifecycleDigest,
  formatLifecycleActor,
  formatLifecycleCancelReason,
  formatLifecycleEvent,
  formatLifecycleReasonCode,
  formatLifecycleStatusLabel,
  lifecycleDetailError,
  parseLifecycleReviewDetailResponse,
} from '@/lib/lifecycle-review-detail-presentation'

function evidence(overrides: Partial<LifecycleEvidenceVector> = {}): LifecycleEvidenceVector {
  return {
    ok: true,
    formulaVersion: 'evidence-v3',
    semanticTopicId: 'a388f707-8991-403a-b5df-33385d81282c',
    lifecycleStatus: 'corroborating',
    activeMembershipCount: 14,
    eligibleMembershipCount: 11,
    syndicationExcludedCount: 2,
    eligibleDistinctSourceIdentityCount: 7,
    unknownSourceCount: 1,
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

function detail(overrides: Partial<LifecycleReviewDetail> = {}): LifecycleReviewDetail {
  return {
    reviewRequestId: '7dcddc8d-ab57-42b2-99ce-ec996858520d',
    generation: 3,
    semanticTopicId: 'a388f707-8991-403a-b5df-33385d81282c',
    topicCanonicalLabel: 'Short-form storytelling systems',
    fromStatus: 'corroborating',
    targetStatus: 'coherent',
    requestStatus: 'approved',
    requestedAt: '2026-09-14T08:30:00.000Z',
    expiresAt: '2026-09-16T08:30:00.000Z',
    decidedAt: '2026-09-14T10:12:00.000Z',
    staleReasonCode: 'EVIDENCE_VECTOR_CHANGED',
    snapshot: {
      evidenceVector: evidence(),
      digest: 'sha256:snapshot-vector-0000000000000001',
      capturedAt: '2026-09-14T08:30:00.000Z',
      fromLifecycleStatus: 'corroborating',
      expectedStatusVersion: 12,
    },
    reviewPolicyVersion: 4,
    decision: {
      reviewerRoleSnapshot: 'semantic_topic_reviewer',
      decidedAt: '2026-09-14T10:12:00.000Z',
      reasonCode: 'identity_consistency_confirmed',
      reviewerRationale: 'A forrásazonosságok és a definíciós határ konzisztens.',
      sameSemanticIdentityConfirmed: true,
      noMaterialIdentityConflict: true,
      canonicalDefinitionScopeFitConfirmed: true,
      provenanceRelationshipReviewed: true,
      decidedByCurrentReviewer: true,
    },
    execution: null,
    cancellation: null,
    transitionHistory: [
      { eventType: 'requested', actorKind: 'service_role_system', createdAt: '2026-09-14T08:30:00.000Z' },
      { eventType: 'approved', actorKind: 'authenticated_reviewer', createdAt: '2026-09-14T10:12:00.000Z' },
    ],
    live: {
      lifecycleStatus: 'corroborating',
      statusVersion: 13,
      evidenceVector: evidence({ eligibleMembershipCount: 12 }),
      vectorDigest: 'sha256:live-vector-00000000000000000002',
      mechanicalRequirementsCurrentlyMet: true,
    },
    stalenessSignals: {
      topicStatusChanged: false,
      topicVersionChanged: true,
      evidenceVectorChanged: true,
      mechanicalRequirementsLost: false,
    },
    isPotentiallyStale: true,
    ...overrides,
  }
}

describe('Lifecycle Reviewer frontend Milestone 2 detail contract', () => {
  it('builds an encoded same-origin detail URL without query mutation', () => {
    expect(buildLifecycleReviewDetailUrl('request/id ?')).toBe('/api/admin/semantic-topic-lifecycle-reviews/request%2Fid%20%3F')
  })

  it('accepts a complete detail envelope with snapshot, live state, decision and audit history', () => {
    const request = detail()
    expect(parseLifecycleReviewDetailResponse({ request })).toEqual(request)
  })

  it('accepts read-only cancellation and execution results', () => {
    const request = detail({
      requestStatus: 'executed',
      decision: null,
      cancellation: {
        cancelledAt: '2026-09-14T11:00:00.000Z',
        cancelReasonCode: 'NEW_EVIDENCE_REQUIRES_NEW_REVIEW',
        cancelRationale: 'Új bizonyítéki kör érkezett.',
        cancelledByCurrentReviewer: false,
      },
      execution: { executedAt: '2026-09-14T12:00:00.000Z' },
    })
    expect(parseLifecycleReviewDetailResponse({ request })).toEqual(request)
  })

  it('rejects malformed closed values and incomplete staleness signals', () => {
    expect(parseLifecycleReviewDetailResponse({ request: { ...detail(), requestStatus: 'unknown' } })).toBeNull()
    expect(parseLifecycleReviewDetailResponse({ request: { ...detail(), decision: { ...detail().decision, reasonCode: 'invented' } } })).toBeNull()
    expect(parseLifecycleReviewDetailResponse({ request: { ...detail(), stalenessSignals: { topicStatusChanged: false } } })).toBeNull()
    expect(parseLifecycleReviewDetailResponse({ data: detail() })).toBeNull()
  })

  it('maps all read response classes without an automatic retry promise', () => {
    expect(lifecycleDetailError(401).kind).toBe('unauthenticated')
    expect(lifecycleDetailError(403).kind).toBe('forbidden')
    expect(lifecycleDetailError(404).kind).toBe('not_found')
    expect(lifecycleDetailError(422, 'invalid uuid')).toEqual({ kind: 'invalid', message: 'invalid uuid' })
    expect(lifecycleDetailError(409).kind).toBe('server')
    expect(lifecycleDetailError(410).kind).toBe('server')
    expect(lifecycleDetailError(500).message).toContain('Automatikus újrapróbálás nem indult')
  })

  it('presents closed codes and diagnostics in readable product language', () => {
    expect(formatLifecycleReasonCode('identity_consistency_confirmed')).toBe('Az azonosság konzisztens')
    expect(formatLifecycleCancelReason('REQUEST_CREATED_IN_ERROR')).toBe('A kérelem tévesen jött létre')
    expect(formatLifecycleEvent('stale')).toBe('Elavulttá vált')
    expect(formatLifecycleActor('authenticated_reviewer')).toBe('Hitelesített felülvizsgáló')
    expect(formatLifecycleStatusLabel('merge_candidate')).toBe('Összevonási jelölt')
    expect(formatLifecycleStatusLabel('future_state')).toBe('future state')
    expect(compactLifecycleDigest('short')).toBe('short')
    expect(compactLifecycleDigest('sha256:abcdefghijklmnopqrstuvwxyz0123456789')).toContain('…')
  })
})

describe('Lifecycle Reviewer frontend Milestone 2 security and interaction boundary', () => {
  const componentSource = readFileSync(
    join(process.cwd(), 'components', 'semantic-topic-lifecycle-reviews', 'LifecycleReviewDetail.tsx'),
    'utf8',
  )
  const clientSource = readFileSync(join(process.cwd(), 'lib', 'lifecycle-review-client.ts'), 'utf8')
  const css = readFileSync(join(process.cwd(), 'app', 'dashboard', 'creator-os.css'), 'utf8')

  it('uses only the existing read endpoint with a same-origin GET request', () => {
    expect(componentSource).toContain("method: 'GET'")
    expect(componentSource).toContain('requestLifecycleJson')
    expect(clientSource).toContain("credentials: 'same-origin'")
    expect(clientSource).toContain("cache: 'no-store'")
    expect(componentSource).not.toMatch(/method:\s*['"]POST['"]/)
    expect(componentSource).not.toMatch(/\/decision|\/cancel/)
    expect(`${componentSource}\n${clientSource}`).not.toMatch(/['"]Origin['"]\s*:/)
  })

  it('has explicit loading, access, not-found and manual retry states', () => {
    expect(componentSource).toContain("'loading'")
    expect(componentSource).toContain("'unauthenticated'")
    expect(componentSource).toContain("'forbidden'")
    expect(componentSource).toContain("'not_found'")
    expect(componentSource).toContain('Újrapróbálás')
    expect(componentSource).toContain('AbortController')
  })

  it('keeps the snapshot immutable in language and exposes the stale warning', () => {
    expect(componentSource).toContain('A snapshot változatlan döntési alap')
    expect(componentSource).toContain('request.isPotentiallyStale')
    expect(componentSource).toContain('diagnosztikai jelzés')
    expect(componentSource).not.toContain('dangerouslySetInnerHTML')
  })

  it('supports visible keyboard focus and reduced motion on the detail view', () => {
    expect(css).toContain('.wv-lifecycle-back-link:focus-visible')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('.wv-lifecycle-detail-skeleton :is(i, strong, span) { animation: none; }')
  })
})
