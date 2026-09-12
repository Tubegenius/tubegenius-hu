import { describe, expect, it } from 'vitest'
import { CREATOR_GROWTH_PRESENTATION } from '@/lib/creator-growth-presentation'

describe('Creator growth presentation', () => {
  it('supports both Creator Lanes and both feedback lenses', () => {
    expect(Object.keys(CREATOR_GROWTH_PRESENTATION)).toEqual(['evidence', 'entertainment'])
    for (const lane of Object.values(CREATOR_GROWTH_PRESENTATION)) {
      expect(lane.release.lensLabel).toBe('Legutóbbi videó')
      expect(lane.pattern.lensLabel).toBe('Csatornaminta')
    }
  })

  it('keeps every chart usable and every conclusion explicitly illustrative', () => {
    for (const lane of Object.values(CREATOR_GROWTH_PRESENTATION)) {
      for (const snapshot of Object.values(lane)) {
        expect(snapshot.chartPoints.length).toBeGreaterThanOrEqual(10)
        expect(snapshot.chartPoints.every(point => point >= 0 && point <= 100)).toBe(true)
        expect(`${snapshot.comparison} ${snapshot.audienceMemoryDetail}`.toLowerCase()).toMatch(/szemléltető/)
        expect(snapshot.signals).toHaveLength(3)
      }
    }
  })

  it('turns feedback into one bounded next experiment', () => {
    for (const lane of Object.values(CREATOR_GROWTH_PRESENTATION)) {
      for (const snapshot of Object.values(lane)) {
        expect(snapshot.nextTest.length).toBeGreaterThan(15)
        expect(snapshot.nextTestDetail.length).toBeGreaterThan(60)
      }
    }
  })
})
