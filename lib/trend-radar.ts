// lib/trend-radar.ts
// WillViral — Trend Radar v3
// KRITIKUS FIX: Serper topic extraction → külön YouTube validation per topic
// Soha nem örökli az eredeti seed YouTube videóit

import type { NicheCategory } from './niche-seeds'

import { youtubeSearch, youtubeStats, getEffectiveBudget, startNewRequest, type YouTubeSearchItem as YTSearchItem } from './youtube-service'
import { recordVideoSnapshots, recordTrendCandidates } from './youtube-snapshot'

const SERPER_API_KEY = process.env.SERPER_API_KEY!

// ── Típusok ──────────────────────────────────────────────────

export type TrendSourceType =
  | 'serper_youtube'        // Serper + YouTube UGYANARRÓL a témáról
  | 'serper_only'           // Csak Serper validált
  | 'youtube_multi_creator' // Csak YouTube, 3+ creator
  | 'weak_signal'           // Gyenge jel

export type TrendConfidence = 'high' | 'medium' | 'low' | 'rejected'

export interface SerperResult {
  title: string
  link: string
  snippet: string
  date?: string
  source?: string
}

export interface YouTubeVideoRaw {
  videoId: string
  title: string
  channelTitle: string
  channelId: string
  publishedAt: string
  viewCount: number
  likeCount: number
  commentCount: number
  thumbnailUrl: string
  description?: string
}

export interface VideoWithRelevance extends YouTubeVideoRaw {
  relevance_score: number
  region_relevance: number
  is_region_relevant: boolean
  relevance_signals: string[]
  market_label: 'hungarian_market' | 'global_with_hungarian_potential' | 'irrelevant_for_region'
}

export interface TrendCandidate {
  id: string
  candidate_topic: string
  candidate_topic_en?: string       // Angol keresési query a YouTube validációhoz
  category: NicheCategory
  region: string
  trend_source_type: TrendSourceType
  confidence: TrendConfidence
  opportunity_type: 'strong_trend' | 'early_opportunity' | 'validated_youtube' | 'weak'
  serper_evidence_count: number
  youtube_relevant_videos_count: number
  unique_creator_count: number
  freshness_score: number
  pollution_score: number
  relevance_average: number
  source_videos: VideoWithRelevance[]
  web_sources: SerperResult[]
  seed_keyword: string
  market_type: 'hungarian_market' | 'global_with_hungarian_potential' | 'mixed'
  reject_reason?: string
}

// ── Serper API hívások ────────────────────────────────────────

async function fetchSerperNews(query: string, region: string): Promise<SerperResult[]> {
  if (!SERPER_API_KEY) return []
  try {
    const gl = region === 'HU' ? 'hu' : 'us'
    const hl = region === 'HU' ? 'hu' : 'en'
    const res = await fetch('https://google.serper.dev/news', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl, hl, num: 10 }),
    })
    const data = await res.json()
    return (data.news || []).map((item: { title?: string; link?: string; snippet?: string; date?: string; source?: string }) => {
      // Google News redirect URL-ek (CAES...) nem nyithatók meg közvetlenül
      // Helyette Google keresési linket generálunk a cikk title alapján
      const rawLink = item.link || ''
      const isGoogleRedirect = rawLink.startsWith('CAES') || rawLink.includes('google.com/url')
      const usableLink = isGoogleRedirect
        ? `https://www.google.com/search?q=${encodeURIComponent(item.title || '')}`
        : rawLink
      return {
        title: item.title || '',
        link: usableLink,
        snippet: item.snippet || '',
        date: item.date,
        source: item.source,
        is_search_fallback: isGoogleRedirect,
      }
    })
  } catch { return [] }
}

async function fetchSerperWeb(query: string, region: string): Promise<SerperResult[]> {
  if (!SERPER_API_KEY) return []
  try {
    const gl = region === 'HU' ? 'hu' : 'us'
    const hl = region === 'HU' ? 'hu' : 'en'
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl, hl, num: 10 }),
    })
    const data = await res.json()
    return (data.organic || []).slice(0, 5).map((item: { title?: string; link?: string; snippet?: string; date?: string; displayLink?: string }) => ({
      title: item.title || '',
      link: item.link || '',
      snippet: item.snippet || '',
      date: item.date,
      source: item.displayLink,
    }))
  } catch { return [] }
}

