import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LIFECYCLE_REVIEW_POLICY_VERSION,
  type LifecycleDecisionRequestBody,
} from '@/lib/semantic-topic/lifecycle-review-types'
import {
  LIFECYCLE_CHECKLIST,
  buildLifecycleDecisionBody,
  buildLifecycleDecisionUrl,
  createLifecycleDecisionDraft,
  createLifecycleDecisionIdempotencyKey,
  lifecycleDecisionReasonCodes,
  lifecycleDecisionSubmitError,
  parseLifecycleDecisionResponse,
  validateLifecycleDecision,
  type LifecycleDecisionDraft,
} from '@/lib/lifecycle-review-decision-presentation'

function coherentApproval(overrides: Partial<LifecycleDecisionDraft> = {}): LifecycleDecisionDraft {
  return {
    outcome: 'approved',
    reasonCode: 'identity_consistency_confirmed',
    reviewerRationale: 'A forrásazonosságok és a kanonikus definíció konzisztens.',
    sameSemanticIdentityConfirmed: true,
    noMaterialIdentityConflict: true,
    canonicalDefinitionScopeFitConfirmed: true,
    provenanceRelationshipReviewed: true,
    ...overrides,
  }
}

describe('Lifecycle Reviewer frontend Milestone 3 decision contract', () => {
  it('derives the closed reason set from outcome and immutable target status', () => {
    expect(lifecycleDecisionReasonCodes('approved', 'coherent')).toEqual(['identity_consistency_confirmed'])
    expect(lifecycleDecisionReasonCodes('approved', 'ambiguous')).toEqual([
      'conflicting_identity_signal',
      'insufficient_context_for_confirmation',
    ])
    expect(lifecycleDecisionReasonCodes('approved', 'corroborating')).toEqual(['suspicion_unfounded'])
    expect(lifecycleDecisionReasonCodes('rejected', 'coherent')).toEqual([
      'insufficient_evidence',
      'invalid_identity_claim',
      'not_ready_for_decision',
      'other_lifecycle_rejection',
    ])
  })

  it('requires all four structured confirmations for coherent approval', () => {
    const valid = validateLifecycleDecision(coherentApproval(), 'coherent', LIFECYCLE_REVIEW_POLICY_VERSION)
    expect(valid).toEqual({ valid: true, fieldErrors: {}, formError: null })

    for (const item of LIFECYCLE_CHECKLIST) {
      const invalid = validateLifecycleDecision(coherentApproval({ [item.key]: null }), 'coherent', LIFECYCLE_REVIEW_POLICY_VERSION)
      expect(invalid.valid).toBe(false)
      expect(invalid.fieldErrors[item.key]).toContain('kifejezetten meg kell erősíteni')
    }
  })

  it('strictly validates outcome, reason, rationale and policy compatibility', () => {
    const empty = validateLifecycleDecision(createLifecycleDecisionDraft(), 'coherent', LIFECYCLE_REVIEW_POLICY_VERSION)
    expect(empty.valid).toBe(false)
    expect(empty.fieldErrors.outcome).toBeTruthy()
    expect(empty.fieldErrors.reasonCode).toBeTruthy()
    expect(empty.fieldErrors.reviewerRationale).toBeTruthy()

    const wrongReason = validateLifecycleDecision(coherentApproval({ reasonCode: 'insufficient_evidence' }), 'coherent', LIFECYCLE_REVIEW_POLICY_VERSION)
    expect(wrongReason.fieldErrors.reasonCode).toBeTruthy()

    const tooLong = validateLifecycleDecision(coherentApproval({ reviewerRationale: 'a'.repeat(1001) }), 'coherent', LIFECYCLE_REVIEW_POLICY_VERSION)
    expect(tooLong.fieldErrors.reviewerRationale).toContain('1000')

    const policyMismatch = validateLifecycleDecision(coherentApproval(), 'coherent', LIFECYCLE_REVIEW_POLICY_VERSION + 1)
    expect(policyMismatch.valid).toBe(false)
    expect(policyMismatch.formError).toContain('nem kompatibilis')
  })

  it('builds the exact backend-owned request body and trims rationale', () => {
    const body = buildLifecycleDecisionBody(
      coherentApproval({ reviewerRationale: '  Ellenőrzött szakmai indoklás.  ' }),
      'coherent',
      LIFECYCLE_REVIEW_POLICY_VERSION,
      'stable-attempt-key',
    )
    expect(body).toEqual<LifecycleDecisionRequestBody>({
      outcome: 'approved',
      reasonCode: 'identity_consistency_confirmed',
      reviewerRationale: 'Ellenőrzött szakmai indoklás.',
      sameSemanticIdentityConfirmed: true,
      noMaterialIdentityConflict: true,
      canonicalDefinitionScopeFitConfirmed: true,
      provenanceRelationshipReviewed: true,
      reviewPolicyVersion: LIFECYCLE_REVIEW_POLICY_VERSION,
      idempotencyKey: 'stable-attempt-key',
    })
    expect(buildLifecycleDecisionBody(coherentApproval(), 'coherent', LIFECYCLE_REVIEW_POLICY_VERSION, '')).toBeNull()
  })

  it('creates a bounded, deterministic attempt key when UUID generation is injected', () => {
    const key = createLifecycleDecisionIdempotencyKey('7dcddc8d-ab57-42b2-99ce-ec996858520d', () => '11111111-2222-4333-8444-555555555555')
    expect(key).toBe('wv-lifecycle-decision:7dcddc8d-ab57-42b2-99ce-ec996858520d:11111111-2222-4333-8444-555555555555')
    expect(key.length).toBeLessThanOrEqual(200)
  })

  it('builds the same-origin decision endpoint and validates success envelopes', () => {
    expect(buildLifecycleDecisionUrl('request/id')).toBe('/api/admin/semantic-topic-lifecycle-reviews/request%2Fid/decision')
    expect(parseLifecycleDecisionResponse({ result: { outcomeKind: 'approved', reviewRequestId: 'id', status: 'approved' } })).toEqual({
      outcomeKind: 'approved', reviewRequestId: 'id', status: 'approved',
    })
    expect(parseLifecycleDecisionResponse({ result: { outcomeKind: 'unknown', reviewRequestId: 'id', status: 'approved' } })).toBeNull()
    expect(parseLifecycleDecisionResponse({ data: {} })).toBeNull()
  })

  it('maps every action response class without claiming a write succeeded', () => {
    expect(lifecycleDecisionSubmitError(401).kind).toBe('unauthenticated')
    expect(lifecycleDecisionSubmitError(403).kind).toBe('forbidden')
    expect(lifecycleDecisionSubmitError(404).kind).toBe('not_found')
    expect(lifecycleDecisionSubmitError(409).kind).toBe('conflict')
    expect(lifecycleDecisionSubmitError(410).kind).toBe('expired')
    expect(lifecycleDecisionSubmitError(422, 'closed error')).toEqual({ kind: 'invalid', message: 'closed error' })
    expect(lifecycleDecisionSubmitError(500).message).toContain('nem került rögzítésre')
  })
})

