import { NextRequest, NextResponse } from 'next/server'
import { topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'
import type { SimilarVideo } from '@/types'
import {
  calcSearchRelevance,
  calcVideoVelocity,
  calcVideoEngagementRate,
  type YouTubeVideoStats,
} from '@/lib/opportunity-scoring'
import { decideSimilarVideo } from '@/lib/scoring/willviral-decision-engine'
import { youtubeSearch, youtubeStats, getEffectiveBudget, quotaSummary, startNewRequest, type YouTubeSearchItem as YTSearchItem, type YouTubeStatsItem as YTStatsItem } from '@/lib/youtube-service'
import { generateSimilarVideoQueries } from '@/lib/similar-query-expansion'
import { calculateNicheFit } from '@/lib/niche-fit'
import { logYouTubeSearch, checkUsagePermission, chargeProtectedFeature, logFreeProductUse } from '@/lib/usage-protection'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { recordVideoSnapshots } from '@/lib/youtube-snapshot'
import { normalizeTopic as normalizeTopicForHash, buildSearchContextHash, getCachedSearch, touchLastOpened, saveSearchResult } from '@/lib/similar-videos-cache'
import { buildPaidResultHash, getPaidResultByHash, getPaidResultById, normalizePaidResultInput, openPaidResult, paidResultResponseMeta, savePaidResult } from '@/lib/paid-results/paid-results-service'
import { polishHungarianOutput } from '@/lib/hungarian-output-polish'
import {
  buildVideoIdeaInputHash,
  ensureVideoIdea,
  addVideoIdeaProofSignal,
  logVideoIdeaEvent,
  getVideoIdeaWorkflowStatus,
  forwardWorkflowStatus,
} from '@/lib/video-ideas/video-idea-service'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_SIMILAR_VIDEO_RELEVANCE = 60
const MIN_GLOBAL_HU_INPUT_RELEVANCE = 60

type Region = 'HU' | 'US'

interface ViralSimilarVideo extends SimilarVideo {
  relevance_score: number
  viral_video_score: number
  score_breakdown: {
    search_relevance: number
    freshness_score: number
    velocity_score: number
    engagement_score: number
    outlier_score: number
  }
  reason: string
  freshness_label: string
  velocity_label: string
  badges: string[]
  decision_status: 'ready' | 'watch' | 'research' | 'rejected'
  decision_label: string
  decision_score: number
  risk_flags: string[]
  niche_fit?: { score: number; label: string; reason: string }
}

interface YouTubeSearchItem {
  id: { videoId: string }
  snippet: {
    title: string
    description?: string
    channelTitle: string
    publishedAt: string
    thumbnails: { medium?: { url: string }; default?: { url: string } }
  }
}

interface YouTubeStatsItem {
  id: string
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string }
  contentDetails?: { duration?: string }
}

const GENERIC_QUERY_WORDS = new Set([
  'ai', 'news', 'science', 'technology', 'viral', 'trending',
  'hírek', 'tudomány', 'technológia', 'trend', 'virális',
])

const HU_REJECT_TERMS = [
  'south africa', 'nigeria', 'kenya', 'ghana', 'india', 'pakistan',
  'lok sabha', 'rajya sabha', 'anc ', 'mk party', 'sabc news',
  'us election', 'uk parliament', 'australian politics',
]

const HU_CHARS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/
const HU_WORDS = /\b(magyar|magyarország|budapest|forint|kormány|egészségügy|orvostudomány|kutatás|áttörés|miért|új|mesterséges|intelligencia)\b/i
// Ékezetmentes regex-ek — a toGlobalTopic ELŐBB strip-eli az ékezeteket
const HU_TO_GLOBAL_PHRASES: Array<[RegExp, string]> = [
  [/\buj aktualis hirek\b/gi, 'latest breaking news'],
  [/\baktualis hirek\b/gi, 'current news'],
  [/\bfriss hirek\b/gi, 'latest news'],
  [/\bmesterseges intelligencia\b/gi, 'artificial intelligence'],
  [/\buj kutatas\b/gi, 'new research'],
  [/\brak felismereseben\b/gi, 'cancer detection'],
  [/\brakdiagnosztika\b/gi, 'cancer diagnosis'],
  [/\begeszseg(es)? elet\b/gi, 'healthy living'],
  [/\borvostudomany\b/gi, 'medicine'],
  [/\begeszsegugy\b/gi, 'healthcare'],
  [/\baktualis\b/gi, 'current'],
  [/\bhirek\b/gi, 'news'],
  [/\bfriss\b/gi, 'latest'],
  [/\buj\b/gi, 'new'],
  [/\bdiagnosztika\b/gi, 'diagnostics'],
  [/\brak\b/gi, 'cancer'],
  [/\bkutatas\b/gi, 'research'],
  [/\battores\b/gi, 'breakthrough'],
  [/\bmiert\b/gi, 'why'],
  [/\boktatas\b/gi, 'education'],
  [/\bgazdasag\b/gi, 'economy'],
  [/\bmunkahelyek\b/gi, 'jobs'],
  [/\bmunka\b/gi, 'work'],
  [/\brobotika\b/gi, 'robotics'],
  [/\btudomany\b/gi, 'science'],
  [/\btechnologia\b/gi, 'technology'],
  [/\bmagyarorszag\b/gi, 'hungary'],
  [/\bmagyar\b/gi, 'hungarian'],
  [/\btortenelem\b/gi, 'history'],
  [/\btortenelmi\b/gi, 'historical'],
  [/\bpszichologia\b/gi, 'psychology'],
  [/\begeszseg(es)?\b/gi, 'healthy'],
  [/\belet\b/gi, 'life'],
  [/\bsport\b/gi, 'sports'],
  [/\bedzes\b/gi, 'workout'],
  [/\btaplalkozas\b/gi, 'nutrition'],
  [/\bdieta\b/gi, 'diet'],
  [/\balvas\b/gi, 'sleep'],
  [/\bpenzugy\b/gi, 'finance'],
  [/\bbefektetes\b/gi, 'investing'],
  [/\bpiramisok\b/gi, 'pyramids'],
  [/\bpiramis\b/gi, 'pyramid'],
  [/\brezges\b/gi, 'vibration'],
  [/\brejtely\b/gi, 'mystery'],
  [/\bfelfedezes\b/gi, 'discovery'],
  [/\bfoldrenges\b/gi, 'earthquake'],
  [/\baz\b/gi, ''],
  [/\ba\b/gi, ''],
]
const GLOBAL_HU_POTENTIAL = [
  'ai', 'artificial intelligence', 'openai', 'chatgpt', 'google', 'microsoft',
  'medicine', 'medical', 'healthcare', 'cancer', 'drug', 'vaccine', 'doctor',
  'research', 'study', 'breakthrough', 'science', 'technology',
]

