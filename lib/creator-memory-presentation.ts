import type { CreatorMemoryItem, TopicState } from '@/types'
import type { CreatorLane } from '@/lib/creator-lane-presentation'

export type CreatorMemorySection = 'ideas' | 'packages' | 'audits'
export type CreatorMemoryFilter = 'all' | TopicState

export const CREATOR_MEMORY_FILTERS: ReadonlyArray<{ value: CreatorMemoryFilter; label: string }> = [
  { value: 'all', label: 'Minden irány' },
  { value: 'saved', label: 'Mentett' },
  { value: 'in_progress', label: 'Folyamatban' },
  { value: 'completed', label: 'Publikált' },
  { value: 'rejected', label: 'Elvetett' },
]

export const CREATOR_MEMORY_STATE: Record<TopicState, { label: string; step: string }> = {
  saved: { label: 'Mentett irány', step: '01' },
  in_progress: { label: 'Aktív projekt', step: '02' },
  completed: { label: 'Publikált', step: '03' },
  rejected: { label: 'Elvetett', step: '—' },
}

export const CREATOR_MEMORY_LANE_COPY: Record<CreatorLane, { title: string; lead: string; lens: string }> = {
  evidence: {
    title: 'A csatornád döntési memóriája.',
    lead: 'Témák, bizonyítékok és korábbi döntések egy visszakereshető alkotói rendszerben.',
    lens: 'Bizonyítékvezérelt nézet',
  },
  entertainment: {
    title: 'A csatornád kreatív memóriája.',
    lead: 'Koncepciók, elkészült csomagok és korábbi döntések egy visszakereshető alkotói rendszerben.',
    lens: 'Élményvezérelt nézet',
  },
}

function normalized(value: string | null | undefined): string {
  return (value || '').toLocaleLowerCase('hu-HU').trim()
}

export function filterCreatorMemory(
  items: CreatorMemoryItem[],
  filter: CreatorMemoryFilter,
  query: string,
): CreatorMemoryItem[] {
  const needle = normalized(query)
  return items.filter(item => {
    if (filter !== 'all' && item.state !== filter) return false
    if (!needle) return true
    return [item.topic, item.search_keyword, item.platform, item.notes]
      .some(value => normalized(value).includes(needle))
  })
}

export function countCreatorMemoryStates(items: CreatorMemoryItem[]): Record<CreatorMemoryFilter, number> {
  return items.reduce<Record<CreatorMemoryFilter, number>>((counts, item) => {
    counts.all += 1
    counts[item.state] += 1
    return counts
  }, { all: 0, saved: 0, in_progress: 0, completed: 0, rejected: 0 })
}

export function totalProofSignals(items: Array<CreatorMemoryItem & { proof_signals?: { strong: number; medium: number; weak: number; rejected: number } }>): number {
  return items.reduce((total, item) => {
    const signals = item.proof_signals
    return total + (signals ? signals.strong + signals.medium + signals.weak + signals.rejected : 0)
  }, 0)
}
