export type CreatorLane = 'evidence' | 'entertainment'

export type CreatorLaneStageId = 'research' | 'claims' | 'explanation' | 'publish'

export interface CreatorLanePresentation {
  label: string
  shortLabel: string
  stages: ReadonlyArray<{ id: CreatorLaneStageId; number: string; label: string }>
}

export const CREATOR_LANE_PRESENTATION: Record<CreatorLane, CreatorLanePresentation> = {
  evidence: {
    label: 'Bizonyítékvezérelt',
    shortLabel: 'Bizonyítékvezérelt',
    stages: [
      { id: 'research', number: '1', label: 'Kutatás' },
      { id: 'claims', number: '2', label: 'Állítások' },
      { id: 'explanation', number: '3', label: 'Magyarázat' },
      { id: 'publish', number: '4', label: 'Publikálás' },
    ],
  },
  entertainment: {
    label: 'Élményvezérelt',
    shortLabel: 'Élményvezérelt',
    stages: [
      { id: 'research', number: '1', label: 'Koncepció' },
      { id: 'claims', number: '2', label: 'Élményív' },
      { id: 'explanation', number: '3', label: 'Jelenetek' },
      { id: 'publish', number: '4', label: 'Publikálás' },
    ],
  },
}
