// lib/creator-focus/fingerprint.ts
// Creator Intelligence 2B -- the VERSIONED, STRICT value identity of a focus value and of a stored suggestion.
//
// WHY STRICT: a decision (a confirmation, a dismissal) is about THIS value. The 2A topic-fit rule and the adapter's
// suggestion matching use the lossy `identityKey` (lower case, accents and punctuation removed, everything that is
// not a-z / 0-9 dropped): that is right for deciding whether a topic fits, and WRONG for deciding that two values are
// the same decision subject (it maps `日本料理 ramen` and `ramen`, `Łódź` and `odz`, `Straße` and `Stra e` to the same
// key). The decision identity therefore does NOT use it. The 2A fit rule is unchanged.
//
// THE v1 CANONICAL FORM (frozen; v1 was corrected before any durable 2B data existed): the value the adapter would hold
// as a claim (`cleanText`: whitespace runs collapsed to one space, trimmed, length limits), then Unicode NFC. Nothing
// else is folded: case, accents, punctuation, scripts, zero-width characters and emoji all stay, so two different
// strings stay two different values. Equal under the form: strings that differ only in whitespace runs or in
// canonically equivalent Unicode (NFC vs NFD). A string with a lone (unpaired) surrogate has no fingerprint, because
// UTF-8 encoding would turn every lone surrogate into the same replacement character and make different strings
// collide.
//   value        sha256("cf-fp-v1\n" + field + "\n" + canonicalValue)
//   suggestion   sha256("cf-fp-v1\nsuggestion\n" + main_category + "\n" + canonicalFocus)
// (the canonical values never contain a newline, and the tokens before them are fixed or from a fixed list, so the
// parts cannot be shifted into each other).
//
// CONSEQUENCES (a product trade-off, stated in docs/architecture/creator-focus-2b.md): a dismissed suggestion that is
// regenerated with a different case or punctuation is a DIFFERENT suggestion and shows up again; a confirmation needs
// the profile to hold the suggestion's exact text.
//
// VERSIONING RULE: a fingerprint is only meaningful together with the version that produced it. The canonical form of
// a version is FROZEN; any change is a NEW version. An event that NEEDS a value identity (confirm, dismiss,
// withdraw(dismissal)) and has a version this code does not know is INERT in the read model (never honoured, never
// reinterpreted; it does not disable the layer). `withdraw(confirmation)` carries no fingerprint and keeps working
// whatever its version (making a withdrawal inert would revive an earlier confirmation). The structural validator of
// the events still expects a 64-hex fingerprint, so a future version with another format needs a validator change.
//
// A HASH IS NOT ANONYMOUS: short, low-entropy focus texts can be recovered by a dictionary attack. The fingerprint is
// pseudonymous data about the creator, not anonymised data.
import { FOCUS_LIMITS, MAIN_CATEGORY_VALUES } from './contract'
import type { DecisionField } from './decision-contract'
import { sha256Hex } from './sha256'
import { cleanText } from './text'

export const FINGERPRINT_VERSION = 1 as const
export const SUPPORTED_FINGERPRINT_VERSIONS: readonly number[] = Object.freeze([1])

export function isSupportedFingerprintVersion(version: unknown): version is 1 {
  return typeof version === 'number' && SUPPORTED_FINGERPRINT_VERSIONS.includes(version)
}

/**
 * The value as the adapter would hold it as a claim: the cleaned focus text (at least min_focus_chars), or a
 * recognised category other than `other`. Anything else has no decision-relevant value.
 */
export function normalizeDecisionValue(field: DecisionField, raw: unknown): string | null {
  if (field === 'specific_focus') return cleanText(raw, FOCUS_LIMITS.min_focus_chars)
  if (field === 'main_category') return typeof raw === 'string' && MAIN_CATEGORY_VALUES.includes(raw) && raw !== 'other' ? raw : null
  return null
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
      else return true
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

/** the strict canonical text of an already cleaned value: NFC, or null when it cannot be bound */
function canonicalText(cleaned: string): string | null {
  if (hasLoneSurrogate(cleaned)) return null
  const nfc = cleaned.normalize('NFC')
  return nfc.length === 0 ? null : nfc
}

/** v1: sha256("cf-fp-v1\n" + field + "\n" + NFC(cleaned value)) as lower-case hex; null when there is nothing to bind. */
export function focusValueFingerprint(field: DecisionField, value: unknown, version: number = FINGERPRINT_VERSION): string | null {
  if (!isSupportedFingerprintVersion(version)) return null
  if (field !== 'specific_focus' && field !== 'main_category') return null
  const normalized = normalizeDecisionValue(field, value)
  if (normalized === null) return null
  const canonical = canonicalText(normalized)
  if (canonical === null) return null
  return sha256Hex(`cf-fp-v1\n${field}\n${canonical}`)
}

/**
 * v1: sha256("cf-fp-v1\nsuggestion\n" + main_category + "\n" + NFC(cleaned focus)). The category is compared exactly,
 * as the adapter does when it pairs a category with a stored suggestion; the focus is compared strictly.
 */
export function focusSuggestionFingerprint(
  suggestion: { main_category: unknown; specific_focus: unknown },
  version: number = FINGERPRINT_VERSION,
): string | null {
  if (!isSupportedFingerprintVersion(version)) return null
  const focus = cleanText(suggestion.specific_focus, FOCUS_LIMITS.min_focus_chars)
  const category = suggestion.main_category
  if (focus === null || typeof category !== 'string' || !MAIN_CATEGORY_VALUES.includes(category)) return null
  const canonical = canonicalText(focus)
  if (canonical === null) return null
  return sha256Hex(`cf-fp-v1\nsuggestion\n${category}\n${canonical}`)
}