function normalizeTopic(topic: string) {
  return topic.trim().replace(/\s+/g, ' ')
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items))
}

function looksHungarian(text: string) {
  return HU_CHARS.test(text) || HU_WORDS.test(text)
}

function toGlobalTopic(topic: string) {
  // El\u0151sz\u00f6r \u00e9kezetmentes\u00edt\u00e9s \u2014 a \b regex csak ASCII word boundary-t ismer
  let value = normalizeTopic(topic)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  for (const [pattern, replacement] of HU_TO_GLOBAL_PHRASES) {
    value = value.replace(pattern, replacement)
  }
  value = value
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return value || normalizeTopic(topic)
}

function hasTranslatedMeaning(topic: string, globalTopic: string) {
  const normalizedOriginal = normalizeTopic(topic)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  return globalTopic.toLowerCase() !== normalizedOriginal
}

async function buildQueriesWithHaiku(topicRaw: string, region: Region): Promise<{ queries: string[]; expansion: Awaited<ReturnType<typeof generateSimilarVideoQueries>> | null }> {
  const topic = normalizeTopic(topicRaw)
  const budget = getEffectiveBudget('similarVideos')

  const expansion = await generateSimilarVideoQueries(
    topic,
    region === 'US' ? 'US' : 'HU',
    region === 'US' ? 'en' : 'hu',
  )

  const queries: string[] = []

  if (region === 'US') {
    queries.push(...expansion.en_queries)
  } else {
    if (expansion.global_adaptable && expansion.en_queries.length > 0) {
      queries.push(expansion.en_queries[0])
    }
    queries.push(...expansion.hu_queries)
    if (expansion.en_queries.length > 1) {
      queries.push(...expansion.en_queries.slice(1))
    }
  }

  const finalQueries = unique(queries)
    .map(q => q.trim())
    .filter(q => q.length > 2)
    .slice(0, budget)

  console.log(`[SimilarVideos] Haiku queries topic="${topicRaw}" region=${region} budget=${budget} queries=[${finalQueries.join(' | ')}]`)
  return { queries: finalQueries, expansion }
}

function freshnessScore(publishedAt: string) {
  const ageDays = Math.max(0, (Date.now() - new Date(publishedAt).getTime()) / DAY_MS)
  if (ageDays <= 7) return 100
  if (ageDays <= 30) return 85
  if (ageDays <= 90) return 65
  if (ageDays <= 180) return 40
  return 15
}

function freshnessLabel(publishedAt: string) {
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(publishedAt).getTime()) / DAY_MS))
  if (ageDays <= 7) return 'Nagyon friss'
  if (ageDays <= 30) return 'Friss'
  if (ageDays <= 90) return 'Aktuális'
  if (ageDays <= 180) return 'Régebbi, de használható'
  return 'Evergreen'
}

function scoreLanguageAndRegion(video: YouTubeVideoStats & { description?: string }, topic: string, region: Region) {
  const text = `${video.title} ${video.channelTitle} ${video.description || ''}`.toLowerCase()
  if (region === 'US') {
    if (looksHungarian(text)) return { score: 0, rejected: true }
    return { score: 90, rejected: false }
  }

  if (HU_REJECT_TERMS.some(term => text.includes(term))) {
    return { score: 0, rejected: true }
  }
  if (looksHungarian(text)) return { score: 95, rejected: false }
  if (GLOBAL_HU_POTENTIAL.some(term => text.includes(term)) || GLOBAL_HU_POTENTIAL.some(term => topic.toLowerCase().includes(term))) {
    return { score: 70, rejected: false }
  }
  return { score: 45, rejected: false }
}

