import { describe, expect, it } from 'vitest'
import { normalizeNicheCandidates } from '@/lib/channel-niche-discovery'

describe('channel niche candidate validation', () => {
  it('deduplicates and orders valid candidates by confidence', () => {
    const candidates = normalizeNicheCandidates([
      { main_category: 'science', specific_focus: 'Űrkutatás érthetően', confidence: 0.6, rationale: 'Több cím is űrkutatási témát dolgoz fel.' },
      { main_category: 'tech_ai', specific_focus: 'Gyakorlati AI eszközök', confidence: 0.9, rationale: 'A videócímek többsége AI eszközökre fókuszál.' },
      { main_category: 'science', specific_focus: '  űrkutatás   érthetően ', confidence: 0.4, rationale: 'Ez ugyanannak a témának egy ismétlése.' },
    ])
    expect(candidates).toHaveLength(2)
    expect(candidates[0].main_category).toBe('tech_ai')
    expect(candidates[1].specific_focus).toBe('Űrkutatás érthetően')
  })

  it('rejects invented categories and invalid confidence instead of repairing claims', () => {
    expect(() => normalizeNicheCandidates([
      { main_category: 'invented', specific_focus: 'Érvényesnek tűnő fókusz', confidence: 0.8, rationale: 'Elég hosszú, de hibás kategóriájú indoklás.' },
      { main_category: 'science', specific_focus: 'Másik fókusz', confidence: Number.NaN, rationale: 'Elég hosszú, de nem véges confidence érték.' },
    ])).toThrow('No valid niche candidates')
  })

  it('rejects empty, oversized, or entirely malformed provider output', () => {
    expect(() => normalizeNicheCandidates([])).toThrow('Invalid niche candidates')
    expect(() => normalizeNicheCandidates(new Array(5).fill({}))).toThrow('Invalid niche candidates')
    expect(() => normalizeNicheCandidates([{ main_category: 'science', specific_focus: 'x', confidence: 0.5, rationale: 'rövid' }])).toThrow('No valid niche candidates')
  })
})
