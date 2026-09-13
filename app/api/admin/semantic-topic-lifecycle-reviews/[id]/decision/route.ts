// PFM Lifecycle Reviewer Action Surface v1 -- reviewer admin API: structured
// approve/reject decision on a lifecycle review request. Calls ONLY 087's
// already-production record_semantic_topic_lifecycle_review_decision RPC --
// never the executor, never a direct table write.
//
// reviewer_user_id is NEVER accepted from the request body -- neither this
// route nor recordLifecycleDecision() (lifecycle-review-actions.ts) forward
// any such field to the RPC; the RPC derives reviewer identity solely from
// auth.uid() on the session client this route passes through. Unknown
// fields in the body (including a forged reviewerUserId/actorId/topicId)
// are rejected outright with 422 -- never silently dropped -- by the
// closed-field-set check below.
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { recordLifecycleDecision } from '@/lib/semantic-topic/lifecycle-review-actions'
import { lifecycleActionFailureToResponse } from '@/lib/semantic-topic/lifecycle-review-http-mapping'
import { jsonNoStore, readJsonBody } from '@/lib/semantic-topic/human-review-http-mapping'
import { isPlainRecord } from '@/lib/api-input-validation'
import {
  isUuid,
  LIFECYCLE_IDEMPOTENCY_KEY_MAX_LENGTH,
  LIFECYCLE_RATIONALE_MAX_LENGTH,
  LIFECYCLE_REASON_CODES,
  LIFECYCLE_REVIEW_POLICY_VERSION,
  type LifecycleDecisionRequestBody,
  type LifecycleReasonCode,
} from '@/lib/semantic-topic/lifecycle-review-types'

// This route reads via cookies()-bound session state and performs a
// side-effecting write on every request -- never statically generated/
// prerendered, never cached.
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 20_000

// The EXACT closed field set item 4 of the gate specifies -- any other key
// present in the body is rejected (422) before the RPC is ever called, not
// silently dropped.
const ALLOWED_FIELDS = new Set([
  'outcome',
  'reasonCode',
  'reviewerRationale',
  'sameSemanticIdentityConfirmed',
  'noMaterialIdentityConflict',
  'canonicalDefinitionScopeFitConfirmed',
  'provenanceRelationshipReviewed',
  'reviewPolicyVersion',
  'idempotencyKey',
])

const CHECKLIST_FIELDS = [
  'sameSemanticIdentityConfirmed',
  'noMaterialIdentityConflict',
  'canonicalDefinitionScopeFitConfirmed',
  'provenanceRelationshipReviewed',
] as const

function isBooleanOrNullish(value: unknown): value is boolean | null | undefined {
  return value === null || value === undefined || typeof value === 'boolean'
}

type ParseResult = { ok: true; input: LifecycleDecisionRequestBody } | { ok: false; error: string }

// Deliberately shallow: only type/shape/membership checks that don't
// require knowing this request's target_status (unknown to the route --
// see lifecycle-review-types.ts's LifecycleDecisionRequestBody doc
// comment). Whether a given reasonCode/checklist combination is actually
// valid for THIS request's outcome+target is decided exclusively by the
// RPC; this function never re-implements that state machine.
function parseDecisionBody(body: unknown): ParseResult {
  if (!isPlainRecord(body)) return { ok: false, error: 'A kérés törzse hiányzik vagy érvénytelen' }

  const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key))
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Ismeretlen mező(k) a kérésben: ${unknownKeys.join(', ')}` }
  }

  if (body.outcome !== 'approved' && body.outcome !== 'rejected') {
    return { ok: false, error: 'outcome mezőnek "approved" vagy "rejected" értékűnek kell lennie' }
  }

  if (typeof body.reasonCode !== 'string' || !LIFECYCLE_REASON_CODES.includes(body.reasonCode as LifecycleReasonCode)) {
    return { ok: false, error: 'reasonCode kötelező, a megengedett értékek egyike' }
  }

  if (typeof body.reviewerRationale !== 'string') {
    return { ok: false, error: 'reviewerRationale kötelező szöveg' }
  }
  const trimmedRationale = body.reviewerRationale.trim()
  if (trimmedRationale.length === 0 || trimmedRationale.length > LIFECYCLE_RATIONALE_MAX_LENGTH) {
    return { ok: false, error: `reviewerRationale kötelező, nem lehet üres, legfeljebb ${LIFECYCLE_RATIONALE_MAX_LENGTH} karakter` }
  }

  for (const field of CHECKLIST_FIELDS) {
    if (!isBooleanOrNullish(body[field])) {
      return { ok: false, error: `${field} csak boolean vagy null lehet` }
    }
  }

  if (body.reviewPolicyVersion !== LIFECYCLE_REVIEW_POLICY_VERSION) {
    return { ok: false, error: `reviewPolicyVersion kötelező, jelenleg támogatott értéke ${LIFECYCLE_REVIEW_POLICY_VERSION}` }
  }

  if (
    typeof body.idempotencyKey !== 'string' ||
    body.idempotencyKey.length === 0 ||
    body.idempotencyKey.length > LIFECYCLE_IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    return { ok: false, error: `idempotencyKey kötelező, 1 és ${LIFECYCLE_IDEMPOTENCY_KEY_MAX_LENGTH} karakter között` }
  }

  return {
    ok: true,
    input: {
      outcome: body.outcome,
      reasonCode: body.reasonCode as LifecycleReasonCode,
      reviewerRationale: trimmedRationale,
      sameSemanticIdentityConfirmed: (body.sameSemanticIdentityConfirmed ?? null) as boolean | null,
      noMaterialIdentityConflict: (body.noMaterialIdentityConflict ?? null) as boolean | null,
      canonicalDefinitionScopeFitConfirmed: (body.canonicalDefinitionScopeFitConfirmed ?? null) as boolean | null,
      provenanceRelationshipReviewed: (body.provenanceRelationshipReviewed ?? null) as boolean | null,
      reviewPolicyVersion: body.reviewPolicyVersion,
      idempotencyKey: body.idempotencyKey,
    },
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  if (!isUuid(id)) return jsonNoStore({ error: 'Érvénytelen review request azonosító' }, { status: 422 })

  const bodyResult = await readJsonBody(request, MAX_BODY_BYTES)
  if (!bodyResult.ok) return jsonNoStore({ error: 'A kérés törzse érvénytelen vagy túl nagy' }, { status: 422 })

  const parsed = parseDecisionBody(bodyResult.body)
  if (!parsed.ok) return jsonNoStore({ error: parsed.error }, { status: 422 })

  const result = await recordLifecycleDecision(supabase, id, parsed.input)
  if (result.outcome !== 'success') return lifecycleActionFailureToResponse(result)
  return jsonNoStore({ result: result.result })
}
