import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { MODELS } from '@/lib/models'
import { createAdminClient } from '@/lib/supabase-server'
import { calcEngagementRate, calcTrendVelocity, calcViewOutlierScore, type YouTubeVideoStats } from '@/lib/opportunity-scoring'
import type { SimilarVideo } from '@/types'
import { getUserId, logUsage } from '@/lib/credits'
import type { ViralScoreResult, ViralScoreConfidence } from '@/types'
import { youtubeSearch, youtubeStats } from '@/lib/youtube-service'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

async function fetchYouTubeData(topic: string, region: string) {
  const regionCode = region === 'HU' ? 'HU' : region === 'US' ? 'US' : 'HU'
  const language = region === 'HU' ? 'hu' : 'en'

  const items = await youtubeSearch(topic, regionCode, language, 180, 20, 'manualTopicSearch')
  if (items.length === 0) return null

  const videoIds = items.map(item => item.id.videoId)
  const statsMap = await youtubeStats(videoIds)

  return {
    videos: items,
    stats: Array.from(statsMap.values()),
    total_results: items.length,
  }
}

function getConfidence(videoCount: number): ViralScoreConfidence {
  if (videoCount >= 30) return 'magas'
  if (videoCount >= 10) return 'közepes'
  if (videoCount >= 5) return 'alacsony'
  return 'nagyon_alacsony'
}

// Backend score — Claude NEM ad score-t, csak a meglévő adatokból számolunk
// Ugyanazokat a komponenseket használja, mint az Opportunity Engine (opportunity-scoring.ts)
function calcBackendViralScore(videos: YouTubeVideoStats[], avgViews: number, totalResults: number): number {
  // View-alapú alap pontszám (logaritmikus skála)
  const viewScore = Math.min(100, (Math.log10(avgViews + 1) / Math.log10(1_000_000)) * 100)
  // Engagement Rate — (likes + comments*3) / views, megosztott logikával
  const engagementScore = calcEngagementRate(videos)
  // Trend Velocity — views/hour a friss videóknál
  const velocityScore = calcTrendVelocity(videos)
  // View Outlier — van-e kiugró teljesítményű videó a témában (lehetőség jelzés)
  const outlierScore = calcViewOutlierScore(videos)
  // Piaci méret — van-e elég tartalom a témában
  const marketScore = Math.min(100, (Math.log10(totalResults + 1) / Math.log10(100_000)) * 100)

  const total = viewScore * 0.35 + engagementScore * 0.25 + velocityScore * 0.15 + outlierScore * 0.1 + marketScore * 0.15
  return Math.round(Math.max(0, Math.min(100, total)))
}

function getVerdict(score: number): 'strong' | 'moderate' | 'weak' | 'avoid' {
  if (score >= 70) return 'strong'
  if (score >= 45) return 'moderate'
  if (score >= 20) return 'weak'
  return 'avoid'
}

