// lib/video-audit-scoring.ts
// WillViral — Video Audit hibrid scoring rendszer
// Backend számol mindent ami matematikai. Claude csak minőségi interpretációt ad.

export type Platform = 'youtube_long' | 'youtube_shorts' | 'tiktok' | 'instagram_reels' | 'facebook_reels'

export type ConfidenceLevel = 'high' | 'medium' | 'low'

export type AuditDecision =
  | 'Reupload'
  | 'Rehook'
  | 'Remix'
  | 'Replatform'
  | 'Repackage'
  | 'Abandon'
  | 'Folytatás'

// Platform-specifikus optimumok
const PLATFORM_DURATION_OPTIMUM: Record<Platform, { min: number; max: number }> = {
  youtube_long:     { min: 480,  max: 1200 }, // 8–20 perc
  youtube_shorts:   { min: 15,   max: 60   }, // 15–60 mp
  tiktok:           { min: 30,   max: 90   }, // 30–90 mp
  instagram_reels:  { min: 15,   max: 60   }, // 15–60 mp
  facebook_reels:   { min: 30,   max: 90   }, // 30–90 mp
}

const PLATFORM_ENGAGEMENT_BENCHMARK: Record<Platform, number> = {
  youtube_long:    0.04,  // 4%
  youtube_shorts:  0.06,  // 6%
  tiktok:          0.08,  // 8%
  instagram_reels: 0.05,  // 5%
  facebook_reels:  0.03,  // 3%
}

// Score értelmezés — globális rendszer
export interface ScoreInterpretation {
  score: number
  label: string
  meaning: string
  risk_level: 'low' | 'medium' | 'high' | 'critical'
  recommended_action: string
}

export function interpretScore(score: number, context: 'audit' | 'opportunity' | 'viral' = 'audit'): ScoreInterpretation {
  if (score >= 90) return {
    score,
    label: 'Kiváló',
    meaning: context === 'audit'
      ? 'Erős teljesítmény. Csak finomhangolás kell.'
      : 'Nagyon erős lehetőség. Azonnal érdemes csinálni.',
    risk_level: 'low',
    recommended_action: 'Skálázd — készíts folytatást vagy hasonló verziót.',
  }
  if (score >= 75) return {
    score,
    label: 'Jó',
    meaning: context === 'audit'
      ? 'Alapvetően működőképes, erős alapokkal. Van néhány javítható pont.'
      : 'Erős lehetőség, kisebb kockázattal.',
    risk_level: 'low',
    recommended_action: 'Publikálásra kész. Kisebb finomhangolással még jobb lehet.',
  }
  if (score >= 60) return {
    score,
    label: 'Közepes / javítható',
    meaning: context === 'audit'
      ? 'A videóban van potenciál, de jelenlegi formában nem elég erős a csomagolás.'
      : 'Van benne potenciál, de nem kiemelkedő lehetőség.',
    risk_level: 'medium',
    recommended_action: 'Ne töröld. Remix, új hook vagy jobb csomagolás javasolt.',
  }
  if (score >= 40) return {
    score,
    label: 'Gyenge',
    meaning: context === 'audit'
      ? 'Jelenlegi formában nem versenyképes. Több fő elem gyenge.'
      : 'Gyenge lehetőség. Csak erős témánál érdemes próbálni.',
    risk_level: 'high',
    recommended_action: 'Jelentős átdolgozás kell. Csak akkor érdemes újra próbálni, ha a téma erős.',
  }
  return {
    score,
    label: 'Kritikus',
    meaning: context === 'audit'
      ? 'Nagy eséllyel rossz csomagolás, rossz platform vagy gyenge alaptéma.'
      : 'Nagy eséllyel rossz téma vagy gyenge adatjel.',
    risk_level: 'critical',
    recommended_action: 'Új téma, új szög vagy teljes újratervezés javasolt.',
  }
}

// YouTube API adatokból backend scoring
export interface YouTubeApiData {
  title: string
  description: string
  duration_seconds: number
  views: number
  likes: number
  comments: number
  published_at: string
  channel_subscribers?: number
  tags?: string[]
  thumbnail_url?: string
}

// Manuális platform adatok
export interface ManualPlatformData {
  platform: Platform
  topic: string
  title: string
  duration_seconds: number
  views: number
  likes: number
  comments: number
  shares?: number
  saves?: number
  uploaded_at?: string
  hashtags?: string[]
  caption?: string
  avg_watch_time_seconds?: number
  completion_rate?: number
  profile_visits?: number
  new_followers?: number
  user_notes?: string
}

