// lib/search/validate-focus.ts
// WillViral — Élő validáció a "Specifikus fókusz" mezőre.
// Nem blokkol agresszívan, csak jelez, ha a fókusz valószínűleg túl tág
// ahhoz, hogy jó minőségű, konkrét trend candidate-eket adjon.

const GENERIC_WORDS = [
  'tudomány', 'egészség', 'hírek', 'tech', 'technológia', 'ai',
  'pénz', 'sport', 'érdekességek', 'trendek', 'trend',
  'science', 'health', 'news', 'facts', 'interesting', 'weird',
  'technology', 'viral', 'trending', 'latest news', 'current events',
]

export interface FocusValidationResult {
  status: 'empty' | 'too_broad' | 'ok'
  message: string
}

export function validateSpecificFocus(focus: string): FocusValidationResult {
  const trimmed = focus.trim()

  if (!trimmed) {
    return { status: 'empty', message: 'A specifikus fókusz kötelező.' }
  }

  const commaCount = (trimmed.match(/,/g) || []).length
  const words = trimmed.split(/\s+/).filter(Boolean)
  const lower = trimmed.toLowerCase()

  const isSingleGenericWord = words.length === 1 && GENERIC_WORDS.includes(lower)
  const isGenericWordOnly = GENERIC_WORDS.some(g => lower === g)
  const tooManyCommas = commaCount > 1
  const tooLong = words.length > 12

  if (isSingleGenericWord || isGenericWordOnly || tooManyCommas || tooLong) {
    return {
      status: 'too_broad',
      message: 'Ez túl tág keresés. Válassz egy konkrét fókuszt, különben gyengébb ajánlásokat kapsz.',
    }
  }

  return { status: 'ok', message: 'Jó fókusz. A Videólehetőségek pontosabb témákat tud keresni.' }
}