export async function POST(request: NextRequest) {
  try {
    const { topic, platform, region } = await request.json()
    if (!topic) return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const cacheKey = `${topic}-${platform}-${region}`.toLowerCase().replace(/\s+/g, '-')
    const admin = createAdminClient()

    const { data: cached } = await admin
      .from('viral_score_cache')
      .select('*')
      .eq('cache_key', cacheKey)
      .gt('expires_at', new Date().toISOString())
      .single()

    if (cached) {
      return NextResponse.json({ ...cached.result, cached: true })
    }

    // YouTube adatok lekérése
    const ytData = await fetchYouTubeData(topic, region || 'HU')
    const videoCount = ytData?.videos?.length || 0
    const confidence = getConfidence(videoCount)

    // ─── KRITIKUS SZABÁLY: ha nincs elég adat, NEM hívunk Claude-ot score-ért ───
    if (videoCount < 3) {
      const result: ViralScoreResult = {
        topic,
        score: 0,
        confidence,
        video_count: videoCount,
        breakdown: { avg_views: 0, avg_likes: 0, avg_comments: 0, trend_momentum: 0, competition_level: 0 },
        recommendation: 'Nincs elegendő adat a megbízható pontszámhoz. A YouTube keresés ehhez a témához kevesebb mint 3 releváns videót talált, így a piaci kereslet nem mérhető megbízhatóan. Próbálj általánosabb vagy más megfogalmazású kulcsszót.',
        verdict: 'avoid',
      }
      return NextResponse.json(result)
    }

    // ─── Videók egységes formátumra hozása a megosztott scoring függvényekhez ───
    const videoStats: YouTubeVideoStats[] = (ytData?.videos || []).map((v: { id: { videoId: string }; snippet: { title: string; channelTitle: string; publishedAt: string; thumbnails: { medium?: { url: string }; default?: { url: string } } } }) => {
      const statsItem = (ytData?.stats || []).find((s: { id: string }) => s.id === v.id.videoId)
      return {
        videoId: v.id.videoId,
        title: v.snippet.title,
        channelTitle: v.snippet.channelTitle,
        publishedAt: v.snippet.publishedAt,
        viewCount: parseInt(statsItem?.statistics?.viewCount || '0'),
        likeCount: parseInt(statsItem?.statistics?.likeCount || '0'),
        commentCount: parseInt(statsItem?.statistics?.commentCount || '0'),
        thumbnailUrl: v.snippet.thumbnails.medium?.url || v.snippet.thumbnails.default?.url || '',
      }
    })

    // Statisztikák aggregálása
    let avgViews = 0, avgLikes = 0, avgComments = 0
    if (videoStats.length > 0) {
      avgViews = videoStats.reduce((sum, v) => sum + v.viewCount, 0) / videoStats.length
      avgLikes = videoStats.reduce((sum, v) => sum + v.likeCount, 0) / videoStats.length
      avgComments = videoStats.reduce((sum, v) => sum + v.commentCount, 0) / videoStats.length
    }

    const totalResults = ytData?.total_results || 0

    // ─── Backend számolja a score-t — ugyanazokkal a komponensekkel mint az Opportunity Engine ───
    const score = calcBackendViralScore(videoStats, avgViews, totalResults)
    const verdict = getVerdict(score)

    // Trend momentum: Trend Velocity (views/hour) + Freshness kombinációja
    const trendMomentum = calcTrendVelocity(videoStats)
    const competitionLevel = Math.round(Math.min(100, (Math.log10(totalResults + 1) / Math.log10(500_000)) * 100))

    // ─── Claude — CSAK magyarázat a meglévő számokból ───
    const prompt = `A backend rendszer a következő valós YouTube adatokat számolta ki egy témára. Te CSAK ezeket az adatokat magyarázod magyarul — NEM adsz saját score-t.

TÉMA: "${topic}"
RÉGIÓ: ${region || 'HU'}

BACKEND SZÁMOK:
- Viral Score: ${score}/100 (verdict: ${verdict})
- Vizsgált videók száma: ${videoCount}
- Átlagos megtekintés: ${Math.round(avgViews).toLocaleString()}
- Átlagos like: ${Math.round(avgLikes).toLocaleString()}
- Átlagos komment: ${Math.round(avgComments).toLocaleString()}
- Trend momentum: ${trendMomentum}/100 (friss videók aránya)
- Verseny szint: ${competitionLevel}/100
- Összes találat a piacon: ${totalResults.toLocaleString()}

FELADAT:
Írj egy 2-3 mondatos magyar ajánlást a fenti SZÁMOK alapján. Magyarázd el mit jelentenek ezek a számok a creator számára. NE adj más score-t, NE mondj ellent a fenti verdict-nek.

Válaszolj KIZÁRÓLAG valid JSON-ban:
{"recommendation": "2-3 mondatos magyar ajánlás a backend számok alapján"}`

    const message = await anthropic.messages.create({
      model: MODELS.fast,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    })

    const responseText = message.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
    const aiResult = JSON.parse(responseText.replace(/```json|```/g, '').trim())

    await logUsage(userId, 'viral_score', MODELS.fast, message.usage.input_tokens, message.usage.output_tokens, { topic })

    // Top 5 videó a videoStats-ból - megtekintés szerint rendezve, a UI-nak (VideoCardActions kártyák)
    const topVideos: SimilarVideo[] = [...videoStats]
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, 5)
      .map(v => ({
        video_id: v.videoId, title: v.title, channel_title: v.channelTitle,
        thumbnail_url: v.thumbnailUrl, view_count: v.viewCount, like_count: v.likeCount,
        comment_count: v.commentCount, published_at: v.publishedAt,
        url: `https://youtube.com/watch?v=${v.videoId}`, duration: null,
      }))

    const result: ViralScoreResult = {
      topic,
      score,
      confidence,
      video_count: videoCount,
      breakdown: {
        avg_views: Math.round(avgViews),
        avg_likes: Math.round(avgLikes),
        avg_comments: Math.round(avgComments),
        trend_momentum: trendMomentum,
        competition_level: competitionLevel,
      },
      recommendation: aiResult.recommendation,
      verdict,
      videos: topVideos,
    }

    const expires = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    await admin.from('viral_score_cache').upsert({ cache_key: cacheKey, result, expires_at: expires })

    return NextResponse.json(result)
  } catch (error) {
    console.error('Viral Score error:', error)
    return NextResponse.json({ error: 'Elemzés sikertelen.' }, { status: 500 })
  }
}
