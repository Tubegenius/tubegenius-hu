// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, reviewer
// admin API: single review request detail.
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getReview } from '@/lib/semantic-topic/human-review-reviewer'
import { jsonNoStore, reviewFailureToResponse } from '@/lib/semantic-topic/human-review-http-mapping'
import { isUuid } from '@/lib/semantic-topic/human-review-types'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const result = await getReview(supabase, id)
  if (result.outcome !== 'success') {
    return reviewFailureToResponse(result)
  }
  return jsonNoStore({ request: result.request })
}
