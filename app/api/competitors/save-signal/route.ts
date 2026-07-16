import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { saveOutlierAsProofSignal } from '@/lib/competitor-tracker'
import { createAdminClient } from '@/lib/supabase-server'
import { topicInputTooLong } from '@/lib/api-input-validation'

// POST — egy kiugro versenytars-video mentese Video Idea proof signal-kent,
// hogy Viral Score/Video Package bemenetkent hasznalhato legyen. Kredit nelkul —
// mar meglevo, kifizetett adatot mentunk ujra.
export async function POST(request: NextRequest) {
  try {
    const { topic, platform, video } = await request.json()
    if (typeof topic !== 'string' || !topic.trim() || topicInputTooLong(topic) || typeof video?.videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(video.videoId)) {
      return NextResponse.json({ error: 'Hiányzó adatok' }, { status: 400 })
    }
    if (platform != null && platform !== 'youtube') return NextResponse.json({ error: 'Nem támogatott platform.' }, { status: 400 })
    const topicValue = topic.trim()

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: storedVideo } = await admin
      .from('tracked_competitor_videos')
      .select('tracked_competitor_id, video_id, title, view_count, published_at, outlier_ratio, is_outlier')
      .eq('user_id', userId)
      .eq('video_id', video.videoId)
      .single()
    if (!storedVideo || !storedVideo.is_outlier || !Number.isFinite(Number(storedVideo.outlier_ratio)) || Number(storedVideo.outlier_ratio) < 1) {
      return NextResponse.json({ error: 'A videó nem található a saját hitelesített outlier adataid között.' }, { status: 404 })
    }
    const { data: storedCompetitor } = await admin
      .from('tracked_competitors')
      .select('channel_title')
      .eq('id', storedVideo.tracked_competitor_id)
      .eq('user_id', userId)
      .single()
    if (!storedCompetitor) return NextResponse.json({ error: 'A versenytárs nem található.' }, { status: 404 })

    const result = await saveOutlierAsProofSignal({
      userId,
      topic: topicValue,
      platform: 'youtube',
      video: {
        videoId: storedVideo.video_id,
        title: storedVideo.title,
        viewCount: Number(storedVideo.view_count || 0),
        publishedAt: storedVideo.published_at,
        outlierRatio: Number(storedVideo.outlier_ratio),
      },
      channelTitle: storedCompetitor.channel_title || '',
    })

    if (!result.success) return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })
    return NextResponse.json({ success: true, video_idea_id: result.videoIdeaId })
  } catch (error) {
    console.error('Save outlier signal error:', error)
    return NextResponse.json({ error: 'Mentés sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
