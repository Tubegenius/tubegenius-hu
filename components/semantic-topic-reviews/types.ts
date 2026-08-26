// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, minimal
// reviewer UI (Local Implementation Phase 4).
//
// SECURITY BOUNDARY: this file is intentionally a plain, standalone client
// data-shape module. It does NOT import anything from the lib/semantic-topic
// application layer (the reviewer types/wrapper/service-role modules that
// live there) -- every field/enum/limit below is a deliberate, small
// duplication of that server-side contract, kept in sync by hand. This is a
// conscious choice,
// not an oversight: it lets a single static source-scan test assert the
// entire components/semantic-topic-reviews/** and
// app/dashboard/semantic-topic-reviews/** import graph never reaches
// lib/semantic-topic/* at all -- the UI only ever talks to the reviewer API
// routes via fetch(), exactly like every other page in this codebase talks
// to its own API routes. See docs/architecture/semantic-topic-identity-v0-contract.md
// SS36 for the full rationale.

export type ReviewRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'revoked' | 'executed'
export type ProposedOutcome = 'CREATE_NEW' | 'ATTACH_EXISTING'
export type DuplicateSearchOutcome = 'no_duplicate_found' | 'possible_duplicate_reviewed_and_distinct'
export type UncertaintyClassification = 'low' | 'medium' | 'high'
export type RejectionReason =
  | 'insufficient_evidence'
  | 'invalid_topic_identity'
  | 'not_lane_neutral'
  | 'malformed_candidate'
  | 'duplicate_without_valid_target'
  | 'other_review_rejection'

export const REJECTION_REASONS: readonly RejectionReason[] = [
  'insufficient_evidence',
  'invalid_topic_identity',
  'not_lane_neutral',
  'malformed_candidate',
  'duplicate_without_valid_target',
  'other_review_rejection',
]

export const REJECTION_REASON_LABELS: Record<RejectionReason, string> = {
  insufficient_evidence: 'Nem elegendő bizonyíték',
  invalid_topic_identity: 'Érvénytelen topic-azonosítás',
  not_lane_neutral: 'Nem lane-neutrális',
  malformed_candidate: 'Hibásan formázott jelölt',
  duplicate_without_valid_target: 'Duplikátum érvényes cél nélkül',
  other_review_rejection: 'Egyéb elutasítási ok',
}

// Mirrors lib/semantic-topic/human-review-types.ts's REVIEW_FIELD_MAX_LENGTHS
// exactly -- these are 077's own CHECK-constraint length ceilings; the RPC
// remains the actual enforcement point, this is only a fast client-side hint.
export const REVIEW_FIELD_MAX_LENGTHS = {
  canonicalTopicLabel: 200,
  topicDefinition: 1000,
  scope: 1000,
  inclusionCriteria: 1000,
  exclusionCriteria: 1000,
  reviewerRationale: 1000,
} as const

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export interface ReviewEvidenceDTO {
  evidenceId: string
  title: string | null
  externalRef: string | null
  publishedAt: string | null
  canonicalUrl: string | null
}

export interface ReviewSourceDTO {
  sourceType: string
  sourceFamilyKey: string
}

export interface ReviewRequestSummaryDTO {
  reviewRequestId: string
  generation: number
  requestedAt: string
  expiresAt: string
  extractionRunId: string
  evidence: ReviewEvidenceDTO
  source: ReviewSourceDTO
  candidateLabel: string | null
  specificity: string | null
  contentFormat: string | null
  modelReportedConfidence: string | null
  supportingSpans: unknown
}

export interface ReviewDecisionDTO {
  decidedAt: string
  canonicalTopicLabel: string | null
  topicDefinition: string | null
  scope: string | null
  inclusionCriteria: string | null
  exclusionCriteria: string | null
  laneNeutralConfirmed: boolean | null
  evidenceAdequacy: string | null
  duplicateSearchOutcome: string | null
  proposedOutcome: string | null
  targetSemanticTopicId: string | null
  uncertaintyClassification: string | null
  reviewerRationale: string | null
  rejectionReason: string | null
}

export interface ReviewRequestDetailDTO extends ReviewRequestSummaryDTO {
  status: ReviewRequestStatus
  labelLanguage: string | null
  subjectEntities: unknown
  actionOrEvent: string | null
  location: string | null
  temporalContext: string | null
  decision: ReviewDecisionDTO | null
}

export interface StructuredApprovalPayload {
  outcome: 'approved'
  canonicalTopicLabel: string
  topicDefinition: string
  scope: string
  inclusionCriteria: string
  exclusionCriteria: string
  laneNeutralConfirmed: true
  evidenceAdequacy: 'adequate'
  duplicateSearchOutcome: DuplicateSearchOutcome
  proposedOutcome: ProposedOutcome
  targetSemanticTopicId: string | null
  uncertaintyClassification: UncertaintyClassification
  reviewerRationale: string
  reviewPolicyVersion: number
}

export interface StructuredRejectionPayload {
  outcome: 'rejected'
  rejectionReason: RejectionReason
  reviewerRationale: string
  reviewPolicyVersion: number
}

export type StructuredDecisionPayload = StructuredApprovalPayload | StructuredRejectionPayload

// Supporting spans are always a small, server-validated {source_field,
// quoted_text}[] shape (see structured-output-schema.ts's own <=10-entry
// cap) -- this narrows the `unknown` DTO field defensively before render,
// never trusting the shape blindly.
export interface SupportingSpan {
  source_field: string
  quoted_text: string
}

export function asSupportingSpans(value: unknown): SupportingSpan[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (v): v is SupportingSpan =>
      typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).source_field === 'string' && typeof (v as Record<string, unknown>).quoted_text === 'string',
  )
}

export function asSubjectEntities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

export const REVIEW_POLICY_VERSION = 1
