// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, reviewer
// admin API: approved-but-not-yet-executed request revocation. State-based
// idempotency only, exactly like cancel -- see that route's header comment.
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { revokeApproval } from '@/lib/semantic-topic/human-review-reviewer'
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

  const result = await revokeApproval(supabase, id)
  if (result.outcome !== 'success') {
    return reviewFailureToResponse(result)
  }
  return jsonNoStore({ result: result.result, reviewRequestId: result.reviewRequestId })
}
