// Creator Intelligence 2B: the pure SHA-256 and the VERSIONED, STRICT focus / suggestion fingerprint. DB-free.
//  * sha256Hex equals node:crypto on every padding boundary and on multi-byte text
//  * the v1 fingerprint is FROZEN (golden vectors computed independently with node:crypto)
//  * the decision identity is a strict, Unicode-preserving value identity: it does NOT use the lossy 2A identityKey
//    (that rule stays untouched and is only for topic fit); values that identityKey collapses stay distinct here
//  * an unknown version, an invalid value or a lone surrogate has NO fingerprint
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FINGERPRINT_VERSION,
  SUPPORTED_FINGERPRINT_VERSIONS,
  focusSuggestionFingerprint,
  focusValueFingerprint,
  isSupportedFingerprintVersion,
  normalizeDecisionValue,
  sha256Hex,
} from '@/lib/creator-focus'
import { identityKey } from '@/lib/creator-focus/text'

const reference = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const focusFp = (text: string) => focusValueFingerprint('specific_focus', text)
const sourceCode = (file: string) =>
  readFileSync(join(process.cwd(), 'lib', 'creator-focus', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')

describe('sha256Hex equals node:crypto', () => {
  it('known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it.each([0, 1, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 191, 192, 1000, 5000])('padding boundary: %i ASCII characters', (n) => {
    const text = 'a'.repeat(n)
    expect(sha256Hex(text)).toBe(reference(text))
  })

  it('multi-byte text: accents, double accents, CJK, emoji, a lone surrogate', () => {
    for (const text of ['otthoni edzés kezdőknek', 'ŐŰ őű', '日本語の動画', 'ПРИВЕТ мир', '🏋️ edzés 🍳', 'a\ud800b', 'é'.repeat(100)]) {
      expect(sha256Hex(text)).toBe(reference(text))
    }
  })

  it('a few hundred deterministic pseudo-random strings', () => {
    let state = 12345
    const next = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state }
    const alphabet = 'abcdefghijklmnopqrstuvwxyzáéíóöőúüűÁÉ0123456789 \n,.-_'
    for (let i = 0; i < 300; i++) {
      const length = next() % 200
      let text = ''
      for (let j = 0; j < length; j++) text += alphabet[next() % alphabet.length]
      expect(sha256Hex(text)).toBe(reference(text))
    }
  })
})

describe('the v1 fingerprint is frozen (golden vectors, computed independently with node:crypto)', () => {
  it('a focus value', () => {
    expect(focusFp('otthoni edzés kezdőknek')).toBe('00b96ff08d4c8cdd982bec45224075e634c5cb9c290842dd1283fd547e6e1fc9')
    expect(focusFp('főzés gyorsan')).toBe('b6a4d8e589173a8b560f5f5bf46032e70d0e6152a4b7cfb8d3d1cca91df11865')
  })

  it('a value written in a script without Latin letters now has a fingerprint', () => {
    expect(focusFp('日本語の動画')).toBe('9bb0c27d1850873633cea135f23c5509a7f8f9025c5b83828a059f42fed27a1d')
  })

  it('a category', () => {
    expect(focusValueFingerprint('main_category', 'health')).toBe('1833441d68957431f8595ef58b06c020aacbc89da951315f3a7adaa5d11b462d')
    expect(focusValueFingerprint('main_category', 'tech_ai')).toBe('78674c89ec3302a6e1365c4aa15cf23910ced02449994a1b4511113b7242b26c')
  })

  it('the field name is part of the fingerprint: the same words as a focus and as a category differ', () => {
    expect(focusFp('health')).toBe('3defc1712da4e25678ca89b18ae863313d4c4ef6a9be25077e2962afc2ef1b0a')
    expect(focusFp('health')).not.toBe(focusValueFingerprint('main_category', 'health'))
  })

  it('a suggestion: the exact category and the strict focus', () => {
    expect(focusSuggestionFingerprint({ main_category: 'health', specific_focus: 'otthoni edzés kezdőknek' })).toBe('08686ed891f9cd4ae68d87abfe60d9370f3dccdc6c9bb273e363790d1ca6246e')
    expect(focusSuggestionFingerprint({ main_category: 'lifestyle', specific_focus: 'otthoni edzés kezdőknek' })).toBe('4626c72c5947ee79b2b4d26bde1f9268c27c91b5053aa0018f0a69118f8aa530')
  })

  it('the version is 1 and the canonical templates are frozen in the source (and the lossy key is not used)', () => {
    expect(FINGERPRINT_VERSION).toBe(1)
    expect([...SUPPORTED_FINGERPRINT_VERSIONS]).toEqual([1])
    const code = sourceCode('fingerprint.ts')
    expect(code).toContain('`cf-fp-v1\\n${field}\\n${canonical}`')
    expect(code).toContain('`cf-fp-v1\\nsuggestion\\n${category}\\n${canonical}`')
    expect(code).not.toContain('identityKey')
    expect(code).not.toContain('toLowerCase')
    expect(code).toContain(".normalize('NFC')")
  })
})

