// lib/trend-tracking.ts
// WillViral — Limitált tracked trend candidate rendszer.
// NEM teljes crawler: csak a userek szempontjából fontos candidate-eket
// követjük (mentett / videócsomaggá vált / magas confidence+score / friss trend),
// és a háttérfrissítés is csak a MÁR ISMERT youtube_video_ids statisztikáit
// kéri le újra — nem indít új YouTube keresést.
//
// Minden függvény hibatűrő: ha a tracking írás/frissítés hibázik, az nem
// törheti el a hívó fő funkciót (mentés, csomaggenerálás, opportunity lekérés).

import { createServerClient } from '@supabase/ssr'
import { youtubeStats } from '@/lib/youtube-service'

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

// ── Refresh ütemezés szabály ──────────────────────────────────
// friss trend 0–72 óra: 8 óránként
// aktív trend 3–14 nap: naponta
// 14–30 nap: 2 naponta
// 30 nap után: leállítjuk a követést (status: stopped)
function computeSchedule(createdAt: string, opportunityScore: number | null, confidence: string | null) {
  const ageHours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60)
  const ageDays = ageHours / 24

  let intervalHours: number
  let status: 'active' | 'stopped' = 'active'

  if (ageHours <= 72) intervalHours = 8
  else if (ageDays <= 14) intervalHours = 24
  else if (ageDays <= 30) intervalHours = 48
  else { intervalHours = 168; status = 'stopped' }

  const score = opportunityScore ?? 0
  const isHighConfidence = confidence === 'magas' || confidence === 'high'
  const refresh_priority: 'high' | 'normal' | 'low' =
    score >= 85 || isHighConfidence ? 'high' : score < 60 ? 'low' : 'normal'

  const next_check_at = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString()
  return { next_check_at, refresh_priority, status }
}

// ── Gatekeeper: eldönti, érdemes-e trackelni egy candidate-ot ──
export interface TrackCandidateInput {
  userId: string
  candidateTopic: string
  niche?: string | null
  region?: string | null
  language?: string | null
  trendSourceType?: string | null
  confidence?: string | null
  opportunityScore?: number | null
  youtubeVideoIds?: string[]
  webSourceIds?: string[]
  generatedAt?: string | null
  // ha true, mindig trackeljük (explicit user akció: mentés / videócsomag)
  force?: boolean
}

function isTrackWorthy(input: TrackCandidateInput): boolean {
  if (input.force) return true
  const score = input.opportunityScore ?? 0
  const isHighConfidence = input.confidence === 'magas' || input.confidence === 'high'
  const generatedAt = input.generatedAt ? new Date(input.generatedAt).getTime() : Date.now()
  const isFresh = Date.now() - generatedAt <= 72 * 60 * 60 * 1000
  return isHighConfidence || score >= 80 || isFresh
}

export async function promoteToTrackedCandidate(input: TrackCandidateInput): Promise<void> {
  if (!isTrackWorthy(input)) return

  try {
    const admin = adminClient()
    const createdAt = input.generatedAt || new Date().toISOString()
    const { next_check_at, refresh_priority } = computeSchedule(createdAt, input.opportunityScore ?? null, input.confidence ?? null)

    await admin.from('tracked_trend_candidates').upsert({
      user_id: input.userId,
      candidate_topic: input.candidateTopic,
      niche: input.niche || null,
      region: input.region || null,
      language: input.language || null,
      trend_source_type: input.trendSourceType || null,
      confidence: input.confidence || null,
      opportunity_score: input.opportunityScore ?? null,
      youtube_video_ids: input.youtubeVideoIds || [],
      web_source_ids: input.webSourceIds || [],
      next_check_at,
      refresh_priority,
      status: 'active',
    }, { onConflict: 'user_id,candidate_topic', ignoreDuplicates: false })
  } catch (e) {
    console.warn('[trend-tracking] promoteToTrackedCandidate failed (non-blocking):', e)
  }
}

// ── Háttérfrissítés: csak a már ismert youtube_video_ids statisztikáit kéri le ──
export interface RefreshResult {
  processed: number
  updated: number
  failed: number
  skipped: number
}

const DEFAULT_BATCH_LIMIT = 20
const FAILURE_RETRY_HOURS = 1