const TRANSLATION_PAIRS: Record<string, string[]> = {
  piramisok: ['pyramid', 'pyramids', 'piramis'],
  piramis: ['pyramid', 'pyramids', 'piramisok'],
  pyramid: ['piramis', 'piramisok'],
  rezges: ['vibration', 'resonance', 'frequency'],
  vibration: ['rezges', 'rezgesei'],
  resonance: ['rezonancia', 'rezges'],
  tortenelem: ['history', 'historical'],
  history: ['tortenelem', 'tortenelmi'],
  tudomany: ['science', 'scientific'],
  science: ['tudomany', 'tudomanyos'],
  foldrenges: ['earthquake', 'seismic'],
  earthquake: ['foldrenges'],
  kutatas: ['research', 'study'],
  research: ['kutatas'],
  felfedezes: ['discovery'],
  discovery: ['felfedezes'],
  rejtely: ['mystery', 'mysterious'],
  mystery: ['rejtely', 'rejtelyes'],
}

function fuzzyWordMatch(word: string, text: string): boolean {
  if (text.includes(word)) return true
  const textWords = text.split(/[^a-z0-9]+/).filter(w => w.length > 2)

  // Translation pairs \u2014 magyar\u2194angol sz\u00f3 megfeleltet\u00e9s
  const wordFolded = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const translations = TRANSLATION_PAIRS[wordFolded] || TRANSLATION_PAIRS[word] || []
  for (const tr of translations) {
    if (text.includes(tr)) return true
    if (textWords.some(tw => tw === tr)) return true
  }

  for (const tw of textWords) {
    if (tw.length < 3 || word.length < 3) continue
    // Prefix match (4+ char k\u00f6z\u00f6s prefix)
    const minLen = Math.min(word.length, tw.length)
    const commonPrefix = [...Array(minLen)].filter((_, i) => word[i] === tw[i]).length
    if (commonPrefix >= Math.max(3, minLen - 2)) return true
    // Levenshtein-szer\u0171: max 2 elt\u00e9r\u00e9s
    if (Math.abs(word.length - tw.length) <= 2) {
      let diff = 0
      for (let i = 0; i < Math.min(word.length, tw.length); i++) {
        if (word[i] !== tw[i]) diff++
      }
      diff += Math.abs(word.length - tw.length)
      if (diff <= 2 && word.length >= 4) return true
    }
  }
  return false
}

