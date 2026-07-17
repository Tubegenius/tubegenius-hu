import { describe, expect, it } from 'vitest'
import { buildVerifiedFactBlock, classifyContentType, determineQualityStatus, isStrictFactMode } from '@/lib/fact-safety'

describe('Video Package fact safety gates', () => {
  it('does not let a single user transcript bypass high-risk source minimums', () => {
    const topic = 'gyógyszer kezelés botrány'
    const contentType = classifyContentType(topic)
    const block = buildVerifiedFactBlock(topic, contentType, isStrictFactMode(contentType), [], [], [{
      title: 'Felhasználó által megadott videó',
      url: 'https://youtube.com/watch?v=abcdefghijk',
      snippet: 'Egyetlen videó transcriptjéből származó egészségügyi állítás.',
      source: 'source_video_transcript',
    }])
    expect(block.fact_strictness_level).toBe('high_risk')
    expect(block.source_count).toBe(1)
    expect(block.minimum_sources_met).toBe(false)
    expect(determineQualityStatus(block, contentType)).toBe('insufficient_sources')
  })

  it('requires three distinct source records for high-risk content', () => {
    const topic = 'gyógyszer kezelés botrány'
    const contentType = classifyContentType(topic)
    const sources = [1, 2, 3].map(index => ({ title: `Forrás ${index}`, snippet: `Gyógyszer kezelés botrány ellenőrzött állítása ${index}.`, url: `https://example${index}.com/article/2026/report` }))
    const block = buildVerifiedFactBlock(topic, contentType, true, sources, [], [])
    expect(block.minimum_sources_met).toBe(true)
    expect(determineQualityStatus(block, contentType)).toBe('verified')
  })
})
