// ============================================================
// WILLVIRAL — Competitor Tracker + Outlier Detector (Phase 2 #2, #3)
// ============================================================
// Kvóta-tudatos: channels.list + playlistItems.list + videos.list = 3 egyseg
// osszesen egy csatorna ellenorzesehez, szemben a search.list 100 egysegevel.

import { getActiveApiKey } from '@/lib/youtube-service'
import { createAdminClient } from '@/lib/supabase-server'
import { ensureVideoIdea, addVideoIdeaProofSignal, logVideoIdeaEvent, buildVideoIdeaInputHash } from '@/lib/video-ideas/video-idea-service'
import { calculateViewSampleOutliers } from '@/lib/competitor-performance'

export interface ChannelSnapshot {
  channelId: string
  title: string
  thumbnail: string | null
  subscriberCount: number
  videoCount: number
  uploadsPlaylistId: string | null
  customUrl: string | null
  thumbnailHigh: string | null
  publishedAt: string | null
  country: string | null
  totalViewCount: number
}

export interface CompetitorVideo {
  videoId: string
  title: string
  thumbnailUrl: string
  viewCount: number
  likeCount: number
  commentCount: number
  publishedAt: string
  outlierRatio: number
  isOutlier: boolean
}

function extractChannelIdOrHandle(input: string): { type: 'id' | 'handle' | 'query'; value: string } {
  const trimmed = input.trim()
  const urlMatch = trimmed.match(/youtube\.com\/(channel\/(UC[\w-]{22})|@([\w.-]+)|c\/([\w.-]+)|user\/([\w.-]+))/)
  if (urlMatch) {
    if (urlMatch[2]) return { type: 'id', value: urlMatch[2] }
    const handle = urlMatch[3] || urlMatch[4] || urlMatch[5]
    return { type: 'handle', value: handle }
  }
  if (/^UC[\w-]{22}$/.test(trimmed)) return { type: 'id', value: trimmed }
  if (trimmed.startsWith('@')) return { type: 'handle', value: trimmed.slice(1) }
  return { type: 'query', value: trimmed }
}

async function fetchChannelByParam(param: string, apiKey: string): Promise<ChannelSnapshot | null> {
  const res = await fetchExternal('YouTube', `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&${param}&key=${apiKey}`)
  if (!res.ok) throw new Error(`YouTube channels request failed: ${res.status}`)
  const data = await res.json()
  const item = data.items?.[0]
  if (!item) return null
  return {
    channelId: item.id,
    title: item.snippet?.title || '',
    thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
    subscriberCount: parseInt(item.statistics?.subscriberCount || '0'),
    videoCount: parseInt(item.statistics?.videoCount || '0'),
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
    customUrl: item.snippet?.customUrl || null,
    thumbnailHigh: item.snippet?.thumbnails?.high?.url || null,
    publishedAt: item.snippet?.publishedAt || null,
    country: item.snippet?.country || null,
    totalViewCount: parseInt(item.statistics?.viewCount || '0'),
  }
}

// Elfogad csatorna URL-t, @handle-t, nyers channel ID-t vagy csatornanevet.
export async function resolveChannel(input: string): Promise<ChannelSnapshot | null> {
  const apiKey = getActiveApiKey()
  const parsed = extractChannelIdOrHandle(input)

  if (parsed.type === 'id') {
    return fetchChannelByParam(`id=${parsed.value}`, apiKey)
  }
  if (parsed.type === 'handle') {
    const byHandle = await fetchChannelByParam(`forHandle=${encodeURIComponent('@' + parsed.value)}`, apiKey)
    if (byHandle) return byHandle
  }
  // Fallback: search.list csatorna nevre — dragabb (100 egyseg), csak akkor
  // hasznaljuk, ha a handle/id alapu felismeres nem sikerult.
  const searchRes = await fetchExternal('YouTube', `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(parsed.value)}&key=${apiKey}`)
  if (!searchRes.ok) throw new Error(`YouTube channel search failed: ${searchRes.status}`)
  const searchData = await searchRes.json()
  const channelId = searchData.items?.[0]?.snippet?.channelId || searchData.items?.[0]?.id?.channelId
  if (!channelId) return null
  return fetchChannelByParam(`id=${channelId}`, apiKey)
}