function calcTopicSimilarity(video: YouTubeVideoStats & { description?: string }, topic: string) {
  const text = `${video.title} ${video.description || ''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const words = topic.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/i)
    .map(w => w.trim())
    .filter(w => w.length > 2 && !GENERIC_QUERY_WORDS.has(w))

  if (words.length === 0) return 35
  const matches = words.filter(w => fuzzyWordMatch(w, text)).length
  return Math.round(Math.min(100, (matches / words.length) * 100))
}

function calcCombinedRelevance(video: YouTubeVideoStats & { description?: string }, topic: string, query: string, region: Region) {
  const scoringTopic = region === 'US' ? toGlobalTopic(topic) : topic
  const searchRelevance = calcSearchRelevance(video, query)
  const topicSimilarity = calcTopicSimilarity(video, scoringTopic)
  const regionScore = scoreLanguageAndRegion(video, topic, region)
  if (regionScore.rejected) return { score: 0, rejected: true }

  const rawScore = Math.round(searchRelevance * 0.45 + topicSimilarity * 0.35 + regionScore.score * 0.20)
  const score = region === 'US' && looksHungarian(topic)
    ? Math.max(rawScore, Math.round(searchRelevance * 0.65 + regionScore.score * 0.35))
    : rawScore

  return {
    score,
    rejected: false,
  }
}

function median(nums: number[]) {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function outlierScores(videos: YouTubeVideoStats[]) {
  const med = Math.max(1, median(videos.map(v => v.viewCount)))
  const map = new Map<string, number>()
  for (const video of videos) {
    const ratio = video.viewCount / med
    const score = Math.round(Math.max(0, Math.min(100, 35 + Math.log2(ratio + 1) * 28)))
    map.set(video.videoId, score)
  }
  return map
}

function velocityScore(video: YouTubeVideoStats) {
  const viewsPerDay = calcVideoVelocity(video) * 24
  return Math.round(Math.max(0, Math.min(100, (Math.log10(viewsPerDay + 1) / Math.log10(500_000)) * 100)))
}

function velocityLabel(video: YouTubeVideoStats) {
  const viewsPerDay = Math.round(calcVideoVelocity(video) * 24)
  if (viewsPerDay >= 100_000) return `${viewsPerDay.toLocaleString('hu-HU')} / nap`
  if (viewsPerDay >= 1_000) return `${Math.round(viewsPerDay / 1000)}K / nap`
  return `${viewsPerDay.toLocaleString('hu-HU')} / nap`
}

function engagementScore(video: YouTubeVideoStats) {
  return Math.round(Math.max(0, Math.min(100, calcVideoEngagementRate(video) * 2000)))
}

function badgesFor(
  score: { relevance: number; freshness: number; velocity: number; engagement: number; outlier: number },
  decisionLabel?: string,
  decisionStatus?: 'ready' | 'watch' | 'research' | 'rejected'
) {
  const badges: string[] = decisionLabel ? [decisionLabel] : []
  if (decisionStatus === 'rejected') return badges.slice(0, 1)
  if (score.velocity >= 70) badges.push('Gyorsan növekvő')
  if (score.engagement >= 65) badges.push('Erős közönségreakció')
  if (score.outlier >= 70) badges.push('Kiugró teljesítmény')
  if (score.freshness >= 80) badges.push('Friss trendjel')
  if (score.relevance >= 80) badges.push('Releváns a témához')
  return badges.slice(0, 4)
}

function reasonFor(
  scores: { relevance: number; freshness: number; velocity: number; engagement: number; outlier: number },
  decisionStatus?: 'ready' | 'watch' | 'research' | 'rejected'
) {
  const strongest = [
    { label: 'erősen kapcsolódik a megadott témához', value: scores.relevance },
    { label: 'friss és aktuális', value: scores.freshness },
    { label: 'gyorsan gyűjti a megtekintéseket', value: scores.velocity },
    { label: 'jó reakcióarányt mutat', value: scores.engagement },
    { label: 'a hasonló találatokhoz képest kiugró teljesítményű', value: scores.outlier },
  ].sort((a, b) => b.value - a.value).slice(0, 2)

  const reason = strongest.map(s => s.label).join(' és ')
  if (decisionStatus === 'ready') return `Inspirációnak erős, mert ${reason}.`
  if (decisionStatus === 'watch') return `Érdemes figyelni, mert ${reason}, de még ellenőrizd a téma gyárthatóságát.`
  if (decisionStatus === 'research') return `Kutatási nyom: ${reason}. Önmagában még nem elég erős gyártási inspiráció.`
  if (decisionStatus === 'rejected') return `Nem ajánlott inspirációnak: nincs elég erős piaci bizonyíték ennél a találatnál.`
  return `Kutatási nyom: ${reason}.`
}
function calcNicheFit(video: { title: string; description?: string; channelTitle?: string }, niche: string): { score: number; label: string; reason: string } {
  if (!niche || niche.length < 2) return { score: 0, label: '', reason: '' }

  const nicheWords = niche.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(w => w.length > 2)
  const text = `${video.title} ${video.description || ''} ${video.channelTitle || ''}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

  let matchCount = 0
  const matchedWords: string[] = []
  for (const w of nicheWords) {
    if (fuzzyWordMatch(w, text)) {
      matchCount++
      matchedWords.push(w)
    }
  }

  const directRatio = nicheWords.length > 0 ? matchCount / nicheWords.length : 0
  const score = Math.round(Math.min(100, directRatio * 80 + (matchCount > 0 ? 20 : 0)))

  if (score >= 70) return { score, label: 'Eros niche fit', reason: `Kozvetlenul kapcsolodik: ${niche}` }
  if (score >= 40) return { score, label: 'Kozepes niche fit', reason: `Reszben kapcsolodik: ${niche}` }
  if (score > 0) return { score, label: 'Gyenge niche fit', reason: `Tavolabb all a niche-edtol, de adaptalhato` }
  return { score: 0, label: 'Nem niche-specifikus', reason: `Nem kapcsolódik közvetlenül: ${niche}. Globálisan érdekes, de adaptálni kell.` }
}

async function fetchYouTube(query: string, region: Region, publishedAfterDays: number, maxResults: number) {
  const regionCode = region === 'US' ? 'US' : 'HU'
  const lang = region === 'US' ? 'en' : 'hu'
  return youtubeSearch(query, regionCode, lang, publishedAfterDays, maxResults, 'similarVideos')
}

async function hydrateStats(items: YouTubeSearchItem[]) {
  const ids = unique(items.map(item => item.id.videoId))
  if (ids.length === 0) return new Map<string, YouTubeStatsItem>()
  return youtubeStats(ids)
}

