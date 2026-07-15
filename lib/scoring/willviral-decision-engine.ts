// WillViral Decision Engine
// Shared production-readiness gates for topics and videos.

const DAY_MS = 24 * 60 * 60 * 1000

export type WillViralDecisionStatus = 'ready' | 'watch' | 'research' | 'rejected'

export interface DecisionResult {
  status: WillViralDecisionStatus
  label: string
  score: number
  risk_flags: string[]
  gates: {
    relevance: boolean
    market_validation: boolean
    freshness: boolean
    evidence: boolean
  }
}

export interface VideoDecisionInput {
  relevance_score: number
  freshness_score: number
  velocity_score: number
  engagement_score: number
  outlier_score: number
  view_count: number
  views_per_day: number
  published_at: string
}

export interface TopicDecisionInput {
  score: number
  relevance_score: number
  freshness_score: number
  web_source_count: number
  evidence_video_count: number
  strong_video_count: number
  source_type?: string
  confidence?: 'high' | 'medium' | 'low' | string
}

export function ageDays(publishedAt: string) {
  const time = new Date(publishedAt).getTime()
  if (!Number.isFinite(time) || time > Date.now() + 60 * 60 * 1000) return 9999
  return Math.max(0, (Date.now() - time) / DAY_MS)
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(100, value)))
}

export function hasVideoMarketValidation(input: VideoDecisionInput) {
  return (
    input.view_count >= 1000 ||
    (input.views_per_day >= 300 && input.view_count >= 300) ||
    (input.engagement_score >= 70 && input.view_count >= 300) ||
    (input.outlier_score >= 80 && input.view_count >= 500)
  )
}

export function scoreValidatedVideo(input: VideoDecisionInput) {
  let score = clampScore(
    input.velocity_score * 0.30 +
    input.engagement_score * 0.25 +
    input.outlier_score * 0.20 +
    input.freshness_score * 0.15 +
    input.relevance_score * 0.10
  )

  if (input.view_count < 100) score = Math.min(score, 35)
  else if (input.view_count < 500) score = Math.min(score, 50)
  else if (input.view_count < 1000) score = Math.min(score, 60)

  return score
}

export function decideSimilarVideo(input: VideoDecisionInput): DecisionResult {
  const risk_flags: string[] = []

  // ── Relevancia kapu — irreleváns videó nem jut tovább ──
  if (input.relevance_score < 60) {
    return {
      status: 'rejected',
      label: 'Nem releváns',
      score: 0,
      risk_flags: ['Nem kapcsolódik eléggé a témához'],
      gates: { relevance: false, market_validation: false, freshness: false, evidence: false },
    }
  }

  if (input.view_count < 100) {
    return {
      status: 'rejected',
      label: 'Túl gyenge jel',
      score: Math.min(25, scoreValidatedVideo(input)),
      risk_flags: ['100 alatti megtekintés', 'Nincs elég piaci bizonyíték'],
      gates: { relevance: true, market_validation: false, freshness: false, evidence: false },
    }
  }

  // ── Piaci scoring — csak releváns videók kapnak pontot ──
  const market_validation = hasVideoMarketValidation(input)
  const publishedAgeDays = ageDays(input.published_at)
  const freshness = publishedAgeDays < 9999 && (
    publishedAgeDays <= 180 || (input.outlier_score >= 85 && input.view_count >= 5000)
  )
  const evidence = input.view_count >= 100
  const score = scoreValidatedVideo(input)

  if (!market_validation) risk_flags.push('Nincs elég piaci validáció')
  if (!freshness) risk_flags.push('Nem elég friss')
  if (input.view_count < 100) risk_flags.push('Túl kevés megtekintés')

  const gates = { relevance: true, market_validation, freshness, evidence }

  if (market_validation && freshness && evidence && score >= 60) {
    return { status: 'ready', label: 'Ajánlott inspiráció', score, risk_flags: [], gates }
  }
  if (market_validation && evidence && score >= 45) {
    return { status: 'watch', label: 'Figyelendő jel', score, risk_flags, gates }
  }
  if (evidence) {
    return { status: 'research', label: 'Kutatási nyom', score, risk_flags, gates }
  }
  return { status: 'rejected', label: 'Nem ajánlott', score, risk_flags, gates }
}

export function decideOpportunityTopic(input: TopicDecisionInput): DecisionResult {
  const risk_flags: string[] = []
  const relevance = input.relevance_score >= 60
  const freshness = input.freshness_score >= 45
  const evidence =
    input.web_source_count >= 2 ||
    (input.web_source_count >= 1 && input.evidence_video_count >= 1) ||
    input.strong_video_count >= 2
  const market_validation = input.strong_video_count >= 1 || input.web_source_count >= 2

  if (!relevance) risk_flags.push('Gyenge niche/relevancia illeszkedés')
  if (!freshness) risk_flags.push('Nem elég friss jel')
  if (!evidence) risk_flags.push('Kevés ellenőrzött bizonyíték')
  if (!market_validation) risk_flags.push('Kevés piaci validáció')
  if (input.confidence && input.confidence !== 'high') risk_flags.push('Nem magas megbízhatóság')

  const score = clampScore(
    (market_validation ? 85 : 35) * 0.30 +
    input.relevance_score * 0.25 +
    input.freshness_score * 0.20 +
    (evidence ? 80 : 25) * 0.15 +
    input.score * 0.10
  )

  const gates = { relevance, market_validation, freshness, evidence }
  if (Object.values(gates).every(Boolean) && input.score >= 68 && score >= 65 && input.confidence === 'high') {
    return { status: 'ready', label: 'Gyártható ma', score, risk_flags: [], gates }
  }
  if (relevance && evidence && market_validation && input.score >= 55) {
    return { status: 'watch', label: 'Korai lehetőség', score, risk_flags, gates }
  }
  if (relevance || evidence) {
    return { status: 'research', label: 'Kutatás kell', score, risk_flags, gates }
  }
  return { status: 'rejected', label: 'Elutasítva', score, risk_flags, gates }
}
