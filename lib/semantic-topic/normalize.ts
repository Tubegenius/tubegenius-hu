// Semantic Topic Identity v0 -- S3A-v2. Deterministic evidence normalization.
//
// Fixed field order, whitespace-collapsed, no locale-dependent formatting --
// the same evidence content always produces the exact same normalized text,
// which is what normalized_input_digest (digest.ts) hashes. Changing this
// function changes normalized_input_digest for every evidence item, which
// is a real behavioral change (it invalidates the completed-cache key), not
// a cosmetic one -- treat edits here like a schema change. This is exactly
// why publishedAt is now canonicalized (see below): SEMANTIC_TOPIC_NORMALIZATION_VERSION
// was bumped 1 -> 2 in extraction-config.ts to mark that change as
// versioned, not silent.
import { canonicalizeTimestamp } from './canonical-timestamp'

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
  // v2: canonicalized (fixed YYYY-MM-DDTHH:mm:ss.sssZ, UTC, millisecond-
  // truncated) rather than embedded as whatever raw string the caller's
  // data source happened to produce -- see canonical-timestamp.ts header
  // for why this was a real cross-caller digest-collision risk, not a
  // cosmetic one. Fails closed (throws) on an unparseable value rather
  // than silently embedding a string that can't be proven canonical.
  const canonicalPublishedAt = canonicalizeTimestamp(evidence.publishedAt)
  if (canonicalPublishedAt) {
    lines.push(`published_at: ${canonicalPublishedAt}`)
  }
  if (evidence.canonicalUrl && evidence.canonicalUrl.trim()) {
    lines.push(`canonical_url: ${evidence.canonicalUrl.trim()}`)
  }
  return lines.join('\n')
}
