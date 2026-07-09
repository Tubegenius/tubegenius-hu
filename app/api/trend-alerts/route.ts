import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { classifyAlerts, type TrackedTrendForAlert } from '@/lib/trend-alerts'

// GET — aktiv (meg nem elutasitott) trend riasztasok. Nincs kredit, nincs uj
// AI/YouTube hivas — a mar meglevo, cron/manualis frissitesekbol szarmazo
// snapshot-adatra epul.
export async function GET() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const admin = createAdminClient()

  const { data: candidates } = await admin
    .from('tracked_trend_candidates')
    .select('id, candidate_topic')
    .eq('user_id', user.id)
    .limit(50)

  const list = candidates || []
  if (list.length === 0) return NextResponse.json({ alerts: [] })

  const ids = list.map(c => c.id)
  const { data: snapshots } = await admin
    .from('trend_candidate_snapshots')
    .select('tracked_candidate_id, checked_at, total_views, views_delta, trend_status')
    .in('tracked_candidate_id', ids)
    .order('checked_at', { ascending: false })
    .limit(500)

  const snapshotsByCandidate = new Map<string, typeof snapshots>()
  for (const s of snapshots || []) {
    const arr = snapshotsByCandidate.get(s.tracked_candidate_id) || []
    if (arr.length < 2) arr.push(s)
    snapshotsByCandidate.set(s.tracked_candidate_id, arr)
  }

  const trackedForAlert: TrackedTrendForAlert[] = list.map(c => {
    const snaps = snapshotsByCandidate.get(c.id) || []
    const latest = snaps[0]
    return {
      id: c.id,
      candidate_topic: c.candidate_topic,
      trend_status: (latest?.trend_status as 'rising' | 'stable' | 'declining' | null) ?? null,
      views_delta: latest?.views_delta ?? null,
      total_views: latest?.total_views ?? null,
      snapshot_count: snaps.length,
      last_checked_at: latest?.checked_at ?? null,
    }
  })

  const candidateAlerts = classifyAlerts(trackedForAlert)
  if (candidateAlerts.length === 0) return NextResponse.json({ alerts: [] })

  const { data: dismissals } = await admin
    .from('trend_alert_dismissals')
    .select('tracked_candidate_id, alert_signature')
    .eq('user_id', user.id)
    .in('tracked_candidate_id', ids)

  const dismissedSignatures = new Set((dismissals || []).map(d => `${d.tracked_candidate_id}:${d.alert_signature}`))
  const activeAlerts = candidateAlerts.filter(a => !dismissedSignatures.has(`${a.candidate_id}:${a.alert_signature}`))

  return NextResponse.json({ alerts: activeAlerts })
}

// POST — egy riasztas elutasitasa (nem jelenik meg ujra, amig a trend
// allapota/nap nem valtozik — lasd buildAlertSignature).
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const { candidate_id, alert_signature } = await request.json()
  if (!candidate_id || !alert_signature) return NextResponse.json({ error: 'Hiányzó adatok' }, { status: 400 })

  const admin = createAdminClient()
  const { error } = await admin.from('trend_alert_dismissals').upsert({
    user_id: user.id,
    tracked_candidate_id: candidate_id,
    alert_signature,
  }, { onConflict: 'user_id,tracked_candidate_id,alert_signature' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
