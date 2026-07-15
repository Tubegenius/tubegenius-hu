import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { classifyAlerts, type AlertFrequency, type TrackedTrendForAlert } from '@/lib/trend-alerts'

// GET — aktiv (meg nem elutasitott) trend riasztasok. Nincs kredit, nincs uj
// AI/YouTube hivas — a mar meglevo, cron/manualis frissitesekbol szarmazo
// snapshot-adatra epul.
export async function GET() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const admin = createAdminClient()

  const { data: candidates, error: candidatesError } = await admin
    .from('tracked_trend_candidates')
    .select('id, candidate_topic, alert_frequency')
    .eq('user_id', user.id)
    .limit(50)
  if (candidatesError) return NextResponse.json({ error: 'A trendriasztások betöltése sikertelen.' }, { status: 500 })

  const list = candidates || []
  if (list.length === 0) return NextResponse.json({ alerts: [], monitors: [] })

  const ids = list.map(c => c.id)
  const { data: snapshots, error: snapshotsError } = await admin
    .from('trend_candidate_snapshots')
    .select('tracked_candidate_id, checked_at, total_views, views_delta, trend_velocity, trend_status')
    .in('tracked_candidate_id', ids)
    .order('checked_at', { ascending: false })
    .limit(500)
  if (snapshotsError) return NextResponse.json({ error: 'A trendriasztások előzményei nem tölthetők be.' }, { status: 500 })

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
      trend_velocity: latest?.trend_velocity == null ? null : Number(latest.trend_velocity),
      snapshot_count: snaps.length,
      last_checked_at: latest?.checked_at ?? null,
      alert_frequency: (c.alert_frequency as AlertFrequency) || 'daily',
    }
  })

  const candidateAlerts = classifyAlerts(trackedForAlert)
  const monitors = list.map(c => ({ candidate_id: c.id, candidate_topic: c.candidate_topic, alert_frequency: (c.alert_frequency as AlertFrequency) || 'daily' }))
  if (candidateAlerts.length === 0) return NextResponse.json({ alerts: [], monitors })

  const { data: dismissals, error: dismissalsError } = await admin
    .from('trend_alert_dismissals')
    .select('tracked_candidate_id, alert_signature')
    .eq('user_id', user.id)
    .in('tracked_candidate_id', ids)
  if (dismissalsError) return NextResponse.json({ error: 'A riasztási állapot nem tölthető be.' }, { status: 500 })

  const dismissedSignatures = new Set((dismissals || []).map(d => `${d.tracked_candidate_id}:${d.alert_signature}`))
  const activeAlerts = candidateAlerts.filter(a => !dismissedSignatures.has(`${a.candidate_id}:${a.alert_signature}`))

  return NextResponse.json({ alerts: activeAlerts, monitors })
}

export async function PATCH(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  const { candidate_id, alert_frequency } = await request.json()
  if (typeof candidate_id !== 'string' || !['daily', 'weekly', 'off'].includes(alert_frequency)) return NextResponse.json({ error: 'Hibás riasztási beállítás.' }, { status: 400 })
  const admin = createAdminClient()
  const { data, error } = await admin.from('tracked_trend_candidates').update({ alert_frequency }).eq('id', candidate_id).eq('user_id', user.id).select('id').single()
  if (error || !data) return NextResponse.json({ error: 'A riasztási beállítás mentése sikertelen.' }, { status: 500 })
  return NextResponse.json({ success: true })
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
  const { data: ownedCandidate } = await admin
    .from('tracked_trend_candidates')
    .select('id')
    .eq('id', candidate_id)
    .eq('user_id', user.id)
    .single()
  if (!ownedCandidate) return NextResponse.json({ error: 'A kovetett trend nem talalhato.' }, { status: 404 })
  const { error } = await admin.from('trend_alert_dismissals').upsert({
    user_id: user.id,
    tracked_candidate_id: candidate_id,
    alert_signature,
  }, { onConflict: 'user_id,tracked_candidate_id,alert_signature' })

  if (error) {
    console.error('[TrendAlerts] POST dismiss DB hiba:', error)
    return NextResponse.json({ error: 'A riasztás elutasítása sikertelen. Próbáld újra később.' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
