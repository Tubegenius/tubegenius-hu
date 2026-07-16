import { describe, expect, it } from 'vitest'
import { computeSeoHeuristics, computeSeoScore, isValidSeoPackage } from '@/lib/seo-optimizer'
import { isValidThumbnailConcept, thumbnailConceptIdentity, validateDistinctThumbnailConcepts } from '@/lib/thumbnail-studio'
import { isValidTitleVariation, validateDistinctTitleVariations } from '@/lib/title-studio'

describe('studio output validation', () => {
  it('weights SEO keyword coverage as one quarter of the total score', () => {
    expect(computeSeoScore({ title_length: 30, title_length_flag: 'ok', description_first_line_length: 20, description_first_line_has_keyword: true, keyword_coverage_in_title: 0, tag_count: 8, tag_count_flag: 'ok' })).toBe(75)
    expect(computeSeoScore({ title_length: 30, title_length_flag: 'ok', description_first_line_length: 20, description_first_line_has_keyword: true, keyword_coverage_in_title: 100, tag_count: 8, tag_count_flag: 'ok' })).toBe(100)
    expect(computeSeoScore({ title_length: 2, title_length_flag: 'too_short', description_first_line_length: 0, description_first_line_has_keyword: false, keyword_coverage_in_title: 0, tag_count: 0, tag_count_flag: 'too_few' })).toBe(0)
  })
  it('matches Hungarian keywords accent-insensitively and rejects invented chapter timing', () => {
    const heuristics = computeSeoHeuristics({ title: 'Árvíztűrő növények otthon', description: 'Arvizturo novenyek bemutatása', keywords: ['árvíztűrő növények'], tags: ['a', 'b', 'c', 'd', 'e'] })
    expect(heuristics.keyword_coverage_in_title).toBe(100)
    expect(heuristics.description_first_line_has_keyword).toBe(true)
    const base = { seo_title: 'Árvíztűrő növények otthon', description: 'Árvíztűrő növények bemutatása', tags: ['a', 'b', 'c', 'd', 'e'], hashtags: ['#a', '#b', '#c'], chapters: Array.from({ length: 4 }, (_, i) => ({ timestamp: '', label: `Fejezet ${i}` })), playlist_suggestion: 'Növények', pinned_comment: 'Te melyiket választanád?', end_screen_cta: 'Nézd meg a következő videót.' }
    expect(isValidSeoPackage(base)).toBe(true)
    expect(isValidSeoPackage({ ...base, chapters: [{ timestamp: '1:30', label: 'Kitalált idő' }, ...base.chapters.slice(1)] })).toBe(false)
  })
  it('rejects malformed AI studio payloads', () => {
    expect(isValidSeoPackage({ seo_title: 'x' })).toBe(false)
    expect(isValidThumbnailConcept({ contrast_attention_score: 250 })).toBe(false)
    expect(isValidThumbnailConcept({ concept_label: 'A', visual_description: 'v', thumbnail_text: 't', composition_note: 'c', emotion_or_conflict: 'e', contrast_attention_score: 70, clutter_risk: 'low' })).toBe(true)
    const concept = (label: string, visual = label) => ({ concept_label: label, visual_description: visual, thumbnail_text: 'Rövid szöveg', composition_note: 'Bal-jobb kompozíció', emotion_or_conflict: 'Kíváncsiság', contrast_attention_score: 70, clutter_risk: 'low' as const })
    expect(validateDistinctThumbnailConcepts([concept('A'), concept('B'), concept('C')])).toHaveLength(3)
    expect(() => validateDistinctThumbnailConcepts([concept('A'), concept('A'), concept('C')])).toThrow()
    expect(isValidThumbnailConcept(concept('A', ''))).toBe(false)
    expect(isValidThumbnailConcept({ ...concept('A'), thumbnail_text: 'Ez a thumbnail szöveg biztosan túl hosszú' })).toBe(false)
    expect(thumbnailConceptIdentity({ ...concept('A'), concept_label: ' Árvíztűrő ' })).toBe(thumbnailConceptIdentity({ ...concept('A'), concept_label: 'arvizturo' }))
    expect(isValidTitleVariation({ title: 'Egy valos magyar cim', curiosity_score: 70, clarity_score: 80, clickability_score: 75, risk_score: 20, reasoning: 'Indok' })).toBe(true)
    expect(isValidTitleVariation({ title: 'Hibas', curiosity_score: 170, clarity_score: 80, clickability_score: 75, risk_score: 20, reasoning: 'Indok' })).toBe(false)
    const title = (value: string) => ({ title: value, curiosity_score: 70, clarity_score: 80, clickability_score: 75, risk_score: 20, reasoning: 'Indok' })
    expect(validateDistinctTitleVariations(['A', 'B', 'C', 'D', 'E'].map(title))).toHaveLength(5)
    expect(() => validateDistinctTitleVariations(['Azonos', 'Azonos', 'C', 'D', 'E'].map(title))).toThrow()
    expect(isValidTitleVariation(title('x'.repeat(101)))).toBe(false)
  })
})