// ── YouTube keresés ───────────────────────────────────────────

async function fetchYouTubeForTopic(
  query: string,
  regionCode: string,
  relevanceLanguage: string,
  publishedAfterDays: number,
  maxResults = 8,
): Promise<YouTubeVideoRaw[]> {
  const items = await youtubeSearch(query, regionCode, relevanceLanguage, publishedAfterDays, maxResults, 'opportunityEngine')
  if (items.length === 0) return []

  const videoIds = items.map(i => i.id.videoId)
  const statsMap = await youtubeStats(videoIds)

  return items.map(item => {
    const stats = statsMap.get(item.id.videoId)
    return {
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      channelId: item.snippet.channelId || '',
      publishedAt: item.snippet.publishedAt,
      viewCount: parseInt(stats?.statistics.viewCount || '0'),
      likeCount: parseInt(stats?.statistics.likeCount || '0'),
      commentCount: parseInt(stats?.statistics.commentCount || '0'),
      thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
      description: item.snippet.description || '',
    }
  })
}

// ── Serper találatokból konkrét trend topic-ok kinyerése ──────

interface ExtractedTopic {
  topic_hu: string           // Magyar megnevezés
  topic_en: string           // Angol keresési query a YouTube validációhoz
  key_entity: string         // Fő entitás (személy, esemény, dolog)
  serper_sources: SerperResult[]
  freshness_score: number
}

function extractTrendTopicsFromSerper(
  serperResults: SerperResult[],
  seedKeyword: string,
  region: string,
  freshnessWindowDays: number,
): ExtractedTopic[] {
  if (serperResults.length === 0) return []

  // Frissesség szűrés
  const freshResults = serperResults.filter(r => {
    if (!r.date) return true
    if (r.date.includes('hour') || r.date.includes('day') || r.date.includes('week') ||
        r.date.includes('óra') || r.date.includes('nap') || r.date.includes('hete')) return true
    try {
      const daysSince = (Date.now() - new Date(r.date).getTime()) / 86400000
      return daysSince <= freshnessWindowDays
    } catch { return true }
  })

  if (freshResults.length === 0) return []

  // Entitás kinyerés a Serper találatokból
  // Ismétlődő entitások = trending topic
  const entityCount = new Map<string, { count: number; sources: SerperResult[]; titles: string[] }>()

  for (const result of freshResults) {
    const text = `${result.title} ${result.snippet}`

    // Nagybetűs szavak mint entitások (nevek, helyszínek, termékek)
    const entities = text.match(/\b[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]+(?:\s[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]+)*\b/g) || []

    // 2+ szavas entitások preferáltak (pontosabb topic)
    const multiWordEntities = entities.filter(e => e.split(' ').length >= 2 && e.length > 5)
    const allEntities = [...new Set([...multiWordEntities, ...entities.slice(0, 5)])]

    for (const entity of allEntities.slice(0, 5)) {
      const key = entity.toLowerCase().trim()
      if (key.length < 4) continue
      // Kizárjuk a túl általános szavakat
      if (['this', 'that', 'with', 'from', 'have', 'been', 'will', 'they', 'what', 'when', 'where'].includes(key)) continue

      const existing = entityCount.get(key) || { count: 0, sources: [], titles: [] }
      existing.count++
      existing.sources.push(result)
      existing.titles.push(result.title)
      entityCount.set(key, existing)
    }
  }

  // Rendezés: legtöbbször ismétlődő entitás = trending
  const sortedEntities = Array.from(entityCount.entries())
    .filter(([_, v]) => v.count >= 1)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)

  const topics: ExtractedTopic[] = []

  for (const [entityKey, entityData] of sortedEntities) {
    // A legfontosabb forrás title-ből kinyerjük a konkrét topic-ot
    const bestSource = entityData.sources[0]
    const topicTitle = bestSource.title

    // Angol YouTube validation query generálás
    // A fő entitást + kontextust tartalmazza
    const topicEn = region === 'HU'
      ? `${entityKey} ${seedKeyword.split(' ').slice(-1)[0]}`.trim().slice(0, 60)
      : topicTitle.slice(0, 60)

    // Magyar megnevezés — az eredeti Serper title alapján
    const topicHu = topicTitle.slice(0, 80)

    const freshnessScore = entityData.sources.some(s =>
      s.date && (s.date.includes('hour') || s.date.includes('óra') || s.date.includes('day') || s.date.includes('nap'))
    ) ? 90 : 60

    topics.push({
      topic_hu: topicHu,
      topic_en: topicEn,
      key_entity: entityKey,
      serper_sources: entityData.sources.slice(0, 3),
      freshness_score: freshnessScore,
    })
  }

  // Ha nincs jól kinyert topic, használjuk a legjobb Serper result title-t
  if (topics.length === 0 && freshResults.length > 0) {
    const best = freshResults[0]
    topics.push({
      topic_hu: best.title.slice(0, 80),
      topic_en: best.title.slice(0, 60),
      key_entity: best.title.split(' ').slice(0, 3).join(' '),
      serper_sources: [best],
      freshness_score: 70,
    })
  }

  return topics
}

