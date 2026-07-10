import { NextRequest, NextResponse } from 'next/server'
import { getUserId, hasEnoughCredits, chargeFeature, CREDIT_COSTS } from '@/lib/credits'
import { createAdminClient } from '@/lib/supabase-server'
import { resolveChannel, fetchChannelRecentVideos } from '@/lib/competitor-tracker'

// GET — figyelt versenytársak listája, a legutóbbi (mentett) videóikkal együtt.
export async function GET() {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const admin = createAdminClient()
  const { data: competitors, error } = await admin
    .from('tracked_competitors')
    .select('*')
    .eq('user_id', userId)
    .order('added_at', { ascending: false })

  if (error) {
    console.error('[Competitors] GET DB hiba:', error)
    return NextResponse.json({ error: 'A versenytársak betöltése sikertelen. Próbáld újra később.' }, { status: 500 })
  }

  const competitorIds = (competitors || []).map(c => c.id)
  let videosByCompetitor = new Map<string, unknown[]>()
  if (competitorIds.length > 0) {
    const { data: videos } = await admin
      .from('tracked_competitor_videos')
      .select('*')
      .in('tracked_competitor_id', competitorIds)
      .order('published_at', { ascending: false })
    for (const v of videos || []) {
      const list = videosByCompetitor.get(v.tracked_competitor_id) || []
      if (list.length < 10) list.push(v)
      videosByCompetitor.set(v.tracked_competitor_id, list)
    }
  }

  return NextResponse.json({
    competitors: (competitors || []).map(c => ({ ...c, videos: videosByCompetitor.get(c.id) || [] })),
  })
}

// POST — uj versenytars csatorna hozzaadasa: felderites + legutobbi videok +
// outlier-szamitas egy meneteben.
export async function POST(request: NextRequest) {
  try {
    const { channel_input, niche } = await request.json()
    if (!channel_input || typeof channel_input !== 'string') {
      return NextResponse.json({ error: 'Csatorna URL, @handle vagy név megadása kötelező' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const enoughCredits = await hasEnoughCredits(userId, 'competitor_add')
    if (!enoughCredits) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.competitor_add} kredit szükséges.` }, { status: 402 })
    }

    const channel = await resolveChannel(channel_input)
    if (!channel) {
      return NextResponse.json({ error: 'A csatorna nem található. Ellenőrizd az URL-t vagy a nevet.' }, { status: 404 })
    }

    const admin = createAdminClient()

    const { data: existing } = await admin
      .from('tracked_competitors')
      .select('id')
      .eq('user_id', userId)
      .eq('channel_id', channel.channelId)
      .eq('platform', 'youtube')
      .single()

    if (existing) {
      return NextResponse.json({ error: 'Ezt a csatornát már figyeled.' }, { status: 409 })
    }

    const videos = channel.uploadsPlaylistId ? await fetchChannelRecentVideos(channel.uploadsPlaylistId, 10) : []
    const avgViews = videos.length > 0 ? Math.round(videos.reduce((sum, v) => sum + v.viewCount, 0) / videos.length) : 0

    const charge = await chargeFeature(userId, 'competitor_add', { channel_id: channel.channelId })
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    const { data: competitor, error: insertError } = await admin
      .from('tracked_competitors')
      .insert({
        user_id: userId,
        channel_id: channel.channelId,
        channel_title: channel.title,
        channel_thumbnail: channel.thumbnail,
        channel_url: `https://youtube.com/channel/${channel.channelId}`,
        platform: 'youtube',
        niche: niche || null,
        baseline_video_count: channel.videoCount,
        baseline_avg_views: avgViews,
        baseline_subscriber_count: channel.subscriberCount,
        last_checked_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (insertError) {
      console.error('[Competitors] KRITIKUS: mentés sikertelen, a user már fizetett érte:', insertError)
      return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })
    }

    if (videos.length > 0) {
      await admin.from('tracked_competitor_videos').insert(
        videos.map(v => ({
          tracked_competitor_id: competitor.id,
          user_id: userId,
          video_id: v.videoId,
          title: v.title,
          thumbnail_url: v.thumbnailUrl,
          view_count: v.viewCount,
          like_count: v.likeCount,
          comment_count: v.commentCount,
          published_at: v.publishedAt,
          outlier_ratio: v.outlierRatio,
          is_outlier: v.isOutlier,
        }))
      )
    }

    return NextResponse.json({
      competitor: { ...competitor, videos },
      _credits_remaining: charge.new_balance,
    })
  } catch (error) {
    console.error('Competitor add error:', error)
    return NextResponse.json({ error: 'Versenytárs hozzáadása sikertelen. Próbáld újra.' }, { status: 500 })
  }
}

// DELETE — versenytárs eltávolítása a figyelésből.
export async function DELETE(request: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const { id } = await request.json()
  if (!id) return NextResponse.json({ error: 'id kötelező' }, { status: 400 })

  const admin = createAdminClient()
  const { error } = await admin.from('tracked_competitors').delete().eq('id', id).eq('user_id', userId)
  if (error) {
    console.error('[Competitors] DELETE DB hiba:', error)
    return NextResponse.json({ error: 'A versenytárs törlése sikertelen. Próbáld újra később.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
