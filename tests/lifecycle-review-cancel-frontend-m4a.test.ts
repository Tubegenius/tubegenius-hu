import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LifecycleCancelRequestBody, LifecycleRequestStatus } from '@/lib/semantic-topic/lifecycle-review-types'
import {
  buildLifecycleCancelBody,
  buildLifecycleCancelUrl,
  createLifecycleCancelDraft,
  createLifecycleCancelIdempotencyKey,
  isLifecycleRequestCancellable,
  lifecycleCancelSubmitError,
  parseLifecycleCancelResponse,
  validateLifecycleCancel,
  type LifecycleCancelDraft,
} from '@/lib/lifecycle-review-cancel-presentation'

function validDraft(overrides: Partial<LifecycleCancelDraft> = {}): LifecycleCancelDraft {
  return {
    cancelReasonCode: 'NEW_EVIDENCE_REQUIRES_NEW_REVIEW',
    cancelRationale: 'Új bizonyítéki kör érkezett, ezért friss request szükséges.',
    ...overrides,
  }
}

describe('Lifecycle Reviewer frontend Milestone 4A cancel contract', () => {
  it('exposes cancel only for the two backend-authorized request states', () => {
    const statuses: LifecycleRequestStatus[] = ['requested', 'approved', 'rejected', 'expired', 'cancelled', 'executed', 'stale']
    expect(statuses.filter(isLifecycleRequestCancellable)).toEqual(['requested', 'approved'])
  })

  it('strictly validates the closed reason and rationale bounds', () => {
    expect(validateLifecycleCancel(createLifecycleCancelDraft())).toEqual({
      valid: false,
      fieldErrors: {
        cancelReasonCode: 'Válassz zárt visszavonási indokot.',
        cancelRationale: 'A szakmai indoklás kötelező.',
      },
    })
    expect(validateLifecycleCancel(validDraft()).valid).toBe(true)
    expect(validateLifecycleCancel(validDraft({ cancelReasonCode: 'invented' as never })).fieldErrors.cancelReasonCode).toBeTruthy()
    expect(validateLifecycleCancel(validDraft({ cancelRationale: 'a'.repeat(1001) })).fieldErrors.cancelRationale).toContain('1000')
  })

  it('builds exactly the three-field backend request body and trims rationale', () => {
    const body = buildLifecycleCancelBody(validDraft({ cancelRationale: '  Ellenőrzött indoklás.  ' }), 'stable-cancel-key')
    expect(body).toEqual<LifecycleCancelRequestBody>({
      cancelReasonCode: 'NEW_EVIDENCE_REQUIRES_NEW_REVIEW',
      cancelRationale: 'Ellenőrzött indoklás.',
      idempotencyKey: 'stable-cancel-key',
    })
    expect(buildLifecycleCancelBody(validDraft(), '')).toBeNull()
  })

  it('creates a stable bounded key for one injected submission attempt', () => {
    const key = createLifecycleCancelIdempotencyKey('7dcddc8d-ab57-42b2-99ce-ec996858520d', () => '11111111-2222-4333-8444-555555555555')
    expect(key).toBe('wv-lifecycle-cancel:7dcddc8d-ab57-42b2-99ce-ec996858520d:11111111-2222-4333-8444-555555555555')
    expect(key.length).toBeLessThanOrEqual(200)
  })

  it('uses the existing encoded cancel endpoint and validates success envelopes', () => {
    expect(buildLifecycleCancelUrl('request/id')).toBe('/api/admin/semantic-topic-lifecycle-reviews/request%2Fid/cancel')
    expect(parseLifecycleCancelResponse({ result: { outcomeKind: 'cancelled', reviewRequestId: 'id', status: 'cancelled' } })).toEqual({
      outcomeKind: 'cancelled', reviewRequestId: 'id', status: 'cancelled',
    })
    expect(parseLifecycleCancelResponse({ result: { outcomeKind: 'approved', reviewRequestId: 'id', status: 'cancelled' } })).toBeNull()
    expect(parseLifecycleCancelResponse({ data: {} })).toBeNull()
  })

  it('maps every required HTTP and network-adjacent error class conservatively', () => {
    expect(lifecycleCancelSubmitError(401).kind).toBe('unauthenticated')
    expect(lifecycleCancelSubmitError(403).kind).toBe('forbidden')
    expect(lifecycleCancelSubmitError(404).kind).toBe('not_found')
    expect(lifecycleCancelSubmitError(409).kind).toBe('conflict')
    expect(lifecycleCancelSubmitError(410).kind).toBe('expired')
    expect(lifecycleCancelSubmitError(422, 'closed error')).toEqual({ kind: 'invalid', message: 'closed error' })
    expect(lifecycleCancelSubmitError(500).message).toContain('nem került visszavonásra')
  })
})

describe('Lifecycle Reviewer frontend Milestone 4A interaction safety', () => {
  const component = readFileSync(
    join(process.cwd(), 'components', 'semantic-topic-lifecycle-reviews', 'LifecycleReviewCancelPanel.tsx'),
    'utf8',
  )
  const detail = readFileSync(
    join(process.cwd(), 'components', 'semantic-topic-lifecycle-reviews', 'LifecycleReviewDetail.tsx'),
    'utf8',
  )
  const css = readFileSync(join(process.cwd(), 'app', 'dashboard', 'creator-os.css'), 'utf8')

  it('posts JSON only to the existing same-origin cancel endpoint', () => {
    expect(component).toContain("method: 'POST'")
    expect(component).toContain("'Content-Type': 'application/json'")
    expect(component).toContain("credentials: 'same-origin'")
    expect(component).not.toMatch(/['"]Origin['"]\s*:/)
    expect(component.match(/await fetch\(/g)).toHaveLength(1)
    expect(component).not.toMatch(/\/decision/)
  })

  it('blocks parallel submission and preserves the attempt key for manual retry', () => {
    expect(component).toContain('if (submittingRef.current) return')
    expect(component).toContain('submittingRef.current = true')
    expect(component).toContain('if (!attemptKeyRef.current)')
    expect(component).toContain('const idempotencyKey = attemptKeyRef.current')
    expect(component).not.toMatch(/setTimeout|setInterval/)
  })

  it('does not optimistically mutate status and refreshes detail after verified server success', () => {
    expect(component).toContain('parsed.reviewRequestId !== request.reviewRequestId')
    expect(component).toContain('onCancelled(parsed)')
    expect(component).not.toMatch(/setRequest|requestStatus\s*=(?!=)/)
    expect(detail).toContain('const handleCancelled')
    expect(detail).toMatch(/setActionNotice[\s\S]*refresh\(\)/)
  })

  it('uses an accessible final modal with focus trap, return focus and scroll lock', () => {
    expect(component).toContain('role="dialog"')
    expect(component).toContain('aria-modal="true"')
    expect(component).toContain("event.key === 'Escape'")
    expect(component).toContain("event.key !== 'Tab'")
    expect(component).toContain("document.body.style.overflow = 'hidden'")
    expect(component).toContain('reviewButtonRef.current?.focus()')
    expect(component).not.toContain('dangerouslySetInnerHTML')
  })

  it('declares responsive, visible-focus and reduced-motion treatment', () => {
    expect(css).toContain('.wv-lifecycle-cancel-overlay')
    expect(css).toContain('.wv-lifecycle-cancel-expand[aria-expanded="true"]')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('.wv-lifecycle-cancel-dialog .is-spinning { animation: none; }')
  })
})
