import { NextRequest, NextResponse } from 'next/server'
import { getUserId, hasEnoughCredits, chargeFeature, CREDIT_COSTS } from '@/lib/credits'
import { createAdminClient } from '@/lib/supabase-server'
import { resolveChannel, fetchChannelRecentVideos } from '@/lib/competitor-tracker'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'

// POST — versenytars ujraellenorzese: friss videok + outlier ujraszamitas.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: competitor } = await admin
      .from('tracked_competitors')
      .select('*')
      .eq('id', params.id)
      .eq('user_id', userId)
      .single()

    if (!competitor) return NextResponse.json({ error: 'A figyelt versenytárs nem található.' }, { status: 404 })

    const lock = await acquireRequestLock({ userId, toolType: 'outlier_scan', inputHash: competitor.id })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    const enoughCredits = await hasEnoughCredits(userId, 'outlier_scan')
    if (!enoughCredits) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.outlier_scan} kredit szükséges.` }, { status: 402 })
    }

    const channel = await resolveChannel(competitor.channel_id)
    const uploadsPlaylistId = channel?.uploadsPlaylistId
    if (!uploadsPlaylistId) {
      return NextResponse.json({ error: 'A csatorna adatai nem érhetők el.' }, { status: 502 })
    }

    const videos = await fetchChannelRecentVideos(uploadsPlaylistId, 10)
    const avgViews = videos.length > 0 ? Math.round(videos.reduce((sum, v) => sum + v.viewCount, 0) / videos.length) : 0

    const charge = await chargeFeature(userId, 'outlier_scan', { competitor_id: competitor.id })
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    await admin.from('tracked_competitors').update({
      baseline_avg_views: avgViews,
      baseline_video_count: channel?.videoCount ?? competitor.baseline_video_count,
      baseline_subscriber_count: channel?.subscriberCount ?? competitor.baseline_subscriber_count,
      last_checked_at: new Date().toISOString(),
    }).eq('id', competitor.id)

    if (videos.length > 0) {
      await admin.from('tracked_competitor_videos').upsert(
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
