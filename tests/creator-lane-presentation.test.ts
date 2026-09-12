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

  it('gives each lane a distinct daily direction', () => {
    expect(CREATOR_LANE_PRESENTATION.evidence.todayDirection).not.toBe(
      CREATOR_LANE_PRESENTATION.entertainment.todayDirection,
    )
    expect(CREATOR_LANE_PRESENTATION.evidence.todaySupport).not.toBe(
      CREATOR_LANE_PRESENTATION.entertainment.todaySupport,
    )
  })
})
