import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { chargeFeature, checkPaidFeatureAccess } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { youtubeSearch, youtubeStats } from '@/lib/youtube-service'
import { recordVideoSnapshots } from '@/lib/youtube-snapshot'
import { calcSearchRelevance, type YouTubeVideoStats } from '@/lib/opportunity-scoring'
import { refreshTrackedCandidateNow } from '@/lib/trend-tracking'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type WebSource = { title: string; url: string; snippet?: string; source?: string; date?: string }

type CandidateRow = {
  id: string
  user_id: string
  candidate_topic: string
  niche: string | null
  region: string | null
  language: string | null
  youtube_video_ids: unknown
  web_source_ids: unknown
}

const MAX_STORED_VIDEOS = 12
const MAX_STORED_WEB_SOURCES = 8
const MIN_VIDEO_RELEVANCE = 45
const MIN_WEB_RELEVANCE = 35

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function topicWords(topic: string): string[] {
  const stop = new Set(['egy', 'van', 'vagy', 'hogy', 'mint', 'the', 'and', 'for', 'with', 'why', 'how', 'what', 'new', 'news', 'video'])
  return normalizeText(topic).split(' ').filter(w => w.length >= 3 && !stop.has(w))
}

function textRelevance(text: string, topic: string): number {
  const words = topicWords(topic)
  if (words.length === 0) return 50
  const haystack = normalizeText(text)
  const matches = words.filter(w => haystack.includes(w)).length
  const ratio = matches / words.length
  return Math.round(Math.max(0, Math.min(100, ratio * 100)))
}

function regionSettings(region: string | null, language: string | null) {
  const isHu = (region || '').toUpperCase() === 'HU' || (language || '').toLowerCase().startsWith('hu')
  return {
    youtubeRegion: isHu ? 'HU' : 'US',
    youtubeLang: isHu ? 'hu' : 'en',
    serperGl: isHu ? 'hu' : 'us',
    serperHl: isHu ? 'hu' : 'en',
  }
}

function parseVideoIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
}

function parseWebSources(value: unknown): WebSource[] {
  if (!Array.isArray(value)) return []
  const parsed: Array<WebSource | null> = value.map(item => {
    if (typeof item === 'string') {
      let source = ''
      try { source = new URL(item).hostname.replace(/^www\./, '') } catch {}
      return { title: source || item, url: item, source }
    }
    if (!item || typeof item !== 'object') return null
    const obj = item as { title?: unknown; url?: unknown; link?: unknown; snippet?: unknown; source?: unknown; date?: unknown }
    const url = typeof obj.url === 'string' ? obj.url : typeof obj.link === 'string' ? obj.link : ''
    if (!url) return null
    let source = typeof obj.source === 'string' ? obj.source : ''
    if (!source) {
      try { source = new URL(url).hostname.replace(/^www\./, '') } catch {}
    }
    return {
      title: typeof obj.title === 'string' ? obj.title : source || url,
      url,
      snippet: typeof obj.snippet === 'string' ? obj.snippet : '',
      source,
      date: typeof obj.date === 'string' ? obj.date : '',
    }
  })
  return parsed.filter((item): item is WebSource => item !== null)
}

async function fetchSerper(endpoint: 'news' | 'search', query: string, gl: string, hl: string): Promise<WebSource[]> {
  const apiKey = process.env.SERPER_API_KEY
  if (!apiKey) return []

  try {
    const res = await fetch(`https://google.serper.dev/${endpoint}`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl, hl, num: 5 }),
    })
    if (!res.ok) return []
    const data = await res.json()
    const rows = endpoint === 'news' ? (data.news || []) : (data.organic || [])
    return rows.map((r: { title?: string; link?: string; snippet?: string; source?: string; date?: string }) => ({
      title: r.title || r.link || query,
      url: r.link || '',
      snippet: r.snippet || '',
      source: r.source || '',
      date: r.date || '',
    })).filter((s: WebSource) => !!s.url)
  } catch {
    return []
  }
}

function dedupeWebSources(sources: WebSource[]): WebSource[] {
  const seen = new Set<string>()
  const out: WebSource[] = []
  for (const source of sources) {
    const key = source.url.split('#')[0]
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(source)
  }
  return out
}

