import type {
  TrustScores,
  TrustDecision,
  TrustDecisionType,
  FinalDecision,
  ValidationResult,
  EvidenceStrength,
  RecommendedNextAction,
} from './types'

export function decideTrust(
  scores: TrustScores,
  validation: ValidationResult,
): TrustDecision {
  const consistencyScore = validation.consistency.topic_consistency_score
  const webCount = validation.valid_web_sources.length
  const videoCount = validation.valid_video_sources.length
  const strongVideoCount = validation.valid_video_sources.filter(v => v.is_strong).length
  const nicheFit = scores.niche_fit
  const hasAnyEvidence = webCount > 0 || videoCount > 0

  if (validation.consistency.is_polluted || consistencyScore < 40) {
    return buildDecision('polluted_candidate', 'reject', 'low', scores, validation)
  }

  // Premium rule: "gyártható most" csak akkor lehet, ha több különböző jel is ugyanarra mutat.
  // Nem kell brutálisan sok YouTube adat, de legalább 2 webes forrás + 1 erős videójel kell.
  if (
    webCount >= 2 &&
    strongVideoCount >= 1 &&
    consistencyScore >= 70 &&
    nicheFit >= 60 &&
    scores.freshness >= 45
  ) {
    const confidence = consistencyScore >= 82 && scores.web_validation >= 70 ? 'high' : 'medium'
    return buildDecision('hybrid_validated_trend', 'make_now', confidence, scores, validation)
  }

  // Premium rule: weben friss/erős, YouTube-on még kevés. Ezt nem szabad kidobni,
  // mert pont ez lehet a korai lehetőség.
  if (webCount >= 1 && consistencyScore >= 60 && nicheFit >= 55 && scores.freshness >= 35) {
    const confidence = webCount >= 2 && consistencyScore >= 75 ? 'medium' : 'low'
    return buildDecision('web_validated_opportunity', 'early_opportunity', confidence, scores, validation)
  }

  // Videójel önmagában inspiráció, de nem tényvalidált téma. Ezt kutatási nyomként adjuk,
  // ne gyártási ajánlásként.
  if (videoCount >= 1 && consistencyScore >= 55 && nicheFit >= 50) {
    return buildDecision('video_inspiration', 'validate_more', 'low', scores, validation)
  }

  if (hasAnyEvidence || nicheFit >= 45) {
    return buildDecision('research_required', 'validate_more', 'low', scores, validation)
  }

  return buildDecision('polluted_candidate', 'reject', 'low', scores, validation)
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
  const strongVideoCount = validation.valid_video_sources.filter(v => v.is_strong).length
  const evidenceStrength = computeEvidenceStrength(webCount, videoCount, strongVideoCount)
  const { label, explanation, reasons, warnings } = buildLabels(type, webCount, videoCount, strongVideoCount, scores, validation)
  const { cta_primary, cta_secondary } = buildCTAs(type, evidenceStrength)
  const recommendedNextAction = buildRecommendedNextAction(type, evidenceStrength)

  return {
    type,
    final_decision: finalDecision,
    confidence,
    user_facing: type !== 'polluted_candidate',
    label,
    explanation,
    reasons,
    warnings,
    evidence_strength: evidenceStrength,
    validation_reason: buildValidationReason(type, evidenceStrength, webCount, videoCount, strongVideoCount, validation),
    recommended_next_action: recommendedNextAction,
    data_limitations: buildDataLimitations(type, webCount, videoCount, strongVideoCount, validation),
    cta_primary,
    cta_secondary,
  }
}

function computeEvidenceStrength(webCount: number, videoCount: number, strongVideoCount: number): EvidenceStrength {
  if (webCount >= 2 && strongVideoCount >= 1) return 'strong'
  if (webCount >= 2 || (webCount >= 1 && videoCount >= 1) || strongVideoCount >= 1) return 'medium'
  if (webCount >= 1 || videoCount >= 1) return 'weak'
  return 'none'
}

function buildLabels(
  type: TrustDecisionType,
  webCount: number,
  videoCount: number,
  strongVideoCount: number,
  scores: TrustScores,
  validation: ValidationResult,
): { label: string; explanation: string; reasons: string[]; warnings: string[] } {
  const reasons: string[] = []
  const warnings: string[] = []
  const rejectedCount = validation.rejected_web_sources.length + validation.rejected_video_sources.length

  switch (type) {
    case 'hybrid_validated_trend':
      reasons.push(`${webCount} webes forrás`, `${videoCount} releváns videó`, `${strongVideoCount} erős videójel`)
      return {
        label: 'Gyártható most',
        explanation: 'Több független jel is ugyanarra a konkrét témára mutat: webes forrás és erős videós piaci jel is van.',
        reasons,
        warnings,
      }

    case 'web_validated_opportunity':
      reasons.push(`${webCount} webes forrás`)
      if (videoCount > 0) reasons.push(`${videoCount} videós jel`)
      if (strongVideoCount === 0) warnings.push('YouTube-on még nincs erős, validált feldolgozás')
      if (rejectedCount > 0) warnings.push(`${rejectedCount} nem passzoló forrást kiszűrtünk`)
      return {
        label: 'Korai lehetőség',
        explanation: 'A téma webes források alapján aktuális vagy ígéretes, de a videós piac még nem telített. Ez tesztelhető tartalmi lehetőség.',
        reasons,
        warnings,
      }

    case 'video_inspiration':
      reasons.push(`${videoCount} releváns videó`)
      warnings.push('Tényállításokhoz még webes forrás kell')
      return {
        label: 'Inspiráció, ellenőrzés kell',
        explanation: 'Van videós jel vagy formátum-inspiráció, de önmagában ez még nem elég forrásalapú gyártási ajánláshoz.',
        reasons,
        warnings,
      }

    case 'research_required':
      if (webCount > 0) reasons.push(`${webCount} webes jel`)
      if (videoCount > 0) reasons.push(`${videoCount} videós jel`)
      warnings.push('További szűkítés vagy mély frissítés javasolt')
      return {
        label: 'Kutatandó irány',
        explanation: 'A rendszer talált jeleket vagy releváns irányt, de ez még nem elég feszes konkrét gyártási témához.',
        reasons,
        warnings,
      }

    case 'polluted_candidate':
      return {
        label: 'Elutasítva',
        explanation: 'A források nem ugyanarra a konkrét témára vonatkoznak, vagy túl gyenge a témakapcsolat.',
        reasons: ['Forráskeveredés vagy gyenge relevancia'],
        warnings: ['Nem megbízható ajánlás'],
      }
  }
}

