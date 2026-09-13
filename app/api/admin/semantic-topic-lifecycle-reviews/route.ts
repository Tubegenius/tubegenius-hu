// PFM Lifecycle Reviewer Read Surface v1 -- reviewer admin API: lifecycle
// review request list.
//
// Auth model: the caller's own authenticated Supabase session is the ONLY
// client ever used here -- no service-role fallback. Whether the caller is
// actually an active reviewer is decided exclusively by the DB
// (semantic_topic_reviewers allowlist, checked inside
// list_semantic_topic_lifecycle_review_requests itself); this route never
// re-implements that check. Mirrors
// app/api/admin/semantic-topic-reviews/route.ts's own established pattern
// exactly.
import { NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { listLifecycleReviews } from '@/lib/semantic-topic/lifecycle-review-reader'
import { lifecycleReadFailureToResponse } from '@/lib/semantic-topic/lifecycle-review-http-mapping'
import { jsonNoStore } from '@/lib/semantic-topic/human-review-http-mapping'
import { isUuid, LIFECYCLE_STATUS_FILTERS, type LifecycleStatusFilter } from '@/lib/semantic-topic/lifecycle-review-types'
import { parseNonNegativeSafeInteger } from '@/lib/api-input-validation'

// This route reads via cookies()-bound session state on every request --
// never statically generated/prerendered, never cached across callers.
export const dynamic = 'force-dynamic'

const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20

function isLifecycleStatusFilter(value: string): value is LifecycleStatusFilter {
  return (LIFECYCLE_STATUS_FILTERS as readonly string[]).includes(value)
}

export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)

  const statusParam = searchParams.get('status')
  let statusFilter: LifecycleStatusFilter = 'actionable'
  if (statusParam !== null) {
    if (!isLifecycleStatusFilter(statusParam)) {
      return jsonNoStore({ error: 'Érvénytelen status paraméter' }, { status: 422 })
    }
    statusFilter = statusParam
  }

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
  // the requested_at half and paginate incorrectly (same rule as the
  // 077/078 list route).
  if ((afterId === null) !== (afterRequestedAt === null)) {
    return jsonNoStore({ error: 'after_id és after_requested_at csak együtt adható meg' }, { status: 422 })
  }

  const result = await listLifecycleReviews(supabase, { statusFilter, limit, afterRequestedAt, afterId })
  if (result.outcome !== 'success') {
    return lifecycleReadFailureToResponse(result)
  }
  return jsonNoStore({ requests: result.requests })
}
