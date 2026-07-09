// ============================================================
// WILLVIRAL — Competitor Tracker + Outlier Detector (Phase 2 #2, #3)
// ============================================================
// Kvóta-tudatos: channels.list + playlistItems.list + videos.list = 3 egyseg
// osszesen egy csatorna ellenorzesehez, szemben a search.list 100 egysegevel.

import { getActiveApiKey } from '@/lib/youtube-service'
import { createAdminClient } from '@/lib/supabase-server'
import { ensureVideoIdea, addVideoIdeaProofSignal, logVideoIdeaEvent, buildVideoIdeaInputHash } from '@/lib/video-ideas/video-idea-service'

export interface ChannelSnapshot {
  channelId: string
  title: string
  thumbnail: string | null
  subscriberCount: number
  videoCount: number
  uploadsPlaylistId: string | null
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
  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&${param}&key=${apiKey}`)
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
  const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(parsed.value)}&key=${apiKey}`)
  const searchData = await searchRes.json()
  const channelId = searchData.items?.[0]?.snippet?.channelId || searchData.items?.[0]?.id?.channelId
  if (!channelId) return null
  return fetchChannelByParam(`id=${channelId}`, apiKey)
}

// Csatorna legutobbi videoi + statisztika + outlier-szamitas a csatorna
// sajat atlagahoz kepest ("4.2x jobban teljesit a csatorna atlaganal").
export async function fetchChannelRecentVideos(uploadsPlaylistId: string, maxResults = 10): Promise<CompetitorVideo[]> {
  const apiKey = getActiveApiKey()

  const playlistRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${apiKey}`)
  const playlistData = await playlistRes.json()
  const items = (playlistData.items || []) as Array<{ snippet: { title: string; publishedAt: string; resourceId: { videoId: string }; thumbnails?: { medium?: { url: string }; default?: { url: string } } } }>
  if (items.length === 0) return []

  const videoIds = items.map(i => i.snippet.resourceId.videoId).filter(Boolean)
  const statsRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(',')}&key=${apiKey}`)
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

  const avgViews = rawVideos.reduce((sum, v) => sum + v.viewCount, 0) / Math.max(1, rawVideos.length)

  return rawVideos.map(v => {
    const outlierRatio = avgViews > 0 ? v.viewCount / avgViews : 0
    return { ...v, outlierRatio: Math.round(outlierRatio * 100) / 100, isOutlier: outlierRatio >= 2.0 }
  })
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

  await addVideoIdeaProofSignal(admin, {
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
    reason: `${input.video.outlierRatio}x jobban teljesít a csatorna átlagánál`,
    payload: { outlier_ratio: input.video.outlierRatio },
  })

  await logVideoIdeaEvent(admin, {
    userId: input.userId,
    videoIdeaId: ideaResult.idea.id,
    eventType: 'competitor_outlier_saved',
    sourceTool: 'competitor_tracker',
    payload: { video_id: input.video.videoId, outlier_ratio: input.video.outlierRatio },
  })

  return { success: true, videoIdeaId: ideaResult.idea.id }
}
