import type { CreatorMemoryItem } from '@/types'

export type CreatorLibraryStage = 'brief' | 'draft' | 'active' | 'published' | 'rejected'

export interface CreatorLibraryEntry {
  id: string
  title: string
  state: CreatorLibraryStage
  stateLabel: string
  stageIndex: string
  platformLabel: string
  updatedAt: string
  opportunityScore: number | null
  viralScore: number | null
  keyword: string | null
  notes: string | null
  nextActionLabel: string
  nextActionHref: string
}

export const CREATOR_LIBRARY_FLOW: readonly Exclude<CreatorLibraryStage, 'rejected'>[] = [
  'brief',
  'draft',
  'active',
  'published',
]

export const CREATOR_LIBRARY_LABELS: Record<CreatorLibraryStage, string> = {
  brief: 'Mentett brief',
  draft: 'Projektvázlat',
  active: 'Aktív projekt',
  published: 'Publikált',
  rejected: 'Elvetett',
}

function resolveLibraryStage(item: CreatorMemoryItem): CreatorLibraryStage {
  if (item.state === 'saved') return item.video_idea_id ? 'draft' : 'brief'
  if (item.state === 'in_progress') return 'active'
  if (item.state === 'completed') return 'published'
  return 'rejected'
}

function nextActionFor(state: CreatorLibraryStage): Pick<CreatorLibraryEntry, 'nextActionLabel' | 'nextActionHref'> {
  if (state === 'draft' || state === 'active') {
    return { nextActionLabel: 'Alkotás folytatása', nextActionHref: '/dashboard/create' }
  }
  if (state === 'published') {
    return { nextActionLabel: 'Növekedés megnyitása', nextActionHref: '/dashboard/growth' }
  }
  return { nextActionLabel: 'Felfedezés megnyitása', nextActionHref: '/dashboard/discover' }
}

export function presentCreatorMemoryItem(item: CreatorMemoryItem, index: number): CreatorLibraryEntry {
  const state = resolveLibraryStage(item)

  return {
    id: item.id,
    title: item.topic,
    state,
    stateLabel: CREATOR_LIBRARY_LABELS[state],
    stageIndex: String(index + 1).padStart(2, '0'),
    platformLabel: item.platform || 'Platformfüggetlen',
    updatedAt: item.updated_at,
    opportunityScore: item.opportunity_score,
    viralScore: item.viral_score,
    keyword: item.search_keyword || null,
    notes: item.notes || null,
    ...nextActionFor(state),
  }
}

export function presentCreatorMemory(items: CreatorMemoryItem[]): CreatorLibraryEntry[] {
  return items.map(presentCreatorMemoryItem)
}

export function countCreatorLibraryStages(entries: CreatorLibraryEntry[]): Record<CreatorLibraryStage, number> {
  return entries.reduce<Record<CreatorLibraryStage, number>>((counts, entry) => {
    counts[entry.state] += 1
    return counts
  }, { brief: 0, draft: 0, active: 0, published: 0, rejected: 0 })
}
