// Semantic Topic Identity v0 -- S3A. Deterministic evidence normalization.
//
// Fixed field order, whitespace-collapsed, no locale-dependent formatting --
// the same evidence content always produces the exact same normalized text,
// which is what normalized_input_digest (digest.ts) hashes. Changing this
// function changes normalized_input_digest for every evidence item, which
// is a real behavioral change (it invalidates the completed-cache key), not
// a cosmetic one -- treat edits here like a schema change.
export interface EvidenceForExtraction {
  title: string
  snippet: string | null
  canonicalUrl: string | null
  publishedAt: string | null
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function buildNormalizedExtractionInput(evidence: EvidenceForExtraction): string {
  const lines: string[] = [`title: ${collapseWhitespace(evidence.title)}`]
  if (evidence.snippet && evidence.snippet.trim()) {
    lines.push(`snippet: ${collapseWhitespace(evidence.snippet)}`)
  }
  if (evidence.publishedAt) {
    lines.push(`published_at: ${evidence.publishedAt}`)
  }
  if (evidence.canonicalUrl && evidence.canonicalUrl.trim()) {
    lines.push(`canonical_url: ${evidence.canonicalUrl.trim()}`)
  }
  return lines.join('\n')
}
