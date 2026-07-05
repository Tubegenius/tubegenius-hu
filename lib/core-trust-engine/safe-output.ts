import type { SafeOutput, TrustDecision, ValidationResult } from './types'
import { buildHookTopicLock } from '@/lib/candidate-consistency'

export function normalizeEvidenceText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function evidenceWords(value: string) {
  const stopwords = new Set([
    'hogy', 'mint', 'vagy', 'mert', 'amit', 'ami', 'egy', 'ezt', 'azt', 'ezek', 'arra',
    'tudosok', 'felfedeztek', 'teljesen', 'befolyasolja', 'atirja', 'tudtunk',
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were', 'new', 'why', 'how',
  ])

  return normalizeEvidenceText(value)
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w))
}

export function evidenceMatchesTitle(displayTitle: string, evidenceTitle: string, evidenceSnippet = '') {
  const displayWords = evidenceWords(displayTitle)
  if (displayWords.length === 0) return false

  const evidenceText = normalizeEvidenceText(`${evidenceTitle} ${evidenceSnippet}`)
  const matches = displayWords.filter(w => evidenceText.includes(w)).length
  const ratio = matches / displayWords.length

  return matches >= 2 || ratio >= 0.35
}

function formatCompactViews(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
  return String(value)
}

function buildEvidenceBoundExplanation(baseExplanation: string, validation: ValidationResult): string {
  const webCount = validation.valid_web_sources.length
  const videos = validation.valid_video_sources
  const strongVideos = videos.filter(v => v.is_strong)
  const webPart = webCount > 0
    ? `${webCount} webes forrás alapján aktuális jel látszik.`
    : 'Nincs elég konkrét webes forrás.'

  const videoPart = strongVideos.length > 0
    ? `A validált videók tényleges nézettségi sávja: ${formatCompactViews(Math.min(...strongVideos.map(v => v.viewCount)))}-${formatCompactViews(Math.max(...strongVideos.map(v => v.viewCount)))} megtekintés (${strongVideos.length} erősebb videó).`
    : videos.length > 0
      ? `Van ${videos.length} kapcsolódó videójel, de ezek nem elég erősek ahhoz, hogy erős videós bizonyítéknak számítsanak.`
      : 'Nincs erős videós bizonyíték.'

  return `${baseExplanation} ${webPart} ${videoPart}`
}

export function buildSafeOutput(params: {
  candidate_topic: string
  decision: TrustDecision
  validation: ValidationResult
  claude_title?: string
  claude_description?: string
  claude_hook?: string
}): SafeOutput {
  const { candidate_topic, decision, validation, claude_title, claude_description, claude_hook } = params

  let headline = candidate_topic
  if (claude_title && claude_title !== candidate_topic) {
    const titleMatchesEvidence =
      validation.valid_web_sources.some(s => evidenceMatchesTitle(claude_title, s.title, s.snippet)) ||
      validation.valid_video_sources.some(v => evidenceMatchesTitle(claude_title, v.title, v.description || ''))
    if (titleMatchesEvidence) {
      headline = claude_title
    }
  }

  let explanation = buildEvidenceBoundExplanation(decision.explanation, validation)
  if (claude_description && !contradicts(claude_description, validation) && !hasUnsupportedEvidenceNumbers(claude_description)) {
    explanation = buildEvidenceBoundExplanation(claude_description, validation)
  }

  let hook: string | null = null
  let hook_status: 'generated' | 'blocked' = 'blocked'
  let blocked_reason: string | undefined = 'Hook generálása előtt további forrásellenőrzés szükséges.'

  const canGenerateHook =
    validation.consistency.topic_consistency_score >= 70 &&
    (validation.valid_web_sources.length >= 1 || validation.valid_video_sources.length >= 1)

  if (canGenerateHook && claude_hook) {
    const hookLock = buildHookTopicLock(
      headline,
      validation.valid_web_sources.map(s => ({ title: s.title, snippet: s.snippet, link: s.url })),
      validation.rejected_web_sources.map(r => ({ title: r.title, snippet: '', link: '', reason: r.reason })),
    )

    if (hookLock.allowed_entities.length > 0 || hookLock.allowed_claims.length > 0) {
      hook = claude_hook
      hook_status = 'generated'
      blocked_reason = undefined
    } else {
      blocked_reason = 'A hook nem egyezik a validált témával.'
    }
  } else if (!canGenerateHook) {
    blocked_reason = validation.consistency.topic_consistency_score < 70
      ? 'A források nem elég konzisztensek hook generálásához.'
      : 'Nincs elég validált forrás hook generálásához.'
  }

  const ctas: Array<{ text: string; action: string }> = [decision.cta_primary]
  if (decision.cta_secondary) ctas.push(decision.cta_secondary)

  return {
    headline,
    explanation,
    hook,
    hook_status,
    blocked_reason,
    dashboard_label: decision.label,
    detail_label: decision.label,
    ctas,
    risk_flags: decision.warnings,
  }
}

function hasUnsupportedEvidenceNumbers(claudeDescription: string): boolean {
  const desc = claudeDescription.toLowerCase()
  return /\d+\s*[kme]|\d+[.,]\d+\s*[kme]|\d+\s*-\s*\d+/.test(desc) || desc.includes('megtekintés') || desc.includes('views')
}

function contradicts(claudeDescription: string, validation: ValidationResult): boolean {
  const desc = claudeDescription.toLowerCase()
  const claimsSupport = (term: string) =>
    desc.includes(term) && (desc.includes('validál') || desc.includes('alátámaszt') || desc.includes('bizonyít') || desc.includes('trendel'))

  // Tényleges forrásszámok alapján döntünk, nem a warnings szöveg tartalma alapján —
  // így research_required esetén is elkapjuk, ha a Claude YouTube/web validációt állít
  // miközben a validált forrásszám 0.
  if (validation.valid_video_sources.length === 0 && claimsSupport('youtube')) {
    return true
  }
  if (validation.valid_web_sources.length === 0 && claimsSupport('webes')) {
    return true
  }

  return false
}

export function buildClaudePromptContext(params: {
  decision: TrustDecision
  validation: ValidationResult
}): string {
  const { decision, validation } = params
  return `VALIDÁCIÓS ÖSSZEFOGLALÓ: ${decision.explanation}
VALIDÁCIÓS TÍPUS: ${decision.label}
VALIDÁLT WEB FORRÁSOK: ${validation.valid_web_sources.length} db
VALIDÁLT VIDEÓK: ${validation.valid_video_sources.length} db
ELUTASÍTOTT FORRÁSOK: ${validation.rejected_web_sources.length + validation.rejected_video_sources.length} db
KONZISZTENCIA: ${validation.consistency.topic_consistency_score}/100`
}
