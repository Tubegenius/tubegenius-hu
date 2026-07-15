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
    return NextResponse.json({
      trends: trendResult.status === 'fulfilled' ? trendResult.value : { processed: 0, updated: 0, failed: 1, skipped: 0 },
      competitors: competitorResult.status === 'fulfilled' ? competitorResult.value : { processed: 0, updated: 0, failed: 1 },
    })
  } catch (e) {
    // A háttérfrissítés hibája soha nem törheti el a szolgáltatást —
    // itt csak logolunk és 200-at adunk vissza üres eredménnyel.
    console.error('[cron/refresh-trends] unexpected failure (non-blocking):', e)
    return NextResponse.json({ processed: 0, updated: 0, failed: 1, skipped: 0 })
  }
}
