// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, reviewer
// admin API: pending request cancellation.
//
// cancelled_by_user_id is NEVER accepted from the request body -- the
// underlying RPC (corrected during the Security and Concurrency Closure
// gate) takes only a review_request_id parameter; cancelled_by_user_id is
// derived exclusively from auth.uid() on the session client. State-based
// idempotency only (repeat calls on an already-cancelled request simply
// replay) -- there is no cancel-specific idempotency key/header on this
// route, matching the RPC's own contract exactly.
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { cancelReview } from '@/lib/semantic-topic/human-review-reviewer'
import { jsonNoStore, reviewFailureToResponse } from '@/lib/semantic-topic/human-review-http-mapping'
import { isUuid } from '@/lib/semantic-topic/human-review-types'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const result = await cancelReview(supabase, id)
  if (result.outcome !== 'success') {
    return reviewFailureToResponse(result)
  }
  return jsonNoStore({ result: result.result, reviewRequestId: result.reviewRequestId })
}