const PLATFORMS: Platform[] = ['youtube_long', 'youtube_shorts', 'tiktok', 'instagram_reels', 'facebook_reels']

export function isAuditPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && PLATFORMS.includes(value as Platform)
}

export function validateManualPlatformData(value: unknown, expectedPlatform: Platform): { ok: true; data: ManualPlatformData } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Hiányzó manuális videóadat' }
  const data = value as Record<string, unknown>
  if (data.platform !== expectedPlatform) return { ok: false, error: 'A manuális adat platformja nem egyezik a kiválasztott platformmal' }
  for (const field of ['topic', 'title'] as const) {
    if (typeof data[field] !== 'string' || !data[field].trim()) return { ok: false, error: `${field} megadása kötelező` }
    if ((data[field] as string).trim().length > 300) return { ok: false, error: `${field} legfeljebb 300 karakter lehet` }
  }
  const nonNegative = ['duration_seconds', 'views', 'likes', 'comments', 'shares', 'saves', 'avg_watch_time_seconds', 'profile_visits', 'new_followers'] as const
  for (const field of nonNegative) {
    const fieldValue = data[field]
    if (fieldValue !== undefined && (!Number.isFinite(fieldValue) || Number(fieldValue) < 0)) return { ok: false, error: `${field} csak nem negatív szám lehet` }
  }
  if (Number(data.duration_seconds) <= 0 || Number(data.duration_seconds) > 86400) return { ok: false, error: 'A videó hossza 1 másodperc és 24 óra között lehet' }
  const completionRate = data.completion_rate
  if (completionRate !== undefined && (!Number.isFinite(completionRate) || Number(completionRate) < 0 || Number(completionRate) > 1)) return { ok: false, error: 'completion_rate 0 és 1 közötti arány lehet' }
  if (data.avg_watch_time_seconds !== undefined && Number(data.avg_watch_time_seconds) > Number(data.duration_seconds)) return { ok: false, error: 'Az átlagos nézési idő nem lehet hosszabb a videónál' }
  if (data.hashtags !== undefined && (!Array.isArray(data.hashtags) || data.hashtags.length > 50)) return { ok: false, error: 'Legfeljebb 50 hashtag adható meg' }
  if (data.caption !== undefined && (typeof data.caption !== 'string' || data.caption.length > 5000)) return { ok: false, error: 'A caption legfeljebb 5000 karakter lehet' }
  return { ok: true, data: value as ManualPlatformData }
}

export interface DimensionScore {
  score: number
  interpretation: ScoreInterpretation
  signals: string[]
  weaknesses: string[]
}

export interface BackendScores {
  hook_strength: DimensionScore
  retention_potential: DimensionScore
  engagement_quality: DimensionScore
  platform_fit: DimensionScore
  packaging_quality: DimensionScore
}

export interface FinalAuditScores {
  hook_strength: number
  retention_potential: number
  engagement_quality: number
  platform_fit: number
  packaging_quality: number
  overall: number
  weighted_breakdown: {
    hook: number
    retention: number
    engagement: number
    platform_fit: number
    packaging: number
  }
}

function clamp(val: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(val)))
}

// ── YOUTUBE BACKEND SCORING ──────────────────────────────────────────────────

