import { NextRequest, NextResponse } from 'next/server'
import { getUserId, checkPaidFeatureAccess, chargeFeature, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { createAdminClient } from '@/lib/supabase-server'
import { resolveChannel, fetchChannelRecentVideos } from '@/lib/competitor-tracker'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { calculateViewSampleOutliers } from '@/lib/competitor-performance'

// POST — versenytars ujraellenorzese: friss videok + outlier ujraszamitas.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: competitor } = await admin
      .from('tracked_competitors')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (!competitor) return NextResponse.json({ error: 'A figyelt versenytárs nem található.' }, { status: 404 })

    const lock = await acquireRequestLock({ userId, toolType: 'outlier_scan', inputHash: competitor.id })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    const access = await checkPaidFeatureAccess(userId, 'outlier_scan', request.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.outlier_scan} kredit szükséges.` }, { status: 402 })
    }

    const channel = await resolveChannel(competitor.channel_id)
    const uploadsPlaylistId = channel?.uploadsPlaylistId
    if (!uploadsPlaylistId) {
      return NextResponse.json({ error: 'A csatorna adatai nem érhetők el.' }, { status: 502 })
    }

    const videos = await fetchChannelRecentVideos(uploadsPlaylistId, 10)
    const baselineViews = calculateViewSampleOutliers(videos.map(video => video.viewCount)).baseline_median_views

    const charge = await chargeFeature(userId, 'outlier_scan', { competitor_id: competitor.id })
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    if (videos.length > 0) {
      const { error: videosError } = await admin.from('tracked_competitor_videos').upsert(
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
        })),
        { onConflict: 'tracked_competitor_id,video_id' }
      )
      if (videosError) {
        const refund = await refundCreditsAfterPersistenceFailure(userId, 'outlier_scan', CREDIT_COSTS.outlier_scan, { reason: 'competitor_refresh_videos_save_failed' })
        return NextResponse.json({ error: refund.success ? 'A videók mentése sikertelen volt, a kreditet visszaadtuk.' : 'A videók mentése és a kredit-visszatérítés sikertelen.' }, { status: 500 })
      }
    }

    const checkedAt = new Date().toISOString()
    const { error: snapshotError } = await admin.from('competitor_performance_snapshots').insert([
      { tracked_competitor_id: competitor.id, user_id: userId, video_id: null, view_count: 0, subscriber_count: channel.subscriberCount, channel_total_views: channel.totalViewCount, channel_video_count: channel.videoCount, checked_at: checkedAt },
      ...videos.map(v => ({ tracked_competitor_id: competitor.id, user_id: userId, video_id: v.videoId, view_count: v.viewCount, checked_at: checkedAt })),
    ])
    if (snapshotError) {
      const refund = await refundCreditsAfterPersistenceFailure(userId, 'outlier_scan', CREDIT_COSTS.outlier_scan, { reason: 'competitor_snapshot_save_failed' })
      return NextResponse.json({ error: refund.success ? 'A teljesítmény-előzmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'A teljesítmény-előzmény mentése és a kredit-visszatérítés sikertelen.' }, { status: 500 })
    }

    const { error: competitorUpdateError } = await admin.from('tracked_competitors').update({
      baseline_avg_views: baselineViews == null ? 0 : Math.round(baselineViews),
      baseline_video_count: channel.videoCount ?? competitor.baseline_video_count,
      baseline_subscriber_count: channel.subscriberCount ?? competitor.baseline_subscriber_count,
      last_checked_at: checkedAt,
    }).eq('id', competitor.id).eq('user_id', userId)

    if (competitorUpdateError) {
      const refund = await refundCreditsAfterPersistenceFailure(userId, 'outlier_scan', CREDIT_COSTS.outlier_scan, { reason: 'competitor_refresh_save_failed' })
      return NextResponse.json({ error: refund.success ? 'A frissítés mentése sikertelen volt, a kreditet visszaadtuk.' : 'A frissítés mentése és a kredit-visszatérítés sikertelen.' }, { status: 500 })
    }

    return NextResponse.json({ videos, _credits_remaining: charge.new_balance })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Competitor refresh error:', error)
    return NextResponse.json({ error: 'Frissítés sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
