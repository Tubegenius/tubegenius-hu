// ============================================================
// WILLVIRAL — Opportunity Scoring Engine (Backend) v2
// ============================================================
// Claude NEM számol score-t. Ez kizárólag backend logika.
// Alap dimenziók: Trend Velocity, Freshness, Engagement Rate,
// View Outlier, Upload Density, Search Relevance, Competition,
// Content Gap, Confidence — ezek épülnek be az 5 fő komponensbe.
//
// Végső súlyozás (változatlan): Trend Momentum 30% / Niche Match 25% /
// Content Gap 20% / Competition 15% / Freshness 10%

export interface YouTubeVideoStats {
  videoId: string
  title: string
  channelTitle: string
  publishedAt: string
  viewCount: number
  likeCount: number
  commentCount: number
  thumbnailUrl: string
}

export interface KeywordSearchResult {
  keyword: string
  videos: YouTubeVideoStats[]
  totalResults: number
}

export interface ScoreBreakdown {
  trend_momentum: number
  niche_match: number
  content_gap: number
  competition: number
  freshness: number
  total: number
  // ─── Diagnosztikai aldimenziók (debug / UI tooltip célokra) ───
  trend_velocity: number
  engagement_rate: number
  view_outlier: number
  upload_density: number
  search_relevance: number
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const OBSERVED_RESULT_SATURATION = 25

function normalizeSearchText(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function ageMsFromPublishedAt(publishedAt: string, now = Date.now()): number | null {
  const published = new Date(publishedAt).getTime()
  if (!Number.isFinite(published) || published > now + HOUR_MS) return null
  return Math.max(0, now - published)
}

// ════════════════════════════════════════════════════════════
// 1. SEARCH RELEVANCE — mennyire releváns a videó a kulcsszóhoz
// ════════════════════════════════════════════════════════════
const TRANSLATION_MAP: Record<string, string[]> = {
  piramisok: ['pyramid', 'pyramids'], piramis: ['pyramid', 'pyramids'],
  pyramid: ['piramis', 'piramisok'], rezges: ['vibration', 'resonance'],
  vibration: ['rezges'], resonance: ['rezonancia'],
  tortenelem: ['history'], history: ['tortenelem'],
  tudomany: ['science'], science: ['tudomany'],
  foldrenges: ['earthquake'], earthquake: ['foldrenges'],
  kutatas: ['research'], research: ['kutatas'],
  felfedezes: ['discovery'], discovery: ['felfedezes'],
  rejtely: ['mystery'], mystery: ['rejtely'],
}

function fuzzyMatch(word: string, text: string): boolean {
  if (text.includes(word)) return true
  const folded = word.normalize('NFD').replace(/[̀-ͯ]/g, '')
  const translations = TRANSLATION_MAP[folded] || TRANSLATION_MAP[word] || []
  for (const tr of translations) { if (text.includes(tr)) return true }
  const textWords = text.split(/[^a-z0-9]+/).filter(w => w.length > 2)
  for (const tw of textWords) {
    if (tw.length < 3 || word.length < 3) continue
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

export function calcSearchRelevance(video: YouTubeVideoStats, keyword: string): number {
  const titleLower = normalizeSearchText(video.title)
  const keywordWords = normalizeSearchText(keyword).split(/\s+/).filter(w => w.length > 2)

  if (keywordWords.length === 0) return 50

  let matchCount = 0
  for (const word of keywordWords) {
    if (fuzzyMatch(word, titleLower)) matchCount++
  }
  const titleMatchRatio = matchCount / keywordWords.length

  // Recency relevance — friss videók kapnak kis bónuszt a relevanciához
  const ageMs = ageMsFromPublishedAt(video.publishedAt)
  const recencyBonus = ageMs !== null && ageMs < 30 * DAY_MS ? 10 : 0

  const score = titleMatchRatio * 90 + recencyBonus
  return Math.round(Math.max(0, Math.min(100, score)))
}

// Egy videólista átlagos search relevance-e — szűréshez/súlyozáshoz
export function filterByRelevance(videos: YouTubeVideoStats[], keyword: string, minRelevance = 20): { video: YouTubeVideoStats; relevance: number }[] {
  return videos
    .map(v => ({ video: v, relevance: calcSearchRelevance(v, keyword) }))
    .filter(r => r.relevance >= minRelevance)
}

export function calcAvgSearchRelevance(videos: YouTubeVideoStats[], keyword: string): number {
  if (videos.length === 0) return 0
  const total = videos.reduce((sum, v) => sum + calcSearchRelevance(v, keyword), 0)
  return Math.round(total / videos.length)
}

// ════════════════════════════════════════════════════════════
// 2. TREND VELOCITY — views/hour, friss videók nézettségi sebessége
// ════════════════════════════════════════════════════════════
export function calcVideoVelocity(video: YouTubeVideoStats): number {
  const ageMs = ageMsFromPublishedAt(video.publishedAt)
  if (ageMs === null) return 0
  const hoursSincePublish = Math.max(1, ageMs / HOUR_MS)
  return Math.max(0, video.viewCount) / hoursSincePublish
}

export function calcTrendVelocity(videos: YouTubeVideoStats[]): number {
  if (videos.length === 0) return 0

  // Csak a 14 napon belüli videók velocity-jét nézzük (a régi, magas-view videók ne torzítsanak)
  const recentVideos = videos.filter(v => {
    const ageMs = ageMsFromPublishedAt(v.publishedAt)
    return ageMs !== null && ageMs < 14 * DAY_MS
  })
  if (recentVideos.length === 0) return 15 // nincs friss videó -> alacsony velocity

  const avgVelocity = recentVideos.reduce((sum, v) => sum + calcVideoVelocity(v), 0) / recentVideos.length

  // Logaritmikus skálázás: 1000 views/hour -> ~100, 10 views/hour -> ~33
  const score = (Math.log10(avgVelocity + 1) / Math.log10(1000)) * 100
  return Math.round(Math.max(0, Math.min(100, score)))
}

// ════════════════════════════════════════════════════════════
// 3. FRESHNESS SCORE — sávos pontozás a megjelenés ideje alapján
// ════════════════════════════════════════════════════════════
function freshnessPoints(ageInDays: number): number {
  if (ageInDays <= 3) return 100
  if (ageInDays <= 7) return 80
  if (ageInDays <= 14) return 60
  if (ageInDays <= 30) return 40
  return 20
}

export function calcFreshness(videos: YouTubeVideoStats[]): number {
  if (videos.length === 0) return 0
  const now = Date.now()
  const total = videos.reduce((sum, v) => {
    const ageMs = ageMsFromPublishedAt(v.publishedAt, now)
    return sum + (ageMs === null ? 0 : freshnessPoints(ageMs / DAY_MS))
  }, 0)
  return Math.round(total / videos.length)
}

// ════════════════════════════════════════════════════════════
// 4. ENGAGEMENT RATE — (likes + comments*3) / views
// ════════════════════════════════════════════════════════════
export function calcVideoEngagementRate(video: YouTubeVideoStats): number {
  if (video.viewCount === 0) return 0
  return (video.likeCount + video.commentCount * 3) / video.viewCount
}

export function calcEngagementRate(videos: YouTubeVideoStats[]): number {
  if (videos.length === 0) return 0
  const validVideos = videos.filter(v => v.viewCount > 0)
  if (validVideos.length === 0) return 0

  const avgRate = validVideos.reduce((sum, v) => sum + calcVideoEngagementRate(v), 0) / validVideos.length

  // Skálázás: 5% engagement rate (0.05) -> 100 pont (kiváló), 0% -> 0 pont
  const score = avgRate * 2000
  return Math.round(Math.max(0, Math.min(100, score)))
}

// ════════════════════════════════════════════════════════════
// 5. VIEW OUTLIER SCORE — videó vs csatorna átlagos teljesítménye
// ════════════════════════════════════════════════════════════
// MVP: channel_recent_average nem áll rendelkezésre videos.list-ből
// extra API hívás nélkül, ezért proxy-becslést használunk:
// a kereséscsoport (azonos kulcsszóra talált videók) mediánjához viszonyítunk.
// Ez azt méri, hogy egy videó kiugró-e a saját kereséscsoportjához képest.
export function calcViewOutlierScore(videos: YouTubeVideoStats[]): number {
  if (videos.length < 2) return 50 // nincs elég adat összehasonlításhoz -> neutrális

  const views = videos.map(v => v.viewCount).sort((a, b) => a - b)
  const mid = Math.floor(views.length / 2)
  const median = views.length % 2 === 0 ? (views[mid - 1] + views[mid]) / 2 : views[mid]

  if (median === 0) return 50

  const maxViews = views[views.length - 1]
  const outlierRatio = maxViews / median

  // outlierRatio 1 (nincs kiugrás) -> 30, 5x -> ~70, 10x+ -> ~100
  const score = 30 + Math.min(70, (outlierRatio - 1) * 10)
  return Math.round(Math.max(0, Math.min(100, score)))
}

// ════════════════════════════════════════════════════════════
// 6. UPLOAD DENSITY — releváns friss videók mennyisége (telítettség jelzés)
// ════════════════════════════════════════════════════════════
// Visszaad egy 0-100 score-t ÉS egy kategóriát a Content Gap számításhoz
export interface UploadDensityResult {
  score: number
  level: 'low' | 'moderate' | 'high' | 'saturated'
}

export function calcUploadDensity(videos: YouTubeVideoStats[], totalResults: number): UploadDensityResult {
  const recentCount = videos.filter(v => {
    const ageMs = ageMsFromPublishedAt(v.publishedAt)
    return ageMs !== null && ageMs < 14 * DAY_MS
  }).length
  const observedResultCount = Math.max(0, Math.min(OBSERVED_RESULT_SATURATION, Number(totalResults) || 0))

  // Kevés releváns videó = alacsony bizonyíték (nem feltétlen rossz, de kockázatos)
  if (recentCount === 0) return { score: 20, level: 'low' }
  if (recentCount <= 2) return { score: 45, level: 'low' }

  // Közepes szám = jó trendjel
  if (recentCount <= 6) return { score: 85, level: 'moderate' }

  // Sok friss videó VAGY nagy totalResults = telítettség veszély
  if (recentCount <= 10 && observedResultCount < OBSERVED_RESULT_SATURATION) return { score: 65, level: 'high' }

  return { score: 35, level: 'saturated' }
}

// ════════════════════════════════════════════════════════════
// 7. COMPETITION SCORE — nem csak videószám, hanem "van bizonyíték, de nincs túltelítettség"
// ════════════════════════════════════════════════════════════
export function calcCompetitionScore(videos: YouTubeVideoStats[], totalResults: number, uploadDensity: UploadDensityResult): number {
  if (videos.length === 0) return 0

  const avgViews = videos.reduce((sum, v) => sum + Math.max(0, Number(v.viewCount) || 0), 0) / videos.length
  const uniqueChannels = new Set(videos.map(v => v.channelTitle)).size
  const channelDiversity = uniqueChannels / videos.length // 1 = mind különböző csatorna (alacsonyabb domináns verseny)

  // Alap: magas avgViews + alacsony diverzitás (kevés nagy csatorna dominál) = magas verseny
  let competition = (Math.log10(avgViews + 1) / Math.log10(1_000_000)) * 50 + (1 - channelDiversity) * 30

  // Piaci volumen hatása
  // A YouTube search API itt nem globális találatszámot, hanem egy korlátozott
  // megfigyelt mintát ad. A volumenjelet ezért ehhez a 25 elemű evidenciamintához
  // kalibráljuk, nem elérhetetlen milliós értékhez.
  const volumeFactor = Math.min(1, Math.max(0, Number(totalResults) || 0) / OBSERVED_RESULT_SATURATION)
  competition += volumeFactor * 20

  // Upload density korrekció: 'saturated' szint extra versenybüntetés
  if (uploadDensity.level === 'saturated') competition += 10
  if (uploadDensity.level === 'low') competition -= 10 // kevés videó = kevesebb látható verseny

  return Math.round(Math.max(0, Math.min(100, competition)))
}

// ════════════════════════════════════════════════════════════
// 8. CONTENT GAP SCORE — van-e feldolgozási rés
// ════════════════════════════════════════════════════════════
// Jelek: alacsony competition + jó upload density (moderate) + van bizonyíték (nem 'low')
export function calcContentGap(competition: number, uploadDensity: UploadDensityResult, freshness: number): number {
  // Alapérték: competition inverze
  let gap = (100 - competition) * 0.6

  // Upload density hatása — 'moderate' a legjobb (van bizonyíték, nincs telítettség)
  const densityBonus: Record<UploadDensityResult['level'], number> = {
    low: 10,       // kevés videó -> lehet rés, de bizonytalan
    moderate: 25,  // ideális: van bizonyíték, nincs telítettség
    high: 10,
    saturated: -10, // túltelített -> nincs rés
  }
  gap += densityBonus[uploadDensity.level]

  // Freshness hozzájárulás — friss témáknál nagyobb a rés kihasználási esélye
  gap += freshness * 0.15

  return Math.round(Math.max(0, Math.min(100, gap)))
}

// ════════════════════════════════════════════════════════════
// 9. TREND MOMENTUM — Trend Velocity + Freshness kombinációja
// ════════════════════════════════════════════════════════════
export function calcTrendMomentum(videos: YouTubeVideoStats[]): number {
  if (videos.length === 0) return 0

  const velocity = calcTrendVelocity(videos)
  const freshness = calcFreshness(videos)

  // Trend Momentum = a sebesség és a frissesség kombinációja (60/40)
  const momentum = velocity * 0.6 + freshness * 0.4
  return Math.round(Math.max(0, Math.min(100, momentum)))
}

// ════════════════════════════════════════════════════════════
// 10. NICHE MATCH — kulcsszó-profil egyezés (változatlan logika)
// ════════════════════════════════════════════════════════════
export function calcNicheMatch(keyword: string, nicheText: string): number {
  const kw = normalizeSearchText(keyword)
  const niche = normalizeSearchText(nicheText)
  const nicheWords = niche.split(/[,;/\s]+/).filter(w => w.length > 2)

  // Niche nélkül nincs bizonyíték egyezésre vagy ellentmondásra: neutrális.
  if (nicheWords.length === 0) return 50

  if (nicheWords.some(w => kw.includes(w) || w.includes(kw))) return 95

  let bestScore = 10
  for (const w of nicheWords) {
    if (kw.split(' ').some(part => part.length > 3 && (w.includes(part) || part.includes(w)))) {
      bestScore = Math.max(bestScore, 75)
    }
  }
  return bestScore
}

// ════════════════════════════════════════════════════════════
// FINAL OPPORTUNITY SCORE — súlyozás VÁLTOZATLAN
// ════════════════════════════════════════════════════════════
const WEIGHTS = {
  trend_momentum: 0.30,
  niche_match: 0.25,
  content_gap: 0.20,
  competition: 0.15, // magas verseny = rossz -> invertálva számít a totalba
  freshness: 0.10,
}

export function calcOpportunityScore(breakdown: { trend_momentum: number; niche_match: number; content_gap: number; competition: number; freshness: number }): number {
  const competitionScoreForTotal = 100 - breakdown.competition

  const total =
    breakdown.trend_momentum * WEIGHTS.trend_momentum +
    breakdown.niche_match * WEIGHTS.niche_match +
    breakdown.content_gap * WEIGHTS.content_gap +
    competitionScoreForTotal * WEIGHTS.competition +
    breakdown.freshness * WEIGHTS.freshness

  return Math.round(Math.max(0, Math.min(100, total)))
}

// ════════════════════════════════════════════════════════════
// MASTER FUNCTION — egy kulcsszóhoz tartozó teljes score breakdown
// ════════════════════════════════════════════════════════════
export function buildScoreBreakdown(
  videos: YouTubeVideoStats[],
  totalResults: number,
  keyword: string,
  nicheText: string
): ScoreBreakdown {
  // 1. Relevancia-szűrés — csak a releváns videók mennek a scoringba
  const relevanceFiltered = filterByRelevance(videos, keyword, 15)
  const relevantVideos = relevanceFiltered.length > 0 ? relevanceFiltered.map(r => r.video) : videos

  const search_relevance = calcAvgSearchRelevance(videos, keyword)
  const trend_velocity = calcTrendVelocity(relevantVideos)
  const freshness = calcFreshness(relevantVideos)
  const engagement_rate = calcEngagementRate(relevantVideos)
  const view_outlier = calcViewOutlierScore(relevantVideos)
  const uploadDensity = calcUploadDensity(relevantVideos, totalResults)
  const competition = calcCompetitionScore(relevantVideos, totalResults, uploadDensity)
  const content_gap = calcContentGap(competition, uploadDensity, freshness)
  const trend_momentum = calcTrendMomentum(relevantVideos)
  const niche_match = calcNicheMatch(keyword, nicheText)

  const total = calcOpportunityScore({ trend_momentum, niche_match, content_gap, competition, freshness })

  return {
    trend_momentum, niche_match, content_gap, competition, freshness, total,
    trend_velocity, engagement_rate, view_outlier, upload_density: uploadDensity.score, search_relevance,
  }
}

// ════════════════════════════════════════════════════════════
// CONFIDENCE SCORE — adatmennyiség alapú megbízhatóság
// ════════════════════════════════════════════════════════════
export function getConfidenceLevel(videoCount: number): 'magas' | 'közepes' | 'alacsony' | 'nagyon_alacsony' {
  if (videoCount >= 20) return 'magas'
  if (videoCount >= 10) return 'közepes'
  if (videoCount >= 3) return 'alacsony'
  return 'nagyon_alacsony'
}
