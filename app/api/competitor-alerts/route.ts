import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, createServerSupabaseClient } from '@/lib/supabase-server'
import { calculateLatestViewsPerHour, type PerformancePoint } from '@/lib/competitor-performance'
import { classifyCompetitorVphAlerts } from '@/lib/competitor-alerts'
import type { AlertFrequency } from '@/lib/trend-alerts'

async function authenticatedUser() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function GET() {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  const admin = createAdminClient()
  const { data: competitors, error } = await admin.from('tracked_competitors').select('id,channel_title,alert_frequency,vph_alert_threshold').eq('user_id', user.id).limit(50)
  if (error) return NextResponse.json({ error: 'A competitor-riasztások betöltése sikertelen.' }, { status: 500 })
  if (!competitors?.length) return NextResponse.json({ alerts: [], monitors: [] })
  const ids = competitors.map(c => c.id)
  const since = new Date(Date.now() - 8 * 86_400_000).toISOString()
  const [{ data: videos, error: videosError }, { data: snapshots, error: snapshotsError }, { data: dismissals, error: dismissalsError }] = await Promise.all([
    admin.from('tracked_competitor_videos').select('tracked_competitor_id,video_id,title').eq('user_id', user.id).in('tracked_competitor_id', ids),
    admin.from('competitor_performance_snapshots').select('tracked_competitor_id,video_id,view_count,checked_at').eq('user_id', user.id).in('tracked_competitor_id', ids).not('video_id', 'is', null).gte('checked_at', since).order('checked_at', { ascending: true }).limit(2000),
    admin.from('competitor_alert_dismissals').select('tracked_competitor_id,video_id,alert_signature').eq('user_id', user.id).in('tracked_competitor_id', ids),
  ])
  if (videosError || snapshotsError || dismissalsError) return NextResponse.json({ error: 'A competitor-riasztások előzményei nem tölthetők be.' }, { status: 500 })
  const points = new Map<string, PerformancePoint[]>()
  for (const snapshot of snapshots || []) {
    const key = `${snapshot.tracked_competitor_id}:${snapshot.video_id}`
    points.set(key, [...(points.get(key) || []), { checked_at: snapshot.checked_at, view_count: Number(snapshot.view_count) }])
  }
  const byId = new Map(competitors.map(c => [c.id, c]))
  const candidates = (videos || []).map(video => {
    const competitor = byId.get(video.tracked_competitor_id)!
    const videoPoints = points.get(`${video.tracked_competitor_id}:${video.video_id}`) || []
    return {
      competitor_id: competitor.id, channel_title: competitor.channel_title, video_id: video.video_id, video_title: video.title,
      views_per_hour: calculateLatestViewsPerHour(videoPoints), threshold: Number(competitor.vph_alert_threshold || 100),
      alert_frequency: (competitor.alert_frequency as AlertFrequency) || 'daily', checked_at: videoPoints.at(-1)?.checked_at || null,
    }
  })
  const dismissed = new Set((dismissals || []).map(d => `${d.tracked_competitor_id}:${d.video_id}:${d.alert_signature}`))
  const alerts = classifyCompetitorVphAlerts(candidates).filter(a => !dismissed.has(`${a.competitor_id}:${a.video_id}:${a.alert_signature}`))
  const monitors = competitors.map(c => ({ competitor_id: c.id, channel_title: c.channel_title, alert_frequency: (c.alert_frequency as AlertFrequency) || 'daily', vph_alert_threshold: Number(c.vph_alert_threshold || 100) }))
  return NextResponse.json({ alerts, monitors })
}

export async function PATCH(request: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  const { competitor_id, alert_frequency, vph_alert_threshold } = await request.json()
  const threshold = Number(vph_alert_threshold)
  if (typeof competitor_id !== 'string' || !['daily', 'weekly', 'off'].includes(alert_frequency) || !Number.isFinite(threshold) || threshold < 1 || threshold > 1_000_000_000) return NextResponse.json({ error: 'Hibás competitor-riasztási beállítás.' }, { status: 400 })
  const admin = createAdminClient()
  const { data, error } = await admin.from('tracked_competitors').update({ alert_frequency, vph_alert_threshold: threshold }).eq('id', competitor_id).eq('user_id', user.id).select('id').single()
  if (error || !data) return NextResponse.json({ error: 'A competitor-riasztási beállítás mentése sikertelen.' }, { status: 500 })
  return NextResponse.json({ success: true })
}

export async function POST(request: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  const { competitor_id, video_id, alert_signature } = await request.json()
  if (![competitor_id, video_id, alert_signature].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) return NextResponse.json({ error: 'Hiányzó vagy hibás adatok.' }, { status: 400 })
  const admin = createAdminClient()
  const { data: owned } = await admin.from('tracked_competitors').select('id').eq('id', competitor_id).eq('user_id', user.id).single()
  if (!owned) return NextResponse.json({ error: 'A figyelt versenytárs nem található.' }, { status: 404 })
  const { data: ownedVideo } = await admin.from('tracked_competitor_videos').select('video_id').eq('tracked_competitor_id', competitor_id).eq('user_id', user.id).eq('video_id', video_id).single()
  if (!ownedVideo) return NextResponse.json({ error: 'A competitor-videó nem található.' }, { status: 404 })
  const { error } = await admin.from('competitor_alert_dismissals').upsert({ user_id: user.id, tracked_competitor_id: competitor_id, video_id, alert_signature }, { onConflict: 'user_id,tracked_competitor_id,video_id,alert_signature' })
  if (error) return NextResponse.json({ error: 'A competitor-riasztás elutasítása sikertelen.' }, { status: 500 })
  return NextResponse.json({ success: true })
}