export async function refreshDueCandidates(limit = DEFAULT_BATCH_LIMIT): Promise<RefreshResult> {
  const result: RefreshResult = { processed: 0, updated: 0, failed: 0, skipped: 0 }
  const admin = adminClient()

  let due: { id: string; candidate_topic: string; youtube_video_ids: string[]; created_at: string; opportunity_score: number | null; confidence: string | null }[] = []
  try {
    const { data } = await admin
      .from('tracked_trend_candidates')
      .select('id, candidate_topic, youtube_video_ids, created_at, opportunity_score, confidence')
      .eq('status', 'active')
      .lte('next_check_at', new Date().toISOString())
      .order('refresh_priority', { ascending: true })
      .limit(limit)
    due = data || []
  } catch (e) {
    console.warn('[trend-tracking] failed to load due candidates (non-blocking):', e)
    return result
  }

  for (const candidate of due) {
    result.processed++
    try {
      await refreshOneCandidate(admin, candidate)
      result.updated++
    } catch (e) {
      result.failed++
      console.warn(`[trend-tracking] refresh failed for candidate ${candidate.id} (non-blocking):`, e)
      // Backoff — ne próbálkozzon azonnal újra a legközelebbi cron futáskor
      try {
        await admin.from('tracked_trend_candidates').update({
          next_check_at: new Date(Date.now() + FAILURE_RETRY_HOURS * 60 * 60 * 1000).toISOString(),
        }).eq('id', candidate.id)
      } catch { /* best-effort */ }
    }
  }

  return result
}

async function refreshOneCandidate(
  admin: ReturnType<typeof adminClient>,
  candidate: { id: string; candidate_topic: string; youtube_video_ids: string[]; created_at: string; opportunity_score: number | null; confidence: string | null }
) {
  const videoIds = (candidate.youtube_video_ids || []).filter(Boolean)

  let totalViews = 0
  let totalLikes = 0
  let totalComments = 0
  let relevantCount = 0

  if (videoIds.length > 0) {
    const stats = await youtubeStats(videoIds)
    for (const item of stats.values()) {
      relevantCount++
      totalViews += Number(item.statistics?.viewCount || 0)
      totalLikes += Number(item.statistics?.likeCount || 0)
      totalComments += Number(item.statistics?.commentCount || 0)
    }
  }

  // Előző snapshot a delta/velocity számításhoz
  const { data: prevSnapshots } = await admin
    .from('trend_candidate_snapshots')
    .select('total_views, checked_at')
    .eq('tracked_candidate_id', candidate.id)
    .order('checked_at', { ascending: false })
    .limit(1)

  const prev = prevSnapshots?.[0]
  const viewsDelta = prev ? totalViews - (prev.total_views || 0) : null
  const hoursSincePrev = prev ? (Date.now() - new Date(prev.checked_at).getTime()) / (1000 * 60 * 60) : null
  const trendVelocity = viewsDelta != null && hoursSincePrev && hoursSincePrev > 0 ? Math.round((viewsDelta / hoursSincePrev) * 100) / 100 : null

  let trendStatus: 'rising' | 'stable' | 'declining' = 'stable'
  if (viewsDelta != null) {
    if (viewsDelta > 0 && (prev?.total_views ? viewsDelta / Math.max(prev.total_views, 1) > 0.02 : true)) trendStatus = 'rising'
    else if (viewsDelta < 0) trendStatus = 'declining'
  }

  const engagementRate = totalViews > 0 ? Math.round(((totalLikes + totalComments) / totalViews) * 10000) / 100 : null

  await admin.from('trend_candidate_snapshots').insert({
    tracked_candidate_id: candidate.id,
    avg_opportunity_score: candidate.opportunity_score,
    total_views: totalViews,
    total_likes: totalLikes,
    total_comments: totalComments,
    youtube_relevant_videos_count: relevantCount,
    engagement_rate: engagementRate,
    views_delta: viewsDelta,
    trend_velocity: trendVelocity,
    trend_status: trendStatus,
  })

  const { next_check_at, refresh_priority, status } = computeSchedule(
    candidate.created_at,
    candidate.opportunity_score,
    candidate.confidence
  )

  await admin.from('tracked_trend_candidates').update({
    last_checked_at: new Date().toISOString(),
    next_check_at,
    refresh_priority,
    status,
  }).eq('id', candidate.id)
}
