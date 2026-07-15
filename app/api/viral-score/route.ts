import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { calcEngagementRate, calcTrendVelocity, calcViewOutlierScore, type YouTubeVideoStats } from '@/lib/opportunity-scoring'
import { calculateNicheFit } from '@/lib/niche-fit'
import type { SimilarVideo } from '@/types'
import { getUserId, logUsage, chargeFeature, checkPaidFeatureAccess } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import type { ViralScoreResult, ViralScoreConfidence } from '@/types'
import { youtubeSearch, youtubeStats } from '@/lib/youtube-service'
import { fetchSerperNews, computeSerperFreshness, getSerperHealthStatus, type SerperResult } from '@/lib/trend-radar'
import { buildViralScoreHash, normalizeTopic, cacheStatusFor, getCachedViralScore, touchLastOpened, saveViralScoreResult } from '@/lib/viral-score-cache'
import { buildPaidResultHash, getPaidResultByHash, getPaidResultById, normalizePaidResultInput, openPaidResult, paidResultResponseMeta, savePaidResult } from '@/lib/paid-results/paid-results-service'
import { polishHungarianOutput, polishHungarianText } from '@/lib/hungarian-output-polish'
import { createAdminClient } from '@/lib/supabase-server'
import {
  buildVideoIdeaInputHash,
  ensureVideoIdea,
  addVideoIdeaProofSignal,
  logVideoIdeaEvent,
  getVideoIdeaWorkflowStatus,
  forwardWorkflowStatus,
  type VideoIdeaWorkflowStatus,
} from '@/lib/video-ideas/video-idea-service'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { resolveCreatorNicheContext } from '@/lib/creator-profile-context'
import { topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'

// ── Téma-relevancia szűrés ────────────────────────────────────
// A YouTube/Serper keresés önmagában fuzzy — pl. "AI botrányok"-ra simán
// visszaadhat tisztán "botrány" témájú, AI-hoz semmilyen módon nem kötődő
// találatokat is. Enélkül a score olyan videókból/forrásokból épülne fel,
// amik valójában nem a keresett témáról szólnak — ez pont az ellentéte
// annak, amit a Core Trust Engine ígér (valós validáció, nem álra hasonlító
// zaj). Szándékosan NEM a megosztott lib/trend-radar.ts szűrőjét
// használjuk — az a 3 karakternél rövidebb szavakat (pl. "AI") eldobja,
// itt pedig pont ezek a rövid, de jelentéssel bíró szavak a lényegesek.
const RELEVANCE_STOPWORDS = new Set([
  'a', 'az', 'és', 'egy', 'de', 'hogy', 'mint', 'vagy', 'mert', 'amit', 'ami', 'ezt', 'azt', 'is', 'nem', 'meg', 'el', 'be', 'ki', 'fel', 'le', 'kis', 'nagy',
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were', 'new', 'why', 'how', 'of', 'in', 'on', 'at', 'to', 'an',
])

function normalizeForRelevance(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function topicRelevanceWords(topic: string): string[] {
  return normalizeForRelevance(topic)
    .split(' ')
    .filter(w => w.length >= 2 && !RELEVANCE_STOPWORDS.has(w))
}

// Rövid témánál (≤3 kulcsszó) minden szónak egyeznie kell — enélkül pont
// az történik, ami "AI botrányok"-nál: csak a "botrányok" egyezik, az "AI"
// eltűnik, és a végeredmény tisztán "botrány" tartalom lesz. Hosszabb,
// leíróbb témáknál 70%-os egyezést engedünk, hogy ne legyen túl szigorú.
function isTopicRelevant(text: string, words: string[]): boolean {
  if (words.length === 0) return true
  const normalized = normalizeForRelevance(text)
  const matchCount = words.filter(w => normalized.includes(w)).length
  const requiredRatio = words.length <= 3 ? 1 : 0.7
  return matchCount / words.length >= requiredRatio
}

// A fetchYouTubeData() egyetlen keresesi hivassal dolgozik, ennyi a maximalis
// lehetseges totalResults — a marketScore/competitionLevel log-skalajanak
// EHHEZ kell kalibralva lennie, nem egy irrealisan nagy (100 000/500 000)
// feltetelezett webskalahoz, kulonben a sub-score soha nem tud magas erteket adni.
const MAX_REALISTIC_RESULTS = 40

async function fetchYouTubeData(topic: string, region: string) {
  const regionCode = region === 'HU' ? 'HU' : region === 'US' ? 'US' : 'HU'
  const language = region === 'HU' ? 'hu' : 'en'

  const items = await youtubeSearch(topic, regionCode, language, 180, MAX_REALISTIC_RESULTS, 'manualTopicSearch')
  if (items.length === 0) return null

  const words = topicRelevanceWords(topic)
  const relevantItems = items.filter(item => isTopicRelevant(`${item.snippet.title} ${item.snippet.description || ''}`, words))
  if (relevantItems.length === 0) return null

  const videoIds = relevantItems.map(item => item.id.videoId)
  const statsMap = await youtubeStats(videoIds)

  return {
    videos: relevantItems,
    stats: Array.from(statsMap.values()),
    total_results: relevantItems.length,
  }
}

function getConfidence(videoCount: number): ViralScoreConfidence {
  if (videoCount >= 30) return 'magas'
  if (videoCount >= 10) return 'közepes'
  if (videoCount >= 5) return 'alacsony'
  return 'nagyon_alacsony'
}

// Web visszhang — Serper hírkeresésből: mennyi és milyen friss a webes lefedettség.
// Ugyanazt a freshness-logikát használja, mint a Trend Radar (lib/trend-radar.ts).
function calcWebBuzzScore(results: SerperResult[]): number {
  if (results.length === 0) return 0
  const countScore = Math.min(100, (results.length / 10) * 100) // Serper hívás max 10 találatot ad
  const freshnessScore = computeSerperFreshness(results, 30)
  return Math.round(countScore * 0.4 + freshnessScore * 0.6)
}

// Backend score — Claude NEM ad score-t, csak a meglévő adatokból számolunk
// Ugyanazokat a komponenseket használja, mint az Opportunity Engine (opportunity-scoring.ts).
// A súlyozás magja (view/engagement/velocity = 75%) változatlan — ha a Serper webes jel
// nem elérhető (API hiba/kulcs hiánya), a formula pontosan az eredeti 5-faktoros
// súlyozásra esik vissza, hogy egy külső API-hiba se torzíthassa a pontszámot.
function calcBackendViralScore(videos: YouTubeVideoStats[], avgViews: number, totalResults: number, webBuzzScore: number | null): number {
  // View-alapú alap pontszám (logaritmikus skála)
  const viewScore = Math.min(100, (Math.log10(avgViews + 1) / Math.log10(1_000_000)) * 100)
  // Engagement Rate — (likes + comments*3) / views, megosztott logikával
  const engagementScore = calcEngagementRate(videos)
  // Trend Velocity — views/hour a friss videóknál
  const velocityScore = calcTrendVelocity(videos)
  // View Outlier — van-e kiugró teljesítményű videó a témában (lehetőség jelzés)
  const outlierScore = calcViewOutlierScore(videos)
  // Piaci méret — van-e elég tartalom a témában.
  // Beta Hardening Test (2026-07-11) kalibrációs hiba: a totalResults a
  // fetchYouTubeData() egyetlen, MAX_REALISTIC_RESULTS-tal korlátozott
  // keresésből jön (lásd lent), tehát SOSEM lehet nagyobb annál — a korábbi
  // 100 000-es nevező miatt a marketScore a leginkább telített témánál is
  // csak ~32/100-ig jutott, sosem tudott érdemben magas piaci méretet jelezni.
  const marketScore = Math.min(100, (Math.log10(totalResults + 1) / Math.log10(MAX_REALISTIC_RESULTS + 1)) * 100)

  const total = webBuzzScore === null
    ? viewScore * 0.35 + engagementScore * 0.25 + velocityScore * 0.15 + outlierScore * 0.1 + marketScore * 0.15
    : viewScore * 0.35 + engagementScore * 0.25 + velocityScore * 0.15 + outlierScore * 0.05 + marketScore * 0.1 + webBuzzScore * 0.1

  return Math.round(Math.max(0, Math.min(100, total)))
}

const DAY_MS = 24 * 60 * 60 * 1000

// Átlagos videókor -> friss/elavult jelzés, ugyanazokkal a küszöbökkel, mint
// a Similar Videos freshnessScore-ja (lásd similar-videos/route.ts).
function calcFreshnessScore(videos: YouTubeVideoStats[]): number {
  if (videos.length === 0) return 0
  const now = Date.now()
  const validAges = videos.map(v => {
    const published = new Date(v.publishedAt).getTime()
    if (!Number.isFinite(published) || published > now + 60 * 60 * 1000) return null
    return Math.max(0, (now - published) / DAY_MS)
  }).filter((age): age is number => age !== null)
  if (validAges.length === 0) return 0
  const avgAgeDays = validAges.reduce((sum, age) => sum + age, 0) / validAges.length
  if (avgAgeDays <= 7) return 100
  if (avgAgeDays <= 30) return 85
  if (avgAgeDays <= 90) return 65
  if (avgAgeDays <= 180) return 40
  return 15
}

// Mennyire erős maga a bizonyíték-mennyiség (nem a virális esély, hanem hogy
// mennyire megbízható az, amiből a score született).
function calcProofStrength(confidence: ViralScoreConfidence, webBuzzScore: number | null): number {
  const base: Record<ViralScoreConfidence, number> = { magas: 90, közepes: 65, alacsony: 35, nagyon_alacsony: 10 }
  return webBuzzScore !== null ? Math.round(base[confidence] * 0.7 + webBuzzScore * 0.3) : base[confidence]
}

function calcRiskLevel(riskFlagCount: number): 'low' | 'medium' | 'high' {
  if (riskFlagCount >= 2) return 'high'
  if (riskFlagCount === 1) return 'medium'
  return 'low'
}

function getVerdict(score: number): 'strong' | 'moderate' | 'weak' | 'avoid' {
  if (score >= 70) return 'strong'
  if (score >= 45) return 'moderate'
  if (score >= 20) return 'weak'
  return 'avoid'
}

function buildViralDecisionSummary(input: {
  score: number
  confidence: ViralScoreConfidence
  videoCount: number
  webBuzzScore: number | null
}): {
  decision_status: 'make_now' | 'test_angle' | 'research' | 'avoid'
  decision_label: string
  decision_reason: string
  next_action: string
  risk_flags: string[]
} {
  const risk_flags: string[] = []
  if (input.confidence === 'nagyon_alacsony' || input.videoCount < 5) risk_flags.push('Kevés videós adat')
  if (input.webBuzzScore === null) risk_flags.push('Webes visszhang nem mérhető')
  else if (input.webBuzzScore < 30) risk_flags.push('Gyenge webes visszhang')

  if (input.score >= 70 && input.videoCount >= 5) {
    return {
      decision_status: 'make_now',
      decision_label: 'Gyártható téma',
      decision_reason: 'A YouTube-jelek alapján van mérhető kereslet és elég adat a témához.',
      next_action: 'Készíts videócsomagot, majd válassz erős hookot és címváltozatot.',
      risk_flags,
    }
  }

  if (input.score >= 45) {
    return {
      decision_status: 'test_angle',
      decision_label: 'Tesztelhető szög',
      decision_reason: 'Látszik piaci jel, de nem elég erős ahhoz, hogy vakon erre építs.',
      next_action: 'Keress Similar Videos példákat, majd készíts egy szűkebb, konkrétabb angle-t.',
      risk_flags,
    }
  }

  if (input.score >= 20 || input.videoCount >= 3) {
    return {
      decision_status: 'research',
      decision_label: 'Kutatás kell',
      decision_reason: 'Van némi adat, de a jel gyenge vagy bizonytalan.',
      next_action: 'Szűkítsd a témát, ellenőrizd webes forrással, és futtass Similar Videos keresést.',
      risk_flags,
    }
  }

  return {
    decision_status: 'avoid',
    decision_label: 'Most nem ajánlott',
    decision_reason: 'Nincs elég releváns adat ahhoz, hogy erre gyártási döntést építs.',
    next_action: 'Próbálj tágabb vagy másképp megfogalmazott keresést.',
    risk_flags,
  }
}

export async function POST(request: NextRequest) {
  try {
    const { topic, platform, region, cache_only, force_refresh, paidResultId, paid_result_id } = await request.json()
    if (!topic || typeof topic !== 'string' || !topic.trim()) return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
    if (topicInputTooLong(topic)) return NextResponse.json({ error: topicTooLongResponseMessage() }, { status: 400 })

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const { data: profileRow } = await createAdminClient().from('profiles').select('niche, main_category, specific_focus, channel_usage_mode').eq('user_id', userId).single()
    // Korabban ez a route csak a legacy `niche` oszlopot olvasta, relevancia-
    // szures/stats_only-gatelas nelkul — egy topic-tol teljesen fuggetlen
    // profil niche torzithatta a nicheFitScore-t. Most a megosztott kapun megy at.
    const { niche: rawUserNiche, useNiche: userNicheRelevant } = resolveCreatorNicheContext({
      topic, channelUsageMode: profileRow?.channel_usage_mode, niche: profileRow?.niche, mainCategory: profileRow?.main_category, specificFocus: profileRow?.specific_focus,
    })
    const userNiche = userNicheRelevant ? rawUserNiche : ''

    // ─── Perzisztens, user-szintű eredmény-cache ─────────────────
    // Amit a user egyszer kredittel lefuttatott, azt bármikor újra meg
    // tudja nyitni kredit nélkül — a lejárat (6 óra) csak "friss vs.
    // korábbi mentett" jelzés, SOHA nem fizetési határ. Csak az explicit
    // force_refresh indít új, fizetős elemzést.
    const hash = buildViralScoreHash({ userId, topic, platform, region })
    const paidNormalizedInput = normalizePaidResultInput(topic)
    const paidInputHash = buildPaidResultHash({
      userId,
      toolType: 'viral_score',
      normalizedInput: paidNormalizedInput,
      region: region || 'HU',
      platform: platform || 'youtube',
    })

    const lock = await acquireRequestLock({ userId, toolType: 'viral_score', inputHash: paidInputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    if (!force_refresh) {
      const paidById = await getPaidResultById(userId, paidResultId || paid_result_id)
      const paid = paidById || await getPaidResultByHash({ userId, toolType: 'viral_score', inputHash: paidInputHash })
      if (paid) {
        const opened = await openPaidResult(paid)
        return NextResponse.json({
          ...(opened.result_json as object),
          from_cache: true,
          ...paidResultResponseMeta(opened),
        })
      }
      const cached = await getCachedViralScore(hash, userId)
      if (cached) {
        await touchLastOpened(cached.id)

        // Backfill: a régi viral_score_searches cache-ből visszanyitott eredmény is
        // kerüljön be a központi paid_results táblába, különben a dashboard
        // "Megvett eredmény" listájában nem jelenik meg.
        const cachedResult = cached.result as ViralScoreResult
        const backfillSave = await savePaidResult({
          userId,
          toolType: 'viral_score',
          inputHash: paidInputHash,
          normalizedInput: paidNormalizedInput,
          originalInput: cachedResult.topic || topic,
          region: region || 'HU',
          platform: platform || 'youtube',
          resultJson: cachedResult,
          summaryJson: { score: cached.score, verdict: cachedResult.verdict, topic: cachedResult.topic || topic },
          creditCost: 1,
          freshForHours: cacheStatusFor(cached.last_refreshed_at) === 'fresh' ? 6 : undefined,
        })
        if (!backfillSave.success) {
          console.error('[ViralScore] KRITIKUS: paid_results backfill sikertelen cache-hit után:', backfillSave.error)
        }

        return NextResponse.json({
          ...(cachedResult as object),
          from_cache: true,
          cache_status: cacheStatusFor(cached.last_refreshed_at),
          last_analyzed_at: cached.last_refreshed_at,
          requires_credit: false,
          from_paid_result: backfillSave.success,
          paid_result_id: backfillSave.record?.id || null,
        })
      }

      if (cache_only) {
        // A kliens csak azt kérdezi, van-e mentett eredmény — ha nincs, NE
        // induljon el a fizetős elemzés és NE jelenjen meg semmilyen
        // kredit-igény, amíg a user explicit nem kéri (lásd Similar Videos
        // ugyanilyen cache_only próbája).
        return NextResponse.json({ from_cache: false, cache_status: 'miss', requires_credit: true })
      }
    }

    // ─── KRITIKUS SZABÁLY: szerver oldali kredit-ellenőrzés a drága munka
    // (YouTube + Serper + Claude hívások) előtt — a kliens oldali ellenőrzés
    // (page.tsx) csak UX, önmagában megkerülhető, sosem elég a tényleges védelemhez.
    const access = await checkPaidFeatureAccess(userId, 'viral_score', request.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
      return NextResponse.json({ error: 'Nincs elegendő kredited ehhez a művelethez.' }, { status: 402 })
    }

    // YouTube adatok lekérése
    const ytData = await fetchYouTubeData(topic, region || 'HU')
    const videoCount = ytData?.videos?.length || 0
    const confidence = getConfidence(videoCount)

    // ─── KRITIKUS SZABÁLY: ha nincs elég adat, NEM hívunk Claude-ot score-ért ───
    if (videoCount < 3) {
      const decision = buildViralDecisionSummary({ score: 0, confidence, videoCount, webBuzzScore: null })
      const result: ViralScoreResult = {
        topic,
        score: 0,
        confidence,
        video_count: videoCount,
        breakdown: { avg_views: 0, avg_likes: 0, avg_comments: 0, trend_momentum: 0, competition_level: 0, web_buzz: null },
        recommendation: 'Nincs elegendő adat a megbízható pontszámhoz. A YouTube keresés ehhez a témához kevesebb mint 3 releváns videót talált, így a piaci kereslet nem mérhető megbízhatóan. Próbálj általánosabb vagy más megfogalmazású kulcsszót.',
        verdict: 'avoid',
      }

      // Kevés adatnál nem vonunk kreditet, de a user kapott egy lezárt
      // eredményt. Ezt is mentjük, hogy a dashboard történetben megjelenjen
      // és később újranyitható legyen.
      const paidSave = await savePaidResult({
        userId,
        toolType: 'viral_score',
        inputHash: paidInputHash,
        normalizedInput: paidNormalizedInput,
        originalInput: topic,
        region: region || 'HU',
        platform: platform || 'youtube',
        resultJson: result,
        summaryJson: { score: 0, verdict: 'avoid', topic, low_data: true, decision_status: decision.decision_status, decision_label: decision.decision_label },
        creditCost: 0,
        freshForHours: 6,
      })
      if (!paidSave.success) {
        console.error('[ViralScore] KRITIKUS: kevés adatos paid_results mentés sikertelen:', paidSave.error)
      }

      await saveViralScoreResult({
        userId, hash, normalizedTopic: normalizeTopic(topic), originalTopic: topic,
        region: region || 'HU', platform: platform || 'youtube',
        result, score: 0, creditCost: 0,
      })

      return NextResponse.json({
        ...result,
        from_cache: false,
        cache_status: 'fresh',
        last_analyzed_at: new Date().toISOString(),
        requires_credit: false,
        from_paid_result: false,
        paid_result_id: paidSave.record?.id || null,
      })
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

    // ─── Webes visszhang lekérése (Serper) — a meglévő YouTube-alapú súlyokat
    // nem bántjuk, csak kiegészítjük velük (lásd calcBackendViralScore). Ha a
    // Serper API nem elérhető, webBuzzScore marad null, és a formula az
    // eredeti, tisztán YouTube-alapú súlyozásra esik vissza.
    const rawSerperResults = await fetchSerperNews(topic, region || 'HU')
    const topicWords = topicRelevanceWords(topic)
    const serperResults = rawSerperResults.filter(r => isTopicRelevant(`${r.title} ${r.snippet}`, topicWords))
    const serperHealth = getSerperHealthStatus()
    const webBuzzScore = serperHealth.unavailable ? null : calcWebBuzzScore(serperResults)

    // ─── Backend számolja a score-t — ugyanazokkal a komponensekkel mint az Opportunity Engine ───
    const score = calcBackendViralScore(videoStats, avgViews, totalResults, webBuzzScore)
    const verdict = getVerdict(score)
    const decision = buildViralDecisionSummary({ score, confidence, videoCount, webBuzzScore })

    // Trend momentum: Trend Velocity (views/hour) + Freshness kombinációja
    const trendMomentum = calcTrendVelocity(videoStats)
    // Lasd MAX_REALISTIC_RESULTS megjegyzes — ugyanaz a kalibracios javitas,
    // mint a marketScore-nal, kulonben ez is sosem tudott 100-hoz kozeli erteket adni.
    const competitionLevel = Math.round(Math.min(100, (Math.log10(totalResults + 1) / Math.log10(MAX_REALISTIC_RESULTS + 1)) * 100))

    // ─── Magyarázható score-bontás — a cél, hogy a Viral Score ne csak egy
    // szám legyen, hanem lássa a creator, MIÉRT ez a szám (lásd Creator OS terv,
    // "Viral Score legyen magyarázható döntési pontszám"). ───
    const freshnessScore = calcFreshnessScore(videoStats)
    const proofStrength = calcProofStrength(confidence, webBuzzScore)
    const riskLevel = calcRiskLevel(decision.risk_flags.length)
    const nicheFitScore = userNiche
      ? Math.round(videoStats.reduce((sum, v) => sum + calculateNicheFit({ title: v.title, channelTitle: v.channelTitle }, userNiche).score, 0) / Math.max(1, videoStats.length))
      : null

    // ─── Claude — magyarázat + a valós adatokból megítélhető minőségi tényezők ───
    const prompt = `A backend rendszer a következő valós YouTube adatokat számolta ki egy témára. Te CSAK ezeket az adatokat magyarázod magyarul — NEM adsz saját 0-100 fő score-t, az már megvan.

TÉMA: "${topic}"
RÉGIÓ: ${region || 'HU'}
PLATFORM: ${platform || 'youtube'}

BACKEND SZÁMOK:
- Viral Score: ${score}/100 (verdict: ${verdict})
- Vizsgált videók száma: ${videoCount}
- Átlagos megtekintés: ${Math.round(avgViews).toLocaleString()}
- Átlagos like: ${Math.round(avgLikes).toLocaleString()}
- Átlagos komment: ${Math.round(avgComments).toLocaleString()}
- Trend momentum: ${trendMomentum}/100 (friss videók aránya)
- Verseny szint: ${competitionLevel}/100
- Friss adat: ${freshnessScore}/100
- Összes találat a piacon: ${totalResults.toLocaleString()}
${webBuzzScore !== null ? `- Webes visszhang (hírek/cikkek): ${webBuzzScore}/100 (${serperResults.length} releváns webes találat)` : '- Webes visszhang: nem elérhető ehhez a futtatáshoz'}

TOP VIDEÓ CÍMEK (ebből ítéld meg a hook/kíváncsiság/platform-illeszkedés/gyárthatóság tényezőket):
${videoStats.slice(0, 8).map(v => `- "${v.title}" (${v.viewCount.toLocaleString()} megtekintés)`).join('\n')}

FELADAT:
1. Írj egy 2-3 mondatos magyar ajánlást a fenti SZÁMOK alapján. Magyarázd el mit jelentenek ezek a számok a creator számára. NE adj más 0-100 fő score-t, NE mondj ellent a fenti verdict-nek.
Ha a webes lefedettségre hivatkozol, PONTOSAN a "webes visszhang" kifejezést használd — NE találj ki hozzá szinonimát vagy új összetett szót.
2. A fenti top videócímek alapján, KIZÁRÓLAG a valós adatra támaszkodva (ne találgass), adj 0-100 közötti becslést az alábbi 4 tényezőre:
   - hook_potential: mennyire erős hook/csavart ígérnek a legjobban teljesítő címek
   - audience_curiosity: mennyire kíváncsiságvezérelt a téma a címek alapján
   - platform_fit: mennyire illik ez a téma a "${platform || 'youtube'}" platformhoz a videók stílusa/hossza alapján
   - production_difficulty: mennyire nehéz ezt legyártani (0 = nagyon egyszerű, 100 = nagyon nehéz/erőforrás-igényes), a téma jellege alapján (pl. szükséges-e szakértelem, speciális felvétel, sok kutatás)

Válaszolj KIZÁRÓLAG valid JSON-ban:
{"recommendation": "2-3 mondatos magyar ajánlás a backend számok alapján", "hook_potential": 0, "audience_curiosity": 0, "platform_fit": 0, "production_difficulty": 0}`

    const aiCall = await callAIProvider({
      model: MODELS.fast,
      maxTokens: 500,
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'viral_score_explanation',
      promptVersion: 'v1',
    })

    const aiResult = extractJson<{
      recommendation?: string
      hook_potential?: unknown
      audience_curiosity?: unknown
      platform_fit?: unknown
      production_difficulty?: unknown
    }>(aiCall.text)
    const polishedRecommendation = polishHungarianText(String(aiResult.recommendation || ''))
    const clampScore = (value: unknown) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
    const hookPotential = clampScore(aiResult.hook_potential)
    const audienceCuriosity = clampScore(aiResult.audience_curiosity)
    const platformFit = clampScore(aiResult.platform_fit)
    const productionDifficulty = clampScore(aiResult.production_difficulty)

    await logUsage(userId, 'viral_score', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { topic })

    // ─── Kredit levonás — korábban ez teljesen hiányzott: a Viral Score
    // sosem vont le kreditet szerver oldalon, a kliens csak becsült egy
    // "1 kredit" költséget, ami valójában sosem érvényesült. Emiatt a
    // funkció eddig ingyenes volt, és nem is jelent meg a "Legutóbbi
    // történeted" panelen (mert oda csak a ténylegesen levont — credits_charged
    // > 0 — sorok kerülnek be).
    const chargeResult = await chargeFeature(userId, 'viral_score', { topic })
    if (!chargeResult.success) {
      return NextResponse.json({ error: chargeResult.error || 'Nincs elegendő kredited ehhez a művelethez.' }, { status: 402 })
    }

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
        web_buzz: webBuzzScore,
        freshness: freshnessScore,
        proof_strength: proofStrength,
        niche_fit: nicheFitScore,
        risk_level: riskLevel,
        hook_potential: hookPotential,
        audience_curiosity: audienceCuriosity,
        platform_fit: platformFit,
        production_difficulty: productionDifficulty,
      },
      recommendation: polishedRecommendation,
      verdict,
      decision_status: decision.decision_status,
      decision_label: decision.decision_label,
      decision_reason: decision.decision_reason,
      next_action: decision.next_action,
      risk_flags: decision.risk_flags,
      videos: topVideos,
      web_sources: serperResults.slice(0, 3).map(s => ({ title: s.title, url: s.link, source: s.source, date: s.date })),
    }

    const paidSave = await savePaidResult({
      userId,
      toolType: 'viral_score',
      inputHash: paidInputHash,
      normalizedInput: paidNormalizedInput,
      originalInput: topic,
      region: region || 'HU',
      platform: platform || 'youtube',
      resultJson: result,
      summaryJson: { score, verdict, topic, decision_status: decision.decision_status, decision_label: decision.decision_label },
      creditCost: 1,
      freshForHours: 6,
      provider: aiCall.provider,
      model: aiCall.model,
      promptTemplateId: aiCall.promptTemplateId,
      promptVersion: aiCall.promptVersion,
      estimatedCost: aiCall.estimatedCost,
    })
    if (!paidSave.success) {
      console.error('[ViralScore] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
    }

    const saveRes = await saveViralScoreResult({
      userId, hash, normalizedTopic: normalizeTopic(topic), originalTopic: topic,
      region: region || 'HU', platform: platform || 'youtube',
      result, score, creditCost: 1,
    })
    if (!saveRes.success) {
      console.error('[ViralScore] KRITIKUS: eredmény mentése sikertelen, a user már fizetett érte:', saveRes.error)
    }

    // ── Video Idea — proof signal bekötés ───────────────────────
    // A Viral Score eredményét (score, top videók, webes források) a topic
    // mögötti Video Idea bizonyítékaként mentjük. Hiba itt sosem törheti el
    // a fő választ — a service funkciók maguk is try/catch-eltek.
    const ideaPlatform = platform || 'youtube'
    const ideaLanguage = (region || 'HU') === 'US' ? 'en' : 'hu'
    const ideaMarket = region || 'HU'
    const videoIdeaHash = buildVideoIdeaInputHash({ userId, topic, platform: ideaPlatform, language: ideaLanguage, market: ideaMarket })
    const videoIdeaAdmin = createAdminClient()
    const existingWorkflowStatus = await getVideoIdeaWorkflowStatus(videoIdeaAdmin, userId, videoIdeaHash)
    const candidateStatus: VideoIdeaWorkflowStatus =
      decision.decision_status === 'make_now' ? 'validated'
      : decision.decision_status === 'avoid' ? 'new_idea'
      : 'validating'
    const strength = verdict === 'strong' ? 'strong' : verdict === 'moderate' ? 'medium' : 'weak'

    const ideaResult = await ensureVideoIdea(videoIdeaAdmin, {
      userId,
      topic,
      platform: ideaPlatform,
      language: ideaLanguage,
      market: ideaMarket,
      inputHash: videoIdeaHash,
      viralScore: score,
      workflowStatus: forwardWorkflowStatus(existingWorkflowStatus, candidateStatus),
      proofSummary: decision.decision_reason,
    })

    if (ideaResult.success && ideaResult.idea) {
      await Promise.all([
        ...topVideos.map(video => addVideoIdeaProofSignal(videoIdeaAdmin, {
          userId,
          videoIdeaId: ideaResult.idea!.id,
          signalType: 'competitor_video',
          sourceTool: 'viral_score',
          sourceId: video.video_id,
          title: video.title,
          url: video.url,
          channelTitle: video.channel_title,
          publishedAt: video.published_at,
          viewCount: video.view_count,
          strength,
          reason: decision.decision_reason,
          payload: { score, verdict },
        })),
        ...(result.web_sources || []).slice(0, 3).map(source => addVideoIdeaProofSignal(videoIdeaAdmin, {
          userId,
          videoIdeaId: ideaResult.idea!.id,
          signalType: 'web_source',
          sourceTool: 'viral_score',
          title: source.title,
          url: source.url,
          strength,
          reason: 'Webes visszhang (Serper hírkeresés)',
          payload: { source_name: source.source, date: source.date },
        })),
      ])

      await logVideoIdeaEvent(videoIdeaAdmin, {
        userId,
        videoIdeaId: ideaResult.idea.id,
        eventType: 'viral_score_completed',
        sourceTool: 'viral_score',
        payload: { topic, score, verdict, video_count: videoCount, decision_status: decision.decision_status },
      })
    }

    return NextResponse.json({
      ...result,
      from_cache: false,
      cache_status: 'fresh',
      last_analyzed_at: new Date().toISOString(),
      requires_credit: true,
      paid_result_id: paidSave.record?.id || null,
    })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Viral Score error:', error)
    return NextResponse.json({ error: 'Elemzés sikertelen.' }, { status: 500 })
  }
}

// GET - Viral Score visszanyitása paidResultId alapján kredit nélkül.
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const paidResultId = request.nextUrl.searchParams.get('paidResultId')
    if (!paidResultId) return NextResponse.json({ error: 'paidResultId kötelező' }, { status: 400 })

    const paid = await getPaidResultById(userId, paidResultId)
    if (!paid) return NextResponse.json({ error: 'Viral Score eredmény nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    return NextResponse.json({
      ...(polishHungarianOutput(opened.result_json) as object),
      ...paidResultResponseMeta(opened),
    })
  } catch (error) {
    console.error('Viral Score GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