export async function POST(request: NextRequest) {
  let requestLockId: string | undefined
  try {
    const { topic, region, max_results = 9, user_niche, use_profile_niche, platform, language, cache_only, force_refresh, paidResultId, paid_result_id } = await request.json()
    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
    }
    if (topicInputTooLong(topic)) return NextResponse.json({ error: topicTooLongResponseMessage() }, { status: 400 })

    // User azonosítás + niche lekérés
    const supabase = createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
    const userId = user.id

    let effectiveNiche = user_niche || ''
    if (!effectiveNiche && use_profile_niche === true) {
      const admin = createAdminClient()
      const { data: prof } = await admin.from('profiles').select('niche').eq('user_id', userId).single()
      effectiveNiche = prof?.niche || ''
    }
    console.log(`[SimilarVideos] niche_fit: effectiveNiche="${effectiveNiche}" topic="${topic}"`)

    // ── Perzisztens eredmény-cache — újranyitás mindig ingyenes ──────
    // Ha a user már egyszer kifizette ezt a keresést (ugyanaz a normalizált
    // topic + régió/nyelv/platform), az eredményt az adatbázisból adjuk
    // vissza: nincs új YouTube/Claude hívás, nincs új kreditlevonás.
    // Csak force_refresh indít explicit, fizetős újrakeresést.
    const searchHash = buildSearchContextHash({ userId, topic, region, language, platform })
    const paidNormalizedInput = normalizePaidResultInput(topic)
    const paidInputHash = buildPaidResultHash({
      userId,
      toolType: 'similar_videos',
      normalizedInput: paidNormalizedInput,
      region: region || 'HU',
      language: language || null,
      platform: platform || 'youtube',
    })
    if (!force_refresh) {
      const paidById = await getPaidResultById(userId, paidResultId || paid_result_id)
      const paid = paidById || await getPaidResultByHash({ userId, toolType: 'similar_videos', inputHash: paidInputHash })
      if (paid) {
        const opened = await openPaidResult(paid)
        return NextResponse.json(polishHungarianOutput({
          ...(opened.result_json as object),
          from_cache: true,
          ...paidResultResponseMeta(opened),
        }))
      }
      const cached = await getCachedSearch(searchHash, userId)
      if (cached) {
        await touchLastOpened(cached.id)
        return NextResponse.json({
          videos: polishHungarianOutput(cached.results),
          from_cache: true,
          cache_only: false,
          last_refreshed_at: cached.last_refreshed_at,
          created_at: cached.created_at,
          warning: null,
        })
      }
      if (cache_only) {
        // Csak cache-ellenőrzés volt kérve (frontend előzetes próba) — nincs
        // cache, nem indítunk fizetős keresést, nem vonunk le semmit.
        return NextResponse.json({ videos: [], from_cache: false, cache_miss: true })
      }
    }

    // Backend-side usage ellenőrzés — kredit levonás CSAK ha tényleg YouTube search fut (nem cache)
    const usageCheck = await checkUsagePermission(userId, 'similar_videos')
    if (!usageCheck.canRun) {
      return NextResponse.json({
        videos: [],
        queries_used: [],
        warning: usageCheck.message,
        usage_blocked: true,
      })
    }
    const lock = await acquireRequestLock({ userId, toolType: 'similar_videos', inputHash: paidInputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }
    requestLockId = lock.lockId

    // Kredit levonást később végezzük, a YouTube keresés után — csak ha nem cache hit
    let creditCharged = false
    if (usageCheck.cost > 0) {
      // Egyelőre nem vonunk le — a keresés után döntünk
      const hasEnough = usageCheck.canRun
      if (!hasEnough) {
        return NextResponse.json({
          videos: [],
          queries_used: [],
          warning: 'Nincs elég kredited ehhez a művelethez.',
          usage_blocked: true,
          credits_remaining: usageCheck.currentCredits,
        })
      }
    }

    startNewRequest(`similar-${Date.now()}`)
    let regionCode: Region = region === 'US' ? 'US' : 'HU'
    const topicIsEnglish = !looksHungarian(topic) && /^[a-zA-Z0-9\s\-.,!?'"()]+$/.test(topic.trim())
    if (regionCode === 'HU' && topicIsEnglish) {
      regionCode = 'US'
    }

    // Haiku query expansion — bármilyen magyar témát kezel
    const { queries, expansion: haikuExpansion } = await buildQueriesWithHaiku(topic, regionCode)
    if (queries.length === 0) return NextResponse.json({ videos: [], queries_used: [] })

    // Párhuzamos keresés — angol query-k US-ben, magyar query-k HU-ban
    let freshness_window_days = 180
    const allResults = await Promise.all(queries.map(async query => {
      const isEnQuery = /^[a-zA-Z0-9\s\-.,!?'"()]+$/.test(query.trim())
      const queryRegion: Region = isEnQuery ? 'US' : regionCode
      const items = await fetchYouTube(query, queryRegion, 180, 8)
      return items.map(item => ({ ...item, query }))
    }))
    let searchItems = allResults.flat()

    // Ha kevés eredmény, bővítjük 365 napra
    if (searchItems.length < 4 && queries.length > 0) {
      freshness_window_days = 365
      const fallbackItems = await fetchYouTube(queries[0], regionCode === 'HU' && topicIsEnglish ? 'US' : regionCode, 365, 10)
      searchItems = [...searchItems, ...fallbackItems.map(item => ({ ...item, query: queries[0] }))]
    }

    const deduped = Array.from(new Map(searchItems.map(item => [item.id.videoId, item])).values())
    console.log(`[SimilarVideos] topic="${topic}" region=${regionCode} queries=${queries.length} searchItems=${searchItems.length} deduped=${deduped.length}`)
    if (deduped.length === 0) {
      return NextResponse.json({ videos: [], queries_used: queries, freshness_window_days, debug: { searchItems: searchItems.length, region: regionCode, topicIsEnglish } })
    }

    const statsMap = await hydrateStats(deduped)
    const baseVideos = deduped.map(item => {
      const stats = statsMap.get(item.id.videoId)
      return {
        videoId: item.id.videoId,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        channelId: item.snippet.channelId || null,
        publishedAt: item.snippet.publishedAt,
        viewCount: parseInt(stats?.statistics.viewCount || '0'),
        likeCount: parseInt(stats?.statistics.likeCount || '0'),
        commentCount: parseInt(stats?.statistics.commentCount || '0'),
        thumbnailUrl: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url || '',
        description: item.snippet.description || '',
        query: item.query,
        duration: stats?.contentDetails?.duration || null,
      }
    })

    // Passzív adatvagyon-gyűjtés — amit amúgy is lekértünk, azt mentjük is.
    // await-elve (serverless függvény leállhat a válasz után), de a helper
    // maga try/catch-elt, tehát hiba esetén sem blokkolja/töri a fő funkciót.
    await recordVideoSnapshots(baseVideos.map(v => ({
      videoId: v.videoId,
      title: v.title,
      channelId: v.channelId,
      channelTitle: v.channelTitle,
      publishedAt: v.publishedAt,
      viewCount: v.viewCount,
      likeCount: v.likeCount,
      commentCount: v.commentCount,
    })))

    // Relevancia scoring — a QUERY-hez mérjük (nem az eredeti user inputhoz),
    // mert a Haiku már lefordította a témát célzott keresési kifejezésre
    const relevantBase = baseVideos
      .map(video => {
        const queryRelevance = calcCombinedRelevance(video, video.query, video.query, regionCode)
        const topicRelevance = calcCombinedRelevance(video, topic, video.query, regionCode)
        const bestRelevance = queryRelevance.score > topicRelevance.score ? queryRelevance : topicRelevance
        return { video, relevance: bestRelevance }
      })
      .filter(item => {
        if (item.relevance.rejected) return false
        if (item.relevance.score >= MIN_SIMILAR_VIDEO_RELEVANCE) return true
        // Ha a Haiku validálta a témát, engedékenyebb gate (40)
        if (haikuExpansion && item.relevance.score >= 40) return true
        return false
      })

    const outlierMap = outlierScores(relevantBase.map(item => item.video))

    const videos: ViralSimilarVideo[] = relevantBase.map(({ video, relevance }) => {
      // A relevancia mindig a ténylegesen számolt érték — korábban itt egy
      // mesterséges Math.max(...,60) felkerekítés volt "ha a Haiku validálta,
      // a relevancia legalább 60" címen, ami pontosan a decideSimilarVideo()
      // relevancia-kapuját (< 60 = elutasítva) kerülte meg: egy 40-59 közötti,
      // valójában irreleváns találat így "épp átment" a kapun, és onnantól
      // pusztán a frissesség/engagement alapján kaphatott "Ajánlott inspiráció"
      // címkét — élesben ez engedte át pl. egy Michael Jackson-videót egy
      // "budapest mesterséges intelligencia kórházak" keresésnél.
      const search_relevance = relevance.score
      const freshness_score = freshnessScore(video.publishedAt)
      const velocity_score = velocityScore(video)
      const engagement_score = engagementScore(video)
      const outlier_score = outlierMap.get(video.videoId) || 35
      const views_per_day = Math.round(calcVideoVelocity(video) * 24)
      const decision = decideSimilarVideo({
        relevance_score: search_relevance,
        freshness_score,
        velocity_score,
        engagement_score,
        outlier_score,
        view_count: video.viewCount,
        views_per_day,
        published_at: video.publishedAt,
      })
      const viral_video_score = decision.score
      const scores = { relevance: search_relevance, freshness: freshness_score, velocity: velocity_score, engagement: engagement_score, outlier: outlier_score }

      return {
        video_id: video.videoId,
        title: video.title,
        channel_title: video.channelTitle,
        thumbnail_url: video.thumbnailUrl,
        view_count: video.viewCount,
        like_count: video.likeCount,
        comment_count: video.commentCount,
        published_at: video.publishedAt,
        url: `https://youtube.com/watch?v=${video.videoId}`,
        duration: video.duration,
        relevance_score: search_relevance,
        viral_video_score,
        score_breakdown: { search_relevance, freshness_score, velocity_score, engagement_score, outlier_score },
        reason: reasonFor(scores, decision.status),
        freshness_label: freshnessLabel(video.publishedAt),
        velocity_label: velocityLabel(video),
        badges: badgesFor(scores, decision.label, decision.status),
        decision_status: decision.status,
        decision_label: decision.label,
        decision_score: decision.score,
        risk_flags: decision.risk_flags,
        niche_fit: calculateNicheFit({ title: video.title, description: video.description, channelTitle: video.channelTitle }, effectiveNiche, relevance.score),
      }
    })

    // ready/watch videók elől, research utána — de ne dobjunk el semmit
    const readyWatch = videos
      .filter(v => v.decision_status === 'ready' || v.decision_status === 'watch')
      .sort((a, b) => b.viral_video_score - a.viral_video_score)
    const research = videos
      .filter(v => v.decision_status === 'research')
      .sort((a, b) => b.viral_video_score - a.viral_video_score)
    const rejected = videos
      .filter(v => v.decision_status === 'rejected')
      .sort((a, b) => b.viral_video_score - a.viral_video_score)

    let finalVideos = [...readyWatch, ...research, ...rejected].slice(0, max_results)

    // Ha még mindig üres, lazítsuk a relevancia küszöböt
    if (finalVideos.length === 0 && baseVideos.length > 0) {
      const looseRelevance = baseVideos
        .map(video => ({ video, relevance: calcCombinedRelevance(video, topic, video.query, regionCode) }))
        .filter(item => !item.relevance.rejected && item.relevance.score >= 25)
      const looseOutlierMap = outlierScores(looseRelevance.map(item => item.video))

      finalVideos = looseRelevance.map(({ video, relevance }) => {
        const search_relevance = relevance.score
        const freshness_score_val = freshnessScore(video.publishedAt)
        const velocity_score_val = velocityScore(video)
        const engagement_score_val = engagementScore(video)
        const outlier_score_val = looseOutlierMap.get(video.videoId) || 35
        const views_per_day = Math.round(calcVideoVelocity(video) * 24)
        const decision = decideSimilarVideo({
          relevance_score: search_relevance, freshness_score: freshness_score_val,
          velocity_score: velocity_score_val, engagement_score: engagement_score_val,
          outlier_score: outlier_score_val, view_count: video.viewCount,
          views_per_day, published_at: video.publishedAt,
        })
        const scores = { relevance: search_relevance, freshness: freshness_score_val, velocity: velocity_score_val, engagement: engagement_score_val, outlier: outlier_score_val }
        return {
          video_id: video.videoId, title: video.title, channel_title: video.channelTitle,
          thumbnail_url: video.thumbnailUrl, view_count: video.viewCount,
          like_count: video.likeCount, comment_count: video.commentCount,
          published_at: video.publishedAt, url: `https://youtube.com/watch?v=${video.videoId}`,
          duration: video.duration, relevance_score: search_relevance,
          viral_video_score: decision.score,
          score_breakdown: { search_relevance, freshness_score: freshness_score_val, velocity_score: velocity_score_val, engagement_score: engagement_score_val, outlier_score: outlier_score_val },
          reason: reasonFor(scores, decision.status), freshness_label: freshnessLabel(video.publishedAt),
          velocity_label: velocityLabel(video), badges: badgesFor(scores, decision.label, decision.status),
          decision_status: decision.status, decision_label: decision.label,
          decision_score: decision.score, risk_flags: decision.risk_flags,
          niche_fit: calculateNicheFit({ title: video.title, description: video.description, channelTitle: video.channelTitle }, effectiveNiche, relevance.score),
        } as ViralSimilarVideo
      }).sort((a, b) => b.viral_video_score - a.viral_video_score).slice(0, max_results)
    }

    // Kredit levonás + usage log — CSAK ha tényleg volt keresés (nem üres eredmény cache-ből)
    const polishedFinalVideos = polishHungarianOutput(finalVideos)
    const hadRealSearch = polishedFinalVideos.length > 0
    let savedPaidResultId: string | null = null
    if (userId && hadRealSearch) {
      if (usageCheck.cost > 0 && !creditCharged) {
        const charge = await chargeProtectedFeature(userId, 'similar_videos', { topic })
        creditCharged = charge.success
        if (!charge.success) {
          return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a kereséshez.' }, { status: 402 })
        }
      } else if (usageCheck.cost === 0) {
        // Ingyenes napi kvótából futott — nincs kredit levonás, de a
        // "Legutóbbi történeted" panelen meg kell jelennie a keresésnek.
        await logFreeProductUse(userId, 'similar_videos', { topic }).catch(() => {})
      }
      await logYouTubeSearch({
        userId,
        featureName: 'similar_videos',
        query: topic,
        searchCount: queries.length,
        wasCached: false,
        planType: 'beta',
      }).catch(() => {})

      // Perzisztens mentés — hogy az újranyitás (más session, más nap) ingyenes
      // legyen. A user már fizetett ezért a keresésért (ha kredit kellett hozzá),
      // ezért a mentés hibája KRITIKUS — logoljuk, de a választ így is visszaadjuk.
      const responsePayload = {
        videos: polishedFinalVideos,
        queries_used: queries,
        interpreted_topic: haikuExpansion?.interpreted_topic || topic,
        global_adaptable: haikuExpansion?.global_adaptable ?? false,
        freshness_window_days,
        region_used: regionCode,
        min_relevance: MIN_SIMILAR_VIDEO_RELEVANCE,
        quota: quotaSummary(),
        warning: polishedFinalVideos.length === 0
          ? (quotaSummary().is_exhausted
              ? 'YouTube API kvóta kimerült. A keresés holnap újra elérhető, vagy próbáld cache-ből.'
              : 'Nem találtunk elég erős Similar Videos találatot erre a témára.')
          : null,
      }

      const paidSave = await savePaidResult({
        userId,
        toolType: 'similar_videos',
        inputHash: paidInputHash,
        normalizedInput: paidNormalizedInput,
        originalInput: topic,
        region: regionCode,
        language: language || null,
        platform: platform || null,
        resultJson: responsePayload,
        summaryJson: { result_count: polishedFinalVideos.length, topic },
        creditCost: usageCheck.cost > 0 ? usageCheck.cost : 0,
        freshForHours: 6,
      })
      if (!paidSave.success) {
        console.error('[SimilarVideos] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
      }
      savedPaidResultId = paidSave.record?.id || null

      await saveSearchResult({
        userId,
        hash: searchHash,
        normalizedTopic: normalizeTopicForHash(topic),
        originalTopic: topic,
        region: regionCode,
        language: language || null,
        platform: platform || null,
        queryVariants: queries,
        results: polishedFinalVideos,
        creditCost: usageCheck.cost > 0 ? usageCheck.cost : 0,
      })

      // ── Video Idea — proof signal bekötés ─────────────────────
      // A Similar Videos találatait a topic mögötti Video Idea bizonyítékaként
      // mentjük, hogy a Creator OS command center ne csak témát, hanem valós
      // piaci jelet lásson. Hiba itt sosem törheti el a fő választ — a service
      // funkciók maguk is try/catch-eltek.
      const ideaPlatform = platform || 'youtube'
      const ideaLanguage = language || (regionCode === 'US' ? 'en' : 'hu')
      const ideaMarket = regionCode
      const videoIdeaHash = buildVideoIdeaInputHash({ userId, topic, platform: ideaPlatform, language: ideaLanguage, market: ideaMarket })
      const videoIdeaAdmin = createAdminClient()
      const existingWorkflowStatus = await getVideoIdeaWorkflowStatus(videoIdeaAdmin, userId, videoIdeaHash)
      const readyCount = polishedFinalVideos.filter(v => v.decision_status === 'ready').length
      const watchCount = polishedFinalVideos.filter(v => v.decision_status === 'watch').length
      const candidateStatus = readyCount > 0 || watchCount > 0 ? 'validated' : 'validating'

      const ideaResult = await ensureVideoIdea(videoIdeaAdmin, {
        userId,
        topic,
        platform: ideaPlatform,
        language: ideaLanguage,
        market: ideaMarket,
        inputHash: videoIdeaHash,
        workflowStatus: forwardWorkflowStatus(existingWorkflowStatus, candidateStatus),
        proofSummary: `Similar Videos: ${polishedFinalVideos.length} találat (${readyCount} ajánlott, ${watchCount} figyelendő).`,
      })

      if (ideaResult.success && ideaResult.idea) {
        const proofVideos = polishedFinalVideos.filter(v => v.decision_status !== 'rejected').slice(0, 8)
        const strengthFor = (status: string) => status === 'ready' ? 'strong' : status === 'watch' ? 'medium' : 'weak'
        await Promise.all(proofVideos.map(video => addVideoIdeaProofSignal(videoIdeaAdmin, {
          userId,
          videoIdeaId: ideaResult.idea!.id,
          signalType: 'similar_video',
          sourceTool: 'similar_videos',
          sourceId: video.video_id,
          title: video.title,
          url: video.url,
          channelTitle: video.channel_title,
          publishedAt: video.published_at,
          viewCount: video.view_count,
          relevanceScore: video.relevance_score,
          strength: strengthFor(video.decision_status),
          reason: video.reason,
          payload: { decision_status: video.decision_status, decision_score: video.decision_score, badges: video.badges },
        })))

        await logVideoIdeaEvent(videoIdeaAdmin, {
          userId,
          videoIdeaId: ideaResult.idea.id,
          eventType: 'similar_videos_completed',
          sourceTool: 'similar_videos',
          payload: { topic, video_count: polishedFinalVideos.length, ready_count: readyCount, watch_count: watchCount },
        })
      }
    }

    return NextResponse.json({
      videos: polishedFinalVideos,
      queries_used: queries,
      from_cache: false,
      interpreted_topic: haikuExpansion?.interpreted_topic || topic,
      global_adaptable: haikuExpansion?.global_adaptable ?? false,
      freshness_window_days,
      region_used: regionCode,
      min_relevance: MIN_SIMILAR_VIDEO_RELEVANCE,
      quota: quotaSummary(),
      warning: polishedFinalVideos.length === 0
        ? (quotaSummary().is_exhausted
            ? 'YouTube API kvóta kimerült. A keresés holnap újra elérhető, vagy próbáld cache-ből.'
            : 'Nem találtunk elég erős Similar Videos találatot erre a témára.')
        : null,
      from_paid_result: false,
      cache_status: 'fresh',
      requires_credit: usageCheck.cost > 0,
      paid_result_id: savedPaidResultId,
    })
  } catch (error) {
    console.error('Similar Videos error:', error)
    const reason = (error as { errors?: Array<{ reason?: string }> })?.errors?.[0]?.reason || null
    return NextResponse.json({ videos: [], error: 'Videók betöltése sikertelen.', error_detail: reason }, { status: 500 })
  } finally {
    await releaseRequestLock(requestLockId)
  }
}

