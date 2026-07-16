import { describe, expect, it } from 'vitest'
import { validateRelatedKeywordSuggestions } from '@/lib/keyword-research'

const suggestion = (index: number) => ({
  keyword: `konkrét kulcsszó ${index}`,
  angle: `Feldolgozási szög ${index}`,
  content_format_hint: 'how-to',
})

describe('keyword research output integrity', () => {
  it('accepts a bounded, unique keyword cluster', () => {
    expect(validateRelatedKeywordSuggestions(Array.from({ length: 8 }, (_, i) => suggestion(i)))).toHaveLength(8)
  })

  it('rejects undersized and duplicate AI output', () => {
    expect(() => validateRelatedKeywordSuggestions([suggestion(1)])).toThrow()
    expect(() => validateRelatedKeywordSuggestions(Array.from({ length: 8 }, () => suggestion(1)))).toThrow()
  })

  it('rejects missing and oversized fields', () => {
    const rows = Array.from({ length: 8 }, (_, i) => suggestion(i))
    rows[2] = { ...rows[2], angle: 'x'.repeat(501) }
    expect(() => validateRelatedKeywordSuggestions(rows)).toThrow()
  })
})