describe('what the strict identity treats as the SAME value', () => {
  const base = focusFp('otthoni edzés kezdőknek')

  it.each([
    ['extra spaces around and inside', '  otthoni   edzés  kezdőknek '],
    ['tabs and newlines instead of spaces', 'otthoni\tedzés\nkezdőknek'],
    ['a no-break space instead of a space', 'otthoni edzés kezdőknek'],
    ['decomposed Unicode (NFD)', 'otthoni edzés kezdőknek'],
  ])('is the same fingerprint for: %s', (_name, text) => {
    expect(focusFp(text)).toBe(base)
  })

  it('is deterministic', () => {
    expect(focusFp('otthoni edzés kezdőknek')).toBe(focusFp('otthoni edzés kezdőknek'))
  })

  it('a suggestion: whitespace and NFD only', () => {
    const a = focusSuggestionFingerprint({ main_category: 'health', specific_focus: '  otthoni   edzés kezdőknek ' })
    expect(a).toBe(focusSuggestionFingerprint({ main_category: 'health', specific_focus: 'otthoni edzés kezdőknek' }))
    expect(a).not.toBe(focusSuggestionFingerprint({ main_category: 'lifestyle', specific_focus: 'otthoni edzés kezdőknek' }))
  })
})

describe('what the strict identity keeps DISTINCT (and the lossy 2A identityKey would merge)', () => {
  it.each([
    ['upper case', 'OTTHONI EDZÉS KEZDŐKNEK'],
    ['no accents', 'otthoni edzes kezdoknek'],
    ['punctuation', 'otthoni edzés, kezdőknek!'],
  ])('the 2A key merges it, the decision identity does not: %s', (_name, text) => {
    expect(identityKey(text)).toBe(identityKey('otthoni edzés kezdőknek'))
    expect(focusFp(text)).not.toBe(focusFp('otthoni edzés kezdőknek'))
  })

  it('a different word is different under both', () => {
    expect(identityKey('otthoni edzés haladóknak')).not.toBe(identityKey('otthoni edzés kezdőknek'))
    expect(focusFp('otthoni edzés haladóknak')).not.toBe(focusFp('otthoni edzés kezdőknek'))
  })

  // the pairs from the review: each pair/triple has one lossy 2A key but different words
  const collapsing: string[][] = [
    ['日本料理 ramen', '韓国料理 ramen', 'ramen'],
    ['Łódź', 'odz'],
    ['Straße', 'Stra e'],
    ['Đà Nẵng', 'A Nang'],
    ['ıstanbul séta', 'istanbul séta'],
    ['æsthetic vlog', 'aesthetic vlog'],
    ['ﬁlm kritika', 'film kritika'],
  ]
  it.each(collapsing)('%s / %s: distinct strict fingerprints', (...group) => {
    const fingerprints = group.map(text => focusFp(text))
    for (const fp of fingerprints) expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(fingerprints).size).toBe(group.length)
    const suggestions = group.map(focus => focusSuggestionFingerprint({ main_category: 'lifestyle', specific_focus: focus }))
    expect(new Set(suggestions).size).toBe(group.length)
  })

  it('the review examples really are collapsed by the 2A key (so the test is not vacuous)', () => {
    expect(identityKey('日本料理 ramen')).toBe(identityKey('ramen'))
    expect(identityKey('韓国料理 ramen')).toBe(identityKey('ramen'))
    expect(identityKey('Łódź')).toBe(identityKey('odz'))
    expect(identityKey('Straße')).toBe(identityKey('Stra e'))
    expect(identityKey('Đà Nẵng')).toBe(identityKey('A Nang'))
  })

  it('golden vectors of the non-Latin triple', () => {
    expect(focusFp('日本料理 ramen')).toBe('e247742f026ebe56a7ddd6599ad01f6ffaf0c802419bd8d153de4328c209f88e')
    expect(focusFp('韓国料理 ramen')).toBe('0b27feb81286c38949903e7b9d06b3c94a72fd239c78e9eadbe10615a18cd05b')
    expect(focusFp('ramen')).toBe('988c0b83b9b2d2d4d03a9ec9a5a572c66c6c9d1b7438a7e53dd897e98455dc0b')
  })

  it('zero-width characters and emoji stay part of the value', () => {
    expect(focusFp('otthoni​edzés kezdőknek')).not.toBe(focusFp('otthoni edzés kezdőknek'))
    expect(focusFp('otthoni edzés 🏋️')).not.toBe(focusFp('otthoni edzés'))
    expect(focusFp('otthoni edzés 🏋️')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a value of punctuation only is now a (strict) value; it is the 2A topic-fit rule that ignores it', () => {
    expect(focusFp('!!! ???')).toMatch(/^[0-9a-f]{64}$/)
    expect(focusFp('!!! ???')).not.toBe(focusFp('??? !!!'))
  })
})

