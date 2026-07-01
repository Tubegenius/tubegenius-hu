// lib/youtube-snapshot.ts
// WillViral — Passzív YouTube adatvagyon gyűjtés
// Csak azt menti, amit a rendszer amúgy is lekér a YouTube API-ból.
// Nincs extra API-hívás. Minden hívás try/catch-ben — hiba esetén a fő
// funkció (keresés/validáció) zavartalanul folytatódik.

import { createServerClient } from '@supabase/ssr'

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

export interface SnapshotVideoInput {
  videoId: string
  title: string
  channelId?: string | null
  channelTitle?: string | null
  publishedAt?: string | null
  viewCount: number
  likeCount: number
  commentCount: number
}

// Egy batch videó snapshot mentése — hívható bármelyik route-ból, ahol
// amúgy is megvan a friss videó statisztika (search + stats hydrate után).
export async function recordVideoSnapshots(videos: SnapshotVideoInput[]): Promise<void> {
  if (!videos || videos.length === 0) return

  try {
    const admin = adminClient()
    const now = new Date().toISOString()

    // 1. Videó identitás upsert (title/channel frissül, ha változott)
    const videoRows = videos.map(v => ({
      video_id: v.videoId,
      title: v.title,
      channel_id: v.channelId || null,
      channel_title: v.channelTitle || null,
      published_at: v.publishedAt || null,
      last_seen_at: now,
    }))
    await admin.from('youtube_videos').upsert(videoRows, { onConflict: 'video_id', ignoreDuplicates: false })

    // 2. Csatorna identitás upsert (csak azonosító, nincs subscriber-adat)
    const channelMap = new Map<string, string>()
    videos.forEach(v => {
      if (v.channelId) channelMap.set(v.channelId, v.channelTitle || '')
    })
    if (channelMap.size > 0) {
      const channelRows = Array.from(channelMap.entries()).map(([channel_id, channel_title]) => ({
        channel_id,
        channel_title,
        last_seen_at: now,
      }))
      await admin.from('youtube_channels').upsert(channelRows, { onConflict: 'channel_id', ignoreDuplicates: false })
    }

    // 3. Snapshot sorok — mindig új sor, ez adja az idősort
    const snapshotRows = videos.map(v => ({
      video_id: v.videoId,
      view_count: v.viewCount || 0,
      like_count: v.likeCount || 0,
      comment_count: v.commentCount || 0,
      checked_at: now,
    }))
    await admin.from('youtube_video_snapshots').insert(snapshotRows)
  } catch (e) {
    console.warn('[youtube-snapshot] recordVideoSnapshots failed (non-blocking):', e)
  }
}

export interface SnapshotTrendCandidateInput {
  candidate_topic: string
  category?: string
  region?: string
  trend_source_type?: string
  confidence?: string
  opportunity_type?: string
  relevance_average?: number
  freshness_score?: number
  seed_keyword?: string
  market_type?: string
}

// Trend candidate-ok passzív mentése — ugyanaz az adat, ami amúgy is
// kiszámolódik és cache-elődik a Trend Radar-ban.
export async function recordTrendCandidates(candidates: SnapshotTrendCandidateInput[]): Promise<void> {
  if (!candidates || candidates.length === 0) return

  try {
    const admin = adminClient()
    await admin.from('trend_candidates').insert(
      candidates.map(c => ({
        candidate_topic: c.candidate_topic,
        category: c.category || null,
        region: c.region || null,
        trend_source_type: c.trend_source_type || null,
        confidence: c.confidence || null,
        opportunity_type: c.opportunity_type || null,
        relevance_average: c.relevance_average ?? null,
        freshness_score: c.freshness_score ?? null,
        seed_keyword: c.seed_keyword || null,
        market_type: c.market_type || null,
      }))
    )
  } catch (e) {
    console.warn('[youtube-snapshot] recordTrendCandidates failed (non-blocking):', e)
  }
}
