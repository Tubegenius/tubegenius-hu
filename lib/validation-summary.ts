// lib/validation-summary.ts
// WillViral — Opportunity Validation Summary
// Web + Video + Content Gap + Freshness alapú validáció

export type ValidationType =
  | 'web_validated_opportunity'
  | 'video_validated_trend'
  | 'hybrid_validated_trend'
  | 'research_required'
  | 'polluted_candidate'

export type FinalDecision = 'make_now' | 'early_opportunity' | 'validate_more' | 'reject'

export interface ValidationSummary {
  validation_type: ValidationType
  web_validation_score: number
  video_validation_score: number
  content_gap_score: number
  freshness_score: number
  topic_consistency_score: number
  final_decision: FinalDecision
  explanation: string
  label: string
  cta_primary: { text: string; action: string }
  cta_secondary?: { text: string; action: string }
}

interface ValidationInput {
  web_source_count: number
  video_source_count: number
  topic_consistency_score: number
  freshness_score: number
  trend_source_type: string
  confidence: string
  opportunity_score: number
  content_gap_score: number
}

function buildExplanation(webCount: number, videoCount: number, webScore: number, videoScore: number): string {
  const webStrong = webScore >= 60 && webCount > 0
  const videoStrong = videoScore >= 60 && videoCount > 0

  if (webStrong && videoStrong) {
    return 'Konkret webes forrasok es relevans videok is ugyanazt a temat tamasztjak ala.'
  }
  if (webStrong && !videoStrong && videoCount > 0) {
    return 'A tema konkret webes forrasok alapjan alatamasztott, de a videos bizonyitek meg gyenge.'
  }
  if (webStrong && videoCount === 0) {
    return 'A tema konkret webes forras alapjan aktualis, de YouTube-on meg nem talaltunk relevans bizonyitek videot.'
  }
  if (!webStrong && videoStrong) {
    return 'A videos jelek alapjan van aktivitas, de konkret webes forrasbol meg gyenge az alatamasztas.'
  }
  if (webCount > 0 && !webStrong) {
    return 'Talaltunk webes forrasokat, de nem eleg konkrettek a tema kozvetlen alatamasztasahoz. Tovabbi forraskereses javasolt.'
  }
  return 'Nincs eleg konkret bizonyitek. Tovabbi forraskereses szukseges.'
}

function buildLabel(webCount: number, videoCount: number, validationType: ValidationType): string {
  if (validationType === 'hybrid_validated_trend') return 'Erosen validalt trend'
  if (validationType === 'polluted_candidate') return 'Kiszurve — forraskeveredés'
  if (validationType === 'research_required') return 'Kutatas kell'
  if (webCount > 0 && videoCount === 0) return 'Korai webes lehetoseg'
  if (webCount === 0 && videoCount > 0) return 'Videos trend'
  return 'Korai lehetoseg'
}

export function buildValidationSummary(input: ValidationInput): ValidationSummary {
  const webScore = Math.min(100, input.web_source_count * 35)
  const videoScore = Math.min(100, input.video_source_count * 25)
  const gapScore = input.content_gap_score || 0
  const freshness = input.freshness_score || 0
  const consistency = input.topic_consistency_score || 80

  // Polluted check
  if (consistency < 40) {
    return {
      validation_type: 'polluted_candidate',
      web_validation_score: webScore,
      video_validation_score: videoScore,
      content_gap_score: gapScore,
      freshness_score: freshness,
      topic_consistency_score: consistency,
      final_decision: 'reject',
      explanation: 'A talalatok nem ugyanarra a konkret temara vonatkoznak.',
      label: 'Kiszurve — forraskeveredés',
      cta_primary: { text: 'Mutass masik temat', action: 'replace' },
    }
  }

  // Hybrid validated
  if (webScore >= 70 && videoScore >= 70) {
    return {
      validation_type: 'hybrid_validated_trend',
      web_validation_score: webScore,
      video_validation_score: videoScore,
      content_gap_score: gapScore,
      freshness_score: freshness,
      topic_consistency_score: consistency,
      final_decision: 'make_now',
      explanation: buildExplanation(input.web_source_count, input.video_source_count, webScore, videoScore),
      label: buildLabel(input.web_source_count, input.video_source_count, 'hybrid_validated_trend'),
      cta_primary: { text: 'Videocsomag generalasa', action: 'video_package' },
      cta_secondary: { text: 'Piaci bizonyitekok megnyitasa', action: 'similar_videos' },
    }
  }

  // Web validated opportunity
  if (webScore >= 35 && videoScore < 50) {
    return {
      validation_type: 'web_validated_opportunity',
      web_validation_score: webScore,
      video_validation_score: videoScore,
      content_gap_score: gapScore,
      freshness_score: freshness,
      topic_consistency_score: consistency,
      final_decision: 'early_opportunity',
      explanation: buildExplanation(input.web_source_count, input.video_source_count, webScore, videoScore),
      label: buildLabel(input.web_source_count, input.video_source_count, 'web_validated_opportunity'),
      cta_primary: { text: 'Keszits teszt videocsomagot', action: 'video_package' },
      cta_secondary: { text: 'Keress hasonlo videokat', action: 'similar_videos' },
    }
  }

  // Video validated
  if (videoScore >= 50 && webScore < 35) {
    return {
      validation_type: 'video_validated_trend',
      web_validation_score: webScore,
      video_validation_score: videoScore,
      content_gap_score: gapScore,
      freshness_score: freshness,
      topic_consistency_score: consistency,
      final_decision: input.opportunity_score >= 65 ? 'make_now' : 'validate_more',
      explanation: buildExplanation(input.web_source_count, input.video_source_count, webScore, videoScore),
      label: buildLabel(input.web_source_count, input.video_source_count, 'video_validated_trend'),
      cta_primary: { text: 'Videocsomag generalasa', action: 'video_package' },
      cta_secondary: { text: 'Webes forrasok keresese', action: 'web_search' },
    }
  }

  // Research required
  return {
    validation_type: 'research_required',
    web_validation_score: webScore,
    video_validation_score: videoScore,
    content_gap_score: gapScore,
    freshness_score: freshness,
    topic_consistency_score: consistency,
    final_decision: 'validate_more',
    explanation: buildExplanation(input.web_source_count, input.video_source_count, webScore, videoScore),
    label: buildLabel(input.web_source_count, input.video_source_count, 'research_required'),
    cta_primary: { text: 'Tovabbi forrasok keresese', action: 'search_more' },
    cta_secondary: { text: 'Piaci bizonyitekok keresese', action: 'similar_videos' },
  }
}
