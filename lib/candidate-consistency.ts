// lib/candidate-consistency.ts
// WillViral — Candidate topic consistency validation
// Kiszűri a polluted candidate-eket: kevert források, fals hook, topic mismatch

export type SourcePageType = 'article' | 'category_page' | 'homepage' | 'tag_page' | 'search_page' | 'video_page' | 'low_quality' | 'unknown'

const CATEGORY_TITLE_PATTERNS = [
  /^(tudom[áa]ny|eg[ée]szs[ée]g|sport|tech|politika|kultur|gazdasag|szórakozás)\s*[-–—|:]/i,
  /^(science|health|technology|politics|business|entertainment)\s*[-–—|:]/i,
  /\b(h[ií]rek|news|latest|rovat|section|category|tag)\b.*[-–—|:]\s*([\w]+\.\w{2,})/i,
  /^napi h[ií]rek/i,
  /^[\w\s]+ - [\w\s]+\.(com|hu|org|net)$/i,
]

const CATEGORY_PATH_PATTERNS = [
  /^\/(tudomany|science|egeszseg|health|sport|tech|politika|business|entertainment|hirek|news|kategoria|category|tag|topic|rovat)\/?$/i,
  /^\/(tag|category|topics?|section|rovat)\/[\w-]+\/?$/i,
]

export function classifySourcePage(url: string, title: string): SourcePageType {
  if (!url) return 'unknown'

  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/+$/, '')

    // Search page
    if (url.includes('google.com/search') || url.includes('bing.com/search') || parsed.searchParams.has('q')) {
      return 'search_page'
    }

    // Video page
    if (url.includes('youtube.com/watch') || url.includes('youtu.be/') || url.includes('vimeo.com/')) {
      return 'video_page'
    }

    // Homepage
    if (!path || path === '' || path === '/') return 'homepage'

    const segments = path.split('/').filter(Boolean)

    // Category/tag page by URL pattern
    for (const pattern of CATEGORY_PATH_PATTERNS) {
      if (pattern.test(path)) return 'category_page'
    }

    // Single segment without date/article ID → likely category
    if (segments.length === 1 && !segments[0].match(/\d{4,}/) && segments[0].length < 30) {
      return 'category_page'
    }

    // Title-based category detection
    const normalizedTitle = title.trim()
    for (const pattern of CATEGORY_TITLE_PATTERNS) {
      if (pattern.test(normalizedTitle)) return 'category_page'
    }

    // Title is just "Domain - Section" pattern
    if (/^[\w\sÀ-ɏ]+ [-–—] [\w\sÀ-ɏ]+$/.test(normalizedTitle) && normalizedTitle.length < 50) {
      return 'category_page'
    }

    // Has date or article slug → likely article
    if (segments.some(s => /\d{4}/.test(s)) || segments.length >= 3) {
      return 'article'
    }

    return segments.length >= 2 ? 'article' : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function isValidSourcePage(pageType: SourcePageType): boolean {
  return pageType === 'article' || pageType === 'video_page'
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function meaningfulWords(value: string): string[] {
  const stopwords = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were',
    'new', 'why', 'how', 'what', 'not', 'has', 'have', 'been', 'will', 'can',
    'you', 'your', 'its', 'our', 'all', 'but', 'just', 'about', 'into', 'than',
    'egy', 'hogy', 'mint', 'vagy', 'mert', 'amit', 'ami', 'ezt', 'azt', 'van',
    'nem', 'meg', 'mar', 'csak', 'most', 'itt', 'ott',
    'explained', 'news', 'viral', 'trending', 'latest', 'breaking', 'update',
  ])
  return normalize(value).split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w))
}

function topicSimilarity(textA: string, textB: string): number {
  const wordsA = meaningfulWords(textA)
  const wordsB = meaningfulWords(textB)
  if (wordsA.length === 0 || wordsB.length === 0) return 0

  const matchesAtoB = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb))).length
  const matchesBtoA = wordsB.filter(w => wordsA.some(wa => wa.includes(w) || w.includes(wa))).length

  const ratioA = matchesAtoB / wordsA.length
  const ratioB = matchesBtoA / wordsB.length
  return Math.round(Math.max(ratioA, ratioB) * 100)
}

