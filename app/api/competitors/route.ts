import { NextRequest, NextResponse } from 'next/server'
import { getUserId, checkPaidFeatureAccess, chargeFeature, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { createAdminClient } from '@/lib/supabase-server'
import { resolveChannel, fetchChannelRecentVideos } from '@/lib/competitor-tracker'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { calculateLatestViewsPerHour, calculateViewSampleOutliers, calculateWindowGrowth, type PerformancePoint } from '@/lib/competitor-performance'
import { topicInputTooLong } from '@/lib/api-input-validation'

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
  const snapshotsByCompetitor = new Map<string, PerformancePoint[]>()
  const snapshotsByVideo = new Map<string, PerformancePoint[]>()
  if (competitorIds.length > 0) {
    const { data: videos, error: videosError } = await admin
      .from('tracked_competitor_videos')
      .select('*')
      .in('tracked_competitor_id', competitorIds)
      .order('published_at', { ascending: false })
    if (videosError) {
      console.error('[Competitors] video load failed:', videosError)
      return NextResponse.json({ error: 'A versenytárs-videók betöltése sikertelen.' }, { status: 500 })
    }
    for (const v of videos || []) {
      const list = videosByCompetitor.get(v.tracked_competitor_id) || []
      if (list.length < 10) list.push(v)
      videosByCompetitor.set(v.tracked_competitor_id, list)
    }

    const since = new Date(Date.now() - 29 * 86_400_000).toISOString()
    const { data: snapshots, error: snapshotsError } = await admin
      .from('competitor_performance_snapshots')
      .select('tracked_competitor_id,video_id,view_count,subscriber_count,channel_total_views,checked_at')
      .eq('user_id', userId)
      .in('tracked_competitor_id', competitorIds)
      .gte('checked_at', since)
      .order('checked_at', { ascending: true })
    if (snapshotsError) {
      console.error('[Competitors] snapshot load failed:', snapshotsError)
      return NextResponse.json({ error: 'A versenytárs-teljesítmény betöltése sikertelen.' }, { status: 500 })
    }
    for (const point of snapshots || []) {
      const normalized: PerformancePoint = {
        checked_at: point.checked_at,
        view_count: Number(point.view_count),
        subscriber_count: point.subscriber_count == null ? null : Number(point.subscriber_count),
        channel_total_views: point.channel_total_views == null ? null : Number(point.channel_total_views),
      }
      if (point.video_id) {
        const key = `${point.tracked_competitor_id}:${point.video_id}`
        snapshotsByVideo.set(key, [...(snapshotsByVideo.get(key) || []), normalized])
      } else {
        snapshotsByCompetitor.set(point.tracked_competitor_id, [...(snapshotsByCompetitor.get(point.tracked_competitor_id) || []), normalized])
      }
    }
  }

  return NextResponse.json({
    competitors: (competitors || []).map(c => {
      const channelPoints = snapshotsByCompetitor.get(c.id) || []
      return {
        ...c,
        growth_7d: calculateWindowGrowth(channelPoints, 7),
        growth_14d: calculateWindowGrowth(channelPoints, 14),
        growth_28d: calculateWindowGrowth(channelPoints, 28),
        videos: (videosByCompetitor.get(c.id) || []).map((video: any) => ({
          ...video,
          views_per_hour: calculateLatestViewsPerHour(snapshotsByVideo.get(`${c.id}:${video.video_id}`) || []),
        })),
      }
    }),
  })
}