// Csatorna legutobbi videoi + statisztika + outlier-szamitas a csatorna
// sajat atlagahoz kepest ("4.2x jobban teljesit a csatorna atlaganal").
export async function fetchChannelRecentVideos(uploadsPlaylistId: string, maxResults = 10): Promise<CompetitorVideo[]> {
  const apiKey = getActiveApiKey()

  const playlistRes = await fetchExternal('YouTube', `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${apiKey}`)
  if (!playlistRes.ok) throw new Error(`YouTube playlist request failed: ${playlistRes.status}`)
  const playlistData = await playlistRes.json()
  const items = (playlistData.items || []) as Array<{ snippet: { title: string; publishedAt: string; resourceId: { videoId: string }; thumbnails?: { medium?: { url: string }; default?: { url: string } } } }>
  if (items.length === 0) return []

  const videoIds = items.map(i => i.snippet.resourceId.videoId).filter(Boolean)
  const statsRes = await fetchExternal('YouTube', `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(',')}&key=${apiKey}`)
  if (!statsRes.ok) throw new Error(`YouTube video stats request failed: ${statsRes.status}`)
  const statsData = await statsRes.json()
  const statsMap = new Map<string, { viewCount?: string; likeCount?: string; commentCount?: string }>(
    (statsData.items || []).map((v: { id: string; statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }) => [v.id, v.statistics])
  )

  const rawVideos = items.map(item => {
    const stats = statsMap.get(item.snippet.resourceId.videoId)
    return {
      videoId: item.snippet.resourceId.videoId,
      title: item.snippet.title,
      thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
      viewCount: parseInt(stats?.viewCount || '0'),
      likeCount: parseInt(stats?.likeCount || '0'),
      commentCount: parseInt(stats?.commentCount || '0'),
      publishedAt: item.snippet.publishedAt,
    }
  })

  const outlierResult = calculateViewSampleOutliers(rawVideos.map(video => video.viewCount))

  return rawVideos.map((video, index) => ({ ...video, outlierRatio: outlierResult.ratios[index], isOutlier: outlierResult.outliers[index] }))
}

export function isCompetitorSnapshotDue(lastCheckedAt: string | null, now = Date.now(), intervalHours = 20): boolean {
  if (!lastCheckedAt) return true
  const checked = new Date(lastCheckedAt).getTime()
  return !Number.isFinite(checked) || checked <= now - intervalHours * 3_600_000
}

