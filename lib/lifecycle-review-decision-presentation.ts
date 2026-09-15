import {
  LIFECYCLE_IDEMPOTENCY_KEY_MAX_LENGTH,
  LIFECYCLE_RATIONALE_MAX_LENGTH,
  LIFECYCLE_REVIEW_POLICY_VERSION,
  type LifecycleDecisionActionResult,
  type LifecycleDecisionRequestBody,
  type LifecycleReasonCode,
  type LifecycleTargetStatus,
} from '@/lib/semantic-topic/lifecycle-review-types'

export type LifecycleDecisionOutcome = LifecycleDecisionRequestBody['outcome']
export type LifecycleChecklistKey =
  | 'sameSemanticIdentityConfirmed'
  | 'noMaterialIdentityConflict'
  | 'canonicalDefinitionScopeFitConfirmed'
  | 'provenanceRelationshipReviewed'

export interface LifecycleDecisionDraft {
  outcome: LifecycleDecisionOutcome | null
  reasonCode: LifecycleReasonCode | null
  reviewerRationale: string
  sameSemanticIdentityConfirmed: boolean | null
  noMaterialIdentityConflict: boolean | null
  canonicalDefinitionScopeFitConfirmed: boolean | null
  provenanceRelationshipReviewed: boolean | null
}

export interface LifecycleDecisionValidation {
  valid: boolean
  fieldErrors: Partial<Record<'outcome' | 'reasonCode' | 'reviewerRationale' | LifecycleChecklistKey, string>>
  formError: string | null
}

export const LIFECYCLE_CHECKLIST: readonly {
  key: LifecycleChecklistKey
  label: string
  description: string
}[] = [
  {
    key: 'sameSemanticIdentityConfirmed',
    label: 'Azonos szemantikai identitás',
    description: 'A bizonyítékok ugyanahhoz a valós témamaghoz tartoznak.',
  },
  {
    key: 'noMaterialIdentityConflict',
    label: 'Nincs lényegi identitáskonfliktus',
    description: 'Nem maradt olyan ellentmondás, amely megváltoztatná a téma azonosságát.',
  },
  {
    key: 'canonicalDefinitionScopeFitConfirmed',
    label: 'A definíció és a hatókör illeszkedik',
    description: 'A kanonikus leírás megfelelően fedi le a bizonyítékok közös jelentését.',
  },
  {
    key: 'provenanceRelationshipReviewed',
    label: 'A származási kapcsolat ellenőrizve',
    description: 'A források közötti eredeti, másodlagos és szindikációs kapcsolat áttekintett.',
  },
]

const APPROVAL_REASONS: Record<LifecycleTargetStatus, readonly LifecycleReasonCode[]> = {
  coherent: ['identity_consistency_confirmed'],
  ambiguous: ['conflicting_identity_signal', 'insufficient_context_for_confirmation'],
  corroborating: ['suspicion_unfounded'],
}

const REJECTION_REASONS: readonly LifecycleReasonCode[] = [
  'insufficient_evidence',
  'invalid_identity_claim',
  'not_ready_for_decision',
  'other_lifecycle_rejection',
]

export function createLifecycleDecisionDraft(): LifecycleDecisionDraft {
  return {
    outcome: null,
    reasonCode: null,
    reviewerRationale: '',
    sameSemanticIdentityConfirmed: null,
    noMaterialIdentityConflict: null,
    canonicalDefinitionScopeFitConfirmed: null,
    provenanceRelationshipReviewed: null,
  }
}

export function lifecycleDecisionReasonCodes(
  outcome: LifecycleDecisionOutcome | null,
  targetStatus: LifecycleTargetStatus,
): readonly LifecycleReasonCode[] {
  if (outcome === 'approved') return APPROVAL_REASONS[targetStatus]
  if (outcome === 'rejected') return REJECTION_REASONS
  return []
}

