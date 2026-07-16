import { NextRequest, NextResponse } from 'next/server'
import { refreshDueCandidates } from '@/lib/trend-tracking'
import { refreshTrackedCompetitorSnapshots } from '@/lib/competitor-tracker'

// GET /api/cron/refresh-trends
// Limitált háttérfrissítés: csak a tracked_trend_candidates közül azokat
// frissíti, amiknek lejárt a next_check_at-ja, és csak a MÁR ISMERT
// youtube_video_ids statisztikáit kéri le újra (nincs új YouTube keresés).
// Cron-ból hívható (Vercel Cron / külső scheduler), CRON_SECRET fejléccel védve.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron/refresh-trends] CRON_SECRET nincs beállítva')
    return NextResponse.json({ error: 'Cron not configured' }, { status: 503 })
  }
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const [trendResult, competitorResult] = await Promise.allSettled([
      refreshDueCandidates(20),
      refreshTrackedCompetitorSnapshots(20),
    ])
    if (trendResult.status === 'rejected') console.error('[cron/refresh-trends] trend refresh failed:', trendResult.reason)
    if (competitorResult.status === 'rejected') console.error('[cron/refresh-trends] competitor refresh failed:', competitorResult.reason)
    const hasRejectedJob = trendResult.status === 'rejected' || competitorResult.status === 'rejected'
    return NextResponse.json({
      ok: !hasRejectedJob,
      trends: trendResult.status === 'fulfilled' ? trendResult.value : { processed: 0, updated: 0, failed: 1, skipped: 0 },
      competitors: competitorResult.status === 'fulfilled' ? competitorResult.value : { processed: 0, updated: 0, failed: 1 },
    }, { status: hasRejectedJob ? 500 : 200 })
  } catch (e) {
    // A schedulernek valódi hibastátusz kell, különben a monitor sikeresnek
    // tekintené a teljesen meghiúsult futást.
    console.error('[cron/refresh-trends] unexpected failure (non-blocking):', e)
    return NextResponse.json({ ok: false, processed: 0, updated: 0, failed: 1, skipped: 0 }, { status: 500 })
  }
}