export function scoreYouTubeBackend(data: YouTubeApiData, platform: Platform): BackendScores {
  const { min, max } = PLATFORM_DURATION_OPTIMUM[platform]
  const engBench = PLATFORM_ENGAGEMENT_BENCHMARK[platform]
  const engRate = data.views > 0 ? (data.likes + data.comments) / data.views : 0

  // 1. Hook Strength (title alapján)
  const titleWords = data.title.trim().split(/\s+/).length
  const hasQuestion = /\?/.test(data.title)
  const hasNumber = /\d/.test(data.title)
  const titleLen = data.title.length
  let hookScore = 50
  if (titleLen >= 40 && titleLen <= 70) hookScore += 15
  else if (titleLen < 20) hookScore -= 20
  if (hasQuestion) hookScore += 10
  if (hasNumber) hookScore += 10
  if (titleWords >= 6 && titleWords <= 12) hookScore += 10
  if (/miért|hogyan|amit|szörnyű|titok|soha|mindenki|kiderült/i.test(data.title)) hookScore += 15

  const hookSignals: string[] = []
  const hookWeaknesses: string[] = []
  if (hasQuestion) hookSignals.push('Kérdéses cím — erős hook signal')
  if (hasNumber) hookSignals.push('Szám a címben — clickbait erő')
  if (titleLen < 20) hookWeaknesses.push('Túl rövid cím — nem elég informatív')
  if (titleLen > 80) hookWeaknesses.push('Túl hosszú cím — levágódhat')

  // 2. Retention Potential
  // A YouTube Data API nem ad retention/completion adatot. Itt kizárólag
  // szerkezeti proxy (hossz) pontozható; like és leíráshossz nem retenció.
  let retentionScore = 45
  const durationInRange = data.duration_seconds >= min && data.duration_seconds <= max
  if (durationInRange) retentionScore += 20
  else if (data.duration_seconds < min) retentionScore -= 15
  else retentionScore -= 10

  const retentionSignals: string[] = []
  const retentionWeaknesses: string[] = []
  if (durationInRange) retentionSignals.push('Videó hossza platform-optimális')
  else retentionWeaknesses.push(`Videó hossza nem optimális (optimum: ${min/60}–${max/60} perc)`)
  retentionWeaknesses.push('Nincs nézőmegtartási adat — a retenció csak szerkezeti becslés')

  // 3. Engagement Quality
  const engRatio = engBench > 0 ? engRate / engBench : 0
  let engScore = clamp(50 + (engRatio - 1) * 40)
  if (data.comments > 50) engScore = clamp(engScore + 10)

  const engSignals: string[] = []
  const engWeaknesses: string[] = []
  if (engRatio > 1.2) engSignals.push(`Engagement ${Math.round(engRatio * 100)}% — platform átlag felett`)
  else if (engRatio < 0.7) engWeaknesses.push('Engagement platform átlag alatt')

  // 4. Platform Fit
  let pfScore = 60
  if (durationInRange) pfScore += 20
  if (data.tags && data.tags.length >= 5) pfScore += 5

  const pfSignals: string[] = []
  const pfWeaknesses: string[] = []
  if (durationInRange) pfSignals.push('Videó hossza platform-kompatibilis')
  pfWeaknesses.push('Közönség-időzóna nélkül a feltöltési időpont nem pontozható')

  // 5. Packaging Quality
  let packScore = 50
  // A thumbnail URL megléte nem bizonyít vizuális minőséget vagy CTR-t.
  if (data.thumbnail_url) packScore += 5
  if (titleLen >= 40 && titleLen <= 70) packScore += 15
  if (data.description && data.description.length > 100) packScore += 10
  if (data.tags && data.tags.length >= 3) packScore += 5

  const packSignals: string[] = []
  const packWeaknesses: string[] = []
  if (data.thumbnail_url) packSignals.push('Thumbnail elérhető — minősége adatból nem mérhető')
  else packWeaknesses.push('Thumbnail nem elérhető az API-ból')
  if (data.description.length < 100) packWeaknesses.push('Rövid leírás — SEO gyenge')

  return {
    hook_strength:       { score: clamp(hookScore),      interpretation: interpretScore(clamp(hookScore), 'audit'),      signals: hookSignals,      weaknesses: hookWeaknesses },
    retention_potential: { score: clamp(retentionScore), interpretation: interpretScore(clamp(retentionScore), 'audit'), signals: retentionSignals, weaknesses: retentionWeaknesses },
    engagement_quality:  { score: clamp(engScore),       interpretation: interpretScore(clamp(engScore), 'audit'),       signals: engSignals,       weaknesses: engWeaknesses },
    platform_fit:        { score: clamp(pfScore),        interpretation: interpretScore(clamp(pfScore), 'audit'),        signals: pfSignals,        weaknesses: pfWeaknesses },
    packaging_quality:   { score: clamp(packScore),      interpretation: interpretScore(clamp(packScore), 'audit'),      signals: packSignals,      weaknesses: packWeaknesses },
  }
}

// ── MANUÁLIS PLATFORM BACKEND SCORING ───────────────────────────────────────