// ── Source validation ────────────────────────────────────────

interface SourceItem {
  title: string
  snippet?: string
  link?: string
  url?: string
  source?: string
}

interface VideoItem {
  title: string
  description?: string
  videoId?: string
  video_id?: string
}

export interface ConsistencyResult {
  topic_consistency_score: number
  valid_sources: SourceItem[]
  removed_sources: Array<SourceItem & { reason: string }>
  valid_videos: VideoItem[]
  removed_videos: Array<VideoItem & { reason: string }>
  hook_topic_match: boolean
  is_polluted: boolean
  quality_status: 'consistent' | 'acceptable' | 'weak_consistency' | 'polluted'
  reasons: string[]
}

export function validateCandidateConsistency(params: {
  candidate_topic: string
  sources: SourceItem[]
  videos: VideoItem[]
  hook?: string
  min_topic_similarity?: number
}): ConsistencyResult {
  const { candidate_topic, sources, videos, hook, min_topic_similarity = 40 } = params
  const reasons: string[] = []

  // Validate sources
  const validSources: SourceItem[] = []
  const removedSources: Array<SourceItem & { reason: string }> = []

  for (const source of sources) {
    // Forrástípus klasszifikáció
    const url = source.link || source.url || ''
    const pageType = classifySourcePage(url, source.title)
    if (!isValidSourcePage(pageType)) {
      removedSources.push({ ...source, reason: `${pageType === 'homepage' ? 'Fooldal' : pageType === 'category_page' ? 'Kategoriaoldal' : pageType === 'search_page' ? 'Kereso oldal' : 'Nem konkret cikk'} — nem valid bizonyitek.` })
      continue
    }

    const sourceText = `${source.title} ${source.snippet || ''}`
    const sim = topicSimilarity(candidate_topic, sourceText)

    if (sim >= min_topic_similarity) {
      validSources.push(source)
    } else {
      removedSources.push({ ...source, reason: `Topic mismatch (similarity: ${sim}). Forras nem kapcsolodik a candidate temahoz.` })
    }
  }

  if (removedSources.length > 0) {
    reasons.push(`${removedSources.length} forras eltavolitva topic mismatch miatt`)
  }

  // Validate videos
  const validVideos: VideoItem[] = []
  const removedVideos: Array<VideoItem & { reason: string }> = []

  for (const video of videos) {
    const videoText = `${video.title} ${video.description || ''}`
    const sim = topicSimilarity(candidate_topic, videoText)

    if (sim >= min_topic_similarity) {
      validVideos.push(video)
    } else {
      removedVideos.push({ ...video, reason: `Topic mismatch (similarity: ${sim}). Video nem kapcsolodik a candidate temahoz.` })
    }
  }

  if (removedVideos.length > 0) {
    reasons.push(`${removedVideos.length} video eltavolitva topic mismatch miatt`)
  }

  // Hook topic match — a hook gyakran magyar, a topic angol → entity-szintű check
  let hookTopicMatch = true
  if (hook && hook.length > 10) {
    const hookSim = topicSimilarity(candidate_topic, hook)
    // Ha van legalább 1 valid source, a hook-nak a SOURCE-okkal is matchelhet
    const hookSourceSim = validSources.length > 0
      ? Math.max(...validSources.map(s => topicSimilarity(`${s.title} ${s.snippet || ''}`, hook)))
      : 0
    const bestHookSim = Math.max(hookSim, hookSourceSim)
    hookTopicMatch = bestHookSim >= 25
    if (!hookTopicMatch) {
      reasons.push(`Hook topic mismatch (similarity: ${bestHookSim}). A hook nem egyezik a validalt temaval.`)
    }
  }

  // Calculate overall consistency score
  const totalItems = sources.length + videos.length
  const validItems = validSources.length + validVideos.length
  const consistencyRatio = totalItems > 0 ? validItems / totalItems : 0

  // Source-level consistency: how similar are the valid sources to each other?
  let sourceConsistency = 100
  if (validSources.length >= 2) {
    const pairScores: number[] = []
    for (let i = 0; i < validSources.length; i++) {
      for (let j = i + 1; j < validSources.length; j++) {
        const sA = `${validSources[i].title} ${validSources[i].snippet || ''}`
        const sB = `${validSources[j].title} ${validSources[j].snippet || ''}`
        pairScores.push(topicSimilarity(sA, sB))
      }
    }
    sourceConsistency = Math.round(pairScores.reduce((a, b) => a + b, 0) / pairScores.length)
  }

  const topicConsistencyScore = Math.round(
    consistencyRatio * 50 +
    (hookTopicMatch ? 20 : 0) +
    Math.min(30, sourceConsistency * 0.3)
  )

  // Determine quality status
  const isPolluted = topicConsistencyScore < 40 || (!hookTopicMatch && removedSources.length > validSources.length)
  let qualityStatus: ConsistencyResult['quality_status']
  if (topicConsistencyScore >= 80) qualityStatus = 'consistent'
  else if (topicConsistencyScore >= 60) qualityStatus = 'acceptable'
  else if (topicConsistencyScore >= 40) qualityStatus = 'weak_consistency'
  else qualityStatus = 'polluted'

  return {
    topic_consistency_score: topicConsistencyScore,
    valid_sources: validSources,
    removed_sources: removedSources,
    valid_videos: validVideos,
    removed_videos: removedVideos,
    hook_topic_match: hookTopicMatch,
    is_polluted: isPolluted,
    quality_status: qualityStatus,
    reasons,
  }
}

