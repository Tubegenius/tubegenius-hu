// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, reviewer
// admin API: structured approve/reject decision.
//
// reviewer_user_id and reviewer_role are NEVER accepted from the request
// body -- recordDecision() (human-review-reviewer.ts) never forwards any
// such field to the RPC; the RPC itself derives reviewer identity solely
// from auth.uid() on the session client this route passes through. A
// request body containing a `reviewerUserId`/`reviewer_user_id` field is
// simply ignored (not merged into the RPC call at all), never trusted.
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { recordDecision } from '@/lib/semantic-topic/human-review-reviewer'
import { jsonNoStore, readJsonBody, reviewFailureToResponse } from '@/lib/semantic-topic/human-review-http-mapping'
import { isPlainRecord, isOptionalTextWithinLimit } from '@/lib/api-input-validation'
import {
  isUuid,
  REJECTION_REASONS,
  REVIEW_FIELD_MAX_LENGTHS,
  type DuplicateSearchOutcome,
  type ProposedOutcome,
  type RejectionReason,
  type StructuredDecisionInput,
  type UncertaintyClassification,
} from '@/lib/semantic-topic/human-review-types'

const MAX_BODY_BYTES = 20_000
const MAX_IDEMPOTENCY_KEY_LENGTH = 200

const DUPLICATE_SEARCH_OUTCOMES: readonly DuplicateSearchOutcome[] = ['no_duplicate_found', 'possible_duplicate_reviewed_and_distinct']
const UNCERTAINTY_CLASSIFICATIONS: readonly UncertaintyClassification[] = ['low', 'medium', 'high']
const PROPOSED_OUTCOMES: readonly ProposedOutcome[] = ['CREATE_NEW', 'ATTACH_EXISTING']

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function parseDecisionBody(body: unknown): { ok: true; decision: StructuredDecisionInput } | { ok: false; error: string } {
  if (!isPlainRecord(body)) return { ok: false, error: 'A kérés törzse hiányzik vagy érvénytelen' }

  if (body.outcome !== 'approved' && body.outcome !== 'rejected') {
    return { ok: false, error: 'outcome mezőnek "approved" vagy "rejected" értékűnek kell lennie' }
  }

  if (!isPositiveInteger(body.reviewPolicyVersion)) {
    return { ok: false, error: 'reviewPolicyVersion kötelező, pozitív egész szám' }
  }
  if (!isNonEmptyString(body.reviewerRationale) || !isOptionalTextWithinLimit(body.reviewerRationale, REVIEW_FIELD_MAX_LENGTHS.reviewerRationale)) {
    return { ok: false, error: `reviewerRationale kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.reviewerRationale} karakter` }
  }

  if (body.outcome === 'rejected') {
    if (typeof body.rejectionReason !== 'string' || !REJECTION_REASONS.includes(body.rejectionReason as RejectionReason)) {
      return { ok: false, error: 'rejectionReason kötelező, a megengedett értékek egyike' }
    }
    return {
      ok: true,
      decision: {
        outcome: 'rejected',
        rejectionReason: body.rejectionReason as RejectionReason,
        reviewerRationale: body.reviewerRationale,
        reviewPolicyVersion: body.reviewPolicyVersion,
      },
    }
  }

  // approved
  if (!isNonEmptyString(body.canonicalTopicLabel) || !isOptionalTextWithinLimit(body.canonicalTopicLabel, REVIEW_FIELD_MAX_LENGTHS.canonicalTopicLabel)) {
    return { ok: false, error: `canonicalTopicLabel kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.canonicalTopicLabel} karakter` }
  }
  if (!isNonEmptyString(body.topicDefinition) || !isOptionalTextWithinLimit(body.topicDefinition, REVIEW_FIELD_MAX_LENGTHS.topicDefinition)) {
    return { ok: false, error: `topicDefinition kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.topicDefinition} karakter` }
  }
  if (!isNonEmptyString(body.scope) || !isOptionalTextWithinLimit(body.scope, REVIEW_FIELD_MAX_LENGTHS.scope)) {
    return { ok: false, error: `scope kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.scope} karakter` }
  }
  if (!isNonEmptyString(body.inclusionCriteria) || !isOptionalTextWithinLimit(body.inclusionCriteria, REVIEW_FIELD_MAX_LENGTHS.inclusionCriteria)) {
    return { ok: false, error: `inclusionCriteria kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.inclusionCriteria} karakter` }
  }
  if (!isNonEmptyString(body.exclusionCriteria) || !isOptionalTextWithinLimit(body.exclusionCriteria, REVIEW_FIELD_MAX_LENGTHS.exclusionCriteria)) {
    return { ok: false, error: `exclusionCriteria kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.exclusionCriteria} karakter` }
  }
  if (body.laneNeutralConfirmed !== true) {
    return { ok: false, error: 'laneNeutralConfirmed kötelezően true' }
  }
  if (body.evidenceAdequacy !== 'adequate') {
    return { ok: false, error: 'evidenceAdequacy kötelezően "adequate"' }
  }
  if (typeof body.duplicateSearchOutcome !== 'string' || !DUPLICATE_SEARCH_OUTCOMES.includes(body.duplicateSearchOutcome as DuplicateSearchOutcome)) {
    return { ok: false, error: 'duplicateSearchOutcome kötelező, a megengedett értékek egyike' }
  }
  if (typeof body.proposedOutcome !== 'string' || !PROPOSED_OUTCOMES.includes(body.proposedOutcome as ProposedOutcome)) {
    return { ok: false, error: 'proposedOutcome kötelező: CREATE_NEW vagy ATTACH_EXISTING' }
  }
  const targetSemanticTopicId = body.targetSemanticTopicId ?? null
  if (targetSemanticTopicId !== null && !isUuid(targetSemanticTopicId)) {
    return { ok: false, error: 'targetSemanticTopicId érvénytelen azonosító' }
  }
  if (body.proposedOutcome === 'CREATE_NEW' && targetSemanticTopicId !== null) {
    return { ok: false, error: 'CREATE_NEW esetén targetSemanticTopicId nem adható meg' }
  }
  if (body.proposedOutcome === 'ATTACH_EXISTING' && targetSemanticTopicId === null) {
    return { ok: false, error: 'ATTACH_EXISTING esetén targetSemanticTopicId kötelező' }
  }
  if (typeof body.uncertaintyClassification !== 'string' || !UNCERTAINTY_CLASSIFICATIONS.includes(body.uncertaintyClassification as UncertaintyClassification)) {
    return { ok: false, error: 'uncertaintyClassification kötelező, a megengedett értékek egyike' }
  }

  return {
    ok: true,
    decision: {
      outcome: 'approved',
      canonicalTopicLabel: body.canonicalTopicLabel,
      topicDefinition: body.topicDefinition,
      scope: body.scope,
      inclusionCriteria: body.inclusionCriteria,
      exclusionCriteria: body.exclusionCriteria,
      laneNeutralConfirmed: true,
      evidenceAdequacy: 'adequate',
      duplicateSearchOutcome: body.duplicateSearchOutcome as DuplicateSearchOutcome,
      proposedOutcome: body.proposedOutcome as ProposedOutcome,
      targetSemanticTopicId,
      uncertaintyClassification: body.uncertaintyClassification as UncertaintyClassification,
      reviewerRationale: body.reviewerRationale,
      reviewPolicyVersion: body.reviewPolicyVersion,
    },
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  if (!isUuid(id)) {
    return jsonNoStore({ error: 'Érvénytelen review request azonosító' }, { status: 422 })
  }

  // Idempotency-Key is required for this route: a decision is a one-time,
  // side-effecting write (it can atomically create an append-only
  // QUARANTINE decision on rejection), so a caller MUST supply a stable key
  // it reuses on retry -- this route never mints one on the caller's
  // behalf, which would silently defeat retry-safety for exactly the caller
  // that needs it most (a client retrying after a dropped connection).
  const idempotencyKey = request.headers.get('idempotency-key')
  if (!idempotencyKey || idempotencyKey.length === 0) {
    return jsonNoStore({ error: 'Idempotency-Key fejléc kötelező' }, { status: 422 })
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return jsonNoStore({ error: 'Idempotency-Key túl hosszú' }, { status: 422 })
  }

  const bodyResult = await readJsonBody(request, MAX_BODY_BYTES)
  if (!bodyResult.ok) {
    return jsonNoStore({ error: 'A kérés törzse érvénytelen vagy túl nagy' }, { status: 422 })
  }

  const parsed = parseDecisionBody(bodyResult.body)
  if (!parsed.ok) {
    return jsonNoStore({ error: parsed.error }, { status: 422 })
  }

  const result = await recordDecision(supabase, id, idempotencyKey, parsed.decision)
  if (result.outcome !== 'success') {
    return reviewFailureToResponse(result)
  }
  return jsonNoStore({ result: result.result, reviewRequestId: result.reviewRequestId })
}