// Napi, kreditmentes háttérmérés. Nem keres új csatornákat: csak a már figyelt
// channel ID-ket és upload playlistjeiket frissíti, így a YouTube-kvóta tervezhető.
export async function refreshTrackedCompetitorSnapshots(limit = 20) {
  const admin = createAdminClient()
  const cutoff = new Date(Date.now() - 20 * 3_600_000).toISOString()
  const { data: competitors, error } = await admin
    .from('tracked_competitors')
    .select('id,user_id,channel_id,last_checked_at')
    .or(`last_checked_at.is.null,last_checked_at.lte.${cutoff}`)
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(Math.max(1, Math.min(limit, 50)))
  if (error) throw error

  const result = { processed: 0, updated: 0, failed: 0 }
  for (const competitor of competitors || []) {
    result.processed++
    try {
      const channel = await resolveChannel(competitor.channel_id)
      if (!channel?.uploadsPlaylistId) throw new Error('Missing uploads playlist')
      const videos = await fetchChannelRecentVideos(channel.uploadsPlaylistId, 10)
      const baselineViews = calculateViewSampleOutliers(videos.map(video => video.viewCount)).baseline_median_views
      const checkedAt = new Date().toISOString()
      if (videos.length) {
        const { error: videosError } = await admin.from('tracked_competitor_videos').upsert(videos.map(video => ({
          tracked_competitor_id: competitor.id, user_id: competitor.user_id, video_id: video.videoId,
          title: video.title, thumbnail_url: video.thumbnailUrl, view_count: video.viewCount,
          like_count: video.likeCount, comment_count: video.commentCount, published_at: video.publishedAt,
          outlier_ratio: video.outlierRatio, is_outlier: video.isOutlier,
        })), { onConflict: 'tracked_competitor_id,video_id' })
        if (videosError) throw videosError
      }

      const { error: snapshotError } = await admin.from('competitor_performance_snapshots').insert([
        { tracked_competitor_id: competitor.id, user_id: competitor.user_id, video_id: null, view_count: 0, subscriber_count: channel.subscriberCount, channel_total_views: channel.totalViewCount, channel_video_count: channel.videoCount, checked_at: checkedAt },
        ...videos.map(video => ({ tracked_competitor_id: competitor.id, user_id: competitor.user_id, video_id: video.videoId, view_count: video.viewCount, checked_at: checkedAt })),
      ])
      if (snapshotError) throw snapshotError

      // last_checked_at kerül utoljára mentésre: ha bármely előző írás hibázik,
      // a következő cron újrapróbálhatja a csatornát.
      const { error: updateError } = await admin.from('tracked_competitors').update({
        baseline_avg_views: baselineViews == null ? 0 : Math.round(baselineViews),
        baseline_video_count: channel.videoCount,
        baseline_subscriber_count: channel.subscriberCount,
        last_checked_at: checkedAt,
      }).eq('id', competitor.id).eq('user_id', competitor.user_id)
      if (updateError) throw updateError
      result.updated++
    } catch (refreshError) {
      result.failed++
      console.error('[competitor-snapshots] refresh failed:', competitor.id, refreshError)
    }
  }
  return result
}

// A kiugró (outlier) versenytárs-videó Video Idea proof signal-kent mentese —
// a mar bevalt mintat koveti (viral-score/similar-videos ugyanigy csinalja).
export async function saveOutlierAsProofSignal(input: {
  userId: string
  topic: string
  platform: string
  video: { videoId: string; title: string; viewCount: number; publishedAt: string; outlierRatio: number }
  channelTitle: string
}) {
  const admin = createAdminClient()
  const videoIdeaHash = buildVideoIdeaInputHash({ userId: input.userId, topic: input.topic, platform: input.platform })
  const ideaResult = await ensureVideoIdea(admin, {
    userId: input.userId,
    topic: input.topic,
    platform: input.platform,
    inputHash: videoIdeaHash,
    workflowStatus: 'validating',
  })
  if (!ideaResult.success || !ideaResult.idea) return { success: false }

  const proofResult = await addVideoIdeaProofSignal(admin, {
    userId: input.userId,
    videoIdeaId: ideaResult.idea.id,
    signalType: 'competitor_video',
    sourceTool: 'competitor_tracker',
    sourceId: input.video.videoId,
    title: input.video.title,
    url: `https://youtube.com/watch?v=${input.video.videoId}`,
    channelTitle: input.channelTitle,
    publishedAt: input.video.publishedAt,
    viewCount: input.video.viewCount,
    strength: input.video.outlierRatio >= 3 ? 'strong' : 'medium',
    reason: `Jelenlegi nézettsége ${input.video.outlierRatio}x a legutóbbi videóminta mediánjához képest`,
    payload: { outlier_ratio: input.video.outlierRatio, basis: 'recent_upload_view_median', age_normalized: false },
  })
  if (!proofResult.success) return { success: false }

  await logVideoIdeaEvent(admin, {
    userId: input.userId,
    videoIdeaId: ideaResult.idea.id,
    eventType: 'competitor_outlier_saved',
    sourceTool: 'competitor_tracker',
    payload: { video_id: input.video.videoId, outlier_ratio: input.video.outlierRatio },
  })

  return { success: true, videoIdeaId: ideaResult.idea.id }
}
import { fetchExternal } from './external-fetch'
