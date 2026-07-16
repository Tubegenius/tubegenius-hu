import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

// GET /api/dashboard/tracked-trends/videos?id=<tracked_candidate_id>
// Ingyenes bizonyíték-lista: a tracked_trend_candidates MÁR ISMERT
// youtube_video_ids és web_source_ids mezőiből olvas. NINCS új YouTube API hívás,
// NINCS Claude hívás, NINCS kreditlevonás — ez csak adatbázis-olvasás.
export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const candidateId = searchParams.get('id')
  if (candidateId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateId)) {
    return NextResponse.json({ error: 'Invalid trend identifier.' }, { status: 400 })
  }
  if (!candidateId) return NextResponse.json({ error: 'id megadása kötelező' }, { status: 400 })

  const admin = createAdminClient()

  const { data: candidate, error: candidateError } = await admin
    .from('tracked_trend_candidates')
    .select('id, candidate_topic, youtube_video_ids, web_source_ids')
    .eq('id', candidateId)
    .eq('user_id', user.id)
    .single()

  if (candidateError) {
    if (candidateError.code === 'PGRST116') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ error: 'Failed to load trend evidence.' }, { status: 500 })
  }

  if (!candidate) return NextResponse.json({ error: 'Nem található' }, { status: 404 })

  const rawWebSources: Array<string | { title?: string; url?: string; link?: string; snippet?: string; source?: string; date?: string }> =
    Array.isArray(candidate.web_source_ids) ? candidate.web_source_ids : []
  const web_sources = rawWebSources
    .map(item => {
      if (typeof item === 'string') {
        let source = ''
        try { source = new URL(item).hostname.replace(/^www\./, '') } catch {}
        return { title: source || item, url: item, snippet: '', source, date: '' }
      }
      const url = item.url || item.link || ''
      if (!url) return null
      let source = item.source || ''
      if (!source) {
        try { source = new URL(url).hostname.replace(/^www\./, '') } catch {}
      }
      return {
        title: item.title || source || url,
        url,
        snippet: item.snippet || '',
        source,
        date: item.date || '',
      }
    })
    .filter((item): item is { title: string; url: string; snippet: string; source: string; date: string } => !!item)

  const videoIds: string[] = Array.isArray(candidate.youtube_video_ids)
    ? candidate.youtube_video_ids.filter((id: unknown): id is string => typeof id === 'string' && /^[\w-]{11}$/.test(id)).slice(0, 50)
    : []
  if (videoIds.length === 0) {
    return NextResponse.json({ videos: [], web_sources, candidate_topic: candidate.candidate_topic })
  }

  const [{ data: videoRows, error: videosError }, { data: snapshotRows, error: snapshotsError }] = await Promise.all([
    admin.from('youtube_videos').select('video_id, title, channel_id, channel_title, published_at').in('video_id', videoIds),
    admin.from('youtube_video_snapshots').select('video_id, view_count, like_count, comment_count, checked_at').in('video_id', videoIds).order('checked_at', { ascending: false }),
  ])
  if (videosError || snapshotsError) return NextResponse.json({ error: 'Failed to load trend video evidence.' }, { status: 500 })

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

  return NextResponse.json({ videos, web_sources, candidate_topic: candidate.candidate_topic })
}
