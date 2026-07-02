import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

// GET /api/dashboard/tracked-trends
// A user limitáltan trackelt trend candidate-jei + a legutóbbi 2 snapshot,
// hogy a dashboard trend_status / views_delta / engagement változást tudjon
// mutatni. Nincs mock adat — ha nincs tracked candidate, üres tömb jön vissza.
export async function GET() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: candidates } = await admin
    .from('tracked_trend_candidates')
    .select('id, candidate_topic, niche, region, confidence, trend_source_type, opportunity_score, created_at, last_checked_at, next_check_at, refresh_priority, status')
    .eq('user_id', user.id)
    .order('last_checked_at', { ascending: false, nullsFirst: false })
    .limit(20)

  const list = candidates || []
  if (list.length === 0) {
    return NextResponse.json({ tracked: [] })
  }

  const ids = list.map(c => c.id)
  const { data: snapshots } = await admin
    .from('trend_candidate_snapshots')
    .select('tracked_candidate_id, checked_at, total_views, engagement_rate, views_delta, trend_velocity, trend_status')
    .in('tracked_candidate_id', ids)
    .order('checked_at', { ascending: false })
    .limit(500)

  // Legfeljebb 10 legutóbbi snapshot candidate-enként — a delta-hoz elég 2, de
  // a sparkline-hoz (Sparkline.tsx) valódi, mért idősor kell.
  const snapshotsByCandidate = new Map<string, typeof snapshots>()
  for (const s of snapshots || []) {
    const arr = snapshotsByCandidate.get(s.tracked_candidate_id) || []
    if (arr.length < 10) arr.push(s)
    snapshotsByCandidate.set(s.tracked_candidate_id, arr)
  }

  const tracked = list.map(c => {
    const snaps = snapshotsByCandidate.get(c.id) || []
    const latest = snaps[0] || null
    const previous = snaps[1] || null
    const engagementDelta = latest?.engagement_rate != null && previous?.engagement_rate != null
      ? Math.round((latest.engagement_rate - previous.engagement_rate) * 100) / 100
      : null
    // Kronológiai sorrendbe (régi -> új) a sparkline-hoz
    const viewHistory = [...snaps].reverse().map(s => s.total_views ?? 0)

    return {
      id: c.id,
      candidate_topic: c.candidate_topic,
      niche: c.niche,
      region: c.region,
      confidence: c.confidence,
      trend_source_type: c.trend_source_type,
      opportunity_score: c.opportunity_score,
      created_at: c.created_at,
      last_checked_at: c.last_checked_at,
      next_check_at: c.next_check_at,
      refresh_priority: c.refresh_priority,
      status: c.status,
      snapshot_count: snaps.length,
      total_views: latest?.total_views ?? null,
      views_delta: latest?.views_delta ?? null,
      trend_velocity: latest?.trend_velocity ?? null,
      trend_status: latest?.trend_status ?? null,
      engagement_rate: latest?.engagement_rate ?? null,
      engagement_delta: engagementDelta,
      view_history: viewHistory,
    }
  })

  return NextResponse.json({ tracked })
}
