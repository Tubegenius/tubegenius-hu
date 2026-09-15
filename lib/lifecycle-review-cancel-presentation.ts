import {
  LIFECYCLE_CANCEL_REASON_CODES,
  LIFECYCLE_IDEMPOTENCY_KEY_MAX_LENGTH,
  LIFECYCLE_RATIONALE_MAX_LENGTH,
  type LifecycleCancelActionResult,
  type LifecycleCancelReasonCode,
  type LifecycleCancelRequestBody,
  type LifecycleRequestStatus,
} from '@/lib/semantic-topic/lifecycle-review-types'

export interface LifecycleCancelDraft {
  cancelReasonCode: LifecycleCancelReasonCode | null
  cancelRationale: string
}

export interface LifecycleCancelValidation {
  valid: boolean
  fieldErrors: Partial<Record<keyof LifecycleCancelDraft, string>>
}

export function isLifecycleRequestCancellable(status: LifecycleRequestStatus): boolean {
  return status === 'requested' || status === 'approved'
}

export function createLifecycleCancelDraft(): LifecycleCancelDraft {
  return { cancelReasonCode: null, cancelRationale: '' }
}

export function validateLifecycleCancel(draft: LifecycleCancelDraft): LifecycleCancelValidation {
  const fieldErrors: LifecycleCancelValidation['fieldErrors'] = {}
  if (!draft.cancelReasonCode) fieldErrors.cancelReasonCode = 'Válassz zárt visszavonási indokot.'
  else if (!LIFECYCLE_CANCEL_REASON_CODES.includes(draft.cancelReasonCode)) {
    fieldErrors.cancelReasonCode = 'A kiválasztott visszavonási indok nem engedélyezett.'
  }

  const rationaleLength = draft.cancelRationale.trim().length
  if (rationaleLength === 0) fieldErrors.cancelRationale = 'A szakmai indoklás kötelező.'
  else if (rationaleLength > LIFECYCLE_RATIONALE_MAX_LENGTH) {
    fieldErrors.cancelRationale = `Az indoklás legfeljebb ${LIFECYCLE_RATIONALE_MAX_LENGTH} karakter lehet.`
  }
  return { valid: Object.keys(fieldErrors).length === 0, fieldErrors }
}

export function buildLifecycleCancelBody(
  draft: LifecycleCancelDraft,
  idempotencyKey: string,
): LifecycleCancelRequestBody | null {
  const validation = validateLifecycleCancel(draft)
  if (!validation.valid || !draft.cancelReasonCode) return null
  if (!idempotencyKey || idempotencyKey.length > LIFECYCLE_IDEMPOTENCY_KEY_MAX_LENGTH) return null
  return {
    cancelReasonCode: draft.cancelReasonCode,
    cancelRationale: draft.cancelRationale.trim(),
    idempotencyKey,
  }
}

export function createLifecycleCancelIdempotencyKey(
  reviewRequestId: string,
  randomUuid: () => string = () => crypto.randomUUID(),
): string {
  return `wv-lifecycle-cancel:${reviewRequestId}:${randomUuid()}`
}

export function buildLifecycleCancelUrl(reviewRequestId: string): string {
  return `/api/admin/semantic-topic-lifecycle-reviews/${encodeURIComponent(reviewRequestId)}/cancel`
}

export function parseLifecycleCancelResponse(payload: unknown): LifecycleCancelActionResult | null {
  if (!payload || typeof payload !== 'object') return null
  const result = (payload as { result?: unknown }).result
  if (!result || typeof result !== 'object') return null
  const candidate = result as Record<string, unknown>
  if (
    !['cancelled', 'replayed'].includes(String(candidate.outcomeKind))
    || typeof candidate.reviewRequestId !== 'string'
    || typeof candidate.status !== 'string'
  ) return null
  return candidate as unknown as LifecycleCancelActionResult
}

export type LifecycleCancelSubmitError = {
  kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'expired' | 'invalid' | 'server' | 'network'
  message: string
}

export function lifecycleCancelSubmitError(status: number, serverMessage?: string): LifecycleCancelSubmitError {
  if (status === 401) return { kind: 'unauthenticated', message: 'A munkamenet lejárt. A kérelem nem került visszavonásra.' }
  if (status === 403) return { kind: 'forbidden', message: 'Nincs aktív felülvizsgálói jogosultságod. A kérelem nem került visszavonásra.' }
  if (status === 404) return { kind: 'not_found', message: 'A kérelem már nem található. Frissítsd a részletnézetet.' }
  if (status === 409) return { kind: 'conflict', message: 'A kérelem állapota időközben megváltozott, ezért nem vonható vissza. Frissítsd a részletnézetet.' }
  if (status === 410) return { kind: 'expired', message: 'A kérelem lejárt, ezért nem vonható vissza.' }
  if (status === 422) return { kind: 'invalid', message: serverMessage || 'A szerver elutasította a visszavonás adatait.' }
  return { kind: 'server', message: 'A kérelem nem került visszavonásra. Automatikus újrapróbálás nem indult.' }
}
