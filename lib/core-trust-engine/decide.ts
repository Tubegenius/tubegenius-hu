import type { TrustScores, TrustDecision, TrustDecisionType, FinalDecision, ValidationResult } from './types'

export function decideTrust(
  scores: TrustScores,
  validation: ValidationResult,
): TrustDecision {
  const consistencyScore = validation.consistency.topic_consistency_score

  if (validation.consistency.is_polluted || consistencyScore < 40) {
    return buildDecision('polluted_candidate', 'reject', 'low', scores, validation)
  }

  if (scores.web_validation >= 70 && scores.video_engagement >= 60) {
    const confidence = consistencyScore >= 80 ? 'high' : 'medium'
    return buildDecision('hybrid_validated_trend', 'make_now', confidence, scores, validation)
  }

  if (scores.web_validation >= 40 && scores.video_engagement < 40) {
    const confidence = scores.web_validation >= 70 ? 'medium' : 'low'
    return buildDecision('web_validated_opportunity', 'early_opportunity', confidence, scores, validation)
  }

  if (scores.video_engagement >= 50 && scores.web_validation < 40) {
    return buildDecision('video_inspiration', 'validate_more', 'low', scores, validation)
  }

  return buildDecision('research_required', 'validate_more', 'low', scores, validation)
}

function buildDecision(
  type: TrustDecisionType,
  finalDecision: FinalDecision,
  confidence: 'high' | 'medium' | 'low',
  scores: TrustScores,
  validation: ValidationResult,
): TrustDecision {
  const webCount = validation.valid_web_sources.length
  const videoCount = validation.valid_video_sources.length
  const { label, explanation, reasons, warnings } = buildLabels(type, webCount, videoCount, scores)
  const { cta_primary, cta_secondary } = buildCTAs(type)

  return {
    type,
    final_decision: finalDecision,
    confidence,
    user_facing: type !== 'polluted_candidate',
    label,
    explanation,
    reasons,
    warnings,
    cta_primary,
    cta_secondary,
  }
}

function buildLabels(
  type: TrustDecisionType,
  webCount: number,
  videoCount: number,
  scores: TrustScores,
): { label: string; explanation: string; reasons: string[]; warnings: string[] } {
  const reasons: string[] = []
  const warnings: string[] = []

  switch (type) {
    case 'hybrid_validated_trend':
      reasons.push(`${webCount} webes forrás`, `${videoCount} releváns videó`)
      return {
        label: 'Erősen validált trend',
        explanation: 'Webes források és videós aktivitás is ugyanarra a témára mutat.',
        reasons,
        warnings,
      }

    case 'web_validated_opportunity':
      reasons.push(`${webCount} webes forrás`)
      if (videoCount === 0) {
        return {
          label: 'Korai webes lehetőség',
          explanation: 'A téma webes források alapján aktuális, de YouTube-on még nem találtunk releváns videót.',
          reasons,
          warnings: ['YouTube-on még kevés a feldolgozás'],
        }
      }
      return {
        label: 'Korai webes lehetőség',
        explanation: 'A téma webes források alapján aktuális, de videós feldolgozás még kevés látszik.',
        reasons,
        warnings,
      }

    case 'video_inspiration':
      reasons.push(`${videoCount} releváns videó`)
      if (webCount === 0) {
        return {
          label: 'Videós inspiráció',
          explanation: 'A formátum vagy engagement erős, de tényalapú validáláshoz további webes forrás kell.',
          reasons,
          warnings: ['Nincs webes forrás — tényalapú validálás hiányzik'],
        }
      }
      return {
        label: 'Videós inspiráció',
        explanation: 'A videós jelek alapján van aktivitás, de konkrét webes forrásból még gyenge az alátámasztás.',
        reasons,
        warnings,
      }

    case 'research_required':
      if (webCount > 0) reasons.push(`${webCount} webes forrás (gyenge)`)
      if (videoCount > 0) reasons.push(`${videoCount} videó (gyenge)`)
      return {
        label: 'Kutatás kell',
        explanation: 'A téma ígéretes lehet, de még nincs elég konkrét alátámasztás.',
        reasons,
        warnings: ['További forráskeresés szükséges'],
      }

    case 'polluted_candidate':
      return {
        label: 'Kiszűrve — forráskeveredés',
        explanation: 'A források nem ugyanarra a konkrét témára vonatkoznak.',
        reasons: ['Forráskeveredés'],
        warnings: ['Nem megbízható ajánlás'],
      }
  }
}

function buildCTAs(type: TrustDecisionType): {
  cta_primary: { text: string; action: string }
  cta_secondary?: { text: string; action: string }
} {
  switch (type) {
    case 'hybrid_validated_trend':
      return {
        cta_primary: { text: 'Videócsomag generálása', action: 'video_package' },
        cta_secondary: { text: 'Similar Videos megnyitása', action: 'similar_videos' },
      }
    case 'web_validated_opportunity':
      return {
        cta_primary: { text: 'Készíts teszt videócsomagot', action: 'video_package' },
        cta_secondary: { text: 'Keress hasonló videókat', action: 'similar_videos' },
      }
    case 'video_inspiration':
      return {
        cta_primary: { text: 'Similar Videos megnyitása', action: 'similar_videos' },
        cta_secondary: { text: 'Webes források keresése', action: 'web_search' },
      }
    case 'research_required':
      return {
        cta_primary: { text: 'További források keresése', action: 'search_more' },
        cta_secondary: { text: 'Similar Videos keresése', action: 'similar_videos' },
      }
    case 'polluted_candidate':
      return {
        cta_primary: { text: 'Mutass másik témát', action: 'replace' },
      }
  }
}
