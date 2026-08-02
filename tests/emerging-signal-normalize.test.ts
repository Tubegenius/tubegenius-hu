import { describe, expect, it } from 'vitest'
import { normalizeText, isBlank, normalizeCanonicalUrl, extractDomain, safeParseDate } from '@/lib/emerging-signal/normalize'

describe('emerging-signal normalize', () => {
  it('lowercases, strips diacritics, collapses whitespace', () => {
    expect(normalizeText('  Ékezetes   Szöveg!!  ')).toBe('ekezetes szoveg')
  })

  it('is case/diacritic/whitespace insensitive between equivalent inputs', () => {
    expect(normalizeText('OpenAI GPT-6')).toBe(normalizeText('openai   gpt-6'))
    expect(normalizeText('Piramis')).toBe(normalizeText('piramis'))
  })

  it('isBlank treats null/undefined/whitespace-only as blank', () => {
    expect(isBlank(null)).toBe(true)
    expect(isBlank(undefined)).toBe(true)
    expect(isBlank('   ')).toBe(true)
    expect(isBlank('x')).toBe(false)
  })

  describe('normalizeCanonicalUrl', () => {
    it('strips www, lowercases host, drops trailing slash, query and fragment', () => {
      expect(normalizeCanonicalUrl('https://WWW.Example.com/Article/1/?utm=abc#frag')).toBe('https://example.com/Article/1')
    })
    it('returns null for non-http(s) protocols', () => {
      expect(normalizeCanonicalUrl('ftp://example.com/a')).toBeNull()
    })
    it('returns null for unparseable input', () => {
      expect(normalizeCanonicalUrl('not a url')).toBeNull()
      expect(normalizeCanonicalUrl(null)).toBeNull()
      expect(normalizeCanonicalUrl('')).toBeNull()
    })
    it('root path normalizes to /', () => {
      expect(normalizeCanonicalUrl('https://example.com')).toBe('https://example.com/')
    })
  })

  describe('extractDomain', () => {
    it('strips www and lowercases', () => {
      expect(extractDomain('https://WWW.Example.COM/a/b')).toBe('example.com')
    })
    it('returns null for invalid url', () => {
      expect(extractDomain('not a url')).toBeNull()
    })
  })

  describe('safeParseDate', () => {
    it('accepts a valid ISO date', () => {
      expect(safeParseDate('2026-08-01T00:00:00.000Z')).toBe('2026-08-01T00:00:00.000Z')
    })
    it('rejects fuzzy relative-date text ("2 days ago") without fabricating a timestamp', () => {
      expect(safeParseDate('2 days ago')).toBeNull()
    })
    it('rejects blank/missing input', () => {
      expect(safeParseDate(null)).toBeNull()
      expect(safeParseDate('')).toBeNull()
    })
  })
})
