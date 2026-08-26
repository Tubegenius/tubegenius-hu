// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, reviewer
// admin API: pending review list.
//
// Auth model: the caller's own authenticated Supabase session is the ONLY
// client ever used here -- no service-role fallback. Whether the caller is
// actually an active reviewer is decided exclusively by the DB
// (semantic_topic_reviewers allowlist, checked inside
// list_pending_topic_assignment_review_requests itself); this route never
// re-implements that check, e.g. via an email allowlist.
import { NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { listPendingReviews } from '@/lib/semantic-topic/human-review-reviewer'
import { jsonNoStore, reviewFailureToResponse } from '@/lib/semantic-topic/human-review-http-mapping'
import { isUuid } from '@/lib/semantic-topic/human-review-types'
import { parseNonNegativeSafeInteger } from '@/lib/api-input-validation'

const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20

export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)

  const limitParam = searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitParam !== null) {
    const parsed = parseNonNegativeSafeInteger(limitParam)
    if (parsed === null || parsed < 1) {
      return jsonNoStore({ error: 'Érvénytelen limit paraméter' }, { status: 422 })
    }
    limit = Math.min(parsed, MAX_LIMIT)
  }

  const afterId = searchParams.get('after_id')
  if (afterId !== null && !isUuid(afterId)) {
    return jsonNoStore({ error: 'Érvénytelen after_id paraméter' }, { status: 422 })
  }

  const afterRequestedAt = searchParams.get('after_requested_at')
  if (afterRequestedAt !== null && Number.isNaN(Date.parse(afterRequestedAt))) {
    return jsonNoStore({ error: 'Érvénytelen after_requested_at paraméter' }, { status: 422 })
  }
  // Cursor is a pair -- either both halves are present or neither is,
  // otherwise the underlying RPC's keyset comparison would silently ignore
  // the requested_at half and paginate incorrectly.
  if ((afterId === null) !== (afterRequestedAt === null)) {
    return jsonNoStore({ error: 'after_id és after_requested_at csak együtt adható meg' }, { status: 422 })
  }

  const result = await listPendingReviews(supabase, { limit, afterRequestedAt, afterId })
  if (result.outcome !== 'success') {
    return reviewFailureToResponse(result)
  }
  return jsonNoStore({ requests: result.requests })
}