export function validateLifecycleDecision(
  draft: LifecycleDecisionDraft,
  targetStatus: LifecycleTargetStatus,
  requestPolicyVersion: number,
): LifecycleDecisionValidation {
  const fieldErrors: LifecycleDecisionValidation['fieldErrors'] = {}
  let formError: string | null = null

  if (requestPolicyVersion !== LIFECYCLE_REVIEW_POLICY_VERSION) {
    formError = `A kérelem v${requestPolicyVersion} szabályzata nem kompatibilis a kliens által támogatott v${LIFECYCLE_REVIEW_POLICY_VERSION} verzióval.`
  }
  if (!draft.outcome) fieldErrors.outcome = 'Válaszd ki, hogy jóváhagyod vagy elutasítod a kérelmet.'

  const allowedReasons = lifecycleDecisionReasonCodes(draft.outcome, targetStatus)
  if (!draft.reasonCode) fieldErrors.reasonCode = 'Válassz zárt döntési indokot.'
  else if (!allowedReasons.includes(draft.reasonCode)) fieldErrors.reasonCode = 'A kiválasztott indok ehhez a döntéshez nem használható.'

  const rationaleLength = draft.reviewerRationale.trim().length
  if (rationaleLength === 0) fieldErrors.reviewerRationale = 'A szakmai indoklás kötelező.'
  else if (rationaleLength > LIFECYCLE_RATIONALE_MAX_LENGTH) {
    fieldErrors.reviewerRationale = `Az indoklás legfeljebb ${LIFECYCLE_RATIONALE_MAX_LENGTH} karakter lehet.`
  }

  if (draft.outcome === 'approved' && targetStatus === 'coherent') {
    for (const item of LIFECYCLE_CHECKLIST) {
      if (draft[item.key] !== true) fieldErrors[item.key] = 'Koherens jóváhagyáshoz ezt kifejezetten meg kell erősíteni.'
    }
  }

  return { valid: !formError && Object.keys(fieldErrors).length === 0, fieldErrors, formError }
}

export function buildLifecycleDecisionBody(
  draft: LifecycleDecisionDraft,
  targetStatus: LifecycleTargetStatus,
  requestPolicyVersion: number,
  idempotencyKey: string,
): LifecycleDecisionRequestBody | null {
  const validation = validateLifecycleDecision(draft, targetStatus, requestPolicyVersion)
  if (!validation.valid || !draft.outcome || !draft.reasonCode) return null
  if (!idempotencyKey || idempotencyKey.length > LIFECYCLE_IDEMPOTENCY_KEY_MAX_LENGTH) return null
  return {
    outcome: draft.outcome,
    reasonCode: draft.reasonCode,
    reviewerRationale: draft.reviewerRationale.trim(),
    sameSemanticIdentityConfirmed: draft.sameSemanticIdentityConfirmed,
    noMaterialIdentityConflict: draft.noMaterialIdentityConflict,
    canonicalDefinitionScopeFitConfirmed: draft.canonicalDefinitionScopeFitConfirmed,
    provenanceRelationshipReviewed: draft.provenanceRelationshipReviewed,
    reviewPolicyVersion: LIFECYCLE_REVIEW_POLICY_VERSION,
    idempotencyKey,
  }
}

export function createLifecycleDecisionIdempotencyKey(
  reviewRequestId: string,
  randomUuid: () => string = () => crypto.randomUUID(),
): string {
  return `wv-lifecycle-decision:${reviewRequestId}:${randomUuid()}`
}

export function buildLifecycleDecisionUrl(reviewRequestId: string): string {
  return `/api/admin/semantic-topic-lifecycle-reviews/${encodeURIComponent(reviewRequestId)}/decision`
}

export function parseLifecycleDecisionResponse(payload: unknown): LifecycleDecisionActionResult | null {
  if (!payload || typeof payload !== 'object') return null
  const result = (payload as { result?: unknown }).result
  if (!result || typeof result !== 'object') return null
  const candidate = result as Record<string, unknown>
  if (
    !['approved', 'rejected', 'replayed'].includes(String(candidate.outcomeKind))
    || typeof candidate.reviewRequestId !== 'string'
    || typeof candidate.status !== 'string'
  ) return null
  return candidate as unknown as LifecycleDecisionActionResult
}

export type LifecycleDecisionSubmitError = {
  kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'expired' | 'invalid' | 'server' | 'network'
  message: string
}

export function lifecycleDecisionSubmitError(status: number, serverMessage?: string): LifecycleDecisionSubmitError {
  if (status === 401) return { kind: 'unauthenticated', message: 'A munkamenet lejárt. A döntés nem került rögzítésre.' }
  if (status === 403) return { kind: 'forbidden', message: 'Nincs aktív felülvizsgálói jogosultságod. A döntés nem került rögzítésre.' }
  if (status === 404) return { kind: 'not_found', message: 'A kérelem már nem található. Frissítsd a részletnézetet.' }
  if (status === 409) return { kind: 'conflict', message: 'A kérelem állapota időközben megváltozott. Frissítsd a részletnézetet, majd értékeld újra.' }
  if (status === 410) return { kind: 'expired', message: 'A kérelem lejárt, ezért a döntés nem rögzíthető.' }
  if (status === 422) return { kind: 'invalid', message: serverMessage || 'A szerver elutasította a döntés adatait.' }
  return { kind: 'server', message: 'A döntés nem került rögzítésre. Automatikus újrapróbálás nem indult.' }
}