// POST — uj versenytars csatorna hozzaadasa: felderites + legutobbi videok +
// outlier-szamitas egy meneteben.
export async function POST(request: NextRequest) {
  try {
    const { channel_input, niche } = await request.json()
    if (!channel_input || typeof channel_input !== 'string' || !channel_input.trim()) {
      return NextResponse.json({ error: 'Csatorna URL, @handle vagy név megadása kötelező' }, { status: 400 })
    }
    if (channel_input.trim().length > 300) return NextResponse.json({ error: 'A csatornaazonosító legfeljebb 300 karakter lehet.' }, { status: 400 })
    if (niche != null && (typeof niche !== 'string' || topicInputTooLong(niche))) return NextResponse.json({ error: 'A niche legfeljebb 300 karakter lehet.' }, { status: 400 })
    const channelInput = channel_input.trim()
    const nicheValue = niche?.trim() || null

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const lock = await acquireRequestLock({ userId, toolType: 'competitor_add', inputHash: channelInput.toLowerCase() })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    const access = await checkPaidFeatureAccess(userId, 'competitor_add', request.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.competitor_add} kredit szükséges.` }, { status: 402 })
    }

    const channel = await resolveChannel(channelInput)
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
    const baselineViews = calculateViewSampleOutliers(videos.map(video => video.viewCount)).baseline_median_views

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
        niche: nicheValue,
        baseline_video_count: channel.videoCount,
        baseline_avg_views: baselineViews == null ? 0 : Math.round(baselineViews),
        baseline_subscriber_count: channel.subscriberCount,
        last_checked_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (insertError) {
      console.error('[Competitors] KRITIKUS: mentés sikertelen, a user már fizetett érte:', insertError)
      const refund = await refundCreditsAfterPersistenceFailure(userId, 'competitor_add', CREDIT_COSTS.competitor_add, { reason: 'competitor_save_failed' }, charge.credit_transaction_id)
      if (insertError.code === '23505' && refund.success) return NextResponse.json({ error: 'Ezt a csatornát már figyeled. A kreditet visszaadtuk.' }, { status: 409 })
      return NextResponse.json({ error: refund.success ? 'A mentés sikertelen volt, a kreditet visszaadtuk.' : 'A mentés és a kredit-visszatérítés sikertelen.' }, { status: 500 })
    }

    if (videos.length > 0) {
      const { error: videosError } = await admin.from('tracked_competitor_videos').insert(
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
      if (videosError) {
        await admin.from('tracked_competitors').delete().eq('id', competitor.id).eq('user_id', userId)
        const refund = await refundCreditsAfterPersistenceFailure(userId, 'competitor_add', CREDIT_COSTS.competitor_add, { reason: 'competitor_videos_save_failed' }, charge.credit_transaction_id)
        return NextResponse.json({ error: refund.success ? 'A videók mentése sikertelen volt, a kreditet visszaadtuk.' : 'A videók mentése és a kredit-visszatérítés sikertelen.' }, { status: 500 })
      }
    }

    const checkedAt = new Date().toISOString()
    const { error: snapshotError } = await admin.from('competitor_performance_snapshots').insert([
      { tracked_competitor_id: competitor.id, user_id: userId, video_id: null, view_count: 0, subscriber_count: channel.subscriberCount, channel_total_views: channel.totalViewCount, channel_video_count: channel.videoCount, checked_at: checkedAt },
      ...videos.map(v => ({ tracked_competitor_id: competitor.id, user_id: userId, video_id: v.videoId, view_count: v.viewCount, checked_at: checkedAt })),
    ])
    if (snapshotError) {
      await admin.from('tracked_competitors').delete().eq('id', competitor.id).eq('user_id', userId)
      const refund = await refundCreditsAfterPersistenceFailure(userId, 'competitor_add', CREDIT_COSTS.competitor_add, { reason: 'competitor_snapshot_save_failed' }, charge.credit_transaction_id)
      return NextResponse.json({ error: refund.success ? 'A teljesítmény-előzmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'A teljesítmény-előzmény mentése és a kredit-visszatérítés sikertelen.' }, { status: 500 })
    }

    return NextResponse.json({
      competitor: { ...competitor, videos },
      _credits_remaining: charge.new_balance,
    })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
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
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: 'Érvényes id kötelező' }, { status: 400 })

  const admin = createAdminClient()
  const { data, error } = await admin.from('tracked_competitors').delete().eq('id', id).eq('user_id', userId).select('id').maybeSingle()
  if (error) {
    console.error('[Competitors] DELETE DB hiba:', error)
    return NextResponse.json({ error: 'A versenytárs törlése sikertelen. Próbáld újra később.' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'A figyelt versenytárs nem található.' }, { status: 404 })

  return NextResponse.json({ success: true })
}