describe('Lifecycle Reviewer frontend Milestone 3 submission safety', () => {
  const component = readFileSync(
    join(process.cwd(), 'components', 'semantic-topic-lifecycle-reviews', 'LifecycleReviewDecisionPanel.tsx'),
    'utf8',
  )
  const detail = readFileSync(
    join(process.cwd(), 'components', 'semantic-topic-lifecycle-reviews', 'LifecycleReviewDetail.tsx'),
    'utf8',
  )
  const css = readFileSync(join(process.cwd(), 'app', 'dashboard', 'creator-os.css'), 'utf8')

  it('posts JSON to the existing same-origin route without setting Origin', () => {
    expect(component).toContain("method: 'POST'")
    expect(component).toContain("'Content-Type': 'application/json'")
    expect(component).toContain("credentials: 'same-origin'")
    expect(component).not.toMatch(/['"]Origin['"]\s*:/)
    expect(component.match(/await fetch\(/g)).toHaveLength(1)
  })

  it('blocks parallel submission and retains one idempotency key across manual retry', () => {
    expect(component).toContain('if (submittingRef.current) return')
    expect(component).toContain('submittingRef.current = true')
    expect(component).toContain('disabled={submitting}')
    expect(component).toContain('if (!attemptKeyRef.current)')
    expect(component).toContain('const idempotencyKey = attemptKeyRef.current')
    expect(component).not.toMatch(/setTimeout|setInterval/)
  })

  it('requires a final accessible confirmation step and never injects HTML', () => {
    expect(component).toContain('role="dialog"')
    expect(component).toContain('aria-modal="true"')
    expect(component).toContain("event.key === 'Escape'")
    expect(component).toContain("event.key !== 'Tab'")
    expect(component).toContain("document.body.style.overflow = 'hidden'")
    expect(component).toContain('reviewButtonRef.current?.focus()')
    expect(component).toContain('Döntés véglegesítése')
    expect(component).not.toContain('dangerouslySetInnerHTML')
  })

  it('only exposes the decision UI for actionable requested records', () => {
    expect(detail).toContain("request.requestStatus === 'requested'")
    expect(component).not.toMatch(/\/cancel/)
  })

  it('declares responsive, focus and reduced-motion treatment', () => {
    expect(css).toContain('.wv-lifecycle-outcome-options input:focus-visible + span')
    expect(css).toContain('.wv-lifecycle-decision-overlay')
    expect(css).toContain('@media (max-width: 720px)')
    expect(css).toContain('.wv-lifecycle-decision-dialog .is-spinning { animation: none; }')
  })
})