export function scoreManualBackend(data: ManualPlatformData): BackendScores {
  const { min, max } = PLATFORM_DURATION_OPTIMUM[data.platform]
  const engBench = PLATFORM_ENGAGEMENT_BENCHMARK[data.platform]
  const durationInRange = data.duration_seconds >= min && data.duration_seconds <= max

  const totalInteractions = data.likes + data.comments + (data.shares ?? 0) + (data.saves ?? 0)
  const engRate = data.views > 0 ? totalInteractions / data.views : 0
  const engRatio = engBench > 0 ? engRate / engBench : 0

  // Hook
  const titleLen = data.title.length
  const hasQuestion = /\?/.test(data.title)
  const hasNumber = /\d/.test(data.title)
  let hookScore = 50
  if (titleLen >= 30 && titleLen <= 80) hookScore += 15
  if (hasQuestion) hookScore += 10
  if (hasNumber) hookScore += 10
  if (/miért|hogyan|titok|kiderült|soha|mindenki/i.test(data.title)) hookScore += 15

  // Retention
  let retentionScore = 50
  if (durationInRange) retentionScore += 20
  else if (data.duration_seconds < min) retentionScore -= 15
  if (data.completion_rate !== undefined) {
    if (data.completion_rate > 0.5) retentionScore += 20
    else if (data.completion_rate > 0.3) retentionScore += 10
    else retentionScore -= 10
  }
  if (data.avg_watch_time_seconds !== undefined && data.duration_seconds > 0) {
    const watchRatio = data.avg_watch_time_seconds / data.duration_seconds
    if (watchRatio > 0.5) retentionScore += 10
  }

  // Engagement
  let engScore = clamp(50 + (engRatio - 1) * 40)
  if ((data.saves ?? 0) > 0 && data.views > 0) {
    const saveRate = (data.saves ?? 0) / data.views
    if (saveRate > 0.02) engScore = clamp(engScore + 10)
  }

  // Platform Fit
  let pfScore = 60
  if (durationInRange) pfScore += 20
  // Feltöltési idő csak a célközönség időzónájával lenne értelmezhető.
  if (data.new_followers && data.new_followers > 0) pfScore += 5

  // Packaging
  const hashtagCount = data.hashtags?.length ?? 0
  const captionLen = data.caption?.length ?? 0
  let packScore = 50
  if (hashtagCount >= 3 && hashtagCount <= 10) packScore += 20
  else if (hashtagCount > 10) packScore += 10
  if (captionLen >= 50 && captionLen <= 300) packScore += 20
  else if (captionLen > 0) packScore += 10

  const makeSignals = (score: number, label: string): { signals: string[]; weaknesses: string[] } => ({
    signals: score >= 70 ? [`${label}: erős signal`] : [],
    weaknesses: score < 50 ? [`${label}: fejlesztést igényel`] : [],
  })

  return {
    hook_strength:       { score: clamp(hookScore),      interpretation: interpretScore(clamp(hookScore), 'audit'),      ...makeSignals(clamp(hookScore), 'Hook') },
    retention_potential: { score: clamp(retentionScore), interpretation: interpretScore(clamp(retentionScore), 'audit'), ...makeSignals(clamp(retentionScore), 'Retenció') },
    engagement_quality:  { score: clamp(engScore),       interpretation: interpretScore(clamp(engScore), 'audit'),       ...makeSignals(clamp(engScore), 'Engagement') },
    platform_fit:        { score: clamp(pfScore),        interpretation: interpretScore(clamp(pfScore), 'audit'),        ...makeSignals(clamp(pfScore), 'Platform fit') },
    packaging_quality:   { score: clamp(packScore),      interpretation: interpretScore(clamp(packScore), 'audit'),      ...makeSignals(clamp(packScore), 'Csomagolás') },
  }
}

// ── WEIGHTED FINAL SCORE ─────────────────────────────────────────────────────

const WEIGHTS = {
  hook_strength:       0.25,
  retention_potential: 0.25,
  engagement_quality:  0.20,
  platform_fit:        0.15,
  packaging_quality:   0.15,
}

