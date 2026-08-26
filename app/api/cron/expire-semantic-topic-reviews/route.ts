import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { isHumanReviewEnabled } from '@/lib/semantic-topic/human-review-flag'
import { expireStaleReviewRequests } from '@/lib/semantic-topic/human-review-service'

// GET /api/cron/expire-semantic-topic-reviews
//
// Sweeps pending Human-Reviewed Candidate Workflow requests whose
// expires_at has passed (migration 078's expire_stale_topic_assignment_review_requests,
// service_role-only). Mirrors the existing cron auth pattern exactly
// (app/api/cron/collect-signals/route.ts's timing-safe CRON_SECRET check) --
// no new, weaker auth scheme is introduced for this route.
//
// Fail-closed on every axis:
//   - missing CRON_SECRET config -> 503, RPC never called
//   - missing/invalid Authorization header -> 401, RPC never called
//   - SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED=false (the default) -> 200 no-op,
//     RPC never called -- this is NOT an error, just nothing to do while the
//     workflow is off
//   - batch limit is a fixed, non-caller-controllable constant, never taken
//     from a query param or header
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EXPIRE_BATCH_LIMIT = 100

function authorized(request: NextRequest, secret: string): boolean {
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
  const supplied = createHash('sha256').update(request.headers.get('authorization') ?? '').digest()
  return timingSafeEqual(expected, supplied)
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[cron/expire-semantic-topic-reviews] CRON_SECRET nincs beállítva')
    return NextResponse.json({ ok: false, error: 'Cron not configured' }, { status: 503 })
  }
  if (!authorized(request, cronSecret)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  if (!isHumanReviewEnabled()) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'flag_disabled' }, { status: 200 })
  }

  try {
    const result = await expireStaleReviewRequests({ batchLimit: EXPIRE_BATCH_LIMIT })
    if (result.outcome !== 'success') {
      console.error('[cron/expire-semantic-topic-reviews] expire RPC failure:', result)
      return NextResponse.json({ ok: false, error: 'Expire operation failed' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, expiredCount: result.expiredCount }, { status: 200 })
  } catch (e) {
    console.error('[cron/expire-semantic-topic-reviews] unexpected failure:', e)
    return NextResponse.json({ ok: false, error: 'Unexpected failure' }, { status: 500 })
  }
}