describe('what has NO fingerprint (null): nothing is bound silently', () => {
  it('an unknown version', () => {
    for (const version of [0, 2, 3, -1, 1.5, Number.NaN, Infinity]) {
      expect(focusValueFingerprint('specific_focus', 'otthoni edzés kezdőknek', version)).toBeNull()
      expect(focusSuggestionFingerprint({ main_category: 'health', specific_focus: 'otthoni edzés kezdőknek' }, version)).toBeNull()
    }
    expect(isSupportedFingerprintVersion(1)).toBe(true)
    expect(isSupportedFingerprintVersion(2)).toBe(false)
    expect(isSupportedFingerprintVersion('1')).toBe(false)
  })

  it('an invalid field, a non-string, a too-short focus, an unknown or `other` category', () => {
    expect(focusValueFingerprint('audience' as never, 'kezdők')).toBeNull()
    expect(focusValueFingerprint('specific_focus', 42)).toBeNull()
    expect(focusValueFingerprint('specific_focus', null)).toBeNull()
    expect(focusValueFingerprint('specific_focus', 'ab')).toBeNull()
    expect(focusValueFingerprint('specific_focus', 'x'.repeat(301))).toBeNull()
    expect(focusValueFingerprint('main_category', 'other')).toBeNull()
    expect(focusValueFingerprint('main_category', 'not_a_category')).toBeNull()
  })

  it('a lone surrogate: UTF-8 would turn every one into the same replacement character and merge different values', () => {
    expect(focusFp('otthoni \ud800 edzés')).toBeNull()
    expect(focusFp('otthoni \udc00 edzés')).toBeNull()
    expect(focusFp('otthoni \ud800')).toBeNull()
    expect(focusSuggestionFingerprint({ main_category: 'health', specific_focus: 'otthoni \ud800 edzés' })).toBeNull()
    // a proper surrogate pair is fine
    expect(focusFp('otthoni 🏋 edzés')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a suggestion with an invalid category or a missing part', () => {
    expect(focusSuggestionFingerprint({ main_category: 'nope', specific_focus: 'otthoni edzés kezdőknek' })).toBeNull()
    expect(focusSuggestionFingerprint({ main_category: 'health', specific_focus: 'ab' })).toBeNull()
    expect(focusSuggestionFingerprint({ main_category: 7, specific_focus: 'otthoni edzés kezdőknek' })).toBeNull()
  })

  it('normalizeDecisionValue is what the adapter holds as a claim', () => {
    expect(normalizeDecisionValue('specific_focus', '  otthoni   edzés  kezdőknek ')).toBe('otthoni edzés kezdőknek')
    expect(normalizeDecisionValue('main_category', 'health')).toBe('health')
    expect(normalizeDecisionValue('main_category', 'other')).toBeNull()
    expect(normalizeDecisionValue('specific_focus', 'ab')).toBeNull()
  })
})