export function computeFinalScores(
  backendScores: BackendScores,
  claudeInterpretation: Record<string, { quality_score: number }>,
  platform: Platform,
): FinalAuditScores {
  const isYouTube = platform === 'youtube_long' || platform === 'youtube_shorts'
  const backendWeight = isYouTube ? 0.75 : 0.60
  const claudeWeight  = isYouTube ? 0.25 : 0.40

  const dims = ['hook_strength', 'retention_potential', 'engagement_quality', 'platform_fit', 'packaging_quality'] as const

  const finalDims = {} as Record<string, number>
  for (const dim of dims) {
    const bScore = backendScores[dim].score
    const cScore = claudeInterpretation[dim]?.quality_score ?? bScore
    finalDims[dim] = clamp(bScore * backendWeight + cScore * claudeWeight)
  }

  const weighted =
    finalDims.hook_strength       * WEIGHTS.hook_strength +
    finalDims.retention_potential * WEIGHTS.retention_potential +
    finalDims.engagement_quality  * WEIGHTS.engagement_quality +
    finalDims.platform_fit        * WEIGHTS.platform_fit +
    finalDims.packaging_quality   * WEIGHTS.packaging_quality

  return {
    hook_strength:       finalDims.hook_strength,
    retention_potential: finalDims.retention_potential,
    engagement_quality:  finalDims.engagement_quality,
    platform_fit:        finalDims.platform_fit,
    packaging_quality:   finalDims.packaging_quality,
    overall:             clamp(weighted),
    weighted_breakdown: {
      hook:         finalDims.hook_strength       * WEIGHTS.hook_strength,
      retention:    finalDims.retention_potential * WEIGHTS.retention_potential,
      engagement:   finalDims.engagement_quality  * WEIGHTS.engagement_quality,
      platform_fit: finalDims.platform_fit        * WEIGHTS.platform_fit,
      packaging:    finalDims.packaging_quality   * WEIGHTS.packaging_quality,
    },
  }
}

// ── DECISION LOGIC ───────────────────────────────────────────────────────────

export function computeDecision(finalScores: FinalAuditScores): {
  decision: AuditDecision
  weakest_dimension: string
  decision_reason: string
} {
  const overall = finalScores.overall

  if (overall >= 90) return { decision: 'Folytatás', weakest_dimension: '-', decision_reason: 'Kiváló teljesítmény. Készíts folytatást vagy hasonló verziót.' }
  if (overall >= 75) return { decision: 'Reupload', weakest_dimension: '-', decision_reason: 'Jó videó. Kisebb finomhangolással újra feltölthető.' }

  const dims = {
    'Hook': finalScores.hook_strength,
    'Retenció': finalScores.retention_potential,
    'Engagement': finalScores.engagement_quality,
    'Platform Fit': finalScores.platform_fit,
    'Csomagolás': finalScores.packaging_quality,
  }
  const weakest = Object.entries(dims).sort((a, b) => a[1] - b[1])[0]
  const [weakName] = weakest

  if (overall >= 60) {
    if (weakName === 'Hook') return { decision: 'Rehook', weakest_dimension: weakName, decision_reason: 'A téma nem rossz, de a nyitás nem adott elég okot a nézőnek, hogy maradjon. Új hook kell.' }
    if (weakName === 'Platform Fit') return { decision: 'Replatform', weakest_dimension: weakName, decision_reason: 'A tartalom jó, de nem erre a platformra optimalizált. Próbáld máshol.' }
    if (weakName === 'Csomagolás') return { decision: 'Repackage', weakest_dimension: weakName, decision_reason: 'A tartalom rendben van, de a csomagolás (cím, thumbnail, hashtag) gyenge.' }
    if (weakName === 'Retenció') return { decision: 'Remix', weakest_dimension: weakName, decision_reason: 'A téma jó, de a struktúra vagy a vágás nem tartja bent a nézőket. Újravágás javasolt.' }
    return { decision: 'Remix', weakest_dimension: weakName, decision_reason: 'Javítható engagement. Erősebb CTA vagy komment trigger javasolt.' }
  }

  if (overall >= 40) return { decision: 'Remix', weakest_dimension: weakName, decision_reason: 'Több fő elem gyenge. Jelentős átdolgozás kell — de a téma megmenthető.' }

  return { decision: 'Abandon', weakest_dimension: weakName, decision_reason: 'Jelenlegi formában nem versenyképes. Új téma, új szög vagy teljes újratervezés javasolt.' }
}

// ── CONFIDENCE ───────────────────────────────────────────────────────────────

export function computeConfidence(platform: Platform, views: number, hasApiData: boolean, hasBehavioralMetrics = false): ConfidenceLevel {
  if (!hasApiData) return views > 1000 ? 'medium' : 'low'
  if (views > 10000 && hasBehavioralMetrics) return 'high'
  if (views > 1000) return 'medium'
  return 'low'
}