export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const candidateId = typeof body.id === 'string' ? body.id : ''
  if (!candidateId) return NextResponse.json({ error: 'Hiányzó trend azonosító.' }, { status: 400 })

  const admin = createAdminClient()
  const { data: candidate, error } = await admin
    .from('tracked_trend_candidates')
    .select('id, user_id, candidate_topic, niche, region, language, youtube_video_ids, web_source_ids')
    .eq('id', candidateId)
    .eq('user_id', user.id)
    .single()

  if (error || !candidate) return NextResponse.json({ error: 'Nem található követett téma.' }, { status: 404 })

  const lock = await acquireRequestLock({ userId: user.id, toolType: 'trend_deep_refresh', inputHash: candidateId })
  if (!lock.acquired) {
    return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
  }

  try {
  const access = await checkPaidFeatureAccess(user.id, 'trend_deep_refresh', request.headers.get('x-daily-soft-limit-override') === 'true')
  if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
  if (!access.allowed) return NextResponse.json({ error: 'Nincs elég kredit a mély frissítéshez.' }, { status: 402 })

  const row = candidate as CandidateRow
  const topic = row.candidate_topic
  const settings = regionSettings(row.region, row.language)
  const existingVideoIds = parseVideoIds(row.youtube_video_ids)
  const existingWebSources = parseWebSources(row.web_source_ids)

  const searchItems = await youtubeSearch(topic, settings.youtubeRegion, settings.youtubeLang, 30, 10, 'dashboardRefresh')
  const searchIds = searchItems.map(item => item.id?.videoId).filter(Boolean)
  const stats = await youtubeStats(searchIds)

  const freshVideos: YouTubeVideoStats[] = searchItems.map(item => {
    const id = item.id.videoId
    const stat = stats.get(id)
    return {
      videoId: id,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      viewCount: Number(stat?.statistics?.viewCount || 0),
      likeCount: Number(stat?.statistics?.likeCount || 0),
      commentCount: Number(stat?.statistics?.commentCount || 0),
      thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }
  }).filter(v => v.videoId && calcSearchRelevance(v, topic) >= MIN_VIDEO_RELEVANCE)

  await recordVideoSnapshots(freshVideos.map(v => ({
    videoId: v.videoId,
    title: v.title,
    channelTitle: v.channelTitle,
    publishedAt: v.publishedAt,
    viewCount: v.viewCount,
    likeCount: v.likeCount,
    commentCount: v.commentCount,
  })))

  const freshVideoIds = freshVideos.map(v => v.videoId)
  const videoIds = Array.from(new Set([...freshVideoIds, ...existingVideoIds])).slice(0, MAX_STORED_VIDEOS)
  const addedVideoCount = freshVideoIds.filter(id => !existingVideoIds.includes(id)).length

  const [newsSources, webSources] = await Promise.all([
    fetchSerper('news', topic, settings.serperGl, settings.serperHl),
    fetchSerper('search', topic, settings.serperGl, settings.serperHl),
  ])
  const relevantWebSources = dedupeWebSources([...newsSources, ...webSources])
    .filter(s => textRelevance(`${s.title} ${s.snippet || ''}`, topic) >= MIN_WEB_RELEVANCE)
  const mergedWebSources = dedupeWebSources([...relevantWebSources, ...existingWebSources]).slice(0, MAX_STORED_WEB_SOURCES)
  const existingWebUrls = new Set(existingWebSources.map(s => s.url))
  const addedWebSourceCount = relevantWebSources.filter(s => !existingWebUrls.has(s.url)).length

  const trendSourceType = mergedWebSources.length >= 1 && videoIds.length >= 2
    ? 'serper_youtube'
    : mergedWebSources.length >= 1
      ? 'serper_only'
      : videoIds.length >= 2
        ? 'youtube_multi_creator'
        : 'weak_signal'

  const confidence = mergedWebSources.length >= 2 && videoIds.length >= 2
    ? 'közepes'
    : mergedWebSources.length >= 1 || videoIds.length >= 2
      ? 'alacsony'
      : 'alacsony'

  const { error: updateError } = await admin
    .from('tracked_trend_candidates')
    .update({
      youtube_video_ids: videoIds,
      web_source_ids: mergedWebSources,
      trend_source_type: trendSourceType,
      confidence,
      status: 'active',
    })
    .eq('id', row.id)
    .eq('user_id', user.id)

  if (updateError) return NextResponse.json({ error: 'A frissítés mentése nem sikerült.' }, { status: 500 })

  await refreshTrackedCandidateNow(row.id)

  const charge = await chargeFeature(user.id, 'trend_deep_refresh', {
    candidate_id: row.id,
    topic,
    added_videos: addedVideoCount,
    added_web_sources: addedWebSourceCount,
  })

  if (!charge.success) {
    return NextResponse.json({ error: charge.error || 'A kredit levonása nem sikerült.' }, { status: 402 })
  }

  return NextResponse.json({
    ok: true,
    topic,
    added_videos: addedVideoCount,
    added_web_sources: addedWebSourceCount,
    total_videos: videoIds.length,
    total_web_sources: mergedWebSources.length,
    new_balance: charge.new_balance,
  })
  } finally {
    await releaseRequestLock(lock.lockId)
  }
}
