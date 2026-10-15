// lib/creator-focus/text.ts
// Small pure text helpers shared by the adapter, the transitions and the fit assessment.
import { sharedPrefixLength, tokenize } from '@/lib/niche-relevance'
import { FOCUS_LIMITS } from './contract'

/** A trimmed, whitespace-collapsed string within the length limits, or null. Never throws. */
export function cleanText(value: unknown, minChars = 1, maxChars: number = FOCUS_LIMITS.max_text_chars): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length < minChars || text.length > maxChars) return null
  return text
}

/** Accent-, case- and punctuation-insensitive identity key (for exact "is it the same text" decisions). */
export function identityKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Terms of a text: normalised tokens of at least three characters (the shared tokenizer drops stopwords). */
export function termsOf(text: string): string[] {
  const seen = new Set<string>()
  for (const token of tokenize(text)) if (token.length >= 3) seen.add(token)
  return [...seen].sort()
}

/**
 * Same rule as the existing relevance gate (lib/niche-relevance.ts): an exact word, or a shared prefix of at
 * least five characters between words that are both at least five characters long.
 */
export function termsMatch(a: string, b: string): boolean {
  if (a === b) return true
  return a.length >= 5 && b.length >= 5 && sharedPrefixLength(a, b) >= 5
}