// ── Region relevance ──────────────────────────────────────────

const HUNGARIAN_CHARS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/
const HUNGARIAN_WORDS = /\b(magyar|magyarország|budapest|kormány|fidesz|orbán|mnb|mta|telex|444|hvg|index|portfolio|rtl|atv|m1|m2)\b/i

const GLOBALLY_RELEVANT_HU = [
  'google', 'apple', 'microsoft', 'meta', 'openai', 'chatgpt', 'gemini',
  'nasa', 'james webb', 'space', 'ai', 'artificial intelligence',
  'cancer', 'crispr', 'quantum', 'bitcoin', 'ethereum', 'crypto',
  'elon musk', 'tesla', 'spacex', 'climate',
]

const REGION_IRRELEVANT_HU = [
  'south africa', 'nigeria', 'kenya', 'ghana', 'india', 'pakistan',
  'mk party', 'anc', 'da party', 'newzroom', 'sabc',
  'neet exam', 'lok sabha', 'rajya sabha',
  'assemblée nationale', 'bundestag parliament uk',
]

function scoreRegionRelevance(video: YouTubeVideoRaw, region: string): {
  score: number
  market_label: VideoWithRelevance['market_label']
} {
  if (region !== 'HU') return { score: 70, market_label: 'global_with_hungarian_potential' }

  const text = `${video.title} ${video.channelTitle} ${video.description || ''}`.toLowerCase()

  if (REGION_IRRELEVANT_HU.some(t => text.includes(t.toLowerCase()))) {
    return { score: 0, market_label: 'irrelevant_for_region' }
  }

  if (HUNGARIAN_CHARS.test(video.title) || HUNGARIAN_WORDS.test(text)) {
    return { score: 95, market_label: 'hungarian_market' }
  }

  if (GLOBALLY_RELEVANT_HU.some(t => text.includes(t.toLowerCase()))) {
    return { score: 60, market_label: 'global_with_hungarian_potential' }
  }

  return { score: 30, market_label: 'global_with_hungarian_potential' }
}

// ── Video relevance scoring — TOPIC szintű ───────────────────
// KRITIKUS: a relevanciát a candidate_topic-hoz mérjük, NEM az eredeti seed-hez

