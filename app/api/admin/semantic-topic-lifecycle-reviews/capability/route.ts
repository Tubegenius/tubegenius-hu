// PFM Lifecycle Reviewer Self-Capability v1 -- reviewer admin API: tells
// the CALLER whether they can review semantic-topic lifecycle requests.
//
// Auth model: the caller's own authenticated Supabase session is the ONLY
// client ever used here -- no service-role fallback. Whether the caller is
// actually an active reviewer is decided exclusively by the DB
// (semantic_topic_reviewers allowlist, checked inside
// get_semantic_topic_lifecycle_reviewer_capability itself); this route
// never re-implements that check. Mirrors
// app/api/admin/semantic-topic-lifecycle-reviews/route.ts's own
// established pattern exactly.
//
// This endpoint is a UI/navigation signal ONLY. It never replaces the
// existing list/detail/decision/cancel RPC- and route-level authorization,
// which remains the sole binding security gate for those operations.
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getLifecycleReviewerCapability, lifecycleReviewerCapabilityFailureToResponse } from '@/lib/semantic-topic/lifecycle-reviewer-capability'
import { jsonNoStore } from '@/lib/semantic-topic/human-review-http-mapping'

// This route reads via cookies()-bound session state on every request --
// never statically generated/prerendered, never cached across callers.
export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const result = await getLifecycleReviewerCapability(supabase)
  if (result.outcome !== 'success') {
    return lifecycleReviewerCapabilityFailureToResponse(result)
  }
  return jsonNoStore({ canReviewSemanticTopicLifecycle: result.canReviewSemanticTopicLifecycle })
}
