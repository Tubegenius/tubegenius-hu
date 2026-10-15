// lib/editing-pattern/audit-evidence-basis.ts
// The existing Video Audit is METADATA-based: YouTube API fields (title, description, duration, statistics,
// tags, the existence of a thumbnail URL) or user-reported metrics, scored by lib/video-audit-scoring.ts and
// interpreted in words by a language model that only receives the title, the topic and the backend scores.
// It has never looked at a frame. This module makes that machine-readable and gives the prompt a guard, so
// neither the response nor the text of the interpretation can pass for a frame- or cut-based analysis.
// (The real frame/cut analysis is the separate EditingAnalysis contract in ./contract.ts.)

export interface AuditEvidenceBasis {
  kind: 'metadata_only'
  frame_analysis_performed: false
  /** an EditingAnalysis result is not attached to this audit */
  editing_analysis_available: false
  /** what the audit actually used */
  basis_fields: string[]
  note_hu: string
}

export function buildAuditEvidenceBasis(input: { hasApiData: boolean; hasBehavioralMetrics: boolean }): AuditEvidenceBasis {
  const basis_fields = input.hasApiData
    ? ['title', 'description', 'duration', 'public_statistics', 'tags', 'thumbnail_url_presence']
    : ['user_reported_title_topic_duration', 'user_reported_engagement_metrics']
  if (input.hasBehavioralMetrics) basis_fields.push('user_reported_completion_or_watch_time')
  basis_fields.push('language_model_interpretation_of_title_topic_and_backend_scores')
  return {
    kind: 'metadata_only',
    frame_analysis_performed: false,
    editing_analysis_available: false,
    basis_fields,
    note_hu: 'Az audit a videó metaadataira (cím, leírás, hossz, statisztikák) és a megadott mutatókra épül. Képkocka- vagy vágásalapú elemzés nem történt.',
  }
}

/** Appended to the interpretation prompt. */
export const AUDIT_EVIDENCE_PROMPT_GUARD_HU = [
  'BIZONYÍTÉK-KORLÁT - KÖTELEZŐ:',
  '- Csak a címet, a témát és a backend score-okat kaptad. A videó képkockáit, vágásait, hangját, tempóját NEM láttad.',
  '- Ne állíts semmit a vágásról, a jelenetekről, a képi megvalósításról vagy a videó látható tartalmáról.',
  '- Ha ilyesmit javaslasz, jelezd, hogy az feltételezés a metaadatok alapján, nem megfigyelés.',
].join('\n')

const FRAME_CLAIM_PATTERNS: readonly RegExp[] = [
  /képkock/i,
  /\bframe/i,
  /vágás/i,
  /vágott/i,
  /jelenetváltás/i,
  /snitt/i,
  /kameramozgás/i,
  /a videóban látható/i,
  /képi (megvalósítás|elemzés)/i,
]

/** Phrases that would claim a frame/cut-level observation. Used by tests and available to a response-level check. */
export function findFrameAnalysisClaims(text: string): string[] {
  return FRAME_CLAIM_PATTERNS.filter((re) => re.test(text)).map((re) => re.source)
}
