import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

// GET /api/dashboard/tracked-trends/videos?id=<tracked_candidate_id>
// A "Videók megnyitása" gomb ingyenes verziója — a tracked_trend_candidates
// tábla youtube_video_ids mezőjéhez tartozó, MÁR ISMERT (passzívan a
// youtube_videos/youtube_video_snapshots táblákba korábban elmentett)
// videóadatot adja vissza. NINCS új YouTube API hívás, NINCS Claude hívás,
// NINCS kreditlevonás — ez csak egy adatbázis-olvasás.
export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const candidateId = searchParams.get('id')
  if (!candidateId) return NextResponse.json({ error: 'id megadása kötelező' }, { status: 400 })

  const admin = createAdminClient()

  const { data: candidate } = await admin
    .from('tracked_trend_candidates')
    .select('id, candidate_topic, youtube_video_ids')
    .eq('id', candidateId)
    .eq('user_id', user.id)
    .single()

  if (!candidate) return NextResponse.json({ error: 'Nem található' }, { status: 404 })

  const videoIds: string[] = (candidate.youtube_video_ids || []).filter(Boolean)
  if (videoIds.length === 0) {
    return NextResponse.json({ videos: [], candidate_topic: candidate.candidate_topic })
  }

  const [{ data: videoRows }, { data: snapshotRows }] = await Promise.all([
    admin.from('youtube_videos').select('video_id, title, channel_id, channel_title, published_at').in('video_id', videoIds),
    admin.from('youtube_video_snapshots').select('video_id, view_count, like_count, comment_count, checked_at').in('video_id', videoIds).order('checked_at', { ascending: false }),
  ])

  const latestSnapshotByVideo = new Map<string, { view_count: number; like_count: number; comment_count: number; checked_at: string }>()
  for (const s of snapshotRows || []) {
    if (!latestSnapshotByVideo.has(s.video_id)) latestSnapshotByVideo.set(s.video_id, s)
  }

  const videos = (videoRows || []).map(v => {
    const snap = latestSnapshotByVideo.get(v.video_id)
    return {
      video_id: v.video_id,
      title: v.title,
      channel_title: v.channel_title,
      published_at: v.published_at,
      url: `https://youtube.com/watch?v=${v.video_id}`,
      thumbnail_url: `https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg`,
      view_count: snap?.view_count ?? null,
      like_count: snap?.like_count ?? null,
      comment_count: snap?.comment_count ?? null,
      last_checked_at: snap?.checked_at ?? null,
    }
  }).sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0))

  return NextResponse.json({ videos, candidate_topic: candidate.candidate_topic })
}
