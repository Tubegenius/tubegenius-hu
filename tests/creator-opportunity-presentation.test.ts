import { describe, expect, it } from 'vitest'
import { CREATOR_OPPORTUNITIES } from '@/lib/creator-opportunity-presentation'

describe('Creator opportunity presentation', () => {
  it('provides a focused opportunity set for both Creator Lanes', () => {
    expect(CREATOR_OPPORTUNITIES.evidence).toHaveLength(3)
    expect(CREATOR_OPPORTUNITIES.entertainment).toHaveLength(3)
    expect(CREATOR_OPPORTUNITIES.evidence.every(item => item.lane === 'evidence')).toBe(true)
    expect(CREATOR_OPPORTUNITIES.entertainment.every(item => item.lane === 'entertainment')).toBe(true)
  })

  it('keeps each brief decision-ready without claiming live data', () => {
    for (const opportunity of [...CREATOR_OPPORTUNITIES.evidence, ...CREATOR_OPPORTUNITIES.entertainment]) {
      expect(opportunity.title.length).toBeGreaterThan(12)
      expect(opportunity.whyNow.length).toBeGreaterThan(40)
      expect(opportunity.audiencePromise.length).toBeGreaterThan(40)
      expect(opportunity.nextMove.length).toBeGreaterThan(40)
      expect(opportunity.tags.length).toBeGreaterThanOrEqual(2)
    }
  })
})
