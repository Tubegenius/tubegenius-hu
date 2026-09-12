import { describe, expect, it } from 'vitest'
import { CREATOR_TODAY_PRESENTATION } from '@/lib/creator-today-presentation'

describe('Creator Today presentation', () => {
  it('keeps the complete daily workspace lane-specific', () => {
    const evidence = CREATOR_TODAY_PRESENTATION.evidence
    const entertainment = CREATOR_TODAY_PRESENTATION.entertainment

    expect(evidence.projectTitle).not.toBe(entertainment.projectTitle)
    expect(evidence.artifactPhase).toContain('Állítások')
    expect(entertainment.artifactPhase).toContain('Élményív')
    expect(evidence.timelineLabel).toBe('Magyarázó képsor')
    expect(entertainment.timelineLabel).toBe('Jelenetritmus')
  })

  it('provides lane-specific signals, opportunities and practical guidance', () => {
    for (const presentation of Object.values(CREATOR_TODAY_PRESENTATION)) {
      expect(presentation.intelligence).toHaveLength(3)
      expect(presentation.opportunities).toHaveLength(2)
      expect(presentation.tip.length).toBeGreaterThan(35)
      expect(presentation.visualLabel.toLowerCase()).toContain('szemléltető')
    }
  })
})
