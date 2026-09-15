import type {
  LifecycleCancelReasonCode,
  LifecycleEvidenceVector,
  LifecycleReasonCode,
  LifecycleReviewDetail,
  LifecycleTransitionAuditEntry,
} from '@/lib/semantic-topic/lifecycle-review-types'

const REASON_LABELS: Record<LifecycleReasonCode, string> = {
  identity_consistency_confirmed: 'Az azonosság konzisztens',
  conflicting_identity_signal: 'Ellentmondó azonossági jel',
  insufficient_context_for_confirmation: 'Nincs elég kontextus a megerősítéshez',
  suspicion_unfounded: 'A gyanú nem igazolódott',
  insufficient_evidence: 'Nem elegendő a bizonyíték',
  invalid_identity_claim: 'Érvénytelen azonossági állítás',
  not_ready_for_decision: 'Még nem áll készen döntésre',
  other_lifecycle_rejection: 'Egyéb lifecycle elutasítás',
}

const CANCEL_REASON_LABELS: Record<LifecycleCancelReasonCode, string> = {
  REVIEW_WITHDRAWN: 'A felülvizsgálat visszavonva',
  NEW_EVIDENCE_REQUIRES_NEW_REVIEW: 'Új bizonyíték miatt új felülvizsgálat szükséges',
  REQUEST_CREATED_IN_ERROR: 'A kérelem tévesen jött létre',
}

const EVENT_LABELS: Record<LifecycleTransitionAuditEntry['eventType'], string> = {
  requested: 'Felülvizsgálat kérve',
  approved: 'Jóváhagyva',
  rejected: 'Elutasítva',
  expired: 'Lejárt',
  cancelled: 'Visszavonva',
  executed: 'Végrehajtva',
  stale: 'Elavulttá vált',
}

const ACTOR_LABELS: Record<LifecycleTransitionAuditEntry['actorKind'], string> = {
  service_role_system: 'WillViral rendszer',
  authenticated_reviewer: 'Hitelesített felülvizsgáló',
}

const LIFECYCLE_STATE_LABELS: Record<string, string> = {
  coherent: 'Koherens',
  ambiguous: 'Nem egyértelmű',
  corroborating: 'Megerősítés alatt',
  candidate_singleton: 'Önálló témajelölt',
  split_required: 'Szétválasztás szükséges',
  merge_candidate: 'Összevonási jelölt',
  superseded: 'Leváltott',
  archived: 'Archivált',
}

const REQUEST_STATUSES = new Set(['requested', 'approved', 'rejected', 'expired', 'cancelled', 'executed', 'stale'])
const FROM_STATUSES = new Set(['corroborating', 'ambiguous'])
const TARGET_STATUSES = new Set(['coherent', 'ambiguous', 'corroborating'])
const EVENT_TYPES = new Set(Object.keys(EVENT_LABELS))
const ACTOR_KINDS = new Set(Object.keys(ACTOR_LABELS))

export function buildLifecycleReviewDetailUrl(reviewRequestId: string): string {
  return `/api/admin/semantic-topic-lifecycle-reviews/${encodeURIComponent(reviewRequestId)}`
}

export function formatLifecycleReasonCode(reason: LifecycleReasonCode): string {
  return REASON_LABELS[reason]
}

export function formatLifecycleCancelReason(reason: LifecycleCancelReasonCode): string {
  return CANCEL_REASON_LABELS[reason]
}

export function formatLifecycleEvent(event: LifecycleTransitionAuditEntry['eventType']): string {
  return EVENT_LABELS[event]
}

export function formatLifecycleActor(actor: LifecycleTransitionAuditEntry['actorKind']): string {
  return ACTOR_LABELS[actor]
}

export function formatLifecycleStatusLabel(status: string): string {
  return LIFECYCLE_STATE_LABELS[status] ?? status.replaceAll('_', ' ')
}

export function compactLifecycleDigest(value: string): string {
  if (value.length <= 28) return value
  return `${value.slice(0, 16)}…${value.slice(-10)}`
}

export function parseLifecycleReviewDetailResponse(payload: unknown): LifecycleReviewDetail | null {
  if (!isObject(payload) || !isLifecycleReviewDetail(payload.request)) return null
  return payload.request
}

export type LifecycleDetailError =
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'server'; message: string }

