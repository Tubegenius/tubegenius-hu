import { describe, expect, it } from 'vitest'
import { CREATOR_LANE_PRESENTATION } from '@/lib/creator-lane-presentation'

describe('Creator Lane presentation', () => {
  it('keeps the two creator mindsets separate', () => {
    expect(CREATOR_LANE_PRESENTATION.evidence.label).toBe('Bizonyítékvezérelt')
    expect(CREATOR_LANE_PRESENTATION.entertainment.label).toBe('Élményvezérelt')
    expect(CREATOR_LANE_PRESENTATION.evidence.stages.map(stage => stage.label)).toEqual([
      'Kutatás', 'Állítások', 'Magyarázat', 'Publikálás',
    ])
    expect(CREATOR_LANE_PRESENTATION.entertainment.stages.map(stage => stage.label)).toEqual([
      'Koncepció', 'Élményív', 'Jelenetek', 'Publikálás',
    ])
  })

  it('does not embed fabricated daily recommendations in the lane definition', () => {
    expect(CREATOR_LANE_PRESENTATION.evidence).not.toHaveProperty('todayDirection')
    expect(CREATOR_LANE_PRESENTATION.evidence).not.toHaveProperty('todaySupport')
    expect(CREATOR_LANE_PRESENTATION.entertainment).not.toHaveProperty('todayDirection')
    expect(CREATOR_LANE_PRESENTATION.entertainment).not.toHaveProperty('todaySupport')
  })
})
