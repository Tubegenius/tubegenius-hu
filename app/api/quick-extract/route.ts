import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getActiveApiKey } from '@/lib/youtube-service'

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

async function tryTranscript(videoId: string): Promise<{ available: boolean; text: string | null }> {
  try {
    const { YoutubeTranscript } = await import('youtube-transcript')
    const segments = await YoutubeTranscript.fetchTranscript(videoId)
    if (segments && segments.length > 0) {
      return { available: true, text: segments.map(s => s.text).join(' ') }
    }
    return { available: false, text: null }
  } catch {
    return { available: false, text: null }
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const { video_url } = await request.json()
    if (!video_url) return NextResponse.json({ error: 'video_url kotelezo' }, { status: 400 })

    const videoId = extractVideoId(video_url)
    if (!videoId) return NextResponse.json({ error: 'Ervenytelen YouTube URL' }, { status: 400 })

    const apiKey = getActiveApiKey()
    const [metaRes, transcriptResult] = await Promise.all([
      fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoId}&key=${apiKey}`),
      tryTranscript(videoId),
    ])

    const metaData = await metaRes.json()
    const item = metaData.items?.[0]
    if (!item) return NextResponse.json({ error: 'Video nem talalhato' }, { status: 404 })

    const snippet = item.snippet
    const stats = item.statistics

    return NextResponse.json({
      video_id: videoId,
      title: snippet.title,
      channel: snippet.channelTitle,
      url: video_url,
      thumbnail_url: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url,
      published_at: snippet.publishedAt,
      view_count: parseInt(stats.viewCount || '0'),
      like_count: parseInt(stats.likeCount || '0'),
      comment_count: parseInt(stats.commentCount || '0'),
      transcript_available: transcriptResult.available,
      transcript_source: transcriptResult.available ? 'transcript' : 'metadata',
      raw_transcript: transcriptResult.text?.slice(0, 12000) || null,
      key_points: [],
      hook: transcriptResult.text ? transcriptResult.text.slice(0, 200) : snippet.description?.slice(0, 200) || '',
    })
  } catch (error) {
    console.error('Quick extract error:', error)
    return NextResponse.json({ error: 'Kinyeres sikertelen' }, { status: 500 })
  }
}
