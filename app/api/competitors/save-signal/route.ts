import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { saveOutlierAsProofSignal } from '@/lib/competitor-tracker'

// POST — egy kiugro versenytars-video mentese Video Idea proof signal-kent,
// hogy Viral Score/Video Package bemenetkent hasznalhato legyen. Kredit nelkul —
// mar meglevo, kifizetett adatot mentunk ujra.
export async function POST(request: NextRequest) {
  try {
    const { topic, platform, video, channel_title } = await request.json()
    if (!topic || !video?.videoId) {
      return NextResponse.json({ error: 'Hiányzó adatok' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const result = await saveOutlierAsProofSignal({
      userId,
      topic,
      platform: platform || 'youtube',
      video: {
        videoId: video.videoId,
        title: video.title,
        viewCount: video.viewCount,
        publishedAt: video.publishedAt,
        outlierRatio: video.outlierRatio,
      },
      channelTitle: channel_title || '',
    })

    if (!result.success) return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })
    return NextResponse.json({ success: true, video_idea_id: result.videoIdeaId })
  } catch (error) {
    console.error('Save outlier signal error:', error)
    return NextResponse.json({ error: 'Mentés sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