export function scoreVideoRelevanceForTopic(
  video: YouTubeVideoRaw,
  candidateTopic: string,     // A konkrét topic (nem a seed)
  keyEntity: string,          // Fő entitás amit keresünk
  freshnessWindowDays: number,
  region: string,
): { score: number; regionRelevance: number; isRegionRelevant: boolean; signals: string[]; marketLabel: VideoWithRelevance['market_label'] } {
  let score = 0
  const signals: string[] = []
  const titleLower = video.title.toLowerCase()
  const descLower = (video.description || '').toLowerCase()

  // 1. Fő entitás egyezés a title-ben (max 40 pont) — LEGFONTOSABB
  const entityWords = keyEntity.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  const entityMatchInTitle = entityWords.filter(w => titleLower.includes(w))
  const entityMatchRatio = entityWords.length > 0 ? entityMatchInTitle.length / entityWords.length : 0

  if (entityMatchRatio >= 0.8) {
    score += 40
    signals.push('Erős entitás egyezés a címben')
  } else if (entityMatchRatio >= 0.5) {
    score += 25
    signals.push('Részleges entitás egyezés')
  } else if (entityMatchRatio > 0) {
    score += 10
  } else {
    // Ha a fő entitás NEM szerepel a title-ben → ez nem evidence videó
    score -= 20
    signals.push('Entitás nem található a címben')
  }

  // 2. Topic szavak a title-ben (max 20 pont)
  const topicWords = candidateTopic.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  const topicMatchInTitle = topicWords.filter(w => titleLower.includes(w))
  const topicMatchRatio = topicWords.length > 0 ? topicMatchInTitle.length / topicWords.length : 0
  score += Math.round(topicMatchRatio * 20)

  // 3. Description relevancia (max 10 pont)
  const entityInDesc = entityWords.filter(w => descLower.includes(w)).length
  if (entityInDesc > 0) score += 10

  // 4. Freshness (max 20 pont)
  const daysSince = Math.floor((Date.now() - new Date(video.publishedAt).getTime()) / 86400000)
  const freshnessRatio = Math.max(0, 1 - (daysSince / freshnessWindowDays))
  score += Math.round(freshnessRatio * 20)
  if (daysSince <= 7) signals.push('Nagyon friss')
  else if (daysSince <= 30) signals.push('Friss tartalom')

  // 5. View count (max 10 pont)
  if (video.viewCount > 100000) { score += 10; signals.push('Nagy nézettség') }
  else if (video.viewCount > 10000) score += 5
  else if (video.viewCount > 1000) score += 2

  // 6. Region relevance
  const { score: regionScore, market_label } = scoreRegionRelevance(video, region)

  if (region === 'HU') {
    if (regionScore === 0) {
      return {
        score: 0,
        regionRelevance: 0,
        isRegionRelevant: false,
        signals: [...signals, 'Nem releváns HU piacnak'],
        marketLabel: 'irrelevant_for_region',
      }
    }
    if (market_label === 'hungarian_market') {
      score += 15
      signals.push('Magyar tartalom')
    }
  }

  const finalScore = Math.max(0, Math.min(100, score))
  const isRegionRelevant = region === 'HU'
    ? (market_label !== 'irrelevant_for_region' && finalScore >= 60)
    : finalScore >= 60

  return {
    score: finalScore,
    regionRelevance: regionScore,
    isRegionRelevant,
    signals,
    marketLabel: market_label,
  }
}


// ── Topic Match Gate ─────────────────────────────────────────
// serper_youtube csak akkor érvényes ha ugyanarról a konkrét témáról szól

function topicMatchSerperYoutube(
  candidateTopic: string,
  keyEntity: string,
  video: YouTubeVideoRaw,
): boolean {
  const titleLower = video.title.toLowerCase()
  const descLower = (video.description || '').toLowerCase()
  const entityWords = keyEntity.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  const topicWords = candidateTopic.toLowerCase().split(/\s+/).filter(w => w.length > 3)

  // Main entity match - legalább 60% egyezés kell
  const entityMatchInTitle = entityWords.filter(w => titleLower.includes(w))
  const entityMatchRatio = entityWords.length > 0 ? entityMatchInTitle.length / entityWords.length : 0
  if (entityMatchRatio >= 0.6) return true

  // Entity in description
  const entityMatchInDesc = entityWords.filter(w => descLower.includes(w))
  const descMatchRatio = entityWords.length > 0 ? entityMatchInDesc.length / entityWords.length : 0
  if (descMatchRatio >= 0.7) return true

  // Topic similarity - topic szavak 50%+ egyezik
  const topicMatchInTitle = topicWords.filter(w => titleLower.includes(w))
  const topicMatchRatio = topicWords.length > 0 ? topicMatchInTitle.length / topicWords.length : 0
  if (topicMatchRatio >= 0.5) return true

  return false
}

