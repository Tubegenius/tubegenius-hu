import { describe, expect, it } from 'vitest'
import { computeSeoScore, isValidSeoPackage } from '@/lib/seo-optimizer'
import { isValidThumbnailConcept } from '@/lib/thumbnail-studio'

describe('studio output validation', () => {
  it('weights SEO keyword coverage as one quarter of the total score', () => {
    expect(computeSeoScore({ title_length: 30, title_length_flag: 'ok', description_first_line_length: 20, description_first_line_has_keyword: true, keyword_coverage_in_title: 0, tag_count: 8, tag_count_flag: 'ok' })).toBe(75)
    expect(computeSeoScore({ title_length: 30, title_length_flag: 'ok', description_first_line_length: 20, description_first_line_has_keyword: true, keyword_coverage_in_title: 100, tag_count: 8, tag_count_flag: 'ok' })).toBe(100)
  })
  it('rejects malformed AI studio payloads', () => {
    expect(isValidSeoPackage({ seo_title: 'x' })).toBe(false)
    expect(isValidThumbnailConcept({ contrast_attention_score: 250 })).toBe(false)
    expect(isValidThumbnailConcept({ concept_label: 'A', visual_description: 'v', thumbnail_text: 't', composition_note: 'c', emotion_or_conflict: 'e', contrast_attention_score: 70, clutter_risk: 'low' })).toBe(true)
  })
})
