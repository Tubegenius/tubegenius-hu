// PFM Lifecycle Reviewer Read Surface v1 -- reviewer admin API: single
// lifecycle review request detail. Mirrors
// app/api/admin/semantic-topic-reviews/[id]/route.ts's exact structure.
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getLifecycleReview } from '@/lib/semantic-topic/lifecycle-review-reader'
import { lifecycleReadFailureToResponse } from '@/lib/semantic-topic/lifecycle-review-http-mapping'
import { jsonNoStore } from '@/lib/semantic-topic/human-review-http-mapping'
import { isUuid } from '@/lib/semantic-topic/lifecycle-review-types'

// This route reads via cookies()-bound session state on every request --
// never statically generated/prerendered, never cached across callers.
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  if (!isUuid(id)) return jsonNoStore({ error: 'Érvénytelen review request azonosító' }, { status: 422 })

  const result = await getLifecycleReview(supabase, id)
  if (result.outcome !== 'success') return lifecycleReadFailureToResponse(result)
  return jsonNoStore({ request: result.request })
}