// ── Hook Topic Lock ──────────────────────────────────────────

export interface HookTopicLock {
  locked_topic: string
  allowed_entities: string[]
  allowed_claims: string[]
  forbidden_angles: string[]
}

export function buildHookTopicLock(
  candidateTopic: string,
  validSources: SourceItem[],
  removedSources: Array<SourceItem & { reason: string }>,
): HookTopicLock {
  const topicWords = meaningfulWords(candidateTopic)

  // Extract entities from valid sources
  const allowedEntities = new Set<string>()
  const allowedClaims: string[] = []
  for (const source of validSources) {
    const words = meaningfulWords(source.title)
    words.filter(w => w.length > 3).forEach(w => allowedEntities.add(w))
    if (source.snippet) {
      allowedClaims.push(source.snippet.slice(0, 150))
    }
  }

  // Forbidden angles from removed sources
  const forbiddenAngles: string[] = []
  for (const removed of removedSources) {
    const removedWords = meaningfulWords(removed.title)
    const uniqueToRemoved = removedWords.filter(w => !topicWords.includes(w) && w.length > 4)
    forbiddenAngles.push(...uniqueToRemoved.slice(0, 3))
  }

  return {
    locked_topic: candidateTopic,
    allowed_entities: Array.from(allowedEntities).slice(0, 20),
    allowed_claims: allowedClaims.slice(0, 5),
    forbidden_angles: [...new Set(forbiddenAngles)].slice(0, 10),
  }
}

export function buildHookTopicLockPrompt(lock: HookTopicLock): string {
  const lines = [
    'HOOK TOPIC LOCK — KOTELEZO SZABALY:',
    `A hook KIZAROLAG errol a temarol szolhat: "${lock.locked_topic}"`,
    '',
    'ENGEDELYEZETT entitasok/szavak: ' + lock.allowed_entities.slice(0, 10).join(', '),
    '',
  ]

  if (lock.allowed_claims.length > 0) {
    lines.push('ENGEDELYEZETT allitasok (csak ezekbol dolgozz):')
    lock.allowed_claims.forEach(c => lines.push(`- ${c}`))
    lines.push('')
  }

  if (lock.forbidden_angles.length > 0) {
    lines.push('TILTOTT szogek/temak (NE hasznald ezeket):')
    lock.forbidden_angles.forEach(a => lines.push(`- ${a}`))
    lines.push('')
  }

  lines.push('NE irj mas temarol, mas helyszinrol, mas esemenynrol.')
  lines.push('NE talalj ki uj tenyt ami nincs a forrasokban.')
  lines.push('Ha nincs eleg anyag jo hookhoz, irj rovid, ovatos hookot.')

  return lines.join('\n')
}
