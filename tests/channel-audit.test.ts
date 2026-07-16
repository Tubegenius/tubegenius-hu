import { describe, expect, it } from 'vitest'
import { computeDimensionAverages, filterRelevantAudits, hasValidDimensionScores, hasValidOverallScore } from '@/lib/channel-audit'

const validScores = { hook_strength: 80, retention_potential: 70, engagement_quality: 60, platform_fit: 90, packaging_quality: 75 }

describe('channel audit evidence methodology', () => {
  it('ignores incomplete and out-of-range dimension records instead of treating fields as zero', () => {
    const result = computeDimensionAverages([
      { final_scores: validScores },
      { final_scores: { ...validScores, hook_strength: 120 } },
      { final_scores: { hook_strength: 20 } },
    ])
    expect(result).toEqual(validScores)
    expect(hasValidDimensionScores({ final_scores: validScores })).toBe(true)
    expect(hasValidDimensionScores({ final_scores: { hook_strength: 20 } })).toBe(false)
  })

  it('fails closed when no audit matches the creator niche', () => {
    const audits = [{ video_title: 'Gitárszóló kezdőknek', topic: 'zene' }]
    expect(filterRelevantAudits(audits, 'otthoni edzés fitnesz')).toEqual([])
  })

  it('accepts only finite 0-100 overall scores', () => {
    expect(hasValidOverallScore({ overall_score: 75 })).toBe(true)
    expect(hasValidOverallScore({ overall_score: Number.NaN })).toBe(false)
    expect(hasValidOverallScore({ overall_score: 101 })).toBe(false)
  })
})
