import type { ValidationResult, ValidatedWebSource, ValidatedVideoSource } from './types'
import type { TrendCandidate } from '@/lib/trend-radar'
import {
  validateCandidateConsistency,
  classifySourcePage,
  isValidSourcePage,
} from '@/lib/candidate-consistency'
import { calculateNicheFit } from '@/lib/niche-fit'

function extractDomainFromTitle(title: string): string | null {
  const dashParts = title.split(/\s[–—-]\s/)
  if (dashParts.length >= 2) {
    return dashParts[dashParts.length - 1].trim().toLowerCase().replace(/\s+/g, '')
  }
  return null
}

function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

function isSafeEvidenceUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && Boolean(parsed.hostname)
  } catch {
    return false
  }
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function sourceDomainMatches(url: string, title: string): boolean {
  const titleDomain = extractDomainFromTitle(title)
  if (!titleDomain) return true
  const urlDomain = extractDomainFromUrl(url)
  if (!urlDomain) return true
  const titleClean = titleDomain.replace(/[^a-z0-9]/g, '')
  const urlClean = urlDomain.replace(/[^a-z0-9]/g, '')
  return urlClean.includes(titleClean) || titleClean.includes(urlClean)
}

export function validateCandidate(
  candidate: TrendCandidate,
  niche: string,
): ValidationResult {
  const consistency = validateCandidateConsistency({
    candidate_topic: candidate.candidate_topic,
    sources: candidate.web_sources.map(s => ({
      title: s.title,
      snippet: s.snippet,
      link: s.link,
    })),
    videos: candidate.source_videos.map(v => ({
      title: v.title,
      description: v.description,
    })),
  })

  const validWebSources: ValidatedWebSource[] = []
  const rejectedWeb: Array<{ title: string; reason: string }> = []

  for (const source of candidate.web_sources) {
    if (!isSafeEvidenceUrl(source.link || '')) {
      rejectedWeb.push({ title: source.title, reason: 'invalid_evidence_url' })
      continue
    }
    const pageType = classifySourcePage(source.link || '', source.title)
    const wasRemoved = consistency.removed_sources.some(r => r.title === source.title)

    if (!isValidSourcePage(pageType)) {
      rejectedWeb.push({ title: source.title, reason: `source_page_type: ${pageType}` })
      continue
    }
    if (!sourceDomainMatches(source.link || '', source.title)) {
      rejectedWeb.push({ title: source.title, reason: 'url_domain_mismatch' })
      continue
    }
    if (wasRemoved) {
      const removal = consistency.removed_sources.find(r => r.title === source.title)
      rejectedWeb.push({ title: source.title, reason: removal?.reason || 'consistency_mismatch' })
      continue
    }

    validWebSources.push({
      title: source.title,
      url: source.link,
      snippet: source.snippet,
      date: source.date,
      source: source.source,
      relevance_score: 80,
    })
  }

  const validVideoSources: ValidatedVideoSource[] = []
  const rejectedVideo: Array<{ title: string; reason: string }> = []

  for (const video of candidate.source_videos) {
    const wasRemoved = consistency.removed_videos.some(r => r.title === video.title)

    if (wasRemoved) {
      const removal = consistency.removed_videos.find(r => r.title === video.title)
      rejectedVideo.push({ title: video.title, reason: removal?.reason || 'consistency_mismatch' })
      continue
    }

    if (!/^[A-Za-z0-9_-]{11}$/.test(video.videoId || '')) {
      rejectedVideo.push({ title: video.title, reason: 'invalid_video_id' })
      continue
    }
    if (![video.viewCount, video.likeCount, video.commentCount].every(isFiniteNonNegative)) {
      rejectedVideo.push({ title: video.title, reason: 'invalid_video_metrics' })
      continue
    }
    if (!Number.isFinite(video.relevance_score) || video.relevance_score < 0 || video.relevance_score > 100) {
      rejectedVideo.push({ title: video.title, reason: 'invalid_relevance_score' })
      continue
    }

    const publishedAtMs = new Date(video.publishedAt).getTime()
    if (!Number.isFinite(publishedAtMs) || publishedAtMs > Date.now()) {
      rejectedVideo.push({ title: video.title, reason: 'invalid_published_at' })
      continue
    }
    const ageDays = Math.max(1, (Date.now() - publishedAtMs) / (24 * 60 * 60 * 1000))
    const viewsPerDay = video.viewCount / ageDays
    const isStrong = video.viewCount >= 1000 || viewsPerDay >= 300

    const engagementRate = video.viewCount > 0
      ? ((video.likeCount + video.commentCount) / video.viewCount) * 100
      : 0

    validVideoSources.push({
      videoId: video.videoId,
      title: video.title,
      channelTitle: video.channelTitle,
      thumbnailUrl: video.thumbnailUrl,
      viewCount: video.viewCount,
      likeCount: video.likeCount,
      commentCount: video.commentCount,
      publishedAt: video.publishedAt,
      description: video.description,
      relevance_score: video.relevance_score ?? 70,
      engagement_score: Math.min(100, engagementRate * 10),
      is_strong: isStrong,
    })
  }

  // Mindig a teljes (multi-category) niche stringgel számolunk, hogy a categoryRatio
  // helyesen büntesse ha csak 1 a 4 kategóriából matchel (subNiche-enkénti 1/1 arány
  // false positive magas score-t adott egyetlen generikus term-matchre, pl. egy évszámra).
  const topicAsVideo = { title: candidate.candidate_topic, description: candidate.candidate_topic_en || '' }
  const fullFit = calculateNicheFit(topicAsVideo, niche, candidate.relevance_average)
  const bestNicheFit = fullFit.score
  const matchedCategories = fullFit.matchedCategories

  return {
    valid_web_sources: validWebSources,
    valid_video_sources: validVideoSources,
    rejected_web_sources: rejectedWeb,
    rejected_video_sources: rejectedVideo,
    consistency,
    niche_fit_score: bestNicheFit,
    niche_matched_categories: matchedCategories,
  }
}
