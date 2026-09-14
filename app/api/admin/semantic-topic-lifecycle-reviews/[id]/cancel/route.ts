// PFM Lifecycle Reviewer Action Surface v1 -- reviewer admin API: cancel a
// requested or approved lifecycle review request. Calls ONLY 087's
// already-production cancel_semantic_topic_lifecycle_review_request RPC --
// never the executor, never a direct table write.
//
// cancelled_by_user_id is NEVER accepted from the request body -- neither
// this route nor cancelLifecycleReview() (lifecycle-review-actions.ts)
// forward any such field to the RPC; it is derived exclusively from
// auth.uid() on the session client this route passes through.
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { cancelLifecycleReview } from '@/lib/semantic-topic/lifecycle-review-actions'
import { lifecycleActionFailureToResponse } from '@/lib/semantic-topic/lifecycle-review-http-mapping'
import { jsonNoStore, readJsonBody } from '@/lib/semantic-topic/human-review-http-mapping'
import { checkOriginGuard, originGuardFailureToResponse } from '@/lib/http-origin-guard'
import { isPlainRecord } from '@/lib/api-input-validation'
import {
  isUuid,
  LIFECYCLE_CANCEL_REASON_CODES,
  LIFECYCLE_IDEMPOTENCY_KEY_MAX_LENGTH,
  LIFECYCLE_RATIONALE_MAX_LENGTH,
  type LifecycleCancelReasonCode,
  type LifecycleCancelRequestBody,
} from '@/lib/semantic-topic/lifecycle-review-types'

// This route reads via cookies()-bound session state and performs a
// side-effecting write on every request -- never statically generated/
// prerendered, never cached.
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 20_000

// The EXACT closed field set item 5 of the gate specifies.
const ALLOWED_FIELDS = new Set(['cancelReasonCode', 'cancelRationale', 'idempotencyKey'])

type ParseResult = { ok: true; input: LifecycleCancelRequestBody } | { ok: false; error: string }

function parseCancelBody(body: unknown): ParseResult {
  if (!isPlainRecord(body)) return { ok: false, error: 'A kérés törzse hiányzik vagy érvénytelen' }

  const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key))
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Ismeretlen mező(k) a kérésben: ${unknownKeys.join(', ')}` }
  }

  if (typeof body.cancelReasonCode !== 'string' || !LIFECYCLE_CANCEL_REASON_CODES.includes(body.cancelReasonCode as LifecycleCancelReasonCode)) {
    return { ok: false, error: 'cancelReasonCode kötelező, a megengedett értékek egyike' }
  }

  if (typeof body.cancelRationale !== 'string') {
    return { ok: false, error: 'cancelRationale kötelező szöveg' }
  }
  const trimmedRationale = body.cancelRationale.trim()
  if (trimmedRationale.length === 0 || trimmedRationale.length > LIFECYCLE_RATIONALE_MAX_LENGTH) {
    return { ok: false, error: `cancelRationale kötelező, nem lehet üres, legfeljebb ${LIFECYCLE_RATIONALE_MAX_LENGTH} karakter` }
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
      cancelReasonCode: body.cancelReasonCode as LifecycleCancelReasonCode,
      cancelRationale: trimmedRationale,
      idempotencyKey: body.idempotencyKey,
    },
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Same-origin/CSRF guard runs FIRST -- before auth.getUser() and before
  // any RPC call -- so a cross-origin or otherwise disallowed request never
  // reaches session validation or the database at all.
  const originGuard = checkOriginGuard(request)
  if (!originGuard.ok) return originGuardFailureToResponse(originGuard.failure)

  const { id } = await params
  const supabase = createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  if (!isUuid(id)) return jsonNoStore({ error: 'Érvénytelen review request azonosító' }, { status: 422 })

  const bodyResult = await readJsonBody(request, MAX_BODY_BYTES)
  if (!bodyResult.ok) return jsonNoStore({ error: 'A kérés törzse érvénytelen vagy túl nagy' }, { status: 422 })

  const parsed = parseCancelBody(bodyResult.body)
  if (!parsed.ok) return jsonNoStore({ error: parsed.error }, { status: 422 })

  const result = await cancelLifecycleReview(supabase, id, parsed.input)
  if (result.outcome !== 'success') return lifecycleActionFailureToResponse(result)
  return jsonNoStore({ result: result.result })
}