function normalizeForMatch(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function meaningfulWords(value: string) {
  const stopwords = new Set([
    'hogy', 'mint', 'vagy', 'mert', 'amit', 'ami', 'egy', 'ezt', 'azt', 'the', 'and', 'for', 'with',
    'this', 'that', 'from', 'are', 'was', 'were', 'new', 'why', 'how',
  ])

  return normalizeForMatch(value)
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w))
}

function sourceMatchesTopic(source: SerperResult, candidateTopic: string, keyEntity: string) {
  const sourceText = normalizeForMatch(`${source.title} ${source.snippet}`)
  const entityWords = meaningfulWords(keyEntity)
  const topicWords = meaningfulWords(candidateTopic)
  const requiredEntityWords = entityWords.length > 0 ? entityWords : topicWords.slice(0, 4)

  const entityMatches = requiredEntityWords.filter(w => sourceText.includes(w)).length
  const topicMatches = topicWords.filter(w => sourceText.includes(w)).length
  const entityRatio = requiredEntityWords.length > 0 ? entityMatches / requiredEntityWords.length : 0
  const topicRatio = topicWords.length > 0 ? topicMatches / topicWords.length : 0

  return entityRatio >= 0.6 || topicRatio >= 0.45 || (entityMatches >= 2 && topicMatches >= 2)
}

function filterSerperSourcesForTopic(
  sources: SerperResult[],
  candidateTopic: string,
  keyEntity: string,
) {
  return sources.filter(source => sourceMatchesTopic(source, candidateTopic, keyEntity)).slice(0, 5)
}

// ── Pollution score ───────────────────────────────────────────

function computePollutionScore(videos: VideoWithRelevance[]): number {
  if (videos.length === 0) return 100
  const avgRelevance = videos.reduce((s, v) => s + v.relevance_score, 0) / videos.length
  const uniqueChannels = new Set(videos.map(v => v.channelId)).size
  const diversity = Math.min(1, uniqueChannels / Math.max(videos.length, 1))
  return Math.max(0, Math.round(100 - avgRelevance - diversity * 20))
}

// ── Trend Source Validator ────────────────────────────────────

function validateTrendSource(
  serperCount: number,
  youtubeRelevantCount: number,
  uniqueCreatorCount: number,
): { trend_source_type: TrendSourceType; confidence: TrendConfidence; opportunity_type: TrendCandidate['opportunity_type'] } {
  if (serperCount >= 2 && youtubeRelevantCount >= 2) {
    return {
      trend_source_type: 'serper_youtube',
      confidence: serperCount >= 4 && youtubeRelevantCount >= 3 ? 'high' : 'medium',
      opportunity_type: 'strong_trend',
    }
  }
  if (serperCount >= 2 && youtubeRelevantCount < 2) {
    return {
      trend_source_type: 'serper_only',
      confidence: serperCount >= 4 ? 'medium' : 'low',
      opportunity_type: 'early_opportunity',
    }
  }
  if (youtubeRelevantCount >= 3 && uniqueCreatorCount >= 3) {
    return {
      trend_source_type: 'youtube_multi_creator',
      confidence: uniqueCreatorCount >= 5 ? 'medium' : 'low',
      opportunity_type: 'validated_youtube',
    }
  }
  return {
    trend_source_type: 'weak_signal',
    confidence: 'low',
    opportunity_type: 'weak',
  }
}

function computeSerperFreshness(results: SerperResult[], windowDays: number): number {
  if (results.length === 0) return 0
  let freshCount = 0
  for (const r of results) {
    if (!r.date) { freshCount += 0.5; continue }
    if (r.date.includes('hour') || r.date.includes('day') || r.date.includes('week') ||
        r.date.includes('óra') || r.date.includes('nap')) freshCount++
    else {
      try {
        const daysSince = (Date.now() - new Date(r.date).getTime()) / 86400000
        if (daysSince <= windowDays) freshCount++
      } catch { freshCount += 0.3 }
    }
  }
  return Math.round((freshCount / results.length) * 100)
}

// ── FŐ PIPELINE ───────────────────────────────────────────────

export interface TrendRadarInput {
  seeds: string[]
  category: NicheCategory
  region: 'HU' | 'US'
  freshnessWindowDays: number
  maxCandidates?: number
  discoveryMode?: 'trend' | 'evergreen_fact'
}