export function lifecycleDetailError(status: number, serverMessage?: string): LifecycleDetailError {
  if (status === 401) return { kind: 'unauthenticated', message: 'A munkamenet lejárt. Jelentkezz be újra a kérelem megnyitásához.' }
  if (status === 403) return { kind: 'forbidden', message: 'Ehhez a felülvizsgálati kérelemhez nincs aktív jogosultságod.' }
  if (status === 404) return { kind: 'not_found', message: 'Ez az életciklus-kérelem nem található, vagy már nem hozzáférhető.' }
  if (status === 422) return { kind: 'invalid', message: serverMessage || 'Az életciklus-kérelem azonosítója nem érvényes.' }
  return { kind: 'server', message: 'Az életciklus-kérelem most nem tölthető be. Automatikus újrapróbálás nem indult.' }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function isEvidenceVector(value: unknown): value is LifecycleEvidenceVector {
  if (!isObject(value) || !isObject(value.confidenceDiagnostics)) return false
  const numericFields = [
    'activeMembershipCount',
    'eligibleMembershipCount',
    'syndicationExcludedCount',
    'eligibleDistinctSourceIdentityCount',
    'unknownSourceCount',
    'manualReviewConfirmedSourceCount',
    'manualReviewOverrideSourceCount',
    'automatedAssignmentSourceCount',
    'topicCreationSeedSourceCount',
    'unclassifiedAssignmentReasonEligibleMembershipCount',
  ]
  const booleanFields = [
    'ok',
    'assignmentReasonBreakdownComplete',
    'mixedAlgorithmVersions',
    'evidenceIdentityComplete',
    'sourceIdentityKnown',
  ]
  const stringFields = ['formulaVersion', 'semanticTopicId', 'lifecycleStatus', 'inputIntegrityStatus']
  const diagnostics = value.confidenceDiagnostics
  return (
    numericFields.every(field => typeof value[field] === 'number')
    && booleanFields.every(field => typeof value[field] === 'boolean')
    && stringFields.every(field => typeof value[field] === 'string')
    && (diagnostics.min === null || typeof diagnostics.min === 'number')
    && (diagnostics.max === null || typeof diagnostics.max === 'number')
    && typeof diagnostics.count === 'number'
  )
}

function isLifecycleReviewDetail(value: unknown): value is LifecycleReviewDetail {
  if (!isObject(value) || !isObject(value.snapshot) || !isObject(value.live) || !isObject(value.stalenessSignals)) return false
  const snapshot = value.snapshot
  const live = value.live
  const signals = value.stalenessSignals
  if (
    typeof value.reviewRequestId !== 'string'
    || typeof value.generation !== 'number'
    || typeof value.semanticTopicId !== 'string'
    || typeof value.topicCanonicalLabel !== 'string'
    || !FROM_STATUSES.has(String(value.fromStatus))
    || !TARGET_STATUSES.has(String(value.targetStatus))
    || !REQUEST_STATUSES.has(String(value.requestStatus))
    || typeof value.requestedAt !== 'string'
    || typeof value.expiresAt !== 'string'
    || !isNullableString(value.decidedAt)
    || !isNullableString(value.staleReasonCode)
    || typeof value.reviewPolicyVersion !== 'number'
    || typeof value.isPotentiallyStale !== 'boolean'
    || !Array.isArray(value.transitionHistory)
  ) return false

  if (
    !isEvidenceVector(snapshot.evidenceVector)
    || typeof snapshot.digest !== 'string'
    || typeof snapshot.capturedAt !== 'string'
    || !FROM_STATUSES.has(String(snapshot.fromLifecycleStatus))
    || typeof snapshot.expectedStatusVersion !== 'number'
    || !isEvidenceVector(live.evidenceVector)
    || typeof live.lifecycleStatus !== 'string'
    || typeof live.statusVersion !== 'number'
    || typeof live.vectorDigest !== 'string'
    || typeof live.mechanicalRequirementsCurrentlyMet !== 'boolean'
    || !['topicStatusChanged', 'topicVersionChanged', 'evidenceVectorChanged', 'mechanicalRequirementsLost'].every(field => typeof signals[field] === 'boolean')
  ) return false

  if (!value.transitionHistory.every(entry => (
    isObject(entry)
    && EVENT_TYPES.has(String(entry.eventType))
    && ACTOR_KINDS.has(String(entry.actorKind))
    && typeof entry.createdAt === 'string'
  ))) return false

  if (value.decision !== null) {
    const decision = value.decision
    if (!isObject(decision)
      || typeof decision.reviewerRoleSnapshot !== 'string'
      || typeof decision.decidedAt !== 'string'
      || typeof decision.reasonCode !== 'string'
      || !(decision.reasonCode in REASON_LABELS)
      || typeof decision.reviewerRationale !== 'string'
      || !isNullableBoolean(decision.sameSemanticIdentityConfirmed)
      || !isNullableBoolean(decision.noMaterialIdentityConflict)
      || !isNullableBoolean(decision.canonicalDefinitionScopeFitConfirmed)
      || !isNullableBoolean(decision.provenanceRelationshipReviewed)
      || typeof decision.decidedByCurrentReviewer !== 'boolean') return false
  }

  if (value.execution !== null && (!isObject(value.execution) || typeof value.execution.executedAt !== 'string')) return false
  if (value.cancellation !== null) {
    const cancellation = value.cancellation
    if (!isObject(cancellation)
      || typeof cancellation.cancelledAt !== 'string'
      || typeof cancellation.cancelReasonCode !== 'string'
      || !(cancellation.cancelReasonCode in CANCEL_REASON_LABELS)
      || typeof cancellation.cancelRationale !== 'string'
      || typeof cancellation.cancelledByCurrentReviewer !== 'boolean') return false
  }

  return true
}
