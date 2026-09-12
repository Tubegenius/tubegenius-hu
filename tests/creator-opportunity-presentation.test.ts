import { describe, expect, it } from 'vitest'
import {
  CREATOR_OPPORTUNITIES,
  creatorOpportunityStarterHref,
  findCreatorOpportunity,
} from '@/lib/creator-opportunity-presentation'

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

  it('resolves only known frontend starters and creates a scoped handoff URL', () => {
    const opportunity = CREATOR_OPPORTUNITIES.entertainment[0]
    expect(findCreatorOpportunity(opportunity.id)).toEqual(opportunity)
    expect(findCreatorOpportunity('unknown-opportunity')).toBeNull()
    expect(creatorOpportunityStarterHref(opportunity)).toBe('/dashboard/create?starter=worst-flat-viewer')
    expect(creatorOpportunityStarterHref(opportunity, '/frontend-preview/create')).toBe('/frontend-preview/create?starter=worst-flat-viewer')
  })
})