export async function buildTrendCandidates(input: TrendRadarInput): Promise<TrendCandidate[]> {
  startNewRequest(`trend-${Date.now()}`)
  const { seeds, category, region, freshnessWindowDays, maxCandidates = 6, discoveryMode = 'trend' } = input
  const regionCode = region === 'HU' ? 'HU' : 'US'
  const relevanceLanguage = region === 'HU' ? 'hu' : 'en'

  const allCandidates: TrendCandidate[] = []

  // LÉPÉS 1: Minden seed-re Serper keresés (Serper nem kvóta-limitált mint YouTube)
  const maxSeeds = Math.min(seeds.length, 10)
  const seedResults = await Promise.all(
    seeds.slice(0, maxSeeds).map(async seed => {
      const [serperNews, serperWeb] = await Promise.all([
        fetchSerperNews(seed, region),
        fetchSerperWeb(seed, region),
      ])
      return { seed, serperResults: [...serperNews, ...serperWeb] }
    })
  )

  // LÉPÉS 2: Serper találatokból topic-ok kinyerése
  const topicsToValidate: Array<{ seed: string; topic: ExtractedTopic; serperResults: SerperResult[] }> = []

  for (const { seed, serperResults } of seedResults) {
    if (serperResults.length === 0) continue

    const extractedTopics = extractTrendTopicsFromSerper(serperResults, seed, region, freshnessWindowDays)

    for (const topic of extractedTopics.slice(0, 2)) { // max 2 topic per seed
      topicsToValidate.push({ seed, topic, serperResults })
    }

    // Seed-as-topic: a seed maga is legyen candidate topic (ez a fontos expansion fallback)
    // Ez biztosítja, hogy pl. "pyramid resonance study" ne vesszen el az entity extractionben
    const seedAlreadyCovered = extractedTopics.some(t => {
      const seedWords = seed.toLowerCase().split(/\s+/).filter(w => w.length > 3)
      const topicWords = t.topic_hu.toLowerCase().split(/\s+/).filter(w => w.length > 3)
      if (seedWords.length === 0) return true
      const overlap = seedWords.filter(w => topicWords.some(tw => tw.includes(w) || w.includes(tw))).length
      return overlap >= Math.min(2, seedWords.length)
    })

    if (!seedAlreadyCovered) {
      topicsToValidate.push({
        seed,
        topic: {
          topic_hu: seed,
          topic_en: seed,
          key_entity: seed.split(/\s+/).slice(0, 3).join(' '),
          serper_sources: serperResults.slice(0, 3),
          freshness_score: serperResults.length > 0 ? 65 : 50,
        },
        serperResults,
      })
    }
  }

  // Topic validálás — budget-controlled
  const topicBudget = getEffectiveBudget('opportunityEngine')
  const topicsToProcess = topicsToValidate.slice(0, topicBudget)

  // LÉPÉS 3: Minden topic-ra külön YouTube validation search
  const validatedCandidates = await Promise.all(
    topicsToProcess.map(async ({ seed, topic, serperResults }) => {
      // YouTube keresés a KONKRÉT TOPIC-ra, nem az eredeti seed-re
      // Ha a seed/topic angol nyelvű és HU régióban vagyunk, keressünk US régióban is
      const isEnglishQuery = /^[a-zA-Z0-9\s\-.,!?'"()]+$/.test(topic.topic_en || topic.topic_hu)
      const ytQuery = region === 'HU' && topic.topic_en !== topic.topic_hu
        ? topic.topic_en
        : topic.topic_hu
      const ytRegion = region === 'HU' && isEnglishQuery ? 'US' : regionCode
      const ytLang = region === 'HU' && isEnglishQuery ? 'en' : relevanceLanguage

      const youtubeVideos = await fetchYouTubeForTopic(
        ytQuery,
        ytRegion,
        ytLang,
        freshnessWindowDays,
        8,
      )

      // Passzív adatvagyon-gyűjtés — amit amúgy is lekértünk, azt mentjük is.
      await recordVideoSnapshots(youtubeVideos.map(v => ({
        videoId: v.videoId,
        title: v.title,
        channelId: v.channelId,
        channelTitle: v.channelTitle,
        publishedAt: v.publishedAt,
        viewCount: v.viewCount,
        likeCount: v.likeCount,
        commentCount: v.commentCount,
      })))

      // LÉPÉS 4: Video relevancia ellenőrzés — TOPIC szinten, nem seed szinten
      const videosWithRelevance: VideoWithRelevance[] = youtubeVideos.map(v => {
        const { score, regionRelevance, isRegionRelevant, signals, marketLabel } = scoreVideoRelevanceForTopic(
          v,
          topic.topic_en || topic.topic_hu,
          topic.key_entity,
          freshnessWindowDays,
          region,
        )
        return {
          ...v,
          relevance_score: score,
          region_relevance: regionRelevance,
          is_region_relevant: isRegionRelevant,
          relevance_signals: signals,
          market_label: marketLabel,
        }
      })

      // Csak topic-releváns videók
      const MIN_USER_FACING_RELEVANCE = discoveryMode === 'evergreen_fact' ? 45 : 60
      const relevantVideos = videosWithRelevance.filter(v => v.relevance_score >= MIN_USER_FACING_RELEVANCE && v.is_region_relevant)
      const uniqueCreators = new Set(relevantVideos.map(v => v.channelId)).size

      const topicWebSources = filterSerperSourcesForTopic(
        topic.serper_sources.length > 0 ? topic.serper_sources : serperResults,
        topic.topic_hu,
        topic.key_entity,
      )

      const serperFreshness = computeSerperFreshness(topicWebSources, freshnessWindowDays)
      const pollutionScore = computePollutionScore(videosWithRelevance.slice(0, 8))

      // Topic Match Gate: serper_youtube esetén explicit topic egyezés ellenőrzés
      const topicMatchedVideos = relevantVideos.filter(v =>
        topicMatchSerperYoutube(topic.topic_en || topic.topic_hu, topic.key_entity, v)
      )
      const evidenceVideos = discoveryMode === 'evergreen_fact' && topicMatchedVideos.length === 0
        ? relevantVideos.slice(0, 5)
        : topicMatchedVideos
      const topicMatchCount = evidenceVideos.length

      // Trend source validáció
      let validation = validateTrendSource(
        topicWebSources.length,
        topicMatchCount,  // csak topic-matched videók számítanak serper_youtube-hoz
        uniqueCreators,
      )

      if (discoveryMode === 'evergreen_fact' && validation.trend_source_type === 'weak_signal') {
        if (evidenceVideos.length >= 2 && uniqueCreators >= 2) {
          validation = {
            trend_source_type: 'youtube_multi_creator',
            confidence: uniqueCreators >= 3 ? 'medium' : 'low',
            opportunity_type: 'validated_youtube',
          }
        } else if (topicWebSources.length >= 1 || serperResults.length >= 2) {
          validation = {
            trend_source_type: 'serper_only',
            confidence: topicWebSources.length >= 2 ? 'medium' : 'low',
            opportunity_type: 'early_opportunity',
          }
        }
      }

      // SPEC: csak a három valid esetkör jelenhet meg a usernek
      // weak_signal mindig eldobjuk
      if (validation.trend_source_type === 'weak_signal') {
        return null
      }

      const sourceVideosForCandidate = discoveryMode === 'evergreen_fact' ? evidenceVideos : topicMatchedVideos

      const freshestVideo = [...relevantVideos].sort((a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
      )[0]
      const daysSinceFreshest = freshestVideo
        ? Math.floor((Date.now() - new Date(freshestVideo.publishedAt).getTime()) / 86400000)
        : freshnessWindowDays
      const ytFreshnessScore = Math.max(0, Math.round((1 - daysSinceFreshest / freshnessWindowDays) * 100))
      const finalFreshnessScore = Math.round((ytFreshnessScore + serperFreshness + topic.freshness_score) / 3)

      const relevanceAvg = relevantVideos.length > 0
        ? Math.round(relevantVideos.reduce((s, v) => s + v.relevance_score, 0) / relevantVideos.length)
        : 0

      // Market type
      const hungarianVideos = relevantVideos.filter(v => v.market_label === 'hungarian_market')
      const marketType: TrendCandidate['market_type'] =
        hungarianVideos.length >= relevantVideos.length * 0.6 ? 'hungarian_market'
        : relevantVideos.length > 0 ? 'global_with_hungarian_potential'
        : 'mixed'

      // HU régióban gyengítjük a confidence-t ha kevés releváns videó
      let finalConfidence = validation.confidence
      if (region === 'HU' && relevantVideos.length < 2 && finalConfidence === 'high') finalConfidence = 'medium'

      return {
        id: `${category}-${topic.key_entity.replace(/\s+/g, '-').slice(0, 30)}-${Date.now()}`,
        candidate_topic: topic.topic_hu,
        candidate_topic_en: topic.topic_en,
        category,
        region,
        trend_source_type: validation.trend_source_type,
        confidence: finalConfidence,
        opportunity_type: validation.opportunity_type,
        serper_evidence_count: topicWebSources.length,
        youtube_relevant_videos_count: sourceVideosForCandidate.length,
        unique_creator_count: uniqueCreators,
        freshness_score: finalFreshnessScore,
        pollution_score: pollutionScore,
        relevance_average: relevanceAvg,
        source_videos: sourceVideosForCandidate.slice(0, 5),
        web_sources: (topicWebSources.length > 0 ? topicWebSources : serperResults.slice(0, 3)).slice(0, 3),
        seed_keyword: seed,
        market_type: marketType,
      } as TrendCandidate
    })
  )

  const finalCandidates = validatedCandidates
    .filter((c): c is TrendCandidate => c !== null)
    .filter(c => c.trend_source_type !== 'weak_signal')  // spec: weak_signal soha nem jelenik meg
    .filter(c => discoveryMode === 'evergreen_fact' ? true : c.confidence !== 'low')
    .filter(c => discoveryMode === 'evergreen_fact' ? c.pollution_score < 90 : c.pollution_score < 75)
    .sort((a, b) => {
      const sourceOrder = { serper_youtube: 4, serper_only: 3, youtube_multi_creator: 2, weak_signal: 1 }
      const confidenceOrder = { high: 4, medium: 3, low: 2, rejected: 1 }
      return (
        (sourceOrder[b.trend_source_type] - sourceOrder[a.trend_source_type]) * 10 +
        (confidenceOrder[b.confidence] - confidenceOrder[a.confidence])
      )
    })
    .slice(0, maxCandidates)

  // Passzív adatvagyon-gyűjtés — ugyanaz az adat, ami amúgy is kiszámolódik.
  await recordTrendCandidates(finalCandidates.map(c => ({
    candidate_topic: c.candidate_topic,
    category: c.category,
    region: c.region,
    trend_source_type: c.trend_source_type,
    confidence: c.confidence,
    opportunity_type: c.opportunity_type,
    relevance_average: c.relevance_average,
    freshness_score: c.freshness_score,
    seed_keyword: c.seed_keyword,
    market_type: c.market_type,
  })))

  return finalCandidates
}

// ── Labels ────────────────────────────────────────────────────

export function trendSourceLabel(sourceType: TrendSourceType): string {
  switch (sourceType) {
    case 'serper_youtube': return 'Webes források és YouTube-videók ugyanazt a témát támasztják alá.'
    case 'serper_only': return 'Korai lehetőség: webes források alapján aktuális, YouTube-on még kevés feldolgozás van.'
    case 'youtube_multi_creator': return 'YouTube-on validált: több creator is ugyanazt a témát dolgozza fel.'
    case 'weak_signal': return 'Gyenge jel: kevés releváns adat, óvatosan kezelendő.'
  }
}

export function marketTypeLabel(marketType: TrendCandidate['market_type']): string {
  switch (marketType) {
    case 'hungarian_market': return 'Magyar piacon validált téma.'
    case 'global_with_hungarian_potential': return 'Globális trend, magyar feldolgozási lehetőséggel.'
    case 'mixed': return 'Vegyes forrású trend.'
  }
}

export function confidenceLabel(confidence: TrendConfidence): string {
  switch (confidence) {
    case 'high': return 'Magas megbízhatóság'
    case 'medium': return 'Közepes megbízhatóság'
    case 'low': return 'Alacsony megbízhatóság'
    case 'rejected': return 'Elutasítva'
  }
}