function buildValidationReason(
  type: TrustDecisionType,
  evidenceStrength: EvidenceStrength,
  webCount: number,
  videoCount: number,
  strongVideoCount: number,
  validation: ValidationResult,
): string {
  const consistency = Math.round(validation.consistency.topic_consistency_score)
  if (type === 'hybrid_validated_trend') {
    return `Erős bizonyíték: ${webCount} webes forrás és ${strongVideoCount} erős videójel, ${consistency}/100 témakapcsolattal.`
  }
  if (type === 'web_validated_opportunity') {
    return `Korai validáció: ${webCount} webes forrás található, de az erős YouTube bizonyíték még korlátozott.`
  }
  if (type === 'video_inspiration') {
    return `Videós inspiráció: ${videoCount} releváns videójel van, de webes forrás nélkül nem kezeljük kész ténytémaként.`
  }
  if (type === 'research_required') {
    return evidenceStrength === 'none'
      ? 'Nincs elég konkrét bizonyíték; a téma csak kutatási irányként használható.'
      : `Gyenge/közepes jel: további forráskeresés kell, mielőtt gyártási témává válik.`
  }
  return 'A jelkeveredés vagy gyenge témakapcsolat miatt a rendszer nem ajánlja.'
}

function buildDataLimitations(
  type: TrustDecisionType,
  webCount: number,
  videoCount: number,
  strongVideoCount: number,
  validation: ValidationResult,
): string[] {
  const limitations: string[] = []
  if (webCount === 0) limitations.push('Nincs validált webes forrás')
  if (strongVideoCount === 0) limitations.push('Nincs erős videós bizonyíték')
  if (videoCount === 0) limitations.push('Nincs releváns YouTube bizonyíték')
  if (validation.rejected_web_sources.length > 0 || validation.rejected_video_sources.length > 0) {
    limitations.push('Nem passzoló forrásokat kiszűrtünk')
  }
  if (type === 'research_required') limitations.push('A téma még szűkítést igényel')
  return Array.from(new Set(limitations))
}

function buildRecommendedNextAction(type: TrustDecisionType, evidenceStrength: EvidenceStrength): RecommendedNextAction {
  switch (type) {
    case 'hybrid_validated_trend': return 'generate_package'
    case 'web_validated_opportunity': return evidenceStrength === 'medium' || evidenceStrength === 'strong' ? 'generate_package' : 'deep_refresh'
    case 'video_inspiration': return 'open_similar_videos'
    case 'research_required': return evidenceStrength === 'none' ? 'refine_topic' : 'deep_refresh'
    case 'polluted_candidate': return 'reject'
  }
}

function buildCTAs(type: TrustDecisionType, evidenceStrength: EvidenceStrength): {
  cta_primary: { text: string; action: string }
  cta_secondary?: { text: string; action: string }
} {
  switch (type) {
    case 'hybrid_validated_trend':
      return {
        cta_primary: { text: 'Videócsomag generálása', action: 'video_package' },
        cta_secondary: { text: 'Hasonló videók ellenőrzése', action: 'similar_videos' },
      }
    case 'web_validated_opportunity':
      return {
        cta_primary: { text: evidenceStrength === 'weak' ? 'Mélyebb validálás' : 'Teszt videócsomag', action: evidenceStrength === 'weak' ? 'search_more' : 'video_package' },
        cta_secondary: { text: 'Hasonló videók keresése', action: 'similar_videos' },
      }
    case 'video_inspiration':
      return {
        cta_primary: { text: 'Hasonló videók megnyitása', action: 'similar_videos' },
        cta_secondary: { text: 'Webes források keresése', action: 'web_search' },
      }
    case 'research_required':
      return {
        cta_primary: { text: 'Téma szűkítése', action: 'search_more' },
        cta_secondary: { text: 'Hasonló videók keresése', action: 'similar_videos' },
      }
    case 'polluted_candidate':
      return {
        cta_primary: { text: 'Mutass másik témát', action: 'replace' },
      }
  }
}
